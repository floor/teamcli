// Behavioural proof of the warm send host's hand-back points (rfc-bus-send-server §2.5, §5): a
// real charter that admits a send, a real owner-seat rule that admits one, and a restored pane
// that lost its herdr name. Inside the hosted guard each line is handed back (HostedFallback)
// before anything is written: the home and checkout trees and the herdr call log are byte-for-byte
// what they were. The same line then runs in-process exactly as a line that never met the host.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { approveOwnerAction, createOwnerActionRequest } from '../../src/client/owner-action.ts';
import { runSend, type SendHost } from '../../src/commands/send.ts';
import { runSetup } from '../../src/commands/setup.ts';
import { armHostedGuard, disarmHostedGuard, HostedFallback, runAsHostedRequest } from '../../src/host/request-scope.ts';
import { callerOf, resetCallerCaches, type CallerSources } from '../../src/caller.ts';
import { setHerdrRun } from '../../src/herdr.ts';
import { registerAgent } from '../../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../../src/registry/teams.ts';
import { testIo } from '../helpers.ts';
import { fakeOwnerStore, seatOwner, type FakeStore } from '../helpers/owner-seat.ts';

const NOW = new Date('2026-11-07T12:00:00.000Z');
const AGENT: Caller = { kind: 'unplaced', reason: 'a seat in the covered checkout' };
const NO_TTY: Caller = { kind: 'owner-no-tty' };
const SCOPE = { peerPid: 4242, startPid: 4241, currentParent: () => 4241 };

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

function scene(): { base: string; home: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'host-fallback-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  upsertTeam(home, teamIdOf(root), { project: 'acme', session: 'acme', root, by: 'test' });
  return { base, home, root };
}

/** Every file under `dir` with its bytes and mode: what "nothing was written" is judged against. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (name === '.git') continue;
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else out.set(path, `${stat.mode}:${readFileSync(path, 'base64')}`);
    }
  };
  walk(dir);
  return out;
}

function sendHost(root: string, home: string, store: FakeStore, calls: string[]): SendHost {
  const sockets = join(root, 'socks');
  mkdirSync(sockets, { recursive: true });
  return {
    agents: () => [],
    processInfo: () => null,
    socketsDir: sockets,
    deliver: async () => { calls.push('deliver'); return { ok: true }; },
    native: {
      typeText: () => { calls.push('typeText'); return true; },
      pressEnter: () => { calls.push('pressEnter'); return true; },
      status: () => 'idle',
      wait: async () => {},
    },
    now: () => NOW,
    home,
    ownerSeatStore: store,
    inboxGraceMs: 0,
  };
}

async function hosted<T>(fn: () => Promise<T>): Promise<{ error?: unknown; value?: T; guard: ReturnType<typeof disarmHostedGuard> }> {
  armHostedGuard(() => null);
  try {
    const value = await runAsHostedRequest(SCOPE, fn);
    return { value, guard: disarmHostedGuard() };
  } catch (error) {
    return { error, guard: disarmHostedGuard() };
  }
}

type Outcome = { code: number; out: string; err: string };

/** The same send, three ways: hosted (handed back, nothing written), then in-process in that same
 *  scene, compared with the same line in a fresh scene that never met the host. */
async function threeWays(build: () => Promise<{ home: string; root: string; store: FakeStore; caller: Caller }>, argv: string[], why: string): Promise<void> {
  const a = await build();
  const calls: string[] = [];
  const before = { home: snapshot(a.home), root: snapshot(a.root) };
  const run = await hosted(() => runSend([...argv], testIo(a.root, a.caller), sendHost(a.root, a.home, a.store, calls)));
  expect(run.error).toBeInstanceOf(HostedFallback);
  expect(run.guard.fellBack).toBe(why);
  expect(run.guard.first).toBeNull();
  expect(calls).toEqual([]);
  expect(snapshot(a.home)).toEqual(before.home);
  expect(snapshot(a.root)).toEqual(before.root);

  const local = testIo(a.root, a.caller);
  const after: Outcome = { code: await runSend([...argv], local, sendHost(a.root, a.home, a.store, calls)), out: local.out, err: local.err };
  const b = await build();
  const fresh = testIo(b.root, b.caller);
  const never: Outcome = { code: await runSend([...argv], fresh, sendHost(b.root, b.home, b.store, [])), out: fresh.out, err: fresh.err };
  // Admitted, written and kept: the line got past the admission it was handed back at.
  expect(after.err).toContain("kept in lead's inbox");
  expect(after.err).not.toContain('only the owner');
  const norm = (text: string, scene: { home: string; root: string }): string => text.replaceAll(scene.root, '<root>').replaceAll(scene.home, '<home>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');
  expect({ code: after.code, out: norm(after.out, a), err: norm(after.err, a) }).toEqual({ code: never.code, out: norm(never.out, b), err: norm(never.err, b) });
}

