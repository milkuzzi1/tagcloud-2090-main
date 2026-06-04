import { timingSafeEqual } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { surveys, type Survey } from '../schema';
import { isValidCode } from '../surveys/codes';
import { log } from '../log';
import type { AuthUserExt } from './sessions';

/**
 * Гард для admin-эндпоинтов: бросает 401, если не залогинен, и 403,
 * если роль не 'admin'. Возвращает гарантированно admin-пользователя.
 *
 * Использовать в +server.ts admin-роутов и /admin/+layout.server.ts:
 *
 *   const admin = requireAdmin(locals.user);
 *   // admin.role === 'admin', admin.id / admin.email доступны
 */
export function requireAdmin(user: AuthUserExt | null): AuthUserExt {
  if (!user) {
    throw error(401, 'Требуется вход');
  }
  if (user.role !== 'admin') {
    throw error(403, 'Доступ запрещён');
  }
  return user;
}

export type AccessFailure =
  | { ok: false; status: 400; code: 'invalid_code'; message: string }
  | { ok: false; status: 401; code: 'unauthorized'; message: string }
  | { ok: false; status: 403; code: 'forbidden'; message: string }
  | { ok: false; status: 404; code: 'survey_not_found'; message: string };

export type AccessSuccess = { ok: true; survey: Survey };

export type AccessResult = AccessSuccess | AccessFailure;

export type AccessOpts = {
  code: string;
  userId?: string;
  token?: string | null;
};

/**
 * Постоянное по времени сравнение строк одинаковой длины. Защита от
 * тайминг-атаки на сравнение creatorToken (UUID, 122 бита энтропии —
 * атака практически невыполнима, но `timingSafeEqual` дешёвый и
 * правильный по гигиене).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ab, bb);
}

/**
 * Проверяет, что вызывающий имеет доступ к опросу как создатель:
 *  - либо он залогинен и опрос принадлежит его user_id (новый путь),
 *  - либо он передал верный creator_token в `?t=` (legacy/публичный путь).
 *
 * Возвращает либо `{ ok: true, survey }`, либо описание ошибки с уже
 * подобранным HTTP-статусом — единый формат для JSON-эндпоинтов.
 */
export async function requireCreatorAccess(opts: AccessOpts): Promise<AccessResult> {
  if (!isValidCode(opts.code)) {
    return { ok: false, status: 400, code: 'invalid_code', message: 'Некорректный код' };
  }
  if (!opts.userId && !opts.token) {
    return { ok: false, status: 401, code: 'unauthorized', message: 'Нужен вход или токен' };
  }

  const [survey] = await db.select().from(surveys).where(eq(surveys.code, opts.code)).limit(1);
  if (!survey) {
    return { ok: false, status: 404, code: 'survey_not_found', message: 'Опрос не найден' };
  }

  const sessionAllowed = opts.userId !== undefined && survey.userId === opts.userId;
  const tokenAllowed =
    opts.token !== undefined &&
    opts.token !== null &&
    constantTimeEqual(survey.creatorToken, opts.token);

  if (!sessionAllowed && !tokenAllowed) {
    return { ok: false, status: 403, code: 'forbidden', message: 'Нет доступа' };
  }

  // Если доступ дан только по legacy ?t= — фиксируем в логах. Цель:
  // отследить, у кого фронт ещё кладёт токен в URL, чтобы депрекейт
  // довести до конца.
  if (!sessionAllowed && tokenAllowed) {
    log.warn('legacy_creator_token_access', { surveyCode: survey.code });
  }

  return { ok: true, survey };
}
