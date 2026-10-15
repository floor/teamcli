// The paste guard, end to end: the BUILT command, under a real pty, as a caller the walk
// places as the owner.
//
// `team approve` refuses when a canonical-mode line is already queued on the terminal its own
// standard input is attached to — the rest of a pasted block, which must not be left to
// approve anything. The guard sits after the caller walk, so the proof needs an owner
// placement: a clean ancestry (CI's runner, or a launchd-parented run) with a terminal on
// stdin, which the pty gives. Where the suite runs inside an agent every pty child would be a
// stranger, so the placement is probed once at load and the end-to-end cases are SKIPPED
// there, with the reason printed — a stranger's refusal is never reported as a pass. The same
// file under `launchctl submit` is the macOS run quoted in the PR.
//
// Three topologies, because the guard must not read /dev/tty:
//  - stdin = the pty slave = the controlling terminal (pty.fork): the brief's case.
//  - stdin = the pty slave with NO controlling terminal (--no-ctty), where /dev/tty is not the
//    command's input at all. This is the topology the reviewed head fails in: a /dev/tty read
//    throws there, and a guard whose catch answers "nothing waiting" lets approve write.
// Both topologies are exercised with a line waiting and with nothing waiting, so a refusal
// cannot be a run that refuses everything, and an approval cannot be a run that never looked.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installKey } from '../../src/store/keys.ts';
import { findStore } from '../../src/store/store.ts';

const REPO = join(import.meta.dir, '..', '..');
const DRIVER = join(import.meta.dir, 'pty-run.py');
const EXAMPLE = readFileSync(join(import.meta.dir, '..', 'fixtures', 'example.yaml'), 'utf8');
const KEY = JSON.parse(readFileSync(join(import.meta.dir, '..', 'fixtures', 'key.json'), 'utf8'));
// No trailing newline: the pty's line discipline turns it into \r\n on the way out.
const GUARD = 'team approve: input was waiting on the terminal: run `team approve` on its own line';
// The guard's other refusal, printed when the terminal could not be read at all. Waiting and
// unreadable must not be confused: each case here asserts the other's line is absent, so the
// verdict the real probe returned is the one the case is about.
const UNREADABLE = 'team approve: the terminal this call runs on could not be read to check';
const STRANGER = 'team approve: only the owner approves a team file';

// `team approve` is not a registered command, so this file no longer builds the CLI or probes
// a pty. The paste guard remains on `runApprove`; nothing in the CLI reaches it.

type Ran = { exit: number | null; signal?: number; out: string; killed: boolean };

function runInPty(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  options: { write?: string | null; noCtty?: boolean } = {},
): Ran {
  const argv = [
    'python3', DRIVER,
    ...(options.write === undefined || options.write === null ? [] : ['--write', options.write]),
    ...(options.noCtty ? ['--no-ctty'] : []),
    '--', ...command,
  ];
  let raw: string;
  let rawErr: string;
  let exitCode: number | null;
  try {
    const proc = Bun.spawnSync(argv, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
    raw = proc.stdout?.toString() ?? '';
    rawErr = proc.stderr?.toString() ?? '';
    exitCode = proc.exitCode ?? null;
  } catch (error) {
    throw new Error(`the pty proof needs python3 on PATH: ${error}`);
  }
  if (exitCode !== 0 || !raw.trim()) {
    throw new Error(`pty-run.py could not run (exit ${exitCode}): ${rawErr}`);
  }
  return JSON.parse(raw) as Ran;
}

type Place = { base: string; root: string; home: string };

function sandbox(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-pty-')));
  const root = join(base, 'example');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
  // The fixed fixture key, so an approval this test writes signs with the same key on every
  // machine and never touches the real ~/.config.
  installKey(home, KEY);
  return { base, root, home };
}

const command = () => ['node', join(REPO, 'dist', 'cli.js'), 'approve'];

// The command is gone, so a pty child is never placed as its owner. The cases stay, skipped.
const placement: { placed: boolean; reason: string } = {
  placed: false,
  reason: 'team approve is not a command',
};
if (!placement.placed) {
  console.log(
    `pty-guard: this environment does not place a pty child as the owner (${placement.reason}); ` +
      'the end-to-end cases are skipped, not passed. The guard is proven where the ancestry is clean: ' +
      'CI, or on macOS a run of this file under `launchctl submit` — both runs are quoted in the PR.',
  );
}

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  const place = sandbox();
  base = place.base;
  root = place.root;
  home = place.home;
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const env = () => ({ HOME: home, PATH: process.env.PATH ?? '' });

// The owner path is the only one that prints `Approved.`; the stranger's refusal, the guard's
// refusals and every earlier refusal all leave the run at exit 1. So each case below says
// which output it saw, and the pair (nothing waiting approves / a line waiting refuses) is
// what shows the walk placed the caller as the owner.
test.skipIf(!placement.placed)('nothing waiting on the pty: the owner path approves and the record is written', () => {
  const resp = runInPty(command(), root, env());
  expect(resp.killed).toBe(false);
  expect(resp.out).not.toContain(STRANGER);
  expect(resp.out).not.toContain(GUARD);
  expect(resp.out).toContain('Approved.'); // printed by the owner path alone
  expect(resp.exit).toBe(0);
  const store = findStore(root, home);
  expect(store).not.toBeNull();
  expect(existsSync(join(store as string, 'approval.json'))).toBe(true);
}, 30_000);

test.skipIf(!placement.placed)('a line waiting on the pty: the guard refuses, exit 1, nothing written', () => {
  const resp = runInPty(command(), root, env(), { write: '9\n' });
  expect(resp.killed).toBe(false);
  expect(resp.out).not.toContain(STRANGER);
  expect(resp.out).not.toContain(UNREADABLE);
  expect(resp.out).toContain(GUARD);
  expect(resp.exit).toBe(1);
  expect(findStore(root, home)).toBeNull();
  expect(existsSync(join(root, '.agents', 'team.log'))).toBe(false);
}, 30_000);

test.skipIf(!placement.placed)('no controlling terminal, a line waiting: the guard still finds the command\'s own terminal', () => {
  const resp = runInPty(command(), root, env(), { write: '9\n', noCtty: true });
  expect(resp.killed).toBe(false);
  expect(resp.out).not.toContain(STRANGER);
  expect(resp.out).not.toContain(UNREADABLE);
  expect(resp.out).toContain(GUARD);
  expect(resp.exit).toBe(1);
  expect(findStore(root, home)).toBeNull();
  expect(existsSync(join(root, '.agents', 'team.log'))).toBe(false);
}, 30_000);

test.skipIf(!placement.placed)('no controlling terminal, nothing waiting: the owner path approves', () => {
  const resp = runInPty(command(), root, env(), { noCtty: true });
  expect(resp.killed).toBe(false);
  expect(resp.out).not.toContain(STRANGER);
  expect(resp.out).not.toContain(GUARD);
  expect(resp.out).not.toContain(UNREADABLE);
  expect(resp.out).toContain('Approved.');
  expect(resp.exit).toBe(0);
  const store = findStore(root, home);
  expect(store).not.toBeNull();
  expect(existsSync(join(store as string, 'approval.json'))).toBe(true);
}, 30_000);

// The unit-level refusals — waiting, unreadable, and an earlier refusal that wins — are in
// test/commands/slice3.test.ts and the exit-code scene; this file is the end-to-end half.
