// Every signer, approval and home is synthetic. No credential-store adapter or approval UI.
import { afterEach, expect, spyOn, test } from 'bun:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runInit } from '../src/commands/init.ts';
import { main } from '../src/cli.ts';
import type { Caller } from '../src/caller.ts';
import { registerOwnerSeat, acceptOwnerSigner, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { actionApprovalsFolder, setApprovalMode, listApprovalModes, createTeamCreateRequest, approveTeamCreate } from '../src/client/team-create.ts';
import { createOwnerActionRequest, approveOwnerAction, listOwnerActionRules } from '../src/client/owner-action.ts';
import { newClientKeyPair, clientKeyDir, writeClientKeyFiles } from '../src/client/records.ts';
import { issueOwnerGeneralGrant } from '../src/client/general-grant.ts';
import { testIo } from './helpers.ts';
const NOW = new Date('2026-11-01T16:00:00Z');
const bases: string[] = [];
afterEach(() => { const owned = bases.splice(0); if (owned.length) execFileSync('trash', owned, { timeout: 20_000 }); }, 30_000);
function signerStore() {
  const keys = new Map<string, { privateKey: KeyObject; publicKey: string }>(); const pins = new Map<string, string>();
  let refuse = false; let signatures = 0;
  const store: OwnerSeatKeyStore = {
    name: 'synthetic signer', available: () => true,
    create: label => { const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = pair.publicKey.export({ format: 'jwk' }); assert.ok(jwk.x); assert.ok(jwk.y);
      const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('hex');
      keys.set(label, { privateKey: pair.privateKey, publicKey: raw }); return { ok: true, publicKey: raw }; },
    publicKey: label => { const key = keys.get(label); return key ? { ok: true, publicKey: key.publicKey } : { ok: false, why: 'synthetic key absent' }; },
    sign: (label, message) => { signatures += 1; if (refuse) return { ok: false, why: 'synthetic signer refused' };
      const key = keys.get(label); return key ? { ok: true, signature: sign('sha256', message, key.privateKey).toString('hex') } : { ok: false, why: 'synthetic key absent' }; },
    pinSet: (label, value) => { pins.set(label, value); return { ok: true }; },
    pinGet: label => { const value = pins.get(label); return value ? { ok: true, value } : { ok: false, why: 'synthetic pin absent' }; },
  };
  return { store, reject: () => { refuse = true; }, signatures: () => signatures };
}
function must<T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> {
  if (!value.ok) throw new Error(JSON.stringify(value)); return value as Extract<T, { ok: true }>;
}
function world() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ig-'))); bases.push(base);
  const root = join(base, 'r'); const other = join(base, 'other'); const home = join(base, 'h');
  fs.mkdirSync(root); fs.mkdirSync(other); fs.mkdirSync(home); execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const signer = signerStore();
  must(registerOwnerSeat(home, { team: 'fixture-owner', entity: 'fixture-entity', signer: 'fixture-signer' }, signer.store, NOW));
  must(acceptOwnerSigner(home, 'fixture-entity', 'fixture-signer', NOW));
  const target = must(setApprovalMode(home, 'team-create', 'none', root, signer.store, NOW)); assert.ok(target.modeId);
  const bystander = must(setApprovalMode(home, 'team-create', 'none', other, signer.store, NOW)); assert.ok(bystander.modeId);
  return { base, root, other, home, signer, targetId: target.modeId, bystanderId: bystander.modeId };
}
type World = ReturnType<typeof world>;
function snapshot(w: World) {
  const dir = actionApprovalsFolder(w.home);
  return Object.fromEntries(fs.readdirSync(dir).filter(name => name.startsWith('am_')).sort().map(name => [name, fs.readFileSync(join(dir, name), 'utf8')]));
}
const callers = {
  owner: { kind: 'owner' }, seat: { kind: 'seat', name: 'member', pane: 'synthetic-member', session: 'synthetic-session' },
  detached: { kind: 'owner-no-tty' }, unplaced: { kind: 'unplaced', reason: 'synthetic unplaced process' },
} satisfies Record<string, Caller>;
async function run(w: World, argv: string[], caller: Caller) {
  const io = testIo(w.root, caller); io.env = { HOME: w.home }; io.stdinIsTTY = caller.kind === 'owner';
  const code = await runInit([...argv, '--json'], io, w.home, undefined, { loggedIn: () => false, registryHome: w.home, ownerSeatStore: w.signer.store, now: () => NOW });
  return { code, io };
}
function words(w: World, mode: string) { return ['--approval-mode', mode, '--scope', w.root]; }
for (const callerName of ['seat', 'detached', 'unplaced'] as const) {
  for (const mode of ['none', 'per-action', 'always-rule']) {
    test('an unapproved ' + callerName + ' cannot change mode ' + mode + ' or touch any existing record', async () => {
      const w = world(); const before = snapshot(w); const signs = w.signer.signatures(); const result = await run(w, words(w, mode), callers[callerName]);
      expect(result.code).toBe(1); expect(JSON.parse(result.io.out).error.id).toBe('init.approval-refused');
      expect(snapshot(w)).toEqual(before); expect(w.signer.signatures()).toBe(signs);
    });
  }
  test('an unapproved ' + callerName + ' cannot revoke a rule and leaves all mode bytes', async () => {
    const w = world(); const before = snapshot(w); const result = await run(w, ['--revoke-approval', 'tc_' + '1'.repeat(24)], callers[callerName]);
    expect(result.code).toBe(1); expect(JSON.parse(result.io.out).error.id).toBe('init.approval-refused'); expect(snapshot(w)).toEqual(before);
  });
}
for (const mode of ['per-action', 'always-rule']) {
  test('the owner terminal changes mode ' + mode + ' only at the matching scope', async () => {
    const w = world(); const before = snapshot(w); const result = await run(w, words(w, mode), callers.owner);
    expect(result.code, result.io.out).toBe(0); const after = snapshot(w); expect(after[w.targetId + '.json']).toBeUndefined();
    expect(after[w.bystanderId + '.json']).toBe(before[w.bystanderId + '.json']);
  });
}
test('none is signed and fully written before the old matching record is unlinked', async () => {
  const w = world(); const before = snapshot(w); const original = fs.unlinkSync; const observed: boolean[] = [];
  const spy = spyOn(fs, 'unlinkSync').mockImplementation((path => {
    if (String(path) === join(actionApprovalsFolder(w.home), w.targetId + '.json')) {
      const fresh = listApprovalModes(w.home, w.signer.store, NOW).modes.filter(mode => mode.scope === w.root && mode.mode_id !== w.targetId);
      observed.push(fresh.length === 1 && fs.existsSync(join(actionApprovalsFolder(w.home), fresh[0]!.mode_id + '.json')));
    }
    return original(path);
  }) as typeof fs.unlinkSync);
  try { expect((await run(w, words(w, 'none'), callers.owner)).code).toBe(0); } finally { spy.mockRestore(); }
  expect(observed).toEqual([true]); const after = snapshot(w); expect(after[w.targetId + '.json']).toBeUndefined();
  expect(after[w.bystanderId + '.json']).toBe(before[w.bystanderId + '.json']);
});
test('a refusing signer leaves every old mode record byte-identical', async () => {
  const w = world(); const before = snapshot(w); w.signer.reject(); const result = await run(w, words(w, 'none'), callers.owner);
  expect(result.code).toBe(1); expect(JSON.parse(result.io.out).error.id).toBe('init.approval-refused'); expect(snapshot(w)).toEqual(before);
});
test('a failed replacement open leaves every old mode record byte-identical', async () => {
  const w = world(); const before = snapshot(w); const original = fs.openSync;
  const spy = spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const path = String(args[0]);
    if (args[1] === 'wx' && path.startsWith(actionApprovalsFolder(w.home) + '/') && basename(path).startsWith('am_') && !(basename(path) in before)) {
      throw Object.assign(new Error('synthetic replacement open failed'), { code: 'EACCES' });
    }
    return Reflect.apply(original, fs, args);
  }) as typeof fs.openSync);
  try {
    const result = await run(w, words(w, 'none'), callers.owner); expect(result.code).toBe(1);
    expect(JSON.parse(result.io.out).error.id).toBe('init.approval-refused'); expect(snapshot(w)).toEqual(before);
  } finally { spy.mockRestore(); }
});
function allow(w: World, root = w.root, action: 'team-revoke-approval' | 'team-send' = 'team-revoke-approval') {
  const request = must(createOwnerActionRequest(w.home, { actions: [action], root, team: 'fixture-owner', head: null, args: {}, requestedBy: 'fixture-requester' }, NOW, () => {}));
  must(approveOwnerAction(w.home, request.record.request_id, 'always', w.signer.store, NOW, { signer: 'fixture-signer' }));
}
for (const mode of ['none', 'per-action', 'always-rule']) {
  test('an owner-signed folder rule admits a seat to mode ' + mode, async () => {
    const w = world(); allow(w); const result = await run(w, words(w, mode), callers.seat); expect(result.code, result.io.out).toBe(0);
    const modes = listApprovalModes(w.home, w.signer.store, NOW).modes.filter(held => held.scope === w.root);
    expect(modes).toHaveLength(mode === 'none' ? 1 : 0);
  });
}
for (const mode of ['wrong-scope', 'wrong-action'] as const) {
  test('a signed rule with ' + mode + ' admits no mode change', async () => {
    const w = world(); const isolated = join(w.other, 'child'); fs.mkdirSync(isolated);
    allow(w, mode === 'wrong-scope' ? isolated : w.root, mode === 'wrong-action' ? 'team-send' : 'team-revoke-approval');
    const before = snapshot(w); const result = await run(w, words(w, 'per-action'), callers.seat);
    expect(result.code).toBe(1); expect(JSON.parse(result.io.out).error.id).toBe('init.approval-refused'); expect(snapshot(w)).toEqual(before);
  });
}
for (const byRule of [false, true]) {
  test('revoke admits the owner terminal or a signed scope rule: rule=' + byRule, async () => {
    const w = world(); const request = must(createTeamCreateRequest(w.home, w.root, null, NOW));
    must(approveTeamCreate(w.home, request.record.request_id, 'always', w.signer.store, NOW, { signer: 'fixture-signer' }));
    if (byRule) allow(w); const before = snapshot(w);
    const result = await run(w, ['--revoke-approval', request.record.request_id], byRule ? callers.detached : callers.owner);
    expect(result.code, result.io.out).toBe(0); expect(snapshot(w)).toEqual(before);
    expect(fs.existsSync(join(actionApprovalsFolder(w.home), request.record.request_id + '.json'))).toBe(false);
  });
}
for (const form of ['mode', 'revoke']) {
  test('a real general grant beside the singular ' + form + ' form is usage, with no writes', async () => {
    const w = world(); const key = newClientKeyPair(); const keys = must(writeClientKeyFiles(clientKeyDir(w.home, 'init-fixture'), key));
    const grant = must(issueOwnerGeneralGrant(w.home, { clientId: 'init-fixture', publicKey: key.publicKey, entities: ['*'], ops: ['init'], mayIssue: false, expires: new Date(Date.now() + 86_400_000) }));
    const before = snapshot(w); const io = testIo(w.root, callers.seat); io.env = { HOME: w.home };
    const args = form === 'mode' ? words(w, 'per-action') : ['--revoke-approval', 'tc_' + '1'.repeat(24)];
    expect(await main(['init', ...args, '--general', grant.path, '--key', keys.keyPath, '--json'], io)).toBe(2);
    expect(snapshot(w)).toEqual(before); expect(JSON.parse(io.out).error.id).toBe('team.general-usage');
  });
}


