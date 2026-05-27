import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { tagcloudWsPlugin } from './vite-plugin-ws';

export default defineConfig({
  plugins: [sveltekit(), tagcloudWsPlugin()],
  server: {
    port: 5173,
    strictPort: true
  }
});
