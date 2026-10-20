// The durable idle-episode claim store: capture before any push, one capture per episode under
// the state lock, a settle fenced by the capture's claim id, and an end that only releases seats
// the reading no longer counts. A malformed record is a hold, never an absence; a held or empty
// lock is refused untouched; a state file that cannot be read fails closed. The last case is the
// real two-process capture: two processes race one episode and exactly one of them wins.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptySession, LOCK_FILE, STATE_FILE, readState, updateState } from '../src/state.ts';
import { captureIdleClaim, endIdleClaims, settleIdleClaim } from '../src/watch/claim.ts';
import { CLAIM_ID_PATTERN, isIdleClaim, type IdleClaimEntry } from '../src/watch/claim-record.ts';

const T0 = Date.parse('2026-10-20T03:00:00.000Z');
const SINCE = new Date(T0 - 10 * 60_000).toISOString();
const SINCE_2 = new Date(T0 - 5 * 60_000).toISOString();
const at = (ms: number): Date => new Date(ms);
const iso = (ms: number): string => new Date(ms).toISOString();

let dir = '';
let agents = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watch-claim-'));
  agents = join(dir, '.agents');
  mkdirSync(agents, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedSeat(seat: string, lastActive: string, session = 'crew'): void {
  updateState(agents, (state) => {
    const one = (state.sessions[session] ??= emptySession());
    one.seats[seat] = { stage: 'ready', last_active: lastActive };
  });
}

/** Writes one session record by hand, as another writer or an older build could have left it. */
function writeRaw(session: unknown): void {
  writeFileSync(join(agents, STATE_FILE), JSON.stringify({ format: 1, sessions: { crew: session } }));
}

function stored(seat = 'worker-1', session = 'crew'): IdleClaimEntry | undefined {
  return readState(agents).sessions[session]?.idle_claims?.[seat];
}

function capture(seat = 'worker-1', idleSince = SINCE, atMs = T0) {
  return captureIdleClaim(agents, { session: 'crew', seat, idle_since: idleSince, at: at(atMs) });
}

function holdLock(contents = '1\n'): void {
  writeFileSync(join(agents, LOCK_FILE), contents);
}

describe('capture', () => {
  test('captures one claim per episode, minted with its own fence, and holds the second capture', () => {
    seedSeat('worker-1', SINCE);
    const first = capture();
    expect(first.kind).toBe('captured');
    if (first.kind !== 'captured') return;
    expect(first.claim.claim_id).toMatch(CLAIM_ID_PATTERN);
    expect(first.claim).toEqual({
      claim_id: first.claim.claim_id,
      idle_since: SINCE,
      state: 'pending',
      claimed_at: iso(T0),
    });
    expect(stored()).toEqual(first.claim);

    const second = capture('worker-1', SINCE, T0 + 1_000);
    expect(second.kind).toBe('held');
    if (second.kind !== 'held') return;
    expect(isIdleClaim(second.entry) && second.entry.claim_id).toBe(first.claim.claim_id);
    // A held capture writes nothing.
    expect(stored()).toEqual(first.claim);
  });

  test('an earlier episode is a new episode: a moved last_active replaces the claim', () => {
    seedSeat('worker-1', SINCE);
    const first = capture();
    expect(first.kind).toBe('captured');
    if (first.kind !== 'captured') return;
    seedSeat('worker-1', SINCE_2);
    const second = capture('worker-1', SINCE_2, T0 + 2_000);
    expect(second.kind).toBe('captured');
    if (second.kind !== 'captured') return;
    expect(second.claim.claim_id).not.toBe(first.claim.claim_id);
    expect(stored()).toMatchObject({ idle_since: SINCE_2, state: 'pending', claim_id: second.claim.claim_id });
  });

  test('the last_active recheck is exact: the same instant in another spelling is stale', () => {
    // The reading's stamp is the stored string; a capture whose `idle_since` names the same
    // instant but not the same bytes is a snapshot the file no longer supports.
    seedSeat('worker-1', '2026-10-20T02:50:00+00:00');
    const result = captureIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: '2026-10-20T02:50:00.000Z', at: at(T0),
    });
    expect(result.kind).toBe('stale');
    expect(stored()).toBeUndefined();
  });

  test('a malformed claim is a hold, and the file it came from is not rewritten', () => {
    writeRaw({
      seats: { 'worker-1': { stage: 'ready', last_active: SINCE } },
      worktrees: {},
      idle_claims: { 'worker-1': { state: 'pending', claim_id: 'not-a-fence' } },
    });
    const before = readFileSync(join(agents, STATE_FILE), 'utf8');
    const result = capture();
    expect(result.kind).toBe('held');
    if (result.kind !== 'held') return;
    expect(result.entry).toEqual({ unreadable: true });
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe(before);
  });

  test('an idle_claims map that is not a map holds every seat the session records', () => {
    writeRaw({
      seats: {
        'worker-1': { stage: 'ready', last_active: SINCE },
        'worker-2': { stage: 'ready', last_active: SINCE },
      },
      worktrees: {},
      idle_claims: 'soon',
    });
    expect(readState(agents).sessions.crew?.idle_claims).toEqual({
      'worker-1': { unreadable: true },
      'worker-2': { unreadable: true },
    });
    expect(capture().kind).toBe('held');
    expect(capture('worker-2').kind).toBe('held');
  });

  test('a held lock captures nothing, and a fresh empty lock keeps its inode and bytes', () => {
    seedSeat('worker-1', SINCE);
    const path = join(agents, LOCK_FILE);
    writeFileSync(path, '');
    const before = statSync(path);
    expect(capture().kind).toBe('busy');
    const after = statSync(path);
    expect(after.ino).toBe(before.ino);
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(stored()).toBeUndefined();

    holdLock();
    expect(capture().kind).toBe('busy');
    expect(readFileSync(path, 'utf8')).toBe('1\n');
  });
});

