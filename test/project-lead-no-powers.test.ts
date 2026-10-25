// A project lead has no power over its project's other teams — only comms admission.
//
// A team's file may declare its lead the project's lead: `in_project` names the project the team
// sits in, and `project_lead: true` marks it the one that leads there. The project registry then
// names that seat's own agent — the record its launch wrote — as the project's `lead`. That
// standing buys no team-management power through the project: over another team of the same
// project, the lead of one team is judged exactly as any other seat, and `team up`, `team down`,
// `team add`, `team remove` and `team grant` each refuse it in their own words, writing nothing.
//
// The one thing the standing holds is admission — the project lead writes to its project's team
// leads, by the project rules, and to nothing else of them — and it holds only where the records
// say so: the same pair, judged over the registry alone, with no pane and no file in it.

import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runRemove } from '../src/commands/remove.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { Terminal } from '../src/launch/terminal.ts';
import { registerAgent, type Agent } from '../src/registry/agents.ts';
import { readProjects, upsertProject } from '../src/registry/projects.ts';
import { readTeams, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { admitSend, PROJECT_RULES, type AdmitContext } from '../src/send/admit.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Machine } from '../src/watch/machine.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T09:00:00Z');
const ENTITY = 'floor';
const AMPLE: Machine = {
  loadPerCore: 0.2, memoryFree: 80, diskFree: 200e9, swapTotal: 10e9, swapFree: 9e9, swapUsed: 1e9,
};

const SEAT = (role: string, name: string, extra = '') => `  - role: ${role}
    name: ${name}
${extra}    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

/** The project-lead team's file: `in_project` names the project, `project_lead` the claim, and
 *  its lead seat carries the capability the record projects onto its roster line. */
const LEAD_TEAM = `format: 1
project: acacia
session: acacia
entity: floor
in_project: oak
project_lead: true
coordinator: lead-a
operator: lead-a
workspace:
  mode: shared
seats:
${SEAT('coordinator', 'lead-a', '    leads: true\n')}${SEAT('builder', 'builder-a')}grant:
  session: acacia
  seat: lead-a
  scope:
    - up
`;

/** The other team of the same project: no claim, and its own lead. */
const PLAIN_TEAM = `format: 1
project: birch
session: birch
entity: floor
in_project: oak
coordinator: lead-b
operator: lead-b
workspace:
  mode: shared
seats:
${SEAT('coordinator', 'lead-b', '    leads: true\n')}${SEAT('builder', 'builder-b')}`;

/** The project lead: the lead seat of the team whose file says `project_lead`. */
const leadA = { kind: 'seat', name: 'lead-a', pane: 'w1:p1', session: 'acacia' } as const;
const owner = { kind: 'owner' } as const;

type Root = { root: string; file: string };
type World = { base: string; home: string; a: Root; b: Root };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One temp home and two team roots: `acacia`, the lead's team, and `birch`, another team of the
 *  same project. The registry is the home's, not either root's. */
function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-project-lead-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const mk = (name: string): Root => {
    const root = join(base, name);
    mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'owner@example.com'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Owner'], { cwd: root, stdio: 'ignore' });
    return { root, file: join(root, '.agents', 'team.yaml') };
  };
  return { base, home, a: mk('acacia'), b: mk('birch') };
}

function write(here: Root, text: string): void {
  writeFileSync(here.file, text);
}

/** Absolute trust, so a missing record is not also the legacy-trust refusal. A file whose
 *  `entity` is set lands in `lobbies/<entity>`: the landing is listed the way the real machine's
 *  own file lists its own, beside the global lobby and the root. */
function trusted(text: string, root: string, home: string): string {
  const global = join(home, '.config', 'team', 'lobby');
  const lobby = join(home, '.config', 'team', 'lobbies', ENTITY);
  return text.replace('workspace:\n', `trust:\n  - ${global}\n  - ${lobby}\n  - ${root}\nworkspace:\n`);
}

/** The lead seat's own record in the team's state, the way its launch wrote it: the caller is
 *  genuinely placed — the refusals below are about the project, not about an unknown caller. */
function recordLeadA(root: string): void {
  updateState(join(root, '.agents'), (state) => {
    (state.sessions.acacia ??= emptySession()).seats['lead-a'] = { stage: 'launched', pane: 'w1:p1' };
  });
}

/** The registry records, upserted the way a launch writes them: `lead-a`'s own record is the
 *  project's `lead`, by the project record — the standing each scene below stands on. */
function register(world: World): { leadA: Agent; leadB: Agent; builderB: Agent; teamA: string; teamB: string } {
  const teamA = teamIdOf(world.a.root);
  const teamB = teamIdOf(world.b.root);
  const seat = (team: string, name: string, session: string, role: string): Agent =>
    registerAgent(world.home, {
      name,
      signing: { model: 'Claude Opus', version: '5.5', role },
      lab: 'anthropic',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude --model claude-opus-5-5',
      reach: { team, seat: name, session, pane: 'w1:p1', address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'owner',
    });
  const leadARecord = seat(teamA, 'lead-a', 'acacia', 'coordinator');
  const leadBRecord = seat(teamB, 'lead-b', 'birch', 'coordinator');
  const builderBRecord = seat(teamB, 'builder-b', 'birch', 'builder');
  upsertTeam(world.home, teamA, {
    project: 'acacia',
    projectId: 'oak',
    entity: 'floor',
    session: 'acacia',
    root: world.a.root,
    roster: [{ agent: leadARecord.id, seat: 'lead-a', role: 'coordinator', leads: true }],
  });
  upsertTeam(world.home, teamB, {
    project: 'birch',
    projectId: 'oak',
    entity: 'floor',
    session: 'birch',
    root: world.b.root,
    roster: [
      { agent: leadBRecord.id, seat: 'lead-b', role: 'coordinator', leads: true },
      { agent: builderBRecord.id, seat: 'builder-b', role: 'builder' },
    ],
  });
  upsertProject(world.home, 'oak', {
    name: 'oak',
    entity: 'floor',
    lead: leadARecord.id,
    teams: [teamA, teamB],
    by: 'owner',
  });
  return { leadA: leadARecord, leadB: leadBRecord, builderB: builderBRecord, teamA, teamB };
}

function launching(onLaunch: () => void): Launch & { closed: number } {
  let n = 0;
  let session: 'absent' | 'running' = 'absent';
  const panes = new Map<string, { text: string; agent: boolean }>();
  const host = {
    closed: 0,
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace() {
      n += 1;
      const pane = `w${n}:p1`;
      panes.set(pane, { text: '', agent: false });
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session: string, pane: string) {
      onLaunch();
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    spawnWatch: () => 4242,
    renameAgent: () => true,
    closeWorkspace() {
      host.closed += 1;
      return true;
    },
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    paneText: () => '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  return host;
}

function terminal(): Terminal {
  return {
    async key() {
      throw new Error('the pause read the terminal');
    },
    drain() {},
  };
}

function upSources(home: string): UpSources {
  return {
    sessionRunning: () => false,
    agents: () => [],
    home,
    now: () => NOW,
    machine: () => AMPLE,
    terminal: () => terminal(),
    launch: launching(() => {}),
  };
}

/** A session with no agent in it: every command below reaches its own caller gate, and none of
 *  them has a seat to stop. */
function idleSources(home: string): DownSources {
  return {
    home,
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    now: () => NOW,
  };
}

function addSources(home: string): AddSources {
  return {
    home,
    sessionState: () => 'absent',
    agents: () => [],
    workspaces: () => [],
    now: () => NOW,
    doctor: {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => false,
      now: () => NOW,
      home,
    },
    launch: launching(() => {}),
  };
}

describe("a project lead over another team of its project", () => {
  test('`team up` at the other team: denied, and the file untouched', async () => {
    const here = world();
    write(here.b, trusted(PLAIN_TEAM, here.b.root, here.home));
    const before = readFileSync(here.b.file, 'utf8');
    const io = testIo(here.b.root, leadA);
    const code = await runUp([], io, upSources(here.home));
    expect(code).toBe(1);
    expect(io.err).toBe('deny\n');
    expect(io.out).toBe('');
    expect(readFileSync(here.b.file, 'utf8')).toBe(before);
  });

  test('the same folder and command as the owner: the plan goes through', async () => {
    // The fixture is not the refusal: with the very same file, the owner's dry run plans.
    const here = world();
    write(here.b, trusted(PLAIN_TEAM, here.b.root, here.home));
    const io = testIo(here.b.root, owner);
    const code = await runUp(['--dry-run'], io, upSources(here.home));
    expect(io.err, io.out).toBe('');
    expect(code).toBe(0);
    expect(io.out).toContain('lead-b');
    expect(io.out).not.toContain('deny');
  });

  test('`team down` at the other team: refused, in the placement words', async () => {
    const here = world();
    write(here.b, trusted(PLAIN_TEAM, here.b.root, here.home));
    const io = testIo(here.b.root, leadA);
    const code = await runDown([], io, idleSources(here.home));
    expect(code).toBe(1);
    expect(io.err).toBe('team down: only the owner or `leads` stops the team; this call is lead-a\n');
    expect(io.out).toBe('');
  });

  test('`team add` at the other team: refused, in the placement words', async () => {
    const here = world();
    write(here.b, trusted(PLAIN_TEAM, here.b.root, here.home));
    const io = testIo(here.b.root, leadA);
    const code = await runAdd(['builder-b'], io, addSources(here.home));
    expect(code).toBe(1);
    expect(io.err).toBe('team add: only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is lead-a\n');
  });

  test('`team remove` at the other team: refused, in the placement words', async () => {
    const here = world();
    write(here.b, trusted(PLAIN_TEAM, here.b.root, here.home));
    const io = testIo(here.b.root, leadA);
    const code = await runRemove(['builder-b'], io, idleSources(here.home));
    expect(code).toBe(1);
    expect(io.err).toBe('team remove: only the owner or `leads` removes a seat; this call is lead-a\n');
  });

  test('`team grant` at the other team: the owner-only refusal, standing and all', async () => {
    const here = world();
    write(here.b, trusted(PLAIN_TEAM, here.b.root, here.home));
    const io = testIo(here.b.root, leadA);
    const code = await runGrant(['lead-b', '--scope', 'up'], io, { home: here.home });
    expect(code).toBe(1);
    expect(io.err).toBe('team grant: only the owner runs this, from a terminal outside herdr; this call is lead-a\n');
  });
});

describe('the same seat over its own team', () => {
  test('`team up` where it leads: the plan goes through', async () => {
    // The caller is genuinely placed: at its own team the same seat, the same way, passes the
    // gate — the refusals above are the project's doing, not an unknown caller's.
    const here = world();
    write(here.a, trusted(LEAD_TEAM, here.a.root, here.home));
    recordLeadA(here.a.root);
    const io = testIo(here.a.root, leadA);
    const code = await runUp(['--dry-run'], io, upSources(here.home));
    expect(io.err, io.out).toBe('');
    expect(code).toBe(0);
    expect(io.out).toContain('builder-a');
  });
});

describe('the one standing the project lead holds: admission', () => {
  test('the project record names the lead, and the lead writes to its teams\' leads — to nothing else of them', () => {
    const here = world();
    const team = register(here);
    const teams = readTeams(here.home);
    const context: AdmitContext = { projects: readProjects(here.home), crossTeams: {} };

    // What the standing stands on: the file's claim, written to the registry as the project's
    // own `lead` — an agent id, and both teams named by the one project.
    expect(context.projects['oak']?.lead).toBe(team.leadA.id);
    expect(context.projects['oak']?.teams).toEqual([team.teamA, team.teamB]);

    // The leads pair writes: the project lead reaches its project's team leads.
    expect(admitSend(team.leadA, team.leadB, teams, undefined, context)).toEqual({
      ok: true,
      rule: PROJECT_RULES[0],
    });

    // And nothing more: the project's seats do not reach through the project, either way.
    const down = admitSend(team.leadA, team.builderB, teams, undefined, context);
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.why).toContain('no rule admits it');
    const up = admitSend(team.builderB, team.leadA, teams, undefined, context);
    expect(up.ok).toBe(false);
  });

  test('without the project records the pair still writes, but as two orchestrators: the record decides which row admits', () => {
    const here = world();
    const team = register(here);
    const teams = readTeams(here.home);
    // The same two records over the team registry alone: the teams' own row admits them — the
    // project record is not what makes the pair work, and it is the row the record displaces.
    expect(admitSend(team.leadA, team.leadB, teams)).toEqual({
      ok: true,
      rule: 'an orchestrator to another orchestrator',
    });
    // And with no project in hand the lead still reaches nothing else of the other team.
    expect(admitSend(team.leadA, team.builderB, teams).ok).toBe(false);
  });
});
