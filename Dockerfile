# syntax=docker/dockerfile:1
# Контейнеризация tagcloud для деплоя в docker compose (например, общий VPS
# 2090.fun с несколькими проектами за одним edge-Caddy).
#
# Сборка:   docker build -t tagcloud .
# Запуск:   docker run --env-file tagcloud.env -p 3000:3000 tagcloud
# Миграции: docker run --rm --env-file tagcloud.env tagcloud npm run db:migrate
#
# Entry — deploy/server.js (а не build/index.js): он навешивает HTTP `upgrade`
# listener, без которого WebSocket (/ws/*) в проде не работает.
#
# Переменные окружения: см. deploy/tagcloud.env.example. В контейнере
# обязательно HOST=0.0.0.0 (иначе порт не виден снаружи контейнера).

# ───────────────────────── build stage ─────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Нативные зависимости для `canvas` (если prebuilt-бинарь недоступен,
# npm соберёт модуль из исходников) и для bcrypt.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential pkg-config \
      libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# patch-package (postinstall) требует patches/ до npm ci
COPY patches ./patches
# prepare=husky не нужен в контейнере (нет .git); postinstall остаётся
RUN npm pkg delete scripts.prepare && npm ci

COPY . .
RUN npm run build

# ───────────────────────── runtime stage ─────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Runtime-библиотеки canvas + шрифты (рендер PNG-облаков требует fontconfig).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
      libjpeg62-turbo libgif7 librsvg2-2 \
      fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Копируем всё из build-стадии: build/ (приложение), node_modules (включая
# tsx для `npm run db:migrate`), scripts/ (migrate, create-admin), drizzle/.
COPY --from=build /app /app

EXPOSE 3000
USER node

# Health-проба без curl/wget (их нет в slim-образе).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "deploy/server.js"]
