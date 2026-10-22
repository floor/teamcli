// `team owner-seat`: setup confirmed by one owner-device signature, profile switch, status lines.

import { afterAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ownerSeatFile, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { runOwnerSeat } from '../src/commands/owner-seat.ts';
import type { Io } from '../src/io.ts';

const made: string[] = [];
afterAll(() => { for (const b of made) rmSync(b, { recursive: true, force: true }); });
const raw = (key: KeyObject) => {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
};
function store(presence = true): OwnerSeatKeyStore {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  return {
    name: 'fake', available: () => true,
    create: (l) => { const p = generateKeyPairSync('ec', { namedCurve: 'P-256' }); keys.set(l, p); return { ok: true, publicKey: raw(p.publicKey) }; },
    publicKey: (l) => (keys.has(l) ? { ok: true, publicKey: raw(keys.get(l)!.publicKey) } : { ok: false, why: 'no key' }),
    sign: (l, m) => (presence && keys.has(l) ? { ok: true, signature: cryptoSign('sha256', m, { key: keys.get(l)!.privateKey, dsaEncoding: 'der' }).toString('hex') } : { ok: false, why: 'the user-presence prompt was cancelled' }),
    pinSet: () => ({ ok: true }), pinGet: () => ({ ok: false, why: 'none' }),
  };
}
function home() {
  const base = realpathSync(mkdtempSync(join(process.cwd(), '.owner-seat-cmd-')));
  made.push(base);
  mkdirSync(join(base, '.config', 'team'), { recursive: true });
  return base;
}
async function run(argv: string[], h: string, s: OwnerSeatKeyStore) {
  let out = ''; let err = '';
  const io: Io = { stdout: (t) => { out += t; }, stderr: (t) => { err += t; }, cwd: h, env: {}, stdinIsTTY: false };
  const code = await runOwnerSeat(argv, io, { home: h, store: s, serve: false });
  return { code, out, err };
}

describe('team owner-seat', () => {
  test('setup, then relaxed, then strict: status shows each loudly', async () => {
    const h = home(); const s = store();
    expect((await run([], h, s)).out).toContain('security profile: strict (default');
    expect((await run(['setup', '--team', 'floor', '--signer', 'mac'], h, s)).code).toBe(0);
    const relaxed = await run(['profile', 'relaxed', '--days', '7'], h, s);
    expect(relaxed.code).toBe(0);
    expect(relaxed.out).toContain('SECURITY PROFILE: RELAXED');
    expect((await run(['status', '--json'], h, s)).out).toContain('"relaxed":true');
    expect((await run(['profile', 'strict'], h, s)).code).toBe(0);
    expect((await run(['status'], h, s)).out).toContain('security profile: strict (signed by mac');
    expect((await run(['profile', 'dev', '--days', '45'], h, s)).code).toBe(1);
  });

  test('setup the owner does not confirm registers nothing', async () => {
    const h = home();
    const r = await run(['setup', '--team', 'floor', '--signer', 'mac'], h, store(false));
    expect(r.code).toBe(1);
    expect(existsSync(ownerSeatFile(h))).toBe(false);
  });

  test('serve prints the page link', async () => {
    const h = home(); const s = store();
    await run(['setup', '--team', 'floor', '--signer', 'mac'], h, s);
    expect((await run(['serve', '--port', '0'], h, s)).out).toMatch(/owner page: http:\/\/localhost:\d+\/\?t=/);
  });
});

describe('team owner-seat setup with policies', () => {
  test('one confirmation registers the seat and sets the named entity policies', async () => {
    const h = home(); const s = store();
    const r = await run(['setup', '--team', 'floor', '--signer', 'mac', '--owner-signers', 'mac', '--grant-emission', 'conversational'], h, s);
    expect(r.code).toBe(0);
    expect(r.out).toContain('owner-signers set');
    expect(r.out).toContain('grant-emission set');
  });
});
