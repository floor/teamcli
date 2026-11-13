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
});
