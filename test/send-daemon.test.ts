import { NO_EVENT_ADAPTER_TOOK_IT, queuedLine } from '../src/send/no-pane-messaging.ts';
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
import { claudeBox, recordBody, testIo } from './helpers.ts';

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

  test('no pane messaging, nothing typed and the bus inbox keeps it; was: frames through the relay host with the same refusal bytes, and a body past the machine limit still lands', async () => {
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
    const retired = await requestDaemon(sock, { v: 1, op: 'send', id: 'big-body', from: 'owner', to: 'native', body: big });
    expect(retired && 'outcome' in retired ? retired.outcome : null).toBe('unreachable');
    // The durable copy is the daemon's own transport store: the whole body, past the machine
    // protocol's line limit, at 0600 in the seat's 0700 folder, waiting for its adapter.
    const copy = join(daemonDropDir('acme', w.root, w.home, 'acme', 'native'), 'big-body');
    expect(lstatSync(join(daemonDropDir('acme', w.root, w.home, 'acme', 'native'))).mode & 0o777).toBe(0o700);
    expect(lstatSync(copy).mode & 0o777).toBe(0o600);
    expect(readFileSync(copy, 'utf8')).toBe(big);
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
    // reaches the no-typing refusal, rather than being refused as a different holder.
    const samePath = join(drops, 'same-id');
    writeFileSync(samePath, 'the same body', { mode: 0o600 });
    const same = await requestDaemon(sock, { v: 1, op: 'send', id: 'same-id', from: 'owner', to: 'native', body: 'the same body' });
    // 0.5.9: the copy is reused, and the endpoint's typed delivery is refused: nothing is typed.
    expect(same && 'outcome' in same ? same.outcome : null).toBe('unreachable');
    expect(host.typed.length).toBe(0);
    expect(readdirSync(drops).sort()).toEqual(['held-id', 'same-id']);
    expect(readFileSync(samePath, 'utf8')).toBe('the same body');
  });
});

function ownerIo(root: string) {
  return testIo(root, { kind: 'owner' });
}

/** The bus record a retired typed-delivery edge leaves: one signed drop for `body` at mode 0600 in
 *  the seat's 0700 folder, the drop-leg marker, and the history line the sender was told about.
 *  These scenes' subjects were the typed leg's edges; the record is what the send keeps now. */
function expectKeptInBus(w: ReturnType<typeof setupWorld>, seat: string, body: string): string {
  const drops = join(w.dir, 'send-drops', 'acme', seat);
  expect(lstatSync(drops).mode & 0o777).toBe(0o700);
  const files = readdirSync(drops).filter((name) => !name.includes('.'));
  expect(files).toHaveLength(1);
  const id = files[0] as string;
  expect(lstatSync(join(drops, id)).mode & 0o777).toBe(0o600);
  expect(recordBody(join(drops, id))).toBe(filed(body));
  expect(JSON.parse(readFileSync(join(drops, `${id}.pending`), 'utf8'))).toMatchObject({
    id,
    from: 'owner',
    to: seat,
    body: filed(body),
    leg: 'drop',
  });
  const history = readHistory('acme', w.root, w.home);
  expect(history.ok).toBe(true);
  if (history.ok) {
    expect(history.entries).toContainEqual(expect.objectContaining({
      id,
      to: seat,
      body: filed(body),
      outcome: 'sent (unconfirmed)',
      via: 'drop',
    }));
  }
  return id;
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
  test('no pane messaging, nothing typed and the bus inbox keeps it; was: two concurrent sends to the same seat serialize in FIFO order without seat-lock refusal', async () => {
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
    const retired = runSend(['native', 'first message'], io1, host);
    expect(await retired).toBe(0);
    expect(io1.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'native', 'first message');
  });

  test('two concurrent sends to a busy receiver are both accepted queued in its bus inbox, and nothing is ever typed', async () => {
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
    expect(io1.out).toMatch(/^team acme, session "acme"\nnative: queued \(receiver busy\) \(drop, 0 ms; id [0-9a-f-]+\); queued; native reads it at its next turn \(pull-only\)\n$/);
    expect(io2.out).toMatch(/^team acme, session "acme"\nnative: queued \(receiver busy\) \(drop, 0 ms; id [0-9a-f-]+\); queued; native reads it at its next turn \(pull-only\)\n$/);
    const id1 = /id ([0-9a-f-]+)\); queued;/.exec(io1.out)?.[1] ?? '';
    const id2 = /id ([0-9a-f-]+)\); queued;/.exec(io2.out)?.[1] ?? '';
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

    // 0.5.9: releasing the lock types nothing. Both copies stay in the seat's bus inbox, where
    // an event adapter takes them; the senders were told so.
    busyLock.release();
    await new Promise((r) => setTimeout(r, 60));
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(io1.err).toContain('queued, no event adapter');
    expect(io2.err).toContain('queued, no event adapter');
    expect(existsSync(join(staged, id1))).toBe(true);
    expect(existsSync(join(staged, id2))).toBe(true);
  });

  test('concurrent sends to two different seats both land in their bus inboxes, typing nothing', async () => {
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
    // 0.5.9: neither pane is typed into; each send lands in its own seat's bus inbox at once.
    expect(sawBothActive).toBe(false);
    expect(active.size).toBe(0);
    expect(entered.size).toBe(0);
    expect(existsSync(join(w.dir, 'send-drops', 'acme', 'lead'))).toBe(true);
    expect(existsSync(join(w.dir, 'send-drops', 'acme', 'native'))).toBe(true);
  });

  test('no typing queue fills: every send past MAX_QUEUE_DEPTH still lands in the bus inbox', async () => {
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

    // 0.5.9: no send waits on a typed delivery, so no typing queue fills: the next send lands in
    // the bus inbox like the rest.
    const overIo = ownerIo(w.root);
    const overCode = await runSend(['native', 'overflow'], overIo, host);
    expect(overCode).toBe(0);
    expect(overIo.err).toContain('queued, no event adapter');
    expect(overIo.err).not.toContain('send queue is full');
    expect(inSub).toBe(false);

    blocked = false;
    unblock!();
    expect((await Promise.all(pending)).every((code) => code === 0)).toBe(true);
  });
});

