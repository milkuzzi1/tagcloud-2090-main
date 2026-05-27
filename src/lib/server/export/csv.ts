import { eq } from 'drizzle-orm';
import { db } from '../db';
import { questions } from '../schema';
import { aggregateQuestion } from '../cloud/aggregate';
import { mapWithLimit } from '../util/concurrency';
import { CSV_BOM, CSV_LINE_SEP, csvEscape } from './csv-escape';

// Лимит параллелизма агрегаций: каждая `aggregateQuestion` бьёт в Postgres,
// и без потолка экспорт большого опроса (30+ вопросов) одной командой может
// съесть весь pool коннектов. 8 — компромисс: используется весь стандартный
// 20-коннектный пул на ~40% (оставляя половину под пользовательские запросы),
// и вписывается в типичные 4–8 vCPU.
const AGGREGATE_CONCURRENCY = 8;

export async function buildSurveyCsv(surveyId: string): Promise<string> {
  const qs = await db
    .select()
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(questions.position);

  // Параллельный fan-out по вопросам с потолком: для опроса с 30+ вопросами это
  // заметно ускоряет экспорт (был последовательный round-trip на каждый
  // вопрос), но ограничивает нагрузку на pool коннектов БД.
  const aggregates = await mapWithLimit(qs, AGGREGATE_CONCURRENCY, (q) =>
    aggregateQuestion(q.id, 1000)
  );

  // Заголовки на русском — основные пользователи опросов читают CSV
  // в Excel/Numbers с русской локалью; «question/word/count» вызывали
  // вопросы у нетехнических создателей опросов.
  const rows: string[] = [
    [csvEscape('вопрос'), csvEscape('ответ'), csvEscape('количество ответов')].join(',')
  ];
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    const top = aggregates[i];
    if (top.length === 0) {
      rows.push([csvEscape(q.text), '', '0'].join(','));
      continue;
    }
    for (const [word, count] of top) {
      rows.push([csvEscape(q.text), csvEscape(word), String(count)].join(','));
    }
  }
  return CSV_BOM + rows.join(CSV_LINE_SEP) + CSV_LINE_SEP;
}