describe('settle', () => {
  function captured(): string {
    const result = capture();
    if (result.kind !== 'captured') throw new Error(`expected a capture, got ${result.kind}`);
    return result.claim.claim_id;
  }

  test('settles only the capture it names: a wrong fence or episode changes nothing', () => {
    seedSeat('worker-1', SINCE);
    const claimId = captured();
    const wrongFence = settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE, claim_id: '0'.repeat(16),
      at: at(T0 + 1_000), outcome: 'accepted',
    });
    expect(wrongFence.kind).toBe('gone');
    const wrongEpisode = settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE_2, claim_id: claimId,
      at: at(T0 + 1_000), outcome: 'accepted',
    });
    expect(wrongEpisode.kind).toBe('gone');
    const pending = stored();
    expect(pending).toMatchObject({ claim_id: claimId, state: 'pending' });
    if (!isIdleClaim(pending)) throw new Error('expected a claim');
    expect(pending.wake_at).toBeUndefined();

    const accepted = settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE, claim_id: claimId,
      at: at(T0 + 2_000), outcome: 'accepted',
    });
    expect(accepted.kind).toBe('settled');
    expect(stored()).toMatchObject({ state: 'inflight', wake_at: iso(T0 + 2_000) });
    // The transition is guarded: once accepted, the same fence cannot settle it again.
    expect(settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE, claim_id: claimId,
      at: at(T0 + 3_000), outcome: 'refused',
    }).kind).toBe('gone');
    expect(stored()).toMatchObject({ state: 'inflight' });
  });

  test('a refused route keeps its notice, and a missed pickup keeps the stalled one', () => {
    seedSeat('worker-1', SINCE);
    const claimId = captured();
    const refused = settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE, claim_id: claimId,
      at: at(T0 + 1_000), outcome: 'refused',
    });
    expect(refused.kind).toBe('settled');
    expect(stored()).toMatchObject({ state: 'refused', notice: 'refused', claimed_at: iso(T0) });

    seedSeat('worker-1', SINCE_2);
    const second = capture('worker-1', SINCE_2, T0 + 2_000);
    if (second.kind !== 'captured') throw new Error('expected a capture');
    settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE_2, claim_id: second.claim.claim_id,
      at: at(T0 + 3_000), outcome: 'accepted',
    });
    const missed = settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE_2, claim_id: second.claim.claim_id,
      at: at(T0 + 63_000), outcome: 'pickup', claimed: false,
    });
    expect(missed.kind).toBe('settled');
    expect(stored()).toMatchObject({ state: 'done', notice: 'stalled', wake_at: iso(T0 + 3_000) });

    // A pickup that found evidence keeps no notice.
    seedSeat('worker-1', SINCE);
    const third = capture('worker-1', SINCE, T0 + 4_000);
    if (third.kind !== 'captured') throw new Error('expected a capture');
    settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE, claim_id: third.claim.claim_id,
      at: at(T0 + 5_000), outcome: 'accepted',
    });
    settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE, claim_id: third.claim.claim_id,
      at: at(T0 + 65_000), outcome: 'pickup', claimed: true,
    });
    const kept = stored();
    expect(kept).toMatchObject({ state: 'done' });
    if (!isIdleClaim(kept)) throw new Error('expected a claim');
    expect(kept.notice).toBeUndefined();
  });

  test('an unknown outcome keeps the claim pending with its notice, and is written once', () => {
    seedSeat('worker-1', SINCE);
    const claimId = captured();
    const first = settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE, claim_id: claimId,
      at: at(T0 + 61_000), outcome: 'unknown',
    });
    expect(first.kind).toBe('settled');
    if (first.kind !== 'settled') return;
    expect(first.changed).toBe(true);
    expect(stored()).toMatchObject({ state: 'pending', notice: 'unknown' });
    const again = settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE, claim_id: claimId,
      at: at(T0 + 62_000), outcome: 'unknown',
    });
    expect(again.kind).toBe('settled');
    if (again.kind !== 'settled') return;
    expect(again.changed).toBe(false);
    expect(stored()).toMatchObject({ state: 'pending', notice: 'unknown' });
  });

  test('a late settle after the episode ended and a new capture began changes nothing', () => {
    seedSeat('worker-1', SINCE);
    const first = captured();
    // The seat leaves the reading and comes back with the same persisted clock: the end removes
    // the claim, and the new capture mints a different fence for the same stamp.
    expect(endIdleClaims(agents, { session: 'crew', current: [] })).toEqual({ kind: 'ended', removed: 1 });
    const second = capture('worker-1', SINCE, T0 + 1_000);
    if (second.kind !== 'captured') throw new Error('expected a capture');
    expect(second.claim.claim_id).not.toBe(first);

    const late = settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE, claim_id: first,
      at: at(T0 + 2_000), outcome: 'accepted',
    });
    expect(late.kind).toBe('gone');
    expect(stored()).toEqual(second.claim);

    const current = settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE, claim_id: second.claim.claim_id,
      at: at(T0 + 3_000), outcome: 'accepted',
    });
    expect(current.kind).toBe('settled');
    expect(stored()).toMatchObject({ state: 'inflight', wake_at: iso(T0 + 3_000) });
  });

  test('a settle under a held lock is refused and leaves the claim pending', () => {
    seedSeat('worker-1', SINCE);
    const claimId = captured();
    holdLock();
    const result = settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE, claim_id: claimId,
      at: at(T0 + 1_000), outcome: 'accepted',
    });
    expect(result.kind).toBe('busy');
    expect(readFileSync(join(agents, LOCK_FILE), 'utf8')).toBe('1\n');
    expect(stored()).toMatchObject({ claim_id: claimId, state: 'pending' });
  });
});

