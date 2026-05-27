export type CloudWord = [string, number];

/**
 * Цветовые схемы:
 *   - 'mono'             — одна навигационная заливка (фирменный navy);
 *   - 'random'           — детерминированный случайный цвет на слово
 *                          (hash от слова → HSL);
 *   - 'custom'           — пользовательская палитра, случайный выбор из неё
 *                          по слову (детерминированно);
 *   - 'custom_gradient'  — пользовательская палитра как стопы градиента;
 *                          цвет слова = линейная интерполяция по
 *                          популярности (count) от min к max.
 */
export type ColorScheme = 'mono' | 'random' | 'custom' | 'custom_gradient';

export type SurveyStatus = 'active' | 'expired' | 'sent' | 'failed';

export type ServerMsg =
  | { type: 'snapshot'; questionId: string; words: CloudWord[] }
  | { type: 'closed'; reason: 'expired' | 'sent' | 'failed' }
  // Push-уведомление для подписчиков `/ws/u` — присылается, когда у
  // одного из опросов пользователя меняется статус (cron→sent/failed,
  // ручной /finish, /retry). На /my по этому сообщению инвалидируем
  // данные страницы; без него UI догонял изменения только на
  // следующем 30-сек polling-цикле.
  | { type: 'survey-status'; code: string; status: SurveyStatus };

export type ClientMsg = { type: 'ping' };
