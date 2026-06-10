import { eq } from 'drizzle-orm';
import { db } from '../db';
import { surveys, questions, emailLog, type Survey } from '../schema';
import { aggregateQuestion } from '../cloud/aggregate';
import { renderPng } from '../cloud/render-png';
import { buildSurveyCsv } from '../export/csv';
import { sendResultsEmail, type EmailAttachment } from '../email/send';
import { notifyClosed, notifyUserSurveyStatus } from '../realtime/broadcast';
import { mapWithLimit } from '../util/concurrency';
import { flushPending } from '../voting/submit';
import { redis } from '../redis';
import { log } from '../log';

// Лимит параллельных рендеров PNG для одного опроса. Worker-pool (Piscina)
// сам по себе ограничен 4 потоками, и Promise.all без потолка просто
// поставит остальные задачи в очередь воркера — но при этом мы держим
// готовые буферы в памяти всё время рендера (10 PNG × ~150кб = ~1.5МБ
// на один опрос). 4 матчит размер пула, не плодит ожидающих задач.
const RENDER_CONCURRENCY = 4;

/**
 * Удаляет агрегаты `cloud:${questionId}` из Redis. Вызывается ПОСЛЕ
 * успешной отправки email — иначе при повторной попытке `processExpired`
 * (recovery-ветка cron) топ-слова пришли бы пустыми.
 */
