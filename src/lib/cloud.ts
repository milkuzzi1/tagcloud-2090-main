import type { CloudWord, ColorScheme } from './types/cloud';
import { palette as brand } from './theme';

/**
 * HSL → HEX. Параметры в градусах/процентах.
 * Используется для генерации читаемых случайных цветов на белом фоне.
 */
function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const c = lig - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Стабильный 32-битный хэш строки (FNV-1a-like). Используем для
 * детерминированной раскраски: одинаковое слово даёт одинаковый цвет
 * между перезагрузками страницы и письмом, что фиксит баг с
 * «прыгающими» цветами при F5.
 */
function strHash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Детерминированно выводит читаемый цвет (saturation 70%, lightness 38%)
 * по hash-у слова. Палитра «brand-friendly»: тёмные насыщенные тона на
 * белом фоне. Воспроизводимо: одно и то же слово → один и тот же цвет.
 */
function deterministicReadableColor(word: string): string {
  const h = strHash(word) % 360;
  return hslToHex(h, 72, 38);
}

/**
 * #RRGGBB → [r, g, b]. Без валидации — на входе уже отвалидированный hex
 * (проверяется в zod-схеме создания опроса).
 */
function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace(/^#/, '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Линейная интерполяция между двумя hex-цветами по t ∈ [0,1].
 */
function lerpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/**
 * Многосегментная интерполяция по списку стопов: t=0 → stops[0], t=1 →
 * stops[N-1]. С N стопами получаем (N-1) сегмент равной ширины.
 * Используется в colorScheme=`custom_gradient` для раскраски слов
 * по популярности.
 */
export function interpolateStops(stops: string[], t: number): string {
  if (stops.length === 0) return brand.navy;
  if (stops.length === 1) return stops[0];
  const tt = Math.max(0, Math.min(1, t));
  const seg = (stops.length - 1) * tt;
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const local = seg - i;
  return lerpHex(stops[i], stops[i + 1], local);
}

export type ColorPicker = (word: string, count: number) => string;

/**
 * Возвращает функцию, которая по (слово, count) выдаёт цвет.
 *
 * Все режимы детерминированы по входу — это лечит баг, при котором
 * перезагрузка страницы перерисовывала облако «другими» цветами:
 *   - 'mono'             — фирменный navy, безусловно;
 *   - 'random'           — HSL по hash-у слова (фикс. saturation/lightness);
 *   - 'custom'           — индекс в палитре по hash-у слова;
 *   - 'custom_gradient'  — линейная интерполяция стопов по count.
 *
 * `words` нужен только для 'custom_gradient' (чтобы посчитать min/max);
 * для остальных схем игнорируется.
 */
export function colorPicker(
  scheme: ColorScheme,
  palette?: string[] | null,
  words?: CloudWord[]
): ColorPicker {
  if (scheme === 'mono') return () => brand.navy;
  if (scheme === 'random') return (word) => deterministicReadableColor(word);

  if (scheme === 'custom' && palette && palette.length > 0) {
    const p = palette;
    return (word) => p[strHash(word) % p.length];
  }

  if (scheme === 'custom_gradient' && palette && palette.length > 0) {
    const p = palette;
    if (p.length === 1) return () => p[0];

    // Один проход без промежуточного массива .map(...): для облака с 200+
    // слов это сразу 200 аллокаций под counts + рост итератора, а нужны
    // только две скалярные вершины распределения.
    let min = Infinity;
    let max = -Infinity;
    if (words) {
      for (let i = 0; i < words.length; i++) {
        const c = words[i][1];
        if (c < min) min = c;
        if (c > max) max = c;
      }
    }
    // На пустом/одинаковом наборе t всегда 0 — отдадим первый стоп,
    // чтобы UI не падал и не делил на ноль.
    if (!isFinite(min) || !isFinite(max) || max === min) {
      return () => p[0];
    }
    const range = max - min;
    return (_word, count) => interpolateStops(p, (count - min) / range);
  }

  return () => brand.navy;
}

/**
 * Шкалирование размера шрифта по count. Логарифмическое — плотные «хвосты»
 * не «съедают» центр (если max=1000, а большинство слов с count<10).
 *
 * Возвращает baseSize..baseSize×SIZE_MULTIPLIER: даёт явное визуальное
 * превосходство самого популярного слова без того, чтобы оно вылезало
 * за холст. SIZE_MULTIPLIER подобран опытным путём на 1200×800 layout.
 *
 * Ключевая константа также продублирована в `workers/render-worker.mjs`
 * — должны совпадать по смыслу, иначе сайт и письмо разойдутся по
 * относительным пропорциям шрифтов.
 */
export const SIZE_MULTIPLIER = 5.5;

export function weightFactor(words: CloudWord[], baseSize: number) {
  // Math.max(1, ...words.map(w => w[1])) выглядит лаконично, но делает две
  // лишних операции: аллокацию массива длины N и spread, который
  // материализует все N значений в стек. Для облака с большим хвостом
  // это заметно: ручной цикл — один проход и ноль аллокаций.
  let max = 1;
  for (let i = 0; i < words.length; i++) {
    if (words[i][1] > max) max = words[i][1];
  }
  const denom = Math.log2(max + 1);
  return (count: number) => baseSize * (1 + (Math.log2(count + 1) / denom) * (SIZE_MULTIPLIER - 1));
}

/**
 * Шкалирует count в нормированную «интенсивность» t ∈ [0, 1] по той же
 * лог-шкале, что и `weightFactor`. t=0 — самое редкое слово (или count≤0),
 * t=1 — самое частое в наборе. Используется для font-weight и
 * пропорциональной обводки в рендере облака.
 */
export function weightIntensityFor(words: CloudWord[]): (count: number) => number {
  let max = 1;
  for (let i = 0; i < words.length; i++) {
    if (words[i][1] > max) max = words[i][1];
  }
  const denom = Math.log2(max + 1);
  return (count) => {
    if (count <= 0) return 0;
    const t = Math.log2(count + 1) / denom;
    return Math.max(0, Math.min(1, t));
  };
}

/**
 * Подбор font-weight по популярности — линейная интерполяция между 400 и 700
 * по `weightIntensityFor`, округлённая до ближайшего шага 100.
 *
 * Само по себе font-weight на canvas не даёт плавной градации: системные
 * sans-serif (Liberation/DejaVu/Arial) обычно содержат только 400 и 700
 * варианты, и CSS-спецификация заставляет браузер «выбрать ближайший
 * существующий»: на практике вес ниже 600 рендерится как 400, остальное —
 * как 700, и облако из 4 бакетов превращается в визуальное «жирно/нежирно».
 *
 * Поэтому в `cloud-render.ts` и `workers/render-worker.mjs` поверх font-weight
 * накладывается ещё пропорциональный strokeText: он работает на любом
 * шрифте и даёт настоящую плавную шкалу веса, согласованную с интенсивностью.
 */
export function fontWeightFor(words: CloudWord[]): (count: number) => number {
  const intensity = weightIntensityFor(words);
  return (count) => {
    const t = intensity(count);
    // 400, 500, 600, 700 — стандартные для большинства шрифтов шаги.
    return 400 + Math.round(t * 3) * 100;
  };
}
