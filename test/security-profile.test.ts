// The security-profile policy: strict by default, relaxed only through a record signed by an owner
// signer's device (fake Secure Enclave store / simulated passkey here), with expiry and audit.

import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addOwnerSigner, registerOwnerSeat, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import {
  proposeSecurityProfile, readSecurityProfile, ruleRelaxed, securityProfileAuditPath, securityProfileChallenge,
  securityProfileLine, securityProfilePath, signSecurityProfile, type SecurityProfileBody,
} from '../src/security/profile.ts';

const made: string[] = [];
afterAll(() => { for (const b of made) rmSync(b, { recursive: true, force: true }); });

const raw = (key: KeyObject) => {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
};

export function fakeStore(): OwnerSeatKeyStore & { signs: number } {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const pins = new Map<string, string>();
  const store = {
    signs: 0,
    name: 'fake-credential-store',
    available: () => true,
    create: (label: string) => { const p = generateKeyPairSync('ec', { namedCurve: 'P-256' }); keys.set(label, p); return { ok: true as const, publicKey: raw(p.publicKey) }; },
    publicKey: (label: string) => (keys.has(label) ? { ok: true as const, publicKey: raw(keys.get(label)!.publicKey) } : { ok: false as const, why: 'no key' }),
    sign: (label: string, message: Buffer) => { store.signs += 1; return keys.has(label) ? { ok: true as const, signature: cryptoSign('sha256', message, { key: keys.get(label)!.privateKey, dsaEncoding: 'der' }).toString('hex') } : { ok: false as const, why: 'no key' }; },
    pinSet: (label: string, value: string) => (pins.has(label) ? { ok: false as const, why: 'exists' } : (pins.set(label, value), { ok: true as const })),
    pinGet: (label: string) => (pins.has(label) ? { ok: true as const, value: pins.get(label)! } : { ok: false as const, why: 'no pin' }),
  };
  return store;
}

function home() {
  const base = realpathSync(mkdtempSync(join(process.cwd(), '.secprofile-')));
  made.push(base);
  const h = join(base, 'home');
  mkdirSync(join(h, '.config', 'team'), { recursive: true });
  return h;
}

const now = new Date('2026-10-23T08:00:00Z');

