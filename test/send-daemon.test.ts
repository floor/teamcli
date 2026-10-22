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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { acquireSeatLock, seatLockPath } from '../src/launch/seat-lock.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { readMessage } from '../src/mcp/inbox.ts';
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
import { signReceiptPayload } from '../src/send/record.ts';
import { LOG_FILE, readState } from '../src/state.ts';
import { storePath } from '../src/store/store.ts';
import { filed } from './send-native-fixtures.ts';
import { claudeBox, testIo } from './helpers.ts';

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

/** Waits for a daemon-side delivery to land: a queued send is answered before its turn. */
async function until(predicate: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out waiting for the delivery');
    await new Promise((r) => setTimeout(r, 10));
  }
}

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
# These scenes walk the typed leg: the inbox is tried and skipped for want of a listener, then
# the trigger line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`;
}

function setupWorld() {
  // `/tmp` rather than the platform temp folder: the fixture's paths sit inside the wake line,
  // and the measured 200-character ceiling has room for the sender only on the short base.
  base = realpathSync(mkdtempSync(join('/tmp', 'team-send-daemon-')));
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

describe('the hosted send socket and its durable copy, through the relay package', () => {
  /** One raw line to the daemon socket, and the parsed answer line. */
  function rawRequest(socketPath: string, line: string): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const socket = connect({ path: socketPath });
      let buffer = '';
      let settled = false;
      const finish = (answer: Record<string, unknown> | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(answer);
      };
      const timer = setTimeout(() => finish(null), 5_000);
      socket.on('error', () => finish(null));
      socket.on('close', () => finish(null));
      socket.on('connect', () => socket.write(`${line}\n`));
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        try {
          finish(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
        } catch {
          finish(null);
        }
      });
    });
  }

  test('frames through the relay host with the same refusal bytes, and a body past the machine limit still lands', async () => {
    const w = setupWorld();
    const host = makeHost(w);
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);
    const sock = started.handle.socketPath;

    const refused = { v: 1, ok: false, id: null, seat: '', outcome: 'refused', detail: 'invalid daemon request' };
    expect(await rawRequest(sock, 'this is not json')).toEqual(refused);
    // An unknown op used to leave the caller waiting for its own deadline; the framing host
    // answers it with the same refusal a malformed line gets.
    expect(await rawRequest(sock, JSON.stringify({ v: 1, op: 'nonsense' }))).toEqual(refused);

    // The send request carries the message body, which is written to a drop and never typed.
    // This socket carried no measured frame limit, so a body past the machine protocol's
    // 65,536 characters is still accepted, exactly as it was before the framing host.
    const big = 'x'.repeat(70_000);
    const asked = await requestDaemon(sock, { v: 1, op: 'send', id: 'big-body', from: 'owner', to: 'native', body: big });
    expect(asked && 'outcome' in asked ? asked.outcome : null).toBe('delivered');
    expect(host.typed.length).toBe(1);
    expect(readFileSync(join(daemonDropDir('acme', w.root, w.home, 'acme', 'native'), 'big-body'), 'utf8')).toBe(big);
  });

  test('the drop is the relay durable write: a different holder is refused and left untouched, the same bytes are reused', async () => {
    const w = setupWorld();
    const host = makeHost(w);
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);
    const sock = started.handle.socketPath;

    const drops = daemonDropDir('acme', w.root, w.home, 'acme', 'native');
    mkdirSync(drops, { recursive: true, mode: 0o700 });
    const held = join(drops, 'held-id');
    writeFileSync(held, 'an earlier holder\n', { mode: 0o600 });

    const refused = await requestDaemon(sock, { v: 1, op: 'send', id: 'held-id', from: 'owner', to: 'native', body: 'a different body' });
    expect(refused && 'outcome' in refused ? refused.outcome : null).toBe('refused');
    expect(refused && 'detail' in refused ? refused.detail : '').toBe('native: the drop file could not be written; nothing was typed');
    expect(readFileSync(held, 'utf8')).toBe('an earlier holder\n');
    expect(host.typed).toEqual([]);

    // The same bytes at the name are this message's copy: the write is reused and the delivery
    // proceeds, rather than being refused as a different holder.
    const samePath = join(drops, 'same-id');
    writeFileSync(samePath, 'the same body', { mode: 0o600 });
    const same = await requestDaemon(sock, { v: 1, op: 'send', id: 'same-id', from: 'owner', to: 'native', body: 'the same body' });
    expect(same && 'outcome' in same ? same.outcome : null).toBe('delivered');
    expect(host.typed.length).toBe(1);
    expect(readdirSync(drops).sort()).toEqual(['held-id', 'same-id']);
    expect(readFileSync(samePath, 'utf8')).toBe('the same body');
  });
});

