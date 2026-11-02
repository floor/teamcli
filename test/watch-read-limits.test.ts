// The two watch-read policies: how long one pass may spend reading, and how long one read may
// take. These scenes pin the catalogue entries (whole milliseconds from 100 to 30000, the
// documented default, a shorter value tighter) and the reader the watch uses, which resolves the
// chain to `team` the same way the pace does and falls back to the defaults with the reason when
// the chain cannot be read.
//
// Every policy write here is signed with the scratch home's own key; nothing reads a live policy.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { entitiesPath } from '../src/entities.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { POLICY_CATALOGUE, writePolicySet } from '../src/policy/index.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { READ_LIMITS_DEFAULT_MS, watchReadLimits } from '../src/watch/read-limits.ts';

const NOW = new Date('2026-11-02T09:00:00Z');

const TEAM = `format: 1
entity: floor
project: beacon
session: beacon
coordinator: lead
operator: lead
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
`;

let base = '';
let root = '';
let home = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join('/private/tmp', 'team-watch-read-limits-')));
  root = join(base, 'repo');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function teamAt(): TeamFile {
  const parsed = validateTeamFile(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8'));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.team;
}

function limits() {
  return watchReadLimits(teamAt(), root, home, NOW);
}

function signedAt(level: 'entity' | 'team', name: string, value: number): void {
  const request = level === 'entity'
    ? { level, target: 'floor', name, value } as const
    : { level, target: teamIdOf(root), teamRoot: root, name, value } as const;
  const wrote = writePolicySet(home, request, { now: NOW });
  if (!wrote.ok) throw new Error(`the signed ${name} was refused: ${wrote.why}`);
}

describe('the watch-read catalogue entries', () => {
  test('both are enforced, entity to team, 2000 ms by default, whole milliseconds 100 to 30000', () => {
    for (const name of ['watch-read-budget-ms', 'watch-read-timeout-ms'] as const) {
      const entry = POLICY_CATALOGUE[name];
      expect(entry.kind).toBe('enforced');
      expect(entry.levels).toEqual(['entity', 'project', 'team']);
      expect(entry.defaultValue).toBe(2000);
      expect(entry.parseValue(2000)).toBe(2000);
      expect(entry.parseValue('400')).toBe(400);
      expect(entry.parseValue(100)).toBe(100);
      expect(entry.parseValue(30_000)).toBe(30_000);
      expect(entry.parseValue(99)).toBeNull();
      expect(entry.parseValue(30_001)).toBeNull();
      expect(entry.parseValue('1.5')).toBeNull();
      expect(entry.valueProblem?.(10)).toContain('whole number of milliseconds from 100 to 30000');
      // A shorter or equal value is the tighter one.
      expect(entry.isWithin?.(1000, 2000)).toBe(true);
      expect(entry.isWithin?.(2000, 1000)).toBe(false);
      expect(entry.isWithin?.(2000, 2000)).toBe(true);
    }
  });
});

describe('the read limits the watch runs under', () => {
  test('nothing declared reads both defaults, with no unknown', () => {
    expect(limits()).toEqual({ budgetMs: READ_LIMITS_DEFAULT_MS.budget, timeoutMs: READ_LIMITS_DEFAULT_MS.timeout });
    expect(limits().budgetMs).toBe(2000);
    expect(limits().timeoutMs).toBe(2000);
  });

  test('a team word applies, and a looser word above it may stand: the team word stays in force', () => {
    signedAt('team', 'watch-read-timeout-ms', 1200);
    signedAt('team', 'watch-read-budget-ms', 600);
    expect(limits()).toEqual({ budgetMs: 600, timeoutMs: 1200 });
    // A higher level may declare a looser ceiling: the tighter team word stays in force.
    signedAt('entity', 'watch-read-budget-ms', 5000);
    expect(limits()).toEqual({ budgetMs: 600, timeoutMs: 1200 });
  });

  test('a word declared at the top alone is the one in force', () => {
    signedAt('entity', 'watch-read-budget-ms', 500);
    expect(limits()).toEqual({ budgetMs: 500, timeoutMs: 2000 });
  });

  test('a lower level that loosens the level above it cannot be read: the defaults stand', () => {
    // The team word lands first, when it has nothing above it; the entity word that would make it
    // a loosening lands second, and only the load sees the pair.
    signedAt('team', 'watch-read-budget-ms', 5000);
    signedAt('entity', 'watch-read-budget-ms', 600);
    const refused = limits();
    expect(refused.budgetMs).toBe(2000);
    expect(refused.timeoutMs).toBe(2000);
    expect(refused.unknown).toContain('watch-read-budget-ms');
  });

  test('a chain that cannot be read keeps both defaults and says why', () => {
    signedAt('entity', 'watch-read-budget-ms', 900);
    expect(limits().budgetMs).toBe(900);
    // A store that does not parse is exactly "cannot be read": nothing here reads it as a level
    // that declared nothing.
    writeFileSync(entitiesPath(home), 'entities: [unclosed\n');
    const unreadable = limits();
    expect(unreadable.budgetMs).toBe(2000);
    expect(unreadable.timeoutMs).toBe(2000);
    expect(unreadable.unknown).toBeTruthy();
  });
});
