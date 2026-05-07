// Воркер для piscina. Гоняется в отдельном Node-потоке — d3-cloud layout
// и canvas-рендер больше не блокируют главный event loop (актуально под
// 1000+ concurrent: один блокирующий syncwrap в main-loop'е роняет latency
// для всех клиентов на 200–500мс).
//
// ВАЖНО: файл — обычный ESM (.mjs), НЕ .ts и НЕ внутри src/. Vite не
// бандлит этот файл, так что путь резолвится одинаково в dev и в prod
// (`<project_root>/workers/render-worker.mjs`).
//
// Зависимости (canvas, d3-cloud) — те же, что и main thread, но
// инициализируются в воркере отдельно.

import { createCanvas } from 'canvas';
import cloud from 'd3-cloud';

const FONT = 'sans-serif';
const BRAND_NAVY = '#0E2A5C';

// Дублируем helper'ы из src/lib/cloud.ts — воркер обязан быть автономным,
// иначе придётся тащить всё дерево SvelteKit'овских импортов в worker thread.
// Поведение строго совпадает с клиентом: одинаковая раскраска и
// размер/толщина шрифта, чтобы письмо и сайт показывали одно и то же облако.
function hslToHex(h, s, l) {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n) => {
    const c = lig - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function strHash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function deterministicReadableColor(word) {
  const h = strHash(word) % 360;
  return hslToHex(h, 72, 38);
}

function hexToRgb(hex) {
  const v = hex.replace(/^#/, '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function rgbToHex(r, g, b) {
  const c = (n) => Math.round(n).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function lerpHex(a, b, t) {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

function interpolateStops(stops, t) {
  if (stops.length === 0) return BRAND_NAVY;
  if (stops.length === 1) return stops[0];
  const tt = Math.max(0, Math.min(1, t));
  const seg = (stops.length - 1) * tt;
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const local = seg - i;
  return lerpHex(stops[i], stops[i + 1], local);
}

function colorPicker(scheme, palette, words) {
  if (scheme === 'mono') return () => BRAND_NAVY;
  if (scheme === 'random') return (word) => deterministicReadableColor(word);
  if (scheme === 'custom' && palette && palette.length > 0) {
    return (word) => palette[strHash(word) % palette.length];
  }
  if (scheme === 'custom_gradient' && palette && palette.length > 0) {
    if (palette.length === 1) return () => palette[0];
    let min = Infinity;
    let max = -Infinity;
    for (const [, c] of words ?? []) {
      if (c < min) min = c;
      if (c > max) max = c;
    }
    if (!isFinite(min) || !isFinite(max) || max === min) {
      return () => palette[0];
    }
    const range = max - min;
    return (_word, count) => interpolateStops(palette, (count - min) / range);
  }
  return () => BRAND_NAVY;
}

// Совпадает с константой `SIZE_MULTIPLIER` в src/lib/cloud.ts. При
// расхождении сайт и письмо нарисуют разные пропорции шрифтов.
const SIZE_MULTIPLIER = 5.5;

function weightFactor(words, baseSize) {
  const max = Math.max(1, ...words.map((w) => w[1]));
  const denom = Math.log2(max + 1);
  return (count) =>
    baseSize * (1 + (Math.log2(count + 1) / denom) * (SIZE_MULTIPLIER - 1));
}

// Rank-based интенсивность (см. src/lib/cloud.ts за обоснование):
// ранжируем слова по count desc, топ → 1.0, последнее → 0.0,
// равные count'ы — одинаковая интенсивность (по рангу первого
// вхождения). Гарантирует видимый шаг между соседями по рангу
// даже на скошенных распределениях.
function weightIntensityFor(words) {
  const sorted = [...words].sort((a, b) => b[1] - a[1]);
  const n = Math.max(1, sorted.length - 1);
  const countToIntensity = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i][1];
    if (!countToIntensity.has(c)) {
      countToIntensity.set(c, 1 - i / n);
    }
  }
  return (count) => {
    if (count <= 0) return 0;
    const v = countToIntensity.get(count);
    return v ?? 0;
  };
}

// Шаг 50 (400, 450, 500, …, 700) — видимо на variable-fonts; на mono-weight
// фоллбеке (DejaVu в docker) это всё равно мапится в 400/700,
// поэтому плавность вывозит strokeText ниже.
function fontWeightFor(words) {
  const intensity = weightIntensityFor(words);
  return (count) => 400 + Math.round(intensity(count) * 6) * 50;
}

// Совпадает с MAX_STROKE_RATIO в src/lib/cloud-render.ts.
const MAX_STROKE_RATIO = 0.085;

// Совпадает с strokeFactor() в src/lib/cloud-render.ts.
function strokeFactor(intensity) {
  return 0.20 + 0.80 * Math.sqrt(Math.max(0, Math.min(1, intensity)));
}

// Вес fillText: всегда 400. Весовой градиент формируется strokeText'ом.
const FILL_WEIGHT = 400;

function drawEmpty(width, height, message) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#6B7280';
  ctx.font = `28px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
  return canvas.toBuffer('image/png');
}

export default async function render(job) {
  const { words, scheme, palette, width, height, maxWords, allowVertical } = job;
  if (!Array.isArray(words) || words.length === 0) {
    return drawEmpty(width, height, 'Нет ответов');
  }

  // Сортировка по убыванию count + обрезка до maxWords. d3-cloud сам
  // сортирует по `size` — но без обрезки длинный хвост рисуется как
  // «звёздная пыль» по краям. Здесь же гарантируем, что в layout
  // улетают только топ-N слов с наибольшими голосами.
  const limit = Math.max(1, maxWords ?? 50);
  const sorted = [...words].sort((a, b) => b[1] - a[1]).slice(0, limit);

  const wf = weightFactor(sorted, 28);
  const color = colorPicker(scheme, palette, sorted);
  const weights = fontWeightFor(sorted);
  const intensities = weightIntensityFor(sorted);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  // Детерминированный mulberry32 — нужен ТОЛЬКО для `.rotate`, чтобы
  // ~40% слов получали ±90° при `allowVertical=true`, и при этом
  // распределение было воспроизводимым между сайтом и письмом.
  let rngState = 0xc0de;
  const rotateRng = () => {
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  await new Promise((resolve, reject) => {
    const layout = cloud()
      .size([width, height])
      .canvas(() => createCanvas(1, 1))
      .words(
        sorted.map(([text, count]) => ({
          text,
          size: wf(count),
          count,
          weight: weights(count)
        }))
      )
      // Padding=10: совпадает с клиентом (`src/lib/cloud-render.ts`).
      // Корректность коллизий обеспечивает патч d3-cloud
      // (`patches/d3-cloud+1.2.9.patch`):
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
      // d3-cloud использует random() для:
      //   1) стартовой позиции каждого слова —
      //        d.x = (size[0] * (random()+0.5)) >> 1 → [0.25w; 0.75w];
      //   2) направления спирали (CW/CCW) в place().
      // Из-за пункта 1 даже самое крупное слово оказывалось НЕ в
      // центре, а где-то в центральной полосе. Возврат 0.5 даёт
      // `d.x = w/2, d.y = h/2` — все слова стартуют ровно в центре.
      // Сортировка по убыванию count + sequential placement в d3-cloud
      // гарантирует радиальную иерархию: топ-слово в центре, остальные
      // отодвигаются на спирали по мере коллизий.
      .random(() => 0.5)
      // Если опрос разрешает вертикали — ~40% слов ставятся под ±90°
      // (равновероятно влево/вправо), остальные — горизонтально.
      // Используем отдельный mulberry32, чтобы не пересекаться с
      // принудительным 0.5 для placement.
      // Самое популярное слово (первое после сортировки) всегда
      // горизонтально — иначе при длинном топ-слове оно не помещается
      // в высоту canvas в повёрнутом виде и теряется.
      .rotate((d, i) => {
        if (!allowVertical) return 0;
        if (i === 0) return 0;
        if (rotateRng() >= 0.4) return 0;
        return rotateRng() < 0.5 ? -90 : 90;
      })
      .font(FONT)
      .fontSize((d) => d.size)
      .fontWeight((d) => String(d.weight))
      .on('end', (placed) => {
        ctx.save();
        ctx.translate(width / 2, height / 2);
        // textBaseline='middle' соответствует sprite-маске d3-cloud
        // (см. `patches/d3-cloud+1.2.9.patch` — там форсируется тот же
        // baseline). Это устраняет рассинхрон между позицией маски
        // коллизий и пользовательского рендера ≈0.3*fontSize.
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const w of placed) {
          const size = w.size ?? 28;
          const text = w.text ?? '';
          const intensity = intensities(w.count ?? 0);
          const c = color(text, w.count ?? 0);
          // Вес fillText всегда FILL_WEIGHT — гладкий градиент через strokeText.
          ctx.font = `${FILL_WEIGHT} ${size}px ${FONT}`;
          ctx.fillStyle = c;
          ctx.save();
          ctx.translate(w.x ?? 0, w.y ?? 0);
          ctx.rotate(((w.rotate ?? 0) * Math.PI) / 180);
          // Плавная градация веса: пропорциональный stroke той же
          // краской поверх fill — согласовано с cloud-render.ts.
          const strokeW = size * MAX_STROKE_RATIO * strokeFactor(intensity);
          if (strokeW > 0) {
            ctx.strokeStyle = c;
            ctx.lineWidth = strokeW;
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            ctx.strokeText(text, 0, 0);
          }
          ctx.fillText(text, 0, 0);
          ctx.restore();
        }
        ctx.restore();
        resolve();
      });
    try {
      layout.start();
    } catch (e) {
      reject(e);
    }
  });

  return canvas.toBuffer('image/png');
}
