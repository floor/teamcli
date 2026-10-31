// `team register` on a seat a pane already holds ready: the second run is the repair. The
// registry record a launch writes is written again from the file as it now stands — the signing,
// the roster and the team's project pointers — while the session's own record and the pane are
// left exactly as they are, save for the seat id and process identity a launch that predates
// them left short: those are completed where the seat stands, which is the repair the doctor's
// "launched before team recorded its process" note names. Fake herdr, a temporary home and a
// pinned caller: no live session is read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import type { Caller } from '../src/caller.ts';
import { setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { findAgent, readAgents, registerAgent, updateAgent } from '../src/registry/agents.ts';
import { recordedSeatSession } from '../src/registry/resume.ts';
import { get as getProject, projectIdOf, readProjects } from '../src/registry/projects.ts';
import { getTeam, setRoster, teamIdOf, teamsFile } from '../src/registry/teams.ts';
import { emptySession, LOG_FILE, readState, SEAT_ID_PATTERN, STATE_FILE, updateState } from '../src/state.ts';
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

async function register(
  w: World,
  argv: string[],
  over: Partial<RegisterSources> = {},
  caller: Caller = OWNER,
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(w.root, caller);
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

  // The record the refresh writes is the live seat's, not just the file's fields: a stable handle
  // a launch that predates the state's id left names another incarnation, and the refresh binds
  // the agent to the seat standing on the pane, so the native route binds it again. A write that
  // does not stand on the live seat never rewrites a handle (`registry-writers.test.ts`).
  test('rebinds a record left with another incarnation\'s handle to the live seat', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    const held = recordOf(w);
    const seat = readState(w.dir).sessions.acme?.seats.lead;
    expect(held).toBeDefined();
    expect(seat?.id).toMatch(SEAT_ID_PATTERN);
    // The handle an earlier launch wrote, while the live state names its own id: the read every
    // native route makes refuses the record as another agent's.
    updateAgent(w.home, held!.id, { seat_handle: 'seat_fedcba987654' });
    const refused = recordedSeatSession({
      home: w.home,
      root: w.root,
      herdrSession: 'acme',
      seat: { name: 'lead', cli: 'claude-code' },
      state: seat,
    });
    expect(refused).toEqual({ kind: 'refused', why: 'the record is another agent for this seat' });

    const second = await register(w, ['lead']);

    expect(second.code).toBe(0);
    expect(second.out).toContain('the record was refreshed from the file, nothing relaunched');
    expect(recordOf(w)?.id).toBe(held?.id);
    expect(recordOf(w)?.seat_handle).toBe(seat?.id);
    expect(recordedSeatSession({
      home: w.home,
      root: w.root,
      herdrSession: 'acme',
      seat: { name: 'lead', cli: 'claude-code' },
      state: readState(w.dir).sessions.acme?.seats.lead,
    }).kind).toBe('bound');
  });

  // Ready on the same pane is not proof that the process in front is the one this record's launch
  // started. The refresh writes the file's fields and, with them, the handle the native route
  // binds: it may rewrite the handle only under proven continuity, and it never hands the seat an
  // id another seat already holds.
  test('refuses to refresh a record whose pane holds a process its launch did not start', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    const held = recordOf(w);
    const seat = readState(w.dir).sessions.acme?.seats.lead;
    expect(held).toBeDefined();
    expect(seat?.launched).toEqual({ shell: 400, cli: [401] });
    // A signing the refresh would rewrite: its survival is the proof nothing was written.
    updateAgent(w.home, held!.id, { signing: { model: 'Claude Sonnet', version: '4.9', role: 'coordinator' } });

    // The pane's front process is another program: the shell that launched this seat is gone.
    const run = await register(w, ['lead'], { processInfo: () => ({ shell: 900, foreground: [901] }) });

    expect(run.code).toBe(1);
    expect(run.out).toBe('');
    expect(run.err).toContain(`team register: lead: pane ${PANE} holds a process other than the one its record's launch started; the record was not refreshed\n`);
    expect(recordOf(w)?.signing).toEqual({ model: 'Claude Sonnet', version: '4.9', role: 'coordinator' });
  });

  // Only a live record holds a seat: a retired one holds nothing, so the handle it kept is free
  // to name the seat standing on the pane.
  test('a retired record left holding the id does not block the refresh', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    const seat = readState(w.dir).sessions.acme?.seats.lead;
    const helper = registerAgent(w.home, {
      name: 'helper',
      signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
      lab: 'anthropic',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: teamId(w), seat: 'helper', session: 'acme', pane: 'pane-helper', address: null },
      seat_handle: seat!.id,
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'synthetic',
    });
    updateAgent(w.home, helper.id, { lifecycle: 'retired' });

    const run = await register(w, ['lead']);

    expect(run.code).toBe(0);
    expect(run.out).toContain('the record was refreshed from the file, nothing relaunched');
    expect(recordOf(w)?.seat_handle).toBe(seat?.id);
  });

  test('refuses to refresh when another seat\'s agent record holds the id its record carries', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    const held = recordOf(w);
    const seat = readState(w.dir).sessions.acme?.seats.lead;
    updateAgent(w.home, held!.id, { signing: { model: 'Claude Sonnet', version: '4.9', role: 'coordinator' } });
    // The holder is another seat's agent record, not the session's own copy of the state.
    registerAgent(w.home, {
      name: 'helper',
      signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
      lab: 'anthropic',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: teamId(w), seat: 'helper', session: 'acme', pane: 'pane-helper', address: null, agent_session: 'helper-session' },
      seat_handle: seat!.id,
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'synthetic',
    });

    const run = await register(w, ['lead']);

    expect(run.code).toBe(1);
    expect(run.err).toContain(`team register: lead: the id its record holds (${seat?.id}) is helper's handle; the record was not refreshed\n`);
    expect(recordOf(w)?.signing).toEqual({ model: 'Claude Sonnet', version: '4.9', role: 'coordinator' });
    expect(findAgent(w.home, { team: teamId(w), seat: 'helper' })?.seat_handle).toBe(seat?.id);
  });

  // The refresh stands the seat on the id it read, and the native route binds the agent on it. A
  // registry that cannot be written leaves the seat reachable only by pull: the run says so
  // instead of reporting the refresh as done.
  test('says pull-only when the refresh cannot bind the native record', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    const healthy = await register(w, ['lead']);
    expect(healthy.code).toBe(0);
    expect(healthy.out).toContain(`lead: already registered — pane ${PANE}; the record was refreshed from the file, nothing relaunched\n`);
    expect(healthy.out).not.toContain('pull-only');

    // The registry folder becomes a file this run cannot write through.
    const agents = join(w.home, '.config', 'team', 'agents');
    renameSync(agents, `${agents}-saved`);
    writeFileSync(agents, 'synthetic blocked registry');

    const run = await register(w, ['lead']);
    expect(run.code).toBe(0);
    expect(run.err).toBe('');
    expect(run.out).toContain(`lead: already registered — pane ${PANE}; nothing was written; pull-only: no agent record for this seat\n`);

    const io = testIo(w.root, OWNER);
    expect(await runRegister(['lead', '--json'], io, sources(w))).toBe(0);
    const doc = JSON.parse(io.out) as { status: string; pull_only?: string | null };
    expect(doc.status).toBe('already');
    expect(doc.pull_only).toBe('no agent record for this seat');
  });

  test('writes the project pointers a file gained after the launch', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    // No `in_project:` in the file yet: the team points at no project.
    expect(getTeam(w.home, teamId(w))?.projectId).toBeNull();
    expect(readProjects(w.home)).toEqual({});
    // The file gains the project level after the launch — the case a review named.
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
    // a review's P1 named — while the state still holds the seat ready on the pane.
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

  test('a delegated run on the already path writes the delegate line', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    // The gate `up` runs is the one register runs; the file gains the section it reads, and the
    // gate itself is stood in as passed for the calling seat.
    writeFileSync(join(w.root, '.agents', 'team.yaml'), `${teamYaml(w)}delegates:\n  - pane: main/w2:p2\n    commands: [up]\n`);
    const worker: Caller = { kind: 'seat', name: 'worker', pane: 'w2:p2', session: 'acme' };

    const second = await register(
      w,
      ['lead'],
      { delegateGate: () => ({ kind: 'passed', pane: 'main/w2:p2' }) },
      worker,
    );

    expect(second.code).toBe(0);
    expect(second.out).toContain('lead: already registered — pane w1:p1');
    // The audit line the launch path writes for the same act, and the already path used to
    // skip: a delegated record write is named as delegated whichever path writes it.
    expect(readFileSync(join(w.dir, LOG_FILE), 'utf8')).toContain('delegate [delegate] main/w2:p2 up: register');
  });

  test('a granted run on the already path writes the grant line', async () => {
    const w = world();
    expect((await register(w, ['lead'])).code).toBe(0);
    // The file's grant names the lead seat for `up`: register's second fallback, stood in as
    // passed for the calling seat.
    writeFileSync(
      join(w.root, '.agents', 'team.yaml'),
      `${teamYaml(w)}grant:\n  session: acme\n  seat: lead\n  scope:\n    - up\n`,
    );
    const worker: Caller = { kind: 'seat', name: 'worker', pane: 'w2:p2', session: 'acme' };

    const second = await register(
      w,
      ['lead'],
      { grantGate: () => ({ kind: 'passed', grant: { session: 'acme', seat: 'lead', scope: ['up'] } }) },
      worker,
    );

    expect(second.code).toBe(0);
    expect(second.out).toContain('lead: already registered — pane w1:p1');
    expect(readFileSync(join(w.dir, LOG_FILE), 'utf8')).toContain('grant [grant] lead up: register');
  });
});

