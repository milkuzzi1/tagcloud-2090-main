import { z } from 'zod';

export const AnswerEntrySchema = z.object({
  questionId: z.string().uuid(),
  // Жёсткий потолок 200 слов на вопрос; настоящий лимит per-question
  // (`questions.max_answers`) проверяется на сервере в validateSubmission.
  words: z.array(z.string().trim().min(1).max(50)).min(1).max(200)
});

export const SubmitAnswersSchema = z.object({
  answers: z.array(AnswerEntrySchema).min(1, 'Нужен хотя бы один ответ').max(500)
});

export type SubmitAnswersInput = z.infer<typeof SubmitAnswersSchema>;
export type AnswerEntry = z.infer<typeof AnswerEntrySchema>;