async function cleanupCloudKeys(questionIds: string[]): Promise<void> {
  if (questionIds.length === 0) return;
  try {
    const keys = questionIds.map((id) => `cloud:${id}`);
    await redis.del(...keys);
  } catch (err) {
    // Не критично — TTL в submit.ts (7 дней) подметёт ключи, если DEL не прошёл.
    log.error('expiry_cleanup_failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Claim-and-release дедуп через email_log.
 *
 * Проблема: processExpired может вызваться повторно из cron recovery после
 * частичного сбоя (см. status='failed' ветку) или конкурентно из двух cron
 * нод. Без дедупа creator получает несколько копий письма с результатами.
 *
 * Решение:
 *   1. Перед sendResultsEmail — INSERT в email_log с UNIQUE dedup_key.
 *      ON CONFLICT DO NOTHING + RETURNING id даёт нам атомарный «claim»:
 *      если RETURNING пуст → кто-то другой уже отправил/отправляет, скип.
 *   2. Если send падает с исключением — DELETE claim'а по id, чтобы
 *      следующий вызов (manual /retry или cron recovery) смог попробовать
 *      заново. БЕЗ release'а claim навсегда блокирует повторную отправку.
 *
 * Race с конкурентным claim'ом: если параллельный воркер уже взял claim,
 * мы получаем пустой RETURNING и не отправляем. Это корректное поведение —
 * письмо отправляет тот, кто первый успел.
 */
async function claimEmailSend(
  dedupKey: string,
  emailType: string,
  toAddr: string
): Promise<{ claimed: true; id: string } | { claimed: false }> {
  const rows = await db
    .insert(emailLog)
    .values({ dedupKey, emailType, toAddr })
    .onConflictDoNothing({ target: emailLog.dedupKey })
    .returning({ id: emailLog.id });
  if (rows.length === 0) return { claimed: false };
  return { claimed: true, id: rows[0].id };
}

async function releaseEmailClaim(id: string): Promise<void> {
  // Ретраим DELETE: если claim не отпустить, его UNIQUE dedup_key навсегда
  // заблокирует повторную отправку (письмо «уже отправлено», хотя его не было).
  // Поэтому пробуем несколько раз с backoff'ом, прежде чем сдаться.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.delete(emailLog).where(eq(emailLog.id, id));
      return;
    } catch (err) {
      if (attempt === 2) {
        log.error('expiry_release_claim_failed', {
          claimId: id,
          err: err instanceof Error ? err.message : String(err)
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
  }
}

export async function processExpired(survey: Survey): Promise<void> {
  log.info('expiry_processing', { surveyCode: survey.code });
  let questionIds: string[] = [];
  try {
    // Дренируем in-memory буфер голосов ПЕРЕД агрегацией: submitAnswers копит
    // голоса в памяти и флашит в Postgres раз в ~200мс/100шт. Опрос, завершённый
    // сразу после голосования, иначе потерял бы последние голоса в письме и
    // облаке (aggregateQuestion читает из Postgres). На single-VPS буфер
    // один — flushPending гарантирует, что всё дошло до БД.
    await flushPending();

    const qs = await db
      .select()
      .from(questions)
      .where(eq(questions.surveyId, survey.id))
      .orderBy(questions.position);
    questionIds = qs.map((q) => q.id);

    const aggregated = await Promise.all(
      qs.map(async (q) => {
        // Берём с запасом (×2): рендерим maxWords, но email-шаблон может
        // показывать чуть больше в текстовой версии (top-N в письме).
        const topWords = await aggregateQuestion(q.id, Math.max(100, survey.maxWords * 2));
        const totalVotes = topWords.reduce((s, [, c]) => s + c, 0);
        return { question: q, topWords, totalVotes };
      })
    );

    const attachments: EmailAttachment[] = [];

    // Рендерим PNG параллельно с потолком: на опросах с 5+ непустыми
    // вопросами раньше шёл sequential `await renderPng` → суммарно
    // ~5 × 200мс = 1с. Параллельный пул из 4 воркеров укладывает то же
    // в ~250–300мс (ограничено пулом Piscina).
    type RenderJob = { idx: number; words: (typeof aggregated)[number]['topWords'] };
    const jobs: RenderJob[] = [];
    for (let i = 0; i < aggregated.length; i++) {
      const a = aggregated[i];
      if (a.totalVotes === 0) continue;
      jobs.push({ idx: i, words: a.topWords });
    }
    const renders = await mapWithLimit(jobs, RENDER_CONCURRENCY, (job) =>
      renderPng(job.words, survey.colorScheme, survey.customPalette, undefined, {
        maxWords: survey.maxWords,
        allowVertical: survey.allowVertical
      })
    );
    for (let k = 0; k < jobs.length; k++) {
      const idx = jobs[k].idx;
      attachments.push({
        filename: `cloud_q${idx + 1}.png`,
        content: renders[k],
        contentType: 'image/png',
        cid: `cloud_q${idx + 1}`
      });
    }

    const csv = await buildSurveyCsv(survey.id);
    attachments.push({
      filename: `results-${survey.code}.csv`,
      content: Buffer.from(csv, 'utf-8'),
      contentType: 'text/csv; charset=utf-8'
    });

    // Claim перед отправкой. Если кто-то параллельно уже взял claim
    // (другой cron-воркер) — мы не отправляем письмо, но всё равно
    // помечаем опрос как 'sent' и чистим Redis: эти шаги идемпотентны
    // и должны произойти один раз даже если письмо уже улетело.
    const claim = await claimEmailSend(
      `survey_results:${survey.id}`,
      'survey_results',
      survey.creatorEmail
    );

    if (!claim.claimed) {
      log.info('expiry_send_skipped_already_sent', { surveyCode: survey.code });
    } else {
      try {
        await sendResultsEmail({
          to: survey.creatorEmail,
          surveyTitle: survey.title ?? `Опрос ${survey.code}`,
          surveyCode: survey.code,
          questions: aggregated.map((a) => ({
            question: { text: a.question.text, answerType: a.question.answerType },
            topWords: a.topWords,
            totalVotes: a.totalVotes
          })),
          attachments
        });
      } catch (sendErr) {
        // Release: следующий /retry или cron recovery должен иметь шанс
        // переслать. Без release claim навсегда блокирует повторы.
        await releaseEmailClaim(claim.id);
        throw sendErr;
      }
    }

    await db.update(surveys).set({ status: 'sent' }).where(eq(surveys.id, survey.id));
    await cleanupCloudKeys(questionIds);
    notifyClosed(survey.code, 'sent');
    notifyUserSurveyStatus(survey.userId, survey.code, 'sent');
    log.info('expiry_sent', { surveyCode: survey.code });
  } catch (err) {
    log.error('expiry_failed', {
      surveyCode: survey.code,
      err: err instanceof Error ? err.message : String(err)
    });
    await db.update(surveys).set({ status: 'failed' }).where(eq(surveys.id, survey.id));
    // Чистим ключи и в failed-ветке: повторная отправка через /retry заново
    // подберёт голоса из Postgres (SELECT word, wordNorm), агрегаты в Redis
    // более не нужны.
    await cleanupCloudKeys(questionIds);
    notifyClosed(survey.code, 'failed');
    notifyUserSurveyStatus(survey.userId, survey.code, 'failed');
  }
}
