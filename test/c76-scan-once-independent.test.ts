// Independent verification of perf/c76-scan-once (da6a99a48).
//
// Coverage:
// 1. On a synthetic 50,000-file fixture built outside the repository, count the file opens per
//    watch pass (each record read at most once) and assert the bound.
// 2. Verdicts are identical to the slow path for a mixed set (read, replied, held, delivered,
//    unread, unverified receipts, another-user records, and general seat briefs — current,
//    stale-epoch receipt, read, and superseded).
// 3. Mid-pass arrivals, mid-pass reads, and single-action guarantees:
//    - A message read mid-pass is neither woken nor falsely reported as `queued, not woken`;
//    - A due message arriving before the wake's under-lock look is not dropped from the wake;
//    - A message arriving after the wake is picked up by the next pass, and nothing is acted on
//      twice.

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';

const realFs = await import('node:fs');
const realFsCalls = {
  openSync: realFs.openSync,
  readFileSync: realFs.readFileSync,
};

const opened: string[] = [];
const readFiles: string[] = [];
let watchingPrefix: string | undefined;

mock.module('node:fs', () => {
  const wrapped = Object.assign({}, realFs);
  for (const name of ['openSync', 'readFileSync'] as const) {
    const real = realFs[name] as (...args: unknown[]) => unknown;
    Object.assign(wrapped, {
      [name]: (...args: unknown[]) => {
        const target = String(args[0]);
        if (watchingPrefix !== undefined && target.startsWith(watchingPrefix)) {
          (name === 'openSync' ? opened : readFiles).push(target);
        }
        return real(...args);
      },
    });
  }
  return wrapped as typeof realFs;
});

afterAll(() => {
  mock.module('node:fs', () => ({ ...realFs, ...realFsCalls }));
});

let listUnackedMessages: (typeof import('../src/commands/messages.ts'))['listUnackedMessages'];
let runWatch: (typeof import('../src/commands/watch.ts'))['runWatch'];
let generalBriefRecord: (typeof import('../src/launch/general-brief.ts'))['generalBriefRecord'];
let GENERAL_BRIEF_SHA256: (typeof import('../src/launch/general-brief.ts'))['GENERAL_BRIEF_SHA256'];
let isGeneralBriefRecord: (typeof import('../src/launch/general-brief.ts'))['isGeneralBriefRecord'];
let mintBriefEpoch: (typeof import('../src/launch/brief-id.ts'))['mintBriefEpoch'];
let mintBriefIncarnation: (typeof import('../src/launch/brief-id.ts'))['mintBriefIncarnation'];
let listUnread: (typeof import('../src/mcp/inbox.ts'))['listUnread'];
let readRecord: (typeof import('../src/send/record.ts'))['readRecord'];
let signReceiptPayload: (typeof import('../src/send/record.ts'))['signReceiptPayload'];
let signRecord: (typeof import('../src/send/record.ts'))['signRecord'];
let statusOf: (typeof import('../src/send/record.ts'))['statusOf'];
let verifyRecord: (typeof import('../src/send/record.ts'))['verifyRecord'];
let emptySession: (typeof import('../src/state.ts'))['emptySession'];
let updateState: (typeof import('../src/state.ts'))['updateState'];
let messageKeyOf: (typeof import('../src/store/keys.ts'))['messageKeyOf'];
let MailPass: (typeof import('../src/watch/mail-pass.ts'))['MailPass'];
let reportedPath: (typeof import('../src/watch/unread.ts'))['reportedPath'];
let wakePath: (typeof import('../src/watch/unread.ts'))['wakePath'];
let wakeUnreadDrops: (typeof import('../src/watch/unread.ts'))['wakeUnreadDrops'];
let reportUnreadDrops: (typeof import('../src/watch/unread.ts'))['reportUnreadDrops'];
let loadTeamFile: (typeof import('../src/file/load.ts'))['loadTeamFile'];
let gitEnv: (typeof import('./helpers.ts'))['gitEnv'];
let testIo: (typeof import('./helpers.ts'))['testIo'];

const MUSE_IDLE = readFileSync(new URL('./fixtures/muse/1.4.11/idle.txt', import.meta.url), 'utf8');

beforeAll(async () => {
  ({ messageKeyOf } = await import('../src/store/keys.ts'));
  ({ readRecord, signReceiptPayload, signRecord, statusOf, verifyRecord } = await import(
    '../src/send/record.ts'
  ));
  ({ generalBriefRecord, GENERAL_BRIEF_SHA256, isGeneralBriefRecord } = await import(
    '../src/launch/general-brief.ts'
  ));
  ({ mintBriefEpoch, mintBriefIncarnation } = await import('../src/launch/brief-id.ts'));
  ({ emptySession, updateState } = await import('../src/state.ts'));
  ({ listUnread } = await import('../src/mcp/inbox.ts'));
  ({ listUnackedMessages } = await import('../src/commands/messages.ts'));
  ({ MailPass } = await import('../src/watch/mail-pass.ts'));
  ({ reportedPath, wakePath, wakeUnreadDrops, reportUnreadDrops } = await import('../src/watch/unread.ts'));
  ({ loadTeamFile } = await import('../src/file/load.ts'));
  ({ runWatch } = await import('../src/commands/watch.ts'));
  ({ gitEnv, testIo } = await import('./helpers.ts'));
});

const SESSION = 'acme-web';
const SEAT = 'deepseek-acme';
const LEAD_SEAT = 'claude-coordinator-acme';

type FixtureWorld = {
  base: string;
  root: string;
  dir: string;
  home: string;
  otherHome: string;
};

const activeBases: string[] = [];

afterEach(() => {
  watchingPrefix = undefined;
  opened.length = 0;
  readFiles.length = 0;
  for (const base of activeBases.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});

function makeWorld(): FixtureWorld {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'c76-scan-ind-')));
  activeBases.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const otherHome = join(base, 'other-home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(otherHome, { recursive: true });
  return { base, root, dir, home, otherHome };
}

