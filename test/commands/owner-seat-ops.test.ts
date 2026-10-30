// Owner-seat doors for send, down, bus, approvals and forget, and a dead bus's backoff.
// Hermetic: a temporary HOME, an in-memory credential store, no herdr, never ~/.config/team.

import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveOwnerAction } from '../../src/client/owner-action.ts';
import { ownerSeatMessages } from '../../src/client/owner-seat.ts';
import { presentOwnerRequest, writeOwnerPageLink } from '../../src/client/owner-page-link.ts';
import { actionApprovalsFolder, actionRequestsFolder } from '../../src/client/team-create.ts';
import { freshBusWatch, nextBackoffMs, reviveBus } from '../../src/bus/supervise.ts';
import { busSocket } from '../../src/bus/server.ts';
import type { Caller } from '../../src/caller.ts';
import { runApprovals } from '../../src/commands/approvals.ts';
import { runBatch } from '../../src/commands/batch.ts';
import { runBus } from '../../src/commands/bus.ts';
import { runDown, type DownSources } from '../../src/commands/down.ts';
import { runForget } from '../../src/commands/forget.ts';
import { runConfig } from '../../src/commands/config.ts';
import { runSend, type SendHost } from '../../src/commands/send.ts';
import type { Io } from '../../src/io.ts';
import { upsertProject, readProjects } from '../../src/registry/projects.ts';
import { getTeam, teamIdOf, upsertTeam } from '../../src/registry/teams.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { seatOwner, type FakeStore } from '../helpers/owner-seat.ts';

