import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    alias: {
      $lib: 'src/lib'
    },
    // Content-Security-Policy: SvelteKit сам подставит nonce в инлайновые
    // <script> и <style>, которые он генерирует (в т.ч. для гидрации). Внешние
    // скрипты/стили этот проект не использует. WS подключаемся только к origin.
    //
    // `style-src-attr 'unsafe-inline'` нужен для inline-style-атрибутов,
    // которые проставляет рантайм-код:
    //   - SvelteKit aria-live announcer (`<div style="position: absolute; …">`),
    //   - Svelte 5 css-wrapper (`<svelte-css-wrapper style="display: contents; …">`),
    //   - наши `style:`/`style={…}` директивы (например, динамический градиент
    //     палитры в /new). Хеши/нонсы для `style-src-attr` SvelteKit не выдаёт,
    //     поэтому без `unsafe-inline` они блокируются — а сам `style-src 'self'`
    //     для атрибутов style="…" в CSP3 не работает.
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        'style-src': ['self'],
        'style-src-attr': ['unsafe-inline'],
        'img-src': ['self', 'data:'],
        'font-src': ['self', 'data:'],
        'connect-src': ['self'],
        'frame-ancestors': ['none'],
        'form-action': ['self'],
        'base-uri': ['self'],
        'object-src': ['none']
      }
    }
  }
};

export default config;
