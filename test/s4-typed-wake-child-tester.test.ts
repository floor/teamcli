// Independent check of the typed wake handed to a one-shot daemon child
// (src/commands/send.ts, src/daemon/wake/child.ts, src/send/typed-wake.ts).
// The pane, the clock and the child walk are synthetic. No live host, CLI, or process signal
// is invoked. The in-process send daemon is the handoff's own listener.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { serveWakeChild, type WakeChildDeps } from '../src/daemon/wake/child.ts';
import type { WakeChildRequest } from '../src/daemon/wake/token.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { WAKE_IDLE_SETTLE_FLOOR_MS, WAKE_IDLE_SETTLE_MS } from '../src/profiles/profile.ts';
import { startSendDaemon, type DaemonHost, type SendDaemonHandle, type WakeHandoff } from '../src/send/daemon.ts';
import { readHistory } from '../src/send/history.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { reserveWake, wakeMarkAt, wakePath } from '../src/send/wake-marker.ts';
import { readScreen } from '../src/watch/screen.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, shortSocketBase, testIo } from './helpers.ts';

const IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.11', 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.11', 'working-synthetic.txt'), 'utf8');
const PANE = 'fixture-pane-one';
const SEAT = 'worker';
const ID = '019a0000-aaaa-7bbb-8ccc-ddddeeeeff01';
const LINE = 'fixture wake line';
const STAGED_AT = Date.parse('2026-11-05T11:59:59.000Z');
const NOW = new Date('2026-11-05T12:00:00.000Z');
const DRAFT = IDLE.replace('❯\n', '❯ fixture draft\n');

const ROOT = join(import.meta.dir, '..');
const PANE_WRITERS = new Set(['typeText', 'pressEnter', 'sendKey', 'typeTextAsync', 'pressEnterAsync', 'sendKeyAsync']);

let bases: string[] = [];
let scratch = '';
const handles: SendDaemonHandle[] = [];

afterEach(async () => {
  for (const handle of handles) await handle.close();
  handles.length = 0;
  const roots = [scratch, shortSocketBase()].filter((root) => root !== '');
  if (bases.length > 0) discardFixtures(bases, { roots });
  bases = [];
});

function holding(text: string): string {
  return IDLE.replace('❯\n', `❯ ${text}\n`);
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function importsPaneWriter(text: string): boolean {
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:\.\.\/)+herdr\.ts['"]/g)) {
    for (const specifier of (match[1] ?? '').split(',')) {
      const name = specifier.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0]?.trim();
      if (name !== undefined && PANE_WRITERS.has(name)) return true;
    }
  }
  return false;
}

type Made = { root: string; dir: string; home: string; team: TeamFile; socket: string };

