/**
 * Клиентский рендер облака через d3-cloud + Canvas2D.
 *
 * Зачем не wordcloud2.js: на сервере (`workers/render-worker.mjs`) у нас
 * d3-cloud + node-canvas. wordcloud2.js использует другой алгоритм
 * упаковки (square spiral grid) и в принципе не способен дать ту же
 * раскладку, что d3-cloud (Archimedean spiral). Поэтому email и сайт
 * визуально расходились даже с детерминированным RNG. Решение —
 * использовать одну и ту же библиотеку на обоих концах.
 *
 * Детерминированность: тот же mulberry32 seed (0xC0DE), что и в worker'е.
 * При одинаковом наборе слов/размеров/весов раскладка, цвета и углы
 * совпадают.
 */
import cloud from 'd3-cloud';
import type { CloudWord, ColorScheme } from './types/cloud';
import { colorPicker, fontWeightFor, weightFactor, weightIntensityFor } from './cloud';

// Максимальная толщина обводки относительно font-size. Плавный градиент
// веса в облаке делаем ПОЛНОСТЬЮ через strokeText: fillText
// всегда рисуем весом 400, поверх накладываем strokeText той же
// краской с линией шириной по ранг-интенсивности. Так избегаем
// бинарного скачка 400/700 от рендеринга системных фонтов: вес всех
// слов воспринимается как непрерывный градиент по толщине штриха.
//
// 0.085: у топ-слова обводка ~8.5% font-size = визуальный extra-bold,
// но влазит в padding=10 d3-cloud (спрайт маски измеряется по
// fontWeight из weights() — это даёт доп. воздуха для жирных слов).
const MAX_STROKE_RATIO = 0.085;

// Кривая «интенсивность → множитель толщины». sqrt растягивает
// нижние ранги вверх (без этого их обводка < 1 пкс), базовый 0.20
// гарантирует самым лёгким словам видимый штрих «медиум»,
// чтобы хвост облака не сливался в «один вес = regular».
function strokeFactor(intensity: number): number {
  return 0.2 + 0.8 * Math.sqrt(Math.max(0, Math.min(1, intensity)));
}

// Вес fillText. Всегда 400 — весь весовой градиент даёт strokeText.
// Спрайты d3-cloud вычисляются по weights() (400…700) — это
// даёт «оверразмер» маски для жирных слов, куда помещается
// толстый strokeText без пересечения с соседями.
const FILL_WEIGHT = 400;

// Синхронизировано с var(--font-sans) в src/app.css. Inter при отсутствии
// @font-face используется только если установлен локально; иначе браузер
// сразу спускается на системные варианты. На macOS это San Francisco
// (веса 100–900), на Windows 10/11 — Segoe UI Variable. На Linux падаем
// на generic sans-serif (DejaVu) — там весы 400/700, поэтому strokeText
// вывозит плавность.
const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/**
 * mulberry32 — компактный детерминированный PRNG. Тот же seed/реализация
 * в `workers/render-worker.mjs`: одинаковые числа на обеих сторонах,
 * одинаковая раскладка.
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RenderOptions {
  baseSize?: number;
  maxWords?: number;
  allowVertical?: boolean;
  backgroundColor?: string;
  /**
   * Размер «логического» холста для layout. d3-cloud считает в этих
   * координатах; мы потом отрисовываем в device-pixel canvas с DPR.
   * 1200×700 — тот же размер, что и в email PNG.
   */
  layoutSize?: [number, number];
}

interface PlacedWord {
  text?: string;
  x?: number;
  y?: number;
  size?: number;
  rotate?: number;
  count?: number;
  weight?: number;
  intensity?: number;
}

/**
 * Запускает d3-cloud layout и рисует слова в `canvas`. Возвращает Promise,
 * резолвящийся когда раскладка готова и нарисована (либо сразу, если
 * слов нет).
 *
 * `cancelToken` — необязательный «флаг отмены»: если в момент `.on('end')`
 * у токена `.cancelled === true`, рисование пропускается. Полезно для
 * Svelte-эффектов, которые могут перевызвать рендер до окончания
 * предыдущего layout-прохода.
 */
