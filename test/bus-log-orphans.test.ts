// Orphaned sidecars: a seal or index whose segment file is gone is removed, never read as
// evidence, and each removal is written once to the team log. This is what a downgrade leaves
// behind when an older build prunes a segment without knowing the sidecars a newer build wrote.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, eventLogPath, pruneEventLog, sweepOrphanedSidecars } from '../src/bus/log.ts';
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
  const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `bus-seal-orphans-${name}-`)));
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

function appendUntilSealed(world: World, slots: number, prefix: string): void {
  for (let index = 1; index <= 900; index += 1) {
    const appended = appendEvent(PROJECT, world.root, world.home, {
      ts: NOW.toISOString(),
      kind: 'message.arrived',
      session: 'acme',
      record_id: `${prefix}-${String(index)}`,
      reason: 'x'.repeat(200),
    }, { maxBytes: MAX_BYTES, kept: KEPT });
    if (!appended.ok) throw new Error(appended.reason);
    if (existsSync(`${livePath(world)}.${String(slots)}`)) return;
  }
  throw new Error(`the fixture never sealed ${String(slots)} segment(s)`);
}

function teamLog(world: World): string {
  const path = join(world.root, '.agents', 'team.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('orphaned sidecars', () => {
  test('a seal and index whose segment is gone are removed once and reported once each', () => {
    const world = makeWorld('sweep');
    appendUntilSealed(world, 2, 'r');
    const gone = `${livePath(world)}.2`;
    rmSync(gone, { force: true });
    expect(existsSync(sealPathOf(gone))).toBe(true);
    expect(existsSync(indexPathOf(gone))).toBe(true);

    const removed = sweepOrphanedSidecars(PROJECT, world.root, world.home, { kept: KEPT });
    expect(removed.sort()).toEqual(['events.jsonl.2.index.jsonl', 'events.jsonl.2.seal.json']);
    expect(existsSync(sealPathOf(gone))).toBe(false);
    expect(existsSync(indexPathOf(gone))).toBe(false);
    // The segment that is still there keeps its sidecars.
    expect(existsSync(sealPathOf(`${livePath(world)}.1`))).toBe(true);
    expect(existsSync(indexPathOf(`${livePath(world)}.1`))).toBe(true);

    const log = teamLog(world);
    expect(log).toContain('bus [event-log] removed orphan events.jsonl.2.seal.json');
    expect(log).toContain('bus [event-log] removed orphan events.jsonl.2.index.jsonl');

    // Nothing is left to remove, and nothing is reported a second time.
    expect(sweepOrphanedSidecars(PROJECT, world.root, world.home, { kept: KEPT })).toEqual([]);
    const after = teamLog(world).split('removed orphan').length - 1;
    expect(after).toBe(2);
  });

  test('the retention pass at start sweeps what a downgrade left behind', () => {
    const world = makeWorld('prune-sweep');
    appendUntilSealed(world, 2, 'r');
    const gone = `${livePath(world)}.2`;
    rmSync(gone, { force: true });

    // Keep-all here: this scene is about the sweep, not about an age drop.
    pruneEventLog(PROJECT, world.root, world.home, { kept: KEPT, retentionSeconds: 0 });
    expect(existsSync(sealPathOf(gone))).toBe(false);
    expect(existsSync(indexPathOf(gone))).toBe(false);
    expect(teamLog(world)).toContain('removed orphan events.jsonl.2.seal.json');
  });
});
