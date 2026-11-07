// Independent scenes for the first-run admission helper. One empty account receives one
// create-grant that lasts 24 hours, and a second pass is refused. Synthetic homes only.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';
import { readGrantRecords } from '../src/grant.ts';
import { firstRunAdmission, ownerRecordPath } from '../src/policy/first-minute.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const NOW = new Date('2026-11-06T15:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const TEAM = 'aaaaaaaaaaaa';

function place(registry: string | null): { base: string; home: string; root: string } {
  const base = fixtureBase('admission-helper-');
  const home = join(base, 'home');
  const root = join(base, 'project');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(root, { mode: 0o700 });
  if (registry !== null) {
    mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.config', 'team', 'teams.yaml'), registry);
  }
  return { base, home, root };
}

function drop(base: string): void {
  discardFixtures([base], { roots: [dirname(base)] });
}

function grantNames(home: string): string[] {
  const folder = join(home, '.config', 'team', 'grants');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => name.endsWith('.json')).sort();
}

test('a non-empty account is not admitted', () => {
  const { base, home, root } = place('teams: {}\n');
  try {
    expect(firstRunAdmission({ home, mode: 'empty-account', now: NOW, teamId: TEAM, root })).toEqual({
      ok: false,
      reason: 'non-empty',
    });
    expect(existsSync(ownerRecordPath(home))).toBe(false);
    expect(grantNames(home)).toEqual([]);
  } finally {
    drop(base);
  }
});

test('an empty account is admitted once, and the grant expires in 24 hours', () => {
  const { base, home, root } = place(null);
  try {
    const admitted = firstRunAdmission({ home, mode: 'empty-account', now: NOW, teamId: TEAM, root });
    const expires = new Date(NOW.getTime() + DAY).toISOString();
    expect(admitted).toEqual({ ok: true, expires });
    expect(grantNames(home)).toEqual(['lead.json']);
    const records = readGrantRecords(home);
    expect(records).toHaveLength(1);
    expect(records[0]?.stem).toBe('lead');
    expect(records[0]?.record).toEqual({ team: TEAM, paths: [root], expires });
  } finally {
    drop(base);
  }
});

test('a second pass is refused and the one grant stays', () => {
  const { base, home, root } = place(null);
  try {
    expect(firstRunAdmission({ home, mode: 'empty-account', now: NOW, teamId: TEAM, root }).ok).toBe(true);
    const owner = readFileSync(ownerRecordPath(home));
    const grant = readFileSync(join(home, '.config', 'team', 'grants', 'lead.json'));
    expect(firstRunAdmission({ home, mode: 'empty-account', now: NOW, teamId: TEAM, root })).toEqual({
      ok: false,
      reason: 'second-pass',
    });
    expect(grantNames(home)).toEqual(['lead.json']);
    expect(readFileSync(ownerRecordPath(home))).toEqual(owner);
    expect(readFileSync(join(home, '.config', 'team', 'grants', 'lead.json'))).toEqual(grant);
  } finally {
    drop(base);
  }
});
