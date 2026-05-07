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
 * Шкалирует count в нормированную «интенсивность» t ∈ [0, 1] по РАНГУ
 * слова в отсортированном по убыванию count'а списке. Топ-слово получает 1,
 * последнее — 0, остальные равномерно по позиции. Слова с одинаковым
 * count получают одинаковую интенсивность (берём ранг первого вхождения).
 *
 * Раньше тут была лог-шкала по count. На скошенных распределениях
 * (1 популярное слово + длинный хвост близких counts, типичный реальный
 * случай) лог сжимал хвост в почти одинаковые значения (≈0.15…0.3),
 * и из 4 бакетов font-weight + проп.обводки визуально выходило только
 * «жирно/нежирно». Rank-based даёт гарантированно разную интенсивность
 * у соседних по позиции слов и видимый плавный градиент по всей шкале.
 */
export function weightIntensityFor(words: CloudWord[]): (count: number) => number {
  const sorted = [...words].sort((a, b) => b[1] - a[1]);
  const n = Math.max(1, sorted.length - 1);
  const countToIntensity = new Map<number, number>();
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

/**
 * Подбор font-weight по популярности — интерполяция между 400 и 700 по
 * `weightIntensityFor` с шагом 50 (400, 450, 500, …, 700).
 *
 * На canvas с моно-весовыми системными шрифтами (DejaVu, Liberation, Arial)
 * браузер маппит любой вес < 600 на 400, ≥ 600 на 700, и облако из бакетов
 * превращается в «жирно/нежирно». На variable-fonts (Inter, San Francisco
 * на macOS, Segoe UI Variable на Windows) шаг 50 уже даёт видимую плавность.
 *
 * В рендере (`cloud-render.ts`, `workers/render-worker.mjs`) поверх font-weight
 * накладывается пропорциональный strokeText той же краской — он работает
 * на любом шрифте и вытягивает плавность даже на моно-весовом fallback'е.
 */
export function fontWeightFor(words: CloudWord[]): (count: number) => number {
  const intensity = weightIntensityFor(words);
  return (count) => 400 + Math.round(intensity(count) * 6) * 50;
}