describe('security-profile', () => {
  test('strict by default: nothing relaxed, status says strict', () => {
    const h = home();
    const store = fakeStore();
    expect(readSecurityProfile(h, store, now).profile).toBe('strict');
    expect(ruleRelaxed(h, 'team-create.owner-answer', store, { now })).toBe(false);
    expect(securityProfileLine(readSecurityProfile(h, store, now))).toContain('strict (default');
  });

  test('relaxed through a Secure Enclave signature: rules relaxed, audited, status loud', () => {
    const h = home();
    const store = fakeStore();
    expect(registerOwnerSeat(h, { team: 'floor', signer: 'mac' }, store, now).ok).toBe(true);
    const p = proposeSecurityProfile(h, { profile: 'relaxed', days: 7, reason: 'dev week' }, now);
    expect(p.ok).toBe(true);
    expect(readSecurityProfile(h, store, now).profile).toBe('strict');
    const s = signSecurityProfile(h, store, undefined, now);
    expect(s.ok).toBe(true);
    expect(store.signs).toBe(1);
    expect(ruleRelaxed(h, 'team-create.owner-answer', store, { now, what: 'init' })).toBe(true);
    expect(ruleRelaxed(h, 'gate.owner-terminal', store, { now })).toBe(true);
    expect(securityProfileLine(readSecurityProfile(h, store, now))).toMatch(/^SECURITY PROFILE: RELAXED: 5 rules relaxed/);
    const log = readFileSync(securityProfileAuditPath(h), 'utf8');
    expect(log).toContain('"event":"set"');
    expect(log).toContain('"rule":"team-create.owner-answer"');
  });

  test('strict profile signed: relaxes nothing', () => {
    const h = home();
    const store = fakeStore();
    registerOwnerSeat(h, { team: 'floor', signer: 'mac' }, store, now);
    proposeSecurityProfile(h, { profile: 'strict', days: 7, reason: 'back to reality' }, now);
    expect(signSecurityProfile(h, store, undefined, now).ok).toBe(true);
    expect(ruleRelaxed(h, 'team-create.owner-answer', store, { now })).toBe(false);
  });

  test('expiry is mandatory, bounded, and restores strict when passed', () => {
    const h = home();
    const store = fakeStore();
    registerOwnerSeat(h, { team: 'floor', signer: 'mac' }, store, now);
    expect(proposeSecurityProfile(h, { profile: 'relaxed', days: 31, reason: 'x' }, now).ok).toBe(false);
    expect(proposeSecurityProfile(h, { profile: 'relaxed', days: 0, reason: 'x' }, now).ok).toBe(false);
    proposeSecurityProfile(h, { profile: 'relaxed', days: 1, reason: 'x' }, now);
    signSecurityProfile(h, store, undefined, now);
    const later = new Date(now.getTime() + 2 * 86_400_000);
    expect(ruleRelaxed(h, 'team-create.owner-answer', store, { now: later })).toBe(false);
    expect(securityProfileLine(readSecurityProfile(h, store, later))).toContain('expired');
  });

  test('an agent cannot set it for itself: an edited or self-made record relaxes nothing', () => {
    const h = home();
    const store = fakeStore();
    registerOwnerSeat(h, { team: 'floor', signer: 'mac' }, store, now);
    proposeSecurityProfile(h, { profile: 'strict', days: 7, reason: 'x' }, now);
    signSecurityProfile(h, store, undefined, now);
    const record = JSON.parse(readFileSync(securityProfilePath(h), 'utf8'));
    writeFileSync(securityProfilePath(h), JSON.stringify({ ...record, profile: 'relaxed', relaxed: ['team-create.owner-answer'] }));
    expect(ruleRelaxed(h, 'team-create.owner-answer', store, { now })).toBe(false);
    // A record signed by a key the agent made itself is not confirmed by the credential store.
    const own = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const body = { ...record, profile: 'relaxed', relaxed: ['team-create.owner-answer'] };
    delete body.signature;
    const { securityProfileBytes } = require('../src/security/profile.ts');
    writeFileSync(securityProfilePath(h), JSON.stringify({ ...body, signature: cryptoSign('sha256', securityProfileBytes(body), { key: own.privateKey, dsaEncoding: 'der' }).toString('hex') }));
    expect(readSecurityProfile(h, store, now).profile).toBe('strict');
    // No owner seat at all: nothing to sign with.
    expect(proposeSecurityProfile(home(), { profile: 'relaxed', days: 7, reason: 'x' }, now).ok).toBe(false);
  });

  test('relaxed through a passkey assertion from the phone', () => {
    const h = home();
    const store = fakeStore();
    registerOwnerSeat(h, { team: 'floor', signer: 'mac' }, store, now);
    const pk = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(addOwnerSigner(h, { signer: 'iphone', type: 'webauthn', publicKey: raw(pk.publicKey), credentialId: 'Y3JlZGVudGlhbC1pZA', rpId: 'localhost' }, store, now).ok).toBe(true);
    const p = proposeSecurityProfile(h, { profile: 'relaxed', days: 7, reason: 'x', signer: 'iphone' }, now);
    if (!p.ok) throw new Error(p.why);
    expect(signSecurityProfile(h, store, undefined, now).ok).toBe(false);
    const assert = (body: SecurityProfileBody, flags: number) => {
      const authData = Buffer.concat([createHash('sha256').update('localhost').digest(), Buffer.from([flags, 0, 0, 0, 1])]);
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: securityProfileChallenge(body), origin: 'http://localhost:7391' }));
      const signature = cryptoSign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), { key: pk.privateKey, dsaEncoding: 'der' }).toString('hex');
      return { authenticator_data: authData.toString('base64url'), client_data_json: clientData.toString('base64url'), signature };
    };
    expect(signSecurityProfile(h, store, assert(p.body, 0x00), now).ok).toBe(false);
    expect(signSecurityProfile(h, store, assert(p.body, 0x05), now).ok).toBe(true);
    expect(ruleRelaxed(h, 'approval.standing-auto', store, { now })).toBe(true);
  });
});
