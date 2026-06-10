import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  integer,
  bigserial,
  jsonb,
  check,
  index,
  uniqueIndex,
  pgEnum
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const colorScheme = pgEnum('color_scheme', ['mono', 'random', 'custom', 'custom_gradient']);
export const answerType = pgEnum('answer_type', ['single', 'multi']);
export const surveyStatus = pgEnum('survey_status', ['active', 'expired', 'sent', 'failed']);
export const userRole = pgEnum('user_role', ['admin', 'user']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Uniqueness is enforced by a PARTIAL unique index on (email) WHERE
    // deleted_at IS NULL (see migration 0007). It is not a plain column UNIQUE
    // because soft-deleted rows may share an email with the live row.
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    emailVerified: boolean('email_verified').notNull().default(false),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    role: userRole('role').notNull().default('user'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    emailLiveUnique: uniqueIndex('users_email_live_unique')
      .on(t.email)
      .where(sql`${t.deletedAt} IS NULL`)
  })
);

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    token: uuid('token').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    userIdx: index('evt_user_idx').on(t.userId),
    expiresIdx: index('evt_expires_idx').on(t.expiresAt)
  })
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    token: text('token').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    userIdx: index('prt_user_idx').on(t.userId),
    expiresIdx: index('prt_expires_idx').on(t.expiresAt)
  })
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
    expiresIdx: index('sessions_expires_idx').on(t.expiresAt)
  })
);

export const organizationInvites = pgTable(
  'organization_invites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Уникальность гарантирует uniqueIndex ниже. Отдельный .unique() на колонке
    // создавал бы ВТОРОЙ (дублирующий) constraint при drizzle-kit generate.
    email: text('email').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    emailIdx: uniqueIndex('org_invites_email_idx').on(t.email)
  })
);

export const pendingAdminHandover = pgTable(
  'pending_admin_handover',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    incomingUserId: uuid('incoming_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    outgoingUserId: uuid('outgoing_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    keepOutgoingData: boolean('keep_outgoing_data').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    incomingIdx: uniqueIndex('pending_handover_incoming_idx').on(t.incomingUserId)
  })
);

export const surveys = pgTable(
  'surveys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: varchar('code', { length: 6 }).notNull().unique(),
    creatorToken: uuid('creator_token').notNull().defaultRandom().unique(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    title: text('title'),
    creatorEmail: text('creator_email').notNull(),
    caseSensitive: boolean('case_sensitive').notNull().default(false),
    colorScheme: colorScheme('color_scheme').notNull().default('mono'),
    customPalette: jsonb('custom_palette').$type<string[] | null>(),
    maxWords: integer('max_words').notNull().default(50),
    allowVertical: boolean('allow_vertical').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: surveyStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    expiresIdx: index('surveys_expires_status_idx').on(t.status, t.expiresAt),
    userIdx: index('surveys_user_idx').on(t.userId, t.createdAt),
    // CHECK как в миграциях 0000/0002 — держим источником истины и схему.
    maxWordsRange: check('surveys_max_words_range', sql`${t.maxWords} BETWEEN 1 AND 500`)
  })
);

export const questions = pgTable(
  'questions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    surveyId: uuid('survey_id')
      .notNull()
      .references(() => surveys.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    answerType: answerType('answer_type').notNull(),
    maxAnswers: integer('max_answers').notNull().default(20),
    position: integer('position').notNull()
  },
  (t) => ({
    surveyIdx: index('questions_survey_idx').on(t.surveyId, t.position),
    maxAnswersRange: check('questions_max_answers_range', sql`${t.maxAnswers} BETWEEN 1 AND 200`)
  })
);

export const responses = pgTable(
  'responses',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    word: text('word').notNull(),
    wordNorm: text('word_norm').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    qWordIdx: index('responses_question_word_idx').on(t.questionId, t.wordNorm)
  })
);

export const emailLog = pgTable(
  'email_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    dedupKey: text('dedup_key').notNull().unique(),
    emailType: text('email_type').notNull(),
    toAddr: text('to_addr').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    sentAtIdx: index('email_log_sent_at_idx').on(t.sentAt)
  })
);

export type User = typeof users.$inferSelect;
export type Survey = typeof surveys.$inferSelect;
export type Question = typeof questions.$inferSelect;
export type Response = typeof responses.$inferSelect;
export type EmailLog = typeof emailLog.$inferSelect;
