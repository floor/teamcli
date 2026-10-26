// The owner page served by `team owner-seat serve`: passkey registration confirmed by the Secure
// Enclave signer, a security-profile signature and a team-create answer, all from a simulated
// passkey over real HTTP on 127.0.0.1. Token and Host checks refuse anything else.

import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readOwnerSeat, registerOwnerSeat, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { createTeamCreateRequest, actionRequestsFolder } from '../src/client/team-create.ts';
import { admitOwnerAction, createOwnerActionRequest } from '../src/client/owner-action.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { serveOwnerPage, spkiToPoint } from '../src/security/owner-page.ts';
import { proposeSecurityProfile, readSecurityProfile } from '../src/security/profile.ts';
import { keyOf } from '../src/store/keys.ts';

const made: string[] = [];
const servers: Array<{ close: () => void }> = [];
afterAll(() => { for (const s of servers) s.close(); for (const b of made) rmSync(b, { recursive: true, force: true }); });

const raw = (key: KeyObject) => {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
};

function fakeStore(): OwnerSeatKeyStore & { prompts: string[] } {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const pins = new Map<string, string>();
  const prompts: string[] = [];
  return {
    prompts,
    name: 'fake-credential-store',
    available: () => true,
    create: (label) => { const p = generateKeyPairSync('ec', { namedCurve: 'P-256' }); keys.set(label, p); return { ok: true, publicKey: raw(p.publicKey) }; },
    publicKey: (label) => (keys.has(label) ? { ok: true, publicKey: raw(keys.get(label)!.publicKey) } : { ok: false, why: 'no key' }),
    sign: (label, message, reason) => { prompts.push(reason); return keys.has(label) ? { ok: true, signature: cryptoSign('sha256', message, { key: keys.get(label)!.privateKey, dsaEncoding: 'der' }).toString('hex') } : { ok: false, why: 'no key' }; },
    pinSet: (label, value) => (pins.has(label) ? { ok: false, why: 'exists' } : (pins.set(label, value), { ok: true })),
    pinGet: (label) => (pins.has(label) ? { ok: true, value: pins.get(label)! } : { ok: false, why: 'no pin' }),
  };
}

