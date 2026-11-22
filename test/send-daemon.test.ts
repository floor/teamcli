import { NO_PANE_MESSAGING, queuedLine } from '../src/send/no-pane-messaging.ts';
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
import { withoutSendId } from './helpers/output.ts';

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
function expectKeptInBus(
  w: ReturnType<typeof setupWorld>,
  seat: string,
  body: string,
  historyMatch: { outcome: string; via?: string } = { outcome: 'queued, not woken', via: 'drop' },
): string {
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
      ...historyMatch,
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
});

describe('working seat retry and seat-lock coexistence', () => {

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

  test('no pane messaging, nothing typed and the bus inbox keeps it; was: returns unreachable without typing when target pane is at a bare shell (both direct and daemon)', async () => {
    const w = setupWorld();
    const host = makeHost(w, {
      processInfo: () => ({ shell: 111, foreground: [111] }),
    });

    // Direct
    const directIo = ownerIo(w.root);
    const retired = await runSend(['native', 'shell guard direct'], directIo, host);
    expect(await retired, directIo.err + directIo.out).toBe(1);
    expect(directIo.err + directIo.out).toContain('team send: native: not delivered: no CLI');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expectKeptInBus(w, 'native', 'shell guard direct');
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
});

