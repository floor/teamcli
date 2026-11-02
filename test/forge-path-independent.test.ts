// An independent scene: the session server is never handed an empty or a relative PATH when the
// forge shim cannot stand. The checks differ from the feature's own: the fail-closed PATH is
// pinned end-to-end on a MIXED value — a folder holding a
// fake CLI, a relative folder, an empty entry and one free folder — where the free folder alone
// must survive, exactly; the nothing-keepable shape must land on the four system folders, never
// the empty string the fix replaced; and the CLI bound behind a STANDING shim must be the
// absolute one, never a relative folder, even when the relative folder holds a real executable
// CLI. Everything here is fake: a plain script named gh, never the real CLI, and synthetic homes.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { failClosedPath, seatServerEnv, sessionBinDir } from '../src/herdr.ts';

const SYSTEM_FOLDERS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

const roots: string[] = [];
function root(): string {
  const path = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'forge-path-')));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A fake forge CLI: a plain script that does nothing. Never the real one. */
function fakeCli(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const cli = join(dir, 'gh');
  writeFileSync(cli, '#!/bin/sh\nexit 111\n');
  chmodSync(cli, 0o755);
  return cli;
}

/** The session's bin path occupied by a plain file, so the shim cannot stand. */
function brokenShim(home: string): void {
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(sessionBinDir(home), 'not a directory');
}

test('the fail-closed PATH keeps the one free absolute folder of a mixed value, exactly', () => {
  // The holding folder goes, the relative folder and the empty entry go, the free one stays —
  // and nothing else is invented: the answer is that folder, not a list around it.
  expect(failClosedPath('/synthetic/hold:rel/dir::/synthetic/free', (dir) => dir === '/synthetic/hold')).toBe('/synthetic/free');
});

test('nothing keepable is the system folders or a refusal — never the empty string', () => {
  // Every folder holding, so even the system list is refused: null is the refusal the caller
  // turns into not starting the server.
  expect(failClosedPath('/synthetic/hold:rel/dir', () => true)).toBeNull();
  // A value of relative folders and empty entries only falls back to the system folders whole.
  expect(failClosedPath('rel/dir:', () => false)).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  // The original bug's outcome — PATH set to the empty string, which a shell reads as the
  // working folder — is unreachable for any of these shapes.
  for (const value of ['', 'rel', ':', '/synthetic/hold']) {
    const answer = failClosedPath(value, () => true);
    expect(answer === null || (answer !== '' && answer.split(':').every((dir) => isAbsolute(dir)))).toBe(true);
  }
});

test('the server env keeps only the free absolute folder when the shim cannot stand', () => {
  const at = root();
  const home = join(at, 'home');
  mkdirSync(home);
  brokenShim(home);
  const hold = join(at, 'hold');
  fakeCli(hold); // an absolute folder holding an executable fake CLI
  const free = join(at, 'free');
  mkdirSync(free);

  const env = seatServerEnv({ HOME: home, USER: 'fixture', PATH: `${hold}:rel/dir::${free}` }, home);

  expect(env.PATH).toBe(free);
  expect((env.PATH ?? '').split(':')).not.toContain('');
  expect(lstatSync(sessionBinDir(home)).isFile()).toBe(true); // no shim was forced over it
});

test('with nothing keepable the server env lands on the system folders, never empty', () => {
  const at = root();
  const home = join(at, 'home');
  mkdirSync(home);
  brokenShim(home);
  const hold = join(at, 'hold');
  fakeCli(hold);

  const env = seatServerEnv({ HOME: home, USER: 'fixture', PATH: `${hold}:rel/dir:` }, home);

  expect(env.PATH).toBeDefined();
  expect(env.PATH).not.toBe('');
  const entries = (env.PATH ?? '').split(':');
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(isAbsolute(entry)).toBe(true);
    expect(SYSTEM_FOLDERS).toContain(entry);
  }
  expect(entries).not.toContain(hold);
});

test('the CLI bound behind a standing shim is the absolute one, never a relative folder', () => {
  const at = root();
  const home = join(at, 'home');
  mkdirSync(home);
  const absHold = join(at, 'abs-hold');
  const absCli = fakeCli(absHold);
  const relDir = join(at, 'rel-hold');
  fakeCli(relDir);
  // A relative entry that genuinely resolves, from this working folder, to a folder holding an
  // executable fake CLI — the shape the lookup must skip rather than bind.
  const relEntry = relative(process.cwd(), relDir);
  expect(isAbsolute(relEntry)).toBe(false);

  const env = seatServerEnv({ HOME: home, USER: 'fixture', PATH: `${relEntry}:${absHold}` }, home);

  const bin = sessionBinDir(home);
  expect(env.PATH).toBe(`${bin}:${relEntry}:${absHold}`);
  const shim = readFileSync(join(bin, 'gh'), 'utf8');
  expect(shim).toContain(`'${absCli}'`);
  expect(shim).not.toContain(relEntry);
});
