import { env } from '$env/dynamic/private';

export function getPublicLogoUrl(): string | null {
  const base = env.PUBLIC_BASE_URL || env.ORIGIN;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/logo2090.png`;
}
