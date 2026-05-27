import { describe, it, expect } from 'vitest';
import { CreateSurveySchema } from '../../src/lib/server/surveys/validation';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function future(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

describe('CreateSurveySchema', () => {
  it('принимает минимальный валидный опрос', () => {
    const r = CreateSurveySchema.safeParse({
      caseSensitive: false,
      colorScheme: 'mono',
      expiresAt: future(2 * HOUR_MS),
      questions: [{ text: 'Hi?', answerType: 'single' }]
    });
    expect(r.success).toBe(true);
  });

  it('ругается, если colorScheme=custom без customPalette', () => {
    const r = CreateSurveySchema.safeParse({
      colorScheme: 'custom',
      expiresAt: future(2 * HOUR_MS),
      questions: [{ text: 'Hi?', answerType: 'single' }]
    });
    expect(r.success).toBe(false);
  });

  it('принимает colorScheme=custom с палитрой hex-цветов', () => {
    const r = CreateSurveySchema.safeParse({
      colorScheme: 'custom',
      customPalette: ['#FF0000', '#00FF00'],
      expiresAt: future(2 * HOUR_MS),
      questions: [{ text: 'Hi?', answerType: 'single' }]
    });
    expect(r.success).toBe(true);
  });

  it('ругается на невалидный hex-цвет', () => {
    const r = CreateSurveySchema.safeParse({
      colorScheme: 'custom',
      customPalette: ['red'],
      expiresAt: future(2 * HOUR_MS),
      questions: [{ text: 'Hi?', answerType: 'single' }]
    });
    expect(r.success).toBe(false);
  });

  it('ругается на expiresAt < сейчас+1ч', () => {
    const r = CreateSurveySchema.safeParse({
      colorScheme: 'mono',
      expiresAt: future(10 * 60 * 1000), // 10мин
      questions: [{ text: 'Hi?', answerType: 'single' }]
    });
    expect(r.success).toBe(false);
  });

  it('ругается на expiresAt > сейчас+30д', () => {
    const r = CreateSurveySchema.safeParse({
      colorScheme: 'mono',
      expiresAt: future(31 * DAY_MS),
      questions: [{ text: 'Hi?', answerType: 'single' }]
    });
    expect(r.success).toBe(false);
  });

  it('ругается на пустой список вопросов', () => {
    const r = CreateSurveySchema.safeParse({
      colorScheme: 'mono',
      expiresAt: future(2 * HOUR_MS),
      questions: []
    });
    expect(r.success).toBe(false);
  });

  it('ругается на >500 вопросов', () => {
    const questions = Array.from({ length: 501 }, () => ({
      text: 'Q?',
      answerType: 'single' as const
    }));
    const r = CreateSurveySchema.safeParse({
      colorScheme: 'mono',
      expiresAt: future(2 * HOUR_MS),
      questions
    });
    expect(r.success).toBe(false);
  });

  it('принимает 100 вопросов (раньше было >50 — лимит снят)', () => {
    const questions = Array.from({ length: 100 }, () => ({
      text: 'Q?',
      answerType: 'single' as const
    }));
    const r = CreateSurveySchema.safeParse({
      colorScheme: 'mono',
      expiresAt: future(2 * HOUR_MS),
      questions
    });
    expect(r.success).toBe(true);
  });

  it('принимает multi-вопрос с maxAnswers=200', () => {
    const r = CreateSurveySchema.safeParse({
      colorScheme: 'mono',
      expiresAt: future(2 * HOUR_MS),
      questions: [{ text: 'Q?', answerType: 'multi' as const, maxAnswers: 200 }]
    });
    expect(r.success).toBe(true);
  });

  it('ругается на multi-вопрос с maxAnswers=201', () => {
    const r = CreateSurveySchema.safeParse({
      colorScheme: 'mono',
      expiresAt: future(2 * HOUR_MS),
      questions: [{ text: 'Q?', answerType: 'multi' as const, maxAnswers: 201 }]
    });
    expect(r.success).toBe(false);
  });

  it('обрезает пробелы у текста вопроса', () => {
    const r = CreateSurveySchema.parse({
      colorScheme: 'mono',
      expiresAt: future(2 * HOUR_MS),
      questions: [{ text: '   Why   ', answerType: 'single' }]
    });
    expect(r.questions[0].text).toBe('Why');
  });
});
