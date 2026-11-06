// Independent verification of fix/reply-queue-when-held (2680d8c90).
//
// Coverage:
// 1. Queued arm writes everything the held path must without disturbing the holder's lock:
//    - Signed reply record written at recordDir(root, session, targetSeat);
//    - Unread hint (.unread.json) written via noteUnread best-effort path;
//    - Answered message's read and replied receipts written and verified in the replier's folder;
//    - The live holder's seat lock file remains intact across runReply's finally block.
// 2. Lock state discrimination and --close guard:
//    - A stale lock token (dead pid or mismatched start token) is taken over and released cleanly;
//    - An unreadable lock token queues the reply without removing the unreadable token;
//    - `team reply <id> --close` still refuses when the closing seat's lock is held by a live
//      holder and writes no `<id>.closed.json`.
// 3. End-to-end ordered scene (queued under live lock -> lock released -> watch wakes once ->
//    second watch pass does nothing):
//    - While the seat lock is held, the reply queues on the drop leg (`delivered (drop)`), types 0
//      keys, and records 1 history entry naming `another command holds the seat` in `failed`;
//    - Once the seat lock is released, the first watch wake pass types 1 wake line, presses Enter
//      once, writes `<id>.wake` in state `sent`, and appends the 2nd history entry (`delivered
//      (typed wake)`);
//    - A subsequent watch wake pass sees `<id>.wake` and types nothing (still 1 typed line, 1
//      Enter, and 2 history entries).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { closeFile, receiptAuthOf, statusOf } from '../src/send/record.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readUnreadHint } from '../src/send/unread-hint.ts';
import type { Live } from '../src/status/compare.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import type { RetrySources } from '../src/watch/retry.ts';
import { wakePath, wakeUnreadDrops } from '../src/watch/unread.ts';
import { gitEnv, recordAt, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const MSG_ID = '11111111-2222-4333-8444-555555555555';
const REPLY_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

const TEAM_YAML = `format: 1
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
let dir: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'reply-queue-ind-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  writeFileSync(join(dir, 'team.yaml'), TEAM_YAML);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function invokeReply(
  argv: string[],
  caller: Caller = { kind: 'owner' },
  patch: Partial<ReplyHost> = {},
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runReply(argv, io, { home, now: () => NOW, ...patch });
  return { code, out: io.out, err: io.err };
}

function seedQuestion(toSeat: string, id: string, fromSeat = 'worker'): string {
  const header = fromSeat === 'owner'
    ? 'from the owner — admitted by: the owner\n'
    : `from the file's seat ${fromSeat} (no registry record yet) — admitted by: a seat to its own team's orchestrator\n`;
  return plantRecord(home, root, 'acme', toSeat, id, `${header}\nplease confirm`, {
    at: NOW_ISO,
    from: fromSeat,
  });
}

describe('1. queued arm artifacts and holder lock preservation', () => {
  test('a reply to a live-held seat writes the signed record, unread hint, and read + replied receipts without releasing the holder lock', async () => {
    seedQuestion('owner', MSG_ID, 'worker');
    const key = messageKeyOf(home);

    const held = acquireSeatLock(dir, 'acme', 'worker');
    if (!('release' in held)) throw new Error('expected initial seat lock acquisition to succeed');
    const lockFile = seatLockPath(dir, 'acme', 'worker');
    const tokenBefore = readFileSync(lockFile, 'utf8');

    try {
      const res = await invokeReply([MSG_ID, 'queued answer body', '--json'], { kind: 'owner' }, {
        newId: () => REPLY_ID,
      });
      expect(res.code).toBe(0);
      expect(res.err).toBe('');
      const parsed = JSON.parse(res.out) as {
        status: string;
        record: string;
        to: string;
        thread: string;
        in_reply_to: string;
        action_summary: string;
      };
      expect(parsed).toMatchObject({
        status: 'replied',
        record: REPLY_ID,
        to: 'worker',
        thread: MSG_ID,
        in_reply_to: MSG_ID,
        action_summary: 'worker: delivered (drop)',
      });

      // 1. Signed reply record is on disk in worker's drop folder.
      const workerFolder = recordDir(root, 'acme', 'worker');
      const replyRec = recordAt(join(workerFolder, REPLY_ID));
      expect(replyRec.payload.id).toBe(REPLY_ID);
      expect(replyRec.payload.to).toBe('worker');
      expect(replyRec.payload.from).toBe('owner');
      expect(replyRec.payload.in_reply_to).toBe(MSG_ID);
      expect(replyRec.payload.thread).toBe(MSG_ID);
      expect(replyRec.payload.body).toContain('queued answer body');

      // 2. Unread hint (.unread.json) in worker's folder recorded the queued reply via best-effort write.
      const hints = readUnreadHint(workerFolder, 'owner');
      expect(hints).toEqual([{ id: REPLY_ID, at: NOW_ISO }]);

      // 3. Both .read.json and .replied.json receipts exist and verify in the replier's folder.
      const ownerFolder = recordDir(root, 'acme', 'owner');
      const readRec = receiptAuthOf(JSON.parse(readFileSync(join(ownerFolder, `${MSG_ID}.read.json`), 'utf8')), key);
      expect(readRec.kind).toBe('ok');
      const repliedRec = receiptAuthOf(
        JSON.parse(readFileSync(join(ownerFolder, `${MSG_ID}.replied.json`), 'utf8')),
        key,
      );
      expect(repliedRec.kind).toBe('ok');
      expect(statusOf(ownerFolder, MSG_ID, { to: 'owner', root, session: 'acme' }, key)).toBe('replied');

      // 4. The live holder's seat lock file was NOT released or overwritten by runReply.
      expect(existsSync(lockFile)).toBe(true);
      expect(readFileSync(lockFile, 'utf8')).toBe(tokenBefore);
    } finally {
      held.release();
    }
    expect(existsSync(lockFile)).toBe(false);
  });
});

describe('2. lock state discrimination: stale takeover, unreadable token, and --close refusal', () => {
  test('a stale lock token (dead pid or mismatched start token) is taken over and released when runReply finishes', async () => {
    seedQuestion('owner', MSG_ID, 'worker');
    const lockFile = seatLockPath(dir, 'acme', 'worker');
    mkdirSync(dirname(lockFile), { recursive: true });
    // Plant a stale 3-field token (<pid> <nonce> <startedAtMs>) naming this process's pid with an
    // epoch-ms start time (1000) that does not match ownStart(), so acquireSeatLock treats it as stale.
    writeFileSync(lockFile, `${String(process.pid)} deadbeef0123 1000\n`);

    const res = await invokeReply([MSG_ID, 'answer after stale takeover'], { kind: 'owner' }, {
      newId: () => REPLY_ID,
    });
    expect(res.code).toBe(0);
    expect(res.out).toBe('team acme, session "acme"\nworker: delivered (drop)\n');

    const workerFolder = recordDir(root, 'acme', 'worker');
    expect(recordAt(join(workerFolder, REPLY_ID)).payload.id).toBe(REPLY_ID);
    expect(readUnreadHint(workerFolder, 'owner')).toEqual([{ id: REPLY_ID, at: NOW_ISO }]);
    // Because acquireSeatLock took over the stale token, runReply held the lock and released it in finally.
    expect(existsSync(lockFile)).toBe(false);
  });

  test('an unreadable lock token queues the reply without removing the unreadable lock file', async () => {
    seedQuestion('owner', MSG_ID, 'worker');
    const lockFile = seatLockPath(dir, 'acme', 'worker');
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, 'unreadable-token-payload\n');

    const res = await invokeReply([MSG_ID, 'answer on unreadable lock'], { kind: 'owner' }, {
      newId: () => REPLY_ID,
    });
    expect(res.code).toBe(0);
    expect(res.out).toBe('team acme, session "acme"\nworker: delivered (drop)\n');

    const workerFolder = recordDir(root, 'acme', 'worker');
    expect(recordAt(join(workerFolder, REPLY_ID)).payload.id).toBe(REPLY_ID);
    expect(readUnreadHint(workerFolder, 'owner')).toEqual([{ id: REPLY_ID, at: NOW_ISO }]);
    // Unreadable token is not owned by runReply, so finally leaves it untouched.
    expect(existsSync(lockFile)).toBe(true);
    expect(readFileSync(lockFile, 'utf8')).toBe('unreadable-token-payload\n');
  });

  test('team reply --close still refuses when the closing seat lock is held by a live holder and writes no close file', async () => {
    seedQuestion('owner', MSG_ID, 'worker');
    const held = acquireSeatLock(dir, 'acme', 'owner');
    if (!('release' in held)) throw new Error('expected owner lock acquisition to succeed');
    try {
      const res = await invokeReply([MSG_ID, '--close'], { kind: 'owner' });
      expect(res.code).toBe(1);
      expect(res.err).toContain('owner: another command holds it');
      expect(res.err).toContain('nothing was written');
      expect(existsSync(closeFile(recordDir(root, 'acme', 'owner'), MSG_ID))).toBe(false);
    } finally {
      held.release();
    }
  });
});

describe('3. end-to-end ordered scene: queued under live lock -> lock released -> watch wakes once -> second pass no-op', () => {
  const MUSE_FIXTURES = join(import.meta.dir, 'fixtures', 'muse', '1.4.11');
  const MUSE_IDLE = readFileSync(join(MUSE_FIXTURES, 'idle.txt'), 'utf8');
  const MUSE_WORKING = readFileSync(join(MUSE_FIXTURES, 'working-synthetic.txt'), 'utf8');
  const FAST_TIMING = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

  function makeScriptedMusePane(): { host: TypedWakeHost; typed: string[]; enters: number } {
    const typed: string[] = [];
    let enters = 0;
    let reads = 0;
    const host: TypedWakeHost = {
      read: () =>
        enters > 0
          ? MUSE_WORKING
          : reads++ < 2
            ? MUSE_IDLE
            : MUSE_IDLE.replace('❯\n', `❯ ${typed[typed.length - 1] ?? ''}\n`),
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

  test('a reply to a held muse seat steps over the typed leg to drop, and after lock release is woken once by watch and never woken again', async () => {
    mkdirSync(lobbyDir(home), { recursive: true });
    const museTeamYaml = `format: 1
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
`;
    writeFileSync(join(dir, 'team.yaml'), museTeamYaml);
    seedQuestion('owner', MSG_ID, 'muse');

    const pane = makeScriptedMusePane();
    const sendHost: SendHost = {
      agents: () => [{ name: 'muse', pane: 'pane-muse' }],
      processInfo: () => ({ shell: 100, foreground: [200] }),
      socketsDir: join(base, 'sockets'),
      deliver: async () => ({ ok: false, reason: 'no socket' }),
      native: { typeText: () => false, pressEnter: () => false, status: () => null, wait: async () => {} },
      typedWake: () => pane.host,
      now: () => NOW,
      home,
    };

    // Step 1: Hold muse's seat lock with this live process while replying.
    const held = acquireSeatLock(dir, 'acme', 'muse');
    if (!('release' in held)) throw new Error('expected muse seat lock acquisition to succeed');
    let replyRes: { code: number; out: string; err: string };
    try {
      replyRes = await invokeReply([MSG_ID, 'final verified answer'], { kind: 'owner' }, {
        newId: () => REPLY_ID,
        send: sendHost,
      });
      // Lock is still held by the original holder right after runReply finishes.
      expect(existsSync(seatLockPath(dir, 'acme', 'muse'))).toBe(true);
    } finally {
      held.release();
    }

    expect(replyRes.code).toBe(0);
    expect(replyRes.err).toBe('');
    expect(replyRes.out).toBe('team acme, session "acme"\nmuse: delivered (drop)\n');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);

    const museFolder = recordDir(root, 'acme', 'muse');
    expect(recordAt(join(museFolder, REPLY_ID)).payload.id).toBe(REPLY_ID);
    expect(readUnreadHint(museFolder, 'owner')).toEqual([{ id: REPLY_ID, at: NOW_ISO }]);

    const historyEntries = () => {
      const h = readHistory('acme', root, home);
      if (!h.ok) throw new Error(h.reason);
      return h.entries.filter((e) => e.id === REPLY_ID);
    };

    const afterReplyHistory = historyEntries();
    expect(afterReplyHistory).toHaveLength(1);
    expect(afterReplyHistory[0]).toMatchObject({
      id: REPLY_ID,
      to: 'muse',
      via: 'drop',
      outcome: 'delivered',
    });
    expect(afterReplyHistory[0]?.failed?.some((f) => f.includes('another command holds the seat'))).toBe(true);

    // Step 2: Seat lock is now free; run Watch Pass 1 past unreadAfter (600s).
    const validated = validateTeamFile(museTeamYaml);
    if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
    const live: Live = {
      running: true,
      agents: [
        { name: 'muse', agent: 'muse', pane: 'pane-muse', workspace: 'ws-muse', status: 'idle', cwd: null },
        { name: 'lead', agent: 'claude', pane: 'pane-lead', workspace: 'ws-lead', status: 'working', cwd: null },
      ] satisfies HerdrAgent[],
      workspaces: [],
      screens: {},
    };
    const sources: RetrySources = {
      screen: () => MUSE_IDLE,
      status: () => 'idle',
      typeText: () => false,
      pressEnter: () => false,
      sleep: async () => {},
      typedWake: (paneId, line, cli) => deliverTypedWake(pane.host, paneId, line, cli, FAST_TIMING),
    };

    const runPass = (at: Date) =>
      wakeUnreadDrops(
        {
          dir,
          session: 'acme',
          root,
          home,
          team: validated.team,
          live,
          ownPane: null,
          sources,
          now: at,
          say: () => {},
        },
        { unreadAfter: 600 },
      );

    await runPass(new Date(NOW.getTime() + 12 * 60_000));
    expect(pane.typed).toHaveLength(1);
    expect(pane.typed[0]).toContain('final verifie');
    expect(pane.enters).toBe(1);

    const wakeMarker = JSON.parse(readFileSync(wakePath(museFolder, REPLY_ID), 'utf8')) as {
      id?: string;
      state?: string;
      evidence?: string;
    };
    expect(wakeMarker).toMatchObject({
      id: REPLY_ID,
      state: 'sent',
      evidence: 'typed-wake',
    });

    const afterPass1History = historyEntries();
    expect(afterPass1History).toHaveLength(2);
    expect(afterPass1History[1]).toMatchObject({
      id: REPLY_ID,
      to: 'muse',
      via: 'typed',
      outcome: 'delivered (typed wake)',
    });

    // Step 3: Watch Pass 2 runs 1 minute later; .wake marker prevents any second wake.
    await runPass(new Date(NOW.getTime() + 13 * 60_000));
    expect(pane.typed).toHaveLength(1);
    expect(pane.enters).toBe(1);
    expect(historyEntries()).toHaveLength(2);
  });
});
