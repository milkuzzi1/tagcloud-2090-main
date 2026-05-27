import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Главная страница не показывает отдельный hero — пользователей-гостей
// сразу отправляем на форму входа/регистрации, авторизованных — на их
// дашборд `/my`. Это требование правки №1.
export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user) {
    throw redirect(303, '/my');
  }
  throw redirect(303, '/login');
};
