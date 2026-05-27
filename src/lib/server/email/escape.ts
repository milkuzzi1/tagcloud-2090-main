/**
 * HTML-эскейп для интерполяции пользовательских данных в шаблоны писем.
 * Один общий хелпер для `templates.ts` (результаты опроса) и
 * `verification.ts` (подтверждение email) — раньше функция дублировалась.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
