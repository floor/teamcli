// The sessionless walk reads a live handoff the way the session-scoped placement does. When the
// previous server leaves, every pane's root process is re-parented to the system's first process,
// so no server process is left among the caller's ancestors; the server's own record of the pane
// the environment names is then the same proof — the hint names the pane, and the root process
// the server reports for it must be one of the caller's ancestors. Only that pid proof turns the
// walk into the `it runs under herdr` reading the dev-mode lead lifts accept; a root that is not
// an ancestor, a read that fails and no hint at all keep the refusal the walk answered before
// this reading existed. Every process, pane, caller, team file and home below is synthetic.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkCaller, type CallerSources, type Process } from '../src/caller.ts';
import { runConfig } from '../src/commands/config.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T09:00:00Z');
const CONFIG_LINE = "only the owner edits the team's record, from a terminal outside herdr; this call is lead";

// The chain a live handoff leaves: the pane's root shell (1400) was re-parented to the system's
// first process when the previous server left, so no server process is anywhere in it.
const HANDOFF_CHAIN: Process[] = [
  { pid: 1420, name: 'bun' },
  { pid: 1410, name: 'claude' },
  { pid: 1400, name: 'pane-shell' },
  { pid: 1, name: 'system' },
];

function fakeAgent(name: string | null, pane: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace: 'ws1', status: 'idle', cwd: null };
}

/** What one walk asked the server: the panes it read a root pid for, and whether it read an
 *  agent list at all — the sessionless walk must never name a seat, which would read a session. */
type Journal = { rootQueries: string[]; agentReads: number };

function handoffSources(journal: Journal, overrides: Partial<CallerSources> = {}): CallerSources {
  return {
    ancestors: () => HANDOFF_CHAIN,
    agents: () => {
      journal.agentReads += 1;
      return [fakeAgent('lead', 'pane1'), fakeAgent('worker', 'pane2')];
    },
    paneRootPid: (pane) => {
      journal.rootQueries.push(pane);
      return pane === 'pane1' ? 1400 : null;
    },
    env: { HERDR_PANE_ID: 'pane1', TEAMCLI_DEV_MODE: '1' },
    stdinIsTTY: false,
    ...overrides,
  };
}

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A repository holding a lead and a worker seat, both panes recorded in the state, and a home
 *  with no registry record: the team file is what every read falls back to. */
