import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, eventLogPath, readEvents, readEventsFromCursor } from '../src/bus/log.ts';
import { messageKeyOf } from '../src/store/keys.ts';

// Independent coverage of the bus verification checkpoint (docs/internal/events.md §1, "Incremental
// verification"): the guarantee the bus relies on when it stops checking the signatures it has
// already checked. The builder's tests pin the main path; these pin the corners the guarantee
// statement makes a promise about — an empty log, a permanently unreadable line inside the verified
// prefix, a record appended below the checkpoint's sequence, two logs in one process, a cursor
// window read through the same checkpoint, and the checkpoint ending up incremental again after a
// trim rebuilt it.

const dirs: string[] = [];

function makeScratch(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-bus-incremental-')));
  dirs.push(base);
  return { root: join(base, 'repo'), home: join(base, 'home') };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const TS = '2026-10-18T12:00:00.000Z';

function appendOne(project: string, root: string, home: string, id: string): void {
  const appended = appendEvent(project, root, home, {
    ts: TS,
    kind: 'message.arrived',
    session: project,
    record_id: id,
  });
  expect(appended.ok).toBe(true);
}

describe('bus verification checkpoint: an empty log and a permanently unreadable prefix line', () => {
  test('an empty log gets a checkpoint: first read full, later reads trust it, the first append is checked', () => {
    const { root, home } = makeScratch();
    // The message key exists before the first read, as it does on a bus that has signed before
    // (a log trimmed empty): a key that appears between two reads is the separate key-change
    // fallback, not this path.
    messageKeyOf(home);

    const empty = readEvents('acme', root, home);
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.full).toBe(true);
    expect(empty.checked).toBe(0);
    expect(empty.events).toEqual([]);
    expect(empty.oldestSeq).toBeNull();
    expect(empty.newestSeq).toBeNull();

    const quiet = readEvents('acme', root, home);
    expect(quiet.ok).toBe(true);
    if (!quiet.ok) return;
    expect(quiet.full).toBe(false);
    expect(quiet.checked).toBe(0);
    expect(quiet.events).toEqual([]);

    appendOne('acme', root, home, 'm-1');
    const grown = readEvents('acme', root, home);
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;
    expect(grown.full).toBe(false);
    expect(grown.checked).toBe(1);
    expect(grown.unverified).toBe(0);
    expect(grown.events.map((event) => event.payload.seq)).toEqual([1]);

    // A subscription read through the same checkpoint sees the record and checks no signature.
    const subscribed = readEventsFromCursor('acme', root, home, 0);
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok || subscribed.kind !== 'events') return;
    expect(subscribed.full).toBe(false);
    expect(subscribed.checked).toBe(0);
    expect(subscribed.events.map((event) => event.payload.seq)).toEqual([1]);
  });

  test('an unreadable line inside the verified prefix stays counted as unverified on every incremental read', () => {
    const { root, home } = makeScratch();
    const path = eventLogPath('acme', root, home);
    appendOne('acme', root, home, 'm-1');
    // A line the log can never parse, retained between two signed records: the checkpoint's digest
    // skips it, and `unverified` must not lose it when the rest of the prefix is trusted.
    appendFileSync(path, 'not a signed event\n');
    appendOne('acme', root, home, 'm-2');

    const first = readEvents('acme', root, home);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.full).toBe(true);
    expect(first.checked).toBe(2);
    expect(first.unverified).toBe(1);
    expect(first.events.map((event) => event.payload.seq)).toEqual([1, 2]);

    const second = readEvents('acme', root, home);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.full).toBe(false);
    expect(second.checked).toBe(0);
    expect(second.unverified).toBe(1);
    expect(second.events.map((event) => event.payload.seq)).toEqual([1, 2]);

    appendOne('acme', root, home, 'm-3');
    const grown = readEvents('acme', root, home);
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;
    expect(grown.full).toBe(false);
    expect(grown.checked).toBe(1);
    expect(grown.unverified).toBe(1);
    expect(grown.events.map((event) => event.payload.seq)).toEqual([1, 2, 3]);
  });
});

