// The durability boundary under an uncertain append, driven through the instrumented filesystem
// the ingester actually uses. Bun 1.4.2 binds a named import to the function it found at import
// time, so the fault is installed on `node:fs/promises` before the ingester is imported, and every
// scene proves the wrap sat in the ingester's own `open` call (the `intercepted` counter) before
// trusting a zero. Only the daemon's append handle is touched: the line's write is allowed to land
// while the append is reported failed, or a fragment of it is written before the write throws.
//
// The property each scene asserts is the log's at-most-once rule stated in the source: an event
// that may already be in the log must not be appended a second time on retry, and the log must stay
// a parseable sequence a restarted daemon can load. No assertion here is weaker than that.
import { afterEach, expect, mock, test } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PresenceLogLine } from '../src/daemon/presence/contract.ts';

const real = await import('node:fs/promises');
const realOpen = real.open;
type Arm = 'fsync-fails' | 'partial-write';
let arm: Arm | null = null;
let intercepted = 0;

mock.module('node:fs/promises', () => ({
  ...real,
  open: (async (...args: unknown[]) => {
    const handle = (await (realOpen as unknown as (...rest: unknown[]) => Promise<Record<string, unknown>>)(
      ...args,
    )) as unknown as Record<string, unknown>;
    const path = String(args[0]);
    const flags = args[1];
    if (arm !== null && flags === 'a' && path.endsWith('events.jsonl')) {
      const mode = arm;
      arm = null;
      intercepted += 1;
      if (mode === 'fsync-fails') {
        // The write lands; the fsync that would make it durable throws.
        handle.sync = async (): Promise<void> => {
          throw new Error('injected: the append could not be fsynced');
        };
      } else {
        // Part of the line is written, then the write reports failure.
        const write = (handle.write as (...rest: unknown[]) => Promise<unknown>).bind(handle);
        handle.write = async (data: unknown): Promise<void> => {
          await write(String(data).slice(0, 40));
          throw new Error('injected: the append stopped after part of its line');
        };
      }
    }
    return handle;
  }) as unknown as typeof real.open,
}));

const { presenceId, readPresenceLogLine } = await import('../src/daemon/presence/contract.ts');
const { createPresenceIngester } = await import('../src/daemon/presence/ingest.ts');
const { presencePaths, stagePresenceRecord } = await import('../src/daemon/presence/spool.ts');
const { readPresenceChannel, readPresenceCurrent, readPresenceTransitions } = await import(
  '../src/daemon/presence/read.ts'
);
const { STATE_FILE } = await import('../src/state.ts');

const SESSION = 'teamcli';
const SEAT = 'builder-7';
const BINDING = 'prs_0123456789ab';
const CLOCK = Date.parse('2026-10-20T03:00:00Z');
function at(secondsAgo: number): string {
  return new Date(CLOCK - secondsAgo * 1000).toISOString();
}

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  arm = null;
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch { /* one failed cleanup must not hide another */ }
  }
  cleanups = [];
});

function makeWorld(): { stateDir: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-presence-append-')));
  const stateDir = join(base, '.agents');
  mkdirSync(stateDir);
  const path = join(stateDir, STATE_FILE);
  writeFileSync(path, JSON.stringify({
    format: 1,
    sessions: { [SESSION]: { seats: { [SEAT]: { stage: 'ready', presence_binding: BINDING } }, worktrees: {} } },
  }));
  const stamp = new Date(1700000000000);
  utimesSync(path, stamp, stamp);
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return { stateDir };
}

function pathsOf(stateDir: string) {
  const paths = presencePaths(stateDir, SESSION, SEAT);
  if (paths === null) throw new Error('the scene seat cannot name a presence folder');
  return paths;
}

