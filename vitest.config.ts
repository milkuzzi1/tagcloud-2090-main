import { defineConfig } from 'vitest/config';

/**
 * vitest для юнит-тестов чистой логики (валидация, нормализация,
 * rate-limit token-bucket, верификация tokens и т.п.).
 *
 * Тесты, требующие postgres/redis, помечены `describe.skipIf(...)` и
 * пропускаются в CI без сервисов. Локально запускаются с `docker compose
 * up -d postgres redis` + `npm test`.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'tests/unit/**/*.{test,spec}.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/app.html', 'src/app.d.ts']
    }
  },
  resolve: {
    alias: {
      $lib: '/src/lib'
    }
  }
});
