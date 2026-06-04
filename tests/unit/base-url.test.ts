import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SvelteKit virtual modules the helper depends on.
const envState: { dev: boolean; env: Record<string, string | undefined> } = {
  dev: false,
  env: {}
};

vi.mock('$app/environment', () => ({
  get dev() {
    return envState.dev;
  }
}));

vi.mock('$env/dynamic/private', () => ({
  get env() {
    return envState.env;
  }
}));

async function load() {
  // Re-import fresh each time so the getters see current envState.
  return await import('../../src/lib/server/net/base-url');
}

describe('resolvePublicBaseUrl', () => {
  beforeEach(() => {
    envState.dev = false;
    envState.env = {};
    vi.resetModules();
  });

  it('prefers PUBLIC_BASE_URL and strips trailing slashes', async () => {
    envState.env = { PUBLIC_BASE_URL: 'https://app.example.com/' };
    const { resolvePublicBaseUrl } = await load();
    expect(resolvePublicBaseUrl('http://127.0.0.1:3000')).toBe('https://app.example.com');
  });

  it('falls back to ORIGIN when PUBLIC_BASE_URL is unset', async () => {
    envState.env = { ORIGIN: 'https://origin.example.com' };
    const { resolvePublicBaseUrl } = await load();
    expect(resolvePublicBaseUrl('http://127.0.0.1:3000')).toBe('https://origin.example.com');
  });

  it('throws in production when neither is set (no silent broken-link fallback)', async () => {
    envState.dev = false;
    envState.env = {};
    const { resolvePublicBaseUrl } = await load();
    expect(() => resolvePublicBaseUrl('http://127.0.0.1:3000')).toThrow(/PUBLIC_BASE_URL/);
  });

  it('falls back to request origin in dev for convenience', async () => {
    envState.dev = true;
    envState.env = {};
    const { resolvePublicBaseUrl } = await load();
    expect(resolvePublicBaseUrl('http://localhost:5173/')).toBe('http://localhost:5173');
  });
});
