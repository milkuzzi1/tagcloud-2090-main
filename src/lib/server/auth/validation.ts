import { z } from 'zod';

export const CredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email('Некорректный email').max(254),
  password: z
    .string()
    .min(8, 'Пароль не короче 8 символов')
    .max(72, 'Пароль не длиннее 72 символов')
});

export type Credentials = z.infer<typeof CredentialsSchema>;

export const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email('Некорректный email').max(254),
  password: z
    .string()
    .min(8, 'Пароль не короче 8 символов')
    .max(72, 'Пароль не длиннее 72 символов')
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Некорректный email').max(254),
  password: z
    .string()
    .min(8, 'Пароль не короче 8 символов')
    .max(72, 'Пароль не длиннее 72 символов')
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const ForgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Некорректный email').max(254)
});
export type ForgotPassword = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().min(10).max(256),
  password: z
    .string()
    .min(8, 'Пароль не короче 8 символов')
    .max(72, 'Пароль не длиннее 72 символов')
});
export type ResetPassword = z.infer<typeof ResetPasswordSchema>;

export const InviteEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email('Некорректный email').max(254),
  note: z.string().trim().max(200).optional()
});
export type InviteEmail = z.infer<typeof InviteEmailSchema>;
