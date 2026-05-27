import { env } from '$env/dynamic/private';
import { getTransporter } from './smtp';
import { resultsHtml, resultsText, type AggregatedQuestion } from './templates';

export type EmailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
  /** Если задан — вложение становится inline и доступно в HTML как `cid:<value>`. */
  cid?: string;
};

export type SendResultsInput = {
  to: string;
  surveyTitle: string;
  surveyCode: string;
  questions: AggregatedQuestion[];
  attachments: EmailAttachment[];
};

export async function sendResultsEmail(input: SendResultsInput): Promise<void> {
  const t = getTransporter();
  if (!t) throw new Error('SMTP не настроен (SMTP_HOST пуст)');

  const fromAddr = env.SMTP_FROM ?? env.SMTP_USER;
  if (!fromAddr) throw new Error('SMTP_FROM не задан (и SMTP_USER пуст)');
  await t.sendMail({
    from: fromAddr,
    to: input.to,
    subject: `Результаты опроса «${input.surveyTitle}»`,
    text: resultsText(input),
    html: resultsHtml(input),
    attachments: input.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
      ...(a.cid ? { cid: a.cid } : {})
    }))
  });
}
