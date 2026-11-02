// A send whose record is already durable never waits on the bus event log either: the drop leg is
// always the last, so every drop send writes an all-failed intent into its marker. When another
// process holds the store's event lock, the send leaves that intent standing and returns; the
// sweep emits it on the tick after the lock frees, exactly once. The old path waited the lock's
// whole default budget (5000 ms) inside the send, between the drop attempt and the marker and
// .pending writes.
//
// The world is a synthetic team under a temp folder; the lock's holder is a real second process,
// so the contention is the one a live send meets rather than a simulated flag.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
});
