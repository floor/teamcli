// The project level, wired into `team send`: a send crossing two teams of one project is judged
// by the project's own rules first (src/send/admit.ts), over the records the command hands in —
// the registered projects, and the live file's lead line carrying the `leads` capability. Two
// scenes: a lead of one team in project TeamCLI reaches a lead of another team of it by name, and
// the same pair stays refused when no project names both teams. The team rules alone refuse the
// pair either way on this base — neither registered roster line is an orchestrator by any
// spelling, and no role name decides — so the admitted scene is the project wiring, not the old
// rules. Fake herdr, a temporary home and temporary roots: no live session and no real CLI home
// is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { runSend, type SendHost } from '../../src/commands/send.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { registerAgent, type Agent } from '../../src/registry/agents.ts';
import { upsertProject } from '../../src/registry/projects.ts';
import { readTeams, teamIdOf, upsertTeam } from '../../src/registry/teams.ts';
import { admitSend, PROJECT_RULES, PROJECT_RULE_SUMMARY, RULE_SUMMARY } from '../../src/send/admit.ts';
import type { NativePane } from '../../src/send/native.ts';
import { updateState } from '../../src/state.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-17T02:00:00Z');
const BODY = 'the phase 0b send, addressed by name';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempBase(prefix: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(base);
  return base;
}

type SendWorld = { base: string; home: string; roots: Record<string, string> };

function seatBlock(role: string, name: string, cli: string, vendor: string): string {
  return `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: ${cli}
    vendor: ${vendor}
    model: Test
    version: "1"
    launch: ${cli} --model test
`;
}

