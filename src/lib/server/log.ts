import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Лёгкий структурированный логгер. Заменяет россыпь console.log/error
 * на единый JSON-формат с уровнями и контекстом.
 *
 * Почему свой, а не pino: pino тащит сторонние транспорты через
 * thread-stream, которые плохо ладят с Vite/Rollup-бандлингом
 * (динамические require пути, которые ломаются в SSR-сборке). Один
 * JSON.stringify в stdout закрывает 95% потребностей и не зависит от
 * рантайм-резолва файлов.
 *
 * - В production: чистый JSON в stdout. Сборщик логов (journald, vector,
 *   loki) парсит без дополнительных опций.
 * - В dev: тоже JSON, но с человекочитаемым префиксом-уровнем для
 *   быстрого визуального скана терминала.
 *
 * Поля контекста (requestId, userId, surveyCode, …) пробрасываются через
 * AsyncLocalStorage — не нужно тащить logger через все аргументы.
 */
const isProd = process.env.NODE_ENV === 'production';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 } as const;
type Level = keyof typeof LEVELS;

const minLevel: number = (() => {
  const want = (process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug')) as Level;
  return LEVELS[want] ?? LEVELS.info;
})();

type LogContext = {
  requestId?: string;
  userId?: string;
  surveyCode?: string;
  [key: string]: unknown;
};

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Запускает callback в новом контексте логирования. Любой `log.info(...)`
 * внутри fn автоматически получит поля из ctx.
 */
export function withLogContext<T>(ctx: LogContext, fn: () => T | Promise<T>): T | Promise<T> {
  // Мерджим с уже существующим контекстом, чтобы вложенные `withLogContext`
  // расширяли, а не затирали родительские поля.
  const parent = storage.getStore();
  return storage.run({ ...(parent ?? {}), ...ctx }, fn);
}

/**
 * Добавляет/перезаписывает поля в текущем контексте. Работает только
 * внутри `withLogContext` — если контекста нет, no-op (логи не упадут).
 */
export function setLogContext(patch: LogContext): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  Object.assign(ctx, patch);
}

export function genRequestId(): string {
  return randomUUID();
}

// Маска по имени поля для защиты от случайного логирования секретов
// через extra. Регэкс ловит:
//   - password, secret, apikey/api_key, accesstoken/access_token, refreshtoken,
//   - cookie, authorization,
//   - sessionid/session_id, csrf_token,
//   - creator_token, verify_token и т.п. суффиксы *token / *secret.
// Match по lower-cased имени, разделители (_, -) игнорируются.
const REDACT_RE =
  /(password|passwd|secret|api[_-]?key|token|cookie|authorization|session[_-]?id|csrf|otp)/;

function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = REDACT_RE.test(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;
  const ctx = storage.getStore();
  const record: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    msg,
    ...(ctx ? redact(ctx) : {}),
    ...(extra ? redact(extra) : {})
  };
  // stderr для warn+, stdout для остальных — чтобы systemd/journald
  // правильно классифицировал.
  const line = JSON.stringify(record);
  if (LEVELS[level] >= LEVELS.warn) process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
  fatal: (msg: string, extra?: Record<string, unknown>) => emit('fatal', msg, extra)
};
