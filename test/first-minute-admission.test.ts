// `first-run-admission` is an owner-signed catalogue word. `empty-account` admits one pass when
// every durable record is absent, and writes one create-grant that expires 24 hours later.
// `off`, an account that already holds a record, and a second pass admit nothing.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPolicy } from '../src/commands/policy.ts';
import { readEntityCreateGrants } from '../src/grant.ts';
import type { Io } from '../src/io.ts';
import { firstRunAdmission, ownerRecordPath } from '../src/policy/first-minute.ts';
import { POLICY_CATALOGUE, resolvePolicy, type Policy } from '../src/policy/index.ts';

const NOW = new Date('2026-11-06T16:00:00Z');
const STAMP = '2026-11-06T16:00:00Z';
const DAY_MS = 24 * 60 * 60 * 1000;
const TEAM = 'aaaaaaaaaaaa';

function word(level: Policy['level'], value: 'off' | 'empty-account'): Policy {
  return { name: 'first-run-admission', value, level, setter: 'owner', date: STAMP, kind: 'enforced' };
}

function homeOf(): { base: string; home: string; root: string } {
  const base = realpathSync(mkdtempSync('/tmp/admit-'));
  const home = join(base, 'home');
  const root = join(base, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  return { base, home, root: realpathSync(root) };
}

describe('first-run-admission catalogue', () => {
  test('the word is off or empty-account, and the release default is empty-account', () => {
    const spec = POLICY_CATALOGUE['first-run-admission'];
    expect(spec.kind).toBe('enforced');
    expect(spec.defaultValue).toBe('empty-account');
    expect(spec.levels).toEqual(['entity', 'project', 'team']);
    expect(spec.parseValue('off')).toBe('off');
    expect(spec.parseValue('empty-account')).toBe('empty-account');
    expect(spec.parseValue('always')).toBeNull();
    const unset = resolvePolicy('first-run-admission', []);
    expect(unset.ok).toBe(true);
    if (unset.ok) expect(unset.effective.value).toBe('empty-account');
  });

  test('a lower level may turn admission off and may not turn it back on', () => {
    const tightened = resolvePolicy('first-run-admission', [word('entity', 'empty-account'), word('team', 'off')]);
    expect(tightened.ok).toBe(true);
    if (tightened.ok) expect(tightened.effective.value).toBe('off');
    const loosened = resolvePolicy('first-run-admission', [word('entity', 'off'), word('team', 'empty-account')]);
    expect(loosened.ok).toBe(false);
  });

  test('team policy keys lists first-run-admission', async () => {
    let out = '';
    const io: Io = {
      stdout: (text) => void (out += text),
      stderr: () => {},
      cwd: '/',
      env: {},
      stdinIsTTY: false,
    };
    expect(await runPolicy(['keys'], io)).toBe(0);
    expect(out.split('\n')).toContain('first-run-admission');
  });
});

describe('first-run-admission refusals', () => {
  test('off admits nothing', () => {
    const dir = homeOf();
    try {
      const result = firstRunAdmission({ home: dir.home, mode: 'off', now: NOW, teamId: TEAM, root: dir.root });
      expect(result).toEqual({ ok: false, reason: 'off' });
      expect(existsSync(ownerRecordPath(dir.home))).toBe(false);
      expect(existsSync(join(dir.home, '.config', 'team', 'grants'))).toBe(false);
    } finally {
      rmSync(dir.base, { recursive: true, force: true });
    }
  });

  test('a non-empty account is refused, and removing one registry file does not reopen it', () => {
    const dir = homeOf();
    try {
      const config = join(dir.home, '.config', 'team');
      mkdirSync(config, { recursive: true });
      writeFileSync(join(config, 'teams.yaml'), 'teams: []\n');
      writeFileSync(join(config, 'entities.yaml'), 'entities: {}\n');
      unlinkSync(join(config, 'teams.yaml'));
      const result = firstRunAdmission({
        home: dir.home,
        mode: 'empty-account',
        now: NOW,
        teamId: TEAM,
        root: dir.root,
      });
      expect(result).toEqual({ ok: false, reason: 'non-empty' });
      expect(existsSync(ownerRecordPath(dir.home))).toBe(false);
    } finally {
      rmSync(dir.base, { recursive: true, force: true });
    }
  });

  test('an empty account is admitted once, with one create-grant that expires in 24 hours', () => {
    const dir = homeOf();
    try {
      const first = firstRunAdmission({
        home: dir.home,
        mode: 'empty-account',
        now: NOW,
        teamId: TEAM,
        root: dir.root,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(Date.parse(first.expires) - NOW.getTime()).toBe(DAY_MS);
      const owner = JSON.parse(readFileSync(ownerRecordPath(dir.home), 'utf8')) as { assurance: string };
      expect(owner.assurance).toBe('none');
      const grants = readEntityCreateGrants(dir.home);
      expect(grants).toEqual([{ entity: null, grantee: { kind: 'team', id: TEAM }, paths: [dir.root], expires: first.expires }]);
      const body = readFileSync(join(dir.home, '.config', 'team', 'grants', 'lead.json'), 'utf8');
      expect(body).not.toContain('dialogs');
      expect(existsSync(join(dir.home, '.config', 'team-key', 'key.json'))).toBe(true);
      const second = firstRunAdmission({
        home: dir.home,
        mode: 'empty-account',
        now: NOW,
        teamId: TEAM,
        root: dir.root,
      });
      expect(second).toEqual({ ok: false, reason: 'second-pass' });
      expect(readdirSync(join(dir.home, '.config', 'team', 'grants'))).toEqual(['lead.json']);
    } finally {
      rmSync(dir.base, { recursive: true, force: true });
    }
  });
});
