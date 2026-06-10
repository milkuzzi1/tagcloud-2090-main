import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static guard against the class of bug where a route handler destructures a
 * misspelled RequestEvent property (e.g. `sookies` instead of `cookies`).
 *
 * Such a typo compiles to `undefined` at the use site and only blows up at
 * runtime on the specific code path. This test reads every +server.ts handler
 * signature and asserts each destructured top-level key is a real SvelteKit
 * RequestEvent property.
 */
const VALID_EVENT_KEYS = new Set([
  'request',
  'url',
  'params',
  'route',
  'cookies',
  'fetch',
  'locals',
  'platform',
  'setHeaders',
  'getClientAddress',
  'isDataRequest',
  'isSubRequest'
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry === '+server.ts') out.push(p);
  }
  return out;
}

// Match only exported SvelteKit handler signatures, e.g.
//   export const POST: RequestHandler = async ({ request, cookies }) =>
const SIG_RE =
  /export\s+const\s+(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|fallback)\s*:\s*RequestHandler\s*=\s*(?:async\s*)?\(\s*\{\s*([^}]*?)\s*\}/g;

describe('route handler RequestEvent destructuring', () => {
  const files = walk('src/routes');

  it('finds route handlers to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`only destructures valid RequestEvent keys in ${file}`, () => {
      const src = readFileSync(file, 'utf-8');
      const bad: string[] = [];
      for (const m of src.matchAll(SIG_RE)) {
        const keys = m[1]
          .split(',')
          .map((k) =>
            k
              .trim()
              .split(':')[0]
              .trim()
              .replace(/\.\.\./, '')
          )
          .filter(Boolean);
        for (const k of keys) {
          // Only flag identifiers that look like a single property name.
          if (/^[a-zA-Z_]\w*$/.test(k) && !VALID_EVENT_KEYS.has(k)) {
            bad.push(k);
          }
        }
      }
      expect(bad, `unknown destructured params: ${bad.join(', ')}`).toEqual([]);
    });
  }
});