function initGitAndTeamFile(w: FixtureWorld): string {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q'], {
    cwd: w.root,
    env: gitEnv(),
  });
  const teamPath = join(w.dir, 'team.yaml');
  writeFileSync(teamPath, readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8'));
  return teamPath;
}

function dropDirOf(w: FixtureWorld, seat = SEAT, session = SESSION): string {
  return join(w.dir, 'send-drops', session, seat);
}

function resetWatchCounters(prefix: string): void {
  watchingPrefix = prefix;
  opened.length = 0;
  readFiles.length = 0;
}

function opensOf(path: string): number {
  let count = 0;
  for (const item of opened) {
    if (item === path) count += 1;
  }
  return count;
}

function seedSignedMessage(
  w: FixtureWorld,
  seat: string,
  id: string,
  atIso: string,
  options: {
    session?: string;
    home?: string;
    from?: string;
    body?: string;
    root?: string;
  } = {},
): string {
  const session = options.session ?? SESSION;
  const dropDir = dropDirOf(w, seat, session);
  mkdirSync(dropDir, { recursive: true });
  const record = signRecord(
    {
      kind: 'message',
      id,
      to: seat,
      to_id: null,
      root: options.root ?? realpathSync(w.root),
      session,
      at: atIso,
      body: options.body ?? `message ${id} for ${seat}`,
      from: options.from ?? 'owner',
      from_id: null,
      rule: 'the owner',
      thread: id,
    },
    options.home ?? w.home,
  );
  const path = join(dropDir, id);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

function seedReceipt(
  w: FixtureWorld,
  seat: string,
  id: string,
  status: 'held' | 'delivered' | 'read' | 'replied',
  atIso: string,
  options: {
    session?: string;
    home?: string;
    to?: string;
    root?: string;
    recordId?: string;
    incarnation?: string;
    brief_sha256?: string;
    brief_epoch?: string;
  } = {},
): string {
  const session = options.session ?? SESSION;
  const dropDir = dropDirOf(w, seat, session);
  mkdirSync(dropDir, { recursive: true });
  const receipt = signReceiptPayload(
    {
      kind: 'receipt',
      status,
      id: options.recordId ?? id,
      to: options.to ?? seat,
      root: options.root ?? realpathSync(w.root),
      session,
      at: atIso,
      ...(options.incarnation === undefined ? {} : { incarnation: options.incarnation }),
      ...(options.brief_sha256 === undefined ? {} : { brief_sha256: options.brief_sha256 }),
      ...(options.brief_epoch === undefined ? {} : { brief_epoch: options.brief_epoch }),
    },
    options.home ?? w.home,
  );
  const path = join(dropDir, `${id}.${status}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return path;
}

describe('1. 50,000-file synthetic fixture: file-open bound per watch pass', () => {
  test(
    'a full runWatch pass over a 50,000-file drop folder opens each waiting record at most once and never opens read records',
    async () => {
      const w = makeWorld();
      const teamPath = initGitAndTeamFile(w);
      const dropDir = dropDirOf(w, SEAT, SESSION);
      mkdirSync(dropDir, { recursive: true });
      messageKeyOf(w.home);

      const nowIso = new Date().toISOString();

      // 10 read records + 10 signed .read.json receipts = 20 files.
      const readRecordPaths: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const id = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        readRecordPaths.push(seedSignedMessage(w, SEAT, id, nowIso));
        seedReceipt(w, SEAT, id, 'read', nowIso);
      }

      // 5 signed waiting records + 49,975 lightweight waiting record files = 49,980 waiting record files.
      // Total files in dropDir = 20 + 49,980 = 50,000 files.
      const signedWaitingPaths: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const id = `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        signedWaitingPaths.push(seedSignedMessage(w, SEAT, id, nowIso));
      }

      const unsignedWaitingCount = 49_975;
      for (let i = 0; i < unsignedWaitingCount; i += 1) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        writeFileSync(join(dropDir, id), '{}\n');
      }

      // Take clockMs after writing the files so unsigned files (which fall back to mtime) are fresh
      // (< threshold) and only the pass's three folder listings (mailboxWaiting, wakeUnreadDrops,
      // reportUnreadDrops) run.
      const clockMs = Date.now();
      const totalWaitingRecords = signedWaitingPaths.length + unsignedWaitingCount;
      expect(readRecordPaths.length * 2 + totalWaitingRecords).toBe(50_000);

      resetWatchCounters(dropDir);

      const code = await runWatch(['--file', teamPath], testIo(w.root, { kind: 'owner' }), {
        live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
        machine: () => ({
          loadPerCore: 1,
          memoryFree: 50,
          diskFree: 200e9,
          swapTotal: 9e9,
          swapFree: 8e9,
          swapUsed: 1e9,
        }),
        standing: () => ({ kind: 'none' }),
        readChecks: () => [],
        screen: () => null,
        status: () => 'idle',
        foreground: () => [],
        typeText: () => false,
        pressEnter: () => false,
        sleep: async () => {},
        notify: () => {},
        now: () => new Date(clockMs),
        wait: async () => false,
        alive: () => false,
        pid: 4242,
        home: w.home,
      });

      expect(code).toBe(0);

      // No readFileSync calls on the drop folder; all record and receipt reads use openSync (O_NOFOLLOW).
      expect(readFiles).toHaveLength(0);

      // Every already-read record is opened 0 times because its receipt is checked first.
      for (const readPath of readRecordPaths) {
        expect(opensOf(readPath)).toBe(0);
      }

      // Separate record opens from receipt opens and count opens per record path.
      const perRecordOpens = new Map<string, number>();
      let recordOpenTotal = 0;
      let receiptOpenTotal = 0;
      for (const target of opened) {
        if (target.endsWith('.json')) {
          receiptOpenTotal += 1;
        } else {
          recordOpenTotal += 1;
          perRecordOpens.set(target, (perRecordOpens.get(target) ?? 0) + 1);
        }
      }

      // Every waiting record (all 49,980 of them) was opened at most once across mailboxWaiting,
      // wakeUnreadDrops, and reportUnreadDrops in the watch pass.
      let maxOpensForAnyRecord = 0;
      for (const count of perRecordOpens.values()) {
        if (count > maxOpensForAnyRecord) maxOpensForAnyRecord = count;
      }
      expect(maxOpensForAnyRecord).toBe(1);
      expect(perRecordOpens.size).toBe(totalWaitingRecords);
      expect(recordOpenTotal).toBe(totalWaitingRecords);
      expect(recordOpenTotal).toBeLessThanOrEqual(50_000);

      // Each signed waiting record was opened exactly once.
      for (const signedPath of signedWaitingPaths) {
        expect(perRecordOpens.get(signedPath)).toBe(1);
      }

      // The 10 .read.json receipts were opened and verified once on the pass (listUnackedMessages)
      // and reused from the receipt-verdict stamp cache by mail.unread and wakeUnreadDrops.
      expect(receiptOpenTotal).toBe(readRecordPaths.length);

      // Clean up the 50,000-file directory inside the test's own timeout budget.
      const idx = activeBases.indexOf(w.base);
      if (idx !== -1) activeBases.splice(idx, 1);
      rmSync(w.base, { recursive: true, force: true });
    },
    180_000,
  );
});

