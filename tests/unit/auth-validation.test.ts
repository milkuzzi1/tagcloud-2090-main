import { describe, it, expect } from 'vitest';
import {
  AdminRegisterSchema,
  CredentialsSchema,
  ForgotPasswordSchema,
  InviteEmailSchema,
  LoginSchema,
  normalizeOrgName,
  OrganizationNameSchema,
  ResetPasswordSchema,
  UserRegisterSchema
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

  it('ругается на пароль длиннее 72 (bcrypt limit)', () => {
    const r = CredentialsSchema.safeParse({ email: 'a@b.com', password: 'x'.repeat(73) });
    expect(r.success).toBe(false);
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

describe('OrganizationNameSchema', () => {
  it('обрезает пробелы и принимает обычное название', () => {
    expect(OrganizationNameSchema.parse('  Школа №2090  ')).toBe('Школа №2090');
  });

  it('ругается на пустую строку', () => {
    expect(OrganizationNameSchema.safeParse('   ').success).toBe(false);
  });

  it('ругается на > 100 символов', () => {
    expect(OrganizationNameSchema.safeParse('a'.repeat(101)).success).toBe(false);
  });
});

describe('normalizeOrgName', () => {
  it('игнорирует регистр и пробелы по краям', () => {
    expect(normalizeOrgName('  Школа №2090  ')).toBe('школа №2090');
    expect(normalizeOrgName('ШКОЛА №2090')).toBe('школа №2090');
  });

  it('считает разные регистры одинаковыми (для UNIQUE-контракта)', () => {
    expect(normalizeOrgName('Foo')).toBe(normalizeOrgName('FOO'));
    expect(normalizeOrgName('Foo Bar')).toBe(normalizeOrgName('foo bar'));
  });
});

describe('AdminRegisterSchema / UserRegisterSchema', () => {
  it('принимает валидный набор полей', () => {
    const out = AdminRegisterSchema.parse({
      organizationName: 'Школа №2090',
      email: 'A@b.com',
      password: 'secret12'
    });
    expect(out.organizationName).toBe('Школа №2090');
    expect(out.email).toBe('a@b.com');
  });

  it('ругается без organizationName', () => {
    expect(AdminRegisterSchema.safeParse({ email: 'a@b.com', password: 'secret12' }).success).toBe(
      false
    );
  });

  it('UserRegisterSchema принимает те же поля, что и Admin', () => {
    const r = UserRegisterSchema.safeParse({
      organizationName: 'Org',
      email: 'a@b.com',
      password: 'secret12'
    });
    expect(r.success).toBe(true);
  });
});

describe('LoginSchema', () => {
  it('требует organizationName, email и password', () => {
    expect(LoginSchema.safeParse({ email: 'a@b.com', password: 'secret12' }).success).toBe(false);
    expect(
      LoginSchema.safeParse({
        organizationName: 'Org',
        email: 'a@b.com',
        password: 'secret12'
      }).success
    ).toBe(true);
  });
});

describe('ForgotPasswordSchema', () => {
  it('обрезает email и принимает org+email', () => {
    const out = ForgotPasswordSchema.parse({
      organizationName: ' Org ',
      email: '  X@Y.COM '
    });
    expect(out.organizationName).toBe('Org');
    expect(out.email).toBe('x@y.com');
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
