// A reply that finds the receiving seat's lock held by another command is queued, not refused:
// the signed record and its unread hint are written without that lock — the id names the file,
// the seal is idempotent, and the hint's own write is atomic and already lock-optional — and the
// seat's watcher delivers the reply when the seat is free. Every scene holds the lock with this
// very process's pid, which is a live holder by the same rule a watch child is, or plants an
// unreadable token; no real signal, pane or key is touched. The last scene follows the queue to
// its end: the release, the watcher's one typed wake, and a second pass that types nothing.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply, type ReplyHost } from '../src/commands/reply.ts';
import type { SendHost } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { acquireSeatLock, seatLockPath } from '../src/launch/seat-lock.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { readHistory } from '../src/send/history.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import type { Live } from '../src/status/compare.ts';
import type { RetrySources } from '../src/watch/retry.ts';
import { wakePath, wakeUnreadDrops } from '../src/watch/unread.ts';
import { recordAt, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T09:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const SENT = '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d';
const REPLY = '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

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
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reply-busy-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function host(patch: Partial<ReplyHost> = {}): ReplyHost {
  return { home, now: () => NOW, ...patch };
}

async function run(
  argv: string[],
  caller: Caller = { kind: 'owner' },
  patch: Partial<ReplyHost> = {},
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runReply(argv, io, host(patch));
  return { code, out: io.out, err: io.err };
}

/** A record `team send` would have written: signed, in the addressee's folder, on its thread. */
function sentTo(seat: string, id: string, fields: Parameters<typeof plantRecord>[6] = {}): string {
  const from = fields.from ?? 'worker';
  const header = from === 'owner'
    ? 'from the owner — admitted by: the owner\n'
    : `from the file's seat ${from} (no registry record yet) — admitted by: a seat to its own team's orchestrator\n`;
  return plantRecord(home, root, 'acme', seat, id, `${header}\nquestion`, { at: NOW_ISO, ...fields });
}

/** The answer's signed record where the receiving seat's reader reads it. */
function answerRecord(): ReturnType<typeof recordAt> {
  return recordAt(join(recordDir(root, 'acme', 'worker'), REPLY));
}

test('a reply whose receiving seat is held by a live command is queued, not refused', async () => {
  sentTo('owner', SENT, { from: 'worker' });
  // The holder is this test's own process, alive by the same rule a watching daemon child is:
  // the token names a pid that is running and the start this process knows of itself.
  const held = acquireSeatLock(join(root, '.agents'), 'acme', 'worker');
  if (!('release' in held)) throw new Error('the fixture seat lock was already held');
  try {
    const result = await run([SENT, 'the answer'], { kind: 'owner' }, { newId: () => REPLY });
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toBe(`team acme, session "acme"\nworker: delivered (drop)\n`);
    const record = answerRecord();
    expect(record.payload.id).toBe(REPLY);
    expect(record.payload.to).toBe('worker');
    expect(record.payload.thread).toBe(SENT);
    expect(record.payload.in_reply_to).toBe(SENT);
  } finally {
    held.release();
  }
});

test('a reply whose receiving seat carries an unreadable lock is queued, not refused', async () => {
  sentTo('owner', SENT, { from: 'worker' });
  const path = seatLockPath(join(root, '.agents'), 'acme', 'worker');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'not a token\n');
  const result = await run([SENT, 'the answer'], { kind: 'owner' }, { newId: () => REPLY });
  expect(result.code).toBe(0);
  expect(answerRecord().payload.id).toBe(REPLY);
});

// ---- the queue's other end: the seat frees, the watcher delivers -------------------------

const MUSE_FIXTURES = join(import.meta.dir, 'fixtures', 'muse', '1.4.11');
const MUSE_IDLE = readFileSync(join(MUSE_FIXTURES, 'idle.txt'), 'utf8');
const MUSE_WORKING = readFileSync(join(MUSE_FIXTURES, 'working-synthetic.txt'), 'utf8');
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

function museHolding(text: string): string {
  return MUSE_IDLE.replace('❯\n', `❯ ${text}\n`);
}

/** The seat's pane, on a script its wake's own reads drive: idle, idle, the line typed back,
 *  then working after the Enter. `wait` costs nothing. */
function wakePane(): { host: TypedWakeHost; typed: string[]; enters: number } {
  const typed: string[] = [];
  let enters = 0;
  let reads = 0;
  const host: TypedWakeHost = {
    read: () => (enters > 0 ? MUSE_WORKING : reads++ < 2 ? MUSE_IDLE : museHolding(typed[typed.length - 1] ?? '')),
    type: (_pane: string, text: string) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    get enters() {
      return enters;
    },
  };
}

/** The reply walk's host: the muse seat is live on its pane, the pane writer is the script,
 *  and no socket is dialed — the team's order names the typed leg, then the drop. */
