import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { acquireSeatLock, seatLockPath } from '../src/launch/seat-lock.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import {
  daemonDropDir,
  daemonLockPath,
  daemonSocketPath,
  MAX_QUEUE_DEPTH,
  probeDaemonSocket,
  requestDaemon,
  startSendDaemon,
  stopSendDaemon,
  type DaemonHost,
  type SendDaemonHandle,
} from '../src/send/daemon.ts';
import { readHistory } from '../src/send/history.ts';
import { triggerLine } from '../src/send/native.ts';
import { readPending } from '../src/send/pending.ts';
import { LOG_FILE } from '../src/state.ts';
import { storePath } from '../src/store/store.ts';
import { filed } from './send-native-fixtures.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T16:00:00.000Z');
const RULE = '─'.repeat(30);

let base = '';
const handles: SendDaemonHandle[] = [];

afterEach(async () => {
  for (const h of handles) {
    await h.close();
  }
  handles.length = 0;
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

function teamYaml(root: string, lobby: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: helper
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: reviewer
    name: native
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m test
`;
}

function setupWorld() {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-daemon-')));
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), teamYaml(root, lobbyDir(home)));
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error('fixture team.yaml failed to load');
  return { root, dir, sockets, home, team: loaded.team };
}

function makeHost(
  world: ReturnType<typeof setupWorld>,
  overrides: Partial<DaemonHost & SendHost> = {},
): DaemonHost & SendHost & { typed: { pane: string; text: string }[]; enters: string[]; frames: string[] } {
  const typed: { pane: string; text: string }[] = [];
  const enters: string[] = [];
  const frames: string[] = [];
  let statusByPane: Record<string, string> = { 'pane-lead': 'idle', 'pane-native': 'idle' };

  const host: DaemonHost & SendHost & { typed: { pane: string; text: string }[]; enters: string[]; frames: string[] } = {
    typed,
    enters,
    frames,
    agents: () => [
      { name: 'lead', pane: 'pane-lead' },
      { name: 'native', pane: 'pane-native' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: world.sockets,
    deliver: async (_sock, frame) => {
      frames.push(frame);
      return { ok: true };
    },
    native: {
      typeText: (_session, pane, text) => {
        typed.push({ pane, text });
        return true;
      },
      pressEnter: (_session, pane) => {
        enters.push(pane);
        statusByPane[pane] = 'working';
        return true;
      },
      status: (_session, pane) => statusByPane[pane] ?? 'idle',
      wait: async () => {},
      paneText: (_session, pane) => {
        const last = [...typed].reverse().find((t) => t.pane === pane);
        if (last && !enters.includes(pane)) {
          return `${RULE}\n❯ ${last.text}\n${RULE}`;
        }
        return `${RULE}\n❯ \n${RULE}`;
      },
    },
    now: () => NOW,
    home: world.home,
    deliverWaitMs: 50,
    pollReadyMs: 5,
    ...overrides,
  };
  return host;
}

describe('send daemon lifecycle and single-instance locking', () => {
  test('starts with 0600 socket and lock inside 0700 state dirs, answers ping, and refuses second start without unlinking socket', async () => {
    const w = setupWorld();
    const host = makeHost(w);
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    handles.push(started.handle);

    const store = storePath('acme', w.root, w.home);
    const sockPath = daemonSocketPath('acme', w.root, w.home);
    const lockPath = daemonLockPath('acme', w.root, w.home);
    expect(lstatSync(store).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(store, 'send')).mode & 0o777).toBe(0o700);
    expect(lstatSync(sockPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(lockPath).mode & 0o777).toBe(0o600);
    expect(await probeDaemonSocket(sockPath)).toBe(true);

    const second = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    expect(second.kind).toBe('already-running');
    expect(existsSync(sockPath)).toBe(true);
    expect(await probeDaemonSocket(sockPath)).toBe(true);

    expect(await stopSendDaemon('acme', w.root, w.home)).toBe(true);
    expect(existsSync(sockPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('reclaims stale daemon.lock when recorded PID is dead (ESRCH) and removes stale socket file', async () => {
    const w = setupWorld();
    const host = makeHost(w);
    const store = storePath('acme', w.root, w.home);
    mkdirSync(join(store, 'send'), { recursive: true, mode: 0o700 });
    const lockPath = daemonLockPath('acme', w.root, w.home);
    writeFileSync(lockPath, `${JSON.stringify({ pid: 999_999 })}\n`, { mode: 0o600 });

    const started = await startSendDaemon({
      root: w.root,
      dir: w.dir,
      team: w.team,
      host,
      alive: (pid) => pid === process.pid,
    });
    expect(started.kind).toBe('serving');
    if (started.kind === 'serving') {
      handles.push(started.handle);
    }
  });

  test('refuses to start when the send directory or lock path is a symlink', async () => {
    const w = setupWorld();
    const host = makeHost(w);
    const store = storePath('acme', w.root, w.home);
    mkdirSync(store, { recursive: true, mode: 0o700 });
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(store, 'send'));

    const res = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    expect(res.kind).toBe('bind-failed');
  });
});

function ownerIo(root: string) {
  return testIo(root, { kind: 'owner' });
}

describe('per-seat FIFO queue and concurrent sends', () => {
  test('two concurrent sends to the same seat serialize in FIFO order without seat-lock refusal', async () => {
    const w = setupWorld();
    const events: string[] = [];
    let releaseFirstTurn: (() => void) | null = null;
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });

    let callCount = 0;
    let inSubmission = false;
    const host = makeHost(w, {
      native: {
        typeText: (_session, _pane, text) => {
          events.push(`type:${text}`);
          return true;
        },
        pressEnter: () => {
          callCount++;
          inSubmission = true;
          events.push(`enter:${String(callCount)}`);
          return true;
        },
        status: () => {
          if (inSubmission) {
            inSubmission = false;
            return 'working';
          }
          return 'idle';
        },
        wait: async () => {
          if (callCount === 0 && releaseFirstTurn) {
            await firstTurnGate;
          }
        },
      },
    });

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io1 = ownerIo(w.root);
    const io2 = ownerIo(w.root);
    const p1 = runSend(['native', 'first message'], io1, host);
    await new Promise((r) => setTimeout(r, 15));
    const p2 = runSend(['native', 'second message'], io2, host);
    await new Promise((r) => setTimeout(r, 10));
    releaseFirstTurn!();

    const [c1, c2] = await Promise.all([p1, p2]);
    expect(c1).toBe(0);
    expect(c2).toBe(0);
    expect(io1.out).toBe('team acme, session "acme"\nnative: delivered\n');
    expect(io2.out).toBe('team acme, session "acme"\nnative: delivered\n');

    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (!hist.ok) return;
    expect(hist.entries.map((e) => ({ body: e.body, outcome: e.outcome }))).toEqual([
      { body: filed('first message'), outcome: 'delivered' },
      { body: filed('second message'), outcome: 'delivered' },
    ]);

    const drops = daemonDropDir('acme', w.root, w.home, 'acme', 'native');
    const dropFiles = readdirSync(drops);
    expect(dropFiles.length).toBe(2);
    for (const file of dropFiles) {
      expect(lstatSync(join(drops, file)).mode & 0o777).toBe(0o600);
    }
    const logContent = readFileSync(join(w.dir, LOG_FILE), 'utf8');
    expect(logContent).not.toContain('first message');
    expect(logContent).not.toContain('second message');
  });

  test('concurrent sends to two different seats run in parallel', async () => {
    const w = setupWorld();
    const active = new Set<string>();
    const entered = new Set<string>();
    let sawBothActive = false;

    const host = makeHost(w, {
      native: {
        typeText: (_session, pane) => {
          active.add(pane);
          if (active.size === 2) sawBothActive = true;
          return true;
        },
        pressEnter: (_session, pane) => {
          active.delete(pane);
          entered.add(pane);
          return true;
        },
        status: (_session, pane) => (entered.has(pane) ? 'working' : 'idle'),
        wait: async () => {
          await new Promise((r) => setTimeout(r, 15));
        },
      },
    });

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const [c1, c2] = await Promise.all([
      runSend(['lead', 'for lead'], ownerIo(w.root), host),
      runSend(['native', 'for native'], ownerIo(w.root), host),
    ]);
    expect(c1).toBe(0);
    expect(c2).toBe(0);
    expect(sawBothActive).toBe(true);
  });

  test('enforces MAX_QUEUE_DEPTH per seat and returns held when the queue is full', async () => {
    const w = setupWorld();
    let blocked = true;
    let unblock: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      unblock = r;
    });
    let inSub = false;

    const host = makeHost(w, {
      native: {
        typeText: () => true,
        pressEnter: () => {
          inSub = true;
          return true;
        },
        status: () => {
          if (inSub) {
            inSub = false;
            return 'working';
          }
          return 'idle';
        },
        wait: async () => {
          if (blocked) await gate;
        },
      },
    });

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    // 1 active + MAX_QUEUE_DEPTH queued fills the queue.
    const pending: Promise<number>[] = [];
    for (let i = 0; i < MAX_QUEUE_DEPTH + 1; i++) {
      pending.push(runSend(['native', `msg-${String(i)}`], ownerIo(w.root), host));
    }
    await new Promise((r) => setTimeout(r, 40));

    const overIo = ownerIo(w.root);
    const overCode = await runSend(['native', 'overflow'], overIo, host);
    expect(overCode).toBe(1);
    expect(overIo.err).toContain('held');
    expect(overIo.err).toContain(`send queue is full (${String(MAX_QUEUE_DEPTH)} messages waiting)`);

    blocked = false;
    unblock!();
    await Promise.all(pending);
  });
});

describe('working seat retry and seat-lock coexistence', () => {
  test('waits while seat is working and delivers once seat returns to idle', async () => {
    const w = setupWorld();
    let polls = 0;
    let entered = false;

    const host = makeHost(w, {
      deliverWaitMs: 200,
      pollReadyMs: 5,
      native: {
        typeText: (_s, pane, text) => {
          host.typed.push({ pane, text });
          return true;
        },
        pressEnter: (_s, pane) => {
          entered = true;
          host.enters.push(pane);
          return true;
        },
        status: () => {
          if (entered) return 'working';
          polls++;
          return polls < 3 ? 'working' : 'idle';
        },
        wait: async () => {
          await new Promise((r) => setTimeout(r, 2));
        },
      },
    });

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    const code = await runSend(['native', 'deliver after turn'], io, host);
    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nnative: delivered\n');
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(host.typed.length).toBe(1);
    expect(host.enters.length).toBe(1);
  });

  test('never types into a busy working pane or returns false delivered when wait budget expires', async () => {
    const w = setupWorld();
    const host = makeHost(w, {
      deliverWaitMs: 25,
      pollReadyMs: 5,
      native: {
        typeText: (_s, pane, text) => {
          host.typed.push({ pane, text });
          return true;
        },
        pressEnter: (_s, pane) => {
          host.enters.push(pane);
          return true;
        },
        status: () => 'working',
        wait: async (ms) => {
          await new Promise((r) => setTimeout(r, ms));
        },
      },
    });

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    const code = await runSend(['native', 'do not clobber working seat', '--json'], io, host);
    expect(code).toBe(1);
    const parsed = JSON.parse(io.out.trim()) as {
      schema: { name: string; version: number };
      error: { id: string; message: string; repair: null };
    };
    expect(parsed.schema).toEqual({ name: 'team.error', version: 1 });
    expect(parsed.error.id).toBe('send.held');
    expect(parsed.error.message).toStartWith('native: held: ');
    expect(parsed.error.message).toContain('the seat is working');
    expect(parsed.error.repair).toBeNull();
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);

    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (hist.ok) {
      expect(hist.entries[0]?.outcome).toBe('held');
    }
  });

  test('waits for acquireSeatLock held by another command and delivers when released, or returns held on timeout', async () => {
    const w = setupWorld();
    const host = makeHost(w, {
      deliverWaitMs: 80,
      pollReadyMs: 5,
      native: {
        typeText: (_s, pane, text) => {
          host.typed.push({ pane, text });
          return true;
        },
        pressEnter: (_s, pane) => {
          host.enters.push(pane);
          return true;
        },
        status: () => (host.enters.length > 0 ? 'working' : 'idle'),
        wait: async (ms) => {
          await new Promise((r) => setTimeout(r, ms));
        },
      },
    });

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const externalLock = acquireSeatLock(w.dir, 'acme', 'native');
    if (!('release' in externalLock)) throw new Error('expected lock');
    setTimeout(() => externalLock.release(), 20);

    const io1 = ownerIo(w.root);
    expect(await runSend(['native', 'waited for seat lock'], io1, host)).toBe(0);
    expect(io1.out).toBe('team acme, session "acme"\nnative: delivered\n');

    // Now hold seat lock past deliverWaitMs: daemon must return held without typing.
    host.typed.length = 0;
    host.enters.length = 0;
    const heldLock = acquireSeatLock(w.dir, 'acme', 'native');
    if (!('release' in heldLock)) throw new Error('expected lock');
    try {
      const io2 = ownerIo(w.root);
      expect(await runSend(['native', 'blocked by lock'], io2, host)).toBe(1);
      expect(io2.err).toContain('held');
      expect(io2.err).toContain('another command holds the seat');
      expect(host.typed).toEqual([]);
      expect(host.enters).toEqual([]);
    } finally {
      heldLock.release();
    }
  });

  test('reclaims stale seat-lock whose holder PID is dead', async () => {
    const w = setupWorld();
    const host = makeHost(w);
    const lockFile = seatLockPath(w.dir, 'acme', 'native');
    mkdirSync(join(w.dir, 'seat-locks', 'acme'), { recursive: true });
    writeFileSync(lockFile, '999999 deadbeefcafe\n', { mode: 0o600 });

    const started = await startSendDaemon({
      root: w.root,
      dir: w.dir,
      team: w.team,
      host,
      alive: (pid) => pid === process.pid,
    });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    expect(await runSend(['native', 'reclaim stale seat-lock'], io, host)).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nnative: delivered\n');
  });
});

describe('composer read-back, unsent draft protection, dialog guard, and bare-shell check', () => {
  test('holds without typing when composer already holds an unsent user draft (both daemon and direct)', async () => {
    const w = setupWorld();
    const unsentScreen = `${RULE}\n❯ user is typing a draft here\n${RULE}`;
    const host = makeHost(w);
    host.native.paneText = () => unsentScreen;

    // 1. Direct send (no daemon)
    const directIo = ownerIo(w.root);
    expect(await runSend(['lead', 'do not clobber draft'], directIo, host)).toBe(1);
    expect(directIo.err).toContain('held: the composer already holds unsent text');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);

    // 2. Daemon send
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const daemonIo = ownerIo(w.root);
    expect(await runSend(['lead', 'do not clobber draft via daemon'], daemonIo, host)).toBe(1);
    expect(daemonIo.err).toContain('held: the composer already holds unsent text');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
  });

  test('holds without typing when screen shows a dialog before typing', async () => {
    const w = setupWorld();
    const questionScreen = [
      '☐ Scope',
      'Which file should we edit?',
      '❯ 1. src/index.ts',
      '  2. src/cli.ts',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    const host = makeHost(w);
    host.native.paneText = () => questionScreen;

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    expect(await runSend(['lead', 'hello'], io, host)).toBe(1);
    expect(io.err).toContain('held: the screen reads question');
    // The daemon's drop folder is not the one a watch scans, so its line promises no retry.
    expect(io.err).not.toContain('a running watch retries it');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);

    // The drop is on disk in the daemon's own folder, with no pending record beside it.
    const drops = daemonDropDir('acme', w.root, w.home, 'acme', 'lead');
    expect(readPending(drops)).toHaveLength(0);
    expect(readdirSync(drops).filter((name) => !name.endsWith('.pending'))).toHaveLength(1);
  });

  test('single-Enter discipline: a screen that cannot be read as a box takes the line once, and the send is taken', async () => {
    const w = setupWorld();
    const host = makeHost(w, {
      native: {
        typeText: (_s, pane, text) => {
          host.typed.push({ pane, text });
          return true;
        },
        pressEnter: (_s, pane) => {
          host.enters.push(pane);
          return true;
        },
        status: () => 'idle',
        wait: async () => {},
        paneText: () => 'plain output with no prompt chrome',
      },
    });

    // Direct: the screen is not an unsent box and never holds the trigger, so the box the
    // delivery sees is empty after Enter — the line left it, taken but not yet confirmed.
    const directIo = ownerIo(w.root);
    expect(await runSend(['lead', 'single enter direct'], directIo, host)).toBe(0);
    expect(directIo.out).toContain('lead: delivered (taken, not yet confirmed)');
    expect(directIo.err).toBe('');
    expect(host.enters.length).toBe(1);

    // Daemon
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    expect(await runSend(['lead', 'single enter test'], io, host)).toBe(0);
    expect(io.out).toContain('lead: delivered (taken, not yet confirmed)');
    expect(host.enters.length).toBe(2);
  });

  test('returns unreachable without typing when target pane is at a bare shell (both direct and daemon)', async () => {
    const w = setupWorld();
    const host = makeHost(w, {
      processInfo: () => ({ shell: 111, foreground: [111] }),
    });

    // Direct
    const directIo = ownerIo(w.root);
    expect(await runSend(['native', 'shell guard direct'], directIo, host)).toBe(1);
    expect(directIo.err).toContain('unreachable: the seat is back at its shell; nothing was typed');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);

    // Daemon
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const daemonIo = ownerIo(w.root);
    expect(await runSend(['native', 'shell guard daemon'], daemonIo, host)).toBe(1);
    expect(daemonIo.err).toContain('unreachable: the seat is back at its shell; nothing was typed');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
  });

  test('--wait is refused on both sides: the CLI never asks, and the daemon refuses an older caller', async () => {
    const w = setupWorld();
    writeFileSync(join(w.sockets, '222.sock'), '');
    // A deliver that would prove a dial: it counts the attempt and throws, so a swallow
    // somewhere on the path still leaves the count behind.
    let dialed = 0;
    const host = makeHost(w, {
      deliver: async () => {
        dialed += 1;
        throw new Error('the socket was dialed');
      },
    });

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    // The CLI's own --wait refuses before the daemon is ever asked.
    const io = ownerIo(w.root);
    const code = await runSend(['lead', 'ping over socket', '--wait'], io, host);
    expect(code).toBe(1);
    expect(io.err).toContain('needs the native leg');

    // An older CLI that still asks the daemon for a waited send gets the same refusal from the
    // daemon's own gate, and the daemon dials nothing either.
    const asked = await requestDaemon(started.handle.socketPath, {
      v: 1,
      op: 'send',
      from: 'owner',
      to: 'lead',
      body: 'from an older caller',
      wait: true,
      timeout_s: 1,
    });
    const refused = asked && 'outcome' in asked ? asked : null;
    expect(refused?.outcome).toBe('refused');
    expect(refused && 'detail' in refused ? refused.detail : '').toContain('needs the native leg');
    expect(dialed).toBe(0);

    // Neither refusal writes a history line: nothing was sent.
    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (!hist.ok) return;
    expect(hist.entries).toEqual([]);
  });

  test('the daemon refuses a stopped seat for a caller that reaches it directly, and starts no worker', async () => {
    const w = setupWorld();
    const file = join(w.dir, 'team.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('  - role: reviewer', '  - role: reviewer\n    stopped: true'));
    const loaded = loadTeamFile(w.root, { home: w.home });
    if (!loaded.ok) throw new Error('fixture team.yaml failed to reload');
    const host = makeHost(w);

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: loaded.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    // An older caller that still asks the daemon directly is refused at the queue, and no leg runs.
    const asked = await requestDaemon(started.handle.socketPath, {
      v: 1,
      op: 'send',
      from: 'owner',
      to: 'native',
      body: 'from an older caller',
    });
    const refused = asked && 'outcome' in asked ? asked : null;
    expect(refused?.outcome).toBe('refused');
    expect(refused && 'detail' in refused ? refused.detail : '').toBe('native is stopped');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (!hist.ok) return;
    expect(hist.entries).toEqual([]);
  });

  test("the daemon refuses a human's pane for a caller that reaches it directly, and starts no worker", async () => {
    const w = setupWorld();
    const file = join(w.dir, 'team.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('  - role: reviewer', '  - role: reviewer\n    human: true'));
    const loaded = loadTeamFile(w.root, { home: w.home });
    if (!loaded.ok) throw new Error('fixture team.yaml failed to reload');
    const host = makeHost(w);

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: loaded.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    // The CLI's walk keeps its typing legs out for a human seat before the daemon is asked; a
    // caller that reaches the daemon directly is refused at the queue, and no leg runs.
    const asked = await requestDaemon(started.handle.socketPath, {
      v: 1,
      op: 'send',
      from: 'owner',
      to: 'native',
      body: 'for a person to read',
    });
    const refused = asked && 'outcome' in asked ? asked : null;
    expect(refused?.outcome).toBe('refused');
    expect(refused && 'detail' in refused ? refused.detail : '').toBe("native: the pane is a human's, and nothing is typed into it");
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (!hist.ok) return;
    expect(hist.entries).toEqual([]);
  });

  test('trigger points at state-folder drop path when delivered through the daemon', async () => {
    const w = setupWorld();
    const host = makeHost(w);
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    expect(await runSend(['native', 'stored in state drops'], io, host)).toBe(0);
    expect(host.typed.length).toBe(1);
    const drops = daemonDropDir('acme', w.root, w.home, 'acme', 'native');
    const files = readdirSync(drops);
    expect(files.length).toBe(1);
    const dropFile = join(drops, files[0]!);
    expect(host.typed[0]?.text ?? null).toBe(triggerLine(dropFile));
    expect(readFileSync(dropFile, 'utf8')).toBe(filed('stored in state drops'));
  });

  test('refuses cross-session and non-orchestrator requests, and recovers cleanly if a throw occurs mid-delivery', async () => {
    const w = setupWorld();
    let shouldThrow = true;
    const host = makeHost(w, {
      native: {
        typeText: (_s, pane, text) => {
          if (shouldThrow) {
            shouldThrow = false;
            throw new Error('simulated mid-delivery crash');
          }
          host.typed.push({ pane, text });
          return true;
        },
        pressEnter: (_s, pane) => {
          host.enters.push(pane);
          return true;
        },
        status: () => (host.enters.length > 0 ? 'working' : 'idle'),
        wait: async () => {},
      },
    });

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const crossSession = await requestDaemon(started.handle.socketPath, {
      v: 1,
      op: 'send',
      session: 'other-session',
      from: 'owner',
      to: 'helper',
      body: 'wrong session',
    });
    expect(crossSession && 'outcome' in crossSession ? crossSession.outcome : null).toBe('refused');

    const workerSend = await requestDaemon(started.handle.socketPath, {
      v: 1,
      op: 'send',
      from: 'helper',
      to: 'native',
      body: 'worker cannot send',
    });
    expect(workerSend && 'outcome' in workerSend ? workerSend.outcome : null).toBe('refused');

    // First send throws inside typeText: Enter is never pressed, seat lock is released, and next send succeeds
    const io1 = ownerIo(w.root);
    expect(await runSend(['native', 'crash mid delivery'], io1, host)).toBe(1);
    expect(host.enters).toEqual([]);

    const io2 = ownerIo(w.root);
    expect(await runSend(['native', 'recovers cleanly'], io2, host)).toBe(0);
    expect(io2.out).toBe('team acme, session "acme"\nnative: delivered\n');
  });

  test('a nickname sent through the daemon keeps the spec and the id it resolved to in history', async () => {
    const w = setupWorld();
    // The lead seat carries a human name, and the registry holds it: the daemon's own history
    // line must keep both what the caller wrote and the record it reached.
    const file = join(w.dir, 'team.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('    launch: claude\n  - role: implementer', '    launch: claude\n    nickname: zeus\n  - role: implementer'));
    const loaded = loadTeamFile(w.root, { home: w.home });
    if (!loaded.ok) throw new Error('fixture team.yaml failed to reload with the nickname');
    const id = teamIdOf(w.root);
    const lead = registerAgent(w.home, {
      name: 'lead',
      signing: { model: 'Test', version: '1', role: 'coordinator' },
      lab: 'test-lab',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: id, seat: 'lead', session: 'acme', pane: 'pane-lead', address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'up',
    });
    upsertTeam(w.home, id, {
      project: 'acme',
      entity: 'acme',
      session: 'acme',
      root: w.root,
      lobby: lobbyDir(w.home),
      roster: [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true, nickname: 'zeus' }],
      lifecycle: 'running',
    });
    const host = makeHost(w);
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: loaded.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    expect(await runSend(['zeus', 'by the human name'], io, host)).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: delivered\n');

    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (!hist.ok) return;
    expect(hist.entries).toEqual([
      expect.objectContaining({ to: 'lead', spec: 'zeus', resolved: lead.id, outcome: 'delivered' }),
    ]);
  });
});

