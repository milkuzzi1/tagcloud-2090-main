import QRCode from 'qrcode';

const DEFAULTS = {
  size: 512,
  margin: 2,
  errorCorrectionLevel: 'M' as const,
  color: { dark: '#0E2A5C', light: '#FFFFFF' }
};

export async function qrPngBase64(
  url: string,
  opts: { size?: number; margin?: number } = {}
): Promise<string> {
  return QRCode.toDataURL(url, {
    width: opts.size ?? DEFAULTS.size,
    margin: opts.margin ?? DEFAULTS.margin,
    errorCorrectionLevel: DEFAULTS.errorCorrectionLevel,
    color: DEFAULTS.color
  });
}