function sendHost(pane: { host: TypedWakeHost }): SendHost {
  return {
    agents: () => [{ name: 'muse', pane: 'pane-muse' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: join(base, 'sockets'),
    deliver: async () => ({ ok: false, reason: 'this scene dials no socket' }),
    native: { typeText: () => false, pressEnter: () => false, status: () => null, wait: async () => {} },
    typedWake: () => pane.host,
    now: () => NOW,
    home,
  };
}

/** The live herdr sighting the watch reads: the muse seat idle on its own pane. */
function liveSeat(): Live {
  const agents: HerdrAgent[] = [
    { name: 'muse', agent: 'muse', pane: 'pane-muse', workspace: 'first', status: 'idle', cwd: null },
    { name: 'lead', agent: 'claude', pane: 'pane-lead', workspace: 'lead', status: 'working', cwd: null },
  ];
  return { running: true, agents, workspaces: [], screens: {} };
}

/** Every history line filed under one message id, in the order they were written. */
function historyFor(id: string) {
  const read = readHistory('acme', root, home);
  if (!read.ok) throw new Error(read.reason);
  return read.entries.filter((entry) => entry.id === id);
}

test('a reply that lands while the seat is held is written, then delivered once when the seat frees', async () => {
  // The whole story of the queue: a watch child mid-wake holds the seat's lock (this test's own
  // live pid, the same rule the scenes above use), the answer is written and walked — the typed
  // leg steps aside, the record waits — and when the seat is free the watch types its one wake.
  // A second pass types nothing: the marker the first wake left is the proof it is spent.
  mkdirSync(lobbyDir(home), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'team.yaml'),
    `format: 1
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
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: muse
    cli: muse
    vendor: meta
    model: Muse Wonder Full
    version: "1"
    launch: muse
delivery_order: [typed, drop]
`,
  );
  sentTo('owner', SENT, { from: 'muse' });

  const pane = wakePane();
  const held = acquireSeatLock(join(root, '.agents'), 'acme', 'muse');
  if (!('release' in held)) throw new Error('the fixture seat lock was already held');
  let replied: { code: number; out: string; err: string };
  try {
    replied = await run([SENT, 'the answer'], { kind: 'owner' }, { newId: () => REPLY, send: sendHost(pane) });
  } finally {
    held.release();
  }

  // Never refused: the answer is on disk and its own line says the drop carries it. Nothing was
  // typed while the holder had the seat — the typed leg refused before it ever asked for the pane.
  expect(replied.code).toBe(0);
  expect(replied.err).toBe('');
  expect(replied.out).toBe(`team acme, session "acme"\nmuse: delivered (drop)\n`);
  expect(recordAt(join(recordDir(root, 'acme', 'muse'), REPLY)).payload.id).toBe(REPLY);
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  const firstLine = historyFor(REPLY)[0];
  expect(firstLine).toMatchObject({ id: REPLY, to: 'muse', via: 'drop', outcome: 'delivered' });
  expect(firstLine?.failed?.some((why) => why.includes('another command holds the seat'))).toBe(true);

  // The lock is free: the seat's watcher types its one wake for the waiting answer.
  const loaded = validateTeamFile(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8'));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const sources: RetrySources = {
    screen: () => MUSE_IDLE,
    status: () => 'idle',
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
    typedWake: (paneId, line, cli) => deliverTypedWake(pane.host, paneId, line, cli, FAST),
  };
  const pass = (at: Date) =>
    wakeUnreadDrops(
      {
        dir: join(root, '.agents'),
        session: 'acme',
        root,
        home,
        team: loaded.team,
        live: liveSeat(),
        ownPane: null,
        sources,
        now: at,
        say: () => {},
      },
      { unreadAfter: 600 },
    );

  await pass(new Date(NOW.getTime() + 15 * 60_000));
  expect(pane.typed).toHaveLength(1);
  // The wake names the answer it carries: the typed line holds the reply's own body summary.
  expect(pane.typed[0]).toContain('the answer');
  expect(pane.enters).toBe(1);
  const marker = JSON.parse(readFileSync(wakePath(join(root, '.agents', 'send-drops', 'acme', 'muse'), REPLY), 'utf8')) as {
    state?: string;
  };
  expect(marker.state).toBe('sent');
  const afterWake = historyFor(REPLY);
  expect(afterWake).toHaveLength(2);
  expect(afterWake[1]).toMatchObject({ id: REPLY, to: 'muse', via: 'typed', outcome: 'delivered (typed wake)' });

  // A later pass reads the marker the wake left: the answer is never delivered twice.
  await pass(new Date(NOW.getTime() + 16 * 60_000));
  expect(pane.typed).toHaveLength(1);
  expect(pane.enters).toBe(1);
  expect(historyFor(REPLY)).toHaveLength(2);
});