/** One root with `.agents/team.yaml`, and a home: the shape `team send` reads. */
function sendWorld(teams: Record<string, { project: string; session: string; coordinator: string; seats: string[] }>): SendWorld {
  const base = tempBase('r5-proj-');
  const home = join(base, 'h');
  mkdirSync(lobbyDir(home), { recursive: true });
  const roots: Record<string, string> = {};
  for (const [name, team] of Object.entries(teams)) {
    const root = join(base, name);
    mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: ${team.project}
coordinator: ${team.coordinator}
operator: ${team.coordinator}
session: ${team.session}
trust:
  - ${lobbyDir(home)}
  - ${root}
workspace:
  mode: shared
seats:
${team.seats.join('')}`);
    roots[name] = root;
  }
  return { base, home, roots };
}

/** One agent record, as `up`/`add` would have registered it. The role is an ordinary word on
 *  purpose: the project record and the file's lead line decide, never a role's name. */
function registered(
  home: string,
  init: { name: string; role: string; team: string; seat: string; session: string; pane: string },
): Agent {
  return registerAgent(home, {
    name: init.name,
    signing: { model: 'Test', version: '1', role: init.role },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude-code --model test',
    reach: { team: init.team, seat: init.seat, session: init.session, pane: init.pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
}

function teamRecord(
  home: string,
  id: string,
  team: {
    project: string;
    session: string;
    root: string;
    // `leads` rides on the entry as the file writes it; a scene that says nothing reads as not
    // leading, the way a line written before the field existed does.
    roster: { agent: string; seat: string; role: string; leads?: boolean }[];
  },
): void {
  upsertTeam(home, id, {
    project: team.project,
    entity: null,
    session: team.session,
    root: team.root,
    lobby: lobbyDir(home),
    roster: team.roster.map((entry) => ({ ...entry, leads: entry.leads ?? false })),
    lifecycle: 'running',
  });
}

type Typed = { session: string; pane: string; text: string };
type Scripted = NativePane & { typed: Typed[]; enters: number };

/** Status samples, one per read: the pre-Enter read, then the polls. `wait` costs nothing. */
function scripted(samples: string[]): Scripted {
  const typed: Typed[] = [];
  let enters = 0;
  let read = 0;
  return {
    typed,
    get enters() {
      return enters;
    },
    typeText: (session, pane, text) => {
      typed.push({ session, pane, text });
      return true;
    },
    pressEnter: () => {
      enters += 1;
      return true;
    },
    status: () => samples[Math.min(read++, samples.length - 1)] ?? 'idle',
    wait: async () => {},
  };
}

/** The fake herdr of the scene: each seat's pane has its own scripted status, and a trigger
 *  typed into any other pane is not taken. The live name is the seat's own — herdr names the
 *  seat it lists, which is what a send reads by before it types. */
function sendHost(world: SendWorld, seats: Record<string, { name?: string; session: string; pane: string; paneStatus: NativePane }>): SendHost & { typedInto: (pane: string) => Typed[] } {
  const byPane = new Map(Object.values(seats).map((seat) => [seat.pane, seat]));
  const bySession = new Map<string, { name: string; pane: string }[]>();
  for (const [key, seat] of Object.entries(seats)) {
    const list = bySession.get(seat.session) ?? [];
    list.push({ name: seat.name ?? key, pane: seat.pane });
    bySession.set(seat.session, list);
  }
  return {
    typedInto: (pane) => (byPane.get(pane)?.paneStatus as { typed?: Typed[] } | undefined)?.typed ?? [],
    agents: (session) => bySession.get(session) ?? null,
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: join(world.base, 'sockets'),
    deliver: async () => ({ ok: true }),
    native: {
      typeText: (session, pane, text) => byPane.get(pane)?.paneStatus.typeText(session, pane, text) ?? false,
      pressEnter: (session, pane) => byPane.get(pane)?.paneStatus.pressEnter(session, pane) ?? false,
      status: (session, pane) => byPane.get(pane)?.paneStatus.status(session, pane) ?? null,
      wait: async () => {},
    },
    now: () => NOW,
    home: world.home,
  };
}

/** The drop the trigger names: the typed line's whitespace-free token that is a path. */
function dropOf(typed: string): { path: string; text: string } {
  const word = typed.split(/\s+/).find((part) => part.startsWith('/'));
  if (!word) throw new Error(`no absolute path in the typed trigger: ${typed}`);
  return { path: word, text: readFileSync(word, 'utf8') };
}

/** The scene's world: teamcli and teamcli.io, each with a seat named `lead`, both registered,
 *  and the callers on their own root. */
function twoTeams(): {
  world: SendWorld;
  cliId: string;
  ioId: string;
  cliRoot: string;
  cliLead: Agent;
  ioLead: Agent;
  caller: Caller;
} {
  const world = sendWorld({
    cli: { project: 'teamcli', session: 'teamcli', coordinator: 'lead', seats: [seatBlock('chief', 'lead', 'claude-code', 'anthropic')] },
    io: { project: 'teamcli.io', session: 'teamcli.io', coordinator: 'lead', seats: [seatBlock('chief', 'lead', 'claude-code', 'anthropic')] },
  });
  const cliRoot = world.roots.cli as string;
  const ioRoot = world.roots.io as string;
  const cliId = teamIdOf(cliRoot);
  const ioId = teamIdOf(ioRoot);
  const cliLead = registered(world.home, { name: 'lead', role: 'chief', team: cliId, seat: 'lead', session: 'teamcli', pane: 'pane-cli-lead' });
  const ioLead = registered(world.home, { name: 'lead', role: 'chief', team: ioId, seat: 'lead', session: 'teamcli.io', pane: 'pane-io-lead' });
  // The file makes the seat named `lead` its coordinator, so the record carries the `leads`
  // capability on it: `lead@<team>` addresses the seat holding leads, never a name alone
  // (src/send/resolve.ts). The role stays an ordinary word.
  teamRecord(world.home, cliId, { project: 'teamcli', session: 'teamcli', root: cliRoot, roster: [{ agent: cliLead.id, seat: 'lead', role: 'chief', leads: true }] });
  teamRecord(world.home, ioId, { project: 'teamcli.io', session: 'teamcli.io', root: ioRoot, roster: [{ agent: ioLead.id, seat: 'lead', role: 'chief', leads: true }] });
  // The state record `up` leaves for the caller: the pane the seat stands on, which is what
  // binds the call to its registry record.
  updateState(join(cliRoot, '.agents'), (state) => {
    state.sessions.teamcli = { seats: { lead: { stage: 'launched', pane: 'pane-cli-lead', workspace: 'w1' } }, worktrees: {} };
  });
  return { world, cliId, ioId, cliRoot, cliLead, ioLead, caller: { kind: 'seat', name: 'lead', pane: 'pane-cli-lead', session: 'teamcli' } };
}

function sceneHost(world: SendWorld): { host: SendHost & { typedInto: (pane: string) => Typed[] }; cliPane: Scripted; ioPane: Scripted } {
  const cliPane = scripted(['idle']);
  const ioPane = scripted(['idle', 'working']);
  const host = sendHost(world, {
    'cli-lead': { name: 'lead', session: 'teamcli', pane: 'pane-cli-lead', paneStatus: cliPane },
    'io-lead': { name: 'lead', session: 'teamcli.io', pane: 'pane-io-lead', paneStatus: ioPane },
  });
  return { host, cliPane, ioPane };
}

describe('the project level admits a pair the team rules refuse', () => {
  test("teamcli's lead reaches teamcli.io's lead by name when both teams are in project TeamCLI", async () => {
    const { world, cliRoot, cliLead, ioLead, caller } = twoTeams();
    // The project record: TeamCLI, its lead by agent id (the io team's lead), and both teams.
    const project = upsertProject(world.home, 'teamcli', { name: 'TeamCLI', entity: 'teamcli', lead: ioLead.id, teams: [teamIdOf(cliRoot), ioLead.reach.team] });
    expect(project.teams).toContain(teamIdOf(cliRoot));
    const { host, cliPane, ioPane } = sceneHost(world);

    // The team rules alone: refused. Neither registered roster line is an orchestrator by any
    // spelling, and no role name decides — so the admission below is the project's own.
    const teamRules = admitSend(cliLead, ioLead, readTeams(world.home));
    expect(teamRules.ok).toBe(false);

    const code = await runSend(['lead@teamcli.io', BODY], testIo(cliRoot, caller), host);

    expect(code).toBe(0);
    expect(cliPane.typed).toEqual([]);
    expect(ioPane.typed.length).toBe(1);
    const typed = ioPane.typed[0] as Typed;
    expect(typed.session).toBe('teamcli.io');
    expect(typed.pane).toBe('pane-io-lead');
    const drop = dropOf(typed.text);
    // The header names the sender's agent id and the project rule that admitted it, before the body.
    expect(drop.text).toContain(cliLead.id);
    expect(drop.text).toContain(PROJECT_RULES[0]);
    expect(drop.text).toContain(BODY);
    expect(drop.text.indexOf(cliLead.id)).toBeLessThan(drop.text.indexOf(BODY));
  });

  test('the same pair is refused when no project names both teams', async () => {
    const { world, cliRoot, ioId, cliLead, ioLead, caller } = twoTeams();
    // Both teams sit in projects — just never the same one, and no project names teamcli.
    upsertProject(world.home, 'other', { name: 'Other', teams: [ioId] });
    const { host, cliPane, ioPane } = sceneHost(world);

    // Nothing in the records moved: the pair is judged as it was, and no rule admits it.
    expect(admitSend(cliLead, ioLead, readTeams(world.home)).ok).toBe(false);

    const io = testIo(cliRoot, caller);
    const code = await runSend(['lead@teamcli.io', BODY], io, host);

    expect(code).toBe(1);
    expect(io.err).toBe(
      `team send: refused: lead@${teamIdOf(cliRoot)} may not send to lead@${ioId}: no rule admits it (${PROJECT_RULE_SUMMARY}; ${RULE_SUMMARY})\n`,
    );
    expect(cliPane.typed).toEqual([]);
    expect(ioPane.typed).toEqual([]);
    expect(ioPane.enters).toBe(0);
  });
});
