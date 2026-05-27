import { describe, it, expect } from 'vitest';
import { colorPicker, weightFactor, interpolateStops } from '../../src/lib/cloud';

describe('colorPicker', () => {
  it('mono всегда возвращает один и тот же brand-цвет', () => {
    const pick = colorPicker('mono');
    expect(pick('alpha', 1)).toBe(pick('beta', 5));
  });

  it('random — детерминирован по слову (одинаковое слово → один цвет)', () => {
    const pick = colorPicker('random');
    const c1 = pick('hello', 5);
    const c2 = pick('hello', 5);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('random — разные слова обычно дают разные цвета', () => {
    const pick = colorPicker('random');
    const a = pick('кот', 1);
    const b = pick('собака', 1);
    expect(a).not.toBe(b);
  });

  it('custom использует переданную палитру детерминированно', () => {
    const pick = colorPicker('custom', ['#AA0000', '#00BB00', '#0000CC']);
    const c = pick('word', 1);
    expect(['#AA0000', '#00BB00', '#0000CC']).toContain(c);
    // Тот же word → тот же цвет (фикс бага «прыгающих» цветов на F5).
    expect(pick('word', 1)).toBe(c);
  });

  it('custom без палитры падает обратно на brand-цвет', () => {
    const pick = colorPicker('custom', null);
    const c = pick('word', 1);
    expect(c).toMatch(/^#[0-9A-Fa-f]{6,8}$/);
  });

  it('custom с пустой палитрой падает обратно на brand-цвет', () => {
    const pick = colorPicker('custom', []);
    const c = pick('word', 1);
    expect(c).toMatch(/^#[0-9A-Fa-f]{6,8}$/);
  });

  it('custom_gradient: самое редкое слово получает первый стоп, самое частое — последний', () => {
    const palette = ['#000000', '#FFFFFF'];
    const words: [string, number][] = [
      ['rare', 1],
      ['popular', 100]
    ];
    const pick = colorPicker('custom_gradient', palette, words);
    expect(pick('rare', 1).toLowerCase()).toBe('#000000');
    expect(pick('popular', 100).toLowerCase()).toBe('#ffffff');
  });

  it('custom_gradient: одинаковые count — все слова получают первый стоп', () => {
    const palette = ['#112233', '#445566'];
    const words: [string, number][] = [
      ['a', 5],
      ['b', 5]
    ];
    const pick = colorPicker('custom_gradient', palette, words);
    expect(pick('a', 5).toLowerCase()).toBe('#112233');
    expect(pick('b', 5).toLowerCase()).toBe('#112233');
  });

  it('custom_gradient: середина диапазона — промежуточный цвет', () => {
    const palette = ['#000000', '#FFFFFF'];
    const words: [string, number][] = [
      ['lo', 0],
      ['hi', 10]
    ];
    const pick = colorPicker('custom_gradient', palette, words);
    expect(pick('mid', 5).toLowerCase()).toBe('#808080');
  });
});

describe('interpolateStops', () => {
  it('один стоп → возвращает его', () => {
    expect(interpolateStops(['#123456'], 0.5).toLowerCase()).toBe('#123456');
  });

  it('многосегментный градиент: середина двух сегментов', () => {
    // 3 стопа: t=0.25 = середина первого сегмента (#000000 ↔ #FF0000).
    expect(interpolateStops(['#000000', '#FF0000', '#00FF00'], 0.25).toLowerCase()).toBe('#800000');
  });

  it('клиппинг t за границы [0,1]', () => {
    const stops = ['#111111', '#222222', '#333333'];
    expect(interpolateStops(stops, -1).toLowerCase()).toBe('#111111');
    expect(interpolateStops(stops, 2).toLowerCase()).toBe('#333333');
  });
});

describe('weightFactor', () => {
  it('возвращает baseSize×SIZE_FLOOR для слова с count=0', () => {
    const wf = weightFactor(
      [
        ['a', 0],
        ['b', 1]
      ],
      28
    );
    // sqrt(0/1) = 0, baseSize × SIZE_FLOOR = 28 × 0.4 = 11.2
    expect(wf(0)).toBeCloseTo(28 * 0.4, 6);
  });

  it('самое частое слово получает максимум (×SIZE_MULTIPLIER)', () => {
    const wf = weightFactor(
      [
        ['a', 1],
        ['b', 10]
      ],
      28
    );
    // sqrt(10/10) = 1, baseSize × SIZE_MULTIPLIER.
    expect(wf(10)).toBeCloseTo(28 * 5.5, 6);
  });

  it('пустой массив не делит на ноль (Math.max ставит max=1)', () => {
    const wf = weightFactor([], 18);
    // sqrt(1/1) = 1, для count=1 → baseSize × SIZE_MULTIPLIER.
    expect(wf(1)).toBeCloseTo(18 * 5.5, 6);
  });

  it('последний ранг (count=1 при max=100) заметно меньше baseSize', () => {
    const wf = weightFactor(
      [
        ['top', 100],
        ['tail', 1]
      ],
      24
    );
    // sqrt(1/100) = 0.1, baseSize × (0.4 + 0.1×5.1) = 24 × 0.91 = 21.84
    // Ключевое: «хвост» сверх-популярного топа < baseSize.
    expect(wf(1)).toBeLessThan(24);
    expect(wf(1)).toBeCloseTo(24 * (0.4 + 0.1 * 5.1), 6);
  });
});