function repo(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-walk-handoff-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
rules:
  - never squash
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
  writeFileSync(join(root, '.agents', 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: { acme: { seats: { lead: { stage: 'ready', pane: 'pane1' }, worker: { stage: 'ready', pane: 'pane2' } }, worktrees: {} } },
  }, null, 2)}\n`);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  return { root, home };
}

function teamFile(root: string): string {
  return readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
}

function logOf(root: string): string {
  const path = join(root, '.agents', 'team.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** `team config set seats.worker.inbound accept` run by a caller the fake sources place: the
 *  walk names this process, and its ancestors are the handoff chain. */
async function configSet(root: string, home: string, sources: CallerSources): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  io.callerSources = () => sources;
  const code = await runConfig(['set', 'seats.worker.inbound', 'accept'], io, { home, env: io.env, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

// --- the walk itself ---------------------------------------------------------------------------

test('walkCaller: the hinted pane root among the ancestors answers the under-herdr reading, without reading an agent list', () => {
  const journal: Journal = { rootQueries: [], agentReads: 0 };
  const walked = walkCaller({ env: { HERDR_PANE_ID: 'pane1', TEAMCLI_DEV_MODE: '1' }, stdinIsTTY: false, callerSources: () => handoffSources(journal) });
  expect(walked).toEqual({ kind: 'unplaced', reason: 'it runs under herdr' });
  expect(journal.rootQueries).toEqual(['pane1']);
  expect(journal.agentReads).toBe(0);
});

test('walkCaller: a root pid that is not an ancestor keeps the detached reading the walk gave before', () => {
  const journal: Journal = { rootQueries: [], agentReads: 0 };
  const sources = handoffSources(journal, { paneRootPid: (pane) => { journal.rootQueries.push(pane); return 9999; } });
  const walked = walkCaller({ env: { HERDR_PANE_ID: 'pane1', TEAMCLI_DEV_MODE: '1' }, stdinIsTTY: false, callerSources: () => sources });
  expect(walked.kind).toBe('unplaced');
  if (walked.kind !== 'unplaced') throw new Error('unreachable');
  expect(walked.reason).not.toBe('it runs under herdr');
  expect(walked.reason).toContain('it is run by an agent (claude) outside herdr');
  expect(walked.reason).toContain('pane pane1');
  expect(journal.rootQueries).toEqual(['pane1']);
  expect(journal.agentReads).toBe(0);
});

test('walkCaller: a server read that fails keeps the detached reading', () => {
  const journal: Journal = { rootQueries: [], agentReads: 0 };
  const sources = handoffSources(journal, { paneRootPid: (pane) => { journal.rootQueries.push(pane); return null; } });
  const walked = walkCaller({ env: { HERDR_PANE_ID: 'pane1' }, stdinIsTTY: false, callerSources: () => sources });
  expect(walked.kind).toBe('unplaced');
  if (walked.kind !== 'unplaced') throw new Error('unreachable');
  expect(walked.reason).not.toBe('it runs under herdr');
  expect(walked.reason).toContain('it is run by an agent (claude) outside herdr');
  expect(journal.rootQueries).toEqual(['pane1']);
});

test('walkCaller: no hint never asks the server, and an empty hint asks it about no pane either', () => {
  for (const env of [{}, { HERDR_PANE_ID: '' }]) {
    const journal: Journal = { rootQueries: [], agentReads: 0 };
    const walked = walkCaller({ env, stdinIsTTY: false, callerSources: () => handoffSources(journal, { env }) });
    expect(walked).toEqual({ kind: 'unplaced', reason: 'it is run by an agent (claude) outside herdr' });
    expect(journal.rootQueries).toEqual([]);
    expect(journal.agentReads).toBe(0);
  }
});

test('walkCaller: a server process among the ancestors still answers the under-herdr reading without a server read', () => {
  const journal: Journal = { rootQueries: [], agentReads: 0 };
  const sources = handoffSources(journal, {
    ancestors: () => [{ pid: 2420, name: 'claude' }, { pid: 2400, name: 'pane-shell' }, { pid: 2000, name: 'herdr' }, { pid: 1, name: 'system' }],
  });
  const walked = walkCaller({ env: { HERDR_PANE_ID: 'pane1' }, stdinIsTTY: false, callerSources: () => sources });
  expect(walked).toEqual({ kind: 'unplaced', reason: 'it runs under herdr' });
  expect(journal.rootQueries).toEqual([]);
  expect(journal.agentReads).toBe(0);
});

// --- the dev-mode lead lift, end to end --------------------------------------------------------

test('config set: the handoff lead is admitted through the dev-mode lift, with its warning and audit line', async () => {
  const { root, home } = repo();
  const journal: Journal = { rootQueries: [], agentReads: 0 };
  const ran = await configSet(root, home, handoffSources(journal));
  expect(ran.code).toBe(0);
  expect(ran.err).toBe(`warning: ${CONFIG_LINE}; dev mode continues\n`);
  expect(teamFile(root)).toContain('inbound: accept');
  expect(logOf(root)).toContain(`config [lead] warning: ${CONFIG_LINE}; dev mode continues; admitted as orchestrator\n`);
});

test('config set: a root pid that is not an ancestor is refused and writes nothing', async () => {
  const { root, home } = repo();
  const before = teamFile(root);
  const journal: Journal = { rootQueries: [], agentReads: 0 };
  const sources = handoffSources(journal, { paneRootPid: (pane) => { journal.rootQueries.push(pane); return 9999; } });
  const ran = await configSet(root, home, sources);
  expect(ran.code).toBe(1);
  expect(ran.err).toContain("team config: only the owner edits the team's record, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr");
  expect(teamFile(root)).toBe(before);
  expect(logOf(root)).toBe('');
});

test('config set: a server read that fails is refused and writes nothing', async () => {
  const { root, home } = repo();
  const before = teamFile(root);
  const journal: Journal = { rootQueries: [], agentReads: 0 };
  const sources = handoffSources(journal, { paneRootPid: (pane) => { journal.rootQueries.push(pane); return null; } });
  const ran = await configSet(root, home, sources);
  expect(ran.code).toBe(1);
  expect(ran.err).toContain("team config: only the owner edits the team's record, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr");
  expect(teamFile(root)).toBe(before);
  expect(logOf(root)).toBe('');
});

test('config set: no hint is refused and writes nothing, and the server is never asked', async () => {
  const { root, home } = repo();
  const before = teamFile(root);
  const journal: Journal = { rootQueries: [], agentReads: 0 };
  const sources = handoffSources(journal, { env: { TEAMCLI_DEV_MODE: '1' } });
  const ran = await configSet(root, home, sources);
  expect(ran.code).toBe(1);
  expect(ran.err).toBe("team config: only the owner edits the team's record, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr)\n");
  expect(journal.rootQueries).toEqual([]);
  expect(teamFile(root)).toBe(before);
  expect(logOf(root)).toBe('');
});
