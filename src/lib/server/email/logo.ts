import { env } from '$env/dynamic/private';
import { LOGO_PNG_BASE64 } from './logo-data';

let cached: Buffer | null = null;

export async function getLogoPng(): Promise<Buffer | null> {
  if (cached) return cached;
  try {
    cached = Buffer.from(LOGO_PNG_BASE64, 'base64');
    return cached;
  } catch {
    return null;
  }
}

export function getPublicLogoUrl(): string | null {
  const base = env.PUBLIC_BASE_URL || env.ORIGIN;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/logo2090.png`;
}
