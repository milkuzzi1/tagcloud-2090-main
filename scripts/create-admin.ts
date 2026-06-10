/**
 * CLI script to create the first admin account.
 *
 * Usage:
 *   ADMIN_CREATION_TOKEN="<token>" DATABASE_URL="postgres://..." \
 *     npx tsx scripts/create-admin.ts --email admin@example.com --baseUrl https://your.host
 *
 * Security (Req 1):
 *   - ADMIN_CREATION_TOKEN must be set and must equal the server-configured
 *     ADMIN_CREATION_TOKEN_EXPECTED (or be passed as --expectedToken). This
 *     stops anyone with mere DATABASE_URL access from minting an admin.
 *   - The system is designed for a SINGLE admin. If an admin already exists,
 *     the script refuses unless --force is passed (administration should be
 *     transferred from the UI, not bootstrapped again).
 *
 * The script creates the account with a random temporary password and prints
 * a password-set link to stdout; the admin opens it to set their password.
 */

import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { hashPassword } from '../src/lib/server/auth/hash';
import { users, passwordResetTokens } from '../src/lib/server/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const { values: args } = parseArgs({
  options: {
    email: { type: 'string' },
    baseUrl: { type: 'string', default: 'http://localhost:3000' },
    expectedToken: { type: 'string' },
    force: { type: 'boolean', default: false }
  }
});

if (!args.email) {
  console.error(
    'Usage: tsx scripts/create-admin.ts --email admin@example.com [--baseUrl https://yourdomain.com]'
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Error: DATABASE_URL environment variable is not set');
  process.exit(1);
}

// --- Req 1: gate admin creation behind ADMIN_CREATION_TOKEN ---------------
const providedToken = process.env.ADMIN_CREATION_TOKEN;
const expectedToken = args.expectedToken ?? process.env.ADMIN_CREATION_TOKEN_EXPECTED;
if (!providedToken) {
  console.error('Error: ADMIN_CREATION_TOKEN environment variable is not set');
  process.exit(1);
}
if (!expectedToken) {
  console.error(
    'Error: no expected token configured. Set ADMIN_CREATION_TOKEN_EXPECTED ' +
      '(server-side) or pass --expectedToken so the provided token can be verified.'
  );
  process.exit(1);
}
{
  const a = Buffer.from(providedToken);
  const b = Buffer.from(expectedToken);
  const equal = a.length === b.length && timingSafeEqual(a, b);
  if (!equal) {
    console.error('Error: ADMIN_CREATION_TOKEN does not match the expected token');
    process.exit(1);
  }
}

const email = args.email.trim().toLowerCase();
const baseUrl = (args.baseUrl ?? 'http://localhost:3000').replace(/\/$/, '');

const sql = postgres(databaseUrl);
const db = drizzle(sql);

try {
  // Req 1/3: the system is designed for a single admin. Refuse to bootstrap
  // another one unless explicitly forced — administration should be handed
  // over from the UI, which removes the outgoing admin.
  const existingAdmins = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.deletedAt)));
  if (existingAdmins.length > 0 && !args.force) {
    console.error(
      `\nAn admin already exists (${existingAdmins.length}). Refusing to create another.\n` +
        'Transfer administration from the admin UI instead, or pass --force to override.'
    );
    process.exit(1);
  }

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
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, existing.id));
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