describe('end', () => {
  test('ends only the seats the reading no longer counts, and writes nothing otherwise', () => {
    seedSeat('worker-1', SINCE);
    seedSeat('worker-2', SINCE);
    expect(capture().kind).toBe('captured');
    expect(capture('worker-2').kind).toBe('captured');
    const file = join(agents, STATE_FILE);
    const before = statSync(file);

    const kept = endIdleClaims(agents, {
      session: 'crew',
      current: [{ seat: 'worker-1', idle_since: SINCE }, { seat: 'worker-2', idle_since: SINCE }],
    });
    expect(kept).toEqual({ kind: 'ended', removed: 0 });
    // Nothing was written: the state file keeps its inode.
    expect(statSync(file).ino).toBe(before.ino);

    const removed = endIdleClaims(agents, { session: 'crew', current: [{ seat: 'worker-1', idle_since: SINCE }] });
    expect(removed).toEqual({ kind: 'ended', removed: 1 });
    expect(stored('worker-1')).toBeDefined();
    expect(stored('worker-2')).toBeUndefined();
  });

  test('preserves an unreadable claim while its seat remains eligible', () => {
    writeRaw({
      seats: { 'worker-1': { stage: 'ready', last_active: SINCE } },
      worktrees: {},
      idle_claims: { 'worker-1': { claim_id: 'short', state: 'done' } },
    });
    const before = readFileSync(join(agents, STATE_FILE), 'utf8');
    expect(endIdleClaims(agents, {
      session: 'crew', current: [{ seat: 'worker-1', idle_since: SINCE }],
    })).toEqual({ kind: 'ended', removed: 0 });
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe(before);
    expect(stored()).toEqual({ unreadable: true });
    // Leaving the reading releases it.
    expect(endIdleClaims(agents, { session: 'crew', current: [] })).toEqual({ kind: 'ended', removed: 1 });
    expect(stored()).toBeUndefined();
  });

  test('an empty lock is refused untouched, and an unreadable state file fails closed', () => {
    seedSeat('worker-1', SINCE);
    const lock = join(agents, LOCK_FILE);
    writeFileSync(lock, '');
    const empty = statSync(lock);
    expect(endIdleClaims(agents, { session: 'crew', current: [] }).kind).toBe('busy');
    expect(statSync(lock).ino).toBe(empty.ino);
    expect(readFileSync(lock, 'utf8')).toBe('');
    unlinkSync(lock);

    writeFileSync(join(agents, STATE_FILE), '{half');
    expect(capture().kind).toBe('failed');
    expect(settleIdleClaim(agents, {
      session: 'crew', seat: 'worker-1', idle_since: SINCE, claim_id: '0'.repeat(16),
      at: at(T0), outcome: 'accepted',
    }).kind).toBe('failed');
    expect(endIdleClaims(agents, { session: 'crew', current: [] }).kind).toBe('failed');
    expect(readFileSync(join(agents, STATE_FILE), 'utf8')).toBe('{half');
  });
});