describe('2. mixed-set verdict parity with the slow path', () => {
  test('MailPass unread and unacked match the uncached slow path and reference oracle across read, replied, held, delivered, unread, unverified receipts, and general briefs', () => {
    const w = makeWorld();
    const dropDir = dropDirOf(w, SEAT, SESSION);
    mkdirSync(dropDir, { recursive: true });
    const key = messageKeyOf(w.home);
    messageKeyOf(w.otherHome);

    // 1. Read record: valid signed .read.json receipt.
    const idRead = 'a0000000-0000-4000-8000-000000000001';
    const pathRead = seedSignedMessage(w, SEAT, idRead, '2026-11-05T08:01:00.000Z');
    seedReceipt(w, SEAT, idRead, 'read', '2026-11-05T08:02:00.000Z');

    // 2. Replied record: valid signed .replied.json receipt (with no .read.json).
    const idReplied = 'a0000000-0000-4000-8000-000000000002';
    const pathReplied = seedSignedMessage(w, SEAT, idReplied, '2026-11-05T08:03:00.000Z');
    seedReceipt(w, SEAT, idReplied, 'replied', '2026-11-05T08:04:00.000Z');

    // 3. Held and delivered records: valid signed .held.json and .delivered.json receipts (still waiting!).
    const idHeld = 'a0000000-0000-4000-8000-000000000003';
    const pathHeld = seedSignedMessage(w, SEAT, idHeld, '2026-11-05T08:05:00.000Z');
    const pathHeldReceipt = seedReceipt(w, SEAT, idHeld, 'held', '2026-11-05T08:05:30.000Z');

    const idDelivered = 'a0000000-0000-4000-8000-000000000004';
    const pathDelivered = seedSignedMessage(w, SEAT, idDelivered, '2026-11-05T08:06:00.000Z');
    const pathDeliveredReceipt = seedReceipt(w, SEAT, idDelivered, 'delivered', '2026-11-05T08:06:30.000Z');

    // 4. Unread record with an unsigned .pending marker carrying a forged earlier timestamp:
    //    must be listed as waiting and dated by its signed `at`, never the unsigned marker's `ts`.
    const idUnread = 'a0000000-0000-4000-8000-000000000005';
    const signedUnreadAt = '2026-11-05T08:07:00.000Z';
    const pathUnread = seedSignedMessage(w, SEAT, idUnread, signedUnreadAt, { from: LEAD_SEAT });
    writeFileSync(
      join(dropDir, `${idUnread}.pending`),
      `${JSON.stringify({ id: idUnread, from: LEAD_SEAT, ts: '2020-01-01T00:00:00.000Z' })}\n`,
    );

    // 5. Unverified receipts:
    // 5a. Receipt signed by another home's key.
    const idWrongKeyReceipt = 'a0000000-0000-4000-8000-000000000006';
    const pathWrongKey = seedSignedMessage(w, SEAT, idWrongKeyReceipt, '2026-11-05T08:08:00.000Z');
    seedReceipt(w, SEAT, idWrongKeyReceipt, 'read', '2026-11-05T08:08:30.000Z', { home: w.otherHome });

    // 5b. Receipt signed by this key, but for another seat.
    const idWrongSeatReceipt = 'a0000000-0000-4000-8000-000000000007';
    const pathWrongSeat = seedSignedMessage(w, SEAT, idWrongSeatReceipt, '2026-11-05T08:09:00.000Z');
    seedReceipt(w, SEAT, idWrongSeatReceipt, 'read', '2026-11-05T08:09:30.000Z', { to: 'other-seat' });

    // 5c. Receipt signed by this key, but for another session.
    const idWrongSessionReceipt = 'a0000000-0000-4000-8000-000000000008';
    const pathWrongSession = seedSignedMessage(w, SEAT, idWrongSessionReceipt, '2026-11-05T08:10:00.000Z');
    const wrongSessionReceipt = signReceiptPayload(
      {
        kind: 'receipt',
        status: 'read',
        id: idWrongSessionReceipt,
        to: SEAT,
        root: realpathSync(w.root),
        session: 'foreign-session',
        at: '2026-11-05T08:10:30.000Z',
      },
      w.home,
    );
    writeFileSync(join(dropDir, `${idWrongSessionReceipt}.read.json`), `${JSON.stringify(wrongSessionReceipt)}\n`);

    // 5d. Corrupt non-JSON .replied.json receipt.
    const idCorruptReceipt = 'a0000000-0000-4000-8000-000000000009';
    const pathCorruptReceipt = seedSignedMessage(w, SEAT, idCorruptReceipt, '2026-11-05T08:11:00.000Z');
    writeFileSync(join(dropDir, `${idCorruptReceipt}.replied.json`), '{not-valid-json\n');

    // 6. General seat briefs:
    // 6a. An earlier superseded general brief (from an older incarnation, not listed in claim.superseded).
    const oldIncarnation = mintBriefIncarnation();
    const oldBriefPayload = generalBriefRecord({
      to: SEAT,
      root: realpathSync(w.root),
      session: SESSION,
      at: '2026-11-05T08:00:00.000Z',
      incarnation: oldIncarnation,
    });
    const pathSupersededBrief = join(dropDir, oldBriefPayload.id);
    writeFileSync(pathSupersededBrief, `${JSON.stringify(signRecord(oldBriefPayload, w.home), null, 2)}\n`);

    // 6b. Current general brief for SEAT, with a stale-epoch .read.json receipt (must still be unread!).
    const currentIncarnation = mintBriefIncarnation();
    const staleEpoch = mintBriefEpoch();
    const currentEpoch = mintBriefEpoch();
    const currentBriefPayload = generalBriefRecord({
      to: SEAT,
      root: realpathSync(w.root),
      session: SESSION,
      at: '2026-11-05T08:12:00.000Z',
      incarnation: currentIncarnation,
    });
    const pathCurrentBrief = join(dropDir, currentBriefPayload.id);
    writeFileSync(pathCurrentBrief, `${JSON.stringify(signRecord(currentBriefPayload, w.home), null, 2)}\n`);
    seedReceipt(w, SEAT, currentBriefPayload.id, 'read', '2026-11-05T08:12:10.000Z', {
      incarnation: currentIncarnation,
      brief_sha256: GENERAL_BRIEF_SHA256,
      brief_epoch: staleEpoch,
    });

    // 6c. Current general brief on LEAD_SEAT with a valid bound .read.json receipt matching its claim epoch.
    const leadIncarnation = mintBriefIncarnation();
    const leadEpoch = mintBriefEpoch();
    const leadBriefPayload = generalBriefRecord({
      to: LEAD_SEAT,
      root: realpathSync(w.root),
      session: SESSION,
      at: '2026-11-05T08:13:00.000Z',
      incarnation: leadIncarnation,
    });
    mkdirSync(dropDirOf(w, LEAD_SEAT, SESSION), { recursive: true });
    const pathLeadBrief = join(dropDirOf(w, LEAD_SEAT, SESSION), leadBriefPayload.id);
    writeFileSync(pathLeadBrief, `${JSON.stringify(signRecord(leadBriefPayload, w.home), null, 2)}\n`);
    seedReceipt(w, LEAD_SEAT, leadBriefPayload.id, 'read', '2026-11-05T08:13:10.000Z', {
      incarnation: leadIncarnation,
      brief_sha256: GENERAL_BRIEF_SHA256,
      brief_epoch: leadEpoch,
    });

    updateState(w.dir, (state) => {
      const sess = (state.sessions[SESSION] ??= emptySession());
      sess.briefs = {
        [SEAT]: {
          id: currentBriefPayload.id,
          at: currentBriefPayload.at,
          incarnation: currentIncarnation,
          epoch: currentEpoch,
          sha256: GENERAL_BRIEF_SHA256,
          attempt: 0,
          stage: 'ready',
          superseded: [],
        },
        [LEAD_SEAT]: {
          id: leadBriefPayload.id,
          at: leadBriefPayload.at,
          incarnation: leadIncarnation,
          epoch: leadEpoch,
          sha256: GENERAL_BRIEF_SHA256,
          attempt: 0,
          stage: 'ready',
          superseded: [],
        },
      };
    });

    // Measure opens during the MailPass fast path across unacked() + unread(SEAT) + unread(LEAD_SEAT).
    resetWatchCounters(join(w.dir, 'send-drops', SESSION));
    const mail = new MailPass({ dir: w.dir, root: w.root, session: SESSION, home: w.home });
    const fastUnacked = mail.unacked();
    const fastUnreadSeat = mail.unread(SEAT);
    const fastUnreadLead = mail.unread(LEAD_SEAT);
    // Calling them a second time on the same MailPass performs 0 additional opens.
    const opensAfterFirstPass = opened.length;
    expect(mail.unacked()).toEqual(fastUnacked);
    expect(mail.unread(SEAT)).toEqual(fastUnreadSeat);
    expect(mail.unread(LEAD_SEAT)).toEqual(fastUnreadLead);
    expect(opened.length).toBe(opensAfterFirstPass);

    // Read and replied records are never opened; held and delivered receipts are never opened by isRead.
    expect(opensOf(pathRead)).toBe(0);
    expect(opensOf(pathReplied)).toBe(0);
    expect(opensOf(pathHeldReceipt)).toBe(0);
    expect(opensOf(pathDeliveredReceipt)).toBe(0);

    // Every waiting record was opened exactly once across both unacked() and unread().
    for (const waitingPath of [
      pathHeld,
      pathDelivered,
      pathUnread,
      pathWrongKey,
      pathWrongSeat,
      pathWrongSession,
      pathCorruptReceipt,
      pathSupersededBrief,
      pathCurrentBrief,
    ]) {
      expect(opensOf(waitingPath)).toBe(1);
    }

    // Compare against the uncached slow path (listUnackedMessages and listUnread with no shared reader).
    const slowUnacked = listUnackedMessages(w.root, SESSION, w.home);
    const slowUnreadSeat = listUnread(dropDir, { to: SEAT, root: w.root, session: SESSION }, w.home);
    const slowUnreadLead = listUnread(
      dropDirOf(w, LEAD_SEAT, SESSION),
      { to: LEAD_SEAT, root: w.root, session: SESSION },
      w.home,
    );

    expect(fastUnacked).toEqual(slowUnacked);
    expect(fastUnreadSeat).toEqual(slowUnreadSeat);
    expect(fastUnreadLead).toEqual(slowUnreadLead);

    // Compare against an independent slow-path reference oracle using statusOf + readRecord + verifyRecord.
    const contextSeat = { to: SEAT, root: w.root, session: SESSION };
    expect(statusOf(dropDir, idRead, contextSeat, key)).toBe('read');
    expect(statusOf(dropDir, idReplied, contextSeat, key)).toBe('replied');
    expect(statusOf(dropDir, idHeld, contextSeat, key)).toBe('held');
    expect(statusOf(dropDir, idDelivered, contextSeat, key)).toBe('delivered');
    expect(statusOf(dropDir, idUnread, contextSeat, key)).toBe('sent');
    expect(statusOf(dropDir, idWrongKeyReceipt, contextSeat, key)).toBe('sent');
    expect(statusOf(dropDir, idWrongSeatReceipt, contextSeat, key)).toBe('sent');
    expect(statusOf(dropDir, idWrongSessionReceipt, contextSeat, key)).toBe('sent');
    expect(statusOf(dropDir, idCorruptReceipt, contextSeat, key)).toBe('sent');

    // Verify exact expected unread IDs for SEAT:
    // - excludes idRead, idReplied, and oldBriefPayload.id (superseded general brief)
    // - includes idHeld, idDelivered, idUnread, the 4 unverified-receipt records, and currentBriefPayload.id
    const expectedUnreadIds = [
      idHeld,
      idDelivered,
      idUnread,
      idWrongKeyReceipt,
      idWrongSeatReceipt,
      idWrongSessionReceipt,
      idCorruptReceipt,
      currentBriefPayload.id,
    ];
    expect(fastUnreadSeat.map((m) => m.id)).toEqual(expectedUnreadIds);

    // Verify the unsigned .pending marker could not backdate idUnread's timestamp.
    const unreadEntry = fastUnreadSeat.find((m) => m.id === idUnread);
    expect(unreadEntry?.ts).toBe(signedUnreadAt);
    expect(unreadEntry?.from).toBe(LEAD_SEAT);

    // Verify LEAD_SEAT's bound read receipt satisfied its current general brief.
    expect(fastUnreadLead).toEqual([]);

    // Verify slow-path record verification on the two general briefs in SEAT's folder.
    const rawOld = readRecord(pathSupersededBrief, oldBriefPayload.id);
    expect(rawOld.ok && rawOld.record !== null && verifyRecord(rawOld.record, key)).toBe(true);
    if (rawOld.ok && rawOld.record !== null) {
      expect(isGeneralBriefRecord(rawOld.record.payload)).toBe(true);
    }
  });

  test('a record owned by another user stays waiting on both MailPass and slow-path lists without opening the file via the strict reader', () => {
    const w = makeWorld();
    const dropDir = dropDirOf(w, SEAT, SESSION);
    mkdirSync(dropDir, { recursive: true });
    messageKeyOf(w.home);

    const foreignId = 'a0000000-0000-4000-8000-000000000099';
    const fileMtimeIso = '2026-11-05T08:15:00.000Z';
    const foreignPath = seedSignedMessage(w, SEAT, foreignId, '2026-11-05T08:14:00.000Z', {
      from: 'owner',
    });
    utimesSync(foreignPath, new Date(fileMtimeIso), new Date(fileMtimeIso));

    const realGetuid = process.getuid!;
    try {
      process.getuid = () => realGetuid() + 1;
      resetWatchCounters(dropDir);

      const mail = new MailPass({ dir: w.dir, root: w.root, session: SESSION, home: w.home });
      const fastUnread = mail.unread(SEAT);
      const fastUnacked = mail.unacked();

      expect(fastUnread.map((m) => m.id)).toEqual([foreignId]);
      expect(fastUnread[0]?.ts).toBe(fileMtimeIso);
      expect(fastUnacked.map((m) => m.id)).toEqual([foreignId]);
      expect(fastUnacked[0]?.from).toBe('owner');

      // The strict reader refused before openSync, and listUnackedMessages fell back to reading
      // the foreign-owned regular file once via readFileSync.
      expect(opensOf(foreignPath)).toBe(0);
      expect(readFiles.filter((p) => p === foreignPath)).toHaveLength(1);

      const slowUnread = listUnread(dropDir, { to: SEAT, root: w.root, session: SESSION }, w.home);
      const slowUnacked = listUnackedMessages(w.root, SESSION, w.home);
      expect(fastUnread).toEqual(slowUnread);
      expect(fastUnacked).toEqual(slowUnacked);
    } finally {
      process.getuid = realGetuid;
    }
  });
});

