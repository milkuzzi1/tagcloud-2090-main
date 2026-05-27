-- Расширяем enum цветовых схем: добавляем 'custom_gradient'
-- (линейная интерполяция по популярности).
-- Существующее значение 'custom' сохраняем за «своя палитра (случайно)».
ALTER TYPE "public"."color_scheme" ADD VALUE IF NOT EXISTS 'custom_gradient';
--> statement-breakpoint

-- max_words — лимит на количество слов, отображаемых в облаке (UI и email).
-- 50 — компромисс между плотностью и читаемостью; д3-cloud/wordcloud.js
-- начинают «толкаться» сильно дальше ~100 слов на стандартном холсте.
ALTER TABLE "surveys" ADD COLUMN IF NOT EXISTS "max_words" integer NOT NULL DEFAULT 50;
--> statement-breakpoint

-- allow_vertical — разрешает поворот случайных слов вертикально.
-- false по умолчанию: горизонтально читать проще, но иногда хочется
-- «классический» вид облака — переключатель отдан создателю опроса.
ALTER TABLE "surveys" ADD COLUMN IF NOT EXISTS "allow_vertical" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- CHECK на разумный диапазон max_words. 1 — минимум, 500 — потолок,
-- покрывающий все realистичные сценарии (UI ограничивает 200, но 500
-- даёт запас на будущее).
DO $$ BEGIN
  ALTER TABLE "surveys" ADD CONSTRAINT "surveys_max_words_range" CHECK ("max_words" BETWEEN 1 AND 500);
EXCEPTION WHEN duplicate_object THEN null;
END $$;
