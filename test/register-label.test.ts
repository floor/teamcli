// Phase 0b, the refusal edges of `team register`'s label refresh: an adoption re-applies the
// seat's herdr label and display agent from the file, with no relaunch — so a run that does not
// adopt the seat, and one that only shows what it would do, must reach herdr not at all.
//
// (a) a run that refuses the adoption applies no herdr write and writes no record;
// (b) `--dry-run` applies nothing.
//
// The refresh scenes themselves — the file's own label and display on a live seat, exactly the
// two writes, and a herdr that refuses them — land with the refresh itself.
// Fake herdr throughout, a temporary home and a pinned caller: no live session is read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { readAgents } from '../src/registry/agents.ts';
import { LOG_FILE, readState, STATE_FILE } from '../src/state.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T00:30:00Z');
const OWNER = { kind: 'owner' as const };
const PANE = 'w1:p1';
const WORKSPACE = 'ws-1';

const made: string[] = [];
// The refresh paths read herdr on their own; an address refresh that reads herdr on its own must
// read nothing here, and an unreadable pane is the reading that leaves a record alone.
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

/** A temporary home and one root with `.agents/team.yaml` — the shape `team register` reads.
 *  `label: null` writes no label line, the seat whose title is its name and role. */
function world(opts: { cli?: string; label?: string | null; display?: string } = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'reg-label-')));
  made.push(base);
  const home = join(base, 'h');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const labelLine = opts.label === null ? '' : `    label: ${opts.label ?? 'lead'}\n`;
  const displayLine = opts.display === undefined ? '' : `    display: ${opts.display}\n`;
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
${labelLine}    cli: ${opts.cli ?? 'claude-code'}
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
${displayLine}    launch: claude --model claude-opus-5-5
`);
  return { base, home, root, dir: join(root, '.agents') };
}

/** The agent herdr reports for the seat: a pane running a program in front of its own shell. */
function agent(name: string): HerdrAgent {
  return { name, agent: 'claude', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: null, session: 'claude-session-1' };
}

/** Every herdr read `register` makes, faked: the scene hands in what each read returns. */
function sources(w: World, over: Partial<RegisterSources> = {}): RegisterSources {
  const base: RegisterSources = {
    home: w.home,
    sessionState: () => 'running',
    agents: () => [agent('lead')],
    processInfo: () => ({ shell: 400, foreground: [401] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    now: () => NOW,
  };
  return { ...base, ...over };
}

async function register(
  w: World,
  argv: string[],
  over: Partial<RegisterSources> = {},
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(w.root, OWNER);
  const code = await runRegister(argv, io, sources(w, over));
  return { code, out: io.out, err: io.err };
}

/** What the run left on disk: the state file and the agent records. */
function written(w: World): { state: boolean; agents: number; log: boolean } {
  return {
    state: existsSync(join(w.dir, STATE_FILE)),
    agents: readAgents(w.home).length,
    log: existsSync(join(w.dir, LOG_FILE)),
  };
}

describe("register's refresh writes nothing", () => {
  test('a refused adoption applies no herdr write and leaves no record', async () => {
    const w = world({ cli: 'codex' });
    const r = await register(w, ['lead']);

    expect(r.code).not.toBe(0);
    expect(written(w)).toEqual({ state: false, agents: 0, log: false });
  });

  test('--dry-run applies nothing', async () => {
    const w = world();
    const r = await register(w, ['lead', '--dry-run']);

    expect(r.code).toBe(0);
    expect(written(w)).toEqual({ state: false, agents: 0, log: false });
  });
});
