// `down` stops a pane-less watch pid only under the full ownership proof. The proof already fixed
// this install's CLI entry and session; these scenes pin the team it serves: a watch that names
// another team's file, or was launched from another team's folder, is never this team's watch,
// whatever its pid and start instant say.
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchCommandFile, watchLaunchOf, watchStopRead } from '../src/watch/pane.ts';
import type { WorkingFolderReader } from '../src/watch/process-adapter.ts';

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'watch-proof-')));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

const CLI = realpathSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)));
const NOW = new Date('2026-10-14T09:00:00Z');
const RECORD = { pid: 4242, heartbeat: NOW.toISOString(), started_at: NOW.toISOString() };

/** A project folder holding a team file in the `.agents` layout, as `up` starts a watch in. */
function project(name: string): { root: string; dir: string; file: string } {
  const root = join(BASE, name);
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'team.yaml');
  writeFileSync(file, `format: 1\nproject: ${name}\n`);
  return { root, dir, file };
}

/** A watch command line as a live process would carry it. */
function command(args: string): string {
  return `bun '${CLI}' watch --session shared${args === '' ? '' : ` ${args}`}`;
}

/** The pane-less record a watch with the given command line and working folder makes. */
function read(
  launch: ReturnType<typeof watchLaunchOf>,
  line: string,
  cwd: string | null,
): ReturnType<typeof watchStopRead> {
  return watchStopRead(RECORD, 'shared', {
    alive: () => true,
    commandOf: () => line,
    startOf: () => NOW.getTime() - 1_000,
    cwdOf: () => cwd,
  }, launch);
}

/** A fake process adapter: it answers the one fact the core asks for and records the pids. */
function fakeAdapter(cwd: string | null): { cwdOf: WorkingFolderReader; asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    cwdOf(pid) {
      asked.push(pid);
      return cwd;
    },
  };
}

const mine = project('acme');
const other = project('other');

test('a flagless watch launched in this project folder is proven', () => {
  const launch = watchLaunchOf(mine.file, mine.dir);
  expect(read(launch, command(''), mine.root)).toEqual({ kind: 'proven', pid: 4242 });
  // The `.agents` folder is the same launch: a hand-run watch started there reads the same file.
  expect(read(launch, command(''), mine.dir)).toEqual({ kind: 'proven', pid: 4242 });
});

test('a watch naming another team file is not this team\'s watch', () => {
  const launch = watchLaunchOf(mine.file, mine.dir);
  expect(read(launch, command(`--file '${other.file}'`), mine.root)).toEqual({
    kind: 'unproven',
    pid: 4242,
    why: 'pid 4242 runs a watch for another team file',
  });
});

test('a watch that names no file and started in another folder is not this team\'s watch', () => {
  const launch = watchLaunchOf(mine.file, mine.dir);
  expect(read(launch, command(''), other.root)).toEqual({
    kind: 'unproven',
    pid: 4242,
    why: 'pid 4242 is not a watch launched from this team\'s folder',
  });
});

test('an absolute file naming this team is proven whatever folder the process started in', () => {
  const launch = watchLaunchOf(mine.file, mine.dir);
  expect(read(launch, command(`--file '${mine.file}'`), other.root)).toEqual({ kind: 'proven', pid: 4242 });
});

test('a relative file is resolved from the folder the process started in', () => {
  const launch = watchLaunchOf(mine.file, mine.dir);
  expect(read(launch, command('--file .agents/team.yaml'), mine.root)).toEqual({ kind: 'proven', pid: 4242 });
  // The same relative name from another folder is another team's file.
  expect(read(launch, command('--file .agents/team.yaml'), other.root)).toEqual({
    kind: 'unproven',
    pid: 4242,
    why: 'pid 4242 runs a watch for another team file',
  });
});

test('a working folder that cannot be read leaves a flagless watch unproven', () => {
  const launch = watchLaunchOf(mine.file, mine.dir);
  expect(read(launch, command(''), null)).toEqual({
    kind: 'unproven',
    pid: 4242,
    why: 'pid 4242\'s working folder cannot be read',
  });
});

test('the working folder is read through the process adapter, and only through it', () => {
  const launch = watchLaunchOf(mine.file, mine.dir);
  const adapter = fakeAdapter(mine.root);
  const proven = watchStopRead(RECORD, 'shared', {
    alive: () => true,
    commandOf: () => command(''),
    startOf: () => NOW.getTime() - 1_000,
    cwdOf: adapter.cwdOf,
  }, launch);
  expect(proven).toEqual({ kind: 'proven', pid: 4242 });
  expect(adapter.asked).toEqual([4242]);

  // A caller that wires no adapter reads no folder: the core keeps no reader of its own.
  expect(watchStopRead(RECORD, 'shared', {
    alive: () => true,
    commandOf: () => command(''),
    startOf: () => NOW.getTime() - 1_000,
  }, launch)).toEqual({
    kind: 'unproven',
    pid: 4242,
    why: 'pid 4242\'s working folder cannot be read',
  });
});

test('the adapter\'s folder decides the flagless launch', () => {
  const launch = watchLaunchOf(mine.file, mine.dir);
  const elsewhere = fakeAdapter(other.root);
  expect(watchStopRead(RECORD, 'shared', {
    alive: () => true,
    commandOf: () => command(''),
    startOf: () => NOW.getTime() - 1_000,
    cwdOf: elsewhere.cwdOf,
  }, launch)).toEqual({
    kind: 'unproven',
    pid: 4242,
    why: 'pid 4242 is not a watch launched from this team\'s folder',
  });
  expect(elsewhere.asked).toEqual([4242]);
});

test('the command line names the file it carries, or none', () => {
  expect(watchCommandFile(command(`--file '${mine.file}'`))).toBe(mine.file);
  expect(watchCommandFile(command('--file .agents/team.yaml'))).toBe('.agents/team.yaml');
  // The last occurrence is the one the parser keeps.
  expect(watchCommandFile(command(`--file '${other.file}' --file '${mine.file}'`))).toBe(mine.file);
  expect(watchCommandFile(command(''))).toBeUndefined();
  expect(watchCommandFile(`vim '${CLI}' watch --file '${other.file}'`)).toBeUndefined();
});
