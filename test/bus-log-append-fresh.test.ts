// The append index a fresh process builds answers the key it is about to write: it reads the
// retained log, verifies the newest line of each file for the sequence, and verifies only the
// lines that can hold the record it is appending. These scenes pin the answers that scan owes —
// a duplicate behind many records, an unverified line that never answers for one, an id that is a
// substring of another, and a second key taken up in the same process — so the cheaper scan can
// never be cheaper than the full one in what it decides.
import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, eventLogPath } from '../src/bus/log.ts';
import type { EventKind } from '../src/bus/kinds.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeScratch(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-bus-append-index-')));
  dirs.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  return { root, home };
}

const TS = '2026-10-18T12:00:00.000Z';
const HELPER = join(import.meta.dir, 'bus-log-append-fresh-run.ts');

async function freshAppend(
  root: string,
  home: string,
  kind: EventKind,
  id: string,
): Promise<{ ok: boolean; duplicate?: boolean; seq?: number; reason?: string }> {
  const proc = Bun.spawn(['bun', HELPER, root, home, kind, id], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
  try {
    return JSON.parse(line) as { ok: boolean; duplicate?: boolean; seq?: number; reason?: string };
  } catch {
    return { ok: false, reason: `unparseable output: ${line.slice(0, 80)} ${err.slice(0, 80)}` };
  }
}

function seed(root: string, home: string, kind: EventKind, prefix: string, count: number): void {
  for (let n = 0; n < count; n += 1) {
    const appended = appendEvent('acme', root, home, {
      ts: TS,
      kind,
      session: 'acme',
      record_id: `${prefix}-${String(n)}`,
    });
    expect(appended.ok).toBe(true);
  }
}

describe('the append index a fresh process builds', () => {
  test('finds a duplicate behind many retained records, and never takes a forged line for it', async () => {
    const { root, home } = makeScratch();
    seed(root, home, 'message.arrived', 'before', 50);
    const original = appendEvent('acme', root, home, {
      ts: TS,
      kind: 'message.delivered',
      session: 'acme',
      record_id: 'target-1',
    });
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    // An unverified line that spells the same id, exactly where a full scan would also skip it.
    const path = eventLogPath('acme', root, home);
    appendFileSync(
      path,
      `${JSON.stringify({
        payload: { v: 1, seq: 9999, ts: TS, kind: 'message.delivered', session: 'acme', record_id: 'target-1' },
        signature: '00'.repeat(64),
      })}\n`,
    );
    seed(root, home, 'message.arrived', 'after', 50);
    const before = readFileSync(path, 'utf8');

    const answer = await freshAppend(root, home, 'message.delivered', 'target-1');
    expect(answer.ok).toBe(true);
    expect(answer.duplicate).toBe(true);
    expect(answer.seq).toBe(original.record.payload.seq);
    // The duplicate wrote nothing: not the record, and not the forged line's shadow either.
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('mints the sequence from the newest verified record, not from a forged tail line', async () => {
    const { root, home } = makeScratch();
    seed(root, home, 'message.arrived', 'seed', 3);
    const path = eventLogPath('acme', root, home);
    appendFileSync(
      path,
      `${JSON.stringify({
        payload: { v: 1, seq: 9000, ts: TS, kind: 'message.arrived', session: 'acme', record_id: 'forged-tail' },
        signature: '00'.repeat(64),
      })}\n`,
    );

    const answer = await freshAppend(root, home, 'message.delivered', 'fresh-1');
    expect(answer.ok).toBe(true);
    expect(answer.duplicate).toBe(false);
    expect(answer.seq).toBe(4);
  });

  test('an id that is a substring of another is not a duplicate of it', async () => {
    const { root, home } = makeScratch();
    seed(root, home, 'message.arrived', 'a-10', 1);

    const answer = await freshAppend(root, home, 'message.arrived', 'a-1');
    expect(answer.ok).toBe(true);
    expect(answer.duplicate).toBe(false);
    expect(answer.seq).toBe(2);
  });

  test('a second key is searched when it is first appended, and the first key keeps its duplicate', () => {
    const { root, home } = makeScratch();
    const first = appendEvent('acme', root, home, { ts: TS, kind: 'message.arrived', session: 'acme', record_id: 'a-1' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = appendEvent('acme', root, home, { ts: TS, kind: 'message.delivered', session: 'acme', record_id: 'b-1' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.duplicate).toBe(false);
    expect(second.record.payload.seq).toBe(2);
    const again = appendEvent('acme', root, home, { ts: TS, kind: 'message.arrived', session: 'acme', record_id: 'a-1' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.duplicate).toBe(true);
    expect(again.record.payload.seq).toBe(1);
  });
});
