import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { voteDedupKey } from '../../src/lib/server/voting/dedup-key';

const TOKEN = 'a'.repeat(64);
const SALT = 'b'.repeat(64);
const CODE = 'ABCD1234';

describe('voteDedupKey', () => {
  it('строит ключ вида voted:<sha256(token:salt)>:<code>', () => {
    const expectedHash = createHash('sha256').update(`${TOKEN}:${SALT}`).digest('hex');
    expect(voteDedupKey(TOKEN, SALT, CODE)).toBe(`voted:${expectedHash}:${CODE}`);
  });

  it('детерминирован для одинаковых входов', () => {
    expect(voteDedupKey(TOKEN, SALT, CODE)).toBe(voteDedupKey(TOKEN, SALT, CODE));
  });

  it('разные device-токены дают разные ключи (класс за общим NAT не делит слот)', () => {
    const a = voteDedupKey('device-one', SALT, CODE);
    const b = voteDedupKey('device-two', SALT, CODE);
    expect(a).not.toBe(b);
  });

  it('один токен в разных опросах даёт разные ключи', () => {
    expect(voteDedupKey(TOKEN, SALT, 'CODE0001')).not.toBe(voteDedupKey(TOKEN, SALT, 'CODE0002'));
  });

  it('разный per-survey salt меняет ключ (стабильность в пределах опроса)', () => {
    expect(voteDedupKey(TOKEN, 'salt-1', CODE)).not.toBe(voteDedupKey(TOKEN, 'salt-2', CODE));
  });
});