function spoolNames(stateDir: string): string[] {
  const folder = pathsOf(stateDir).spool;
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

function logText(stateDir: string): string {
  const path = pathsOf(stateDir).log;
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function ingesterFor(stateDir: string) {
  const ingester = createPresenceIngester({ stateDir, session: SESSION, now: () => new Date(CLOCK) });
  cleanups.push(async () => {
    if (!ingester.isClosed()) await ingester.close();
  });
  return ingester;
}

let nonceCounter = 0;
function stage(stateDir: string): { id: string; ts: string } {
  const ts = at(30);
  nonceCounter += 1;
  const id = presenceId(ts, nonceCounter.toString(16).padStart(8, '0'));
  if (id === null) throw new Error('the scene supplied an invalid instant');
  const staged = stagePresenceRecord(stateDir, {
    session: SESSION, seat: SEAT, binding: BINDING, source: 'runtime-hook', event: 'turn-start', ts, id,
  });
  if (staged.kind !== 'staged') throw new Error(staged.why);
  return { id, ts };
}

type Observations = {
  stateDir: string;
  id: string;
  rawAfterRetry: string;
  parsed: Array<PresenceLogLine | { why: string }>;
  readableIds: string[];
  spoolAfterRetry: string[];
  reloadErrors: string[];
  channelState: string | null;
  feedKind: string;
  feedIds: string[];
  projectionId: string | null;
};

/** Drives one uncertain append and its retry, then a restart, without asserting: each test names
 *  the property it measures on the same observations. */
async function uncertainAppend(mode: Arm): Promise<Observations> {
  const world = makeWorld();
  const ingester = ingesterFor(world.stateDir);
  const staged = stage(world.stateDir);
  const before = intercepted;
  arm = mode;
  const first = await ingester.step();
  // The positive control: the injected fault sat in this ingester's own append call.
  expect(intercepted - before).toBe(1);
  expect(first.errors.some((entry) => entry.why.includes('log append failed'))).toBe(true);
  // The retry runs with the fault disarmed and no live step left behind.
  await ingester.step();
  const rawAfterRetry = logText(world.stateDir);
  const parsed = rawAfterRetry.split('\n').filter((text) => text !== '').map((text) => readPresenceLogLine(text));
  const readableIds = parsed.flatMap((line) => ('why' in line ? [] : [line.id]));
  const spoolAfterRetry = spoolNames(world.stateDir);
  await ingester.close();

  const next = ingesterFor(world.stateDir);
  const reload = await next.step();
  const channel = await readPresenceChannel(world.stateDir, SESSION);
  const feed = await readPresenceTransitions({ stateDir: world.stateDir, session: SESSION, seat: SEAT });
  const projection = await readPresenceCurrent(world.stateDir, SESSION, SEAT);
  return {
    stateDir: world.stateDir,
    id: staged.id,
    rawAfterRetry,
    parsed,
    readableIds,
    spoolAfterRetry,
    reloadErrors: reload.errors.map((entry) => entry.why),
    channelState: channel.kind === 'ok' ? channel.value.state : null,
    feedKind: feed.kind,
    feedIds: feed.kind === 'ok' ? feed.transitions.map((line) => line.id) : [],
    projectionId: projection.kind === 'ok' ? projection.value.id : null,
  };
}

test('a write that landed before its fsync failed is appended once, and the log stays parseable', async () => {
  const seen = await uncertainAppend('fsync-fails');
  // The precondition, measured: the first attempt did write a complete line and kept the record.
  expect(seen.rawAfterRetry.endsWith('\n')).toBe(true);
  expect(seen.spoolAfterRetry).toEqual([]);
  // Every line in the log is a line this build can read, and the event appears exactly once.
  expect(seen.parsed.every((line) => !('why' in line))).toBe(true);
  expect(seen.readableIds.filter((id) => id === seen.id)).toHaveLength(1);
  expect(seen.projectionId).toBe(seen.id);
});

test('a retry after a written-but-unfsynced append leaves a log a restarted daemon can load and serve', async () => {
  const seen = await uncertainAppend('fsync-fails');
  // A restart loads the log rather than faulting on it, and the channel serves.
  expect(seen.reloadErrors).toEqual([]);
  expect(seen.channelState).toBe('serving');
  // The feed a consumer walks carries the event once, with a resumable sequence.
  expect(seen.feedKind).toBe('ok');
  expect(seen.feedIds.filter((id) => id === seen.id)).toHaveLength(1);
});

test('a partially written line is repaired before the retry appends, leaving no unreadable bytes', async () => {
  const seen = await uncertainAppend('partial-write');
  // The first attempt left a fragment; the retry must not append onto it.
  expect(seen.parsed.every((line) => !('why' in line))).toBe(true);
  expect(seen.readableIds.filter((id) => id === seen.id)).toHaveLength(1);
  expect(seen.spoolAfterRetry).toEqual([]);
  expect(seen.projectionId).toBe(seen.id);
});

test('a retry after a partial append leaves a log a restarted daemon can load and serve', async () => {
  const seen = await uncertainAppend('partial-write');
  expect(seen.reloadErrors).toEqual([]);
  expect(seen.channelState).toBe('serving');
  expect(seen.feedKind).toBe('ok');
  expect(seen.feedIds.filter((id) => id === seen.id)).toHaveLength(1);
});
