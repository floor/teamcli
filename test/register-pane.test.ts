// `team register <seat> --pane <id>`: a running pane herdr never named — a seat started before
// this team managed the session — is named as the seat through the host and recorded the way a
// seat herdr already answers to is. The pane is held to the same reading: it runs in the team's
// own session, its foreground cli is the file's seat cli, and no other seat's record holds it.
// Fake herdr, a temporary home and a pinned caller: no live session is read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { findAgent, readAgents } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, LOG_FILE, readState, STATE_FILE, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T10:00:00Z');
const OWNER = { kind: 'owner' as const };
const PANE = 'w1:p1';

const made: string[] = [];
beforeEach(() => {
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});
afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; home: string; root: string; dir: string };

function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'reg-pane-')));
  made.push(base);
  const home = join(base, 'h');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
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
`);
  return { base, home, root, dir: join(root, '.agents') };
}

/** The agent herdr reports for the seat: a pane running a program in front of its own shell. */
function agent(name: string): HerdrAgent {
  return { name, agent: 'claude', pane: PANE, workspace: 'ws-1', status: 'idle', cwd: null, session: 'claude-session-1' };
}

function sources(w: World, over: Partial<RegisterSources> = {}): RegisterSources {
  return {
    home: w.home,
    sessionState: () => 'running',
    agents: () => [agent('lead')],
    processInfo: () => ({ shell: 400, foreground: [401] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    now: () => NOW,
    ...over,
  };
}

async function register(w: World, argv: string[], over: Partial<RegisterSources> = {}): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(w.root, OWNER);
  const code = await runRegister(argv, io, sources(w, over));
  return { code, out: io.out, err: io.err };
}

/** The host rename, recorded: a scene shows what it was told, and when. */
function named(calls: string[]): Partial<RegisterSources> {
  return {
    renameAgent: (session, pane, name) => {
      calls.push(`${session} ${pane} ${name}`);
      return true;
    },
  };
}

/** What the run left on disk: the state file, agent records, the log and the pane pointers. */
function written(w: World): { state: boolean; agents: number; log: boolean; panes: boolean } {
  return {
    state: existsSync(join(w.dir, STATE_FILE)),
    agents: readAgents(w.home).length,
    log: existsSync(join(w.dir, LOG_FILE)),
    panes: existsSync(join(w.home, '.config', 'team', 'panes')),
  };
}

const NOTHING = { state: false, agents: 0, log: false, panes: false };

const teamId = (w: World): string => teamIdOf(w.root);

describe('registering an unnamed pane with --pane', () => {
  test('the reading a launch left before the registration is retired with the new record', async () => {
    // A `working` written by the previous launch's hook belongs to the record this run replaces;
    // it must not answer for the seat the run just recorded. The seat's next prompt writes it.
    const w = world();
    mkdirSync(join(w.dir, 'seat-state'), { recursive: true });
    writeFileSync(join(w.dir, 'seat-state', 'lead.json'), `{"state":"working","since":"${NOW.toISOString()}"}\n`);
    const r = await register(w, ['lead', '--pane', 'w2:p2'], {
      agents: () => [],
      foreground: () => ['claude'],
      ...named([]),
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(w.dir, 'seat-state', 'lead.json'))).toBe(false);
  });

  test('names the pane as the seat through the host, then records it', async () => {
    const w = world();
    const calls: string[] = [];
    const r = await register(w, ['lead', '--pane', 'w2:p2'], {
      // herdr names no agent of the seat — the pane is one it never named.
      agents: () => [],
      foreground: () => ['claude'],
      ...named(calls),
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain('lead: registered — pane w2:p2; the pane was named lead, nothing was launched');
    // The rename a launch runs, through the host, and before anything was recorded.
    expect(calls).toEqual(['acme w2:p2 lead']);

    const held = readState(w.dir).sessions.acme?.seats.lead;
    expect(held?.stage).toBe('ready');
    expect(held?.pane).toBe('w2:p2');
    // The pane's own reading, recorded as it was, and only what a launch can know: herdr lists
    // no agent on that pane, so no workspace and no agent session are carried.
    expect(held?.launched).toEqual({ shell: 400, cli: [401] });
    expect(held?.workspace).toBeUndefined();
    expect(held?.agent_session).toBeUndefined();

    const record = findAgent(w.home, { team: teamId(w), seat: 'lead' });
    expect(record?.reach.pane).toBe('w2:p2');
    expect(record?.lifecycle).toBe('running');
    expect(record?.seat_handle).toBe(held?.id);

    expect(written(w).panes).toBe(true);
  });

  test('--dry-run says what it would name and record, and nothing is written or renamed', async () => {
    const w = world();
    const calls: string[] = [];
    const r = await register(w, ['lead', '--pane', 'w2:p2', '--dry-run'], {
      agents: () => [],
      foreground: () => ['claude'],
      ...named(calls),
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain(
      'lead: would register — pane w2:p2; the pane would be named lead and recorded, nothing would be launched',
    );
    expect(calls).toEqual([]);
    expect(written(w)).toEqual(NOTHING);
  });

  test('is refused when no such pane runs in the session', async () => {
    const w = world();
    const calls: string[] = [];
    const r = await register(w, ['lead', '--pane', 'w9:p9'], {
      agents: () => [],
      foreground: () => ['claude'],
      processInfo: () => null,
      ...named(calls),
    });

    expect(r.code).toBe(1);
    expect(r.err).toContain('no pane w9:p9 in session "acme"');
    expect(calls).toEqual([]);
    expect(written(w)).toEqual(NOTHING);
  });

  test('is refused when the pane holds another cli than the file\'s seat', async () => {
    const w = world();
    const calls: string[] = [];
    const r = await register(w, ['lead', '--pane', 'w2:p2'], {
      agents: () => [],
      foreground: () => ['zsh'],
      ...named(calls),
    });

    expect(r.code).toBe(1);
    expect(r.err).toContain('holds no `claude-code` process');
    expect(calls).toEqual([]);
    expect(written(w)).toEqual(NOTHING);
  });

  test('is refused when another seat\'s record already holds the pane', async () => {
    const w = world();
    const calls: string[] = [];
    updateState(w.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = { stage: 'ready', pane: 'w2:p2' };
    });

    const r = await register(w, ['lead', '--pane', 'w2:p2'], {
      agents: () => [],
      foreground: () => ['claude'],
      ...named(calls),
    });

    expect(r.code).toBe(1);
    expect(r.err).toContain('pane w2:p2 is worker\'s in session "acme"');
    expect(calls).toEqual([]);
    expect(readState(w.dir).sessions.acme?.seats.lead).toBeUndefined();
    expect(readAgents(w.home)).toHaveLength(0);
  });

  test('is refused when herdr already names the pane as another agent', async () => {
    const w = world();
    const calls: string[] = [];
    const r = await register(w, ['lead', '--pane', 'w2:p2'], {
      agents: () => [{ ...agent('worker'), pane: 'w2:p2' }],
      foreground: () => ['claude'],
      ...named(calls),
    });

    // `--pane` adopts a pane herdr never named: one it already answers to as another agent is
    // that agent's, and adopting it would put a second name on a running pane.
    expect(r.code).toBe(1);
    expect(r.err).toContain('pane w2:p2 is named worker in session "acme"');
    expect(r.err).toContain('--pane names a pane herdr never named, nothing was registered');
    expect(calls).toEqual([]);
    expect(written(w)).toEqual(NOTHING);
  });

  test('records the pane anyway when herdr does not take the rename, and says so', async () => {
    const w = world();
    const r = await register(w, ['lead', '--pane', 'w2:p2'], {
      agents: () => [],
      foreground: () => ['claude'],
      renameAgent: () => false,
    });

    // The record is what this command exists to write: a rename herdr did not take is a note
    // and the outcome line's own words, never a refusal, and the next run names the pane again.
    expect(r.code).toBe(0);
    expect(r.out).toContain('lead: registered — pane w2:p2; herdr did not take the name, nothing was launched');
    expect(readState(w.dir).sessions.acme?.seats.lead?.pane).toBe('w2:p2');
    const record = findAgent(w.home, { team: teamId(w), seat: 'lead' });
    expect(record?.reach.pane).toBe('w2:p2');
  });
});
