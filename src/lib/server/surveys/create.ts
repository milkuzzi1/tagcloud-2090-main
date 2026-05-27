import { db } from '../db';
import { surveys, questions } from '../schema';
import { generateUniqueCode } from './codes';
import type { CreateSurveyInput } from './validation';

export type CreateSurveyResult = {
  id: string;
  code: string;
  creatorToken: string;
  expiresAt: Date;
};

export type CreateSurveyContext = {
  userId: string;
  email: string;
};

export async function createSurvey(
  input: CreateSurveyInput,
  ctx: CreateSurveyContext
): Promise<CreateSurveyResult> {
  const code = await generateUniqueCode();

  return await db.transaction(async (tx) => {
    const [survey] = await tx
      .insert(surveys)
      .values({
        code,
        userId: ctx.userId,
        title: input.title ?? null,
        creatorEmail: ctx.email,
        caseSensitive: input.caseSensitive,
        colorScheme: input.colorScheme,
        customPalette: input.customPalette ?? null,
        maxWords: input.maxWords,
        allowVertical: input.allowVertical,
        expiresAt: input.expiresAt
      })
      .returning({
        id: surveys.id,
        code: surveys.code,
        creatorToken: surveys.creatorToken,
        expiresAt: surveys.expiresAt
      });

    await tx.insert(questions).values(
      input.questions.map((q, i) => ({
        surveyId: survey.id,
        text: q.text,
        answerType: q.answerType,
        maxAnswers: q.maxAnswers,
        position: i
      }))
    );

    return survey;
  });
}
