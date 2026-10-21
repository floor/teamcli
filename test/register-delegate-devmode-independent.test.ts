// Independent coverage for `team register` under dev mode when the caller is a delegate pane
// the team file names: the delegation's approval precondition folds exactly as it does for
// `up`, `add` and `remove`, and the run says so once. Everything after that precondition stays
// enforced — the entry must still name `up` in its command list — and a run in force is still
// the bare refusal it always was. A dry run folds the same precondition into its preview and
// writes nothing.
//
// Fake herdr and a temporary home throughout; no live session, pane or CLI home is read.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { readAgents } from '../src/registry/agents.ts';
import { LOG_FILE, readState, STATE_FILE } from '../src/state.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-21T07:30:00Z');
const PANE = 'w1:p1';
const WORKSPACE = 'ws-1';
const OWNER = { kind: 'owner' as const };
/** The caller the file's `delegates` section names: a seat outside this team's own session. */
const DELEGATE: Caller = { kind: 'seat', name: 'lead', pane: 'w2:p1', session: 'floor' };
/** The one sentence the approval precondition refuses with, before dev mode folds it. */
const APPROVAL = 'delegation needs a verified approval: the file was never approved on this machine';

type World = { base: string; home: string; root: string; dir: string; file: string };

const made: string[] = [];

beforeEach(() => {
  // The address refresh reads herdr on its own; an unreadable pane leaves the record alone.
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});

afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary home and one root holding `.agents/team.yaml` with a delegate pane. */
function world(commands: string[] = ['up', 'add', 'remove']): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'reg-delegate-')));
  made.push(base);
  const home = join(base, 'h');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const file = join(dir, 'team.yaml');
  writeFileSync(file, `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ${lobbyDir(home)}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
delegates:
  - pane: floor/w2:p1
    commands: [${commands.join(', ')}]
`);
  return { base, home, root, dir, file };
}

/** The agent herdr reports for the seat: a pane running a program in front of its own shell. */
function seatAgent(): HerdrAgent {
  return { name: 'lead', agent: 'claude', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: null, session: 'claude-session-1' };
}

function sources(w: World): RegisterSources {
  return {
    home: w.home,
    sessionState: () => 'running',
    agents: () => [seatAgent()],
    processInfo: () => ({ shell: 400, foreground: [401] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    now: () => NOW,
  };
}

async function register(w: World, argv: string[], opts: { dev?: boolean; caller?: Caller } = {}) {
  const io = testIo(w.root, opts.caller ?? OWNER);
  if (opts.dev) io.env = { TEAMCLI_DEV_MODE: '1' };
  const code = await runRegister(argv, io, sources(w));
  return { code, out: io.out, err: io.err };
}

/** What the run left on disk: the state file, agent records and the audit log. */
function written(w: World): { state: boolean; agents: number; log: boolean } {
  return {
    state: existsSync(join(w.dir, STATE_FILE)),
    agents: readAgents(w.home).length,
    log: existsSync(join(w.dir, LOG_FILE)),
  };
}

const NOTHING = { state: false, agents: 0, log: false };

test('dev mode folds the delegate approval precondition and the run records the fold', async () => {
  const w = world();
  // The delegate evidence reads herdr: no agents is a clean external pane.
  setHerdrRun(() => ({ agents: [] }));
  const r = await register(w, ['lead'], { dev: true, caller: DELEGATE });
  expect(r.code).toBe(0);
  // The live complaint, now a warning that names the file it stands behind.
  expect(r.err).toContain(`team register: warning: ${APPROVAL}`);
  expect(r.err).toContain('the live team file ');
  expect(r.err).toContain('counts as approved; dev mode continues');
  expect(r.err).not.toContain(`team register: ${APPROVAL}`);
  expect(readState(w.dir).sessions.acme?.seats.lead?.stage).toBe('ready');
  // The run wrote the record, and its provenance carries the dev mark the fold owes.
  const records = readAgents(w.home);
  expect(records).toHaveLength(1);
  expect(records[0]?.provenance.dev_mode).toBe(true);
  expect(readFileSync(join(w.dir, LOG_FILE), 'utf8')).toContain(`warning: ${APPROVAL}`);
});

test('without dev mode the delegate approval precondition is still the bare refusal', async () => {
  const w = world();
  setHerdrRun(() => ({ agents: [] }));
  const r = await register(w, ['lead'], { caller: DELEGATE });
  expect(r.code).toBe(1);
  expect(r.err).toBe(`team register: ${APPROVAL}\n`);
  expect(written(w)).toEqual(NOTHING);
});

test('dev mode folds only the approval: a delegate entry without `up` still refuses', async () => {
  const w = world(['add', 'remove']);
  setHerdrRun(() => ({ agents: [] }));
  const r = await register(w, ['lead'], { dev: true, caller: DELEGATE });
  expect(r.code).toBe(1);
  // The entry itself is the refusal now: the folded precondition let the run reach it.
  expect(r.err).toContain('may not run `up`');
  expect(r.err).toContain('its approved commands are add, remove');
  expect(r.err).not.toContain('dev mode continues');
  expect(written(w)).toEqual(NOTHING);
});

test('a dev-mode dry run previews the folded precondition and writes nothing', async () => {
  const w = world();
  setHerdrRun(() => ({ agents: [] }));
  const r = await register(w, ['lead', '--dry-run'], { dev: true, caller: DELEGATE });
  expect(r.code).toBe(0);
  expect(r.out).toContain(`! warning: ${APPROVAL}`);
  expect(r.out).toContain('nothing would be launched');
  expect(written(w)).toEqual(NOTHING);
});
