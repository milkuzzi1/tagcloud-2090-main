-- 0002_organizations.sql
-- Переход на мульти-арендную модель: организации, роли admin/user, allowlist
-- (organization_invites), восстановление пароля (password_reset_tokens) и
-- soft-delete пользователей (deleted_at).
--
-- ВНИМАНИЕ: миграция деструктивная — пересоздаёт users и все зависимые таблицы.
-- По договорённости с владельцем продукта существующие пользователи и данные
-- сбрасываются (см. план distributed-crunching-pretzel.md, секция 1).

-- 1. Сносим старую схему данных пользователей и зависимостей.
DROP TABLE IF EXISTS "responses" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "questions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "surveys" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "sessions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "email_verification_tokens" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "users" CASCADE;--> statement-breakpoint

-- 2. Роль пользователя: 'admin' создаёт организацию и управляет allowlist;
--    'user' — обычный участник.
CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');--> statement-breakpoint

-- 3. organizations — корневой тенант. name_normalized = lower(trim(name)),
--    используется для регистронезависимого поиска и UNIQUE-контракта.
CREATE TABLE "organizations" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" text NOT NULL,
    "name_normalized" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "organizations_name_normalized_unique" UNIQUE("name_normalized")
);
--> statement-breakpoint

-- 4. users — теперь обязательно привязан к организации. email уникален в
--    пределах (organization_id, email). deleted_at — soft-delete (опция
--    «оставить данные пользователя в базе данных» при удалении из организации).
CREATE TABLE "users" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" uuid NOT NULL,
    "email" text NOT NULL,
    "password_hash" text,
    "email_verified" boolean NOT NULL DEFAULT false,
    "email_verified_at" timestamp with time zone,
    "role" "user_role" NOT NULL DEFAULT 'user',
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- 5. organization_invites — allowlist: записи, разрешающие email-у
--    регистрацию в конкретной организации. Удаление = ревокация доступа
--    к будущим регистрациям, но не трогает уже зарегистрированных users.
CREATE TABLE "organization_invites" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" uuid NOT NULL,
    "email" text NOT NULL,
    "invited_by" uuid,
    "invited_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "organization_invites" ADD CONSTRAINT "org_invites_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "org_invites_invited_by_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- 6. password_reset_tokens — одноразовые токены сброса пароля.
--    Token — opaque строка (32 байта в base64url), как для sessions.
CREATE TABLE "password_reset_tokens" (
    "token" text PRIMARY KEY NOT NULL,
    "user_id" uuid NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "prt_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- 7. sessions — пересоздаём как было (FK теперь смотрит на новую users).
CREATE TABLE "sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" uuid NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- 8. email_verification_tokens — без изменений, FK обновлён.
CREATE TABLE "email_verification_tokens" (
    "token" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL,
    "email" text NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "evt_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- 9. surveys, questions, responses — копия из 0000 + 0001 (max_words, allow_vertical).
CREATE TABLE "surveys" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "code" varchar(6) NOT NULL,
    "creator_token" uuid DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid,
    "title" text,
    "creator_email" text NOT NULL,
    "case_sensitive" boolean DEFAULT false NOT NULL,
    "color_scheme" "color_scheme" DEFAULT 'mono' NOT NULL,
    "custom_palette" jsonb,
    "max_words" integer NOT NULL DEFAULT 50,
    "allow_vertical" boolean NOT NULL DEFAULT false,
    "expires_at" timestamp with time zone NOT NULL,
    "status" "survey_status" DEFAULT 'active' NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "surveys_code_unique" UNIQUE("code"),
    CONSTRAINT "surveys_creator_token_unique" UNIQUE("creator_token"),
    CONSTRAINT "surveys_max_words_range" CHECK ("max_words" BETWEEN 1 AND 500)
);
--> statement-breakpoint

ALTER TABLE "surveys" ADD CONSTRAINT "surveys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "questions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "survey_id" uuid NOT NULL,
    "text" text NOT NULL,
    "answer_type" "answer_type" NOT NULL,
    "max_answers" integer NOT NULL DEFAULT 20,
    "position" integer NOT NULL,
    CONSTRAINT "questions_max_answers_range" CHECK ("max_answers" BETWEEN 1 AND 200)
);
--> statement-breakpoint

ALTER TABLE "questions" ADD CONSTRAINT "questions_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "responses" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "question_id" uuid NOT NULL,
    "word" text NOT NULL,
    "word_norm" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "responses" ADD CONSTRAINT "responses_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- 10. Индексы. Горячие пути:
--   users_org_email_unique     — гарантия уникальности email в рамках организации + быстрый login lookup;
--   users_org_idx              — список members организации (admin UI);
--   org_invites_org_email_unique — гарантия одной allowlist-записи на (org, email);
--   prt_user_idx / prt_expires_idx — поиск/чистка password_reset_tokens.
--   Остальное — копия из 0000.
CREATE UNIQUE INDEX "users_org_email_unique" ON "users" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_invites_org_email_unique" ON "organization_invites" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "prt_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "prt_expires_idx" ON "password_reset_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "evt_user_idx" ON "email_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "evt_expires_idx" ON "email_verification_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "surveys_expires_status_idx" ON "surveys" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "surveys_user_idx" ON "surveys" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "questions_survey_idx" ON "questions" USING btree ("survey_id","position");--> statement-breakpoint
CREATE INDEX "responses_question_word_idx" ON "responses" USING btree ("question_id","word_norm");