describe('3. mid-pass arrivals, mid-pass reads, and single-action guarantees across passes', () => {
  test('a message read mid-pass is neither woken nor falsely reported as queued, not woken, and is not opened on the next pass', async () => {
    const w = makeWorld();
    const teamPath = initGitAndTeamFile(w);
    const loaded = loadTeamFile(w.root, { file: teamPath });
    if (!loaded.ok) throw new Error('expected team config');
    const team = {
      ...loaded.team,
      seats: loaded.team.seats.map((s) =>
        s.name === SEAT ? { ...s, cli: 'muse', watchWake: true } : s,
      ),
    };
    const dropDir = dropDirOf(w, SEAT, SESSION);
    mkdirSync(dropDir, { recursive: true });

    const midReadId = 'd0000000-0000-4000-8000-000000000001';
    const sentAt = '2026-11-05T08:40:00.000Z';
    const passClock = new Date('2026-11-05T09:00:00.000Z'); // 20 min old -> overdue for both N wake and 2N report
    const midReadPath = seedSignedMessage(w, SEAT, midReadId, sentAt, {
      from: 'owner',
      root: w.root,
      home: w.home,
    });

    // MailPass snapshots the folder at pass start while midReadId is still unread.
    const pass1Mail = new MailPass({ dir: w.dir, root: w.root, session: SESSION, home: w.home });
    expect(pass1Mail.unread(SEAT).map((m) => m.id)).toEqual([midReadId]);

    // Before wakeUnreadDrops and reportUnreadDrops act, the seat reads the message mid-pass.
    seedReceipt(w, SEAT, midReadId, 'read', passClock.toISOString());

    const said: string[] = [];
    let typedWakeCalls = 0;
    const liveState = {
      running: true,
      agents: [
        {
          name: SEAT,
          agent: 'muse',
          pane: 'pane-deepseek',
          workspace: 'ws-deepseek',
          status: 'idle',
          cwd: w.root,
        },
      ],
      workspaces: [{ id: 'ws-deepseek', label: SEAT }],
      screens: { 'pane-deepseek': MUSE_IDLE },
    };
    const sources: WatchSources = {
      live: () => liveState,
      machine: () => ({
        loadPerCore: 1,
        memoryFree: 50,
        diskFree: 200e9,
        swapTotal: 9e9,
        swapFree: 8e9,
        swapUsed: 1e9,
      }),
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => MUSE_IDLE,
      status: () => 'idle',
      foreground: () => ['muse'],
      typeText: () => true,
      pressEnter: () => true,
      typedWake: async () => {
        typedWakeCalls += 1;
        return { delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' };
      },
      sleep: async () => {},
      notify: () => {},
      now: () => passClock,
      wait: async () => false,
      alive: () => false,
      pid: 4242,
      home: w.home,
    };

    const scene = {
      dir: w.dir,
      session: SESSION,
      root: w.root,
      home: w.home,
      team,
      live: liveState,
      ownPane: null,
      sources,
      now: passClock,
      say: (text: string) => {
        said.push(text);
      },
      mail: pass1Mail,
    };

    await wakeUnreadDrops(scene, { unreadAfter: 60 });
    reportUnreadDrops(scene, { unreadAfter: 60 });

    // Neither woken nor falsely reported as queued, not woken.
    expect(typedWakeCalls).toBe(0);
    expect(existsSync(wakePath(dropDir, midReadId))).toBe(false);
    expect(existsSync(reportedPath(dropDir, midReadId))).toBe(false);
    expect(said).toEqual([]);

    // On Pass 2, the record file is opened 0 times because its .read.json receipt is checked first.
    resetWatchCounters(dropDir);
    const pass2Mail = new MailPass({ dir: w.dir, root: w.root, session: SESSION, home: w.home });
    expect(pass2Mail.unacked()).toEqual([]);
    expect(pass2Mail.unread(SEAT)).toEqual([]);
    expect(opensOf(midReadPath)).toBe(0);
  });

  test('a due message arriving mid-pass before the wake lock is not dropped from the wake, and a message arriving after the wake is woken on the next pass without ever acting twice', async () => {
    const w = makeWorld();
    const teamPath = initGitAndTeamFile(w);
    const loaded = loadTeamFile(w.root, { file: teamPath });
    if (!loaded.ok) throw new Error('expected team config');
    const team = {
      ...loaded.team,
      seats: loaded.team.seats.map((s) =>
        s.name === SEAT ? { ...s, cli: 'muse', watchWake: true } : s,
      ),
    };
    const dropDir = dropDirOf(w, SEAT, SESSION);
    mkdirSync(dropDir, { recursive: true });

    const msg1Id = 'b0000000-0000-4000-8000-000000000001';
    const msgMidWakeId = 'b0000000-0000-4000-8000-000000000002';
    const msgAfterWakeId = 'b0000000-0000-4000-8000-000000000003';
    const sentAt = '2026-11-05T08:50:00.000Z';
    const passClock = new Date('2026-11-05T09:00:00.000Z'); // 10 min old -> due for N wake (60s)

    const msg1Path = seedSignedMessage(w, SEAT, msg1Id, sentAt, {
      from: 'owner',
      root: w.root,
      home: w.home,
    });

    // Pass 1 MailPass snapshots msg1Id only (opening msg1Path once).
    const pass1Mail = new MailPass({ dir: w.dir, root: w.root, session: SESSION, home: w.home });
    expect(pass1Mail.unread(SEAT).map((m) => m.id)).toEqual([msg1Id]);

    // msgMidWakeId arrives after pass1Mail.unread(SEAT) was taken, before wakeUnreadDrops acquires the seat lock.
    const msgMidWakePath = seedSignedMessage(w, SEAT, msgMidWakeId, sentAt, {
      from: 'owner',
      root: w.root,
      home: w.home,
    });

    const wakes: { pass: number; line: string }[] = [];
    let currentPass = 1;
    const liveState = {
      running: true,
      agents: [
        {
          name: SEAT,
          agent: 'muse',
          pane: 'pane-deepseek',
          workspace: 'ws-deepseek',
          status: 'idle',
          cwd: w.root,
        },
      ],
      workspaces: [{ id: 'ws-deepseek', label: SEAT }],
      screens: { 'pane-deepseek': MUSE_IDLE },
    };

    const makeSources = (): WatchSources => ({
      live: () => liveState,
      machine: () => ({
        loadPerCore: 1,
        memoryFree: 50,
        diskFree: 200e9,
        swapTotal: 9e9,
        swapFree: 8e9,
        swapUsed: 1e9,
      }),
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => MUSE_IDLE,
      status: () => 'idle',
      foreground: () => ['muse'],
      typeText: () => true,
      pressEnter: () => true,
      typedWake: async (_pane, line) => {
        wakes.push({ pass: currentPass, line });
        // While Pass 1's wake is being typed, msgAfterWakeId lands in the drop folder.
        if (currentPass === 1 && !existsSync(join(dropDir, msgAfterWakeId))) {
          seedSignedMessage(w, SEAT, msgAfterWakeId, sentAt, {
            from: 'owner',
            root: w.root,
            home: w.home,
          });
        }
        return { delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' };
      },
      sleep: async () => {},
      notify: () => {},
      now: () => passClock,
      wait: async () => false,
      alive: () => false,
      pid: 4242,
      home: w.home,
    });

    resetWatchCounters(dropDir);
    const sources1 = makeSources();
    await wakeUnreadDrops(
      {
        dir: w.dir,
        session: SESSION,
        root: w.root,
        home: w.home,
        team,
        live: liveState,
        ownPane: null,
        sources: sources1,
        now: passClock,
        say: () => {},
        mail: pass1Mail,
      },
      { unreadAfter: 60 },
    );

    // Pass 1 woke once, and both msg1Id and msgMidWakeId (which arrived before the seat lock)
    // were covered by that wake reservation; msgAfterWakeId arrived during typedWake and waits
    // for Pass 2. Under the lock, listUnread reused pass1Mail.recordAt so msg1Path was not re-read
    // by listUnread (only payloadOf opened msg1Path once for the audit), while msgMidWakePath was
    // opened once by listUnread via pass1Mail.recordAt and once by payloadOf.
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.pass).toBe(1);
    expect(existsSync(wakePath(dropDir, msg1Id))).toBe(true);
    expect(existsSync(wakePath(dropDir, msgMidWakeId))).toBe(true);
    expect(existsSync(wakePath(dropDir, msgAfterWakeId))).toBe(false);
    expect(opensOf(msg1Path)).toBe(1);
    expect(opensOf(msgMidWakePath)).toBe(2);

    // Pass 2 runs with a fresh MailPass: picks up msgAfterWakeId and wakes it once, without
    // re-waking msg1Id or msgMidWakeId.
    currentPass = 2;
    const pass2Mail = new MailPass({ dir: w.dir, root: w.root, session: SESSION, home: w.home });
    const sources2 = makeSources();
    await wakeUnreadDrops(
      {
        dir: w.dir,
        session: SESSION,
        root: w.root,
        home: w.home,
        team,
        live: liveState,
        ownPane: null,
        sources: sources2,
        now: passClock,
        say: () => {},
        mail: pass2Mail,
      },
      { unreadAfter: 60 },
    );

    expect(wakes).toHaveLength(2);
    expect(wakes[1]?.pass).toBe(2);
    expect(existsSync(wakePath(dropDir, msgAfterWakeId))).toBe(true);

    // A third pass with all three already woken does nothing at all (nothing is acted on twice).
    currentPass = 3;
    const pass3Mail = new MailPass({ dir: w.dir, root: w.root, session: SESSION, home: w.home });
    const sources3 = makeSources();
    await wakeUnreadDrops(
      {
        dir: w.dir,
        session: SESSION,
        root: w.root,
        home: w.home,
        team,
        live: liveState,
        ownPane: null,
        sources: sources3,
        now: passClock,
        say: () => {},
        mail: pass3Mail,
      },
      { unreadAfter: 60 },
    );
    expect(wakes).toHaveLength(2);
  });

  test('an overdue message arriving mid-pass is picked up on the next pass, and the first pass report is never emitted twice', async () => {
    const w = makeWorld();
    const teamPath = initGitAndTeamFile(w);
    const loaded = loadTeamFile(w.root, { file: teamPath });
    if (!loaded.ok) throw new Error('expected team config');
    const team = loaded.team;
    const dropDir = dropDirOf(w, SEAT, SESSION);
    mkdirSync(dropDir, { recursive: true });

    const rep1Id = 'c0000000-0000-4000-8000-000000000001';
    const rep2Id = 'c0000000-0000-4000-8000-000000000002';
    const sentAt = '2026-11-05T08:40:00.000Z';
    const passClock = new Date('2026-11-05T09:00:00.000Z'); // 20 min later -> overdue for 2N report

    seedSignedMessage(w, SEAT, rep1Id, sentAt, { from: 'owner', root: w.root, home: w.home });

    const said: string[] = [];
    const emptyLive = { running: true, agents: [], workspaces: [], screens: {} };
    const makeSources = (): WatchSources => ({
      live: () => emptyLive,
      machine: () => ({
        loadPerCore: 1,
        memoryFree: 50,
        diskFree: 200e9,
        swapTotal: 9e9,
        swapFree: 8e9,
        swapUsed: 1e9,
      }),
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => null,
      status: () => 'idle',
      foreground: () => [],
      typeText: () => false,
      pressEnter: () => false,
      sleep: async () => {},
      notify: () => {},
      now: () => passClock,
      wait: async () => false,
      alive: () => false,
      pid: 4242,
      home: w.home,
    });

    // Pass 1 MailPass lists rep1Id before rep2Id arrives.
    const pass1Mail = new MailPass({ dir: w.dir, root: w.root, session: SESSION, home: w.home });
    expect(pass1Mail.unread(SEAT).map((m) => m.id)).toEqual([rep1Id]);

    // rep2Id arrives mid-pass after pass1Mail has already listed the seat's unread drops.
    seedSignedMessage(w, SEAT, rep2Id, sentAt, { from: 'owner', root: w.root, home: w.home });

    const sources1 = makeSources();
    reportUnreadDrops(
      {
        dir: w.dir,
        session: SESSION,
        root: w.root,
        home: w.home,
        team,
        live: emptyLive,
        ownPane: null,
        sources: sources1,
        now: passClock,
        say: (text) => {
          said.push(text);
        },
        mail: pass1Mail,
      },
      { unreadAfter: 60 },
    );

    // Pass 1 reported only rep1Id; rep2Id was not falsely reported before a pass could wake it.
    expect(existsSync(reportedPath(dropDir, rep1Id))).toBe(true);
    expect(existsSync(reportedPath(dropDir, rep2Id))).toBe(false);
    expect(said).toHaveLength(1);

    // Pass 2 runs with a fresh MailPass: picks up rep2Id and reports it once, and never reports rep1Id again.
    const pass2Mail = new MailPass({ dir: w.dir, root: w.root, session: SESSION, home: w.home });
    const sources2 = makeSources();
    reportUnreadDrops(
      {
        dir: w.dir,
        session: SESSION,
        root: w.root,
        home: w.home,
        team,
        live: emptyLive,
        ownPane: null,
        sources: sources2,
        now: passClock,
        say: (text) => {
          said.push(text);
        },
        mail: pass2Mail,
      },
      { unreadAfter: 60 },
    );

    expect(existsSync(reportedPath(dropDir, rep1Id))).toBe(true);
    expect(existsSync(reportedPath(dropDir, rep2Id))).toBe(true);
    expect(said).toHaveLength(2);

    // A third pass with both already reported emits no additional report lines.
    const pass3Mail = new MailPass({ dir: w.dir, root: w.root, session: SESSION, home: w.home });
    const sources3 = makeSources();
    reportUnreadDrops(
      {
        dir: w.dir,
        session: SESSION,
        root: w.root,
        home: w.home,
        team,
        live: emptyLive,
        ownPane: null,
        sources: sources3,
        now: passClock,
        say: (text) => {
          said.push(text);
        },
        mail: pass3Mail,
      },
      { unreadAfter: 60 },
    );
    expect(said).toHaveLength(2);
  });

  test('a due message arriving after an empty initial pass scan is still woken in that same pass and never woken twice', async () => {
    const w = makeWorld();
    const teamPath = initGitAndTeamFile(w);
    const loaded = loadTeamFile(w.root, { file: teamPath });
    if (!loaded.ok) throw new Error('expected team config');
    const team = {
      ...loaded.team,
      seats: loaded.team.seats.map((s) =>
        s.name === SEAT ? { ...s, cli: 'muse', watchWake: true } : s,
      ),
    };
    const dropDir = dropDirOf(w, SEAT, SESSION);
    mkdirSync(dropDir, { recursive: true });
    messageKeyOf(w.home);

    const lateOnEmptyScanId = 'e0000000-0000-4000-8000-000000000001';
    const sentAt = '2026-11-05T08:50:00.000Z';
    const passClock = new Date('2026-11-05T09:00:00.000Z'); // 10 min old -> due for N wake (60s)

    // Pass 1 MailPass scans the seat's folder when it is completely empty.
    const pass1Mail = new MailPass({ dir: w.dir, root: w.root, session: SESSION, home: w.home });
    expect(pass1Mail.unread(SEAT)).toEqual([]);

    // Before wakeUnreadDrops reaches the seat, a due message lands in the folder.
    const latePath = seedSignedMessage(w, SEAT, lateOnEmptyScanId, sentAt, {
      from: 'owner',
      root: w.root,
      home: w.home,
    });

    let wakeCalls = 0;
    const liveState = {
      running: true,
      agents: [
        {
          name: SEAT,
          agent: 'muse',
          pane: 'pane-deepseek',
          workspace: 'ws-deepseek',
          status: 'idle',
          cwd: w.root,
        },
      ],
      workspaces: [{ id: 'ws-deepseek', label: SEAT }],
      screens: { 'pane-deepseek': MUSE_IDLE },
    };

    const makeSources = (): WatchSources => ({
      live: () => liveState,
      machine: () => ({
        loadPerCore: 1,
        memoryFree: 50,
        diskFree: 200e9,
        swapTotal: 9e9,
        swapFree: 8e9,
        swapUsed: 1e9,
      }),
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => MUSE_IDLE,
      status: () => 'idle',
      foreground: () => ['muse'],
      typeText: () => true,
      pressEnter: () => true,
      typedWake: async () => {
        wakeCalls += 1;
        return { delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' };
      },
      sleep: async () => {},
      notify: () => {},
      now: () => passClock,
      wait: async () => false,
      alive: () => false,
      pid: 4242,
      home: w.home,
    });

    resetWatchCounters(dropDir);
    await wakeUnreadDrops(
      {
        dir: w.dir,
        session: SESSION,
        root: w.root,
        home: w.home,
        team,
        live: liveState,
        ownPane: null,
        sources: makeSources(),
        now: passClock,
        say: () => {},
        mail: pass1Mail,
      },
      { unreadAfter: 60 },
    );

    // Even though pass1Mail.unread(SEAT) was empty, wakeUnreadDrops checked the folder with
    // pass1Mail.recordAt, woke the seat in Pass 1, and wrote the wake marker. Both fresh and
    // freshNow shared pass1Mail.recordAt (1 open) plus payloadOf (1 open) = 2 opens total.
    expect(wakeCalls).toBe(1);
    expect(existsSync(wakePath(dropDir, lateOnEmptyScanId))).toBe(true);
    expect(opensOf(latePath)).toBe(2);

    // Pass 2 sees the wake marker and does not wake the seat a second time.
    const pass2Mail = new MailPass({ dir: w.dir, root: w.root, session: SESSION, home: w.home });
    await wakeUnreadDrops(
      {
        dir: w.dir,
        session: SESSION,
        root: w.root,
        home: w.home,
        team,
        live: liveState,
        ownPane: null,
        sources: makeSources(),
        now: passClock,
        say: () => {},
        mail: pass2Mail,
      },
      { unreadAfter: 60 },
    );
    expect(wakeCalls).toBe(1);
  });
});
