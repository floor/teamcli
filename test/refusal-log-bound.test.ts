// The refusal sink's operational log: a repeat the event store confirms writes no second line,
// and a store that cannot answer falls back to the log for a bounded number of lines, so a
// refusal loop cannot rotate `.agents/team.log` away. Synthetic roots and homes only: nothing
// here reads the machine's own team state.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import { raiseRefusalEvent, REFUSAL_DEDUPE_SECONDS, REFUSAL_FALLBACK_LOG_LINES } from '../src/bus/refusals.ts';
import { storePath } from '../src/store/store.ts';

type World = { root: string; home: string; cleanup(): void };

function world(): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-refusal-')));
  mkdirSync(join(root, '.agents', 'send-drops', 'acme', 'lead'), { recursive: true });
  return { root, home: join(root, 'home'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** One refusal of an object named by `id`, as a seat's inbox read raises it. */
function raise(at: World, id: string, now: Date): boolean {
  return raiseRefusalEvent({
    project: 'acme',
    root: at.root,
    home: at.home,
    session: 'acme',
    kind: 'record.invalid',
    rule: 'shape',
    object: { id, seat: 'lead', path: join(at.root, '.agents', 'send-drops', 'acme', 'lead', id) },
    now,
  });
}

/** The refusal lines the operational log holds. */
function lines(at: World): string[] {
  return readFileSync(join(at.root, '.agents', 'team.log'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('refusal [lead] record.invalid shape'));
}

describe('the refusal log under a loop', () => {
  test('the first occurrence in a window writes one line and one event; a repeat writes neither', () => {
    const at = world();
    try {
      const now = new Date('2026-10-21T10:00:00.000Z');
      expect(raise(at, 'a', now)).toBe(true);
      expect(raise(at, 'a', now)).toBe(false);
      expect(lines(at)).toHaveLength(1);
      const events = readEvents('acme', at.root, at.home);
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      expect(events.events.filter((event) => event.payload.kind === 'record.invalid')).toHaveLength(1);
      // The next window raises the same object again: a new event, and its own line.
      const next = new Date(now.getTime() + REFUSAL_DEDUPE_SECONDS * 1000);
      expect(raise(at, 'a', next)).toBe(true);
      expect(lines(at)).toHaveLength(2);
    } finally {
      at.cleanup();
    }
  });

  test('a store that cannot answer falls back to the log, bounded per checkout', () => {
    const at = world();
    try {
      // The store's event log path is a directory, so no event can be recorded: every occurrence
      // is unconfirmed and the log line is the only evidence the refusal leaves.
      mkdirSync(join(storePath('acme', at.root, at.home), 'events.jsonl'), { recursive: true });
      const now = new Date('2026-10-21T10:00:00.000Z');
      for (let n = 0; n < REFUSAL_FALLBACK_LOG_LINES + 10; n++) {
        expect(raise(at, `loop-${String(n)}`, now)).toBe(false);
      }
      expect(lines(at)).toHaveLength(REFUSAL_FALLBACK_LOG_LINES);
    } finally {
      at.cleanup();
    }
  });
});