test('a real charter admitting a send hands the line back before any write, and the in-process run is unchanged', async () => {
  // Control: with no charter the same unplaced caller is refused, so the admission below is the charter's.
  const bare = scene();
  const refused = testIo(bare.root, AGENT);
  expect(await runSend(['lead', 'hello'], refused, sendHost(bare.root, bare.home, fakeOwnerStore(), []))).toBe(1);
  await threeWays(async () => {
    const s = scene();
    const store = fakeOwnerStore();
    await runSetup(['--signer', 'touch-id', '--team', 'acme', '--roots', s.root], testIo(s.root, AGENT), { home: s.home, store, now: () => NOW });
    return { ...s, store, caller: AGENT };
  }, ['lead', 'hello'], 'a charter admits this line');
});

test('a real owner-seat rule admitting a send hands the line back before its claim, and the in-process run is unchanged', async () => {
  const bare = scene();
  const refused = testIo(bare.root, NO_TTY);
  expect(await runSend(['lead', 'hello'], refused, sendHost(bare.root, bare.home, seatOwner(bare.home), []))).toBe(1);
  await threeWays(async () => {
    const s = scene();
    const store = seatOwner(s.home);
    const asked = createOwnerActionRequest(s.home, { actions: ['team-send'], root: s.root, team: 'acme', head: null, args: { 'team-send': [] }, requestedBy: 'ada' }, NOW);
    if (!asked.ok) throw new Error('the rule request was not made');
    expect(approveOwnerAction(s.home, asked.record.request_id, 'always', store, NOW)).toMatchObject({ ok: true });
    return { ...s, store, caller: NO_TTY };
  }, ['lead', 'hello'], 'an owner-seat rule admits this line');
});

test('a restored pane that lost its herdr name is handed back before the rename, and the in-process placement renames it', async () => {
  const { home, root } = scene();
  const PANE = 'fixture-pane-restored';
  const SHELL = 7101;
  const CLI = 7102;
  registerAgent(home, {
    name: 'lead',
    signing: { model: 'm', version: '1', role: 'coordinator' },
    lab: 'lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamIdOf(root), seat: 'lead', session: 'acme', pane: PANE, address: null, agent_session: 'conv-kept' },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  } as never);
  const herdr: string[][] = [];
  setHerdrRun((args) => { herdr.push(args); return { result: { type: 'ok' } }; });
  const sources = (): CallerSources => ({
    ancestors: () => [{ pid: CLI, name: 'claude' }, { pid: SHELL, name: 'zsh' }, { pid: 8100, name: 'herdr' }, { pid: 1, name: 'init' }],
    agents: () => [{ name: null, agent: 'claude', pane: PANE, workspace: 'ws', status: 'idle', cwd: null, session: 'conv-kept' }] as never,
    paneRootPid: (pane) => (pane === PANE ? SHELL : null),
    env: {},
    stdinIsTTY: false,
    paneProcesses: (pane) => (pane === PANE ? { shell: SHELL, foreground: [CLI] } : null),
    foreground: (pane) => (pane === PANE ? ['claude'] : null),
    home,
    processStartOf: () => null,
  });
  const io = { env: {}, stdinIsTTY: false, callerSources: sources };
  try {
    const before = { home: snapshot(home), root: snapshot(root) };
    resetCallerCaches();
    const run = await hosted(async () => callerOf(io, 'acme'));
    expect(run.error).toBeInstanceOf(HostedFallback);
    expect(run.guard.fellBack).toBe('the seat pane lost its herdr name; the in-process run repairs it');
    expect(run.guard.first).toBeNull();
    expect(herdr).toEqual([]);
    expect(snapshot(home)).toEqual(before.home);
    expect(snapshot(root)).toEqual(before.root);
    resetCallerCaches();
    expect(callerOf(io, 'acme')).toEqual({ kind: 'seat', name: 'lead', pane: PANE, session: 'acme' });
    // The in-process placement went on to the rename: it asked herdr, and the placement log
    // line (written by the repair, never by the hosted run) is in the checkout's state folder.
    expect(herdr).toContainEqual(['agent', 'list']);
    const written = [...snapshot(root).entries()].filter(([path, bytes]) => before.root.get(path) !== bytes);
    expect(written.some(([path]) => readFileSync(path, 'utf8').includes(`the herdr name on pane ${PANE}`))).toBe(true);
  } finally {
    setHerdrRun(null);
    resetCallerCaches();
  }
});
