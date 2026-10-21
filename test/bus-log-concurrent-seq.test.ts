// RC053-EVENT-SEQUENCE-ATOMIC coverage: concurrent appenders must mint distinct, contiguous
// sequences, and a subscriber cursor must reach every appended event.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, createSequenceTracker, readEvents, readEventsFromCursor } from '../src/bus/log.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeScratch(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-bus-seq-')));
  dirs.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  return { root, home };
}

describe('the event log under concurrent appenders', () => {
  test('concurrent processes mint distinct contiguous sequences and a cursor reaches every event', async () => {
    const { root, home } = makeScratch();
    const seed = 100;
    for (let i = 0; i < seed; i += 1) {
      const seeded = appendEvent('acme', root, home, {
        ts: new Date().toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: `seed-${i}`,
      });
      expect(seeded.ok).toBe(true);
    }

    const ids = Array.from({ length: 6 }, (_, i) => `writer-${i}`);
    const startAt = Date.now() + 500;
    const helper = join(import.meta.dir, 'bus-log-concurrent-seq-run.ts');
    const procs = ids.map((id) =>
      Bun.spawn(['bun', helper, root, home, id, String(startAt)], { stdout: 'pipe', stderr: 'pipe' }),
    );
    const results = await Promise.all(
      procs.map(async (proc) => {
        const out = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        await proc.exited;
        const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
        let parsed: { ok?: boolean; duplicate?: boolean; seq?: number; reason?: string };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          parsed = { reason: `unparseable output: ${line.slice(0, 80)} ${err.slice(0, 80)}` };
        }
        return { exitCode: proc.exitCode, ...parsed };
      }),
    );

    const read = readEvents('acme', root, home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const seqs = read.events.map((event) => event.payload.seq);
    const tracker = createSequenceTracker(0);
    const accepted = read.events.filter((event) => tracker.accept(event)).map((event) => event.payload.record_id);
    const acceptedIds = new Set(accepted);
    const minted = results.map((result) => result.seq);

    // One fact object, so a red run shows the allocation and the reader's view together.
    expect({
      exitCodes: results.map((result) => result.exitCode),
      ok: results.map((result) => result.ok),
      duplicate: results.map((result) => result.duplicate),
      distinctMinted: new Set(minted).size,
      logTotal: seqs.length,
      logSeqsOrdered: seqs.every((seq, at) => seq === at + 1),
      acceptedByCursorTracker: accepted.length,
      skippedReaderIds: ids.filter((id) => !acceptedIds.has(id)),
    }).toEqual({
      exitCodes: ids.map(() => 0),
      ok: ids.map(() => true),
      duplicate: ids.map(() => false),
      distinctMinted: ids.length,
      logTotal: seed + ids.length,
      logSeqsOrdered: true,
      acceptedByCursorTracker: seed + ids.length,
      skippedReaderIds: [],
    });

    const cursor = readEventsFromCursor('acme', root, home, seed);
    expect(cursor.ok).toBe(true);
    if (!cursor.ok || cursor.kind !== 'events') return;
    expect(cursor.events.map((event) => event.payload.record_id).sort()).toEqual([...ids].sort());
  }, 30000);
});
