import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply } from '../src/commands/reply.ts';
import { acquireSeatLock, lockSteps, seatLockPath } from '../src/launch/seat-lock.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { markAnsweredBySend } from '../src/send/answered-by-send.ts';
import { appendHistory } from '../src/send/history.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { signRecord } from '../src/send/record.ts';
import {
  clearUnread,
  noteUnread,
  readUnreadHint,
  unreadHintPath,
} from '../src/send/unread-hint.ts';
import { emptySession, updateState } from '../src/state.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T07:00:00.000Z');
const NOW_ISO = NOW.toISOString();

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

type World = { root: string; home: string; sockets: string };

function makeWorld(): World {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-answered-indep-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  writeFileSync(
    join(dir, 'team.yaml'),
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
delivery_order: [drop]
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: helper
    label: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`,
  );
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead' };
    session.seats.worker = { stage: 'ready', pane: 'pane-worker' };
    session.seats.helper = { stage: 'ready', pane: 'pane-helper' };
  });
  return { root, home, sockets };
}

function receiptExists(w: World, seat: string, id: string): boolean {
  return existsSync(join(recordDir(w.root, 'acme', seat), `${id}.read.json`));
}

function addHistory(w: World, id: string, from: string, to: string, via: string, ts: string): void {
  appendHistory('acme', w.root, w.home, { ts, from, to, body: `body-${id}`, id, outcome: 'delivered', via });
}

describe('independent probe: bounded .unread.json index & answered-by-send verification', () => {
  test('send overhead stays bounded on a large drop tree and marks only the newest qualifying delivered-unread record', () => {
    const w = makeWorld();
    const leadDir = recordDir(w.root, 'acme', 'lead');
    const helperDir = recordDir(w.root, 'acme', 'helper');
    mkdirSync(leadDir, { recursive: true, mode: 0o700 });
    mkdirSync(helperDir, { recursive: true, mode: 0o700 });

    // Populate a large drop tree across seats so an unbounded scan would read thousands of files
    for (let i = 0; i < 2000; i++) {
      writeFileSync(join(helperDir, `decoy-${String(i).padStart(5, '0')}`), 'decoy body\n');
    }

    // 1. Oldest qualifying delivered-unread from worker (via socket)
    const idOlder = 'b1000000-0000-4000-8000-000000000001';
    plantRecord(w.home, w.root, 'acme', 'lead', idOlder, 'older question', {
      from: 'worker',
      at: '2026-11-04T06:00:00.000Z',
    });
    addHistory(w, idOlder, 'worker', 'lead', 'socket', '2026-11-04T06:00:01.000Z');

    // 2. Middle qualifying delivered-unread from worker (via channel — should be selected first)
    const idNewestQualifying = 'b1000000-0000-4000-8000-000000000002';
    plantRecord(w.home, w.root, 'acme', 'lead', idNewestQualifying, 'newest qualifying question', {
      from: 'worker',
      at: '2026-11-04T06:10:00.000Z',
    });
    addHistory(w, idNewestQualifying, 'worker', 'lead', 'channel', '2026-11-04T06:10:01.000Z');

    // 3. Newer non-qualifying message from worker (via webhook — not in DELIVERED_VIAS)
    const idWebhook = 'b1000000-0000-4000-8000-000000000003';
    plantRecord(w.home, w.root, 'acme', 'lead', idWebhook, 'webhook post', {
      from: 'worker',
      at: '2026-11-04T06:20:00.000Z',
    });
    addHistory(w, idWebhook, 'worker', 'lead', 'webhook', '2026-11-04T06:20:01.000Z');

    // 4. Newer message from worker delivered AFTER the send instant
    const idAfterSend = 'b1000000-0000-4000-8000-000000000004';
    plantRecord(w.home, w.root, 'acme', 'lead', idAfterSend, 'late delivery', {
      from: 'worker',
      at: '2026-11-04T06:30:00.000Z',
    });
    addHistory(w, idAfterSend, 'worker', 'lead', 'native', '2026-11-04T07:05:00.000Z');

    // 5. Unrelated sender's unread message
    const idOtherSender = 'b1000000-0000-4000-8000-000000000005';
    plantRecord(w.home, w.root, 'acme', 'lead', idOtherSender, 'from helper', {
      from: 'helper',
      at: '2026-11-04T06:15:00.000Z',
    });
    addHistory(w, idOtherSender, 'helper', 'lead', 'socket', '2026-11-04T06:15:01.000Z');

    expect(readUnreadHint(leadDir, 'worker').map((e) => e.id)).toEqual([
      idAfterSend,
      idWebhook,
      idNewestQualifying,
      idOlder,
    ]);

    const t0 = performance.now();
    const firstSweep = markAnsweredBySend({
      seat: 'lead',
      sender: 'worker',
      senderId: null,
      root: w.root,
      session: 'acme',
      project: 'acme',
      home: w.home,
      at: NOW_ISO,
    });
    const elapsedMs = performance.now() - t0;

    expect(firstSweep).toEqual({ kind: 'marked', id: idNewestQualifying });
    expect(elapsedMs).toBeLessThan(150);
    expect(receiptExists(w, 'lead', idNewestQualifying)).toBe(true);
    expect(receiptExists(w, 'lead', idOlder)).toBe(false);
    expect(receiptExists(w, 'lead', idWebhook)).toBe(false);
    expect(receiptExists(w, 'lead', idAfterSend)).toBe(false);
    expect(receiptExists(w, 'lead', idOtherSender)).toBe(false);

    // Clearing idNewestQualifying preserves the older unread entry in .unread.json
    expect(readUnreadHint(leadDir, 'worker').map((e) => e.id)).toEqual([
      idAfterSend,
      idWebhook,
      idOlder,
    ]);

    // A second send settles the older qualifying message next
    const secondSweep = markAnsweredBySend({
      seat: 'lead',
      sender: 'worker',
      senderId: null,
      root: w.root,
      session: 'acme',
      project: 'acme',
      home: w.home,
      at: NOW_ISO,
    });
    expect(secondSweep).toEqual({ kind: 'marked', id: idOlder });
    expect(receiptExists(w, 'lead', idOlder)).toBe(true);
  });

  test('enforces HINTS_PER_SENDER cap (16), deterministic tie-breaking on equal timestamps, and senderId verification', () => {
    const w = makeWorld();
    const leadDir = recordDir(w.root, 'acme', 'lead');

    // Stage 20 unread messages from worker with ascending timestamps
    for (let i = 1; i <= 20; i++) {
      const mm = String(i).padStart(2, '0');
      const id = `c1000000-0000-4000-8000-0000000000${mm}`;
      plantRecord(w.home, w.root, 'acme', 'lead', id, `msg-${mm}`, {
        from: 'worker',
        at: `2026-11-04T05:${mm}:00.000Z`,
      });
    }

    const hints = readUnreadHint(leadDir, 'worker');
    expect(hints.length).toBe(16);
    expect(hints[0]?.id).toBe('c1000000-0000-4000-8000-000000000020');
    expect(hints[15]?.id).toBe('c1000000-0000-4000-8000-000000000005');

    // Equal timestamp tie-breaking + senderId incarnation verification on helper
    const idAlpha = 'd1000000-0000-4000-8000-000000000001';
    const idZeta = 'd1000000-0000-4000-8000-000000000009';
    for (const id of [idAlpha, idZeta]) {
      const signed = signRecord(
        {
          kind: 'message',
          id,
          to: 'lead',
          to_id: null,
          root: realpathSync(w.root),
          session: 'acme',
          at: '2026-11-04T06:00:00.000Z',
          body: `tie-${id}`,
          from: 'helper',
          from_id: 'agent-incarnation-1',
          rule: 'the owner',
          thread: id,
        },
        w.home,
      );
      mkdirSync(leadDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(leadDir, id), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
      noteUnread(leadDir, 'helper', id, '2026-11-04T06:00:00.000Z');
      addHistory(w, id, 'helper', 'lead', 'socket', '2026-11-04T06:00:00.000Z');
    }

    expect(readUnreadHint(leadDir, 'helper').map((e) => e.id)).toEqual([idZeta, idAlpha]);

    // Mismatched senderId refuses to mark another incarnation's message
    const wrongSenderId = markAnsweredBySend({
      seat: 'lead',
      sender: 'helper',
      senderId: 'agent-incarnation-2',
      root: w.root,
      session: 'acme',
      project: 'acme',
      home: w.home,
      at: NOW_ISO,
    });
    expect(wrongSenderId).toEqual({ kind: 'none' });
    expect(receiptExists(w, 'lead', idZeta)).toBe(false);

    // Matching senderId settles the tie-breaking winner (idZeta)
    const rightSenderId = markAnsweredBySend({
      seat: 'lead',
      sender: 'helper',
      senderId: 'agent-incarnation-1',
      root: w.root,
      session: 'acme',
      project: 'acme',
      home: w.home,
      at: NOW_ISO,
    });
    expect(rightSenderId).toEqual({ kind: 'marked', id: idZeta });
    expect(receiptExists(w, 'lead', idZeta)).toBe(true);
    expect(receiptExists(w, 'lead', idAlpha)).toBe(false);
  });

  test('forged, stale, corrupt, or missing .unread.json and tampered records mark nothing without scanning', () => {
    const w = makeWorld();
    const leadDir = recordDir(w.root, 'acme', 'lead');
    const idLegit = 'e1000000-0000-4000-8000-000000000001';

    plantRecord(w.home, w.root, 'acme', 'lead', idLegit, 'legit body', {
      from: 'worker',
      at: '2026-11-04T06:00:00.000Z',
    });
    addHistory(w, idLegit, 'worker', 'lead', 'socket', '2026-11-04T06:00:01.000Z');

    // 1. Corrupt JSON in .unread.json -> returns empty hints and marks nothing
    writeFileSync(unreadHintPath(leadDir), '{corrupt-json');
    expect(readUnreadHint(leadDir, 'worker')).toEqual([]);
    expect(
      markAnsweredBySend({
        seat: 'lead',
        sender: 'worker',
        senderId: null,
        root: w.root,
        session: 'acme',
        project: 'acme',
        home: w.home,
        at: NOW_ISO,
      }),
    ).toEqual({ kind: 'none' });

    // 2. Wrong schema version in .unread.json -> ignored safely
    writeFileSync(
      unreadHintPath(leadDir),
      JSON.stringify({ v: 99, unread: { worker: { entries: [{ id: idLegit, at: '2026-11-04T06:00:00.000Z' }] } } }),
    );
    expect(readUnreadHint(leadDir, 'worker')).toEqual([]);

    // 3. Valid hint, but record on disk has tampered body after signing -> rejected by signature check
    noteUnread(leadDir, 'worker', idLegit, '2026-11-04T06:00:00.000Z');
    const recordPath = join(leadDir, idLegit);
    const raw = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    raw.body = 'tampered-after-signing';
    writeFileSync(recordPath, `${JSON.stringify(raw, null, 2)}\n`);

    expect(
      markAnsweredBySend({
        seat: 'lead',
        sender: 'worker',
        senderId: null,
        root: w.root,
        session: 'acme',
        project: 'acme',
        home: w.home,
        at: NOW_ISO,
      }),
    ).toEqual({ kind: 'none' });
    expect(receiptExists(w, 'lead', idLegit)).toBe(false);

    // 4. Non-drop-folder guard: noteUnread outside send-drops/<session>/<seat> writes nothing
    const arbitraryDir = join(w.root, 'not-a-drop-folder');
    mkdirSync(arbitraryDir, { recursive: true });
    noteUnread(arbitraryDir, 'worker', idLegit, '2026-11-04T06:00:00.000Z');
    expect(existsSync(unreadHintPath(arbitraryDir))).toBe(false);
  });

  test('clearUnread acquires and releases the recipient seat lock, and preserves a pre-held seat lock', () => {
    const w = makeWorld();
    const leadDir = recordDir(w.root, 'acme', 'lead');
    const idLock = 'f1000000-0000-4000-8000-000000000001';

    plantRecord(w.home, w.root, 'acme', 'lead', idLock, 'lock probe', {
      from: 'worker',
      at: '2026-11-04T06:00:00.000Z',
    });

    const agentsDir = join(w.root, '.agents');
    const expectedLockPath = seatLockPath(agentsDir, 'acme', 'lead');

    const publishedTargets: string[] = [];
    const droppedTargets: string[] = [];
    const origPublish = lockSteps.publish;
    const origDrop = lockSteps.drop;
    lockSteps.publish = (from, to) => {
      publishedTargets.push(to);
      origPublish(from, to);
    };
    lockSteps.drop = (path) => {
      droppedTargets.push(path);
      origDrop(path);
    };
    try {
      clearUnread(leadDir, idLock);
    } finally {
      lockSteps.publish = origPublish;
      lockSteps.drop = origDrop;
    }

    expect(publishedTargets).toContain(expectedLockPath);
    expect(droppedTargets).toContain(expectedLockPath);
    expect(existsSync(expectedLockPath)).toBe(false);
    expect(readUnreadHint(leadDir, 'worker')).toEqual([]);

    // When the seat lock is already held by another live caller, clearUnread does not clobber/release the outer lock
    noteUnread(leadDir, 'worker', idLock, '2026-11-04T06:00:00.000Z');
    expect(readUnreadHint(leadDir, 'worker').map((e) => e.id)).toEqual([idLock]);

    const outerLock = acquireSeatLock(agentsDir, 'acme', 'lead');
    expect('release' in outerLock).toBe(true);
    try {
      const key = messageKeyState(w.home);
      if (key.kind !== 'key') throw new Error(key.kind);
      publishRecordRead({
        dropDir: leadDir,
        id: idLock,
        to: 'lead',
        root: w.root,
        session: 'acme',
        home: w.home,
        key: key.key,
        at: NOW_ISO,
      });
      // Outer lock must still be held on disk while clearUnread completed
      expect(existsSync(expectedLockPath)).toBe(true);
      expect(readUnreadHint(leadDir, 'worker')).toEqual([]);
    } finally {
      if ('release' in outerLock) outerLock.release();
    }
    expect(existsSync(expectedLockPath)).toBe(false);
  });

  test('reply locates its target record without scanning folder contents and updates both seats .unread.json', async () => {
    const w = makeWorld();
    const workerDir = recordDir(w.root, 'acme', 'worker');
    const leadDir = recordDir(w.root, 'acme', 'lead');
    const idAsk = 'f2000000-0000-4000-8000-000000000001';
    const idReply = 'f2000000-0000-4000-8000-000000000002';

    plantRecord(w.home, w.root, 'acme', 'worker', idAsk, 'please report', {
      from: 'lead',
      at: '2026-11-04T06:00:00.000Z',
    });
    addHistory(w, idAsk, 'lead', 'worker', 'socket', '2026-11-04T06:00:01.000Z');
    expect(readUnreadHint(workerDir, 'lead').map((e) => e.id)).toEqual([idAsk]);

    const workerCaller: Caller = { kind: 'seat', name: 'worker', pane: 'pane-worker', session: 'acme' };
    const replyIo = testIo(w.root, workerCaller);
    const replyCode = await runReply([idAsk, 'acknowledged'], replyIo, {
      home: w.home,
      now: () => NOW,
      newId: () => idReply,
    });

    expect(replyCode).toBe(0);
    // Answering clears idAsk from worker's .unread.json and stages idReply into lead's .unread.json
    expect(readUnreadHint(workerDir, 'lead')).toEqual([]);
    expect(readUnreadHint(leadDir, 'worker').map((e) => e.id)).toEqual([idReply]);
    expect(readdirSync(workerDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(leadDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
