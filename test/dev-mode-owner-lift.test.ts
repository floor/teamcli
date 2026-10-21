// The owner's urgent dev-mode admission. While dev mode is on — the variable
// before any policy governs, the effective `dev-mode` policy once one does — a caller placed on
// its recorded pane in the team's session and named the team's orchestrator continues past an
// owner-only gate with the `dev mode continues` warning, and the run is logged with the command
// and the caller. Every other seat, an unrecorded or other-session placement, an unplaced caller,
// and dev mode off keep the refusal. `tempo` is the scene's gate: the smallest owner-only edit
// that writes one line and needs no key, socket or launch. Every file, caller and pane below is
// synthetic.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallerSources } from '../src/caller.ts';
import { runTempo } from '../src/commands/tempo.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
const LEAD = { kind: 'seat' as const, name: 'lead', pane: 'w1:p1', session: 'acme' };
const HELPER = { kind: 'seat' as const, name: 'helper', pane: 'w2:p1', session: 'acme' };
const OWNER_LINE = 'only the owner runs tempo, from a terminal outside herdr';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A repository with a lead seat and a helper seat, their panes recorded in the state, and a home
 *  beside it. The lead is the file's resolved orchestrator; the helper is an ordinary seat. */
function repo(options: { recordLead?: boolean } = {}): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-owner-lift-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
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
  if (options.recordLead !== false) recordSeat(root, 'lead', 'w1:p1');
  recordSeat(root, 'helper', 'w2:p1');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home };
}

/** Write one seat into the state the placement check reads: session, name, recorded pane. */
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

/** The log lines a run wrote beside the team file. */
function logOf(root: string): string {
  const path = join(root, '.agents', 'team.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

test('the variable admits a placed orchestrator: warning, the write, and one audit line', async () => {
  const { root, home } = repo();
  const io = testIo(root, LEAD);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runTempo(['urgent'], io, { home })).toBe(0);
  expect(io.err).toBe(`warning: ${OWNER_LINE}; this call is lead; dev mode continues\n`);
  expect(io.out).toContain('tempo: urgent');
  expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).toContain('tempo: urgent');
  expect(logOf(root)).toContain(`tempo [lead] warning: ${OWNER_LINE}; this call is lead; dev mode continues; admitted as orchestrator\n`);
});

test('unset, and any value but exactly 1, keep the refusal and write nothing', async () => {
  for (const env of [{}, { TEAMCLI_DEV_MODE: 'true' }, { TEAMCLI_DEV_MODE: '0' }]) {
    const { root, home } = repo();
    const io = testIo(root, LEAD);
    io.env = env;
    expect(await runTempo(['urgent'], io, { home })).toBe(1);
    expect(io.err).toBe(`team tempo: ${OWNER_LINE}; this call is lead\n`);
    expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).not.toContain('tempo:');
    expect(logOf(root)).toBe('');
  }
});

test('the mode is on but an ordinary seat is still refused, with no audit line', async () => {
  const { root, home } = repo();
  const io = testIo(root, HELPER);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runTempo(['urgent'], io, { home })).toBe(1);
  expect(io.err).toBe(`team tempo: ${OWNER_LINE}; this call is helper\n`);
  expect(logOf(root)).toBe('');
});

test('the lead name without the recorded pane, or in another session, is refused', async () => {
  const { root, home } = repo();
  const another = testIo(root, { ...LEAD, pane: 'w9:p9' });
  another.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runTempo(['urgent'], another, { home })).toBe(1);
  expect(another.err).toBe(`team tempo: ${OWNER_LINE}; this call is lead\n`);

  const elsewhere = testIo(root, { ...LEAD, session: 'other' });
  elsewhere.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runTempo(['urgent'], elsewhere, { home })).toBe(1);
  expect(elsewhere.err).toBe(`team tempo: ${OWNER_LINE}; this call is lead\n`);
  expect(logOf(root)).toBe('');
});

test('a state that records no pane refuses the lead: the name is not the placement', async () => {
  const { root, home } = repo({ recordLead: false });
  const io = testIo(root, LEAD);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runTempo(['urgent'], io, { home })).toBe(1);
  expect(io.err).toBe(`team tempo: ${OWNER_LINE}; this call is lead\n`);
  expect(logOf(root)).toBe('');
});

test('placement is read from the pane, in the team session, not from a handed-in caller', async () => {
  const { root, home } = repo();
  const io = testIo(root);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  io.callerSources = () => herdrSources('lead', 'w1:p1');
  expect(await runTempo(['urgent'], io, { home })).toBe(0);
  expect(io.err).toContain('dev mode continues');
  expect(logOf(root)).toContain('admitted as orchestrator');
});

test('an unplaced caller under herdr is refused with the mode on', async () => {
  const { root, home } = repo();
  const io = testIo(root);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  io.callerSources = () => ({
    ancestors: () => [{ pid: 500, name: 'herdr' }],
    agents: () => [],
    paneRootPid: () => null,
    env: {},
    stdinIsTTY: false,
  });
  expect(await runTempo(['urgent'], io, { home })).toBe(1);
  expect(io.err).toBe(`team tempo: ${OWNER_LINE}; this call is unplaced (it runs in a herdr pane without an agent)\n`);
  expect(logOf(root)).toBe('');
});

test('a governing dev-mode on admits with its level note, the variable unset', async () => {
  const { root, home } = repo();
  const written = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'dev-mode', value: 'on' }, { now: NOW });
  if (!written.ok) throw new Error(written.why);
  const io = testIo(root, LEAD);
  expect(await runTempo(['relaxed'], io, { home })).toBe(0);
  expect(io.err).toBe(`warning: ${OWNER_LINE}; this call is lead; dev mode continues (dev-mode on at team level)\n`);
  expect(logOf(root)).toContain('dev mode continues (dev-mode on at team level); admitted as orchestrator');
});

test('a governing dev-mode off keeps the refusal and retires the variable', async () => {
  const { root, home } = repo();
  const written = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'dev-mode', value: 'off' }, { now: NOW });
  if (!written.ok) throw new Error(written.why);
  const io = testIo(root, LEAD);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runTempo(['urgent'], io, { home })).toBe(1);
  expect(io.err).toBe(`team tempo: ${OWNER_LINE}; this call is lead\n`);
  expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).not.toContain('tempo:');
  expect(logOf(root)).toBe('');
});
