// The charter judges the folder a command changes, never the caller's cwd. `--request` records
// a card and does not run the command. Every scene uses a temp home; the real team config is
// never read or written.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { approveOwnerAction, createOwnerActionRequest } from '../src/client/owner-action.ts';
import { actionApprovalsFolder } from '../src/client/team-create.ts';
import { runApprovals } from '../src/commands/approvals.ts';
import { runClient } from '../src/commands/client.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runForget } from '../src/commands/forget.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runSetup } from '../src/commands/setup.ts';
import { runSwap } from '../src/commands/swap.ts';
import { runUp, type UpSources } from '../src/commands/up.ts';
import { runStandingGrant } from '../src/permissions/manage.ts';
import { getTeam, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { testIo } from './helpers.ts';
import { fakeOwnerStore, seatOwner, type FakeStore } from './helpers/owner-seat.ts';

const NOW = new Date('2026-11-07T12:00:00.000Z');
const AGENT: Caller = { kind: 'unplaced', reason: 'a seat in the covered checkout' };
const OWNER: Caller = { kind: 'owner' };
const NO_TTY: Caller = { kind: 'owner-no-tty' };

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): { base: string; home: string; covered: string; outside: string; store: FakeStore } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'charter-target-')));
  made.push(base);
  const home = join(base, 'home');
  const covered = join(base, 'covered');
  const outside = join(base, 'outside');
  mkdirSync(home, { recursive: true });
  for (const root of [covered, outside]) {
    mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM.replace('project: acme', root === covered ? 'project: acme' : 'project: beta').replace('session: acme', root === covered ? 'session: acme' : 'session: beta'));
  }
  const store = fakeOwnerStore();
  return { base, home, covered, outside, store };
}

async function sign(home: string, store: FakeStore, roots: string[], cwd: string): Promise<void> {
  const code = await runSetup(['--signer', 'touch-id', '--team', 'acme', '--roots', roots.join(',')], testIo(cwd, AGENT), { home, store, now: () => NOW });
  expect(code).toBe(0);
}

function register(home: string, root: string, project: string): string {
  const id = teamIdOf(root);
  upsertTeam(home, id, { project, session: project, root, by: 'test' });
  return id;
}

function sendHost(root: string, home: string, store: FakeStore): SendHost {
  const sockets = join(root, 'socks');
  mkdirSync(sockets, { recursive: true });
  return {
    agents: () => [],
    processInfo: () => null,
    socketsDir: sockets,
    deliver: async () => ({ ok: true }),
    native: { typeText: () => true, pressEnter: () => true, status: () => 'idle', wait: async () => {} },
    now: () => NOW,
    home,
    ownerSeatStore: store,
    inboxGraceMs: 0,
  };
}

function downSources(home: string, store: FakeStore): DownSources {
  return {
    sessionRunning: () => false,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => null,
    foreground: () => null,
    now: () => NOW,
    home,
    ownerSeatStore: store,
    launch: {
      typeText: () => true,
      sendKey: () => true,
      pressEnter: () => true,
      agentPanes: () => [],
      closeWorkspace: () => false,
      stopSession: () => false,
      deleteSession: () => false,
      kill: () => false,
      sleep: async () => {},
      now: () => NOW,
    },
  };
}

test('forget judges the named team, and --request removes nothing', async () => {
  const { home, covered, outside, store } = scratch();
  await sign(home, store, [covered], covered);
  const here = register(home, covered, 'acme');
  const there = register(home, outside, 'beta');
  const sources = { home, now: () => NOW, ownerSeatStore: store };
  const missed = testIo(covered, AGENT);
  expect(await runForget(['beta'], missed, sources), missed.err).toBe(1);
  expect(missed.err).toContain('team setup --edit');
  expect(getTeam(home, there)).not.toBeNull();
  const asked = testIo(covered, AGENT);
  expect(await runForget(['acme', '--request'], asked, sources), asked.err + asked.out).toBe(0);
  expect(asked.out).toContain('recorded');
  expect(getTeam(home, here)).not.toBeNull();
  const admitted = testIo(covered, AGENT);
  expect(await runForget(['acme'], admitted, sources), admitted.err + admitted.out).toBe(0);
  expect(getTeam(home, here)).toBeNull();
  expect(getTeam(home, there)).not.toBeNull();

  const plain = scratch();
  const owned = register(plain.home, plain.covered, 'acme');
  const owner = testIo(plain.covered, OWNER);
  expect(await runForget(['acme'], owner, { home: plain.home, now: () => NOW, ownerSeatStore: plain.store }), owner.err + owner.out).toBe(0);
  expect(getTeam(plain.home, owned)).toBeNull();
});

