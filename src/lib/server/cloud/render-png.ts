import path from 'node:path';
import os from 'node:os';
import { Piscina } from 'piscina';
import { observeRenderDuration } from '../metrics';
import { log } from '../log';
import type { CloudWord, ColorScheme } from '$lib/types/cloud';

export type RenderSize = { width: number; height: number };

const DEFAULT_SIZE: RenderSize = { width: 1200, height: 800 };

/**
 * Pool worker'ов для рендера PNG. d3-cloud + canvas — синхронные и
 * CPU-heavy (100–300мс на 100 слов); в main-thread это блокирует event loop
 * для всех остальных запросов. Worker_threads исполняют рендер параллельно
 * в отдельных V8-изолятах.
 *
 * Workers ленивые: создаются по первому запросу, лимит сверху
 * `min(cpus-1, 4)`. На домашнем сервере с 4 vCPU это 3 worker'а — баланс
 * между параллелизмом и памятью (canvas-инстансы тяжёлые).
 *
 * Файл воркера лежит вне src/ — `workers/render-worker.mjs` в корне репо,
 * чтобы Vite его не бандлил и путь резолвился одинаково в dev/prod через
 * `process.cwd()`.
 */
const g = globalThis as unknown as { __tagcloud_render_pool?: Piscina };

// Таймаут одного рендера: зависший d3-cloud/canvas иначе держал бы worker-поток
// занятым бесконечно, отъедая весь пул. 15с с большим запасом (типичный рендер
// 100–300мс).
const RENDER_TIMEOUT_MS = 15_000;

export function getPool(): Piscina {
  if (g.__tagcloud_render_pool) return g.__tagcloud_render_pool;
  const filename = path.resolve(process.cwd(), 'workers/render-worker.mjs');
  const maxThreads = Math.min(4, Math.max(1, os.cpus().length - 1));
  const pool = new Piscina({
    filename,
    minThreads: 0,
    maxThreads,
    // Если воркер падает (canvas, d3-cloud) — не убивает приложение.
    // idleTimeout: воркер выключается через 30с простоя, освобождая RAM.
    idleTimeout: 30_000,
    // Ограничиваем очередь задач: при всплеске истечений (десятки опросов разом)
    // без потолка очередь росла бы в памяти неограниченно. 'auto' = maxThreads^2.
    maxQueue: 'auto'
  });
  // Ошибки воркера ВНЕ обработки задачи (краш потока) иначе молча теряются.
  pool.on('error', (err) => {
    log.error('render_pool_error', {
      err: err instanceof Error ? err.message : String(err)
    });
  });
  g.__tagcloud_render_pool = pool;
  log.info('render_pool_initialized', { filename, maxThreads });
  return pool;
}

/**
 * Закрывает worker-пул на graceful shutdown (см. hooks.server.ts). No-op,
 * если пул ещё не создавался.
 */
export async function closeRenderPool(): Promise<void> {
  if (!g.__tagcloud_render_pool) return;
  await g.__tagcloud_render_pool.close();
  g.__tagcloud_render_pool = undefined;
}

export type RenderOptions = {
  maxWords?: number;
  allowVertical?: boolean;
};

export async function renderPng(
  words: CloudWord[],
  scheme: ColorScheme,
  palette: string[] | null,
  size: RenderSize = DEFAULT_SIZE,
  opts: RenderOptions = {}
): Promise<Buffer> {
  const start = performance.now();
  // AbortController-таймаут: piscina отменит задачу, если рендер завис.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RENDER_TIMEOUT_MS);
  try {
    const result = await getPool().run(
      {
        words,
        scheme,
        palette,
        width: size.width,
        height: size.height,
        maxWords: opts.maxWords ?? 50,
        allowVertical: opts.allowVertical ?? false
      },
      { signal: ac.signal }
    );
    observeRenderDuration((performance.now() - start) / 1000);
    // piscina возвращает Buffer как есть — он передаётся через
    // structuredClone (transferable не используем, лишняя возня).
    return result as Buffer;
  } finally {
    clearTimeout(timer);
  }
}
