// A cursor at the retained tail is answered from the open segment alone: the sealed set is
// vouched for by its seals and indexes, so no sealed byte is read for a subscriber following the
// log. A cursor inside the sealed history still reads and verifies every retained line, and a
// segment whose seal is gone sends the read through that same verified path.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, eventLogPath, hydrateEventLog, readEventsFromCursor } from '../src/bus/log.ts';
import { sealPathOf } from '../src/bus/seal.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { teamIdOf } from '../src/registry/teams.ts';

const PROJECT = 'acme';
const NOW = new Date('2026-10-19T12:00:00.000Z');
const MAX_BYTES = 50_000;
const KEPT = 4;

const dirs: string[] = [];

afterEach(() => {
  for (const base of dirs.splice(0)) rmSync(base, { recursive: true, force: true });
});

const TEAM_YAML = `format: 1
project: acme
entity: floor
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    leads: true
`;

type World = { root: string; home: string };

function makeWorld(name: string): World {
  const base = realpathSync(mkdtempSync(`/private/tmp/bus-seal-cursor-${name}-`));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  const written = writePolicySet(
    home,
    { level: 'team', target: teamIdOf(root), teamRoot: root, name: 'event-segment-mb', value: 1 },
    { now: NOW },
  );
  if (!written.ok) throw new Error(written.why);
  return { root, home };
}

function livePath(world: World): string {
  return eventLogPath(PROJECT, world.root, world.home);
}

function appendPadded(world: World, id: string): void {
  const appended = appendEvent(PROJECT, world.root, world.home, {
    ts: NOW.toISOString(),
    kind: 'message.arrived',
    session: 'acme',
    record_id: id,
    from: 'lead',
    to: 'builder',
    reason: 'x'.repeat(200),
  }, { maxBytes: MAX_BYTES, kept: KEPT });
  if (!appended.ok) throw new Error(appended.reason);
}

function appendUntilSealed(world: World, slots: number, prefix: string): void {
  for (let index = 1; index <= 900; index += 1) {
    appendPadded(world, `${prefix}-${String(index)}`);
    if (existsSync(`${livePath(world)}.${String(slots)}`)) return;
  }
  throw new Error(`the fixture never sealed ${String(slots)} segment(s)`);
}

type OpenLine = { seq: number; record_id: string };

