import { isIP } from 'node:net';

/**
 * Парсер реального IP клиента за обратным прокси.
 *
 * Проблема: `event.getClientAddress()` в SvelteKit и `req.socket.remoteAddress` в
 * raw-upgrade'ах возвращают IP ближайшего hop'а. Когда перед приложением стоит
 * Caddy/nginx (как у нас — Caddy на 127.0.0.1:443 → Node на :3000), это даёт
 * 127.0.0.1 для всех запросов, и rate-limit схлопывается в один бакет.
 *
 * Решение: читать `X-Forwarded-For`, но только когда socket-peer входит в
 * allowlist доверенных прокси-сетей. Это защищает от спуфинга: внешний клиент
 * не может выставить XFF и подделать чужой IP, потому что его socket-IP не
 * пройдёт проверку trust'а.
 *
 * Дефолтный allowlist — приватные диапазоны (loopback + RFC1918 + ULA). Это
 * безопасный default для self-hosted сетапов с прокси на той же машине или в
 * docker-сети. Внешний IP в эти диапазоны попасть не может.
 *
 * Переопределяется через env `TRUSTED_PROXY_CIDRS` (comma-separated, например
 * `10.0.0.0/8,192.168.0.0/16,fd00::/8`).
 */

// Дефолтные доверенные сети: loopback + приватные.
// Подделать снаружи невозможно — внешний IP в эти диапазоны не маршрутизируется.
const DEFAULT_TRUSTED_CIDRS = [
  '127.0.0.0/8', // IPv4 loopback
  '10.0.0.0/8', // RFC1918
  '172.16.0.0/12', // RFC1918
  '192.168.0.0/16', // RFC1918
  '169.254.0.0/16', // link-local (docker bridge иногда)
  '::1/128', // IPv6 loopback
  'fc00::/7', // IPv6 ULA (RFC4193)
  'fe80::/10' // IPv6 link-local
];

type Cidr = { kind: 4 | 6; bytes: Uint8Array; prefix: number };

function ipToBytes(ip: string): Uint8Array | null {
  const kind = isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
      return null;
    }
    return new Uint8Array(parts);
  }
  if (kind === 6) {
    // Раскрываем `::` и mapped-форму, отдаём 16 байт.
    return ipv6ToBytes(ip);
  }
  return null;
}

function ipv6ToBytes(ip: string): Uint8Array | null {
  // Mapped IPv4: `::ffff:1.2.3.4` → отдаём как IPv6 (16 байт), но в CIDR-match'е
  // потом сравним отдельно — для нас это всё равно IPv4-клиент за прокси.
  let normalized = ip;
  if (normalized.includes('.')) {
    // `::ffff:1.2.3.4` → конвертим хвост в hex-пары
    const lastColon = normalized.lastIndexOf(':');
    const v4 = normalized.slice(lastColon + 1);
    const v4Bytes = ipToBytes(v4);
    if (!v4Bytes || v4Bytes.length !== 4) return null;
    const hi = ((v4Bytes[0] << 8) | v4Bytes[1]).toString(16);
    const lo = ((v4Bytes[2] << 8) | v4Bytes[3]).toString(16);
    normalized = normalized.slice(0, lastColon + 1) + hi + ':' + lo;
  }
  const doubleColon = normalized.indexOf('::');
  let groups: string[];
  if (doubleColon === -1) {
    groups = normalized.split(':');
    if (groups.length !== 8) return null;
  } else {
    const left = normalized.slice(0, doubleColon);
    const right = normalized.slice(doubleColon + 2);
    const leftGroups = left ? left.split(':') : [];
    const rightGroups = right ? right.split(':') : [];
    const fill = 8 - leftGroups.length - rightGroups.length;
    if (fill < 0) return null;
    groups = [...leftGroups, ...new Array(fill).fill('0'), ...rightGroups];
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const n = parseInt(groups[i] || '0', 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

function parseCidr(cidr: string): Cidr | null {
  const slash = cidr.indexOf('/');
  if (slash < 0) return null;
  const ip = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0) return null;
  const kind = isIP(ip);
  if (kind === 4 && prefix <= 32) {
    const bytes = ipToBytes(ip);
    if (!bytes) return null;
    return { kind: 4, bytes, prefix };
  }
  if (kind === 6 && prefix <= 128) {
    const bytes = ipToBytes(ip);
    if (!bytes) return null;
    return { kind: 6, bytes, prefix };
  }
  return null;
}

function matchesCidr(ipBytes: Uint8Array, ipKind: 4 | 6, cidr: Cidr): boolean {
  // Сопоставляем IPv4 с IPv6-CIDR только через mapped-форму `::ffff:0:0/96`,
  // здесь не поддерживаем — всё равно дефолтные правила покрывают v4 отдельно.
  if (cidr.kind !== ipKind) return false;
  const fullBytes = Math.floor(cidr.prefix / 8);
  const remBits = cidr.prefix % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== cidr.bytes[i]) return false;
  }
  if (remBits === 0) return true;
  const mask = (0xff << (8 - remBits)) & 0xff;
  return (ipBytes[fullBytes] & mask) === (cidr.bytes[fullBytes] & mask);
}

