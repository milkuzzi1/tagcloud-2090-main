import { describe, it, expect } from 'vitest';
import {
  CredentialsSchema,
  ForgotPasswordSchema,
  InviteEmailSchema,
  LoginSchema,
  RegisterSchema,
  ResetPasswordSchema
} from '../../src/lib/server/auth/validation';

describe('CredentialsSchema', () => {
  it('принимает валидный email и пароль ≥ 8 символов', () => {
    const out = CredentialsSchema.parse({ email: 'User@Example.COM', password: 'secret12' });
    expect(out.email).toBe('user@example.com');
    expect(out.password).toBe('secret12');
  });

  it('обрезает пробелы в email', () => {
    const out = CredentialsSchema.parse({ email: '  hi@x.com  ', password: 'secret12' });
    expect(out.email).toBe('hi@x.com');
  });

  it('ругается на пароль короче 8', () => {
    const r = CredentialsSchema.safeParse({ email: 'a@b.com', password: 'short' });
    expect(r.success).toBe(false);
  });

  it('ругается на пароль длиннее 72 байт (bcrypt limit)', () => {
    const r = CredentialsSchema.safeParse({ email: 'a@b.com', password: 'x'.repeat(73) });
    expect(r.success).toBe(false);
  });

  it('ругается на пароль ≤72 символов, но >72 байт (многобайтовые символы)', () => {
    // 37 кириллических символов = 74 байта в UTF-8 (2 байта на символ): по
    // символам прошёл бы старый лимит 72, по байтам — нет.
    const pwd = 'п'.repeat(37);
    expect(pwd.length).toBeLessThanOrEqual(72);
    expect(Buffer.byteLength(pwd, 'utf8')).toBeGreaterThan(72);
    expect(CredentialsSchema.safeParse({ email: 'a@b.com', password: pwd }).success).toBe(false);
  });

  it('принимает пароль ровно 72 байта', () => {
    const r = CredentialsSchema.safeParse({ email: 'a@b.com', password: 'x'.repeat(72) });
    expect(r.success).toBe(true);
  });

  it('ругается на невалидный email', () => {
    const r = CredentialsSchema.safeParse({ email: 'not-an-email', password: 'secret12' });
    expect(r.success).toBe(false);
  });

  it('ругается на email длиннее 254 (RFC 5321)', () => {
    const long = 'a'.repeat(250) + '@b.com';
    const r = CredentialsSchema.safeParse({ email: long, password: 'secret12' });
    expect(r.success).toBe(false);
  });
});

describe('RegisterSchema', () => {
  it('принимает email + пароль, нормализует email', () => {
    const out = RegisterSchema.parse({ email: 'A@b.com', password: 'secret12' });
    expect(out.email).toBe('a@b.com');
    expect(out.password).toBe('secret12');
  });

  it('ругается без email', () => {
    expect(RegisterSchema.safeParse({ password: 'secret12' }).success).toBe(false);
  });

  it('ругается на короткий пароль', () => {
    expect(RegisterSchema.safeParse({ email: 'a@b.com', password: 'short' }).success).toBe(false);
  });
});

describe('LoginSchema', () => {
  it('требует email и password (без organizationName)', () => {
    expect(LoginSchema.safeParse({ password: 'secret12' }).success).toBe(false);
    expect(LoginSchema.safeParse({ email: 'a@b.com', password: 'secret12' }).success).toBe(true);
  });

  it('нормализует email', () => {
    const out = LoginSchema.parse({ email: '  X@Y.COM ', password: 'secret12' });
    expect(out.email).toBe('x@y.com');
  });
});

describe('ForgotPasswordSchema', () => {
  it('обрезает и нормализует email', () => {
    const out = ForgotPasswordSchema.parse({ email: '  X@Y.COM ' });
    expect(out.email).toBe('x@y.com');
  });

  it('ругается на невалидный email', () => {
    expect(ForgotPasswordSchema.safeParse({ email: 'nope' }).success).toBe(false);
  });
});

describe('ResetPasswordSchema', () => {
  it('принимает токен и пароль ≥ 8', () => {
    const r = ResetPasswordSchema.safeParse({
      token: 'a'.repeat(20),
      password: 'secret12'
    });
    expect(r.success).toBe(true);
  });

  it('ругается на короткий токен', () => {
    expect(ResetPasswordSchema.safeParse({ token: 'short', password: 'secret12' }).success).toBe(
      false
    );
  });
});

describe('InviteEmailSchema', () => {
  it('нормализует email', () => {
    const out = InviteEmailSchema.parse({ email: ' Foo@Bar.COM ' });
    expect(out.email).toBe('foo@bar.com');
  });

  it('ругается на невалидный email', () => {
    expect(InviteEmailSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });
});
