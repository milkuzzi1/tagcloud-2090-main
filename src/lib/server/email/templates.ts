import type { CloudWord } from '$lib/types/cloud';
import { escapeHtml } from './escape';

export type AggregatedQuestion = {
  question: { text: string; answerType: 'single' | 'multi' };
  topWords: CloudWord[];
  totalVotes: number;
};

export type ResultsTemplateInput = {
  surveyTitle: string;
  surveyCode: string;
  questions: AggregatedQuestion[];
};

const NAVY = '#0E2A5C';
const MUTED = '#6B7280';
const SURFACE = '#F7F8FA';
const TEXT = '#1A1A1A';
const BORDER = '#E5E7EB';

export function resultsHtml(opts: ResultsTemplateInput): string {
  const items = opts.questions
    .map((q, i) => {
      const cid = `cloud_q${i + 1}`;
      const tags = q.topWords
        .slice(0, 10)
        .map(
          ([word, count]) =>
            `<li style="display:inline-block;background:${SURFACE};padding:4px 12px;margin:2px;border-radius:4px;font-size:14px;">${escapeHtml(word)} <span style="color:${MUTED};">×${count}</span></li>`
        )
        .join('');
      const cloud =
        q.totalVotes > 0
          ? `<div style="margin-top:14px;text-align:center;"><img src="cid:${cid}" alt="Облако тегов: вопрос ${i + 1}" style="max-width:100%;height:auto;border:1px solid ${BORDER};border-radius:6px;background:#FFFFFF;"></div>`
          : '';
      return `
        <tr><td style="padding:18px 0;border-top:1px solid ${BORDER};">
          <div style="color:${MUTED};font-size:12px;text-transform:uppercase;letter-spacing:0.04em;font-weight:600;">Вопрос ${i + 1}${q.question.answerType === 'multi' ? ' · несколько слов' : ''}</div>
          <div style="font-size:16px;color:${TEXT};margin:6px 0 12px;font-weight:500;">${escapeHtml(q.question.text)}</div>
          <div style="color:${MUTED};font-size:13px;margin-bottom:8px;">Голосов: <strong style="color:${TEXT};">${q.totalVotes}</strong>${q.totalVotes > 0 ? ' · топ-10' : ''}</div>
          <ul style="list-style:none;padding:0;margin:0;">${tags || `<li style="color:${MUTED};font-size:14px;">— нет ответов</li>`}</ul>
          ${cloud}
        </td></tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TEXT};background:#FFFFFF;margin:0;padding:24px;-webkit-font-smoothing:antialiased;">
  <table width="100%" style="max-width:640px;margin:0 auto;border-collapse:collapse;">
    <tr><td>
      <table style="width:100%;border-bottom:3px solid ${NAVY};padding-bottom:16px;border-collapse:collapse;">
        <tr>
          <td style="vertical-align:middle;width:56px;padding-right:14px;">
            <img src="cid:logo" alt="Школа №2090" width="48" height="48" style="display:block;border-radius:6px;">
          </td>
          <td style="vertical-align:middle;">
            <div style="font-weight:600;color:${NAVY};font-size:12px;letter-spacing:0.06em;text-transform:uppercase;">Облако тегов · Школа №2090</div>
            <h1 style="font-size:22px;margin:4px 0 0;color:${NAVY};font-weight:600;line-height:1.3;">${escapeHtml(opts.surveyTitle)}</h1>
          </td>
        </tr>
      </table>
      <table width="100%" style="border-collapse:collapse;margin-top:16px;">${items}</table>
      <p style="color:${MUTED};font-size:12px;margin-top:32px;border-top:1px solid ${BORDER};padding-top:16px;line-height:1.5;">
        Автоматическое сообщение от сервиса опросов Школа №2090.<br>
        Не отвечайте на это письмо.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

export function resultsText(opts: ResultsTemplateInput): string {
  const lines: string[] = [`Результаты опроса: ${opts.surveyTitle}`, ''];
  opts.questions.forEach((q, i) => {
    lines.push(`Вопрос ${i + 1}: ${q.question.text}`);
    lines.push(`  Голосов: ${q.totalVotes}`);
    if (q.topWords.length === 0) {
      lines.push('  — нет ответов');
    } else {
      q.topWords.slice(0, 10).forEach(([w, c]) => lines.push(`  ${w}: ${c}`));
    }
    lines.push('');
  });
  lines.push(`Полные результаты — в прикреплённом results-${opts.surveyCode}.csv.`);
  return lines.join('\n');
}
