// Hydration: reconcile's dedupe sets are rebuilt from the signed per-segment indexes, so a log
// whose segments are all sealed is answered without reading one byte of them. A segment that is
// present but unsealed is still read and verified in full — hydration is a cost saving over a
// sealed set, never a way around verification — and a line in the open segment is returned only
// when its own signature verifies.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, eventLogPath, hydrateEventLog, readEvents, type EventBrief } from '../src/bus/log.ts';
import { reconcilePass } from '../src/bus/reconcile.ts';
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
  const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `bus-seal-hydrate-${name}-`)));
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

function appendPadded(world: World, id: string, seat?: string): void {
  const appended = appendEvent(PROJECT, world.root, world.home, {
    ts: NOW.toISOString(),
    kind: 'message.arrived',
    session: 'acme',
    record_id: id,
    from: 'lead',
    to: 'builder',
    ...(seat === undefined ? {} : { seat }),
    reason: 'x'.repeat(200),
  }, { maxBytes: MAX_BYTES, kept: KEPT });
  if (!appended.ok) throw new Error(appended.reason);
}

function appendUntilSealed(world: World, slots: number, prefix: string): void {
  for (let index = 1; index <= 900; index += 1) {
    appendPadded(world, `${prefix}-${String(index)}`, 'lead');
    if (existsSync(`${livePath(world)}.${String(slots)}`)) return;
  }
  throw new Error(`the fixture never sealed ${String(slots)} segment(s)`);
}

function hydrate(world: World) {
  return hydrateEventLog(PROJECT, world.root, world.home, { kept: KEPT });
}

function typed(result: ReturnType<typeof hydrate>): Extract<ReturnType<typeof hydrate>, { ok: true }> {
  if (!result.ok) throw new Error(result.reason);
  return result;
}

function idsOf(entries: EventBrief[]): string[] {
  return entries.map((entry) => entry.record_id);
}

describe('reconcile hydration from the sealed indexes', () => {
  test('a sealed set hydrates while every sealed segment stays unreadable', () => {
    const world = makeWorld('sealed');
    appendUntilSealed(world, 1, 'r');
    for (const id of ['open-1', 'open-2', 'open-3']) appendPadded(world, id);
    chmodSync(`${livePath(world)}.1`, 0o000);

    const hydrated = typed(hydrate(world));
    expect(hydrated.full).toBe(false);
    expect(hydrated.unverified).toBe(0);
    expect(hydrated.entries.length).toBeGreaterThan(3);
    expect(idsOf(hydrated.entries)).toContain('open-3');
    // The sealed segment's records are returned from its index alone, in sequence order.
    const first = hydrated.entries[0]!;
    expect(first.record_id).toBe('r-1');
    expect(first.seat).toBe('lead');
    expect(first.from).toBe('lead');
    expect(first.to).toBe('builder');
    const seqs = hydrated.entries.map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(hydrated.oldestSeq).toBe(1);
    expect(hydrated.entries.at(-1)?.record_id).toBe('open-3');
  });

  test('a segment with no seal is read and verified in full, never hydrated', () => {
    const world = makeWorld('fallback');
    appendUntilSealed(world, 2, 'r');
    appendPadded(world, 'open-1');
    rmSync(sealPathOf(`${livePath(world)}.2`), { force: true });

    const hydrated = typed(hydrate(world));
    const read = readEvents(PROJECT, world.root, world.home, { kept: KEPT });
    if (!read.ok) throw new Error(read.reason);
    expect(hydrated.full).toBe(true);
    expect(idsOf(hydrated.entries)).toEqual(read.events.map((event) => event.payload.record_id));
    expect(idsOf(hydrated.entries)).toContain('r-1');
  });

  test('a tampered line in the open segment is disclosed and never hydrated', () => {
    const world = makeWorld('tamper');
    appendUntilSealed(world, 1, 'r');
    appendPadded(world, 'open-1');
    appendFileSync(livePath(world), '{"payload":{"seq":99999},"signature":"x"}\n');

    const hydrated = typed(hydrate(world));
    expect(hydrated.unverified).toBe(1);
    expect(idsOf(hydrated.entries)).toContain('open-1');
    expect(idsOf(hydrated.entries)).not.toContain('99999');
  });

  test('an append after hydration is seen once the open segment changes', () => {
    const world = makeWorld('cache');
    appendUntilSealed(world, 1, 'r');
    appendPadded(world, 'open-1');
    const before = typed(hydrate(world));
    expect(idsOf(before.entries)).toContain('open-1');
    expect(idsOf(before.entries)).not.toContain('open-2');
    // A second pass over unchanged bytes answers with nothing re-checked.
    expect(typed(hydrate(world)).checked).toBe(0);

    appendPadded(world, 'open-2');
    const after = typed(hydrate(world));
    expect(idsOf(after.entries)).toContain('open-2');
    expect(after.checked).toBeGreaterThan(0);
  });

  test('a reconcile pass over a sealed log never reads the sealed segment bytes', () => {
    const world = makeWorld('reconcile');
    appendUntilSealed(world, 2, 'r');
    appendPadded(world, 'open-1');
    // The append that triggered the last rotation lives in the open file too.
    const openLines = readFileSync(livePath(world), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '').length;
    chmodSync(`${livePath(world)}.1`, 0o000);
    chmodSync(`${livePath(world)}.2`, 0o000);

    const pass = reconcilePass({
      project: PROJECT,
      root: world.root,
      session: 'acme',
      home: world.home,
      now: NOW,
    });
    expect(pass.ok).toBe(true);
    if (!pass.ok) return;
    expect(pass.full).toBe(false);
    // Only the open segment's records were checked against the key.
    expect(pass.checked).toBe(openLines);
    expect(pass.raised).toEqual([]);
  });
});