describe('working seat retry and seat-lock coexistence', () => {
  test('no pane messaging, nothing typed and the bus inbox keeps it; was: waits while seat is working and delivers once seat returns to idle', async () => {
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
    const retired = await runSend(['native', 'deliver after turn'], io, host);
    expect(await retired).toBe(0);
    expect(io.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'native', 'deliver after turn');
  });

  test('no pane messaging, nothing typed and the bus inbox keeps it; was: answers queued at once and types nothing into a busy pane, never a false delivered', async () => {
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
    const retired = await runSend(['native', 'do not clobber working seat'], io, host);
    expect(await retired).toBe(0);
    expect(io.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'native', 'do not clobber working seat');
  });

  // The daemon's last mile reads the store itself. A projected turn this process did not see
  // in herdr's status still holds the drop: the runtime's own record outranks the screen.
  test('no pane messaging, nothing typed and the bus inbox keeps it; was: holds the drop when the native proof says a turn is running, even with an idle screen', async () => {
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
    const retired = await runSend(['native', 'do not clobber the projected turn', '--json'], io, host);
    expect(await retired).toBe(0);
    expect(io.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'native', 'do not clobber the projected turn');
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
    expect(host.typed).toHaveLength(0);
    expect(host.enters).toHaveLength(0);
  });

  // The contract makes an unproven channel a hold, never a fallback: without a provider the
  // daemon cannot qualify the projection, so it does not type.
  test('no pane messaging, nothing typed and the bus inbox keeps it; was: holds a native idle projection when no channel proof is provided', async () => {
    const w = setupWorld();
    writePresence(w, 'native', 'idle');
    const host = makeHost(w);
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    const retired = await runSend(['native', 'unproven channel', '--json'], io, host);
    expect(await retired).toBe(0);
    expect(io.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'native', 'unproven channel');
  });

  test('a seat lock held by another command answers queued, and its release types nothing', async () => {
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
    expect(io1.out).toMatch(/^team acme, session "acme"\nnative: queued \(receiver busy\) \(drop, 0 ms; id [0-9a-f-]+\); queued; native reads it at its next turn \(pull-only\)\n$/);
    expect(host.typed).toEqual([]);
    externalLock.release();
    // 0.5.9: the release types nothing; the copy waits in the bus inbox.
    await new Promise((r) => setTimeout(r, 60));
    expect(host.typed).toEqual([]);
    expect(io1.err).toContain('queued, no event adapter');
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
      expect(io2.out).toMatch(/^team acme, session "acme"\nnative: queued \(receiver busy\) \(drop, 0 ms; id [0-9a-f-]+\); queued; native reads it at its next turn \(pull-only\)\n$/);
      expect(host.typed).toEqual([]);
      expect(host.enters).toEqual([]);
    } finally {
      heldLock.release();
    }
    await new Promise((r) => setTimeout(r, 60));
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
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
    expect(io.out).toBe('team acme, session "acme"\nnative: sent (unconfirmed) (drop, 0 ms); queued; native reads it at its next turn (pull-only)\n');
  });

  test('no pane messaging, nothing typed and the bus inbox keeps it; was: a non-queued item reaching delivery while the recipient seat lock is held queues at delivery with preserved id, no premature success, and promotes to delivered (read) on receipt while keeping compose seats out of queue acceptance', async () => {
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
    const retired = await runSend(['native', 'queued at delivery seam'], io, host);
    expect(await retired).toBe(0);
    expect(io.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'native', 'queued at delivery seam');
    // No premature success: the one history line is the drop's own unconfirmed word, never a
    // delivered one.
    const after = readHistory('acme', w.root, w.home);
    expect(after.ok ? after.entries.filter((e) => e.outcome !== 'sent (unconfirmed)') : []).toEqual([]);
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

    // 0.5.9: releasing the lock types nothing. The two staged copies stay in the bus inbox, the
    // conflicting holder is untouched, and no history line claims a typed delivery.
    await new Promise((r) => setTimeout(r, 80));
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(existsSync(join(dropDir, 'prestage-create-id'))).toBe(true);
    expect(existsSync(join(dropDir, 'prestage-match-id'))).toBe(true);
    expect(readFileSync(conflictPath, 'utf-8')).toBe('original held record that must not be overwritten');
    const historyAfter = readHistory('acme', w.root, w.home);
    if (historyAfter.ok) expect(historyAfter.entries.filter((e) => e.outcome !== 'unreachable')).toEqual([]);
  });
});

