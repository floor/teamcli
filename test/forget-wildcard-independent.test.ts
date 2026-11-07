// A wildcard general grant (ops *) no longer reaches `team forget` (0.5.18). Forget removes
// a team and is hard to undo, so a grant of every op is refused before anything is removed.
// The refusal names the two paths that still work: an explicit grant that names forget, and
// a per-use approval. An explicit grant, the --request/--approval path, and the owner at a
// terminal outside herdr are unchanged. Every other op a wildcard reached still reaches it,
// and the check/doctor widened-grant note does not list forget among the ops an older
// wildcard reaches. Written from that rule. The team is a synthetic registry record.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approveOwnerAction } from '../src/client/owner-action.ts';
import {
  admitGeneral,
  GENERAL_OPS,
  issueOwnerGeneralGrant,
  widenedGrantNote,
  wildcardGrantsWidened,
  type GrantOp,
} from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import type { Caller } from '../src/caller.ts';
import { runForget } from '../src/commands/forget.ts';
import { main } from '../src/cli.ts';
import type { Io } from '../src/io.ts';
import { getTeam, upsertTeam } from '../src/registry/teams.ts';
import { installKey } from '../src/store/keys.ts';
import { fixtureBase } from './helpers.ts';
import { seatOwner, type FakeStore } from './helpers/owner-seat.ts';

const base = fixtureBase('.forget-wildcard-');
const home = join(base, 'home');
const root = join(base, 'repo');
const day = 86_400_000;
const seat: Caller = { kind: 'seat', name: 'holder', pane: 'p1' };
const owner: Caller = { kind: 'owner' };
const detached: Caller = { kind: 'owner-no-tty' };
const approvalNow = new Date('2026-11-07T12:00:00Z');
// Signed before forget shipped (v0.5.6, 2026-10-31), read after every later release in the table.
const signedBeforeForget = new Date('2026-10-30T12:00:00Z');
const widenedRead = new Date('2026-11-08T00:00:00Z');
const widenedExpires = new Date('2027-01-01T00:00:00Z');

const wildTeam = 'wild00wild00';
const namedTeam = 'expl00expl00';
const ownerTeam = 'ownr00ownr00';
const approvalTeam = 'aprv00aprv00';

let keyPath = '';
let wildcard = '';
let namedForget = '';
let store: FakeStore;

function namesOpenPaths(text: string): void {
  expect(text).toMatch(/explicit grant/i);
  expect(text).toMatch(/per-use approval/i);
  expect(text).toMatch(/forget/);
}

function remember(id: string): void {
  upsertTeam(home, id, { project: 'acme', session: 'acme', root, by: 'test' });
}

