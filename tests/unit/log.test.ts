import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { log, withLogContext, setLogContext, genRequestId } from '../../src/lib/server/log';

describe('log', () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  const captured: string[] = [];

  beforeEach(() => {
    captured.length = 0;
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured.push(String(chunk));
      return true;
    });
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      captured.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });

  it('пишет JSON-строку с уровнем, временем и сообщением', () => {
    log.info('hello');
    expect(captured.length).toBe(1);
    const rec = JSON.parse(captured[0]);
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('hello');
    expect(rec.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('warn/error/fatal идут в stderr, info/debug — в stdout', () => {
    log.info('a');
    log.error('b');
    expect(stdoutWrite).toHaveBeenCalledTimes(1);
    expect(stderrWrite).toHaveBeenCalledTimes(1);
  });

  it('withLogContext добавляет поля в записи внутри callback', async () => {
    await withLogContext({ requestId: 'req-1', userId: 'u-1' }, async () => {
      log.info('event');
    });
    const rec = JSON.parse(captured[0]);
    expect(rec.requestId).toBe('req-1');
    expect(rec.userId).toBe('u-1');
  });

  it('вложенный withLogContext мерджит, не затирает', async () => {
    await withLogContext({ requestId: 'req-1' }, async () => {
      await withLogContext({ surveyCode: 'ABC' }, async () => {
        log.info('event');
      });
    });
    const rec = JSON.parse(captured[0]);
    expect(rec.requestId).toBe('req-1');
    expect(rec.surveyCode).toBe('ABC');
  });

  it('setLogContext добавляет поля в текущий контекст', async () => {
    await withLogContext({ requestId: 'req-1' }, async () => {
      setLogContext({ userId: 'u-after' });
      log.info('event');
    });
    const rec = JSON.parse(captured[0]);
    expect(rec.userId).toBe('u-after');
  });

  it('redact скрывает поля с секретами', () => {
    log.info('login', { password: 'p1', email: 'e@e' });
    const rec = JSON.parse(captured[0]);
    expect(rec.password).toBe('[REDACTED]');
    expect(rec.email).toBe('e@e');
  });

  it('genRequestId возвращает валидный uuid', () => {
    const id = genRequestId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('extra поля попадают в JSON', () => {
    log.warn('something', { code: 42, items: ['a', 'b'] });
    const rec = JSON.parse(captured[0]);
    expect(rec.code).toBe(42);
    expect(rec.items).toEqual(['a', 'b']);
  });
});
