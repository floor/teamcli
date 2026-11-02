// A send whose record is already durable never waits on its episode's key: when another process
// holds the key, the attempt is written whole beside the record and the send returns at once. The
// chore pass records the note later, under the same key, and the episode is exactly what it would
// have been — one attempt line, one exhaustion, one scheduled escalation. A note replayed after
// its drain landed records nothing twice.
//
// The world is a synthetic team under a temp folder; the key's other holder is a real second
// process, so the contention is the one a live send meets rather than a simulated flag.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { sweepFallbackEscalations } from '../src/daemon/fallback-sweep.ts';
import { fallbackKeyOf } from '../src/send/fallback-events.ts';
import { historyPath } from '../src/send/history.ts';
import { dropDir, fake, owner, world, type World } from './send-native-fixtures.ts';

const MSG = '0f8fad5b-d9cb-469f-a165-70867728950e';
const CONFIG = '2026-10-05T04:00:00.000Z';

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

/** The module's key-lock folder for this episode: `fallback-<16 hex of the canonical key>`, the
 *  same derivation `withKeyLock` takes. A drift here must fail the scene loudly, not silently
 *  hold some other lock — so the drain's own report is asserted to see this episode. */
function lockDirOf(made: World): string {
  const recipient = { team: 'acme', seat: 'iris', toId: null, session: 'acme', root: made.root };
  const digest = createHash('sha256').update(fallbackKeyOf(recipient, MSG)).digest('hex').slice(0, 16);
  return join(dirname(historyPath('acme', made.root, made.home)), 'locks', `fallback-${digest}`);
}

/** A real second process that takes the episode's key and holds it until told to release. */
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

function holdEpisodeKey(made: World): { readyPath: string; releasePath: string; exit: Promise<number> } {
  const base = dirname(made.root);
  const scriptPath = join(base, 'hold-episode-key.ts');
  const readyPath = join(base, 'holder.ready');
  const releasePath = join(base, 'holder.release');
  writeFileSync(scriptPath, HOLDER_SOURCE(join(import.meta.dir, '..', 'src', 'state.ts')));
  const child = Bun.spawn([process.execPath, scriptPath, lockDirOf(made), readyPath, releasePath], {
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

function noteNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes('.fallback-note-'));
}

function ledgerLines(storeDir: string): string[] {
  const name = readdirSync(storeDir).find((entry) => entry.startsWith('fallback-attempts-'));
  if (name === undefined) return [];
  return readFileSync(join(storeDir, name), 'utf8').trim().split('\n').filter((line) => line !== '');
}

describe('a send never waits on its episode key', () => {
  test('a key held by another process defers the note; it lands once, and the escalation sees it', async () => {
    const made = seatWorld();
    const holder = holdEpisodeKey(made);
    // The holder is ready before the send starts: the first note always meets a live holder.
    await until(() => existsSync(holder.readyPath));

    const io = owner(made.root);
    const started = performance.now();
    const code = await runSend(['iris', 'the gate is green'], io, fake(made, { sendId: () => MSG }));
    const elapsed = performance.now() - started;

    expect(code, io.err).toBe(0);
    // The key was still held when the send returned: the run did not wait for it, and the wait
    // the old path made (the holder's own 10 s) is what this bound excludes.
    expect(existsSync(holder.releasePath)).toBe(false);
    expect(elapsed).toBeLessThan(500);
    expect(io.err).not.toContain('the fallback attempt was not recorded');

    const dir = dropDir(made.dir, 'iris');
    const notes = noteNames(dir);
    expect(notes).toHaveLength(1);
    const noteText = readFileSync(join(dir, notes[0]!), 'utf8');
    const note = JSON.parse(noteText) as { format: number; sender: string; fact: { route: string; outcome: string } };
    expect(note.format).toBe(1);
    expect(note.sender).toBe('owner');
    expect(note.fact.route).toBe('drop');

    // Release the key; the chore pass's next tick records the deferred fact.
    writeFileSync(holder.releasePath, 'release\n');
    await holder.exit;

    const after = new Date(Date.parse(CONFIG) + 1000);
    const swept = sweepFallbackEscalations({ home: made.home, roots: [made.root], now: () => after });
    expect(swept.roots[0]!.why).toBeNull();
    const drained = swept.roots[0]!.notes!;
    expect(drained.refused).toHaveLength(0);
    expect(drained.deferred).toHaveLength(0);
    expect(drained.drained).toHaveLength(1);
    expect(drained.drained[0]!.messageId).toBe(MSG);
    expect(drained.drained[0]!.state).toBe('all-failed');
    // The note's work is done: it is gone, and the pass that reaches the episode sees one attempt.
    expect(noteNames(dir)).toHaveLength(0);

    const storeDir = dirname(historyPath('acme', made.root, made.home));
    const lines = ledgerLines(storeDir);
    expect(lines).toHaveLength(1);
    const attempt = JSON.parse(lines[0]!) as { route: string; outcome: string; messageId: string };
    expect(attempt.messageId).toBe(MSG);
    expect(attempt.route).toBe('drop');

    const marker = JSON.parse(readFileSync(join(dir, `${MSG}.fallback.json`), 'utf8')) as {
      status: string;
      attempts: unknown[];
      allFailedAt?: string;
      dueAt?: string;
      outbox?: unknown;
    };
    expect(marker.status).toBe('all-failed');
    expect(marker.attempts).toHaveLength(1);
    expect(marker.allFailedAt).toBe(CONFIG);
    // The delayed escalation is scheduled from the fact's own instant, not from the drain's:
    // a lock that held the send for seconds cannot push the escalation out.
    expect(marker.dueAt).toBe(new Date(Date.parse(CONFIG) + 300_000).toISOString());
    // The exhaustion event went out, so no intent is left for the next pass.
    expect(marker.outbox).toBeUndefined();

    // A note whose drain landed but whose removal did not is replayed once more: the recorder's
    // own dedupe keeps the ledger at one line.
    writeFileSync(join(dir, notes[0]!), noteText);
    const replay = sweepFallbackEscalations({ home: made.home, roots: [made.root], now: () => after });
    expect(replay.roots[0]!.notes!.drained).toHaveLength(1);
    expect(replay.roots[0]!.notes!.drained[0]!.state).toBe('duplicate');
    expect(ledgerLines(storeDir)).toHaveLength(1);
    expect(noteNames(dir)).toHaveLength(0);
  });
});
