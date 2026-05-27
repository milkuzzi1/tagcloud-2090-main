import { eq, inArray, and } from 'drizzle-orm';
import { db } from '../db';
import { surveys, questions } from '../schema';
import type { AnswerEntry } from './validation';

export const MAX_WORD_LENGTH = 50;
/** Жёсткий потолок multi-вопросов (см. CHECK constraint в миграции 0004). */
export const MAX_MULTI_WORDS = 50;

export type ValidationError =
  | { code: 'survey_not_found'; message: string }
  | { code: 'survey_expired'; message: string }
  | { code: 'question_not_found'; message: string; questionId?: string }
  | { code: 'word_too_long'; max: number; message: string; questionId?: string }
  | { code: 'too_many_words'; max: number; message: string; questionId?: string }
  | { code: 'whitespace_in_word'; message: string; questionId?: string }
  | { code: 'single_must_be_one_word'; message: string; questionId?: string };

export type ProcessedAnswer = {
  questionId: string;
  words: string[];
  normalized: string[];
};

export type ValidationResult =
  | {
      ok: true;
      processed: ProcessedAnswer[];
      survey: { code: string; expiresAt: Date; caseSensitive: boolean };
    }
  | { ok: false; error: ValidationError };

function normalize(word: string, caseSensitive: boolean): string {
  return caseSensitive ? word : word.toLocaleLowerCase('ru-RU');
}

export async function validateSubmission(
  code: string,
  answers: AnswerEntry[]
): Promise<ValidationResult> {
  const [survey] = await db.select().from(surveys).where(eq(surveys.code, code)).limit(1);
  if (!survey) {
    return { ok: false, error: { code: 'survey_not_found', message: 'Опрос не найден' } };
  }
  if (survey.status !== 'active' || survey.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: { code: 'survey_expired', message: 'Опрос завершён' } };
  }

  const questionIds = answers.map((a) => a.questionId);
  const found = await db
    .select()
    .from(questions)
    .where(and(inArray(questions.id, questionIds), eq(questions.surveyId, survey.id)));

  const byId = new Map(found.map((q) => [q.id, q]));
  const processed: ProcessedAnswer[] = [];

  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (!question) {
      return {
        ok: false,
        error: {
          code: 'question_not_found',
          message: 'Вопрос не принадлежит этому опросу',
          questionId: answer.questionId
        }
      };
    }

    const words = answer.words.map((w) => w.trim()).filter((w) => w.length > 0);

    if (question.answerType === 'single') {
      if (words.length !== 1) {
        return {
          ok: false,
          error: {
            code: 'single_must_be_one_word',
            message: 'Ответ должен быть одним словом',
            questionId: question.id
          }
        };
      }
    } else {
      const limit = question.maxAnswers ?? MAX_MULTI_WORDS;
      if (words.length === 0 || words.length > limit) {
        return {
          ok: false,
          error: {
            code: 'too_many_words',
            max: limit,
            message: `Допустимо от 1 до ${limit} слов`,
            questionId: question.id
          }
        };
      }
    }

    for (const word of words) {
      if (/\s/.test(word)) {
        return {
          ok: false,
          error: {
            code: 'whitespace_in_word',
            message: 'Слова не должны содержать пробелы',
            questionId: question.id
          }
        };
      }
      if (word.length > MAX_WORD_LENGTH) {
        return {
          ok: false,
          error: {
            code: 'word_too_long',
            max: MAX_WORD_LENGTH,
            message: `Слово не длиннее ${MAX_WORD_LENGTH} символов`,
            questionId: question.id
          }
        };
      }
    }

    processed.push({
      questionId: question.id,
      words,
      normalized: words.map((w) => normalize(w, survey.caseSensitive))
    });
  }

  return {
    ok: true,
    processed,
    survey: {
      code: survey.code,
      expiresAt: survey.expiresAt,
      caseSensitive: survey.caseSensitive
    }
  };
}
