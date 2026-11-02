// A send whose record is already durable never waits on the bus event log either: the drop leg is
// always the last, so every drop send writes an all-failed intent into its marker. When another
// process holds the store's event lock, the send leaves that intent standing and returns; the
// sweep emits it on the tick after the lock frees, exactly once. The old path waited the lock's
// whole default budget (5000 ms) inside the send, between the drop attempt and the marker and
// .pending writes.
//
// A crash between the append and the publication ledger leaves the marker's intent standing with
// the event already in the log. The next pass re-appends the same deterministic record id, and
// the log's own dedupe on (kind, record_id, session) keeps it one event without the ledger.
//
// The world is a synthetic team under a temp folder; the lock's holder is a real second process,
// so the contention is the one a live send meets rather than a simulated flag.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { eventLogPath } from '../src/bus/log.ts';
import { runSend } from '../src/commands/send.ts';
import { sweepFallbackEscalations } from '../src/daemon/fallback-sweep.ts';
import { historyPath } from '../src/send/history.ts';
import { dropDir, fake, owner, world, type World } from './send-native-fixtures.ts';

const MSG = '6f1d7a2c-3b4e-4c5d-8e9f-0a1b2c3d4e5f';

const worlds: World[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const made of worlds.splice(0)) made.cleanup();
});

function seatWorld(): World {
  const made = world(['drop'], [{ name: 'iris', role: 'remote' }]);
  worlds.push(made);
  return made;
}

/** The store folder holding the event log and its lock, the same derivation the send uses. */
function storeDirOf(made: World): string {
  return dirname(historyPath('acme', made.root, made.home));
}

/** A real second process that takes the store's event lock and holds it until told to release. */
const HOLDER_SOURCE = (stateModule: string): string => `import { existsSync, writeFileSync } from 'node:fs';
import { withLock } from ${JSON.stringify(stateModule)};

const [lockDir, readyPath, releasePath] = process.argv.slice(2);
withLock(
  lockDir,
  () => {
    writeFileSync(readyPath, 'held\\n');
    const deadline = Date.now() + 10_000;
    while (!existsSync(releasePath) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  },
  { waitMs: 5_000 },
);
`;

