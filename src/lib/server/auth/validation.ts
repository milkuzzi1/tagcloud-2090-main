import { z } from 'zod';

// bcrypt усекает пароль до 72 БАЙТ (не символов). 72-символьная проверка
// пропускала пароли из многобайтовых символов (кириллица, эмодзи): строка из
// 72 символов могла занимать >72 байт, и bcrypt молча отбрасывал хвост — два
// разных пароля могли совпасть по усечённому префиксу. Валидируем по байтам в
// UTF-8 (Buffer.byteLength), чтобы реальная длина не превышала лимит bcrypt.
const passwordField = z
  .string()
  .min(8, 'Пароль не короче 8 символов')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= 72, 'Пароль не длиннее 72 байт');

export const CredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email('Некорректный email').max(254),
  password: passwordField
});

export type Credentials = z.infer<typeof CredentialsSchema>;

export const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email('Некорректный email').max(254),
  password: passwordField
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Некорректный email').max(254),
  password: passwordField
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const ForgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Некорректный email').max(254)
});
export type ForgotPassword = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().min(10).max(256),
  password: passwordField
});
export type ResetPassword = z.infer<typeof ResetPasswordSchema>;

export const InviteEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email('Некорректный email').max(254),
  note: z.string().trim().max(200).optional()
});
export type InviteEmail = z.infer<typeof InviteEmailSchema>;