export async function renderCloud(
  canvas: HTMLCanvasElement,
  words: CloudWord[],
  scheme: ColorScheme,
  palette: string[] | null,
  opts: RenderOptions = {},
  cancelToken: { cancelled: boolean } = { cancelled: false }
): Promise<void> {
  const layoutSize = opts.layoutSize ?? [1200, 700];
  const baseSize = opts.baseSize ?? 20;
  const limit = Math.max(1, opts.maxWords ?? 50);

  // Размер canvas в device-pixels учитывает DPR — так шрифт остаётся
  // чётким на retina, а logical-координаты d3-cloud правильно
  // ложатся в layoutSize.
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width || layoutSize[0];
  const cssH = canvas.clientHeight || canvas.height || layoutSize[1];
  const pixelW = Math.max(1, Math.floor(cssW * dpr));
  const pixelH = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== pixelW) canvas.width = pixelW;
  if (canvas.height !== pixelH) canvas.height = pixelH;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.fillStyle = opts.backgroundColor ?? '#FFFFFF';
  ctx.fillRect(0, 0, pixelW, pixelH);

  if (words.length === 0) {
    ctx.restore();
    return;
  }

  const sorted = [...words].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const pickColor = colorPicker(scheme, palette, sorted);
  const weights = fontWeightFor(sorted);
  const intensities = weightIntensityFor(sorted);

  // d3-cloud сам не предоставляет canvas в браузере — передаём фабрику
  // 1×1 offscreen canvas для замеров текста.
  const measureCanvas = (): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    return c;
  };

  type CloudWithRandom = ReturnType<typeof cloud> & {
    random?: (rng: () => number) => CloudWithRandom;
  };

  // d3-cloud МОЛЧА выкидывает слова, которые не помещаются на canvas
  // (см. cloudCollide → place(): после фиксированного числа итераций
  // спирали возвращается false и слово не попадает в массив `tags`,
  // переданный в `.on('end', ...)`). Из-за этого при `maxWords=50` в
  // облако реально попадало лишь 24–32 слова — топ-слово занимает много
  // места при `baseSize × SIZE_MULTIPLIER`, и остаток слов хвоста
  // упирается в границы layoutSize.
  //
  // Чиним итеративным масштабированием: запускаем layout, и если попало
  // меньше слов, чем мы запросили, — уменьшаем `baseSize` на коэффициент
  // и пробуем ещё раз. С каждой попыткой шрифты становятся компактнее,
  // и d3-cloud получает больше места под хвост. Останавливаемся либо
  // когда все слова помещены, либо когда дошли до минимального масштаба
  // (последний best-effort прогон).
  //
  // SCALE_STEP=0.9 — на каждом шаге площадь под слова уменьшается на
  // ~19% (0.9² ≈ 0.81), достаточно агрессивно, чтобы за 8 попыток
  // пройти от 100% до ~43% базового размера и заведомо разместить даже
  // 200 слов на 1200×700.
  const SCALE_STEP = 0.9;
  const MIN_SCALE = 0.35;
  const MAX_ATTEMPTS = 8;

  async function runLayout(scale: number): Promise<PlacedWord[]> {
    const wf = weightFactor(sorted, baseSize * scale);
    // rotateRng пересоздаём на каждой попытке: иначе при многократных
    // запусках состояние утечёт и одно и то же слово получит разные
    // углы между прогонами — раскладка перестанет быть детерминированной.
    const rotateRng = makeRng(0xc0de);
    return await new Promise<PlacedWord[]>((resolve, reject) => {
      try {
        const layout = cloud()
          .size(layoutSize)
          .canvas(measureCanvas as unknown as () => HTMLCanvasElement)
          .words(
            sorted.map(([text, count]) => ({
              text,
              size: wf(count),
              count,
              weight: weights(count),
              intensity: intensities(count)
            }))
          )
          // Padding=10 — компромисс между плотностью облака и видимым
          // воздухом между словами. Корректность коллизий обеспечивает
          // патч d3-cloud (`patches/d3-cloud+1.2.9.patch`):
          //   1) форсирует textBaseline='middle' в sprite — без этого
          //      sprite-маска коллизий стояла на 0.3*fontSize выше глифа,
          //      и крупные/повёрнутые слова визуально наезжали на соседей;
          //   2) добавляет 2*padding к sprite container ДО rotation-матрицы,
          //      чтобы halo strokeText помещался в маску по обеим осям;
          //   3) обновляет seenRow только на непустых строках — иначе
          //      пустые строки снизу спрайта попадали в bbox, маска
          //      получалась несимметричной, и слова сверху от текущего
          //      проходили коллизию, но визуально перекрывались.
          .padding(10)
          // Стартовая позиция и направление спирали должны быть
          // детерминированными — мы хотим, чтобы клиентское облако и
          // PNG из воркера выглядели одинаково. random=0.5 ставит
          // первое слово ровно в центр, чтобы оно лежало в (0,0).
          // Самое популярное слово (первое после сортировки) всегда
          // горизонтально — иначе при длинном топ-слове оно не помещается
          // в высоту canvas в повёрнутом виде и теряется.
          .rotate((d, i) => {
            if (!opts.allowVertical) return 0;
            if (i === 0) return 0;
            if (rotateRng() >= 0.4) return 0;
            return rotateRng() < 0.5 ? -90 : 90;
          })
          .font(FONT)
          .fontSize((d) => (d as { size: number }).size)
          .fontWeight((d) => String((d as { weight: number }).weight))
          .on('end', (placed: PlacedWord[]) => resolve(placed));
        // d3-cloud по умолчанию использует Math.random() для:
        //   1) стартовой позиции каждого слова:
        //        d.x = (size[0] * (random()+0.5))>>1 → [0.25w; 0.75w]
        //   2) направления спирали (CW/CCW) внутри place().
        // Из-за пункта 1 даже самое крупное слово оказывалось «где-то
        // в центральной полосе», но не строго в центре — облако
        // выглядело хаотично. Возврат 0.5 даёт `d.x = w/2, d.y = h/2`,
        // т.е. ВСЕ слова стартуют ровно в центре. Сортировка по убыванию
        // count + sequential placement в d3-cloud гарантирует, что:
        //   - топ-слово ложится в (0,0) (нет коллизий → не двигается);
        //   - следующее по популярности коллидирует с топ-словом и
        //     уходит на минимально возможный радиус по архимедовой
        //     спирали;
        //   - чем дальше слово в порядке популярности, тем больший
        //     радиус оно занимает.
        // Это и есть «центр + радиальная иерархия» из задачи.
        // .random — у d3-cloud есть в рантайме, но в @types/d3-cloud отсутствует.
        (layout as CloudWithRandom).random?.(() => 0.5);
        layout.start();
      } catch (err) {
        reject(err);
      }
    });
  }

  let placed: PlacedWord[] = [];
  let scale = 1;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    placed = await runLayout(scale);
    if (cancelToken.cancelled) {
      ctx.restore();
      return;
    }
    if (placed.length >= sorted.length) break;
    scale *= SCALE_STEP;
    if (scale < MIN_SCALE) {
      // Последний best-effort прогон ровно на MIN_SCALE: на крайних
      // случаях (200 слов + крошечный layout) даём шанс уместить
      // максимум — но больше не масштабируем, чтобы не сделать
      // шрифты нечитаемыми.
      scale = MIN_SCALE;
      placed = await runLayout(scale);
      if (cancelToken.cancelled) {
        ctx.restore();
        return;
      }
      break;
    }
  }

  if (cancelToken.cancelled) {
    ctx.restore();
    return;
  }

  // Переходим в координаты layout: d3-cloud кладёт центр в (0,0), мы
  // двигаем его в центр canvas. dpr-масштаб даёт чёткий рендер на retina.
  const sx = pixelW / layoutSize[0];
  const sy = pixelH / layoutSize[1];
  ctx.translate(pixelW / 2, pixelH / 2);
  ctx.scale(sx, sy);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const w of placed) {
    const text = w.text ?? '';
    const size = w.size ?? baseSize;
    const intensity = w.intensity ?? 0;
    const rot = w.rotate ?? 0;
    const color = pickColor(text, w.count ?? 0);
    ctx.save();
    ctx.translate(w.x ?? 0, w.y ?? 0);
    ctx.rotate((rot * Math.PI) / 180);
    // Всегда вес 400 для fillText — весовой градиент формирует strokeText
    // ниже (объяснение в шапке файла).
    ctx.font = `${FILL_WEIGHT} ${size}px ${FONT}`;
    ctx.fillStyle = color;
    const strokeW = size * MAX_STROKE_RATIO * strokeFactor(intensity);
    if (strokeW > 0) {
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeW;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeText(text, 0, 0);
    }
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}
