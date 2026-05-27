// Чистая функция RFC 4180 escape — вынесена из csv.ts, чтобы её можно было
// тестировать без подтягивания db/schema (csv.ts импортирует runtime БД).

// UTF-8 BOM — нужен Excel'ю для корректной кодировки кириллицы при открытии CSV.
export const CSV_BOM = '\uFEFF';

// CSV line separator: RFC 4180 предписывает CRLF, и Excel в Windows при копи-пасте
// одного поля с `\n` теряет внутри-ячеечный перевод строки. Используем `\r\n`
// между записями всего CSV.
export const CSV_LINE_SEP = '\r\n';

// Префиксы, которые Excel/Numbers/LibreOffice интерпретируют как начало формулы.
// Без экранирования значение `=cmd|'/c calc'!A0` будет выполнено при открытии CSV
// (CVE-класс «CSV/formula injection»). Префиксуем неэкранированные значения
// одиночной кавычкой — она съедается парсером, но отключает интерпретацию.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvEscape(value: string): string {
  // Защита от formula injection: оборачиваем «опасные» значения в кавычки и
  // префиксуем апострофом. Сочетание с обычной escape-логикой ниже даёт корректный
  // RFC 4180 (двойные кавычки — удвоить, всю строку — обернуть в кавычки).
  if (FORMULA_PREFIX.test(value)) {
    return '"\'' + value.replace(/"/g, '""') + '"';
  }
  if (/[",\n\r]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
  return value;
}
