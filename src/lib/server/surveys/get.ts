import { eq, desc, sql, asc } from 'drizzle-orm';
import { db } from '../db';
import { surveys, questions } from '../schema';

export type QuestionPublic = {
  id: string;
  text: string;
  answerType: 'single' | 'multi';
  maxAnswers: number;
  position: number;
};

export type SurveyPublic = {
  code: string;
  title: string | null;
  expiresAt: Date;
  status: 'active' | 'expired' | 'sent' | 'failed';
  questions: QuestionPublic[];
  colorScheme: 'mono' | 'random' | 'custom' | 'custom_gradient';
  customPalette: string[] | null;
  maxWords: number;
  allowVertical: boolean;
};

export type SurveyForCreator = SurveyPublic & {
  id: string;
  creatorEmail: string;
  creatorToken: string;
  caseSensitive: boolean;
  createdAt: Date;
};

/**
 * Грузит опрос вместе с вопросами одним SQL-запросом (LEFT JOIN). Раньше
 * было два round-trip: `select surveys`, потом `select questions`. Один JOIN
 * сокращает задержку SSR-загрузки ~на половину RTT до Postgres.
 */
async function loadSurveyWithQuestions(
  code: string
): Promise<{ survey: typeof surveys.$inferSelect; questions: QuestionPublic[] } | null> {
  const rows = await db
    .select({ survey: surveys, question: questions })
    .from(surveys)
    .leftJoin(questions, eq(questions.surveyId, surveys.id))
    .where(eq(surveys.code, code))
    .orderBy(asc(questions.position));

  if (rows.length === 0) return null;
  const survey = rows[0].survey;
  const qs: QuestionPublic[] = [];
  for (const row of rows) {
    const q = row.question;
    if (!q) continue; // LEFT JOIN: возможен null если вопросов нет
    qs.push({
      id: q.id,
      text: q.text,
      answerType: q.answerType,
      maxAnswers: q.maxAnswers,
      position: q.position
    });
  }
  return { survey, questions: qs };
}

export async function getSurveyPublic(code: string): Promise<SurveyPublic | null> {
  const data = await loadSurveyWithQuestions(code);
  if (!data) return null;
  const { survey, questions: qs } = data;
  return {
    code: survey.code,
    title: survey.title,
    expiresAt: survey.expiresAt,
    status: survey.status,
    questions: qs,
    colorScheme: survey.colorScheme,
    customPalette: survey.customPalette,
    maxWords: survey.maxWords,
    allowVertical: survey.allowVertical
  };
}

export async function getSurveyForCreator(
  code: string,
  opts: { userId?: string; token?: string }
): Promise<SurveyForCreator | null> {
  const data = await loadSurveyWithQuestions(code);
  if (!data) return null;
  const { survey, questions: qs } = data;

  // Доступ: либо session (userId матчит surveys.user_id), либо старый ?t=token
  const ok =
    (opts.userId !== undefined && survey.userId === opts.userId) ||
    (opts.token !== undefined && survey.creatorToken === opts.token);
  if (!ok) return null;

  return {
    id: survey.id,
    code: survey.code,
    title: survey.title,
    expiresAt: survey.expiresAt,
    status: survey.status,
    creatorEmail: survey.creatorEmail,
    creatorToken: survey.creatorToken,
    caseSensitive: survey.caseSensitive,
    colorScheme: survey.colorScheme,
    customPalette: survey.customPalette,
    maxWords: survey.maxWords,
    allowVertical: survey.allowVertical,
    createdAt: survey.createdAt,
    questions: qs
  };
}

export type UserSurveyListItem = {
  code: string;
  title: string | null;
  status: 'active' | 'expired' | 'sent' | 'failed';
  expiresAt: Date;
  createdAt: Date;
  questionsCount: number;
  responsesCount: number;
};

export async function listUserSurveys(userId: string): Promise<UserSurveyListItem[]> {
  // Один запрос вместо трёх: раньше шёл `select surveys` + `count questions`
  // + `count responses`, и при росте списка опросов это давало 3 RTT и
  // дополнительный JOIN questions×responses (декартов источник для COUNT,
  // ленивая БД скрывала проблему). Скалярные подзапросы дают честный
  // count(*) на каждом пользователе и идут одним planом.
  //
  // ВАЖНО про корреляцию: drizzle для одно-табличного FROM (surveys)
  // оптимизирует ссылки `${surveys.id}` в `sql\`\`` до неквалифицированного
  // `"id"`. Внутри подзапроса PG резолвит такое `"id"` к колонке внутреннего
  // FROM (questions.id / responses.id), а не к surveys.id — и получаем 0
  // совпадений или ошибку. Поэтому пишем имена столбцов корреляции как
  // литеральный SQL: `surveys.id` / `questions.survey_id` без интерполяции.
  const rows = await db
    .select({
      id: surveys.id,
      code: surveys.code,
      title: surveys.title,
      status: surveys.status,
      expiresAt: surveys.expiresAt,
      createdAt: surveys.createdAt,
      questionsCount: sql<number>`(
        SELECT count(*)::int FROM questions WHERE questions.survey_id = surveys.id
      )`,
      responsesCount: sql<number>`(
        SELECT count(*)::int FROM responses
        INNER JOIN questions q ON q.id = responses.question_id
        WHERE q.survey_id = surveys.id
      )`
    })
    .from(surveys)
    .where(eq(surveys.userId, userId))
    .orderBy(desc(surveys.createdAt));

  return rows.map((s) => ({
    code: s.code,
    title: s.title,
    status: s.status,
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
    questionsCount: s.questionsCount ?? 0,
    responsesCount: s.responsesCount ?? 0
  }));
}
