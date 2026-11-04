// Migration: a store written before seals existed has its segments verified in full once and then
// sealed oldest first, each seal naming the one before it. A segment whose lines do not all verify
// is never sealed and blocks every newer seal; a segment whose seal exists but does not hold is
// never re-sealed, because a re-sign would launder exactly what the failed check refuses.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, eventLogPath, sealUnsealedSegments, verifyEventLogSeals } from '../src/bus/log.ts';
import { indexPathOf, sealPathOf } from '../src/bus/seal.ts';
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
  const base = realpathSync(mkdtempSync(`/private/tmp/bus-seal-migrate-${name}-`));
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

function stripSidecars(world: World, slots: number): void {
  for (let n = 1; n <= slots; n += 1) {
    rmSync(sealPathOf(`${livePath(world)}.${String(n)}`), { force: true });
    rmSync(indexPathOf(`${livePath(world)}.${String(n)}`), { force: true });
  }
}

function migrate(world: World): string[] {
  return sealUnsealedSegments(PROJECT, world.root, world.home, { kept: KEPT });
}

describe('migration of an older store', () => {
  test('a store with no seals is verified once and sealed oldest first, each naming the one before', () => {
    const world = makeWorld('plain');
    appendUntilSealed(world, 3, 'r');
    stripSidecars(world, 3);

    expect(migrate(world)).toEqual(['events.jsonl.3', 'events.jsonl.2', 'events.jsonl.1']);
    const seals = [3, 2, 1].map((slot) => {
      const text = readFileSync(sealPathOf(`${livePath(world)}.${String(slot)}`), 'utf8');
      return JSON.parse(text) as { segment: string; previous: string | null; sealDigest: string };
    });
    expect(seals.map((seal) => seal.segment)).toEqual(['events.jsonl.3', 'events.jsonl.2', 'events.jsonl.1']);
    expect(seals[0]!.previous).toBeNull();
    expect(seals[1]!.previous).toBe(seals[0]!.sealDigest);
    expect(seals[2]!.previous).toBe(seals[1]!.sealDigest);
    for (const slot of [3, 2, 1]) {
      expect(existsSync(indexPathOf(`${livePath(world)}.${String(slot)}`))).toBe(true);
    }

    const checked = verifyEventLogSeals(PROJECT, world.root, world.home, { kept: KEPT });
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.problems).toEqual([]);
    expect(checked.segments.map((segment) => segment.state)).toEqual(['sealed', 'sealed', 'sealed']);
  });

  test('a segment whose lines do not all verify is not sealed and blocks every newer seal', () => {
    const world = makeWorld('bad-line');
    appendUntilSealed(world, 3, 'r');
    stripSidecars(world, 3);
    appendFileSync(`${livePath(world)}.2`, 'not a signed record\n');

    expect(migrate(world)).toEqual(['events.jsonl.3']);
    expect(existsSync(sealPathOf(`${livePath(world)}.2`))).toBe(false);
    expect(existsSync(sealPathOf(`${livePath(world)}.1`))).toBe(false);

    const checked = verifyEventLogSeals(PROJECT, world.root, world.home, { kept: KEPT });
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.segments.map((segment) => [segment.name, segment.state, segment.why])).toEqual([
      ['events.jsonl.3', 'sealed', undefined],
      ['events.jsonl.2', 'unsealed', 'no-seal'],
      ['events.jsonl.1', 'unsealed', 'no-seal'],
    ]);
  });

  test('a second pass seals nothing and rewrites nothing', () => {
    const world = makeWorld('idempotent');
    appendUntilSealed(world, 2, 'r');
    stripSidecars(world, 2);
    expect(migrate(world)).toEqual(['events.jsonl.2', 'events.jsonl.1']);
    const before = [1, 2].map((slot) => {
      const at = sealPathOf(`${livePath(world)}.${String(slot)}`);
      return { text: readFileSync(at, 'utf8'), mtimeMs: statSync(at).mtimeMs };
    });

    expect(migrate(world)).toEqual([]);
    const after = [1, 2].map((slot) => {
      const at = sealPathOf(`${livePath(world)}.${String(slot)}`);
      return { text: readFileSync(at, 'utf8'), mtimeMs: statSync(at).mtimeMs };
    });
    expect(after).toEqual(before);
    // A store whose segments already carry seals is not touched at all.
    expect(migrate(world)).toEqual([]);
  });

  test('a segment whose seal exists but no longer holds is never re-sealed', () => {
    const world = makeWorld('bad-seal');
    appendUntilSealed(world, 1, 'r');
    const segment = `${livePath(world)}.1`;
    writeFileSync(segment, `${readFileSync(segment, 'utf8')} `);

    expect(migrate(world)).toEqual([]);
    const checked = verifyEventLogSeals(PROJECT, world.root, world.home, { kept: KEPT });
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.segments[0]!.state).toBe('unsealed');
    expect(checked.segments[0]!.why).toBe('size');
  });
});
