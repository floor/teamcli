// 1364 keeps grant, delegate and revoke owner-reserved. Dev mode, a governing policy and the
// machine local-fast record do not admit a placed lead or a herdr walk to them. The refusal is
// the owner sentence, with no dev-lift warning and no admission line. Every seat, file, pane
// and home below is synthetic, and no command here touches the live machine.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallerSources } from '../src/caller.ts';
import { runDelegate } from '../src/commands/delegate.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runRevoke } from '../src/commands/revoke.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import { keyOf } from '../src/store/keys.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-20T09:00:00Z');
const LEAD = { kind: 'seat' as const, name: 'lead', pane: 'w1:p1', session: 'acme' };
const OWNER_GRANT = 'only the owner runs this, from a terminal outside herdr';
const SEATS = `seats:
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
`;

let made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository with `lead` as its resolved coordinator and `helper` as an ordinary seat, both
 *  panes recorded in the session state, a home beside it, and any authority records asked for. */
function repo(records = ''): { root: string; home: string; file: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-authority-lift-')));
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
${SEATS}${records}`);
  recordSeat(root, 'lead', 'w1:p1');
  recordSeat(root, 'helper', 'w2:p1');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home, file };
}

/** One seat in the session state the placement check reads. */
function recordSeat(root: string, name: string, pane: string): void {
  const path = join(root, '.agents', 'team.state.json');
  const state = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as { format: number; sessions: Record<string, { seats: Record<string, unknown>; worktrees: Record<string, unknown> }> })
    : { format: 1, sessions: {} };
  const session = (state.sessions.acme ??= { seats: {}, worktrees: {} });
  session.seats[name] = { stage: 'ready', pane };
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** The placed caller a herdr pane reports: one herdr ancestor and the pane's shell as its root. */
function herdrSources(name: string | null, pane: string): CallerSources {
  return {
    ancestors: () => [
      { pid: 501, name: 'zsh' },
      { pid: 500, name: 'herdr' },
    ],
    agents: () => [{ name, agent: 'claude', pane, workspace: 'w1', status: 'idle', cwd: null }],
    paneRootPid: (asked) => (asked === pane ? 501 : null),
    env: {},
    stdinIsTTY: false,
  };
}

function logOf(root: string): string {
  const path = join(root, '.agents', 'team.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** The owner's machine switch, written the way the command writes it, in a synthetic home. */
function seedMachine(home: string, mode: 'local-fast' | 'pr-per-change' | 'off'): void {
  keyOf(home);
  const written = writeDevelopmentMode({ home, mode, now: NOW, caller: 'test' });
  if (!written.ok) throw new Error(written.why);
}

const GRANT_RECORD = `grant:
  session: acme
  seat: lead
  scope: [up, down]
`;
const DELEGATES_RECORD = `delegates:
  - pane: outside/first
    commands: [up, down]
`;

test('the variable does not admit a placed orchestrator to grant', async () => {
  const { root, home, file } = repo();
  const before = readFileSync(file, 'utf8');
  const io = testIo(root, LEAD);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runGrant(['lead', '--scope', 'up,down', '--dry-run'], io, { home })).toBe(1);
  expect(io.out).toBe('');
  expect(io.err).toBe(`team grant: ${OWNER_GRANT}; this call is lead\n`);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(logOf(root)).toBe('');
});

test('the variable does not admit the real grant write', async () => {
  const { root, home, file } = repo();
  const before = readFileSync(file, 'utf8');
  const io = testIo(root, LEAD);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runGrant(['lead', '--scope', 'up,down'], io, { home })).toBe(1);
  expect(io.err).toBe(`team grant: ${OWNER_GRANT}; this call is lead\n`);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(logOf(root)).toBe('');
});

test('delegate stays refused under the same variable', async () => {
  const { root, home, file } = repo();
  const before = readFileSync(file, 'utf8');
  const io = testIo(root, LEAD);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runDelegate(['outside/first', '--commands', 'up', '--dry-run'], io, { home })).toBe(1);
  expect(io.err).toBe(`team delegate: ${OWNER_GRANT}; this call is lead\n`);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(logOf(root)).toBe('');
});

test('revoke stays refused and leaves the grant record', async () => {
  const { root, home, file } = repo(GRANT_RECORD);
  const before = readFileSync(file, 'utf8');
  const io = testIo(root, LEAD);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runRevoke(['grant'], io, { home })).toBe(1);
  expect(io.err).toBe(`team revoke: ${OWNER_GRANT}; this call is lead\n`);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(logOf(root)).toBe('');
});

test('revoke of a delegate record stays refused', async () => {
  const { root, home, file } = repo(DELEGATES_RECORD);
  const before = readFileSync(file, 'utf8');
  const io = testIo(root, LEAD);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runRevoke(['delegate', 'outside/first'], io, { home })).toBe(1);
  expect(io.err).toBe(`team revoke: ${OWNER_GRANT}; this call is lead\n`);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(logOf(root)).toBe('');
});

test('the herdr route is refused the same way, with no dev-lift warning', async () => {
  const { root, home } = repo();
  const io = testIo(root);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  io.callerSources = () => herdrSources('lead', 'w1:p1');
  expect(await runGrant(['lead', '--scope', 'up,down', '--dry-run'], io, { home })).toBe(1);
  expect(io.err).toBe(`team grant: ${OWNER_GRANT}; this call is unplaced (it runs under herdr)\n`);
  expect(logOf(root)).toBe('');
});

test('an ordinary seat is refused with dev mode on, and nothing is written or logged', async () => {
  const { root, home, file } = repo();
  const before = readFileSync(file, 'utf8');
  const io = testIo(root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runGrant(['helper', '--scope', 'up'], io, { home })).toBe(1);
  expect(io.err).toBe(`team grant: ${OWNER_GRANT}; this call is helper\n`);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(logOf(root)).toBe('');
});

test('dev mode off keeps every one of the three refusals, even for the orchestrator', async () => {
  const { root, home } = repo();
  const grantIo = testIo(root, LEAD);
  grantIo.env = {};
  expect(await runGrant(['lead', '--scope', 'up'], grantIo, { home })).toBe(1);
  expect(grantIo.err).toBe(`team grant: ${OWNER_GRANT}; this call is lead\n`);
  const delegateIo = testIo(root, LEAD);
  delegateIo.env = {};
  expect(await runDelegate(['outside/first', '--commands', 'up'], delegateIo, { home })).toBe(1);
  expect(delegateIo.err).toBe(`team delegate: ${OWNER_GRANT}; this call is lead\n`);
  const revokeIo = testIo(root, LEAD);
  revokeIo.env = {};
  expect(await runRevoke(['grant'], revokeIo, { home })).toBe(1);
  expect(revokeIo.err).toBe(`team revoke: ${OWNER_GRANT}; this call is lead\n`);
  expect(logOf(root)).toBe('');
});

test('a governing dev-mode on still refuses the authority commands', async () => {
  const { root, home } = repo();
  const written = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'dev-mode', value: 'on' }, { now: NOW });
  if (!written.ok) throw new Error(written.why);
  const io = testIo(root, LEAD);
  expect(await runGrant(['lead', '--scope', 'up,down', '--dry-run'], io, { home })).toBe(1);
  expect(io.err).toBe(`team grant: ${OWNER_GRANT}; this call is lead\n`);
  expect(logOf(root)).toBe('');
});

test('the herdr route stays refused under a governing dev-mode on', async () => {
  const { root, home } = repo();
  const written = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'dev-mode', value: 'on' }, { now: NOW });
  if (!written.ok) throw new Error(written.why);
  const io = testIo(root);
  io.env = {};
  io.callerSources = () => herdrSources('lead', 'w1:p1');
  expect(await runGrant(['lead', '--scope', 'up,down', '--dry-run'], io, { home })).toBe(1);
  expect(io.err).toBe(`team grant: ${OWNER_GRANT}; this call is unplaced (it runs under herdr)\n`);
  expect(logOf(root)).toBe('');
});

test('the herdr route stays refused under the machine local-fast record', async () => {
  const { root, home } = repo();
  seedMachine(home, 'local-fast');
  const io = testIo(root);
  io.env = {};
  io.callerSources = () => herdrSources('lead', 'w1:p1');
  expect(await runGrant(['lead', '--scope', 'up,down', '--dry-run'], io, { home })).toBe(1);
  expect(io.err).toBe(`team grant: ${OWNER_GRANT}; this call is unplaced (it runs under herdr)\n`);
  expect(logOf(root)).toBe('');
});

test('the herdr route keeps the refusal under the machine off record, even with the variable set', async () => {
  const { root, home } = repo();
  seedMachine(home, 'off');
  const io = testIo(root);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  io.callerSources = () => herdrSources('lead', 'w1:p1');
  expect(await runGrant(['lead', '--scope', 'up,down', '--dry-run'], io, { home })).toBe(1);
  expect(io.err).toBe(`team grant: ${OWNER_GRANT}; this call is unplaced (it runs under herdr)\n`);
  expect(logOf(root)).toBe('');
});

test('a governing dev-mode off retires the variable for the authority commands', async () => {
  const { root, home, file } = repo();
  const written = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'dev-mode', value: 'off' }, { now: NOW });
  if (!written.ok) throw new Error(written.why);
  const before = readFileSync(file, 'utf8');
  const io = testIo(root, LEAD);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runGrant(['lead', '--scope', 'up'], io, { home })).toBe(1);
  expect(io.err).toBe(`team grant: ${OWNER_GRANT}; this call is lead\n`);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(logOf(root)).toBe('');
});
