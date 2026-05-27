import { z } from 'zod';

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const QuestionInputSchema = z
  .object({
    text: z.string().trim().min(1, 'Текст вопроса обязателен').max(500),
    answerType: z.enum(['single', 'multi']),
    maxAnswers: z
      .number()
      .int()
      .min(1, 'Минимум 1 ответ')
      .max(200, 'Максимум 200 ответов')
      .optional()
  })
  .transform((q) => ({
    ...q,
    // single = всегда 1 ответ; multi без явного maxAnswers — дефолт для старых клиентов.
    maxAnswers: q.answerType === 'single' ? 1 : (q.maxAnswers ?? 5)
  }));

export const CreateSurveySchema = z
  .object({
    title: z.string().trim().max(200).optional(),
    caseSensitive: z.boolean().default(false),
    colorScheme: z.enum(['mono', 'random', 'custom', 'custom_gradient']),
    customPalette: z
      .array(z.string().regex(HEX_COLOR, 'Цвет должен быть в формате #RRGGBB'))
      .min(1)
      .max(10)
      .optional(),
    // Лимит слов в облаке: 1..200 — UX-разумный потолок (BD CHECK ставит 500).
    // 50 — дефолт: примерно столько хорошо помещается в стандартное облако.
    maxWords: z.number().int().min(1, 'Минимум 1 слово').max(200, 'Максимум 200 слов').default(50),
    allowVertical: z.boolean().default(false),
    expiresAt: z.coerce.date(),
    questions: z
      .array(QuestionInputSchema)
      .min(1, 'Нужен хотя бы один вопрос')
      .max(500, 'Не больше 500 вопросов')
  })
  .refine(
    (d) =>
      (d.colorScheme !== 'custom' && d.colorScheme !== 'custom_gradient') ||
      (d.customPalette && d.customPalette.length > 0),
    {
      message: 'customPalette обязательна при colorScheme=custom/custom_gradient',
      path: ['customPalette']
    }
  )
  .refine(
    (d) => d.colorScheme !== 'custom_gradient' || (d.customPalette && d.customPalette.length >= 2),
    {
      message: 'Для градиента нужно минимум 2 цвета',
      path: ['customPalette']
    }
  )
  .refine((d) => d.expiresAt.getTime() >= Date.now() + HOUR_MS - 60_000, {
    message: 'Срок должен быть как минимум через 1 час',
    path: ['expiresAt']
  })
  .refine((d) => d.expiresAt.getTime() <= Date.now() + 30 * DAY_MS, {
    message: 'Срок не может быть больше 30 дней',
    path: ['expiresAt']
  });

export type CreateSurveyInput = z.infer<typeof CreateSurveySchema>;
