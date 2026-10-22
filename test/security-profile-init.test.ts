// team init --execute under each security profile: strict needs the per-request owner-seat answer;
// relaxed (owner-signed, unexpired) admits the request without one and audits it as such.

import { afterAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { registerOwnerSeat, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { actionAuditFolder } from '../src/client/team-create.ts';
import { runInit } from '../src/commands/init.ts';
import type { Io } from '../src/io.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { proposeSecurityProfile, signSecurityProfile, type SecurityProfileName } from '../src/security/profile.ts';
import { keyOf } from '../src/store/keys.ts';

const made: string[] = [];
afterAll(() => { for (const b of made) rmSync(b, { recursive: true, force: true }); });

const raw = (key: KeyObject) => {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
};

function fakeStore(): OwnerSeatKeyStore {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  return {
    name: 'fake-credential-store',
    available: () => true,
    create: (label) => { const p = generateKeyPairSync('ec', { namedCurve: 'P-256' }); keys.set(label, p); return { ok: true, publicKey: raw(p.publicKey) }; },
    publicKey: (label) => (keys.has(label) ? { ok: true, publicKey: raw(keys.get(label)!.publicKey) } : { ok: false, why: 'no key' }),
    sign: (label, message) => (keys.has(label) ? { ok: true, signature: cryptoSign('sha256', message, { key: keys.get(label)!.privateKey, dsaEncoding: 'der' }).toString('hex') } : { ok: false, why: 'no key' }),
    pinSet: () => ({ ok: false, why: 'unused' }),
    pinGet: () => ({ ok: false, why: 'unused' }),
  };
}

async function setup(profile: SecurityProfileName | null) {
  const base = realpathSync(mkdtempSync(join(process.cwd(), '.secprofile-init-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  keyOf(home);
  const store = fakeStore();
  expect(registerOwnerSeat(home, { team: 'floor', signer: 'mac' }, store).ok).toBe(true);
  const wrote = writePolicySet(home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac'] }, { now: new Date() });
  if (!wrote.ok) throw new Error(wrote.why);
  if (profile !== null) {
    expect(proposeSecurityProfile(home, { profile, days: 7, reason: 'test' }).ok).toBe(true);
    expect(signSecurityProfile(home, store).ok).toBe(true);
  }
  const root = join(base, 'code', 'docs');
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const run = async (argv: string[]) => {
    let out = '';
    const io: Io = { stdout: (t) => { out += t; }, stderr: () => {}, cwd: root, env: {}, stdinIsTTY: false };
    const code = await runInit(argv, io, home, undefined, { loggedIn: () => true, ownerSeatStore: store });
    return { code, json: argv.includes('--json') && out.trim().startsWith('{') ? JSON.parse(out) : null };
  };
  return { home, root, run };
}

describe('team init --execute and the security profile', () => {
  for (const profile of [null, 'strict'] as const) {
    test(`${profile ?? 'no profile (strict default)'}: no answer, no team`, async () => {
      const s = await setup(profile);
      const id = (await s.run(['--request', '--json'])).json.request_id as string;
      expect((await s.run(['--execute', id])).code).toBe(1);
      expect(existsSync(join(s.root, '.agents', 'team.yaml'))).toBe(false);
    });
  }

  test('relaxed: the request is admitted without a per-request answer, audited via security-profile', async () => {
    const s = await setup('relaxed');
    const id = (await s.run(['--request', '--json'])).json.request_id as string;
    expect((await s.run(['--execute', id])).code).toBe(0);
    expect(existsSync(join(s.root, '.agents', 'team.yaml'))).toBe(true);
    const audit = JSON.parse(readFileSync(join(actionAuditFolder(s.home), `${id}.json`), 'utf8'));
    expect(audit).toMatchObject({ via: 'security-profile', signer: 'mac', kind: 'team-create' });
    expect(readFileSync(join(s.home, '.config', 'team', 'security-profile.log'), 'utf8')).toContain('team-create.owner-answer');
    // Still single-use.
    expect((await s.run(['--execute', id])).code).toBe(1);
  });
});
