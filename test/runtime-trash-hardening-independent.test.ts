// Independent scenes for the runtime trash park after the dated folder is opened.
// A link standing in that folder does not receive the file, a link at .config or
// .config/team is refused before anything is written outside, and a dated folder that
// cannot be opened is refused with the named sentence. Synthetic homes only.
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parkInRuntimeTrash, runtimeTrashFolder, runtimeTrashRefusedLine } from '../src/file/runtime-trash.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const BODY = 'stay-with-the-opened-folder';
const homes: string[] = [];
const restore: string[] = [];

afterAll(() => {
  for (const path of restore) {
    try {
      chmodSync(path, 0o700);
    } catch {
      // A folder already restored is left as it stands.
    }
  }
  discardFixtures(homes);
});

function synthetic(): { home: string; outside: string } {
  const home = mkdtempSync(join(tmpdir(), 'runtime-trash-hardening-'));
  const outside = mkdtempSync(join(tmpdir(), 'runtime-trash-outside-'));
  homes.push(home, outside);
  return { home, outside };
}

function retired(home: string): string {
  const path = join(home, 'retired.txt');
  writeFileSync(path, BODY);
  return path;
}

test('a link swapped into the dated folder after it is opened never receives the file', () => {
  const { home, outside } = synthetic();
  const source = retired(home);
  const dated = runtimeTrashFolder(home, NOW);
  mkdirSync(dated, { recursive: true, mode: 0o700 });
  const opened = lstatSync(dated).ino;
  const target = join(outside, 'landed');
  symlinkSync(target, join(dated, 'retired.txt'));

  const parked = parkInRuntimeTrash(source, home, NOW);

  expect(lstatSync(dated).ino).toBe(opened);
  expect(lstatSync(join(dated, 'retired.txt')).isSymbolicLink()).toBe(true);
  expect(parked.to).toBe(join(dated, 'retired.txt-2'));
  expect(readFileSync(parked.to, 'utf8')).toBe(BODY);
  expect(lstatSync(parked.to).isSymbolicLink()).toBe(false);
  expect(readdirSync(outside)).toEqual([]);
});

test('a symlink at .config is refused and nothing is written outside', () => {
  const { home, outside } = synthetic();
  const source = retired(home);
  symlinkSync(outside, join(home, '.config'));
  const dated = runtimeTrashFolder(home, NOW);
  expect(() => parkInRuntimeTrash(source, home, NOW)).toThrow(runtimeTrashRefusedLine(dated));
  expect(readFileSync(source, 'utf8')).toBe(BODY);
  expect(lstatSync(join(home, '.config')).isSymbolicLink()).toBe(true);
  expect(readdirSync(outside)).toEqual([]);
});

test('a symlink at .config/team is refused and nothing is written outside', () => {
  const { home, outside } = synthetic();
  const source = retired(home);
  mkdirSync(join(home, '.config'), { mode: 0o700 });
  symlinkSync(outside, join(home, '.config', 'team'));
  const dated = runtimeTrashFolder(home, NOW);
  expect(() => parkInRuntimeTrash(source, home, NOW)).toThrow(runtimeTrashRefusedLine(dated));
  expect(readFileSync(source, 'utf8')).toBe(BODY);
  expect(lstatSync(join(home, '.config', 'team')).isSymbolicLink()).toBe(true);
  expect(readdirSync(outside)).toEqual([]);
});

test('a mode-000 dated folder is refused with the named sentence and no errno text', () => {
  const { home } = synthetic();
  const source = retired(home);
  const dated = runtimeTrashFolder(home, NOW);
  mkdirSync(dated, { recursive: true, mode: 0o700 });
  restore.push(dated);
  chmodSync(dated, 0o000);
  try {
    let caught: unknown;
    try {
      parkInRuntimeTrash(source, home, NOW);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toBe(runtimeTrashRefusedLine(dated));
    expect(message).not.toContain('EACCES');
    expect(message).not.toContain('EPERM');
    expect(message).not.toContain('ENOTDIR');
    expect(readFileSync(source, 'utf8')).toBe(BODY);
  } finally {
    chmodSync(dated, 0o700);
  }
});
