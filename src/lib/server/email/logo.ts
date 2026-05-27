import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

let cached: Buffer | null = null;

/**
 * Читает PNG логотипа школы из `static/logo2090.png` (резолвится относительно
 * корня репозитория, чтобы работать одинаково и в dev (vite-tsx), и в prod
 * (build/), и в worker_threads). Результат кешируется на время жизни процесса.
 */
export async function getLogoPng(): Promise<Buffer | null> {
  if (cached) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/lib/server/email/logo.ts → подняться в корень и взять static/logo2090.png
    const candidates = [
      resolve(here, '../../../../static/logo2090.png'),
      resolve(process.cwd(), 'static/logo2090.png'),
      resolve(process.cwd(), 'logo2090.png')
    ];
    for (const p of candidates) {
      try {
        cached = await readFile(p);
        return cached;
      } catch {
        // try next
      }
    }
  } catch {
    // ignore
  }
  return null;
}