function holdEventLock(made: World): { readyPath: string; releasePath: string; exit: Promise<number> } {
  const base = dirname(made.root);
  const scriptPath = join(base, 'hold-event-lock.ts');
  const readyPath = join(base, 'event-holder.ready');
  const releasePath = join(base, 'event-holder.release');
  writeFileSync(scriptPath, HOLDER_SOURCE(join(import.meta.dir, '..', 'src', 'state.ts')));
  const child = Bun.spawn([process.execPath, scriptPath, join(storeDirOf(made), 'locks', 'events'), readyPath, releasePath], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  children.push(child);
  return { readyPath, releasePath, exit: child.exited };
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the condition did not hold before the deadline');
}

/** The whole event log this checkout has, or the empty string when none was ever written. */
function eventLogText(made: World): string {
  const path = eventLogPath('acme', made.root, made.home);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** The exhaustion records in the log; exactly one is the episode's. */
function heldEventCount(made: World): number {
  return eventLogText(made)
    .split('\n')
    .filter((line) => line.includes('"kind":"message.held"')).length;
}

type Marker = {
  status: string;
  attempts: unknown[];
  allFailedAt?: string;
  outbox?: { kind: string };
};

function markerOf(made: World, messageId: string): Marker {
  return JSON.parse(readFileSync(join(dropDir(made.dir, 'iris'), `${messageId}.fallback.json`), 'utf8')) as Marker;
}

/** The episode's publication ledger files in the store: one per episode, written after the append
 *  and never rotated. */
function publicationLedgers(made: World): string[] {
  return readdirSync(storeDirOf(made)).filter(
    (name) => name.startsWith('fallback-published-') && name.endsWith('.jsonl'),
  );
}

describe('a drop send never waits on the bus event lock', () => {
  test('an event lock held by another process leaves the intent standing; the sweep emits it once', async () => {
    const made = seatWorld();
    const holder = holdEventLock(made);
    // The holder is ready before the send starts: the send's first exhaustion always meets it.
    await until(() => existsSync(holder.readyPath));

    const io = owner(made.root);
    const started = performance.now();
    const code = await runSend(['iris', 'the gate is green'], io, fake(made, { sendId: () => MSG }));
    const elapsed = performance.now() - started;

    expect(code, io.err).toBe(0);
    // The lock was still held when the send returned, and the wait the old path made (the
    // holder's whole 10 s budget) is what this bound excludes.
    expect(existsSync(holder.releasePath)).toBe(false);
    expect(elapsed).toBeLessThan(1000);
    expect(io.err).not.toContain('the fallback attempt was not recorded');

    const dir = dropDir(made.dir, 'iris');
    // The drop is taken: the record, the pending copy and the history line are all on disk.
    expect(existsSync(join(dir, MSG))).toBe(true);
    expect(existsSync(join(dir, `${MSG}.pending`))).toBe(true);
    expect(existsSync(join(dir, `${MSG}.fallback.json`))).toBe(true);
    expect(readFileSync(historyPath('acme', made.root, made.home), 'utf8')).toContain('"via":"drop"');

    // The intent is the durable record of the event that has not gone out yet.
    const held = markerOf(made, MSG);
    expect(held.status).toBe('all-failed');
    expect(held.attempts).toHaveLength(1);
    expect(held.allFailedAt).toBeDefined();
    expect(held.outbox?.kind).toBe('all-failed');
    expect(heldEventCount(made)).toBe(0);

    // A sweep beside the still-live holder reports the episode as deferred, not refused, and
    // appends nothing; the marker keeps its intent.
    const allFailedAt = held.allFailedAt as string;
    const busy = new Date(Date.parse(allFailedAt) + 1000);
    const deferred = sweepFallbackEscalations({ home: made.home, roots: [made.root], now: () => busy });
    expect(deferred.roots[0]!.why).toBeNull();
    expect(deferred.roots[0]!.report!.deferred).toHaveLength(1);
    expect(deferred.roots[0]!.report!.refused).toHaveLength(0);
    expect(deferred.roots[0]!.report!.escalated).toHaveLength(0);
    expect(heldEventCount(made)).toBe(0);
    expect(markerOf(made, MSG).outbox?.kind).toBe('all-failed');

    // Release the lock; the next tick emits the intent exactly once and clears it.
    writeFileSync(holder.releasePath, 'release\n');
    await holder.exit;
    const after = new Date(Date.parse(allFailedAt) + 2000);
    const swept = sweepFallbackEscalations({ home: made.home, roots: [made.root], now: () => after });
    expect(swept.roots[0]!.why).toBeNull();
    expect(swept.roots[0]!.report!.deferred).toHaveLength(0);
    expect(swept.roots[0]!.report!.refused).toHaveLength(0);
    expect(heldEventCount(made)).toBe(1);
    const emitted = markerOf(made, MSG);
    expect(emitted.outbox).toBeUndefined();
    expect(emitted.status).toBe('all-failed');

    // A second pass finds nothing to emit: the marker, not the log's retention, is the record.
    const again = sweepFallbackEscalations({ home: made.home, roots: [made.root], now: () => after });
    expect(again.roots[0]!.why).toBeNull();
    expect(heldEventCount(made)).toBe(1);
  });

  test('with a free event lock the exhaustion event still goes out inside the send', async () => {
    const made = seatWorld();
    const io = owner(made.root);
    const code = await runSend(['iris', 'the gate is green'], io, fake(made, { sendId: () => MSG }));
    expect(code, io.err).toBe(0);

    // No intent is left for a later pass: the send emitted it and cleared it.
    const marker = markerOf(made, MSG);
    expect(marker.status).toBe('all-failed');
    expect(marker.outbox).toBeUndefined();
    expect(heldEventCount(made)).toBe(1);
  });

  test('a crash between the append and the publication ledger dedupes on the log alone', async () => {
    const made = seatWorld();
    const holder = holdEventLock(made);
    await until(() => existsSync(holder.readyPath));

    const io = owner(made.root);
    const code = await runSend(['iris', 'the gate is green'], io, fake(made, { sendId: () => MSG }));
    expect(code, io.err).toBe(0);
    const path = join(dropDir(made.dir, 'iris'), `${MSG}.fallback.json`);
    // The marker as a crash in the flush leaves it: the intent written, the append about to land.
    const crashState = readFileSync(path, 'utf8');
    const allFailedAt = markerOf(made, MSG).allFailedAt as string;
    expect(markerOf(made, MSG).outbox?.kind).toBe('all-failed');

    // The first pass appends the event and then records it in the publication ledger.
    writeFileSync(holder.releasePath, 'release\n');
    await holder.exit;
    const at = new Date(Date.parse(allFailedAt) + 2000);
    const swept = sweepFallbackEscalations({ home: made.home, roots: [made.root], now: () => at });
    expect(swept.roots[0]!.why).toBeNull();
    expect(heldEventCount(made)).toBe(1);
    const ledgers = publicationLedgers(made);
    expect(ledgers).toHaveLength(1);
    // The deterministic record id the episode published under: the retry must reach the log
    // under this same id, so the log's dedupe sees the event it already holds.
    const published = JSON.parse(
      readFileSync(join(storeDirOf(made), ledgers[0]!), 'utf8').trim(),
    ) as { recordId: string; kind: string };
    expect(published.kind).toBe('all-failed');
    expect(published.recordId).not.toBe('');

    // The crash lands between the two writes: the append is in the log, the ledger was never
    // written, and the marker still carries its intent. Restoring the marker and removing the
    // ledger is exactly that state.
    rmSync(join(storeDirOf(made), ledgers[0]!), { force: true });
    writeFileSync(path, crashState);

    // The next pass has only the event log's own dedupe on (kind, record_id, session) to go on:
    // it re-appends the same deterministic record id, the log answers duplicate rather than
    // writing a second line, and the episode still stands as one event.
    const recovered = sweepFallbackEscalations({ home: made.home, roots: [made.root], now: () => at });
    expect(recovered.roots[0]!.why).toBeNull();
    expect(recovered.roots[0]!.report!.refused).toHaveLength(0);
    expect(heldEventCount(made)).toBe(1);
    expect(markerOf(made, MSG).outbox).toBeUndefined();
    // The retry reached the log under the same record id, and the log kept its one line for it.
    const withId = eventLogText(made)
      .split('\n')
      .filter((line) => line.includes(`"record_id":"${published.recordId}"`));
    expect(withId).toHaveLength(1);
    // The ledger the crash never wrote is written now, from the record the log already holds.
    const rewrote = publicationLedgers(made);
    expect(rewrote).toHaveLength(1);
    const recoveredLine = JSON.parse(readFileSync(join(storeDirOf(made), rewrote[0]!), 'utf8').trim()) as { recordId: string };
    expect(recoveredLine.recordId).toBe(published.recordId);

    // And a pass after that finds nothing left to do: the intent is gone and retention has not
    // been asked to remember anything.
    const settled = sweepFallbackEscalations({ home: made.home, roots: [made.root], now: () => at });
    expect(settled.roots[0]!.why).toBeNull();
    expect(heldEventCount(made)).toBe(1);
  });
});
