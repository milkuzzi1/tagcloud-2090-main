import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

/**
 * Resolve the public-facing base URL used to build links sent to users
 * (email verification, password reset). Behind a reverse proxy `url.origin`
 * can resolve to the internal address (e.g. http://127.0.0.1:3000), which
 * produces un-clickable links in emails.
 *
 * Policy:
 *   - prefer PUBLIC_BASE_URL, then ORIGIN;
 *   - in production, FAIL FAST if neither is set rather than silently falling
 *     back to the request origin and shipping broken links;
 *   - in dev, fall back to the request origin for convenience.
 */
export function resolvePublicBaseUrl(requestOrigin: string): string {
  const configured = env.PUBLIC_BASE_URL || env.ORIGIN;
  if (configured) return configured.replace(/\/+$/, '');
  if (dev) return requestOrigin.replace(/\/+$/, '');
  throw new Error(
    'PUBLIC_BASE_URL (or ORIGIN) must be set in production so that emailed ' +
      'verification/reset links point at the public address.'
  );
}