describe('bus verification checkpoint: what falls back to a full verify', () => {
  test('a record appended below the checkpoint sequence changes the prefix digest and is caught', () => {
    const { root, home } = makeScratch();
    const path = eventLogPath('acme', root, home);
    for (const id of ['m-1', 'm-2', 'm-3']) appendOne('acme', root, home, id);
    const first = readEvents('acme', root, home);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.full).toBe(true);
    expect(first.checked).toBe(3);

    // A well-formed line claiming an old sequence, signed with a signature that does not cover it.
    // It sits at or below the checkpoint's sequence, so the prefix digest covers its bytes: a read
    // that trusted the checkpoint without hashing the prefix would skip it.
    const lines = readFileSync(path, 'utf8').split('\n');
    const forged = JSON.parse(lines[0]!) as { payload: Record<string, unknown>; signature: string };
    forged.payload.seq = 2;
    forged.payload.record_id = 'forged-below-checkpoint';
    appendFileSync(path, `${JSON.stringify(forged)}\n`);

    const caught = readEvents('acme', root, home);
    expect(caught.ok).toBe(true);
    if (!caught.ok) return;
    expect(caught.full).toBe(true);
    expect(caught.checked).toBe(4);
    expect(caught.unverified).toBe(1);
    expect(caught.events.map((event) => event.payload.record_id)).toEqual(['m-1', 'm-2', 'm-3']);

    // The rebuilt checkpoint covers the forged bytes too; the next read trusts them and still
    // counts the record unverified rather than returning it as an event.
    const again = readEvents('acme', root, home);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.full).toBe(false);
    expect(again.checked).toBe(0);
    expect(again.unverified).toBe(1);
    expect(again.events.map((event) => event.payload.record_id)).toEqual(['m-1', 'm-2', 'm-3']);
  });

  test('a rewrite with the same bytes keeps the checkpoint; a trim rebuilds it and the log grows incrementally again', () => {
    const { root, home } = makeScratch();
    const path = eventLogPath('acme', root, home);
    for (const id of ['m-1', 'm-2', 'm-3']) appendOne('acme', root, home, id);
    expect(readEvents('acme', root, home).ok).toBe(true);

    // Same bytes written again (a rewrite, not a change): the digest is over content, not a file
    // identity, so nothing is re-verified.
    writeFileSync(path, readFileSync(path, 'utf8'));
    const rewritten = readEvents('acme', root, home);
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    expect(rewritten.full).toBe(false);
    expect(rewritten.checked).toBe(0);
    expect(rewritten.events.map((event) => event.payload.seq)).toEqual([1, 2, 3]);

    // Rotate, then trim the old segment: the checkpoint covered sequences that are now gone, so
    // the read verifies the retained log in full and rebuilds the checkpoint at the new start.
    renameSync(path, `${path}.1`);
    appendOne('acme', root, home, 'm-4');
    unlinkSync(`${path}.1`);

    const trimmed = readEvents('acme', root, home);
    expect(trimmed.ok).toBe(true);
    if (!trimmed.ok) return;
    expect(trimmed.full).toBe(true);
    expect(trimmed.checked).toBe(1);
    expect(trimmed.events.map((event) => event.payload.seq)).toEqual([4]);

    appendOne('acme', root, home, 'm-5');
    const regrown = readEvents('acme', root, home);
    expect(regrown.ok).toBe(true);
    if (!regrown.ok) return;
    expect(regrown.full).toBe(false);
    expect(regrown.checked).toBe(1);
    expect(regrown.events.map((event) => event.payload.seq)).toEqual([4, 5]);
  });
});

describe('bus verification checkpoint: one checkpoint per retained log', () => {
  test('two logs read in one process keep their own checkpoints', () => {
    const { root, home } = makeScratch();
    appendOne('acme', root, home, 'a-1');
    const firstA = readEvents('acme', root, home);
    expect(firstA.ok).toBe(true);
    if (!firstA.ok) return;
    expect(firstA.full).toBe(true);
    expect(firstA.checked).toBe(1);

    // The other team's log has checks of its own; building its checkpoint must not reuse or
    // invalidate the first log's.
    appendOne('other', root, home, 'b-1');
    const firstB = readEvents('other', root, home);
    expect(firstB.ok).toBe(true);
    if (!firstB.ok) return;
    expect(firstB.full).toBe(true);
    expect(firstB.checked).toBe(1);
    expect(firstB.events.map((event) => event.payload.record_id)).toEqual(['b-1']);

    const secondA = readEvents('acme', root, home);
    expect(secondA.ok).toBe(true);
    if (!secondA.ok) return;
    expect(secondA.full).toBe(false);
    expect(secondA.checked).toBe(0);
    expect(secondA.events.map((event) => event.payload.record_id)).toEqual(['a-1']);

    appendOne('acme', root, home, 'a-2');
    const grownA = readEvents('acme', root, home);
    expect(grownA.ok).toBe(true);
    if (!grownA.ok) return;
    expect(grownA.full).toBe(false);
    expect(grownA.checked).toBe(1);
    expect(grownA.events.map((event) => event.payload.record_id)).toEqual(['a-1', 'a-2']);

    // The other log is still independent: unchanged bytes, nothing re-checked.
    const secondB = readEvents('other', root, home);
    expect(secondB.ok).toBe(true);
    if (!secondB.ok) return;
    expect(secondB.full).toBe(false);
    expect(secondB.checked).toBe(0);
    expect(secondB.events.map((event) => event.payload.record_id)).toEqual(['b-1']);
  });

  test('a subscription cursor past the checkpoint reads only the appended records, through the same checkpoint', () => {
    const { root, home } = makeScratch();
    for (const id of ['m-1', 'm-2']) appendOne('acme', root, home, id);
    expect(readEvents('acme', root, home).ok).toBe(true);

    const fromOne = readEventsFromCursor('acme', root, home, 1);
    expect(fromOne.ok).toBe(true);
    if (!fromOne.ok || fromOne.kind !== 'events') return;
    expect(fromOne.full).toBe(false);
    expect(fromOne.checked).toBe(0);
    expect(fromOne.events.map((event) => event.payload.seq)).toEqual([2]);
    expect(fromOne.cursor).toBe(2);

    appendOne('acme', root, home, 'm-3');
    const fromTwo = readEventsFromCursor('acme', root, home, 2);
    expect(fromTwo.ok).toBe(true);
    if (!fromTwo.ok || fromTwo.kind !== 'events') return;
    expect(fromTwo.full).toBe(false);
    expect(fromTwo.checked).toBe(1);
    expect(fromTwo.events.map((event) => event.payload.seq)).toEqual([3]);
    expect(fromTwo.cursor).toBe(3);
    expect(fromTwo.newestSeq).toBe(3);
  });
});