function ownerIo(root: string) {
  return testIo(root, { kind: 'owner' });
}

const SEAT_ID = 'seat_0123456789ab';
const BINDING = 'prs_0123456789ab';
/** The daemon reads the presence store itself, so a scene that exercises the last-mile guard
 *  writes the daemon's own projection shape and the seat record that fences it. */
function writePresence(w: ReturnType<typeof setupWorld>, seat: string, state: 'working' | 'idle'): void {
  const since = '2026-10-14T15:50:00.000Z';
  const observedAt = '2026-10-14T15:51:00.000Z';
  const seatDir = join(w.dir, 'presence', 'acme', seat);
  mkdirSync(seatDir, { recursive: true });
  writeFileSync(join(seatDir, 'current.json'), `${JSON.stringify({
    v: 1,
    seq: 7,
    id: `${since}-a1b2c3d4`,
    state,
    source: 'runtime-hook',
    event: state === 'working' ? 'turn-start' : 'turn-end',
    binding: BINDING,
    since,
    observedAt,
  })}\n`);
  const stored = readState(w.dir);
  const session = stored.sessions.acme ?? { seats: {}, worktrees: {} };
  session.seats[seat] = {
    ...(session.seats[seat] ?? {}),
    stage: 'ready',
    id: SEAT_ID,
    presence_binding: BINDING,
    presence_applied: { seat_id: SEAT_ID, binding: BINDING, seq: 7, applied_at: observedAt },
    last_active: since,
  };
  writeFileSync(
    join(w.dir, 'team.state.json'),
    `${JSON.stringify({ ...stored, format: 1, sessions: { ...stored.sessions, acme: session } })}\n`,
  );
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
    expect(io1.out).toBe('team acme, session "acme"\nnative: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
    // The second send reached the daemon while the first was still being delivered: it is
    // answered at once with the queue's word and the message id, and delivered behind it.
    expect(io2.out).toMatch(/^team acme, session "acme"\nnative: queued \(receiver busy\) \(typed, 0 ms; id [0-9a-f-]+\)\n$/);
    const queuedId = /id ([0-9a-f-]+)\)\n$/.exec(io2.out)?.[1] ?? '';
    expect(queuedId).not.toBe('');

    await until(() => {
      const h = readHistory('acme', w.root, w.home);
      return h.ok && h.entries.length === 2;
    });
    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (!hist.ok) return;
    expect(hist.entries.map((e) => ({ body: e.body, outcome: e.outcome }))).toEqual([
      { body: filed('first message'), outcome: 'sent (unconfirmed)' },
      { body: filed('second message'), outcome: 'sent (unconfirmed)' },
    ]);
    expect(hist.entries[0]?.id).toBeTruthy();
    expect(hist.entries[1]?.id).toBe(queuedId);
    expect(hist.entries[0]?.id).not.toBe(queuedId);

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

  test('two concurrent sends to a busy receiver are both accepted queued and delivered exactly once in FIFO order', async () => {
    const w = setupWorld();
    let pendingTake = 0;
    const host = makeHost(w, {
      native: {
        typeText: (_s, pane, text) => {
          host.typed.push({ pane, text });
          return true;
        },
        pressEnter: (_s, pane) => {
          host.enters.push(pane);
          pendingTake++;
          return true;
        },
        // The seat reads idle until a trigger is taken, then working for the one status read
        // that proves the submission; each delivery gets its own take.
        status: () => {
          if (pendingTake > 0) {
            pendingTake--;
            return 'working';
          }
          return 'idle';
        },
        // A real yield, as the host's own wait does: the daemon may poll this while the
        // receiver is busy, and an instantly-resolved wait would starve the event loop.
        wait: async (ms) => {
          await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
        },
      },
    });

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    // The receiver is busy before either send arrives: another command holds its seat lock.
    const busyLock = acquireSeatLock(w.dir, 'acme', 'native');
    if (!('release' in busyLock)) throw new Error('expected lock');

    const io1 = ownerIo(w.root);
    const io2 = ownerIo(w.root);
    const p1 = runSend(['native', 'first queued'], io1, host);
    await new Promise((r) => setTimeout(r, 10));
    const p2 = runSend(['native', 'second queued'], io2, host);

    const [c1, c2] = await Promise.all([p1, p2]);
    expect(c1).toBe(0);
    expect(c2).toBe(0);
    expect(io1.out).toMatch(/^team acme, session "acme"\nnative: queued \(receiver busy\) \(typed, 0 ms; id [0-9a-f-]+\)\n$/);
    expect(io2.out).toMatch(/^team acme, session "acme"\nnative: queued \(receiver busy\) \(typed, 0 ms; id [0-9a-f-]+\)\n$/);
    const id1 = /id ([0-9a-f-]+)\)\n$/.exec(io1.out)?.[1] ?? '';
    const id2 = /id ([0-9a-f-]+)\)\n$/.exec(io2.out)?.[1] ?? '';
    expect(id1).not.toBe('');
    expect(id2).not.toBe('');
    expect(id1).not.toBe(id2);

    // Both signed copies were stored in the transport tree before either was delivered, and
    // nothing was typed while the receiver was busy.
    const staged = join(w.dir, 'send-drops', 'acme', 'native');
    expect(existsSync(join(staged, id1))).toBe(true);
    expect(existsSync(join(staged, id2))).toBe(true);
    expect(lstatSync(join(staged, id1)).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(staged, id2)).mode & 0o777).toBe(0o600);
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);

    busyLock.release();
    await until(() => host.enters.length === 2);
    await until(() => {
      const h = readHistory('acme', w.root, w.home);
      return h.ok && h.entries.length === 2;
    });
    // One delivery each, in the order the sends reached the queue: the ids in the senders'
    // answers are the ids on the two receipts.
    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (!hist.ok) return;
    expect(hist.entries.map((e) => ({ id: e.id, body: e.body, outcome: e.outcome }))).toEqual([
      { id: id1, body: filed('first queued'), outcome: 'sent (unconfirmed)' },
      { id: id2, body: filed('second queued'), outcome: 'sent (unconfirmed)' },
    ]);
    expect(new Set(hist.entries.map((e) => e.id)).size).toBe(2);
    expect(host.typed.length).toBe(2);
    expect(host.enters.length).toBe(2);
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
    // The seat is in a turn at acceptance: the send is answered at once as queued and waits in
    // the seat's FIFO for the turn to end, instead of spending the caller's wait budget.
    expect(io.out).toMatch(/^team acme, session "acme"\nnative: queued \(receiver busy\) \(typed, 0 ms; id [0-9a-f-]+\)\n$/);
    const queuedId = /id ([0-9a-f-]+)\)/.exec(io.out)?.[1];
    if (queuedId === undefined) throw new Error('no queued id in the answer');
    await until(() => host.enters.length === 1);
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(host.typed.length).toBe(1);
    expect(host.enters.length).toBe(1);
    // The Enter is observed inside the worker's delivery, before it has verified the take and
    // appended its history line: on a loaded host the poll above can return in that window, so
    // wait for this send's own record — the delivery's last step — before reading its outcome.
    // Waiting for its presence, not for the expected outcome, still fails on a wrong outcome.
    await until(() => {
      const h = readHistory('acme', w.root, w.home);
      return h.ok && h.entries.some((e) => e.id === queuedId);
    });
    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (hist.ok) expect(hist.entries[0]?.outcome).toBe('sent (unconfirmed)');
  });

  test('answers queued at once and types nothing into a busy pane, never a false delivered', async () => {
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
    const code = await runSend(['native', 'do not clobber working seat'], io, host);
    // Accepted, not refused: busy is the queue's word, and the line carries the id.
    expect(code).toBe(0);
    expect(io.out).toMatch(/^team acme, session "acme"\nnative: queued \(receiver busy\) \(typed, 0 ms; id [0-9a-f-]+\)\n$/);
    const queuedId = /id ([0-9a-f-]+)\)\n$/.exec(io.out)?.[1] ?? '';
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);

    // The seat never becomes free. Closing the daemon ends the queued wait with a held receipt
    // under the same id, so the send is neither lost nor reported as delivered.
    await started.handle.close();
    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (hist.ok) {
      expect(hist.entries[0]?.id).toBe(queuedId);
      expect(hist.entries[0]?.outcome).toBe('held');
    }
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
  });

  // The daemon's last mile reads the store itself. A projected turn this process did not see
  // in herdr's status still holds the drop: the runtime's own record outranks the screen.
  test('holds the drop when the native proof says a turn is running, even with an idle screen', async () => {
    const w = setupWorld();
    writePresence(w, 'native', 'working');
    const host = makeHost(w);
    const started = await startSendDaemon({
      root: w.root,
      dir: w.dir,
      team: w.team,
      host,
      presenceChannelHealthy: () => true,
    });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    const code = await runSend(['native', 'do not clobber the projected turn', '--json'], io, host);
    expect(code).toBe(1);
    const parsed = JSON.parse(io.out.trim()) as { error: { id: string; message: string } };
    expect(parsed.error.id).toBe('send.held');
    expect(parsed.error.message).toContain("the seat's native presence does not allow typing (working: the runtime reports a turn running)");
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
  });

  test('delivers on a qualified native idle when the caller provides the channel proof', async () => {
    const w = setupWorld();
    writePresence(w, 'native', 'idle');
    const host = makeHost(w);
    const started = await startSendDaemon({
      root: w.root,
      dir: w.dir,
      team: w.team,
      host,
      presenceChannelHealthy: () => true,
    });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    const code = await runSend(['native', 'the projected turn ended'], io, host);
    expect(code).toBe(0);
    expect(io.out).toContain('native: sent (unconfirmed)');
    expect(host.typed).toHaveLength(1);
    expect(host.enters).toHaveLength(1);
  });

  // The contract makes an unproven channel a hold, never a fallback: without a provider the
  // daemon cannot qualify the projection, so it does not type.
  test('holds a native idle projection when no channel proof is provided', async () => {
    const w = setupWorld();
    writePresence(w, 'native', 'idle');
    const host = makeHost(w);
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    const code = await runSend(['native', 'unproven channel', '--json'], io, host);
    expect(code).toBe(1);
    const parsed = JSON.parse(io.out.trim()) as { error: { id: string; message: string } };
    expect(parsed.error.id).toBe('send.held');
    expect(parsed.error.message).toContain('the presence channel is not known healthy this pass');
    expect(host.typed).toEqual([]);
  });

  test('queues behind a seat lock held by another command and delivers once it is released', async () => {
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

    const io1 = ownerIo(w.root);
    expect(await runSend(['native', 'waited for seat lock'], io1, host)).toBe(0);
    // The held lock is the queue's word: the sender is answered now, and the delivery follows
    // once the other command lets go.
    expect(io1.out).toMatch(/^team acme, session "acme"\nnative: queued \(receiver busy\) \(typed, 0 ms; id [0-9a-f-]+\)\n$/);
    expect(host.typed).toEqual([]);
    externalLock.release();
    await until(() => host.enters.length === 1);
    expect(host.typed.length).toBe(1);
    // The delivery has ended and the worker has let the seat go before the next hold.
    await until(() => {
      const h = readHistory('acme', w.root, w.home);
      return h.ok && h.entries.length === 1;
    });
    await until(() => {
      const probe = acquireSeatLock(w.dir, 'acme', 'native');
      if (!('release' in probe)) return false;
      probe.release();
      return true;
    });

    // Now hold the seat lock: the send is still accepted, queued behind the lock, and no leg
    // is typed while the other command holds the seat. Releasing it delivers exactly once.
    host.typed.length = 0;
    host.enters.length = 0;
    const heldLock = acquireSeatLock(w.dir, 'acme', 'native');
    if (!('release' in heldLock)) throw new Error('expected lock');
    const io2 = ownerIo(w.root);
    try {
      expect(await runSend(['native', 'blocked by lock'], io2, host)).toBe(0);
      expect(io2.out).toMatch(/^team acme, session "acme"\nnative: queued \(receiver busy\) \(typed, 0 ms; id [0-9a-f-]+\)\n$/);
      expect(host.typed).toEqual([]);
      expect(host.enters).toEqual([]);
    } finally {
      heldLock.release();
    }
    await until(() => host.enters.length === 1);
    await until(() => {
      const h = readHistory('acme', w.root, w.home);
      return h.ok && h.entries.length === 2;
    });
    expect(host.typed.length).toBe(1);
    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (hist.ok) expect(hist.entries.map((e) => e.outcome)).toEqual(['sent (unconfirmed)', 'sent (unconfirmed)']);
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
    expect(io.out).toBe('team acme, session "acme"\nnative: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
  });

  test('a non-queued item reaching delivery while the recipient seat lock is held queues at delivery with preserved id, no premature success, and promotes to delivered (read) on receipt while keeping compose seats out of queue acceptance', async () => {
    const w = setupWorld();
    let heldAtDelivery: { release(): void } | null = null;
    let entered = false;
    let processReads = 0;
    let currentMsgId = '';

    const host = makeHost(w, {
      deliverWaitMs: 40,
      pollReadyMs: 5,
      processInfo: () => {
        processReads++;
        // The seat lock is free when enqueueSend checks receiverBusyOf, then taken by another
        // command while executeQueuedSend is preparing delivery (during the first processInfo read).
        if (processReads === 1 && heldAtDelivery === null) {
          const lock = acquireSeatLock(w.dir, 'acme', 'native');
          if ('release' in lock) heldAtDelivery = lock;
        }
        return { shell: 100, foreground: [200] };
      },
      native: {
        typeText: (_s, pane, text) => {
          host.typed.push({ pane, text });
          return true;
        },
        pressEnter: (_s, pane) => {
          entered = true;
          host.enters.push(pane);
          if (currentMsgId !== '') {
            const dropDir = join(w.dir, 'send-drops', 'acme', 'native');
            const read = readMessage(
              { dropDir, root: realpathSync(w.root), seat: 'native', session: 'acme' },
              currentMsgId,
              w.home,
            );
            expect(read.ok).toBe(true);
          }
          return true;
        },
        status: () => (entered ? 'working' : 'idle'),
        wait: async (ms) => {
          await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
        },
      },
    });

    const teamWithCompose = {
      ...w.team,
      seats: [
        ...w.team.seats,
        {
          ...w.team.seats[0]!,
          name: 'compose',
          cli: 'jules',
        },
      ],
    };
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: teamWithCompose, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    const code = await runSend(['native', 'queued at delivery seam'], io, host);
    expect(code).toBe(0);
    expect(io.out).toMatch(/^team acme, session "acme"\nnative: queued \(receiver busy\) \(typed, 0 ms; id [0-9a-f-]+\)\n$/);
    const queuedId = /id ([0-9a-f-]+)\)\n$/.exec(io.out)?.[1] ?? '';
    expect(queuedId).not.toBe('');
    currentMsgId = queuedId;

    // While the recipient seat lock remains held, nothing was typed and no history line claims delivery.
    expect(heldAtDelivery).not.toBeNull();
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    const beforeRelease = readHistory('acme', w.root, w.home);
    if (beforeRelease.ok) {
      expect(beforeRelease.entries).toEqual([]);
    }

    // Releasing the lock lets the worker deliver the staged message once under the preserved id,
    // and the seat's signed read receipt records `delivered (read)`.
    heldAtDelivery!.release();
    await until(() => host.enters.length === 1);
    await until(() => {
      const h = readHistory('acme', w.root, w.home);
      return h.ok && h.entries.length === 1;
    });
    expect(host.typed).toHaveLength(1);
    expect(host.enters).toHaveLength(1);
    const afterRelease = readHistory('acme', w.root, w.home);
    expect(afterRelease.ok).toBe(true);
    if (afterRelease.ok) {
      expect(afterRelease.entries).toHaveLength(1);
      expect(afterRelease.entries[0]?.id).toBe(queuedId);
      expect(afterRelease.entries[0]?.outcome).toBe('delivered (read)');
      expect(afterRelease.entries[0]?.via).toBe('typed');
    }

    // A compose seat (Jules) stays out of .21 daemon queue acceptance even when its seat lock is held.
    const julesLock = acquireSeatLock(w.dir, 'acme', 'compose');
    if (!('release' in julesLock)) throw new Error('expected compose lock');
    try {
      const composeRes = await started.handle.deliver({
        v: 1,
        op: 'send',
        from: 'owner',
        to: 'compose',
        body: 'jules compose brief',
        session: 'acme',
      });
      expect(composeRes.ok).toBe(false);
      expect(composeRes.outcome).toBe('refused');
      if (composeRes.outcome === 'refused') {
        expect(composeRes.detail).toContain('compose runs jules');
      }
    } finally {
      julesLock.release();
    }
  });

  test('stages the signed copy (create-or-match) before answering queued and refuses on conflicting bytes without touching the held file or typing', async () => {
    const w = setupWorld();
    const activeDeliveredIds: string[] = [];
    let pendingTake = 0;
    const dropDir = daemonDropDir('acme', w.root, w.home, 'acme', 'native');

    const host = makeHost(w, {
      deliverWaitMs: 40,
      pollReadyMs: 5,
      native: {
        typeText: (_s, pane, text) => {
          host.typed.push({ pane, text });
          return true;
        },
        pressEnter: (_s, pane) => {
          host.enters.push(pane);
          pendingTake++;
          const nextId = activeDeliveredIds.shift();
          if (nextId) {
            const signedReceipt = signReceiptPayload(
              {
                kind: 'receipt',
                status: 'read',
                id: nextId,
                to: 'native',
                root: realpathSync(w.root),
                session: 'acme',
                at: NOW.toISOString(),
              },
              w.home,
            );
            writeFileSync(join(dropDir, `${nextId}.read.json`), `${JSON.stringify(signedReceipt)}\n`, { mode: 0o600 });
          }
          return true;
        },
        status: () => {
          if (pendingTake > 0) {
            pendingTake--;
            return 'working';
          }
          return 'idle';
        },
        wait: async (ms) => {
          await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
        },
      },
    });

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    mkdirSync(dropDir, { recursive: true, mode: 0o700 });

    // Pre-populate a matching copy (`prestage-match-id`) and a conflicting copy (`prestage-conflict-id`).
    const matchingPath = join(dropDir, 'prestage-match-id');
    writeFileSync(matchingPath, 'matching body across retries', { mode: 0o600 });
    const conflictPath = join(dropDir, 'prestage-conflict-id');
    writeFileSync(conflictPath, 'original held record that must not be overwritten', { mode: 0o600 });

    // Hold the recipient seat lock so enqueueSend takes the busy pre-stage + queued path.
    const heldLock = acquireSeatLock(w.dir, 'acme', 'native');
    if (!('release' in heldLock)) throw new Error('expected seat lock');

    try {
      // 1a. Create-on-stage before queued: a fresh id stages the signed copy on disk BEFORE answering queued.
      const createRes = await started.handle.deliver({
        v: 1,
        op: 'send',
        id: 'prestage-create-id',
        from: 'owner',
        to: 'native',
        body: 'freshly staged while busy',
        session: 'acme',
      });
      expect(createRes.ok).toBe(true);
      expect(createRes.outcome).toBe('queued');
      expect(createRes.id).toBe('prestage-create-id');

      const createdDropPath = join(dropDir, 'prestage-create-id');
      expect(existsSync(createdDropPath)).toBe(true);
      expect(readFileSync(createdDropPath, 'utf-8')).toBe('freshly staged while busy');
      expect(lstatSync(createdDropPath).mode & 0o777).toBe(0o600);

      // 1b. Match-on-stage before queued: identical bytes at an existing id succeed via create-or-match.
      const matchRes = await started.handle.deliver({
        v: 1,
        op: 'send',
        id: 'prestage-match-id',
        from: 'owner',
        to: 'native',
        body: 'matching body across retries',
        session: 'acme',
      });
      expect(matchRes.ok).toBe(true);
      expect(matchRes.outcome).toBe('queued');
      expect(matchRes.id).toBe('prestage-match-id');
      expect(readFileSync(matchingPath, 'utf-8')).toBe('matching body across retries');
      expect(lstatSync(matchingPath).mode & 0o777).toBe(0o600);

      // 2. Conflicting bytes at the id refuse BEFORE answering queued; nothing is queued or typed and the held file is unchanged.
      const conflictRes = await started.handle.deliver({
        v: 1,
        op: 'send',
        id: 'prestage-conflict-id',
        from: 'owner',
        to: 'native',
        body: 'conflicting replacement attempt',
        session: 'acme',
      });
      expect(conflictRes.ok).toBe(false);
      expect(conflictRes.outcome).toBe('refused');
      expect(conflictRes.id).toBeNull();
      if (conflictRes.outcome === 'refused') {
        expect(conflictRes.detail).toBe('native: the drop file could not be written; nothing was typed');
      }
      expect(readFileSync(conflictPath, 'utf-8')).toBe('original held record that must not be overwritten');
      expect(lstatSync(conflictPath).mode & 0o777).toBe(0o600);

      // While the lock is still held, nothing has been typed at all.
      expect(host.typed).toEqual([]);
      expect(host.enters).toEqual([]);
    } finally {
      activeDeliveredIds.push('prestage-create-id', 'prestage-match-id');
      heldLock.release();
    }

    // Releasing the lock delivers only the two valid queued messages (once each, preserving msgId and read-receipt promotion),
    // and never types the refused conflicting payload.
    await until(() => host.enters.length === 2);
    await until(() => {
      const h = readHistory('acme', w.root, w.home);
      return h.ok && h.entries.length === 2;
    });
    expect(host.typed).toHaveLength(2);
    expect(host.enters).toHaveLength(2);
    expect(host.typed.some((t: { pane: string; text: string }) => t.text.includes('prestage-conflict-id'))).toBe(false);
    expect(readFileSync(conflictPath, 'utf-8')).toBe('original held record that must not be overwritten');

    const historyAfter = readHistory('acme', w.root, w.home);
    expect(historyAfter.ok).toBe(true);
    if (historyAfter.ok) {
      expect(historyAfter.entries.map((e) => ({ id: e.id, outcome: e.outcome, via: e.via }))).toEqual([
        { id: 'prestage-create-id', outcome: 'delivered (read)', via: 'typed' },
        { id: 'prestage-match-id', outcome: 'delivered (read)', via: 'typed' },
      ]);
    }
  });
});