// A record from a launch that predates the seat id and the process identity: the state's seat is
// ready on the pane, with neither `id` nor `launched`. `team register <seat>` completes both from
// the same reads a launch makes, and leaves the registry agent's `seat_handle` on the id — the
// whole of the repair `team doctor`'s "launched before team recorded its process" note names.
describe('completing a record a launch that predates the seat id left short', () => {
  test("records the id and the pane's process identity where the seat stands", async () => {
    const w = world();
    updateState(w.dir, (state) => {
      state.sessions.acme = {
        ...emptySession(),
        seats: { lead: { stage: 'ready', pane: PANE, workspace: 'ws-1' } },
      };
    });

    const run = await register(w, ['lead']);

    expect(run.code).toBe(0);
    // The registry held no record of this team either — the launch that predates the id predates
    // it — so the run writes the roster line and says so.
    expect(run.out).toContain('lead: already registered — pane w1:p1; the team registry\'s roster did not list it, and was written');
    const seat = readState(w.dir).sessions.acme?.seats.lead;
    expect(seat?.id).toMatch(SEAT_ID_PATTERN);
    expect(seat?.launched).toEqual({ shell: 400, cli: [401] });
    // The registry's own handle is the id: the record `team seats` and the sync read.
    expect(recordOf(w)?.seat_handle).toBe(seat?.id);
    expect(readFileSync(join(w.dir, LOG_FILE), 'utf8')).toContain(`lead: refreshed ${seat?.id} — pane ${PANE}`);
  });

  test('keeps the id a record already holds, and writes only the missing identity', async () => {
    const w = world();
    updateState(w.dir, (state) => {
      state.sessions.acme = {
        ...emptySession(),
        seats: { lead: { id: 'seat_aaaaaaaaaaaa', stage: 'ready', pane: PANE, workspace: 'ws-1' } },
      };
    });

    const run = await register(w, ['lead']);

    expect(run.code).toBe(0);
    const seat = readState(w.dir).sessions.acme?.seats.lead;
    expect(seat?.id).toBe('seat_aaaaaaaaaaaa');
    expect(seat?.launched).toEqual({ shell: 400, cli: [401] });
    expect(recordOf(w)?.seat_handle).toBe('seat_aaaaaaaaaaaa');
  });

  test('adopts the id a stopped session retained, and retires the retained line', async () => {
    const w = world();
    updateState(w.dir, (state) => {
      state.sessions.acme = {
        ...emptySession(),
        seats: { lead: { stage: 'ready', pane: PANE, workspace: 'ws-1' } },
        retained_seats: { lead: { id: 'seat_bbbbbbbbbbbb' } },
      };
    });

    const run = await register(w, ['lead']);

    expect(run.code).toBe(0);
    const session = readState(w.dir).sessions.acme;
    expect(session?.seats.lead?.id).toBe('seat_bbbbbbbbbbbb');
    expect(session?.retained_seats?.lead).toBeUndefined();
    expect(recordOf(w)?.seat_handle).toBe('seat_bbbbbbbbbbbb');
  });

  test('a second run leaves the completed record as it is', async () => {
    const w = world();
    updateState(w.dir, (state) => {
      state.sessions.acme = {
        ...emptySession(),
        seats: { lead: { stage: 'ready', pane: PANE, workspace: 'ws-1' } },
      };
    });
    expect((await register(w, ['lead'])).code).toBe(0);
    const state = readFileSync(join(w.dir, STATE_FILE), 'utf8');

    const again = await register(w, ['lead']);

    expect(again.code).toBe(0);
    expect(readFileSync(join(w.dir, STATE_FILE), 'utf8')).toBe(state);
  });

  test('--dry-run leaves a record short of its id and identity untouched', async () => {
    const w = world();
    updateState(w.dir, (state) => {
      state.sessions.acme = {
        ...emptySession(),
        seats: { lead: { stage: 'ready', pane: PANE, workspace: 'ws-1' } },
      };
    });
    const state = readFileSync(join(w.dir, STATE_FILE), 'utf8');

    const dry = await register(w, ['lead', '--dry-run']);

    expect(dry.code).toBe(0);
    expect(dry.out).toContain('lead: already registered — pane w1:p1; the team registry\'s roster would be written');
    expect(readFileSync(join(w.dir, STATE_FILE), 'utf8')).toBe(state);
    // Nothing was written to the registry either.
    expect(recordOf(w)).toBeNull();
  });
});