test('a folder rule cannot change an approval mode at an outside requested scope', async () => {
  const w = world();
  const outsideBase = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ig-outside-'))); bases.push(outsideBase);
  const outside = join(outsideBase, 'r'); fs.mkdirSync(outside); execFileSync('git', ['init', '-q'], { cwd: outside, stdio: 'ignore' });
  const outsideMode = must(setApprovalMode(w.home, 'team-create', 'none', outside, w.signer.store, NOW));
  assert.ok(outsideMode.modeId);
  allow(w); // This API's always rule covers the caller repository's parent, w.base.
  expect(listOwnerActionRules(w.home, w.signer.store, NOW).rules.some(rule => rule.scope === w.base && rule.actions.includes('team-revoke-approval'))).toBe(true);
  const control = await run(w, words(w, 'per-action'), callers.seat);
  expect(control.code, control.io.out).toBe(0); // Prove this exact signed rule admits its own folder.
  const before = snapshot(w);
  const result = await run(w, ['--approval-mode', 'per-action', '--scope', outside], callers.seat);
  const after = snapshot(w);
  console.info('outside scope result: ' + JSON.stringify({ code: result.code, output: result.io.out, targetExistedBefore: before[outsideMode.modeId + '.json'] !== undefined, targetExistsAfter: after[outsideMode.modeId + '.json'] !== undefined, allModeBytesUnchanged: JSON.stringify(before) === JSON.stringify(after) }));
  expect(result.code).toBe(1); expect(JSON.parse(result.io.out).error.id).toBe('init.approval-refused');
  expect(after).toEqual(before);
});