function world(): Made {
  const base = fixtureBase('s4wake-');
  bases.push(base);
  scratch = dirname(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const socketDir = join(shortSocketBase(), `s4wake-${basename(base)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  mkdirSync(socketDir, { recursive: true });
  bases.push(socketDir);
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
  const text = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
trust:
  - ${lobbyDir(home)}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Fixture
    version: "1"
    launch: claude
  - role: implementer
    name: ${SEAT}
    cli: muse
    vendor: test
    model: Fixture
    version: "1"
    launch: muse
delivery_order: [mcp-inbox, typed]
`;
  writeFileSync(join(dir, 'team.yaml'), text, { mode: 0o600 });
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error('the fixture team did not load');
  return { root, dir, home, team: loaded.team, socket: join(socketDir, 'daemon.sock') };
}

function hostOf(made: Made): DaemonHost & SendHost & { typed: string[]; wakeCalls: string[] } {
  const typed: string[] = [];
  const wakeCalls: string[] = [];
  return {
    typed,
    wakeCalls,
    agents: () => [{ name: SEAT, pane: PANE }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: dirname(made.socket),
    daemonSocket: made.socket,
    deliver: async () => ({ ok: true }),
    native: {
      typeText: (_session, _pane, text) => {
        typed.push(text);
        return true;
      },
      pressEnter: () => true,
      status: () => 'idle',
      wait: async () => {},
      paneText: () => IDLE,
    },
    typedWake: (session) => {
      wakeCalls.push(session);
      const host: TypedWakeHost = { read: () => IDLE, type: () => true, enter: () => true, wait: async () => {} };
      return host;
    },
    now: () => NOW,
    home: made.home,
    deliverWaitMs: 50,
    pollReadyMs: 5,
  };
}

function requestOf(made: Made): WakeChildRequest {
  const drops = join(made.dir, 'wake-drops');
  mkdirSync(drops, { recursive: true });
  const dropPath = join(drops, ID);
  writeFileSync(dropPath, 'staged\n', { mode: 0o600 });
  return {
    version: 1,
    id: ID,
    seat: SEAT,
    session: 'acme',
    cli: 'muse',
    line: LINE,
    dropPath,
    dir: made.dir,
    root: made.root,
    project: 'acme',
    home: made.home,
    from: 'owner',
    body: 'fixture body',
    from_team: 'acme',
    stagedAt: STAGED_AT,
  };
}

function deps(walk: WakeChildDeps['walk']): WakeChildDeps & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    agents: () => [{ name: SEAT, pane: PANE }],
    processes: () => null,
    walk: async (host, pane, line, cli) => {
      state.calls += 1;
      return walk(host, pane, line, cli);
    },
    wakeHost: () => ({ read: () => null, type: () => false, enter: () => false, wait: async () => {} }),
    now: () => NOW,
  };
}

function historyOf(made: Made) {
  const read = readHistory('acme', made.root, made.home);
  if (!read.ok) throw new Error(read.reason);
  return read.entries;
}

function stepsOf(made: Made) {
  const read = readEvents('acme', made.root, made.home);
  if (!read.ok) throw new Error(read.reason);
  return read.events.map((one) => one.payload).filter((payload) => payload.record_id.startsWith(ID));
}

test('the CLI names the handoff and does not call it delivered', async () => {
  const made = world();
  const host = hostOf(made);
  const wakes: WakeHandoff[] = [];
  const started = await startSendDaemon({
    root: made.root,
    dir: made.dir,
    team: made.team,
    host,
    socketPath: made.socket,
    lockPath: `${made.socket}.lock`,
    wake: (wake) => wakes.push(wake),
  });
  if (started.kind !== 'serving') throw new Error(started.kind);
  handles.push(started.handle);

  const io = testIo(made.root, { kind: 'owner' });
  const code = await runSend([SEAT, 'fixture hello'], io, host);
  expect(code).toBe(0);
  expect(io.out).toContain('handed to the daemon for a typed wake');
  expect(io.out).not.toContain('delivered');
  expect(host.typed).toEqual([]);
  expect(host.wakeCalls).toEqual([]);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]?.seat).toBe(SEAT);
  expect(wakes[0]?.cli).toBe('muse');
  expect(historyOf(made)).toEqual([]);
});

test('one reservation types once, a killed walk leaves it unread, and a sent marker types nothing again', async () => {
  const made = world();
  const request = requestOf(made);
  const marker = wakePath(dirname(request.dropPath), ID);
  expect(reserveWake(marker, { id: ID, at: NOW.toISOString(), state: 'reserved' })).toBe(true);

  const killed = deps(async () => {
    expect(wakeMarkAt(marker)?.state).toBe('reserved');
    expect(existsSync(request.dropPath)).toBe(true);
    throw new Error('the child was killed');
  });
  await expect(serveWakeChild(request, killed)).rejects.toThrow('the child was killed');
  expect(killed.calls).toBe(1);
  expect(wakeMarkAt(marker)?.state).toBe('reserved');
  expect(existsSync(request.dropPath)).toBe(true);
  expect(historyOf(made).some((entry) => entry.outcome.includes('delivered'))).toBe(false);

  const woke = deps(async () => ({
    delivered: true,
    typed: true,
    tries: 1,
    reason: 'the working screen showed after 1 Enter',
    submittedAt: STAGED_AT + 400,
    workingAt: STAGED_AT + 900,
  }));
  expect(await serveWakeChild(request, woke)).toEqual({ outcome: 'delivered', reason: 'the working screen showed after 1 Enter' });
  expect(woke.calls).toBe(1);
  expect(wakeMarkAt(marker)?.state).toBe('sent');

  const again = deps(async () => ({ delivered: true, typed: true, tries: 1, reason: 'again' }));
  expect(await serveWakeChild(request, again)).toEqual({ outcome: 'coalesced' });
  expect(again.calls).toBe(0);

  const step = stepsOf(made).find((one) => one.record_id === `${ID}:leg.tried:typed`);
  expect(step).toMatchObject({ submit_ms: 400, working_ms: 900 });
});