describe('composer read-back, unsent draft protection, dialog guard, and bare-shell check', () => {
  test('no pane messaging, nothing typed and the bus inbox keeps it; was: holds without typing when composer already holds an unsent user draft (both daemon and direct)', async () => {
    // This fake host carries no key surface: the box words are the fallback a delivery keeps
    // where no measured way into the box exists. The shipped queue route, which reads the
    // profile's measured keys, is the next test.
    const w = setupWorld();
    const unsentScreen = `${RULE}\n❯ user is typing a draft here\n${RULE}`;
    const host = makeHost(w);
    host.native.paneText = () => unsentScreen;

    // 1. Direct send (no daemon)
    const directIo = ownerIo(w.root);
    const retired = await runSend(['lead', 'do not clobber draft'], directIo, host);
    expect(await retired).toBe(0);
    expect(directIo.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'lead', 'do not clobber draft');
  });

  test('no pane messaging, nothing typed and the bus inbox keeps it; was: holds a running turn whose composer holds a draft, typing nothing and keeping the draft', async () => {
    // The release's own capture of text typed while a turn runs: the classifier reads the
    // screen `working` (its caution stage runs before the composer stage), and only the
    // composer read sees the draft. The typed leg must hold, never type into it.
    const workingUnsent = readFileSync(new URL('./fixtures/claude-code/2.1.289/unsent-typing-while-running-ansi.txt', import.meta.url), 'utf8');
    const w = setupWorld();
    const host = makeHost(w);
    host.native.paneText = () => workingUnsent;

    const io = ownerIo(w.root);
    const retired = await runSend(['lead', 'do not clobber the running draft'], io, host);
    expect(await retired).toBe(0);
    expect(io.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'lead', 'do not clobber the running draft');
  });

  test('no pane messaging, nothing typed and the bus inbox keeps it; was: the shipped queue route copies an unsent draft, delivers, and pastes it back', async () => {
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
    const retired = await runSend(['lead', 'take the box'], io, host);
    expect(await retired).toBe(0);
    expect(io.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'lead', 'take the box');
  });

  test('no pane messaging, nothing typed and the bus inbox keeps it; was: delivers into a running turn whose composer is empty', async () => {
    const w = setupWorld();
    const host = makeHost(w);
    const busy = (box: string) => `✻ Thinking… (12s · esc to interrupt)\n${RULE}\n❯ ${box}\n${RULE}`;
    host.native.paneText = (_session, pane) => {
      const last = [...host.typed].reverse().find((t) => t.pane === pane);
      return busy(last && !host.enters.includes(pane) ? last.text : '');
    };

    const io = ownerIo(w.root);
    const retired = await runSend(['lead', 'send into an empty working box'], io, host);
    expect(await retired).toBe(0);
    expect(io.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'lead', 'send into an empty working box');
  });

  test('no pane messaging, nothing typed and the bus inbox keeps it; was: holds without typing when screen shows a dialog before typing', async () => {
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
    const retired = await runSend(['lead', 'hello'], io, host);
    expect(await retired).toBe(0);
    expect(io.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'lead', 'hello');
  });

  test('no pane messaging, nothing typed and the bus inbox keeps it; was: single-Enter discipline: a screen that cannot be read as a box takes the line once, and the send is taken', async () => {
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
    const retired = await runSend(['lead', 'single enter direct'], directIo, host);
    expect(await retired).toBe(0);
    expect(directIo.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'lead', 'single enter direct');
  });

  test('no pane messaging, nothing typed and the bus inbox keeps it; was: returns unreachable without typing when target pane is at a bare shell (both direct and daemon)', async () => {
    const w = setupWorld();
    const host = makeHost(w, {
      processInfo: () => ({ shell: 111, foreground: [111] }),
    });

    // Direct
    const directIo = ownerIo(w.root);
    const retired = await runSend(['native', 'shell guard direct'], directIo, host);
    expect(await retired).toBe(0);
    expect(directIo.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'native', 'shell guard direct');
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

    // The CLI's own --wait bypasses the daemon, queues in the bus inbox (nothing is typed), and
    // waits on the thread.
    const io = ownerIo(w.root);
    const code = await runSend(['lead', 'ping over socket', '--wait', '--timeout', '1'], io, host);
    expect(code).toBe(1);
    expect(io.err).toBe(
      `${queuedLine('lead', NO_EVENT_ADAPTER_TOOK_IT)}team send: lead: timeout: sent, no reply on the thread within 1s; the thread stays open\n`,
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
      { to: 'lead', outcome: 'timeout', via: 'drop' },
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

  test('no pane messaging, nothing typed and the bus inbox keeps it; was: trigger points at state-folder drop path when delivered through the daemon', async () => {
    const w = setupWorld();
    const host = makeHost(w);
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(w.root);
    const retired = await runSend(['native', 'stored in state drops'], io, host);
    expect(await retired).toBe(0);
    expect(io.err).toContain('queued, no event adapter');
    expectKeptInBus(w, 'native', 'stored in state drops');
  });

  test('refuses cross-session requests, lets a declared seat send, and types nothing however the pane would behave', async () => {
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
    // 0.5.9: a declared seat may send through the endpoint; what stops this one is the rule that
    // nothing is typed into a pane, so the endpoint's typed delivery answers unreachable.
    expect(workerSend && 'outcome' in workerSend ? workerSend.outcome : null).toBe('unreachable');

    // 0.5.9: the throwing typeText is never reached — nothing is typed — so both sends land in the
    // seat's bus inbox, and the second is not held behind a lock the first left.
    const io1 = ownerIo(w.root);
    expect(await runSend(['native', 'crash mid delivery'], io1, host)).toBe(0);
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);

    const io2 = ownerIo(w.root);
    expect(await runSend(['native', 'recovers cleanly'], io2, host)).toBe(0);
    expect(io2.out).toBe('team acme, session "acme"\nnative: sent (unconfirmed) (drop, 0 ms); queued; native reads it at its next turn (pull-only)\n');
    expect(io2.err).toContain('queued, no event adapter');
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
    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (drop, 0 ms); queued; lead reads it at its next turn (pull-only)\n');

    const hist = readHistory('acme', w.root, w.home);
    expect(hist.ok).toBe(true);
    if (!hist.ok) return;
    expect(hist.entries).toEqual([
      expect.objectContaining({ to: 'lead', spec: 'zeus', resolved: lead.id, outcome: 'sent (unconfirmed)' }),
    ]);
  });
});