describe('composer read-back, unsent draft protection, dialog guard, and bare-shell check', () => {
  test('holds without typing when composer already holds an unsent user draft (both daemon and direct)', async () => {
    // This fake host carries no key surface: the box words are the fallback a delivery keeps
    // where no measured way into the box exists. The shipped queue route, which reads the
    // profile's measured keys, is the next test.
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

  test('holds a running turn whose composer holds a draft, typing nothing and keeping the draft', async () => {
    // The release's own capture of text typed while a turn runs: the classifier reads the
    // screen `working` (its caution stage runs before the composer stage), and only the
    // composer read sees the draft. The typed leg must hold, never type into it.
    const workingUnsent = readFileSync(new URL('./fixtures/claude-code/2.1.289/unsent-typing-while-running-ansi.txt', import.meta.url), 'utf8');
    const w = setupWorld();
    const host = makeHost(w);
    host.native.paneText = () => workingUnsent;

    const io = ownerIo(w.root);
    expect(await runSend(['lead', 'do not clobber the running draft'], io, host)).toBe(1);
    expect(io.err).toContain('held: the composer already holds unsent text');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    // The draft is still where the owner left it.
    expect(host.native.paneText('acme', 'pane-lead')).toBe(workingUnsent);
  });

  test('the shipped queue route copies an unsent draft, delivers, and pastes it back', async () => {
    // The real daemon host carries the measured keys; with them, the queue's delivery empties
    // the box, takes the trigger, and puts the owner's text back — the same delivery the direct
    // leg makes. The fake models the composer: a key empties it, a bracketed paste redraws it.
    const w = setupWorld();
    const host = makeHost(w);
    const draft = 'a draft for the queue';
    let box = draft;
    let sent = false;
    const keys: string[] = [];
    host.native.paneText = () => claudeBox(box);
    host.native.typeText = (_session, pane, text) => {
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      box = pasted ? pasted[1] ?? '' : text;
      host.typed.push({ pane, text });
      return true;
    };
    host.native.pressEnter = (_session, pane) => {
      host.enters.push(pane);
      box = '';
      sent = true;
      return true;
    };
    host.native.sendKey = (_session, _pane, key) => {
      keys.push(key);
      box = '';
      return true;
    };
    host.native.status = () => (sent ? 'working' : 'idle');

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    expect(await runSend(['lead', 'take the box'], io, host)).toBe(0);
    // The queue's own delivery says what became of the owner's text: the draft receipt travels
    // with the sent line, its history entry and the response, as it does on the direct leg.
    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet; the unsent text was pasted back)\n');
    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (!hist.ok) return;
    expect(hist.entries.at(-1)).toMatchObject({
      outcome: 'sent (unconfirmed)',
      via: 'typed',
      note: 'trigger taken, no read receipt yet; the unsent text was pasted back',
    });
    // claude-code's idle clear is ctrl+c; the trigger was typed, submitted, and the draft
    // redrawn by a bracketed paste, with no literal typing of the draft.
    expect(keys).toEqual(['ctrl+c']);
    expect(host.typed[host.typed.length - 1]?.text).toBe(`\x1b[200~${draft}\x1b[201~`);
    expect(box).toBe(draft);
  });

  test('delivers into a running turn whose composer is empty', async () => {
    const w = setupWorld();
    const host = makeHost(w);
    const busy = (box: string) => `✻ Thinking… (12s · esc to interrupt)\n${RULE}\n❯ ${box}\n${RULE}`;
    host.native.paneText = (_session, pane) => {
      const last = [...host.typed].reverse().find((t) => t.pane === pane);
      return busy(last && !host.enters.includes(pane) ? last.text : '');
    };

    const io = ownerIo(w.root);
    const code = await runSend(['lead', 'send into an empty working box'], io, host);
    if (code !== 0) console.log('DEBUG', JSON.stringify(io.err), JSON.stringify(host.typed.length), JSON.stringify(host.enters.length));
    expect(code).toBe(0);
    expect(io.out).toContain('lead: sent (unconfirmed) (typed, ');
    expect(io.out).toContain('trigger taken, no read receipt yet');
    expect(host.typed.length).toBe(1);
    expect(host.enters).toEqual(['pane-lead']);
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
    // delivery sees is empty after Enter — the line left it, and no read receipt followed.
    const directIo = ownerIo(w.root);
    expect(await runSend(['lead', 'single enter direct'], directIo, host)).toBe(0);
    expect(directIo.out).toContain('lead: sent (unconfirmed) (typed, ');
    expect(directIo.out).toContain('trigger taken, no read receipt yet');
    expect(directIo.err).toBe('');
    expect(host.enters.length).toBe(1);

    // Daemon
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    expect(await runSend(['lead', 'single enter test'], io, host)).toBe(0);
    expect(io.out).toContain('lead: sent (unconfirmed) (typed, ');
    expect(io.out).toContain('trigger taken, no read receipt yet');
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

  test('--wait bypasses the daemon and waits on the thread, while the daemon refuses an older caller', async () => {
    const w = setupWorld();
    writeFileSync(join(w.sockets, '222.sock'), '');
    // A deliver that would prove a dial: it counts the attempt and throws, so a swallow
    // somewhere on the path still leaves the count behind.
    let dialed = 0;
    const host = makeHost(w, {
      waitMs: 0,
      deliver: async () => {
        dialed += 1;
        throw new Error('the socket was dialed');
      },
    });

    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    // The CLI's own --wait bypasses the daemon, delivers on the typed leg, and waits on the thread.
    const io = ownerIo(w.root);
    const code = await runSend(['lead', 'ping over socket', '--wait', '--timeout', '1'], io, host);
    expect(code).toBe(1);
    expect(io.err).toBe(
      'team send: lead: timeout: sent, no reply on the thread within 1s; the thread stays open\n',
    );

    // An older CLI that still asks the daemon for a waited send gets the refusal from the
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

    // Only the CLI's timed-out thread wait wrote a history line; the daemon refusal wrote nothing.
    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (!hist.ok) return;
    expect(hist.entries.map((e) => ({ to: e.to, outcome: e.outcome, via: e.via }))).toEqual([
      { to: 'lead', outcome: 'timeout', via: 'typed' },
    ]);
  });

  test('a waited send still needs the team file’s own inbound accept for a launch this build did not write', async () => {
    // The launch declares accept itself, but with its own --settings and no generated file this
    // build did not attest it: the team file's word is still required, so the daemon refuses
    // before it opens anything and nothing is dialed.
    const w = setupWorld();
    const file = join(w.dir, 'team.yaml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        '    launch: claude\n',
        `    launch: claude --settings '{"crossSessionInbound":"accept"}'` + '\n',
      ),
    );
    const loaded = loadTeamFile(w.root, { home: w.home });
    if (!loaded.ok) throw new Error('fixture team.yaml failed to reload');
    writeFileSync(join(w.sockets, '222.sock'), '');
    const host = makeHost(w);
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: loaded.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const asked = await requestDaemon(started.handle.socketPath, {
      v: 1,
      op: 'send',
      from: 'owner',
      to: 'lead',
      body: 'no team word',
      wait: true,
      timeout_s: 1,
    });
    const refused = asked && 'outcome' in asked ? asked : null;
    expect(refused?.outcome).toBe('refused');
    expect(refused && 'detail' in refused ? refused.detail : '').toContain(
      "the receiving seat's team file does not declare inbound accept",
    );
    expect(host.frames).toEqual([]);
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
    expect(host.typed[0]?.text ?? null).toBe(
      triggerLine(dropFile, { seat: 'owner', team: 'acme', body: 'stored in state drops' }),
    );
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
    expect(io2.out).toBe('team acme, session "acme"\nnative: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
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
    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');

    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (!hist.ok) return;
    expect(hist.entries).toEqual([
      expect.objectContaining({ to: 'lead', spec: 'zeus', resolved: lead.id, outcome: 'sent (unconfirmed)' }),
    ]);
  });
});