test('submission is recorded without the working screen, and the working time stays unreported until that screen shows', async () => {
  const made = world();
  const request = requestOf(made);
  const marker = wakePath(dirname(request.dropPath), ID);
  expect(reserveWake(marker, { id: ID, at: NOW.toISOString(), state: 'reserved' })).toBe(true);
  const walked = deps(async () => ({
    delivered: true,
    typed: true,
    tries: 1,
    reason: 'the line left the box',
    submittedAt: STAGED_AT + 400,
  }));
  await serveWakeChild(request, walked);
  const step = stepsOf(made).find((one) => one.record_id === `${ID}:leg.tried:typed`);
  expect(step?.submit_ms).toBe(400);
  expect(step?.working_ms).toBeUndefined();
});

test('the 150 ms settle refuses a working screen and an unsent draft between the two idle reads', async () => {
  expect(WAKE_IDLE_SETTLE_MS).toBe(150);
  expect(WAKE_IDLE_SETTLE_FLOOR_MS).toBe(150);
  expect(readScreen('muse', IDLE).kind).toBe('idle');
  expect(readScreen('muse', WORKING).kind).toBe('working');
  expect(readScreen('muse', DRAFT).kind).toBe('unsent');

  const waits: number[] = [];
  const host = (second: string): TypedWakeHost => ({
    read: () => (waits.length === 0 ? IDLE : second),
    type: () => true,
    enter: () => true,
    wait: async (ms) => {
      waits.push(ms);
    },
  });

  const working = await deliverTypedWake(host(WORKING), PANE, LINE, 'muse');
  expect(waits).toEqual([150]);
  expect(working).toMatchObject({ delivered: false, typed: false, tries: 0 });
  expect(working.reason).toContain('working');
  expect(working.reason).toContain('nothing was typed');

  waits.length = 0;
  const draft = await deliverTypedWake(host(DRAFT), PANE, LINE, 'muse');
  expect(waits).toEqual([150]);
  expect(draft).toMatchObject({ delivered: false, typed: false, tries: 0 });
  expect(draft.reason).toContain('unsent');
  expect(draft.reason).toContain('nothing was typed');
});

test('the wake child binds the one typer and no messaging module types beside it', () => {
  const entry = readFileSync(join(ROOT, 'src', 'daemon', 'wake', 'entry.ts'), 'utf8');
  expect(entry).toContain('deliverTypedWake');
  expect(entry).toContain('herdrTypedWakeHost');
  expect(importsPaneWriter(entry)).toBe(false);
  const daemon = readFileSync(join(ROOT, 'src', 'send', 'daemon.ts'), 'utf8');
  expect(daemon).toContain('typeText: refuseTyping');
  expect(daemon).toContain('pressEnter: refuseTyping');
  expect(daemon).toContain('sendKey: refuseTyping');

  const messaging = [
    ...files(join(ROOT, 'src', 'send')),
    ...files(join(ROOT, 'src', 'daemon', 'wake')),
    join(ROOT, 'src', 'commands', 'send.ts'),
  ];
  const typers = messaging
    .filter((path) => importsPaneWriter(readFileSync(path, 'utf8')))
    .map((path) => relative(ROOT, path));
  expect(typers).toEqual(['src/send/typed-wake.ts']);
});
