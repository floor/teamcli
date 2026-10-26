// `team policy set` from an agent (no owner terminal): admitted by one owner-device signature from
// the owner seat (Touch ID), refused when the owner cancels or when no seat exists.

import { afterAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { registerOwnerSeat, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { runPolicy } from '../src/commands/policy.ts';
import type { Io } from '../src/io.ts';
import { keyOf } from '../src/store/keys.ts';

const made: string[] = [];
afterAll(() => { for (const b of made) rmSync(b, { recursive: true, force: true }); });
const raw = (key: KeyObject) => {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
};
function store(): OwnerSeatKeyStore & { presence: boolean; prompts: string[] } {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const s = {
    presence: true, prompts: [] as string[], name: 'fake', available: () => true,
    create: (l: string) => { const p = generateKeyPairSync('ec', { namedCurve: 'P-256' }); keys.set(l, p); return { ok: true as const, publicKey: raw(p.publicKey) }; },
    publicKey: (l: string) => (keys.has(l) ? { ok: true as const, publicKey: raw(keys.get(l)!.publicKey) } : { ok: false as const, why: 'no key' }),
    sign: (l: string, m: Buffer, reason: string) => { s.prompts.push(reason); return s.presence && keys.has(l) ? { ok: true as const, signature: cryptoSign('sha256', m, { key: keys.get(l)!.privateKey, dsaEncoding: 'der' }).toString('hex') } : { ok: false as const, why: 'cancelled' }; },
    pinSet: () => ({ ok: true as const }), pinGet: () => ({ ok: false as const, why: 'none' }),
  };
  return s;
}
function home() {
  const base = realpathSync(mkdtempSync(join(process.cwd(), '.policy-owner-device-')));
  made.push(base);
  mkdirSync(join(base, '.config', 'team'), { recursive: true });
  keyOf(base);
  return base;
}
const agent = (cwd: string): Io => ({ stdout: () => {}, stderr: () => {}, cwd, env: {}, stdinIsTTY: false });

describe('team policy set approved on the owner device', () => {
  test('no owner seat: an agent is refused as before', async () => {
    const h = home();
    expect(await runPolicy(['set', 'entity', 'owner-signers', 'mac', '--entity', 'floor'], agent(h), { home: h, ownerSeatStore: store() })).toBe(1);
  });

  test('with an owner seat: one Touch ID admits it and is audited; a cancel refuses it', async () => {
    const h = home();
    const s = store();
    expect(registerOwnerSeat(h, { team: 'floor', signer: 'mac' }, s).ok).toBe(true);
    expect(await runPolicy(['set', 'entity', 'owner-signers', 'mac', '--entity', 'floor'], agent(h), { home: h, ownerSeatStore: s })).toBe(0);
    expect(s.prompts).toEqual(['TeamCLI: policy set entity owner-signers mac']);
    expect(readFileSync(join(h, '.config', 'team', 'security-profile.log'), 'utf8')).toContain('owner-device-consent');
    s.presence = false;
    expect(await runPolicy(['set', 'entity', 'grant-emission', 'conversational', '--entity', 'floor'], agent(h), { home: h, ownerSeatStore: s })).toBe(1);
  });

  test('a dry run with an owner seat prints the plan and does not ask for Touch ID', async () => {
    const h = home();
    const s = store();
    expect(registerOwnerSeat(h, { team: 'floor', signer: 'mac' }, s).ok).toBe(true);
    const lines: string[] = [];
    const io: Io = { stdout: (text) => lines.push(text), stderr: () => {}, cwd: h, env: {}, stdinIsTTY: false };
    expect(await runPolicy(['set', 'entity', 'owner-signers', 'mac', '--entity', 'floor', '--dry-run'], io, { home: h, ownerSeatStore: s })).toBe(0);
    expect(s.prompts).toEqual([]);
    expect(lines.join('')).toContain('would set');
    expect(await runPolicy(['unset', 'entity', 'owner-signers', '--entity', 'floor', '--dry-run'], io, { home: h, ownerSeatStore: s })).toBe(0);
    expect(s.prompts).toEqual([]);
  });
});
