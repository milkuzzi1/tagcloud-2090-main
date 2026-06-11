import Redis from 'ioredis';
import { building } from '$app/environment';
import { env } from '$env/dynamic/private';
import { log } from './log';

// Во время `vite build` SvelteKit импортирует серверные модули для анализа,
// когда реальных env ещё нет. Подставляем заглушку и не подключаемся
// (lazyConnect: true в режиме сборки).
const url = building ? 'redis://localhost:6379/0' : env.REDIS_URL;
if (!url) throw new Error('REDIS_URL is not set');

export const redis = new Redis(url, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
  lazyConnect: building,
  connectTimeout: 3000
});

redis.on('error', (err) => {
  log.error('redis_error', { err: err.message });
});

export async function pingRedis(): Promise<boolean> {
  try {
    const res = await redis.ping();
    return res === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Корректно закрывает соединение с Redis на graceful shutdown
 * (см. hooks.server.ts). `quit()` дожидается завершения in-flight команд.
 */
export async function disconnectRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    // Уже закрыт/недоступен — не мешаем завершению процесса.
  }
}
