// Independent scenes for the runtime trash park guard.
// A link at runtime/, at trash/, or at the dated folder is refused before the parked file moves
// and before anything is written through that link. A file standing where the dated folder
// should be is refused with the named sentence. Synthetic homes only: these scenes never run a
// trash command.
import { afterAll, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeDir } from '../src/daemon/paths.ts';
import { parkInRuntimeTrash, runtimeTrashFolder, runtimeTrashRefusedLine } from '../src/file/runtime-trash.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const BODY = 'stay-put';
const homes: string[] = [];

afterAll(() => discardFixtures(homes));

function synthetic(): { home: string; outside: string } {
  const home = mkdtempSync(join(tmpdir(), 'runtime-trash-guard-'));
  const outside = mkdtempSync(join(tmpdir(), 'runtime-trash-outside-'));
  homes.push(home, outside);
  mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
  return { home, outside };
}

function retired(home: string): string {
  const path = join(home, 'retired.txt');
  writeFileSync(path, BODY);
  return path;
}

function refused(home: string, outside: string, source: string): void {
  const dated = runtimeTrashFolder(home, NOW);
  let caught: unknown;
  try {
    parkInRuntimeTrash(source, home, NOW);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const message = (caught as Error).message;
  expect(message).toBe(runtimeTrashRefusedLine(dated));
  expect(message).not.toContain('ENOTDIR');
  expect(readFileSync(source, 'utf8')).toBe(BODY);
  expect(readdirSync(outside)).toEqual([]);
}

test('a symlink at runtime/ is refused, the parked file stays, and nothing is written outside', () => {
  const { home, outside } = synthetic();
  const source = retired(home);
  const runtime = runtimeDir(home);
  symlinkSync(outside, runtime);
  refused(home, outside, source);
  expect(lstatSync(runtime).isSymbolicLink()).toBe(true);
});

test('a symlink at trash/ is refused, the parked file stays, and nothing is written outside', () => {
  const { home, outside } = synthetic();
  const source = retired(home);
  const runtime = runtimeDir(home);
  mkdirSync(runtime, { mode: 0o700 });
  const trash = join(runtime, 'trash');
  symlinkSync(outside, trash);
  refused(home, outside, source);
  expect(lstatSync(trash).isSymbolicLink()).toBe(true);
});

test('a symlink at the dated folder is refused, the parked file stays, and nothing is written outside', () => {
  const { home, outside } = synthetic();
  const source = retired(home);
  const runtime = runtimeDir(home);
  mkdirSync(join(runtime, 'trash'), { recursive: true, mode: 0o700 });
  const dated = runtimeTrashFolder(home, NOW);
  symlinkSync(outside, dated);
  refused(home, outside, source);
  expect(lstatSync(dated).isSymbolicLink()).toBe(true);
});

test('a file in place of the dated folder is refused with the named sentence, not ENOTDIR', () => {
  const { home, outside } = synthetic();
  const source = retired(home);
  const runtime = runtimeDir(home);
  mkdirSync(join(runtime, 'trash'), { recursive: true, mode: 0o700 });
  const dated = runtimeTrashFolder(home, NOW);
  writeFileSync(dated, 'not-a-directory');
  refused(home, outside, source);
  expect(lstatSync(dated).isFile()).toBe(true);
  expect(readFileSync(dated, 'utf8')).toBe('not-a-directory');
});
