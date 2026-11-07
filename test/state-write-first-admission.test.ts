import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { grantsDir } from '../src/grant.ts';
import { firstRunAdmission, ownerRecordPath } from '../src/policy/first-minute.ts';
const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-write-admission-'))); dirs.push(base);
  const home = join(base, 'home'); const root = join(base, 'project'); mkdirSync(home); mkdirSync(root);
  return { base, home, root };
}
for (const site of ['owner', 'grant'] as const) for (const dangling of [false, true]) {
  test(`F4 ${site} refuses a link planted after the empty-account reading (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const outside = join(at.base, 'outside'); if (!dangling) writeFileSync(outside, 'unchanged');
    const path = site === 'owner' ? ownerRecordPath(at.home) : join(grantsDir(at.home), 'lead.json');
    let planted = false; const now = new Date('2026-11-07T00:00:00.000Z');
    now.getTime = () => {
      if (!planted) { planted = true; mkdirSync(dirname(path), { recursive: true }); symlinkSync(outside, path); }
      return Date.prototype.getTime.call(now);
    };
    let admitted = false;
    try { admitted = firstRunAdmission({ ...at, mode: 'empty-account', teamId: 'abcdef123456', now }).ok; }
    catch { /* A file refusal may throw; no admission may be reported. */ }
    expect(planted).toBe(true); expect(existsSync(outside)).toBe(!dangling);
    if (!dangling) expect(readFileSync(outside, 'utf8')).toBe('unchanged');
    expect(lstatSync(path).isSymbolicLink()).toBe(true); expect(admitted).toBe(false);
    expect(existsSync(join(at.home, '.config', 'team-key', 'key.json'))).toBe(false);
    if (site === 'grant') expect(existsSync(ownerRecordPath(at.home))).toBe(false);
  });
}

test('F4 creates one owner record and one grant at mode 0600, then refuses a second pass', () => {
  const at = fixture(); const input = { ...at, mode: 'empty-account' as const, teamId: 'abcdef123456', now: new Date('2026-11-07T00:00:00.000Z') };
  expect(firstRunAdmission(input)).toEqual({ ok: true, expires: '2026-11-08T00:00:00.000Z' });
  const owner = ownerRecordPath(at.home); const grant = join(grantsDir(at.home), 'lead.json');
  expect(lstatSync(owner).mode & 0o777).toBe(0o600); expect(lstatSync(grant).mode & 0o777).toBe(0o600);
  const oldOwner = readFileSync(owner, 'utf8'); const oldGrant = readFileSync(grant, 'utf8');
  expect(firstRunAdmission(input)).toEqual({ ok: false, reason: 'second-pass' });
  expect(readFileSync(owner, 'utf8')).toBe(oldOwner); expect(readFileSync(grant, 'utf8')).toBe(oldGrant);
});
test('F4 refuses a linked state directory before creating records in its target', () => {
  const at = fixture(); const outside = join(at.base, 'outside-folder'); mkdirSync(outside);
  mkdirSync(join(at.home, '.config')); symlinkSync(outside, join(at.home, '.config', 'team'));
  expect(() => firstRunAdmission({ ...at, mode: 'empty-account', teamId: 'abcdef123456', now: new Date() })).toThrow();
  expect(existsSync(join(outside, 'owner.json'))).toBe(false); expect(existsSync(join(outside, 'grants'))).toBe(false);
});

test('F4 exclusive owner create refuses a link appearing after destination preflight', () => {
  const at = fixture(); const outside = join(at.base, 'outside'); writeFileSync(outside, 'unchanged');
  const now = new Date('2026-11-07T00:00:00.000Z');
  now.toISOString = () => { symlinkSync(outside, ownerRecordPath(at.home)); return '2026-11-07T00:00:00.000Z'; };
  expect(() => firstRunAdmission({ ...at, mode: 'empty-account', teamId: 'abcdef123456', now })).toThrow();
  expect(readFileSync(outside, 'utf8')).toBe('unchanged'); expect(lstatSync(ownerRecordPath(at.home)).isSymbolicLink()).toBe(true);
});
