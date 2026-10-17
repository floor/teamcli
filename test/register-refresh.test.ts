// `team register` on a seat a pane already holds ready: the second run is the repair. The
// registry record a launch writes is written again from the file as it now stands — the signing,
// the roster and the team's project pointers — while the session's own record and the pane are
// left exactly as they are. Fake herdr, a temporary home and a pinned caller: no live session is
// read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { findAgent, readAgents, updateAgent } from '../src/registry/agents.ts';
import { get as getProject, projectIdOf, readProjects } from '../src/registry/projects.ts';
import { getTeam, setRoster, teamIdOf, teamsFile } from '../src/registry/teams.ts';
import { readState, STATE_FILE } from '../src/state.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T09:00:00Z');
const OWNER = { kind: 'owner' as const };
const PANE = 'w1:p1';

const made: string[] = [];
// The address refresh reads herdr on its own; no pane of this machine's is behind it here, and
// an unreadable pane is the reading that leaves a record alone.
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

/** The team file, with `extra` lines where the sections order them: right after `project:`. */
function teamYaml(w: World, extra = ''): string {
  return `format: 1
project: acme
${extra}coordinator: lead
operator: lead
session: acme
trust:
  - ${lobbyDir(w.home)}
  - ${w.root}
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
`;
}

function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'reg-refresh-')));
  made.push(base);
  const home = join(base, 'h');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const w = { base, home, root, dir: join(root, '.agents') };
  writeFileSync(join(root, '.agents', 'team.yaml'), teamYaml(w));
  return w;
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

const teamId = (w: World): string => teamIdOf(w.root);
const recordOf = (w: World): ReturnType<typeof findAgent> => findAgent(w.home, { team: teamId(w), seat: 'lead' });

describe('registering a seat the pane already holds ready', () => {
  test('re-records the file\'s signing after the record drifted', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    const first = recordOf(w);
    expect(first).toBeDefined();
    // The drift `team check` names: the registry's signing no longer matches the file's seat.
    updateAgent(w.home, first!.id, {
      signing: { model: 'Claude Sonnet', version: '4.9', role: 'builder' },
      lab: 'someone-else',
      lifecycle: 'stopped',
    });

    const second = await register(w, ['lead']);

    expect(second.code).toBe(0);
    expect(second.out).toContain('lead: already registered — pane w1:p1; the record was refreshed from the file, nothing relaunched');
    const after = recordOf(w);
    expect(after?.id).toBe(first?.id);
    expect(after?.signing).toEqual({ model: 'Claude Opus', version: '5.5', role: 'coordinator' });
    expect(after?.lab).toBe('anthropic');
    expect(after?.lifecycle).toBe('running');
    expect(after?.reach.pane).toBe(PANE);
    expect(readAgents(w.home)).toHaveLength(1);
    // The session's own record is the launch's; the refresh does not rewrite it.
    expect(readState(w.dir).sessions.acme?.seats.lead?.stage).toBe('ready');
  });

  test('writes the project pointers a file gained after the launch', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    // No `in_project:` in the file yet: the team points at no project.
    expect(getTeam(w.home, teamId(w))?.projectId).toBeNull();
    expect(readProjects(w.home)).toEqual({});
    // The file gains the project level after the launch — the case operator-3's review named.
    writeFileSync(join(w.root, '.agents', 'team.yaml'), teamYaml(w, 'in_project: platform\nproject_lead: true\n'));

    const second = await register(w, ['lead']);

    expect(second.code).toBe(0);
    expect(second.out).toContain('the record was refreshed from the file');
    expect(getTeam(w.home, teamId(w))?.projectId).toBe(projectIdOf('platform'));
    const project = getProject(w.home, projectIdOf('platform'));
    expect(project?.name).toBe('platform');
    expect(project?.teams).toContain(teamId(w));
    // `project_lead: true`: the project's lead is the agent of the seat the file marks as its
    // lead, re-resolved from the file on the refresh run.
    expect(project?.lead).toBe(recordOf(w)?.id);
  });

  test('a seat held ready and missing from the roster gets its line', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    const held = recordOf(w);
    expect(held).toBeDefined();
    // The record lost the seat's line after the launch — a registry that never got it, the case
    // operator-3's P1 named — while the state still holds the seat ready on the pane.
    setRoster(w.home, teamId(w), []);
    expect(getTeam(w.home, teamId(w))?.roster).toEqual([]);
    const state = readFileSync(join(w.dir, STATE_FILE), 'utf8');

    const second = await register(w, ['lead']);

    expect(second.code).toBe(0);
    // The run names the gap the check names: the roster did not list the seat, and the line a
    // launch writes was written — the merged path's own words for the case.
    expect(second.out).toContain("the team registry's roster did not list it, and was written");
    // The line the launch's own write would have made: the same agent, the file's role, and the
    // lead's capability re-resolved to the file's lead seat.
    expect(getTeam(w.home, teamId(w))?.roster).toEqual([
      { agent: held!.id, seat: 'lead', role: 'coordinator', leads: true },
    ]);
    expect(readFileSync(teamsFile(w.home), 'utf8')).toContain(
      `- { agent: ${held!.id}, seat: lead, role: coordinator, leads: true }`,
    );
    expect(recordOf(w)?.id).toBe(held?.id);
    // Nothing relaunched: the session's own record stands as it was.
    expect(readFileSync(join(w.dir, STATE_FILE), 'utf8')).toBe(state);
  });

  test('--dry-run says what would be refreshed and writes nothing', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    const state = readFileSync(join(w.dir, STATE_FILE), 'utf8');
    const teams = readFileSync(teamsFile(w.home), 'utf8');
    const agents = readAgents(w.home);

    const dry = await register(w, ['lead', '--dry-run']);

    expect(dry.code).toBe(0);
    expect(dry.out).toContain('lead: already registered — pane w1:p1; the record would be refreshed from the file, nothing relaunched');
    expect(readFileSync(join(w.dir, STATE_FILE), 'utf8')).toBe(state);
    expect(readFileSync(teamsFile(w.home), 'utf8')).toBe(teams);
    expect(readAgents(w.home)).toEqual(agents);
  });
});
