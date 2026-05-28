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
