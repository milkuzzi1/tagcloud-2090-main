import { describe, it, expect } from 'vitest';
import { AnswerEntrySchema, SubmitAnswersSchema } from '../../src/lib/server/voting/validation';

// Канонический v4-UUID, который проходит RFC 9562 проверку Zod v4.
const UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('AnswerEntrySchema', () => {
  it('принимает валидную запись', () => {
    const r = AnswerEntrySchema.parse({ questionId: UUID, words: ['one', 'two'] });
    expect(r.words).toEqual(['one', 'two']);
  });

  it('обрезает пробелы у слов', () => {
    const r = AnswerEntrySchema.parse({ questionId: UUID, words: ['  hello  ', 'world '] });
    expect(r.words).toEqual(['hello', 'world']);
  });

  it('ругается на пустой массив слов', () => {
    expect(AnswerEntrySchema.safeParse({ questionId: UUID, words: [] }).success).toBe(false);
  });

  it('ругается на >200 слов (жёсткий потолок схемы)', () => {
    const words = Array.from({ length: 201 }, (_, i) => `w${i}`);
    expect(AnswerEntrySchema.safeParse({ questionId: UUID, words }).success).toBe(false);
  });

  it('ругается на слово длиннее 50 символов', () => {
    expect(AnswerEntrySchema.safeParse({ questionId: UUID, words: ['x'.repeat(51)] }).success).toBe(
      false
    );
  });

  it('ругается на questionId не uuid', () => {
    expect(AnswerEntrySchema.safeParse({ questionId: 'not-a-uuid', words: ['x'] }).success).toBe(
      false
    );
  });
});

describe('SubmitAnswersSchema', () => {
  it('требует хотя бы один ответ', () => {
    expect(SubmitAnswersSchema.safeParse({ answers: [] }).success).toBe(false);
  });

  it('лимитирует количество ответов в одном запросе (≤500)', () => {
    const answers = Array.from({ length: 501 }, () => ({ questionId: UUID, words: ['x'] }));
    expect(SubmitAnswersSchema.safeParse({ answers }).success).toBe(false);
  });
});