describe('two processes', () => {
  test('capturing one episode from two processes yields exactly one winner', async () => {
    seedSeat('worker-1', SINCE);
    const moduleUrl = new URL('../src/watch/claim.ts', import.meta.url).href;
    const script = join(dir, 'capture-child.ts');
    writeFileSync(script, `
import { captureIdleClaim } from ${JSON.stringify(moduleUrl)};
const [agents, startAt, since] = [process.argv[2], Number(process.argv[3]), process.argv[4]];
while (Date.now() < startAt) {}
const result = captureIdleClaim(agents, { session: 'crew', seat: 'worker-1', idle_since: since, at: new Date(startAt) });
console.log(JSON.stringify(result));
`);
    const startAt = Date.now() + 400;
    const spawn = () => Bun.spawn([process.execPath, 'run', script, agents, String(startAt), SINCE]);
    const [a, b] = [spawn(), spawn()];
    const [textA, textB] = await Promise.all([
      new Response(a.stdout).text(),
      new Response(b.stdout).text(),
      a.exited,
      b.exited,
    ]);
    const results = [textA, textB].map((text) => JSON.parse(text.trim()) as { kind: string; claim?: { claim_id: string } });
    const winners = results.filter((one) => one.kind === 'captured');
    expect(winners).toHaveLength(1);
    expect(results.every((one) => ['captured', 'held', 'busy'].includes(one.kind))).toBe(true);
    const winner = winners[0]!.claim!;
    expect(stored()).toEqual({
      claim_id: winner.claim_id,
      idle_since: SINCE,
      state: 'pending',
      claimed_at: new Date(startAt).toISOString(),
    });

    // A later process reads the same claim and is held, never a second capture.
    const later = Bun.spawnSync([process.execPath, 'run', script, agents, '0', SINCE]);
    const result = JSON.parse(later.stdout.toString().trim()) as { kind: string };
    expect(result.kind).toBe('held');
  });
});
