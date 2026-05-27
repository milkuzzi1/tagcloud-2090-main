CREATE TYPE "public"."answer_type" AS ENUM('single', 'multi');--> statement-breakpoint
CREATE TYPE "public"."color_scheme" AS ENUM('mono', 'random', 'custom');--> statement-breakpoint
CREATE TYPE "public"."survey_status" AS ENUM('active', 'expired', 'sent', 'failed');--> statement-breakpoint

-- users — корневая таблица для авторизации и привязки опросов.
CREATE TABLE IF NOT EXISTS "users" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "email" text NOT NULL,
    "password_hash" text,
    "email_verified" boolean NOT NULL DEFAULT false,
    "email_verified_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint

-- sessions — куки-сессии (id хранится как opaque token, см. auth/sessions.ts).
CREATE TABLE IF NOT EXISTS "sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" uuid NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- email_verification_tokens — одноразовые ссылки подтверждения email.
CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
    "token" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL,
    "email" text NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

-- surveys — корневая сущность опроса. creator_token — legacy-доступ по ?t=,
-- user_id — современный путь через сессионные cookies.
CREATE TABLE IF NOT EXISTS "surveys" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "code" varchar(6) NOT NULL,
    "creator_token" uuid DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid,
    "title" text,
    "creator_email" text NOT NULL,
    "case_sensitive" boolean DEFAULT false NOT NULL,
    "color_scheme" "color_scheme" DEFAULT 'mono' NOT NULL,
    "custom_palette" jsonb,
    "expires_at" timestamp with time zone NOT NULL,
    "status" "survey_status" DEFAULT 'active' NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "surveys_code_unique" UNIQUE("code"),
    CONSTRAINT "surveys_creator_token_unique" UNIQUE("creator_token")
);
--> statement-breakpoint

-- questions — вопросы опроса. max_answers — индивидуальный лимит для multi
-- (default 20 = прежнее хардкод-поведение в r/[code]); CHECK 1..200 — потолок,
-- защищающий от создания вопроса со заведомо нелепыми параметрами.
CREATE TABLE IF NOT EXISTS "questions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "survey_id" uuid NOT NULL,
    "text" text NOT NULL,
    "answer_type" "answer_type" NOT NULL,
    "max_answers" integer NOT NULL DEFAULT 20,
    "position" integer NOT NULL,
    CONSTRAINT "questions_max_answers_range" CHECK ("max_answers" BETWEEN 1 AND 200)
);
--> statement-breakpoint

-- responses — все «голоса». bigserial PK, чтобы спокойно переживать
-- многомиллионные нагрузки без переполнения int4.
CREATE TABLE IF NOT EXISTS "responses" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "question_id" uuid NOT NULL,
    "word" text NOT NULL,
    "word_norm" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Foreign keys. Все каскадные — удаление пользователя/опроса вычищает всё,
-- что от него зависит, без отдельных DELETE-волн в коде.
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "evt_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "surveys" ADD CONSTRAINT "surveys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "questions" ADD CONSTRAINT "questions_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "responses" ADD CONSTRAINT "responses_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Индексы. Все покрывают конкретные горячие пути:
--   sessions_user_idx           — отзыв всех сессий пользователя при logout-all;
--   sessions_expires_idx        — cron-чистка истёкших сессий;
--   evt_user_idx / evt_expires  — поиск/чистка verification-токенов;
--   surveys_expires_status_idx  — cron expiry processor (FOR UPDATE SKIP LOCKED);
--   surveys_user_idx            — список «мои опросы» отсортированный по дате;
--   questions_survey_idx        — загрузка вопросов опроса по позиции;
--   responses_question_word_idx — агрегация облака по (question_id, word_norm).
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evt_user_idx" ON "email_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evt_expires_idx" ON "email_verification_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "surveys_expires_status_idx" ON "surveys" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "surveys_user_idx" ON "surveys" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "questions_survey_idx" ON "questions" USING btree ("survey_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "responses_question_word_idx" ON "responses" USING btree ("question_id","word_norm");