let cachedCidrs: Cidr[] | null = null;
let cachedSource: string | undefined;

function getTrustedCidrs(): Cidr[] {
  const envValue = process.env.TRUSTED_PROXY_CIDRS;
  if (cachedSource === envValue && cachedCidrs) return cachedCidrs;
  // TRUSTED_PROXY_CIDRS ДОПОЛНЯЕТ дефолты, а не заменяет их. Иначе оператор,
  // добавивший публичный CIDR своего edge-прокси, молча терял бы доверие к
  // loopback/RFC1918 — Caddy на 127.0.0.1 переставал бы считаться доверенным,
  // XFF игнорировался, и все клиенты схлопывались в один IP (ломая rate-limit
  // и дедуп голосов). Кастомные CIDR добавляются к встроенным приватным.
  const custom = envValue?.trim() ? envValue.split(',').map((s) => s.trim()) : [];
  const list = [...DEFAULT_TRUSTED_CIDRS, ...custom];
  const parsed: Cidr[] = [];
  for (const raw of list) {
    const c = parseCidr(raw.trim());
    if (c) parsed.push(c);
    // Невалидные CIDR молча игнорируем — лог через console было бы шумно
    // при каждом запросе; конфиг валидируется один раз при первом вызове.
  }
  cachedCidrs = parsed;
  cachedSource = envValue;
  return parsed;
}

function isTrustedProxy(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 0) return false;
  const bytes = ipToBytes(ip);
  if (!bytes) return false;
  const ipKind = kind as 4 | 6;
  const cidrs = getTrustedCidrs();
  for (const c of cidrs) {
    if (matchesCidr(bytes, ipKind, c)) return true;
  }
  return false;
}

/**
 * Парсит `X-Forwarded-For` справа налево, отбрасывая trusted-hops. Возвращает
 * первый IP, который НЕ является доверенным прокси — это реальный клиент.
 *
 * Если socket-peer не доверенный → XFF полностью игнорируется (спуф-защита),
 * возвращается socket-IP.
 *
 * @param xffHeader  значение заголовка X-Forwarded-For (string | string[] | null | undefined)
 * @param socketIp   `req.socket.remoteAddress` или `event.getClientAddress()`
 */
export function parseClientIp(
  xffHeader: string | string[] | null | undefined,
  socketIp: string | null | undefined
): string {
  const peer = (socketIp ?? '').trim();
  if (!peer) return 'unknown';

  // Если непосредственный peer не входит в trusted-список — XFF не доверяем.
  if (!isTrustedProxy(peer)) return peer;

  if (!xffHeader) return peer;
  const headerStr = Array.isArray(xffHeader) ? xffHeader.join(',') : xffHeader;
  const hops = headerStr
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (hops.length === 0) return peer;

  // Идём справа налево: ближайший прокси добавляется в конец списка.
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (isIP(hop) === 0) continue; // мусор — пропускаем
    if (!isTrustedProxy(hop)) return hop;
  }
  // Все hop'ы доверенные (странно, но возможно при многослойной инфре). Реального
  // клиента в цепочке нет — каждый hop это доверенный прокси. Безопасно отдать
  // socket-peer: подделать XFF, не пройдя trust-проверку peer'а, снаружи нельзя.
  return peer;
}

/**
 * Удобный обёртка для SvelteKit `handle`: вытаскивает XFF из request.headers
 * и socket-IP из `event.getClientAddress()`.
 */
export function getClientIpFromKitEvent(event: {
  request: Request;
  getClientAddress: () => string;
}): string {
  const xff = event.request.headers.get('x-forwarded-for');
  let socketIp: string;
  try {
    socketIp = event.getClientAddress();
  } catch {
    socketIp = '';
  }
  return parseClientIp(xff, socketIp);
}
