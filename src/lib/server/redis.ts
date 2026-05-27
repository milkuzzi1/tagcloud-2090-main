import Redis from 'ioredis';
import { env } from '$env/dynamic/private';
import { log } from './log';

const url = env.REDIS_URL;
if (!url) throw new Error('REDIS_URL is not set');

export const redis = new Redis(url, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
  lazyConnect: false,
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