function openLines(world: World): OpenLine[] {
  const lines: OpenLine[] = [];
  for (const raw of readFileSync(livePath(world), 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    const parsed = JSON.parse(raw) as { payload?: { seq?: number; record_id?: string } };
    if (typeof parsed.payload?.seq === 'number' && typeof parsed.payload.record_id === 'string') {
      lines.push({ seq: parsed.payload.seq, record_id: parsed.payload.record_id });
    }
  }
  return lines;
}

function cursorRead(world: World, cursor: number) {
  return readEventsFromCursor(PROJECT, world.root, world.home, cursor, { kept: KEPT });
}

function idsOf(result: Extract<ReturnType<typeof cursorRead>, { ok: true; kind: 'events' }>): string[] {
  return result.events.map((event) => event.payload.record_id);
}

describe('cursor reads across a sealed set', () => {
  test('a cursor at the sealed tail is answered from the open segment, sealed bytes unread', () => {
    const world = makeWorld('tail');
    appendUntilSealed(world, 2, 'r');
    appendPadded(world, 'open-1');
    appendPadded(world, 'open-2');
    const open = openLines(world);
    const sealedTail = Math.min(...open.map((line) => line.seq)) - 1;
    expect(sealedTail).toBeGreaterThan(0);
    chmodSync(`${livePath(world)}.1`, 0o000);
    chmodSync(`${livePath(world)}.2`, 0o000);

    const read = cursorRead(world, sealedTail);
    if (!read.ok) throw new Error(read.reason);
    expect(read.kind).toBe('events');
    if (read.kind !== 'events') return;
    // Every open line is after the cursor, and nothing in the sealed segments was needed.
    expect(idsOf(read)).toEqual(open.map((line) => line.record_id));
    expect(read.oldestSeq).toBe(1);
    expect(read.newestSeq).toBe(Math.max(...open.map((line) => line.seq)));
    expect(read.checked).toBe(open.length);
    expect(read.unverified).toBe(0);
  });

  test('an idle tail cursor is answered without re-checking the open segment', () => {
    const world = makeWorld('idle');
    appendUntilSealed(world, 1, 'r');
    appendPadded(world, 'open-1');
    const open = openLines(world);
    const sealedTail = Math.min(...open.map((line) => line.seq)) - 1;

    const first = cursorRead(world, sealedTail);
    if (!first.ok) throw new Error(first.reason);
    if (first.kind !== 'events') throw new Error(first.kind);
    expect(first.checked).toBe(open.length);
    const second = cursorRead(world, sealedTail);
    if (!second.ok) throw new Error(second.reason);
    if (second.kind !== 'events') throw new Error(second.kind);
    expect(second.checked).toBe(0);
    expect(idsOf(second)).toEqual(idsOf(first));

    // A cursor at the newest record has nothing to return and does not move.
    const newest = Math.max(...open.map((line) => line.seq));
    const atEnd = cursorRead(world, newest);
    if (!atEnd.ok) throw new Error(atEnd.reason);
    if (atEnd.kind !== 'events') throw new Error(atEnd.kind);
    expect(atEnd.events).toEqual([]);
    expect(atEnd.cursor).toBe(newest);
  });

  test('a cursor inside the sealed history reads and verifies every retained line', () => {
    const world = makeWorld('history');
    appendUntilSealed(world, 2, 'r');
    appendPadded(world, 'open-1');

    const read = cursorRead(world, 0);
    if (!read.ok) throw new Error(read.reason);
    if (read.kind !== 'events') throw new Error(read.kind);
    const ids = idsOf(read);
    expect(ids[0]).toBe('r-1');
    expect(ids).toContain('open-1');
    expect(read.oldestSeq).toBe(1);
    expect(read.unverified).toBe(0);
  });

  test('a tampered line in the open segment is never returned to a tail cursor', () => {
    const world = makeWorld('tamper');
    appendUntilSealed(world, 1, 'r');
    appendPadded(world, 'open-1');
    const sealedTail = Math.min(...openLines(world).map((line) => line.seq)) - 1;
    appendFileSync(livePath(world), '{"payload":{"seq":99999,"record_id":"forged"},"signature":"x"}\n');
    chmodSync(`${livePath(world)}.1`, 0o000);

    const read = cursorRead(world, sealedTail);
    if (!read.ok) throw new Error(read.reason);
    if (read.kind !== 'events') throw new Error(read.kind);
    expect(idsOf(read)).toContain('open-1');
    expect(idsOf(read)).not.toContain('forged');
    expect(read.unverified).toBe(1);
  });

  test('a segment with no seal sends the tail cursor through the verified full read', () => {
    const world = makeWorld('fallback');
    appendUntilSealed(world, 2, 'r');
    appendPadded(world, 'open-1');
    const open = openLines(world);
    const sealedTail = Math.min(...open.map((line) => line.seq)) - 1;
    rmSync(sealPathOf(`${livePath(world)}.2`), { force: true });

    // The seal-less segment is read and verified in full rather than vouched for by a seal.
    const hydrated = hydrateEventLog(PROJECT, world.root, world.home, { kept: KEPT });
    if (!hydrated.ok) throw new Error(hydrated.reason);
    expect(hydrated.full).toBe(true);
    expect(hydrated.checked).toBeGreaterThan(open.length);

    const read = cursorRead(world, sealedTail);
    if (!read.ok) throw new Error(read.reason);
    if (read.kind !== 'events') throw new Error(read.kind);
    // The tail answer is unchanged; the verified read above is what it answers from.
    expect(idsOf(read)).toEqual(open.map((line) => line.record_id));
    expect(read.unverified).toBe(0);
  });
});