test('a covered checkout cannot revoke, send, stop, swap or launch a team outside the charter', async () => {
  const { home, covered, outside, store } = scratch();
  await sign(home, store, [covered], covered);
  register(home, outside, 'beta');
  const madeRequest = createOwnerActionRequest(home, {
    actions: ['team-down'],
    root: outside,
    team: 'beta',
    head: null,
    args: { 'team-down': [] },
    requestedBy: 'ada',
  }, NOW);
  expect(madeRequest.ok).toBe(true);
  if (!madeRequest.ok) return;
  const rule = madeRequest.record.request_id;
  expect(approveOwnerAction(home, rule, 'always', store, NOW)).toMatchObject({ ok: true });
  expect(existsSync(join(actionApprovalsFolder(home), `${rule}.json`))).toBe(true);
  const revoke = testIo(covered, AGENT);
  expect(await runApprovals(['revoke', rule], revoke, { home, now: () => NOW, ownerSeatStore: store }), revoke.err).toBe(1);
  expect(revoke.err).toContain('team setup --edit');
  expect(existsSync(join(actionApprovalsFolder(home), `${rule}.json`))).toBe(true);

  const sent = testIo(covered, AGENT);
  expect(await runSend(['lead@beta', 'hello'], sent, sendHost(covered, home, store)), sent.err).toBe(1);
  expect(sent.err).toContain('team setup --edit');

  const file = join(outside, '.agents', 'team.yaml');
  const before = readFileSync(file, 'utf8');
  const down = testIo(covered, AGENT);
  expect(await runDown(['--file', file], down, downSources(home, store)), down.err).toBe(1);
  expect(down.err).toContain('team setup --edit');
  expect(readFileSync(file, 'utf8')).toBe(before);

  const swap = testIo(covered, AGENT);
  expect(await runSwap(['--file', file], swap, { home, now: () => NOW, ownerSeatStore: store }), swap.err).toBe(1);
  expect(swap.err).toContain('team setup --edit');
  expect(readFileSync(file, 'utf8')).toBe(before);

  const upSources: UpSources = {
    home,
    ownerSeatStore: store,
    now: () => NOW,
    sessionRunning: () => false,
    agents: () => [],
  };
  const up = testIo(covered, AGENT);
  expect(await runUp(['--file', file, '--dry-run'], up, upSources), up.err).toBe(1);
  expect(up.err).toContain('team setup --edit');
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('the owner forgets a team outside the charter directly', async () => {
  const { home, covered, outside, store } = scratch();
  await sign(home, store, [covered], covered);
  const there = register(home, outside, 'beta');
  const owner = testIo(covered, OWNER);
  expect(await runForget(['beta'], owner, { home, now: () => NOW, ownerSeatStore: store }), owner.err + owner.out).toBe(0);
  expect(owner.out).toContain('forgot');
  expect(getTeam(home, there)).toBeNull();
});

test('an always rule does not send, stop or launch a team outside its folder', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'charter-rule-')));
  made.push(base);
  const home = join(base, 'home');
  const here = join(base, 'lane', 'acme');
  const there = join(base, 'beta');
  mkdirSync(home, { recursive: true });
  for (const root of [here, there]) {
    mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    const project = root === here ? 'acme' : 'beta';
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM.replaceAll('acme', project));
  }
  const store = seatOwner(home);
  register(home, there, 'beta');
  const asked = createOwnerActionRequest(home, {
    actions: ['team-send', 'team-down', 'team-up'],
    root: here,
    team: 'acme',
    head: null,
    args: { 'team-send': [], 'team-down': [], 'team-up': [] },
    requestedBy: 'ada',
  }, NOW);
  expect(asked.ok).toBe(true);
  if (!asked.ok) return;
  expect(approveOwnerAction(home, asked.record.request_id, 'always', store, NOW)).toMatchObject({ ok: true });
  const file = join(there, '.agents', 'team.yaml');
  const before = readFileSync(file, 'utf8');
  const sent = testIo(here, NO_TTY);
  expect(await runSend(['lead@beta', 'hello'], sent, sendHost(here, home, store)), sent.err).toBe(1);
  expect(sent.err).toContain('only the owner or a seat the send admission admits');
  const down = testIo(here, NO_TTY);
  expect(await runDown(['--file', file], down, downSources(home, store)), down.err).toBe(1);
  expect(down.err).toContain('only the owner or a `leads` seat');
  expect(readFileSync(file, 'utf8')).toBe(before);
  const up = testIo(here, NO_TTY);
  const upSources: UpSources = { home, ownerSeatStore: store, now: () => NOW, sessionRunning: () => false, agents: () => [] };
  expect(await runUp(['--file', file, '--dry-run'], up, upSources), up.err).toBe(1);
  expect(up.err).toContain('only the owner or a `leads` seat');
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('a charter does not issue a general grant or a standing grant', async () => {
  const { home, covered, store } = scratch();
  await sign(home, store, [covered], covered);
  const pub = join(covered, 'client.pub');
  writeFileSync(pub, `${JSON.stringify({ public_key: 'abc' })}\n`);
  const asked = testIo(covered, AGENT);
  expect(runClient(['general-grant', '--to', 'reader', '--public-key', pub, '--request'], asked, home), asked.err + asked.out).toBe(0);
  expect(asked.out).toContain('recorded');
  expect(asked.out).not.toContain('issued');
  const grant = testIo(covered, AGENT);
  expect(runStandingGrant(grant, { seat: 'lead', capabilities: ['send'] }, { home, ownerSeatStore: store })).toBe('refused');
  expect(grant.err).toContain('only the owner');
});
