// With no trash command, a retired path is parked in the dated runtime trash and never
// unlinked. A path outside the cleanup roots is refused. A symlink moves as a link.
import { afterEach, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { retireTeamFile } from '../src/file/retire.ts';
import { runtimeTrashEmptyLine, runtimeTrashFolder } from '../src/file/runtime-trash.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const NOW = new Date('2026-11-06T08:00:00.000Z');
const DAY = '2026-11-06';
const bases: string[] = [];
const savedPath = process.env.PATH;

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  const held = bases.splice(0);
  discardFixtures(held, { roots: held.map((base) => dirname(base)) });
});

function hideTrash(): void {
  const base = fixtureBase('runtime-trash-bin-');
  bases.push(base);
  process.env.PATH = base;
}

test('no trash command parks the file in the dated runtime trash and names that folder', () => {
  const base = fixtureBase('runtime-trash-');
  bases.push(base);
  const home = join(base, 'throwaway-home');
  const dir = join(base, 'oak');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'note.txt');
  writeFileSync(file, 'kept\n', { mode: 0o600 });
  const before = statSync(file).ino;

  const retired = retireTeamFile(file, { home, now: NOW, trashCommand: null });
  const dated = runtimeTrashFolder(home, NOW);

  expect(retired.how).toBe('parked');
  expect(dated).toBe(join(home, '.config', 'team', 'runtime', 'trash', DAY));
  expect(retired.to).toBe(join(dated, 'note.txt'));
  expect(retired.empty).toBe(runtimeTrashEmptyLine(dated));
  expect(retired.empty).toContain(dated);
  expect(statSync(retired.to).ino).toBe(before);
  expect(() => statSync(file)).toThrow();
});

test('a path outside the cleanup roots is refused when no trash command can be reached', () => {
  const base = fixtureBase('runtime-trash-');
  bases.push(base);
  const scratch = join(base, 'scratch');
  const outside = join(base, 'elsewhere');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  mkdirSync(outside, { recursive: true, mode: 0o700 });
  const file = join(outside, 'note.txt');
  writeFileSync(file, 'stays\n', { mode: 0o600 });
  hideTrash();

  expect(() => discardFixtures([file], { roots: [scratch] })).toThrow(/refusing to remove/);
  expect(statSync(file).isFile()).toBe(true);
});

test('a symlink is parked as a link and its target stays where it is', () => {
  const base = fixtureBase('runtime-trash-');
  bases.push(base);
  const scratch = join(base, 'scratch');
  const dir = join(scratch, 'oak');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(scratch, 'kept.txt');
  writeFileSync(target, 'body\n', { mode: 0o600 });
  const link = join(dir, 'note.txt');
  symlinkSync(target, link);
  const before = lstatSync(link).ino;
  hideTrash();

  discardFixtures([link], { roots: [scratch] });

  const dated = runtimeTrashFolder(dir, new Date());
  const parked = join(dated, 'note.txt');
  expect(dated).toContain(join('runtime', 'trash'));
  expect(lstatSync(parked).isSymbolicLink()).toBe(true);
  expect(lstatSync(parked).ino).toBe(before);
  expect(statSync(target).isFile()).toBe(true);
  expect(() => lstatSync(link)).toThrow();
});
