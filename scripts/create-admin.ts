/**
 * CLI script to create the first admin account.
 *
 * Usage:
 *   DATABASE_URL="postgres://..." npx tsx scripts/create-admin.ts --email admin@example.com
 *
 * The script creates the account with a random temporary password
 * and prints a password-set link to stdout.
 * The admin must open that link to set their password before logging in.
 */

import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { hashPassword } from '../src/lib/server/auth/hash';
import { users, passwordResetTokens } from '../src/lib/server/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

const { values: args } = parseArgs({
  options: {
    email: { type: 'string' },
    baseUrl: { type: 'string', default: 'http://localhost:3000' }
  }
});

if (!args.email) {
  console.error('Usage: tsx scripts/create-admin.ts --email admin@example.com [--baseUrl https://yourdomain.com]');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Error: DATABASE_URL environment variable is not set');
  process.exit(1);
}

const email = args.email.trim().toLowerCase();
const baseUrl = (args.baseUrl ?? 'http://localhost:3000').replace(/\/$/, '');

const sql = postgres(databaseUrl);
const db = drizzle(sql);

try {
  // Check if user already exists
  const [existing] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);

  let userId: string;

  if (existing) {
    if (existing.role === 'admin') {
      console.log(`\n\u2763 ${email} is already an admin.`);
      console.log('If you need to reset their password, use the forgot-password flow.');
      process.exit(0);
    }
    // Upgrade existing user to admin
    await db.update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, existing.id));
    userId = existing.id;
    console.log(`\n\u2763 Upgraded existing user ${email} to admin.`);
  } else {
    // Create new admin with random temporary password
    const tmpPassword = randomBytes(32).toString('hex');
    const passwordHash = await hashPassword(tmpPassword);
    const now = new Date();
    const [created] = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        role: 'admin',
        emailVerified: true,
        emailVerifiedAt: now
      })
      .returning({ id: users.id });
    userId = created.id;
    console.log(`\n\u2763 Created new admin: ${email}`);
  }

  // Generate password-reset token (valid 24h)
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.insert(passwordResetTokens).values({
    token,
    userId,
    expiresAt
  });

  const setPasswordUrl = `${baseUrl}/reset-password?t=${token}`;

  console.log('\nSend this link to the admin to set their password:');
  console.log(`\n  ${setPasswordUrl}\n`);
  console.log('Link expires in 24h.');
} finally {
  await sql.end();
}