/** A simulated platform passkey for rp `localhost`. */
function phone() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = Buffer.from('iphone-credential-0001').toString('base64url');
  const assert = (challenge: string) => {
    const authData = Buffer.concat([createHash('sha256').update('localhost').digest(), Buffer.from([0x05, 0, 0, 0, 7])]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'http://localhost' }));
    const signature = cryptoSign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), { key: pair.privateKey, dsaEncoding: 'der' });
    return { credentialId, authenticatorData: authData.toString('base64url'), clientDataJSON: clientData.toString('base64url'), signature: signature.toString('base64url') };
  };
  return { pair, credentialId, assert, spki: (pair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url') };
}

async function setup() {
  const base = realpathSync(mkdtempSync(join(process.cwd(), '.owner-page-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  keyOf(home);
  const store = fakeStore();
  expect(registerOwnerSeat(home, { team: 'floor', signer: 'mac' }, store).ok).toBe(true);
  const page = await serveOwnerPage({ home, store, port: 0 });
  servers.push(page.server);
  const call = async (method: string, path: string, body?: unknown, opts: { token?: string } = {}) => {
    const r = await fetch(`http://localhost:${page.port}${path}?t=${opts.token ?? page.token}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> };
  };
  return { base, home, store, page, call };
}

async function registerPhone(s: Awaited<ReturnType<typeof setup>>, p: ReturnType<typeof phone>) {
  const o = await s.call('POST', '/api/register/options');
  expect(o.status).toBe(200);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: o.body.challenge, origin: 'http://localhost' })).toString('base64url');
  return s.call('POST', '/api/register', { signer: 'iphone', credentialId: p.credentialId, publicKey: p.spki, clientDataJSON });
}

describe('owner page', () => {
  test('spkiToPoint reads the P-256 point out of SubjectPublicKeyInfo', () => {
    const p = phone();
    expect(spkiToPoint(Buffer.from(p.spki, 'base64url'))).toBe(raw(p.pair.publicKey));
  });

  test('a wrong token or a missing one is refused; the page needs it', async () => {
    const s = await setup();
    expect((await s.call('GET', '/api/state', undefined, { token: 'nope' })).status).toBe(403);
    const html = await fetch(`http://localhost:${s.page.port}/?t=${s.page.token}`);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('navigator.credentials');
  });

  test('registering a passkey asks the Secure Enclave signer once, then the profile is signed from the phone', async () => {
    const s = await setup();
    const p = phone();
    const reg = await registerPhone(s, p);
    expect(reg.status).toBe(200);
    expect(s.store.prompts.length).toBe(1);
    expect(readOwnerSeat(s.home)!.signers.map((x) => x.name)).toEqual(['mac', 'iphone']);
    const proposal = proposeSecurityProfile(s.home, { profile: 'relaxed', days: 7, reason: 'dev', signer: 'iphone' });
    if (!proposal.ok) throw new Error(proposal.why);
    const state = await s.call('GET', '/api/state');
    expect((state.body.proposal as { challenge: string }).challenge).toBe(proposal.challenge);
    const signed = await s.call('POST', '/api/profile/sign', p.assert(proposal.challenge));
    expect(signed.status).toBe(200);
    expect(readSecurityProfile(s.home, s.store).profile).toBe('relaxed');
    expect(String((await s.call('GET', '/api/state')).body.profile)).toContain('RELAXED');
  });

  test('a registration that is not for an issued challenge is refused', async () => {
    const s = await setup();
    const p = phone();
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: 'made-up', origin: 'http://localhost' })).toString('base64url');
    expect((await s.call('POST', '/api/register', { signer: 'iphone', credentialId: p.credentialId, publicKey: p.spki, clientDataJSON })).status).toBe(400);
    expect(s.store.prompts.length).toBe(0);
  });

  test('a team-create request is answered oui from the phone', async () => {
    const s = await setup();
    const p = phone();
    expect((await registerPhone(s, p)).status).toBe(200);
    const wrote = writePolicySet(s.home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac', 'iphone'] }, { now: new Date() });
    if (!wrote.ok) throw new Error(wrote.why);
    const root = join(s.base, 'code', 'docs');
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    const made = createTeamCreateRequest(s.home, root, null, new Date());
    if (!made.ok) throw new Error(made.why);
    const id = made.record.request_id;
    const state = await s.call('GET', '/api/state');
    expect((state.body.requests as Array<{ id: string }>).map((r) => r.id)).toEqual([id]);
    const ch = await s.call('POST', '/api/team-create/challenge', { id, word: 'oui', credentialId: p.credentialId });
    expect(ch.status).toBe(200);
    const done = await s.call('POST', '/api/team-create/answer', { ...p.assert(String(ch.body.challenge)), id, word: 'oui' });
    expect(done.status).toBe(200);
    expect(existsSync(join(actionRequestsFolder(s.home), `${id}.seat-answer.json`))).toBe(true);
  });

  test('an init-and-up request is answered oui from the phone, shown once, and admits both actions', async () => {
    const s = await setup();
    const p = phone();
    expect((await registerPhone(s, p)).status).toBe(200);
    const wrote = writePolicySet(s.home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac', 'iphone'] }, { now: new Date() });
    if (!wrote.ok) throw new Error(wrote.why);
    const root = join(s.base, 'code', 'demo');
    mkdirSync(root, { recursive: true });
    const made = createOwnerActionRequest(s.home, { actions: ['team-create', 'team-up'], root, team: 'demo', head: null, args: {}, requestedBy: 'seat:iris' }, new Date());
    if (!made.ok) throw new Error(made.why);
    const id = made.record.request_id;
    const state = await s.call('GET', '/api/state');
    const shown = state.body.requests as Array<{ id: string; text: string }>;
    expect(shown.map((r) => r.id)).toEqual([id]);
    expect(shown[0]!.text).toContain('seat:iris asks to create the team, then start the team');
    const ch = await s.call('POST', '/api/team-create/challenge', { id, word: 'oui', credentialId: p.credentialId });
    expect(ch.status).toBe(200);
    const done = await s.call('POST', '/api/team-create/answer', { ...p.assert(String(ch.body.challenge)), id, word: 'oui' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // Answered: the card is gone, and the signed answer admits init then up, once each.
    expect(((await s.call('GET', '/api/state')).body.requests as unknown[]).length).toBe(0);
    const ask = (action: 'team-create' | 'team-up') => ({ action, root, team: 'demo', head: null, words: [], claim: true });
    expect(admitOwnerAction(s.home, id, ask('team-create'), s.store, new Date())).toMatchObject({ ok: true, signer: 'iphone' });
    expect(admitOwnerAction(s.home, id, ask('team-up'), s.store, new Date())).toMatchObject({ ok: true, signer: 'iphone' });
    expect(admitOwnerAction(s.home, id, ask('team-up'), s.store, new Date()).ok).toBe(false);
  });

  test('a passkey the owner-signers policy does not name is refused before a challenge is issued', async () => {
    const s = await setup();
    const p = phone();
    expect((await registerPhone(s, p)).status).toBe(200);
    const wrote = writePolicySet(s.home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac'] }, { now: new Date() });
    if (!wrote.ok) throw new Error(wrote.why);
    const root = join(s.base, 'code', 'docs');
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    const made = createTeamCreateRequest(s.home, root, null, new Date());
    if (!made.ok) throw new Error(made.why);
    const id = made.record.request_id;
    const ch = await s.call('POST', '/api/team-create/challenge', { id, word: 'oui', credentialId: p.credentialId });
    expect(ch.status).toBe(400);
    expect(String(ch.body.error)).toContain('not accepted by the owner-signers policy');
    expect(existsSync(join(actionRequestsFolder(s.home), `${id}.seat-answer.json`))).toBe(false);
  });

  test('a passkey the owner does not confirm with Touch ID is not added', async () => {
    const s = await setup();
    const p = phone();
    const sign = s.store.sign;
    s.store.sign = () => ({ ok: false, why: 'the user-presence prompt was cancelled' });
    const reg = await registerPhone(s, p);
    expect(reg.status).toBe(403);
    expect(readOwnerSeat(s.home)!.signers.map((x) => x.name)).toEqual(['mac']);
    s.store.sign = sign;
    expect((await registerPhone(s, p)).status).toBe(200);
    expect(readFileSync(join(s.home, '.config', 'team', 'security-profile.log'), 'utf8')).toContain('"act":"add-passkey-signer"');
  });

  test('a request from another Host is refused even with the token', async () => {
    const s = await setup();
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port: s.page.port, path: `/api/state?t=${s.page.token}`, headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.end();
    });
    expect(status).toBe(403);
  });
});

