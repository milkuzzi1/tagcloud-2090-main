import 'dotenv/config';
import postgres from 'postgres';
import Redis from 'ioredis';

/**
 * Dev-only сидер ответов для опроса. Заполняет таблицу `responses`
 * заданным распределением слов и обновляет Redis-агрегат `cloud:${qid}`,
 * чтобы живое облако сразу видело новые слова без переаггрегации.
 *
 * Использование:
 *
 *   tsx scripts/seed-responses.ts <CODE> [<questionPosition>] '<json-distribution>'
 *
 *   # все ответы пойдут в первый вопрос (position=0):
 *   tsx scripts/seed-responses.ts ABC123 0 '{"пельмени":12,"борщ":10,"плов":8,"суши":7,"каша":4,"суп":4,"блины":3,"салат":3,"торт":2,"чай":2,"кофе":1}'
 *
 * Замечания:
 *   — НЕ обходит rate-limit и НЕ ставит `voted:*` ключи; ваш браузер
 *     по-прежнему сможет ответить как обычный респондент.
 *   — Если опрос с `caseSensitive=false`, нормализация делается тем же
 *     способом, что и в боевом коде (`toLocaleLowerCase('ru-RU')`).
 *   — Скрипт можно запускать несколько раз — он просто добавляет, не
 *     обнуляет. Если нужно начать с чистого листа: `DELETE FROM responses
 *     WHERE question_id = ...; DEL cloud:<qid>` руками.
 */

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const [code, posArg, jsonArg] = process.argv.slice(2);
if (!code || !jsonArg) {
  console.error(
    'usage: tsx scripts/seed-responses.ts <CODE> [<questionPosition>] \'{"слово":N,...}\''
  );
  process.exit(1);
}
const questionPosition = posArg ? Number(posArg) : 0;
if (!Number.isFinite(questionPosition) || questionPosition < 0) {
  console.error(`bad question position: ${posArg}`);
  process.exit(1);
}

let distribution: Record<string, number>;
try {
  distribution = JSON.parse(jsonArg);
} catch (e) {
  console.error('failed to parse distribution JSON:', e);
  process.exit(1);
}
for (const [w, n] of Object.entries(distribution)) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    console.error(`bad count for ${w}: ${n} (must be non-negative integer)`);
    process.exit(1);
  }
}

const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
const redis = new Redis(redisUrl);

async function main(): Promise<void> {
  const surveys = await sql<{ id: string; case_sensitive: boolean }[]>`
    SELECT id, case_sensitive FROM surveys WHERE code = ${code}
  `;
  if (surveys.length === 0) {
    throw new Error(`survey ${code} not found`);
  }
  const survey = surveys[0];

  const questions = await sql<{ id: string; position: number; text: string }[]>`
    SELECT id, position, text FROM questions
    WHERE survey_id = ${survey.id}
    ORDER BY position
  `;
  const question = questions.find((q) => q.position === questionPosition);
  if (!question) {
    throw new Error(
      `question with position=${questionPosition} not found for survey ${code}; ` +
        `available: ${questions.map((q) => q.position).join(', ')}`
    );
  }

  console.log(`[seed] survey=${code} qid=${question.id} ("${question.text}")`);

  const rows: { question_id: string; word: string; word_norm: string }[] = [];
  for (const [word, count] of Object.entries(distribution)) {
    const norm = survey.case_sensitive ? word : word.toLocaleLowerCase('ru-RU');
    for (let i = 0; i < count; i++) {
      rows.push({ question_id: question.id, word, word_norm: norm });
    }
  }
  if (rows.length === 0) {
    console.log('[seed] empty distribution, nothing to do');
    return;
  }

  await sql`INSERT INTO responses ${sql(rows, 'question_id', 'word', 'word_norm')}`;
  console.log(`[seed] inserted ${rows.length} response(s) into postgres`);

  const cloudKey = `cloud:${question.id}`;
  const pipeline = redis.pipeline();
  for (const [word, count] of Object.entries(distribution)) {
    if (count <= 0) continue;
    const norm = survey.case_sensitive ? word : word.toLocaleLowerCase('ru-RU');
    pipeline.zincrby(cloudKey, count, norm);
  }
  // Тот же 7-дневный TTL, что использует боевой `submitAnswers()`.
  pipeline.expire(cloudKey, 7 * 24 * 60 * 60);
  await pipeline.exec();
  console.log(`[seed] bumped redis zset ${cloudKey}`);
}

try {
  await main();
} finally {
  await sql.end();
  redis.disconnect();
}
