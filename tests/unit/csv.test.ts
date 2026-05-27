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

describe('CSV_BOM', () => {
  it('сериализуется в UTF-8 как EF BB BF (Excel-friendly)', () => {
    const buf = Buffer.from(CSV_BOM, 'utf8');
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
  });
});
