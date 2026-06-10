import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * DEPRECATED / DISABLED (Req 3).
 *
 * General admin creation is no longer allowed: the system is designed to have
 * exactly one admin. The first admin is created via scripts/create-admin.ts,
 * and administration is transferred (once) via POST /api/admin/transfer-admin,
 * which removes the outgoing admin once the incoming one activates.
 *
 * This endpoint is kept only to return an explicit error to any stale client
 * instead of 404, so the disabling is obvious.
 */
export const POST: RequestHandler = async () => {
  return json(
    {
      error: {
        code: 'disabled',
        message: 'Создание администраторов отключено. Используйте передачу администрирования.'
      }
    },
    { status: 410 }
  );
};
