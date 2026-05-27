// ESLint flat-config (v9). Включаем только правила, которые ловят реальные
// баги, а не стилистику — стиль форматит Prettier.
import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs['flat/recommended'],
  prettier,
  ...svelte.configs['flat/prettier'],
  {
    languageOptions: {
      globals: {
        // Browser-side
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        Event: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        HTMLElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLFormElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLImageElement: 'readonly',
        FormData: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        Image: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        getComputedStyle: 'readonly',
        // Node-side (server)
        process: 'readonly',
        Buffer: 'readonly',
        globalThis: 'readonly',
        performance: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        NodeJS: 'readonly'
      }
    },
    rules: {
      // unused vars/args допускаем, если префикс _.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      // any — намеренное решение в редких местах (динамический result.rows и т.п.),
      // не делаем error.
      '@typescript-eslint/no-explicit-any': 'warn',
      // SvelteKit-проект: empty catch — обычная история (best-effort cleanup).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Svelte ругается на a11y-вещи внутри custom-компонентов. Включаем
      // только те, что реально влияют на UX.
      'svelte/no-at-html-tags': 'off', // используем доверенные HTML из email.ts
      // SvelteKit 2.x правило про `resolve()` в navigation — стилистическое
      // и шумное на текущей кодовой базе. Голос ESLint больше не предупреждает
      // о реальных багах, лишь о смене API; включим только когда команда решит
      // делать миграцию централизованно.
      'svelte/no-navigation-without-resolve': 'off'
    }
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: ts.parser
      }
    }
  },
  {
    ignores: [
      'build/',
      '.svelte-kit/',
      'dist/',
      'node_modules/',
      'workers/',
      'drizzle/',
      'static/',
      'package-lock.json'
    ]
  }
];
