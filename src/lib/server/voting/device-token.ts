import { randomBytes } from 'node:crypto';
import { dev } from '$app/environment';
import type { Cookies } from '@sveltejs/kit';

// Имя cookie со стабильным per-device nonce. Голос дедуплицируется по этому
// токену, а не по IP: школьный класс за одним NAT делит внешний IP, и IP-дедуп
// блокировал бы всех, кроме первого проголосовавшего. Токен — случайный nonce,
// не несёт PII; httpOnly, чтобы скрипты страницы не могли его прочитать.
export const VOTE_DEVICE_COOKIE = 'tc_device';

// ~6 месяцев. Опрос живёт максимум несколько суток, но один браузер может
// участвовать в разных опросах — переиздавать токен на каждый опрос незачем.
const DEVICE_TOKEN_MAX_AGE_SEC = 180 * 24 * 60 * 60;

/**
 * Возвращает стабильный per-device токен из cookie, создавая и устанавливая
 * его при первом обращении. Используется как ключ дедупликации голосов вместо
 * IP. Сброс cookie позволяет проголосовать повторно — это сознательный
 * компромисс; защита от злоупотреблений держится на per-IP rate-limit
 * (checkRateLimit), который НЕ убран.
 */
export function getOrCreateDeviceToken(cookies: Cookies): string {
  const existing = cookies.get(VOTE_DEVICE_COOKIE);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  cookies.set(VOTE_DEVICE_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: !dev,
    maxAge: DEVICE_TOKEN_MAX_AGE_SEC
  });
  return token;
}
