import { text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Liveness-проба для systemd / reverse-proxy / k8s.
 * Возвращает 200, если процесс жив и event-loop отвечает. Никаких внешних
 * проверок (БД, Redis) — иначе кратковременный сбой downstream'а вызовет
 * перезапуск процесса, что только усугубит ситуацию.
 */
export const GET: RequestHandler = () => text('ok');
