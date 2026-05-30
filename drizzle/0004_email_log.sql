CREATE TABLE "email_log" (
"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
"dedup_key" text NOT NULL UNIQUE,
"email_type" text NOT NULL,
"to_addr" text NOT NULL,
"sent_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "email_log_sent_at_idx" ON "email_log" ("sent_at");
