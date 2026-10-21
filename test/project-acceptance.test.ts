// The Phase 0b acceptance scene: the project level, end to end, with fake hosts and a temporary
// home — the real commands, the real registries, no live session and no real CLI home.
//
// (1) two team files (teamcli, `in_project: TeamCLI` and `project_lead: true`; teamcli.io,
//     `in_project: TeamCLI`) register their seats through `team register` → the registry shows
//     project TeamCLI with both teams, each team record pointing at it by id, and the project's
//     lead is teamcli's own leads seat's agent id — read back after the sibling's registration,
//     which must not clear it;
// (2) teamcli's lead sends to teamcli.io's lead by name → admitted, the drop lands on the
//     receiver's pane and carries the rule; the same lead to a plain seat of teamcli.io → refused
//     while `seats_cross_teams` is off, and nothing is typed;
// (3) `team status --project TeamCLI` covers both teams, each with its session and seat count;
// (4) a team two projects name is a difference, naming both and the file to fix;
// (5) every existing fixture team file still loads unchanged: the same team, and the new project
//     fields neutral (`inProject` null, `projectLead` false) — while the schema fixtures that
//     were refused stay refused.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runStatus, standingSource, type StatusSources } from '../src/commands/status.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { readAgents } from '../src/registry/agents.ts';
import * as projectRegistry from '../src/registry/projects.ts';
import { readTeams, teamIdOf } from '../src/registry/teams.ts';
import type { NativePane } from '../src/send/native.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T01:00:00Z');
const OWNER = { kind: 'owner' as const };
const AGENT_ID = /^agt_[0-9a-f]{12}$/;
const BODY = 'the shared project work is starting';

/** One seat block: the lead carries the file's own `leads: true`, never a role word alone. */
function seatBlock(role: string, name: string, leads: boolean): string {
  return `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${leads ? '    leads: true\n' : ''}`;
}

type World = { base: string; home: string; rootA: string; rootB: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempBase(prefix: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(base);
  return base;
}

/** Where herdr's fake places each seat: a session, a workspace, a pane. */
const PANES: Record<string, { session: string; workspace: string; pane: string }> = {
  lead: { session: 'teamcli', workspace: 'w1', pane: 'w1:p1' },
  'lead-io': { session: 'teamcli-io', workspace: 'w2', pane: 'w2:p1' },
  'worker-io': { session: 'teamcli-io', workspace: 'w2', pane: 'w2:p2' },
};

/** The two team files, and a home: the shape `team register` and `team send` read. */
function world(): World {
  const base = tempBase('acc-');
  const home = join(base, 'h');
  mkdirSync(lobbyDir(home), { recursive: true });
  const rootA = join(base, 'teamcli');
  const rootB = join(base, 'teamcli.io');
  const file = (root: string, text: string): void => {
    mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, '.agents', 'team.yaml'), text);
  };
  file(rootA, `format: 1
project: teamcli
in_project: TeamCLI
project_lead: true
coordinator: lead
operator: lead
session: teamcli
trust:
  - ${lobbyDir(home)}
  - ${rootA}
workspace:
  mode: shared
seats:
${seatBlock('coordinator', 'lead', true)}# The send scenes here walk the typed trigger: the inbox is tried and skipped for want of a
# listener, then the line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`);
  file(rootB, `format: 1
project: teamcli.io
in_project: TeamCLI
coordinator: lead-io
operator: lead-io
session: teamcli-io
trust:
  - ${lobbyDir(home)}
  - ${rootB}
workspace:
  mode: shared
seats:
${seatBlock('coordinator', 'lead-io', true)}${seatBlock('implementer', 'worker-io', false)}# The send scenes here walk the typed trigger: the inbox is tried and skipped for want of a
# listener, then the line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`);
  return { base, home, rootA, rootB };
}

