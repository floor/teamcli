// Phase 0b: `team register` re-applies the seat's herdr label and its display agent from the
// file — line 1, the workspace title `workspaceLabel` names, and line 2, the `displayAgent` text
// `up` and `add` report — with no relaunch. An adoption never touches what it adopted, so these
// two writes are the whole of what it may change in herdr, and a herdr that refuses one is one
// line that leaves the seat's record standing.
//
// (a) a live seat's workspace title and display_agent are set to the file's own values, and
//     exactly those two writes reach herdr;
// (b) the values are the file's: a written display and a seat with no written label both come
//     out as `workspaceLabel` and `displayAgent` render them;
// (c) a run that refuses the adoption writes neither;
// (d) the writes failing is one line, not a lost record: exit 0, the state stands;
// (e) a seat already registered at its pane writes no record and has both lines re-applied all
//     the same — the repair `team check` names;
// (f) `--dry-run` applies nothing.
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
// The refresh paths are injected below; an address refresh that reads herdr on its own must
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

/** Every herdr read `register` makes, faked, plus the two sidebar writes `up` and `add` make
 *  (`RegisterSources`' own channels): a scene hands in its own to see what was applied, or
 *  `false` to see a herdr that refuses the write. They are the run's only channels to reach a
 *  pane, so what a scene records here is the whole of what the run changed in herdr — and
 *  nothing that launches. */
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

/** Records each applied write as one line and accepts it. */
function refresh(applied: string[]): Partial<RegisterSources> {
  return {
    renameWorkspace: (session, workspace, label) => {
      applied.push(`rename ${session} ${workspace} ${label}`);
      return true;
    },
    reportDisplayAgent: (session, pane, text) => {
      applied.push(`display ${session} ${pane} ${text}`);
      return true;
    },
  };
}

describe("register's label refresh", () => {
  test('sets the file\'s workspace label and display agent, and nothing else reaches herdr', async () => {
    const w = world();
    const applied: string[] = [];
    const r = await register(w, ['lead'], refresh(applied));

    expect(r.code).toBe(0);
    expect(r.out).toContain('lead: registered — pane w1:p1');
    // The file's own rendering: the written label is the title, and the display is the model and
    // version, a space, then `default` for the effort the file does not set.
    expect(applied).toContain(`rename acme ${WORKSPACE} lead`);
    expect(applied).toContain(`display acme ${PANE} Claude Opus 5.5 default`);
    // The two writes are the whole of it: an adoption changes nothing else in herdr.
    expect(applied).toHaveLength(2);
  });

  test('a written display comes out as displayAgent renders it, the version and the effort or default', async () => {
    const w = world({ display: 'Acme Lead Opus 5.5' });
    const applied: string[] = [];
    const r = await register(w, ['lead'], refresh(applied));

    expect(r.code).toBe(0);
    expect(applied).toContain(`rename acme ${WORKSPACE} lead`);
    expect(applied).toContain(`display acme ${PANE} Acme Lead Opus 5.5 default`);
  });

  test('a seat with no written label is titled by its name and role', async () => {
    const w = world({ label: null });
    const applied: string[] = [];
    const r = await register(w, ['lead'], refresh(applied));

    expect(r.code).toBe(0);
    expect(applied).toContain(`rename acme ${WORKSPACE} lead · coordinator`);
  });

  test('a refused adoption applies neither write', async () => {
    const w = world({ cli: 'codex' });
    const applied: string[] = [];
    const r = await register(w, ['lead'], refresh(applied));

    expect(r.code).not.toBe(0);
    expect(applied).toHaveLength(0);
    expect(written(w)).toEqual({ state: false, agents: 0, log: false });
  });

  test('a herdr that refuses the writes is one line, and the record stands', async () => {
    const w = world();
    const r = await register(w, ['lead'], {
      renameWorkspace: () => false,
      reportDisplayAgent: () => false,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain('lead: registered — pane w1:p1');
    // The relabel contract `up` and `add` keep: a refused write is one line for that seat, and
    // the seat is not left out of the run.
    const said = `${r.out}${r.err}`;
    expect(said).toContain('lead: its title was not reported');
    expect(said).toContain('lead: its display was not reported');

    const held = readState(w.dir).sessions.acme?.seats.lead;
    expect(held?.stage).toBe('ready');
    expect(held?.pane).toBe(PANE);
    expect(readAgents(w.home)).toHaveLength(1);
  });

  test('an already-registered seat writes no record and re-applies both lines', async () => {
    const w = world();
    const first = await register(w, ['lead'], { renameWorkspace: () => true, reportDisplayAgent: () => true });
    expect(first.code).toBe(0);

    const applied: string[] = [];
    const again = await register(w, ['lead'], refresh(applied));

    expect(again.code).toBe(0);
    expect(again.out).toContain('lead: already registered — pane w1:p1');
    // The repair `team check` names: the record is left alone, and a label or display that
    // drifted is put back from the file where the seat stands.
    expect(applied).toContain(`rename acme ${WORKSPACE} lead`);
    expect(applied).toContain(`display acme ${PANE} Claude Opus 5.5 default`);
    expect(applied).toHaveLength(2);
  });

  test('--dry-run applies nothing', async () => {
    const w = world();
    const applied: string[] = [];
    const r = await register(w, ['lead', '--dry-run'], refresh(applied));

    expect(r.code).toBe(0);
    expect(applied).toHaveLength(0);
    expect(written(w)).toEqual({ state: false, agents: 0, log: false });
  });
});
