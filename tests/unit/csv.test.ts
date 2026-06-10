import { describe, it, expect } from 'vitest';
import { csvEscape, CSV_BOM } from '../../src/lib/server/export/csv-escape';

describe('csvEscape', () => {
  it('строка с запятой оборачивается в кавычки', () => {
    expect(csvEscape('hello, world')).toBe('"hello, world"');
  });

  it('кавычки внутри удваиваются (RFC 4180)', () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it('перевод строки оборачивается', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('CR оборачивается', () => {
    expect(csvEscape('a\rb')).toBe('"a\rb"');
  });

  it('обычное слово без спец-символов не оборачивается', () => {
    expect(csvEscape('word')).toBe('word');
  });

  it('пустая строка не оборачивается', () => {
    expect(csvEscape('')).toBe('');
  });

  it('кириллица не считается спец-символом', () => {
    expect(csvEscape('привет')).toBe('привет');
  });
});

describe('csvEscape: formula injection (CSV/Excel)', () => {
  // Значения, начинающиеся с = + - @ TAB CR, Excel/LibreOffice трактуют как
  // формулу. csvEscape должен обезвредить: обернуть в кавычки и префиксовать
  // апострофом (апостроф съедается парсером, формула не исполняется).
  it('= в начале экранируется апострофом', () => {
    expect(csvEscape('=1+1')).toBe('"\'=1+1"');
  });

  it('+ в начале экранируется', () => {
    expect(csvEscape('+1')).toBe('"\'+1"');
  });

  it('- в начале экранируется', () => {
    expect(csvEscape('-1')).toBe('"\'-1"');
  });

  it('@ в начале экранируется', () => {
    expect(csvEscape('@SUM(A1)')).toBe('"\'@SUM(A1)"');
  });

  it('классический payload =cmd|... обезврежен', () => {
    expect(csvEscape("=cmd|'/c calc'!A0")).toBe("\"'=cmd|'/c calc'!A0\"");
  });

  it('TAB в начале экранируется', () => {
    expect(csvEscape('\tx')).toBe('"\'\tx"');
  });

  it('формула с кавычкой внутри: апостроф + удвоение кавычек', () => {
    expect(csvEscape('=1"2')).toBe('"\'=1""2"');
  });

  it('= НЕ в начале не считается формулой', () => {
    expect(csvEscape('a=1')).toBe('a=1');
  });
});

describe('CSV_BOM', () => {
  it('сериализуется в UTF-8 как EF BB BF (Excel-friendly)', () => {
    const buf = Buffer.from(CSV_BOM, 'utf8');
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
  });
});
