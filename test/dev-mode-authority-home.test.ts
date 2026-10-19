// The production home the authority commands hand their dev-mode admission. The commands take an
// optional home (tests and callers may name one); a real CLI run supplies none, and the gate must
// still read the central resolver's sources — a governing `dev-mode` policy or the machine
// `local-fast` record — instead of refusing before it can read them. `homedir()` is the one
// lookup involved, and this file is the one place that replaces it: the mock stands in before
// any command module is loaded, so every `homedir()` call in the run answers the synthetic home.
// The caller is a herdr walk, as a real seat's call is; no live file or home is read.
import { afterEach, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as realOs from 'node:os';
import { join } from 'node:path';
import type { CallerSources } from '../src/caller.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { keyOf } from '../src/store/keys.ts';

const NOW = new Date('2026-10-20T09:00:00Z');
const OWNER_GRANT = 'only the owner runs this, from a terminal outside herdr';
const UNPLACED = 'unplaced (it runs under herdr)';
let fakeHome = '';

// Registered before the command modules load (they are imported dynamically below), so every
// `homedir()` in the run answers `fakeHome`. The real module's other exports are untouched.
mock.module('node:os', () => ({ ...realOs, homedir: () => fakeHome }));

let made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): { root: string; home: string; file: string } {
  const base = realpathSync(mkdtempSync(join(realOs.tmpdir(), 'team-authority-home-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(file, `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
  recordSeat(root, 'lead', 'w1:p1');
  recordSeat(root, 'helper', 'w2:p1');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: { ...process.env, HOME: realOs.homedir() }, stdio: 'ignore' });
  return { root, home, file };
}

function recordSeat(root: string, name: string, pane: string): void {
  const path = join(root, '.agents', 'team.state.json');
  const state = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as { format: number; sessions: Record<string, { seats: Record<string, unknown>; worktrees: Record<string, unknown> }> })
    : { format: 1, sessions: {} };
  const session = (state.sessions.acme ??= { seats: {}, worktrees: {} });
  session.seats[name] = { stage: 'ready', pane };
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function herdrSources(): CallerSources {
  return {
    ancestors: () => [
      { pid: 501, name: 'zsh' },
      { pid: 500, name: 'herdr' },
    ],
    agents: () => [{ name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
    paneRootPid: (asked) => (asked === 'w1:p1' ? 501 : null),
    env: {},
    stdinIsTTY: false,
  };
}

function logOf(root: string): string {
  const path = join(root, '.agents', 'team.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function seedMachine(home: string, mode: 'local-fast' | 'pr-per-change' | 'off'): void {
  keyOf(home);
  const written = writeDevelopmentMode({ home, mode, now: NOW, caller: 'test' });
  if (!written.ok) throw new Error(written.why);
}

/** The io a real CLI run builds: no handed-in caller, herdr placement by the walk. The helper
 *  module is imported after the mock, like the command modules, so its graph sees it too. */
async function ioAt(root: string) {
  const { testIo } = await import('./helpers.ts');
  const io = testIo(root);
  io.env = {};
  io.callerSources = () => herdrSources();
  return io;
}

test('no supplied home: the herdr route still reads the machine local-fast record for grant', async () => {
  const { root, home } = repo();
  seedMachine(home, 'local-fast');
  fakeHome = home;
  const { runGrant } = await import('../src/commands/grant.ts');
  const io = await ioAt(root);
  expect(await runGrant(['lead', '--scope', 'up,down', '--dry-run'], io)).toBe(0);
  expect(io.err).toContain(`this call is ${UNPLACED}; dev mode continues (dev-mode on at machine level)`);
  expect(logOf(root)).toContain('admitted as orchestrator');
});

test('no supplied home: the herdr route reads the machine record for delegate and revoke too', async () => {
  const { root, home } = repo();
  seedMachine(home, 'local-fast');
  fakeHome = home;
  const { runDelegate } = await import('../src/commands/delegate.ts');
  const delegateIo = await ioAt(root);
  expect(await runDelegate(['outside/first', '--commands', 'up', '--dry-run'], delegateIo)).toBe(0);
  expect(delegateIo.err).toContain('dev mode continues (dev-mode on at machine level)');
  const { runRevoke } = await import('../src/commands/revoke.ts');
  const revokeIo = await ioAt(root);
  expect(await runRevoke(['grant'], revokeIo)).toBe(0);
  expect(revokeIo.err).toContain('dev mode continues (dev-mode on at machine level)');
});

test('no supplied home: the herdr route reads a governing team policy', async () => {
  const { root, home } = repo();
  const written = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'dev-mode', value: 'on' }, { now: NOW });
  if (!written.ok) throw new Error(written.why);
  fakeHome = home;
  const { runGrant } = await import('../src/commands/grant.ts');
  const io = await ioAt(root);
  expect(await runGrant(['lead', '--scope', 'up,down', '--dry-run'], io)).toBe(0);
  expect(io.err).toContain('dev mode continues (dev-mode on at team level)');
  expect(logOf(root)).toContain('admitted as orchestrator');
});

test('no supplied home: the machine off record keeps the refusal, and the variable cannot revive it', async () => {
  const { root, home } = repo();
  seedMachine(home, 'off');
  fakeHome = home;
  const { runGrant } = await import('../src/commands/grant.ts');
  const io = await ioAt(root);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runGrant(['lead', '--scope', 'up,down', '--dry-run'], io)).toBe(1);
  expect(io.err).toBe(`team grant: ${OWNER_GRANT}; this call is ${UNPLACED}\n`);
  expect(logOf(root)).toBe('');
});