const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date('2026-10-26T12:00:00.000Z');
const detached: Caller = { kind: 'owner-no-tty' };
const owner: Caller = { kind: 'owner' };

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
    leads: true
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
delivery_order: [mcp-inbox, typed]
`;

function place() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'owner-seat-ops-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'code', 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  const store = seatOwner(home);
  return { base, home, root, store };
}

function ioOf(root: string, caller: Caller): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout(text: string) { io.out += text; },
    stderr(text: string) { io.err += text; },
    cwd: root,
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    caller,
  };
  return io;
}

function requestId(text: string): string {
  return /owner-seat request (oa_[0-9a-f]{24})/.exec(text)?.[1] ?? '';
}

function sendHost(root: string, home: string, store: FakeStore): SendHost {
  const sockets = join(root, 'socks');
  mkdirSync(sockets, { recursive: true });
  const drop = join(root, '.agents', 'send-drops', 'acme', 'lead');
  mkdirSync(drop, { recursive: true });
  writeFileSync(join(drop, '.inbox-listener'), `${JSON.stringify({
    v: 1, seat: 'lead', session: 'acme', root, cli: 'claude-code', pid: process.pid, ts: NOW.toISOString(),
  })}\n`);
  return {
    agents: () => [{ name: 'lead', pane: 'w1:p1', cli: 'claude' }],
    processInfo: () => ({ shell: 400, foreground: [] }),
    socketsDir: sockets,
    deliver: async () => ({ ok: true }),
    native: { typeText: () => true, pressEnter: () => true, status: () => 'idle', wait: async () => {} },
    now: () => NOW,
    home,
    ownerSeatStore: store,
    inboxGraceMs: 0,
  };
}

function downSources(home: string, store: FakeStore, stopped: { n: number }): DownSources {
  return {
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    now: () => NOW,
    home,
    ownerSeatStore: store,
    launch: {
      typeText: () => true,
      sendKey: () => true,
      pressEnter: () => true,
      agentPanes: () => [],
      closeWorkspace: () => true,
      stopSession: () => { stopped.n += 1; return true; },
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    },
  };
}

describe('send, down and bus through the owner seat', () => {
  test('send --request writes nothing; --approval delivers; a replay is refused', async () => {
    const p = place();
    const host = sendHost(p.root, p.home, p.store);
    const ask = ioOf(p.root, detached);
    const asked = await runSend(['lead', 'hello', '--request'], ask, host);
    expect(asked, ask.err).toBe(0);
    const id = requestId(ask.out);
    expect(id).not.toBe('');
    const dropNames = readdirSync(join(p.root, '.agents', 'send-drops', 'acme', 'lead'));
    expect(dropNames.filter((name) => name !== '.inbox-listener')).toEqual([]);
    const early = ioOf(p.root, detached);
    expect(await runSend(['lead', 'hello', '--approval', id], early, host)).toBe(1);
    expect(early.err).toContain('has no owner-seat answer yet');
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const ran = ioOf(p.root, detached);
    expect(await runSend(['lead', 'hello', '--approval', id], ran, host), ran.err + ran.out).toBe(0);
    expect(ran.err).toContain(`owner-seat approval ${id} (signed by mac)`);
    expect(ran.out).toContain('lead: sent (unconfirmed)');
    const again = ioOf(p.root, detached);
    expect(await runSend(['lead', 'hello', '--approval', id], again, host)).toBe(1);
    expect(again.err).toContain('single-use');
  });

  test('an always rule admits send with no request, and the requester cannot approve their own', async () => {
    const p = place();
    const host = sendHost(p.root, p.home, p.store);
    const ask = ioOf(p.root, detached);
    expect(await runSend(['lead', 'hello', '--request'], ask, host)).toBe(0);
    const id = requestId(ask.out);
    expect(approveOwnerAction(p.home, id, 'always', p.store, NOW)).toMatchObject({ ok: true, choice: 'always' });
    const ran = ioOf(p.root, detached);
    expect(await runSend(['lead', 'stand by'], ran, host), ran.err + ran.out).toBe(0);
    expect(ran.out).toContain('lead: sent (unconfirmed)');
    const self = ioOf(p.root, { kind: 'seat', name: 'mac', pane: 'w9:p1', session: 'acme' });
    expect(await runSend(['lead', 'mine', '--request'], self, host)).toBe(0);
    const own = requestId(self.out);
    expect(approveOwnerAction(p.home, own, 'oui', p.store, NOW)).toEqual({ ok: false, why: `signer "mac" asked for request ${own}; no principal approves its own request` });
  });

  test('down --request stops nothing; --approval stops the session', async () => {
    const p = place();
    const stopped = { n: 0 };
    const sources = downSources(p.home, p.store, stopped);
    const ask = ioOf(p.root, detached);
    expect(await runDown(['--request'], ask, sources), ask.err).toBe(0);
    expect(stopped.n).toBe(0);
    const id = requestId(ask.out);
    const early = ioOf(p.root, detached);
    expect(await runDown(['--approval', id], early, sources)).toBe(1);
    expect(stopped.n).toBe(0);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const ran = ioOf(p.root, detached);
    expect(await runDown(['--approval', id], ran, sources), ran.err + ran.out).toBe(0);
    expect(ran.err).toContain(`owner-seat approval ${id}`);
    expect(stopped.n).toBe(1);
  });

  test('a leads seat on its own pane starts the bus; a worker does not; --approval does', async () => {
    const p = place();
    updateState(join(p.root, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.lead = { stage: 'ready', pane: 'w1:p1' };
      session.seats.worker = { stage: 'ready', pane: 'w2:p1' };
    });
    const stop = (end: () => void): (() => void) => { setTimeout(end, 0); return () => {}; };
    const worker = ioOf(p.root, { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' });
    expect(await runBus([], worker, { home: p.home, reconcileIntervalMs: 0, stop })).toBe(1);
    expect(worker.err).toContain('only the owner or a `leads` seat runs `bus`');
    expect(existsSync(busSocket(p.root))).toBe(false);
    const lead = ioOf(p.root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });
    expect(await runBus([], lead, { home: p.home, reconcileIntervalMs: 0, stop }), lead.err).toBe(0);
    expect(lead.err).toContain('answering on .agents/bus.sock');
    upsertTeam(p.home, teamIdOf(p.root), {
      project: 'acme', session: 'acme', root: p.root, by: 'test',
      roster: [{ agent: 'agt_worker', seat: 'worker', role: 'implementer', leads: true }],
    });
    const marked = ioOf(p.root, { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' });
    expect(await runBus([], marked, { home: p.home, reconcileIntervalMs: 0, stop }), marked.err).toBe(0);
    const ask = ioOf(p.root, detached);
    expect(await runBus(['--request'], ask, { home: p.home, ownerSeatStore: p.store, now: () => NOW })).toBe(0);
    expect(existsSync(busSocket(p.root))).toBe(false);
    const id = requestId(ask.out);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const ran = ioOf(p.root, detached);
    expect(await runBus(['--approval', id], ran, { home: p.home, ownerSeatStore: p.store, now: () => NOW, reconcileIntervalMs: 0, stop }), ran.err).toBe(0);
    expect(ran.err).toContain('answering on .agents/bus.sock');
    expect(existsSync(busSocket(p.root))).toBe(false);
  });

  test('an inherited token starts the bus with no owner terminal, and a loose token does not', async () => {
    const p = place();
    const stop = (end: () => void): (() => void) => { setTimeout(end, 0); return () => {}; };
    const nonce = 'ab'.repeat(16);
    const token = join(p.root, '.agents', 'bus.inherit');
    writeFileSync(token, `${nonce}\n`, { mode: 0o600 });
    const loose = ioOf(p.root, detached);
    chmodSync(token, 0o666);
    expect(await runBus(['--inherited', nonce], loose, { home: p.home, reconcileIntervalMs: 0, stop })).toBe(1);
    expect(existsSync(busSocket(p.root))).toBe(false);
    rmSync(token);
    writeFileSync(token, `${nonce}\n`, { mode: 0o600 });
    const ran = ioOf(p.root, detached);
    expect(await runBus(['--inherited', nonce], ran, { home: p.home, reconcileIntervalMs: 0, stop }), ran.err).toBe(0);
    expect(existsSync(token)).toBe(false);
    expect(ran.err).toContain('answering on .agents/bus.sock');
  });
});

describe('config set through the owner seat', () => {
  test('with Touch ID presented, one touch signs the request and the change applies in the same run', async () => {
    const p = place();
    const env = { ...process.env, TEAM_CONFIG_SOURCE: 'file' };
    const file = join(p.root, '.agents', 'team.yaml');
    const ran = ioOf(p.root, detached);
    expect(await runConfig(['set', 'project', 'touched', '--request'], ran, { home: p.home, env, now: () => NOW, ownerSeatStore: p.store, present: true }), ran.err + ran.out).toBe(0);
    expect(ran.err).toContain('owner notified via touch-id: approved with a verified owner-seat signature');
    expect(readFileSync(file, 'utf8')).toContain('project: touched');
  });

  test('--request writes nothing; --approval for other words refuses; the signed words apply once', async () => {
    const p = place();
    const env = { ...process.env, TEAM_CONFIG_SOURCE: 'file' };
    const sources = { home: p.home, env, now: () => NOW, ownerSeatStore: p.store };
    const file = join(p.root, '.agents', 'team.yaml');
    const before = readFileSync(file, 'utf8');
    const plain = ioOf(p.root, detached);
    expect(await runConfig(['set', 'project', 'other'], plain, sources)).toBe(1);
    const ask = ioOf(p.root, detached);
    expect(await runConfig(['set', 'project', 'other', '--request'], ask, sources), ask.err).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
    const id = requestId(ask.out);
    expect(id).not.toBe('');
    const early = ioOf(p.root, detached);
    expect(await runConfig(['set', 'project', 'other', '--approval', id], early, sources)).toBe(1);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const widened = ioOf(p.root, detached);
    expect(await runConfig(['set', 'project', 'wider', '--approval', id], widened, sources)).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
    const ran = ioOf(p.root, detached);
    expect(await runConfig(['set', 'project', 'other', '--approval', id], ran, sources), ran.err + ran.out).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('project: other');
    const replay = ioOf(p.root, detached);
    expect(await runConfig(['set', 'project', 'again', '--approval', id], replay, sources)).toBe(1);
  });
});

describe('approvals and forget', () => {
  test('list and revoke an always rule, including from a seat with an owner-seat answer', async () => {
    const p = place();
    const host = sendHost(p.root, p.home, p.store);
    const ask = ioOf(p.root, detached);
    expect(await runSend(['lead', 'hello', '--request'], ask, host)).toBe(0);
    const rule = requestId(ask.out);
    expect(approveOwnerAction(p.home, rule, 'always', p.store, NOW)).toMatchObject({ ok: true });
    const listed = ioOf(p.root, detached);
    expect(await runApprovals(['list'], listed, { home: p.home, now: () => NOW, ownerSeatStore: p.store })).toBe(0);
    expect(listed.out).toContain(rule);
    const revokeAsk = ioOf(p.root, detached);
    expect(await runApprovals(['revoke', rule, '--request'], revokeAsk, { home: p.home, now: () => NOW, ownerSeatStore: p.store })).toBe(0);
    expect(existsSync(join(actionApprovalsFolder(p.home), `${rule}.json`))).toBe(true);
    const id = requestId(revokeAsk.out);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const revoked = ioOf(p.root, detached);
    expect(await runApprovals(['revoke', rule, '--approval', id], revoked, { home: p.home, now: () => NOW, ownerSeatStore: p.store }), revoked.err).toBe(0);
    expect(revoked.out).toContain(`revoked ${rule}`);
    expect(existsSync(join(actionApprovalsFolder(p.home), `${rule}.json`))).toBe(false);
    const ownerRun = ioOf(p.root, owner);
    expect(await runApprovals(['list'], ownerRun, { home: p.home, now: () => NOW, ownerSeatStore: p.store })).toBe(0);
    expect(ownerRun.out).toContain('no always rules');
  });

  test('forget removes one registry record and its project membership, and refuses an ambiguous name', async () => {
    const p = place();
    const other = join(p.base, 'code', 'beta');
    mkdirSync(other, { recursive: true });
    const a = 'abc123abc123';
    const b = 'def456def456';
    upsertTeam(p.home, a, { project: 'acme', session: 'acme', root: p.root, by: 'test', roster: [{ agent: 'agt_lead', seat: 'lead', role: 'coordinator' }] });
    upsertTeam(p.home, b, { project: 'acme', session: 'beta', root: other, by: 'test' });
    upsertProject(p.home, 'acme-proj', { name: 'Acme', teams: [a, b], lead: 'agt_lead', by: 'test' });
    writeFileSync(join(p.root, '.agents', 'team.yaml'), TEAM);
    const ambiguous = ioOf(p.root, owner);
    expect(await runForget(['acme'], ambiguous, { home: p.home })).toBe(1);
    expect(ambiguous.err).toContain('names 2 teams');
    expect(getTeam(p.home, a)).not.toBeNull();
    expect(getTeam(p.home, b)).not.toBeNull();
    const ran = ioOf(p.root, owner);
    expect(await runForget([a], ran, { home: p.home }), ran.err).toBe(0);
    expect(ran.out).toContain(`forgot ${a}`);
    expect(ran.out).toContain('panes were not stopped');
    expect(getTeam(p.home, a)).toBeNull();
    expect(getTeam(p.home, b)?.project).toBe('acme');
    expect(readProjects(p.home)['acme-proj']?.teams).toEqual([b]);
    expect(readProjects(p.home)['acme-proj']?.lead).toBeNull();
    expect(existsSync(join(p.root, '.agents', 'team.yaml'))).toBe(true);
    const seat = ioOf(p.root, detached);
    expect(await runForget([b, '--request'], seat, { home: p.home, now: () => NOW, ownerSeatStore: p.store })).toBe(0);
    expect(getTeam(p.home, b)).not.toBeNull();
  });
});

function ruleFile(home: string, id: string): void {
  mkdirSync(actionApprovalsFolder(home), { recursive: true });
  writeFileSync(join(actionApprovalsFolder(home), `${id}.json`), '{}\n');
}

function deadPid(): number {
  for (let pid = 1_000_000; pid < 1_000_200; pid++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('no unused pid');
}

describe('several actions, one owner-seat request', () => {
  test('revoke takes every id in one request, and a bad id revokes nothing and spends nothing', async () => {
    const p = place();
    const a = `oa_${'ab'.repeat(12)}`;
    const b = `oa_${'cd'.repeat(12)}`;
    const missing = `oa_${'ef'.repeat(12)}`;
    ruleFile(p.home, a);
    ruleFile(p.home, b);
    const sources = { home: p.home, now: () => NOW, ownerSeatStore: p.store };
    const ask = ioOf(p.root, detached);
    expect(await runApprovals(['revoke', a, b, '--request'], ask, sources), ask.err).toBe(0);
    expect(ownerSeatMessages(p.home)).toHaveLength(1);
    expect(ask.out).toContain(a);
    expect(ask.out).toContain(b);
    const id = requestId(ask.out);
    const record = JSON.parse(readFileSync(join(actionRequestsFolder(p.home), `${id}.json`), 'utf8')) as { params: { actions: string[]; words: Record<string, string[]> } };
    expect(record.params.actions).toEqual(['team-revoke-approval']);
    expect(record.params.words['team-revoke-approval']).toEqual(['revoke', a, b]);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const ran = ioOf(p.root, detached);
    expect(await runApprovals(['revoke', a, b, '--approval', id], ran, sources), ran.err + ran.out).toBe(0);
    expect(ran.out).toContain(`revoked ${a}, ${b}`);
    expect(existsSync(join(actionApprovalsFolder(p.home), `${a}.json`))).toBe(false);
    expect(existsSync(join(actionApprovalsFolder(p.home), `${b}.json`))).toBe(false);
    ruleFile(p.home, a);
    ruleFile(p.home, b);
    const again = ioOf(p.root, detached);
    expect(await runApprovals(['revoke', a, b, '--approval', id], again, sources)).toBe(1);
    expect(again.err).toContain('single-use');
    expect(existsSync(join(actionApprovalsFolder(p.home), `${a}.json`))).toBe(true);

    ruleFile(p.home, a);
    const badAsk = ioOf(p.root, detached);
    expect(await runApprovals(['revoke', a, missing, '--request'], badAsk, sources), badAsk.err).toBe(0);
    const badId = requestId(badAsk.out);
    expect(approveOwnerAction(p.home, badId, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const blocked = ioOf(p.root, detached);
    expect(await runApprovals(['revoke', a, missing, '--approval', badId], blocked, sources)).toBe(1);
    expect(blocked.err).toContain('nothing was revoked');
    expect(existsSync(join(actionApprovalsFolder(p.home), `${a}.json`))).toBe(true);
    ruleFile(p.home, missing);
    const retry = ioOf(p.root, detached);
    expect(await runApprovals(['revoke', a, missing, '--approval', badId], retry, sources), retry.err + retry.out).toBe(0);
    expect(existsSync(join(actionApprovalsFolder(p.home), `${a}.json`))).toBe(false);
    expect(existsSync(join(actionApprovalsFolder(p.home), `${missing}.json`))).toBe(false);
    const repeated = ioOf(p.root, owner);
    ruleFile(p.home, a);
    expect(await runApprovals(['revoke', a, a], repeated, sources)).toBe(1);
    expect(repeated.err).toContain('is repeated');
    expect(existsSync(join(actionApprovalsFolder(p.home), `${a}.json`))).toBe(true);
  });

  test('forget takes every id in one request, and a bad word forgets nothing', async () => {
    const p = place();
    const a = 'abc123abc123';
    const b = 'def456def456';
    const other = join(p.base, 'code', 'beta');
    mkdirSync(other, { recursive: true });
    upsertTeam(p.home, a, { project: 'alpha', session: 'alpha', root: p.root, by: 'test' });
    upsertTeam(p.home, b, { project: 'beta', session: 'beta', root: other, by: 'test' });
    const sources = { home: p.home, now: () => NOW, ownerSeatStore: p.store };
    const ask = ioOf(p.root, detached);
    expect(await runForget([a, b, '--request'], ask, sources), ask.err).toBe(0);
    expect(ownerSeatMessages(p.home)).toHaveLength(1);
    const id = requestId(ask.out);
    const record = JSON.parse(readFileSync(join(actionRequestsFolder(p.home), `${id}.json`), 'utf8')) as { params: { words: Record<string, string[]> } };
    expect(record.params.words['team-forget']).toEqual([a, b]);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const ran = ioOf(p.root, detached);
    expect(await runForget([a, b, '--approval', id], ran, sources), ran.err + ran.out).toBe(0);
    expect(ran.out).toContain(`forgot ${a}`);
    expect(ran.out).toContain(`forgot ${b}`);
    expect(getTeam(p.home, a)).toBeNull();
    expect(getTeam(p.home, b)).toBeNull();

    upsertTeam(p.home, a, { project: 'alpha', session: 'alpha', root: p.root, by: 'test' });
    const badAsk = ioOf(p.root, detached);
    expect(await runForget([a, 'missing-team', '--request'], badAsk, sources)).toBe(0);
    const badId = requestId(badAsk.out);
    expect(approveOwnerAction(p.home, badId, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const blocked = ioOf(p.root, detached);
    expect(await runForget([a, 'missing-team', '--approval', badId], blocked, sources)).toBe(1);
    expect(blocked.err).toContain('no team record');
    expect(getTeam(p.home, a)).not.toBeNull();
    upsertTeam(p.home, 'missing-team', { project: 'gone', session: 'gone', root: other, by: 'test' });
    const retry = ioOf(p.root, detached);
    expect(await runForget([a, 'missing-team', '--approval', badId], retry, sources), retry.err + retry.out).toBe(0);
    expect(getTeam(p.home, a)).toBeNull();
    expect(getTeam(p.home, 'missing-team')).toBeNull();

    upsertTeam(p.home, a, { project: 'alpha', session: 'alpha', root: p.root, by: 'test' });
    const dup = ioOf(p.root, owner);
    expect(await runForget([a, 'alpha'], dup, { home: p.home })).toBe(1);
    expect(dup.err).toContain('already in this forget');
    expect(getTeam(p.home, a)).not.toBeNull();
    upsertTeam(p.home, b, { project: 'alpha', session: 'beta', root: other, by: 'test' });
    const ambiguous = ioOf(p.root, owner);
    expect(await runForget(['alpha', b], ambiguous, { home: p.home })).toBe(1);
    expect(ambiguous.err).toContain('names 2 teams');
    expect(getTeam(p.home, a)).not.toBeNull();
    expect(getTeam(p.home, b)).not.toBeNull();
  });

  test('one batch request is one card, and one answer runs every action', async () => {
    const p = place();
    const a = `oa_${'ab'.repeat(12)}`;
    const b = `oa_${'cd'.repeat(12)}`;
    const team = 'abc123abc123';
    ruleFile(p.home, a);
    ruleFile(p.home, b);
    upsertTeam(p.home, team, { project: 'acme', session: 'acme', root: p.root, by: 'test' });
    const sources = { home: p.home, now: () => NOW, ownerSeatStore: p.store };
    const ask = ioOf(p.root, detached);
    expect(await runBatch(['--request', '--do', 'approvals', 'revoke', a, b, '--do', 'forget', team], ask, sources), ask.err).toBe(0);
    expect(ownerSeatMessages(p.home)).toHaveLength(1);
    expect(ask.out).toContain('one signature covers 2 actions');
    const id = requestId(ask.out);
    const text = ownerSeatMessages(p.home)[0]?.text ?? '';
    expect(text).toContain('revoke an approval rule');
    expect(text).toContain(a);
    expect(text).toContain(b);
    expect(text).toContain('forget a team record');
    expect(text).toContain(team);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const dry = ioOf(p.root, detached);
    expect(await runBatch(['--approval', id, '--dry-run'], dry, sources), dry.err + dry.out).toBe(0);
    expect(dry.out).toContain('nothing was run');
    expect(existsSync(join(actionApprovalsFolder(p.home), `${a}.json`))).toBe(true);
    expect(getTeam(p.home, team)).not.toBeNull();
    const ran = ioOf(p.root, detached);
    expect(await runBatch(['--approval', id], ran, sources), ran.err + ran.out).toBe(0);
    expect(ran.out).toContain(`revoked ${a}, ${b}`);
    expect(ran.out).toContain(`forgot ${team}`);
    expect(ran.out).toContain('ran 2 actions');
    expect(existsSync(join(actionApprovalsFolder(p.home), `${a}.json`))).toBe(false);
    expect(getTeam(p.home, team)).toBeNull();
    ruleFile(p.home, a);
    ruleFile(p.home, b);
    upsertTeam(p.home, team, { project: 'acme', session: 'acme', root: p.root, by: 'test' });
    const replay = ioOf(p.root, detached);
    expect(await runBatch(['--approval', id], replay, sources)).toBe(1);
    expect(replay.err).toContain('single-use');
    expect(existsSync(join(actionApprovalsFolder(p.home), `${a}.json`))).toBe(true);
    expect(getTeam(p.home, team)).not.toBeNull();
  });

  test('a bad id in a batch runs nothing, and the same answer still works once the id exists', async () => {
    const p = place();
    const a = `oa_${'ab'.repeat(12)}`;
    const missing = `oa_${'ef'.repeat(12)}`;
    const team = 'abc123abc123';
    ruleFile(p.home, a);
    upsertTeam(p.home, team, { project: 'acme', session: 'acme', root: p.root, by: 'test' });
    const sources = { home: p.home, now: () => NOW, ownerSeatStore: p.store };
    const ask = ioOf(p.root, detached);
    expect(await runBatch(['--request', '--do', 'approvals', 'revoke', a, missing, '--do', 'forget', team], ask, sources)).toBe(0);
    const id = requestId(ask.out);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const blocked = ioOf(p.root, detached);
    expect(await runBatch(['--approval', id], blocked, sources)).toBe(1);
    expect(blocked.err).toContain('nothing was run');
    expect(existsSync(join(actionApprovalsFolder(p.home), `${a}.json`))).toBe(true);
    expect(getTeam(p.home, team)).not.toBeNull();
    ruleFile(p.home, missing);
    const retry = ioOf(p.root, detached);
    expect(await runBatch(['--approval', id], retry, sources), retry.err + retry.out).toBe(0);
    expect(existsSync(join(actionApprovalsFolder(p.home), `${a}.json`))).toBe(false);
    expect(getTeam(p.home, team)).toBeNull();
  });

  test('two revoke segments merge, a repeated action does not, and the requester cannot approve', async () => {
    const p = place();
    const a = `oa_${'ab'.repeat(12)}`;
    const b = `oa_${'cd'.repeat(12)}`;
    const sources = { home: p.home, now: () => NOW, ownerSeatStore: p.store };
    const merged = ioOf(p.root, detached);
    expect(await runBatch(['--request', '--do', 'approvals', 'revoke', a, '--do', 'approvals', 'revoke', b], merged, sources), merged.err).toBe(0);
    const id = requestId(merged.out);
    const record = JSON.parse(readFileSync(join(actionRequestsFolder(p.home), `${id}.json`), 'utf8')) as { params: { actions: string[]; words: Record<string, string[]> } };
    expect(record.params.actions).toEqual(['team-revoke-approval']);
    expect(record.params.words['team-revoke-approval']).toEqual(['revoke', a, b]);
    const duplicate = ioOf(p.root, detached);
    expect(await runBatch(['--request', '--do', 'up', '--do', 'up'], duplicate, sources)).toBe(2);
    expect(duplicate.err).toContain('already in this batch');
    const self = ioOf(p.root, { kind: 'seat', name: 'mac', pane: 'w9:p1', session: 'acme' });
    expect(await runBatch(['--request', '--do', 'forget', 'abc123abc123'], self, sources)).toBe(0);
    const own = requestId(self.out);
    expect(approveOwnerAction(p.home, own, 'oui', p.store, NOW)).toEqual({ ok: false, why: `signer "mac" asked for request ${own}; no principal approves its own request` });
  });

  test('a request does not open a browser when the owner page is already up', () => {
    const p = place();
    const a = `oa_${'ab'.repeat(12)}`;
    ruleFile(p.home, a);
    writeOwnerPageLink(p.home, { pid: process.pid, port: 9, url: 'http://localhost:9/?t=tok' });
    const live = ioOf(p.root, detached);
    expect(presentOwnerRequest(p.home, () => { throw new Error('opened a browser'); })).toBe('live');
    return runApprovals(['revoke', a, '--request'], live, { home: p.home, now: () => NOW, ownerSeatStore: p.store }).then((code) => {
      expect(code, live.err).toBe(0);
      expect(live.out).toContain('the owner page is already open and will show this card');
      expect(live.out).not.toContain('http://');
      writeOwnerPageLink(p.home, { pid: deadPid(), port: 9, url: 'http://localhost:9/?t=tok' });
      expect(presentOwnerRequest(p.home, () => { throw new Error('opened a browser'); })).toBe('closed');
      const closed = ioOf(p.root, detached);
      return runApprovals(['revoke', a, '--request'], closed, { home: p.home, now: () => NOW, ownerSeatStore: p.store }).then((again) => {
        expect(again, closed.err).toBe(0);
        expect(closed.out).toContain('the owner answers it on the owner page');
        expect(closed.out).not.toContain('http://');
      });
    });
  });
});

describe('a dead bus waits, then tries again', () => {
  test('backoff grows and a live socket is left alone', async () => {
    expect(nextBackoffMs(0)).toBe(0);
    expect(nextBackoffMs(1)).toBe(1000);
    expect(nextBackoffMs(2)).toBe(2000);
    expect(nextBackoffMs(6)).toBe(30_000);
    const watch = freshBusWatch();
    let starts = 0;
    const start = async () => {
      starts += 1;
      return { kind: 'bind-failed' as const, code: 'EADDRINUSE' };
    };
    const input = { root: '/tmp/owner-seat-ops-bus', team: {} as never, stderr: () => {} };
    const first = await reviveBus(input, watch, 0, async () => false, start);
    expect(first).toMatchObject({ kind: 'failed', nextAt: 1000 });
    expect(starts).toBe(1);
    expect(await reviveBus(input, watch, 500, async () => false, start)).toMatchObject({ kind: 'waiting' });
    expect(starts).toBe(1);
    const second = await reviveBus(input, watch, 1000, async () => false, start);
    expect(second).toMatchObject({ kind: 'failed', nextAt: 3000 });
    expect(starts).toBe(2);
    expect(await reviveBus(input, watch, 3000, async () => true, start)).toEqual({ kind: 'listening' });
    expect(starts).toBe(2);
    expect(watch.failures).toBe(0);
  });
});
