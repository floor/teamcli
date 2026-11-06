// A machine with no trash binary parks a retired file in the dated runtime trash. The seam
// injects that absence: the scene never spawns a trash command, and the file is renamed, not deleted.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runtimeDir } from '../src/daemon/paths.ts';
import { retireTeamFile } from '../src/file/retire.ts';
import { parkInRuntimeTrash, runtimeTrashFolder, runtimeTrashRefusedLine } from '../src/file/runtime-trash.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const NOW = new Date('2026-11-06T08:00:00.000Z');
const made: string[] = [];
const savedPath = process.env.PATH;

function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  made.push(path);
  return path;
}

afterEach(() => {
  // This suite is the park itself. Cleanup takes the no-trash path (a rename into the dated
  // runtime trash) so a slow system trash cannot hold the hook, and the mkdtemp homes are gone.
  process.env.PATH = '/bin:/usr/sbin:/sbin';
  try {
    discardFixtures(made.splice(0));
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

test('no trash binary parks the file in the dated runtime trash and says how to empty it', () => {
  const home = scratch('runtime-trash-home-');
  const dir = scratch('runtime-trash-src-');
  const file = join(dir, 'team.yaml');
  writeFileSync(file, 'kept\n');
  const retired = retireTeamFile(file, { home, now: NOW, trashCommand: null });
  const dated = runtimeTrashFolder(home, NOW);
  expect(retired.how).toBe('parked');
  expect(retired.to).toBe(join(dated, 'team.yaml'));
  expect(retired.empty).toBe(`empty it by removing the dated folder ${dated}`);
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(retired.to, 'utf8')).toBe('kept\n');
});

test('a trash command that cannot be started parks the same way, and a second file keeps both', () => {
  const home = scratch('runtime-trash-home-');
  const dir = scratch('runtime-trash-src-');
  mkdirSync(join(dir, 'pair'), { recursive: true });
  const first = join(dir, 'pair', 'note.txt');
  const second = join(dir, 'note.txt');
  writeFileSync(first, 'one\n');
  writeFileSync(second, 'two\n');
  const missing: [string, string[]] = ['/nonexistent/team-trash-bin', []];
  const parked = retireTeamFile(first, { home, now: NOW, trashCommand: missing });
  const again = retireTeamFile(second, { home, now: NOW, trashCommand: null });
  expect(parked.how).toBe('parked');
  expect(again.to).toBe(join(runtimeTrashFolder(home, NOW), 'note.txt-2'));
  expect(readFileSync(parked.to, 'utf8')).toBe('one\n');
  expect(readFileSync(again.to, 'utf8')).toBe('two\n');
});

test('a symlink at runtime, trash, or the dated folder is refused and the file stays put', () => {
  const outside = scratch('runtime-trash-outside-');
  for (const level of ['runtime', 'trash', 'dated'] as const) {
    const home = scratch('runtime-trash-home-');
    const dir = scratch('runtime-trash-src-');
    const file = join(dir, 'team.yaml');
    writeFileSync(file, 'kept\n');
    const runtime = runtimeDir(home);
    mkdirSync(dirname(runtime), { recursive: true });
    if (level === 'runtime') symlinkSync(outside, runtime);
    else if (level === 'trash') {
      mkdirSync(runtime);
      symlinkSync(outside, join(runtime, 'trash'));
    } else {
      mkdirSync(join(runtime, 'trash'), { recursive: true });
      symlinkSync(outside, runtimeTrashFolder(home, NOW));
    }
    const dated = runtimeTrashFolder(home, NOW);
    expect(() => parkInRuntimeTrash(file, home, NOW)).toThrow(runtimeTrashRefusedLine(dated));
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(outside)).not.toContain('team.yaml');
  }
});

test('a file standing where the dated folder should be is refused by name, not by a raw code', () => {
  const home = scratch('runtime-trash-home-');
  const dir = scratch('runtime-trash-src-');
  const file = join(dir, 'team.yaml');
  writeFileSync(file, 'kept\n');
  const dated = runtimeTrashFolder(home, NOW);
  mkdirSync(dirname(dated), { recursive: true });
  writeFileSync(dated, 'not a folder\n');
  let caught: unknown;
  try {
    parkInRuntimeTrash(file, home, NOW);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(runtimeTrashRefusedLine(dated));
  expect((caught as Error).message).not.toContain('ENOTDIR');
  expect(existsSync(file)).toBe(true);
});

test('a park lands in the opened dated folder and leaves a link standing in it', () => {
  const outside = scratch('runtime-trash-outside-');
  const home = scratch('runtime-trash-home-');
  const dir = scratch('runtime-trash-src-');
  const file = join(dir, 'team.yaml');
  writeFileSync(file, 'kept\n');
  const dated = runtimeTrashFolder(home, NOW);
  mkdirSync(dated, { recursive: true });
  const inode = lstatSync(dated).ino;
  symlinkSync(join(outside, 'gone'), join(dated, 'team.yaml'));
  const parked = parkInRuntimeTrash(file, home, NOW);
  expect(lstatSync(dated).ino).toBe(inode);
  expect(lstatSync(join(dated, 'team.yaml')).isSymbolicLink()).toBe(true);
  expect(parked.to).toBe(join(dated, 'team.yaml-2'));
  expect(readFileSync(parked.to, 'utf8')).toBe('kept\n');
  expect(existsSync(file)).toBe(false);
  expect(readdirSync(outside)).not.toContain('team.yaml');
});

test('a symlink at .config or .config/team is refused and the file stays put', () => {
  const outside = scratch('runtime-trash-outside-');
  for (const level of ['.config', '.config/team'] as const) {
    const home = scratch('runtime-trash-home-');
    const dir = scratch('runtime-trash-src-');
    const file = join(dir, 'team.yaml');
    writeFileSync(file, 'kept\n');
    if (level === '.config/team') mkdirSync(join(home, '.config'));
    symlinkSync(outside, join(home, level));
    const dated = runtimeTrashFolder(home, NOW);
    expect(() => parkInRuntimeTrash(file, home, NOW)).toThrow(runtimeTrashRefusedLine(dated));
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(outside)).not.toContain('team.yaml');
  }
});

test('a dated folder the park cannot open is refused by name, not by a raw permission code', () => {
  const home = scratch('runtime-trash-home-');
  const dir = scratch('runtime-trash-src-');
  const file = join(dir, 'team.yaml');
  writeFileSync(file, 'kept\n');
  const dated = runtimeTrashFolder(home, NOW);
  mkdirSync(dated, { recursive: true });
  chmodSync(dated, 0o000);
  try {
    let caught: unknown;
    try {
      parkInRuntimeTrash(file, home, NOW);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(runtimeTrashRefusedLine(dated));
    expect((caught as Error).message).not.toContain('EACCES');
    expect((caught as Error).message).not.toContain('EPERM');
    expect(existsSync(file)).toBe(true);
  } finally {
    chmodSync(dated, 0o700);
  }
});
