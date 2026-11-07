// Independent scenes: the first empty-account admission writes its two records without following a link.
// Aimed at 5c6b1f309. A link at either record, or in the config folder ladder, is refused before either file is written.
// The key mint is stubbed, so this scene never opens a key store. The fixture home is an unresolved path under the system temp folder.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardFixtures } from './fixture-cleanup.ts';

const realKeys = { ...await import('../src/store/keys.ts') };
let minted = 0;
mock.module('../src/store/keys.ts', () => ({
  ...realKeys,
  keyOf: () => {
    minted += 1;
    return {};
  },
}));
const { FileWriteRefusal } = await import('../src/file-write.ts');
const { firstRunAdmission, ownerRecordPath } = await import('../src/policy/first-minute.ts');

const OUTSIDE = 'synthetic outside data\n';
const TEAM = 'abcdef123456';
const NOW = new Date('2026-11-07T04:00:00.000Z');
const EXPIRES = '2026-11-08T04:00:00.000Z';
const priorHome = process.env.HOME;
const roots: string[] = [];

afterEach(() => {
  discardFixtures(roots.splice(0));
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
});

afterAll(() => {
  mock.module('../src/store/keys.ts', () => realKeys);
});

function place(): { base: string; home: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), 'state-write-'));
  roots.push(base);
  const home = join(base, 'home');
  const project = join(base, 'project');
  mkdirSync(home);
  mkdirSync(project);
  return { base, home, root: project };
}

function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function ownerText(): string {
  return `${JSON.stringify({ assurance: 'none', at: NOW.toISOString() }, null, 2)}\n`;
}

function grantText(root: string): string {
  return `${JSON.stringify({ team: TEAM, paths: [root], expires: EXPIRES }, null, 2)}\n`;
}

function grantPath(home: string): string {
  return join(home, '.config', 'team', 'grants', 'lead.json');
}

/** Plant during the expiry read, after the empty-account look and before either record is written. */
function clock(plant: () => void): Date {
  const now = new Date(NOW.getTime());
  let planted = false;
  now.getTime = () => {
    if (!planted) {
      planted = true;
      plant();
    }
    return NOW.getTime();
  };
  return now;
}

function admit(home: string, root: string, now: Date): { ok: true; expires: string } | { ok: false; reason: string } | 'refused' {
  process.env.HOME = home;
  try {
    return firstRunAdmission({ home, mode: 'empty-account', now, teamId: TEAM, root });
  } catch (error) {
    expect(error).toBeInstanceOf(FileWriteRefusal);
    return 'refused';
  }
}

function outsideFile(folder: string, kind: 'live' | 'dangling'): string {
  const path = join(folder, 'outside.txt');
  if (kind === 'live') writeFileSync(path, OUTSIDE);
  return path;
}

test('the first admission writes both records at mode 0600 and a second pass changes nothing', () => {
  const { home, root } = place();
  const before = minted;
  expect(admit(home, root, NOW)).toEqual({ ok: true, expires: EXPIRES });
  const owner = ownerRecordPath(home);
  const grant = grantPath(home);
  expect(lstatSync(owner).mode & 0o777).toBe(0o600);
  expect(lstatSync(grant).mode & 0o777).toBe(0o600);
  expect(readFileSync(owner, 'utf8')).toBe(ownerText());
  expect(readFileSync(grant, 'utf8')).toBe(grantText(root));
  for (const folder of [join(home, '.config'), join(home, '.config', 'team'), join(home, '.config', 'team', 'grants')]) {
    const held = lstatSync(folder);
    expect(held.isDirectory()).toBe(true);
    expect(held.mode & 0o777).toBe(0o700);
  }
  expect(minted).toBe(before + 1);
  expect(absent(join(home, '.config', 'team-key', 'key.json'))).toBe(true);
  const ownerBytes = readFileSync(owner);
  const grantBytes = readFileSync(grant);
  expect(admit(home, root, NOW)).toEqual({ ok: false, reason: 'second-pass' });
  expect(readFileSync(owner)).toEqual(ownerBytes);
  expect(readFileSync(grant)).toEqual(grantBytes);
  expect(minted).toBe(before + 1);
});

test('a link at either record is refused before either file is written', () => {
  for (const which of ['owner', 'grant'] as const) {
    for (const kind of ['live', 'dangling'] as const) {
      const { base, home, root } = place();
      const before = minted;
      let target = '';
      const result = admit(home, root, clock(() => {
        mkdirSync(join(home, '.config', 'team', 'grants'), { recursive: true });
        target = outsideFile(base, kind);
        const link = which === 'owner' ? ownerRecordPath(home) : grantPath(home);
        symlinkSync(kind === 'live' ? target : join(target, 'missing'), link);
      }));
      expect(result).toBe('refused');
      expect(minted).toBe(before);
      if (kind === 'live') expect(readFileSync(target, 'utf8')).toBe(OUTSIDE);
      else expect(absent(join(target, 'missing'))).toBe(true);
      expect(lstatSync(which === 'owner' ? ownerRecordPath(home) : grantPath(home)).isSymbolicLink()).toBe(true);
      expect(absent(ownerRecordPath(home)) || lstatSync(ownerRecordPath(home)).isSymbolicLink()).toBe(true);
      expect(absent(grantPath(home)) || lstatSync(grantPath(home)).isSymbolicLink()).toBe(true);
      if (which === 'grant') expect(absent(ownerRecordPath(home))).toBe(true);
    }
  }
});

test('a link in the config folder ladder is refused before either record is written', () => {
  for (const part of ['.config', 'team', 'grants'] as const) {
    const { base, home, root } = place();
    const before = minted;
    let outside = '';
    const result = admit(home, root, clock(() => {
      outside = join(base, 'outside-dir');
      mkdirSync(outside);
      writeFileSync(join(outside, 'marker.txt'), OUTSIDE);
      if (part === '.config') symlinkSync(outside, join(home, '.config'));
      else if (part === 'team') {
        mkdirSync(join(home, '.config'));
        symlinkSync(outside, join(home, '.config', 'team'));
      } else {
        mkdirSync(join(home, '.config', 'team'), { recursive: true });
        symlinkSync(outside, join(home, '.config', 'team', 'grants'));
      }
    }));
    expect(result).toBe('refused');
    expect(minted).toBe(before);
    expect(readFileSync(join(outside, 'marker.txt'), 'utf8')).toBe(OUTSIDE);
    expect(absent(join(outside, 'owner.json'))).toBe(true);
    expect(absent(join(outside, 'lead.json'))).toBe(true);
    expect(absent(join(outside, 'grants', 'lead.json'))).toBe(true);
    expect(absent(ownerRecordPath(home))).toBe(true);
  }
});
