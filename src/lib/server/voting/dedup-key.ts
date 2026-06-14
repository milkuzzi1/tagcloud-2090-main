import { createHash } from 'node:crypto';

/**
 * Строит ключ дедупликации голоса в Redis.
 *
 * Дедуп привязан к ПЕР-УСТРОЙСТВЕННОМУ токену (nonce-cookie), а НЕ к IP. Раньше
 * ключ считался от IP — но школьный класс сидит за одним NAT с общим внешним
 * IP, поэтому второй и последующие ученики получали 409 «уже голосовали».
 * Токен устройства уникален на браузер, поэтому каждый ученик голосует один
 * раз, даже разделяя IP.
 *
 * Токен солится переданным per-survey salt'ом (см. getOrCreateSurveySalt):
 *   - salt стабилен весь срок жизни опроса, поэтому дедуп не «сбрасывается» при
 *     переходе через полночь UTC (как было бы с ежедневным salt'ом);
 *   - в Redis уходит только sha256-хэш, сам токен не хранится.
 *
 * Функция чистая (только node:crypto) — её легко покрыть юнит-тестами без
 * Redis/окружения.
 */
export function voteDedupKey(deviceToken: string, surveySalt: string, code: string): string {
  const hash = createHash('sha256').update(`${deviceToken}:${surveySalt}`).digest('hex');
  return `voted:${hash}:${code}`;
}