beforeAll(() => {
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
  const pair = newClientKeyPair();
  const written = writeClientKeyFiles(join(home, '.config', 'team-client', 'holder'), pair);
  if (!written.ok) throw new Error(written.why);
  keyPath = written.keyPath;
  const later = new Date(Date.now() + day);
  const star = issueOwnerGeneralGrant(home, {
    clientId: 'holder', publicKey: pair.publicKey, entities: ['*'], ops: ['*'] satisfies GrantOp[], mayIssue: false, expires: later,
  });
  if (!star.ok) throw new Error(star.why);
  wildcard = star.path;
  const named = issueOwnerGeneralGrant(home, {
    clientId: 'holder', publicKey: pair.publicKey, entities: ['*'], ops: ['forget'] satisfies GrantOp[], mayIssue: false, expires: later,
  });
  if (!named.ok) throw new Error(named.why);
  namedForget = named.path;
  const old = issueOwnerGeneralGrant(home, {
    clientId: 'holder', publicKey: pair.publicKey, entities: ['*'], ops: ['*'] satisfies GrantOp[], mayIssue: false, expires: widenedExpires,
  }, signedBeforeForget);
  if (!old.ok) throw new Error(old.why);
  store = seatOwner(home);
  for (const id of [wildTeam, namedTeam, ownerTeam, approvalTeam]) remember(id);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

async function run(argv: string[], caller: Caller): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: Io = {
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
    cwd: root,
    env: { HOME: home },
    stdinIsTTY: caller.kind === 'owner',
    caller,
  };
  return { code: await main(argv, io), out, err };
}

/** Scenes that remove a record go through `team forget`, which reads `homedir()`. That value is the HOME the process started with, so these scenes run in a child started with the synthetic home. */
function runChild(argv: string[], caller: 'seat' | 'owner'): { code: number; out: string; err: string } {
  const worker = fileURLToPath(new URL('./adapters/forget-wildcard-independent-worker.ts', import.meta.url));
  const child = spawnSync(process.execPath, [worker, realpathSync(home), realpathSync(root), caller, JSON.stringify(argv)], {
    cwd: root,
    env: { ...process.env, HOME: realpathSync(home), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as { code: number; out: string; err: string };
}

test('a wildcard grant asking for forget is refused before the team is removed', async () => {
  const ran = await run(['forget', wildTeam, '--general', wildcard, '--key', keyPath], seat);
  expect(ran.code).toBe(1);
  namesOpenPaths(`${ran.err}${ran.out}`);
  expect(`${ran.err}${ran.out}`).not.toContain(`forgot ${wildTeam}`);
  expect(getTeam(home, wildTeam)?.project).toBe('acme');
});

test('an explicit grant that names forget is still admitted and removes the team', () => {
  const ran = runChild(['forget', namedTeam, '--general', namedForget, '--key', keyPath], 'seat');
  expect(ran.code).toBe(0);
  expect(ran.err).toContain('admitted by general grant');
  expect(ran.out).toContain(`forgot ${namedTeam}`);
  expect(getTeam(home, namedTeam)).toBeNull();
});

test('a per-use request records nothing removed, and the approval still forgets', async () => {
  const sources = { home, now: () => approvalNow, ownerSeatStore: store };
  let out = '';
  let err = '';
  const ask: Io & { out: string; err: string } = {
    out: '',
    err: '',
    stdout: (text) => { out += text; ask.out = out; },
    stderr: (text) => { err += text; ask.err = err; },
    cwd: root,
    env: { HOME: home },
    stdinIsTTY: false,
    caller: detached,
  };
  expect(await runForget([approvalTeam, '--request'], ask, sources), ask.err).toBe(0);
  expect(getTeam(home, approvalTeam)?.project).toBe('acme');
  const id = /owner-seat request (oa_[0-9a-f]{24})/.exec(ask.out)?.[1] ?? '';
  expect(id).not.toBe('');
  expect(approveOwnerAction(home, id, 'oui', store, approvalNow)).toMatchObject({ ok: true });
  out = '';
  err = '';
  const ran: Io & { out: string; err: string } = {
    out: '',
    err: '',
    stdout: (text) => { out += text; ran.out = out; },
    stderr: (text) => { err += text; ran.err = err; },
    cwd: root,
    env: { HOME: home },
    stdinIsTTY: false,
    caller: detached,
  };
  expect(await runForget([approvalTeam, '--approval', id], ran, sources), ran.err + ran.out).toBe(0);
  expect(ran.out).toContain(`forgot ${approvalTeam}`);
  expect(getTeam(home, approvalTeam)).toBeNull();
});

test('the owner at a terminal outside herdr still forgets, with no grant', () => {
  const ran = runChild(['forget', ownerTeam], 'owner');
  expect(ran.code).toBe(0);
  expect(ran.out).toContain(`forgot ${ownerTeam}`);
  expect(`${ran.err}${ran.out}`).not.toContain('general grant');
  expect(getTeam(home, ownerTeam)).toBeNull();
});

test('a wildcard still reaches every other op, and no longer reaches forget', () => {
  for (const op of GENERAL_OPS) {
    const held = admitGeneral(home, wildcard, keyPath, op, null);
    if (op === 'forget') {
      expect(held.ok).toBe(false);
      if (!held.ok) namesOpenPaths(held.why);
    } else {
      expect(held.ok).toBe(true);
    }
  }
});

test('a wildcard still admits another op through the door', async () => {
  const ran = await run(['status', '--general', wildcard, '--key', keyPath], seat);
  expect(ran.err).toContain('admitted by general grant');
  expect(`${ran.err}${ran.out}`).not.toContain('does not cover status');
});

test('the check and doctor widened note does not list forget as reached', () => {
  const widened = wildcardGrantsWidened(home, widenedRead).find((row) => row.signed === signedBeforeForget.toISOString());
  expect(widened).toBeDefined();
  if (widened === undefined) return;
  expect(widened.ops).not.toContain('forget');
  // setup shipped in the same release as forget; peek shipped later. Both stay reached.
  expect(widened.ops).toContain('setup');
  expect(widened.ops).toContain('peek');
  const note = widenedGrantNote(widened);
  expect(note).toContain('setup');
  expect(note).not.toMatch(/\bforget\b/);
});
