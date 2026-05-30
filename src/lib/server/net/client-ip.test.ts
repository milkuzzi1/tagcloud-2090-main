import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseClientIp, getClientIpFromKitEvent } from './client-ip';

/**
* Тесты на парсер X-Forwarded-For + trusted-CIDR матчинг.
*
* Контракт parseClientIp:
*  - читает XFF справа налево (rightmost = ближайший к нам hop)
*  - отбрасывает все trusted (внутри CIDR allowlist) хопы
*  - первый встретившийся untrusted hop → реальный клиент
*  - если XFF нет/пустой/мусор → возвращает socketIp
*  - если socketIp untrusted → возвращает socketIp (никому не верим)
*
* CIDR allowlist по умолчанию (без TRUSTED_PROXY_CIDRS):
*   127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16,
*   ::1/128, fc00::/7, fe80::/10
*/

// ----- helpers -----

function restoreEnv(prev: Record<string, string | undefined>) {
 for (const [k, v] of Object.entries(prev)) {
   if (v === undefined) delete process.env[k];
   else process.env[k] = v;
 }
}

describe('parseClientIp', () => {
 let envBackup: Record<string, string | undefined>;

 beforeEach(() => {
   envBackup = { TRUSTED_PROXY_CIDRS: process.env.TRUSTED_PROXY_CIDRS };
 });

 afterEach(() => {
   restoreEnv(envBackup);
 });

 describe('default trusted CIDRs (no TRUSTED_PROXY_CIDRS env)', () => {
   beforeEach(() => {
     delete process.env.TRUSTED_PROXY_CIDRS;
   });

   it('returns socket IP when XFF is null', () => {
     expect(parseClientIp(null, '203.0.113.7')).toBe('203.0.113.7');
   });

   it('returns socket IP when XFF is undefined', () => {
     expect(parseClientIp(undefined, '203.0.113.7')).toBe('203.0.113.7');
   });

   it('returns socket IP when XFF is empty string', () => {
     expect(parseClientIp('', '203.0.113.7')).toBe('203.0.113.7');
   });

   it('strips a single trusted hop (loopback) and returns the real client', () => {
     // Caddy → 127.0.0.1, XFF says client was 198.51.100.4
     expect(parseClientIp('198.51.100.4', '127.0.0.1')).toBe('198.51.100.4');
   });

   it('strips multiple trusted hops (RFC1918 chain)', () => {
     // client → public LB → internal LB (10.x) → app (127.0.0.1)
     // XFF: "203.0.113.9, 10.0.0.5, 192.168.1.7"
     expect(parseClientIp('203.0.113.9, 10.0.0.5, 192.168.1.7', '127.0.0.1')).toBe(
       '203.0.113.9'
     );
   });

   it('stops at first untrusted hop (deepest non-private wins)', () => {
     // Attacker spoofed an extra hop at the start; rightmost untrusted is what we want.
     // XFF: "1.2.3.4, 5.6.7.8, 10.0.0.1"
     // Walking right-to-left: 10.0.0.1 (trusted) → 5.6.7.8 (untrusted) → STOP
     expect(parseClientIp('1.2.3.4, 5.6.7.8, 10.0.0.1', '127.0.0.1')).toBe('5.6.7.8');
   });

   it('returns socket IP when ALL XFF hops are trusted (degenerate)', () => {
     // Shouldn't really happen, but be defensive.
     expect(parseClientIp('10.0.0.1, 192.168.1.1', '127.0.0.1')).toBe('127.0.0.1');
   });

   it('returns socket IP when socket is untrusted (do not trust XFF at all)', () => {
     // Direct connection from a public IP, no real proxy. XFF could be a lie.
     expect(parseClientIp('1.2.3.4', '5.6.7.8')).toBe('5.6.7.8');
   });

   it('handles whitespace around commas', () => {
     expect(parseClientIp('  203.0.113.9 ,  10.0.0.5  ', '127.0.0.1')).toBe('203.0.113.9');
   });

   it('ignores malformed entries in XFF', () => {
     // "not-an-ip" → not a valid IP, treat as untrusted? Implementation walks until valid.
     // Our parser must not crash on garbage. The well-formed leftmost untrusted should win.
     expect(parseClientIp('203.0.113.9, garbage, 10.0.0.1', '127.0.0.1')).not.toBe('10.0.0.1');
   });

   it('IPv6 loopback ::1 is trusted', () => {
     expect(parseClientIp('2001:db8::1', '::1')).toBe('2001:db8::1');
   });

   it('IPv6 ULA fc00::/7 is trusted', () => {
     expect(parseClientIp('2001:db8::1', 'fc00::42')).toBe('2001:db8::1');
   });

   it('IPv6 link-local fe80::/10 is trusted', () => {
     expect(parseClientIp('2001:db8::1', 'fe80::abcd')).toBe('2001:db8::1');
   });

   it('IPv6 untrusted socket returns socket IP', () => {
     expect(parseClientIp('203.0.113.9', '2001:db8::1')).toBe('2001:db8::1');
   });

   it('accepts XFF as string[] (Node http edge case)', () => {
     // Some runtimes can give multi-valued headers as array.
     expect(parseClientIp(['198.51.100.4'], '127.0.0.1')).toBe('198.51.100.4');
   });
 });

 describe('custom TRUSTED_PROXY_CIDRS env', () => {
   it('adds a public CIDR to the trust list', () => {
     // Pretend Cloudflare-style: 203.0.113.0/24 is our trusted edge.
     process.env.TRUSTED_PROXY_CIDRS = '203.0.113.0/24';
     // XFF: "1.2.3.4, 203.0.113.99" — 203.0.113.99 is now trusted, real client = 1.2.3.4
     expect(parseClientIp('1.2.3.4, 203.0.113.99', '127.0.0.1')).toBe('1.2.3.4');
   });

   it('supports multiple custom CIDRs', () => {
     process.env.TRUSTED_PROXY_CIDRS = '203.0.113.0/24,198.51.100.0/24';
     expect(parseClientIp('1.2.3.4, 198.51.100.10, 203.0.113.99', '127.0.0.1')).toBe('1.2.3.4');
   });

   it('does not nuke defaults when custom CIDRs added (additive)', () => {
     // 10/8 should still be trusted even with custom CIDRs configured.
     process.env.TRUSTED_PROXY_CIDRS = '203.0.113.0/24';
     expect(parseClientIp('1.2.3.4, 10.0.0.5', '127.0.0.1')).toBe('1.2.3.4');
   });

   it('handles whitespace and empty entries gracefully', () => {
     process.env.TRUSTED_PROXY_CIDRS = ' 203.0.113.0/24 , , 198.51.100.0/24 ,';
     expect(parseClientIp('1.2.3.4, 198.51.100.10', '127.0.0.1')).toBe('1.2.3.4');
   });

   it('ignores invalid CIDR strings without crashing', () => {
     process.env.TRUSTED_PROXY_CIDRS = 'not-a-cidr,999.999.999.999/8,203.0.113.0/24';
     // 203.0.113.0/24 still works; garbage entries are dropped.
     expect(parseClientIp('1.2.3.4, 203.0.113.99', '127.0.0.1')).toBe('1.2.3.4');
   });
 });

 describe('security: XFF spoofing attempts', () => {
   beforeEach(() => {
     delete process.env.TRUSTED_PROXY_CIDRS;
   });

   it('attacker spoofs XFF on a direct (untrusted) connection — ignored', () => {
     // Attacker connects directly to the app (bypassing Caddy somehow) and sets
     // XFF: "8.8.8.8" to impersonate Google. Socket IP is the attacker's real IP.
     // Since socket is untrusted, we MUST NOT believe XFF.
     expect(parseClientIp('8.8.8.8', '198.51.100.66')).toBe('198.51.100.66');
   });

   it('attacker prepends XFF behind a real proxy — gets ONLY the attacker hop', () => {
     // Real flow: attacker (1.2.3.4) → Caddy (127.0.0.1) → app.
     // Attacker sends header "X-Forwarded-For: 8.8.8.8" hoping to impersonate.
     // Caddy appends the attacker's real IP: final XFF = "8.8.8.8, 1.2.3.4".
     // Walking right-to-left: 1.2.3.4 is the leftmost untrusted → real client.
     // 8.8.8.8 is the spoof, must be discarded.
     expect(parseClientIp('8.8.8.8, 1.2.3.4', '127.0.0.1')).toBe('1.2.3.4');
   });

   it('attacker spoofs multiple hops — still gets blamed for their real IP', () => {
     // XFF: "8.8.8.8, 9.9.9.9, 1.2.3.4" (attacker prepended two fake hops)
     // Caddy appended attacker's real 1.2.3.4 at the end.
     // Walk r-to-l: 1.2.3.4 is untrusted → STOP. Attacker can't escape their own IP.
     expect(parseClientIp('8.8.8.8, 9.9.9.9, 1.2.3.4', '127.0.0.1')).toBe('1.2.3.4');
   });

   it('CIDR boundary: 10.255.255.255 is trusted (last in /8), 11.0.0.0 is not', () => {
     // Sanity: prefix arithmetic on the boundary.
     expect(parseClientIp('1.2.3.4, 10.255.255.255', '127.0.0.1')).toBe('1.2.3.4');
     expect(parseClientIp('1.2.3.4, 11.0.0.0', '127.0.0.1')).toBe('11.0.0.0');
   });

   it('CIDR boundary: 172.15.x is NOT trusted, 172.16.x IS, 172.31.x IS, 172.32.x is NOT', () => {
     // RFC1918 172.16.0.0/12 covers 172.16.0.0 – 172.31.255.255.
     expect(parseClientIp('1.2.3.4, 172.15.255.255', '127.0.0.1')).toBe('172.15.255.255');
     expect(parseClientIp('1.2.3.4, 172.16.0.0', '127.0.0.1')).toBe('1.2.3.4');
     expect(parseClientIp('1.2.3.4, 172.31.255.255', '127.0.0.1')).toBe('1.2.3.4');
     expect(parseClientIp('1.2.3.4, 172.32.0.0', '127.0.0.1')).toBe('172.32.0.0');
   });
 });
});

describe('getClientIpFromKitEvent', () => {
 let envBackup: Record<string, string | undefined>;

 beforeEach(() => {
   envBackup = { TRUSTED_PROXY_CIDRS: process.env.TRUSTED_PROXY_CIDRS };
   delete process.env.TRUSTED_PROXY_CIDRS;
 });

 afterEach(() => {
   restoreEnv(envBackup);
 });

 function mockEvent(xff: string | null, socketIp: string) {
   const headers = new Headers();
   if (xff !== null) headers.set('x-forwarded-for', xff);
   return {
     request: new Request('http://example.test', { headers }),
     getClientAddress: () => socketIp
   };
 }

 it('reads XFF header and resolves real client through Caddy', () => {
   expect(getClientIpFromKitEvent(mockEvent('198.51.100.4', '127.0.0.1'))).toBe(
     '198.51.100.4'
   );
 });

 it('falls back to socket IP when no XFF header', () => {
   expect(getClientIpFromKitEvent(mockEvent(null, '127.0.0.1'))).toBe('127.0.0.1');
 });

 it('does not trust XFF on direct (untrusted) connection', () => {
   expect(getClientIpFromKitEvent(mockEvent('8.8.8.8', '203.0.113.7'))).toBe('203.0.113.7');
 });
});