/** The agent herdr reports for a seat: a pane running a program in front of its own shell. */
function agent(name: string): HerdrAgent {
  const at = PANES[name] as { session: string; workspace: string; pane: string };
  return { name, agent: 'claude', pane: at.pane, workspace: at.workspace, status: 'idle', cwd: null, session: 'claude-session-1' };
}

/** The fake herdr `team register` reads: each session's seats on their own panes, every pane a
 *  live claude-code on an idle screen. */
function registerSources(home: string): RegisterSources {
  return {
    home,
    sessionState: () => 'running',
    agents: (session) => Object.keys(PANES).filter((name) => (PANES[name] as { session: string }).session === session).map((name) => agent(name)),
    processInfo: () => ({ shell: 400, foreground: [401] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    now: () => NOW,
  };
}

async function registered(world: World, root: string, seat: string): Promise<void> {
  const io = testIo(root, OWNER);
  const code = await runRegister([seat], io, registerSources(world.home));
  if (code !== 0) throw new Error(`team register ${seat} failed (${code}): ${io.out}${io.err}`);
}

// ---- the send scenes: the registered world, scripted panes ----

type Typed = { session: string; pane: string; text: string };

/** One pane's box: `samples` answers each status read, and every key is recorded. */
type Pane = { session: string; samples: string[]; typed: Typed[]; enters: number };

function paneOf(session: string, samples: string[]): Pane {
  return { session, samples, typed: [], enters: 0 };
}

/** The fake herdr of the send scenes: each seat's pane has its own scripted status. */
function sendHost(world: World, panes: Map<string, Pane>): SendHost {
  const bySession = new Map<string, { name: string; pane: string }[]>();
  for (const [name, at] of Object.entries(PANES)) {
    const list = bySession.get(at.session) ?? [];
    list.push({ name, pane: at.pane });
    bySession.set(at.session, list);
  }
  function paneAt(pane: string): Pane | undefined {
    for (const [name, place] of Object.entries(PANES)) {
      if (place.pane === pane) return panes.get(name);
    }
    return undefined;
  }
  const native: NativePane = {
    typeText: (session, pane, text) => {
      const one = paneAt(pane);
      if (!one) return false;
      one.typed.push({ session, pane, text });
      return true;
    },
    pressEnter: (_session, pane) => {
      const one = paneAt(pane);
      if (!one) return false;
      one.enters += 1;
      return true;
    },
    status: (_session, pane) => {
      const one = paneAt(pane);
      if (!one) return null;
      return one.samples[Math.min(one.enters, one.samples.length - 1)] ?? 'idle';
    },
    wait: async () => {},
  };
  return {
    agents: (session) => bySession.get(session) ?? null,
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: join(world.base, 'sockets'),
    deliver: async () => ({ ok: true }),
    native,
    now: () => NOW,
    home: world.home,
  };
}

function seatCaller(name: string): Caller {
  const at = PANES[name] as { session: string; pane: string };
  return { kind: 'seat', name, pane: at.pane, session: at.session };
}

/** The one drop in a seat's folder — the record the send wrote. The typed trigger is the seat's
 *  own receipt-writing read and names no path, so the folder is read, not the line. */
function dropOf(root: string, session: string, seat: string): { path: string; text: string } {
  const dir = join(root, '.agents', 'send-drops', session, seat);
  const names = readdirSync(dir).filter((one) => !one.includes('.'));
  for (const name of names) {
    const path = join(dir, name);
    const text = readFileSync(path, 'utf8');
    if (!text.includes('from the launch — admitted by:')) return { path, text };
  }
  throw new Error(`no send drop was written in ${dir}`);
}

// ---- (1) two team files register into one project ----

describe('two team files register into one project', () => {
  test('the project names both teams, their records point at it by id, and the lead is the file\'s leads seat', async () => {
    const w = world();
    await registered(w, w.rootA, 'lead');
    const idA = teamIdOf(w.rootA);
    const afterLead = projectRegistry.get(w.home, 'teamcli');
    expect(afterLead?.name).toBe('TeamCLI');
    expect(afterLead?.teams).toEqual([idA]);
    const leadAgent = readAgents(w.home).find((one) => one.reach.team === idA && one.reach.seat === 'lead');
    expect(leadAgent?.id).toMatch(AGENT_ID);
    expect(afterLead?.lead).toBe(leadAgent?.id);

    // The sibling registers: it joins the project and names the same project by id, without
    // touching the lead the first team's file declared.
    await registered(w, w.rootB, 'lead-io');
    await registered(w, w.rootB, 'worker-io');
    const idB = teamIdOf(w.rootB);
    const project = projectRegistry.get(w.home, 'teamcli');
    expect(project?.name).toBe('TeamCLI');
    expect(project?.teams).toEqual([idA, idB]);
    expect(project?.lead).toBe(leadAgent?.id);
    const teams = readTeams(w.home);
    expect(teams[idA]?.projectId).toBe(project?.id);
    expect(teams[idB]?.projectId).toBe(project?.id);
    expect(teams[idA]?.project).toBe('teamcli');
    expect(teams[idB]?.project).toBe('teamcli.io');
  });
});

// ---- (2) the two sends ----

describe('a project leads cross their teams', () => {
  test('teamcli\'s lead reaches teamcli.io\'s lead by name, and the drop names the rule', async () => {
    const w = world();
    await registered(w, w.rootA, 'lead');
    await registered(w, w.rootB, 'lead-io');
    await registered(w, w.rootB, 'worker-io');
    const leadPane = paneOf('teamcli', ['idle']);
    const ioLeadPane = paneOf('teamcli-io', ['idle', 'working']);
    const ioWorkerPane = paneOf('teamcli-io', ['idle']);
    const panes = new Map([['lead', leadPane], ['lead-io', ioLeadPane], ['worker-io', ioWorkerPane]]);
    const host = sendHost(w, panes);

    const code = await runSend(['lead-io@teamcli.io', BODY], testIo(w.rootA, seatCaller('lead')), host);

    expect(code).toBe(0);
    expect(ioLeadPane.typed.length).toBe(1);
    const drop = dropOf(w.rootB, 'teamcli-io', 'lead-io');
    const sender = readAgents(w.home).find((one) => one.reach.team === teamIdOf(w.rootA) && one.reach.seat === 'lead');
    expect(drop.text).toContain(sender?.id ?? 'no agent id');
    expect(drop.text).toContain(BODY);
    // The caller is the project's own lead, so the project's first rule is the one that fires:
    // the project lead writing to a lead of its teams. No role name decided it.
    expect(drop.text).toContain('the project lead and the leads of its teams');
  });

  test('the same lead to a plain seat of teamcli.io is refused while seats_cross_teams is off', async () => {
    const w = world();
    await registered(w, w.rootA, 'lead');
    await registered(w, w.rootB, 'lead-io');
    await registered(w, w.rootB, 'worker-io');
    const leadPane = paneOf('teamcli', ['idle']);
    const ioLeadPane = paneOf('teamcli-io', ['idle']);
    const ioWorkerPane = paneOf('teamcli-io', ['idle']);
    const panes = new Map([['lead', leadPane], ['lead-io', ioLeadPane], ['worker-io', ioWorkerPane]]);
    const host = sendHost(w, panes);
    const io = testIo(w.rootA, seatCaller('lead'));

    const code = await runSend(['worker-io@teamcli.io', BODY], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('may not send');
    expect(io.err).toContain('no rule admits it');
    // Nothing crossed: no pane of the other team was touched.
    expect(ioWorkerPane.typed).toEqual([]);
    expect(ioWorkerPane.enters).toBe(0);
    expect(ioLeadPane.typed).toEqual([]);
  });
});

// ---- (3) the project level in status ----

describe('team status --project TeamCLI', () => {
  test('covers both teams of the project, each with its session and seat count', async () => {
    const w = world();
    await registered(w, w.rootA, 'lead');
    await registered(w, w.rootB, 'lead-io');
    await registered(w, w.rootB, 'worker-io');
    const sources: StatusSources = {
      live: () => null,
      branch: () => 'main',
      standing: standingSource(w.home),
      now: () => NOW,
      home: w.home,
      projects: {
        list: () => projectRegistry.list(w.home),
        byName: (key) => projectRegistry.byName(w.home, key),
        ofTeam: (team) => projectRegistry.ofTeam(w.home, team),
      },
    };
    const io = testIo(w.rootA, OWNER);
    const code = await runStatus(['--project', 'TeamCLI', '--json'], io, sources);

    expect(code).toBe(0);
    const report = JSON.parse(io.out) as {
      project: { name: string; lead: string | null; teams: string[] };
      teams: { name: string; session: string | null; lifecycle: string | null; seats: number | null }[];
    };
    const idA = teamIdOf(w.rootA);
    const idB = teamIdOf(w.rootB);
    expect(report.project.name).toBe('TeamCLI');
    expect([...report.project.teams].sort()).toEqual([idA, idB].sort());
    const rows = new Map(report.teams.map((row) => [row.name, row]));
    expect(rows.get(idA)).toMatchObject({ session: 'teamcli', lifecycle: 'running', seats: 1 });
    expect(rows.get(idB)).toMatchObject({ session: 'teamcli-io', lifecycle: 'running', seats: 2 });
  });
});

// ---- (4) a team two projects name ----

describe('a team named in two projects', () => {
  test('is a difference in team check, naming both and the file to fix', async () => {
    const w = world();
    await registered(w, w.rootA, 'lead');
    const idA = teamIdOf(w.rootA);
    // The registry's own writer takes both: a file can be edited into this state, and the
    // refusal is the reader's — `ofTeam` here, and `team check` repeats it.
    projectRegistry.upsertProject(w.home, 'site', { name: 'Site', teams: [idA], at: NOW.toISOString() });
    const parsed = validateTeamFile(readFileSync(join(w.rootA, '.agents', 'team.yaml'), 'utf8'));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const quiet: Live = {
      running: true,
      agents: [{ name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
      workspaces: [{ id: 'w1', label: workspaceLabel(parsed.team.seats[0]!) }],
      screens: { 'w1:p1': CLAUDE_IDLE },
    };
    const io = testIo(w.rootA, OWNER);
    const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
      live: () => quiet,
      branch: () => 'main',
      standing: (at) => standingSource(w.home)(at),
      now: () => NOW,
      home: w.home,
    });
    const out = `${io.out}${io.err}`;
    expect(out).toContain(`difference: the project registry: team ${idA} is named in 2 projects: site, teamcli`);
    expect(out).toContain('  repair: fix the project registry (~/.config/team/projects.yaml)');
    expect(code).toBe(1);
  });
});

// ---- (5) the existing fixture files ----

describe('every existing fixture team file still loads unchanged', () => {
  test('the team fixtures load with their own content, and the project fields read neutral', () => {
    const example = validateTeamFile(readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8'));
    if (!example.ok) throw new Error(JSON.stringify(example.errors));
    expect(example.team.project).toBe('acme-web');
    expect(example.team.inProject).toBeNull();
    expect(example.team.projectLead).toBe(false);

    const models = validateTeamFile(readFileSync(new URL('./fixtures/doctor-models.yaml', import.meta.url), 'utf8'));
    if (!models.ok) throw new Error(JSON.stringify(models.errors));
    expect(models.team.project).toBe('pilot');
    expect(models.team.inProject).toBeNull();
    expect(models.team.projectLead).toBe(false);
  });

  test('the schema fixtures that were refused stay refused', () => {
    for (const name of ['missing-project.yaml', 'unknown-field.yaml', 'wrong-type.yaml']) {
      const parsed = validateTeamFile(readFileSync(new URL(`./fixtures/schema/${name}`, import.meta.url), 'utf8'));
      expect(parsed.ok).toBe(false);
    }
  });
});
