// The agent record's identity rules, pinned end to end over the real registry files:
//
// 1. Identity is (team id, file seat), never the pane: a pane change re-points the same record,
//    and one pair holds one live record — a seat of the same name in another team is another agent.
// 2. Records are append-only: a removed seat is marked ended, never deleted, and its history stays
//    readable; a retired seat's next launch is a new agent, never a reuse of the old id.
// 3. A record confers no right: admission never reads a record as permission — a live, running
//    record on each side decides nothing, and only the registry's own capabilities admit a pair.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTeamFile } from '../../src/file/validate.ts';
import { agentsDir, findAgent, getAgent, readAgents, registerAgent, type Agent } from '../../src/registry/agents.ts';
import { readProjects, upsertProject } from '../../src/registry/projects.ts';
import { registerEnd, registerLaunch, type RegistryTeam } from '../../src/registry/sync.ts';
import { getTeam, readTeams, teamIdOf, upsertTeam } from '../../src/registry/teams.ts';
import { admitSend, type AdmitContext } from '../../src/send/admit.ts';
import { gitEnv } from '../helpers.ts';

const TEAM_YAML = `format: 1
project: acme
coordinator: lead
operator: ops
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

  - role: coordinator
    name: ops
    label: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

type World = { base: string; home: string };
type Fixture = World & { root: string; file: string; yaml: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp home, shared by every root of the scene: the registry is the home's, not the root's. */
function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-registry-identity-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  return { base, home };
}

/** One registered team root: a git repo carrying a valid team file, the way the commands read it. */
function makeRoot(world: World, name: string, project: string): Fixture {
  const root = join(world.base, name);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const yaml = TEAM_YAML.replace('project: acme', `project: ${project}`)
    .replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`);
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, yaml);
  return { ...world, root, file, yaml };
}

function teamOf(fixture: Fixture): RegistryTeam['team'] {
  const parsed = validateTeamFile(fixture.yaml, { home: fixture.home, root: fixture.root });
  if (!parsed.ok) throw new Error('fixture team does not validate');
  return parsed.team;
}

function registryOf(fixture: Fixture): RegistryTeam {
  return { home: fixture.home, team: teamOf(fixture), root: fixture.root, by: 'owner' };
}

/** Launches one seat of the fixture's file, the way `team up` does: register-or-repoint. */
function launch(fixture: Fixture, seatName: string, pane: string): string {
  const seat = teamOf(fixture).seats.find((entry) => entry.name === seatName);
  if (!seat) throw new Error(`the fixture has no seat ${seatName}`);
  const result = registerLaunch(registryOf(fixture), seat, pane);
  if (!('id' in result)) throw new Error(result.note);
  return result.id;
}

function endSeat(fixture: Fixture, seatName: string, ending: 'stopped' | 'retired'): void {
  const note = registerEnd(registryOf(fixture), seatName, ending);
  if (note) throw new Error(note.note);
}

/** One agent record, registered directly: the shape a seat's launch writes, without herdr. */
function record(home: string, team: string, seat: string, session: string, pane: string): Agent {
  return registerAgent(home, {
    name: seat,
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team, seat, session, pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
}

describe("the record's identity is the team id and the file seat", () => {
  test('a pane change re-points the same record: one (team, seat) pair holds one live agent', () => {
    const world = makeWorld();
    const fixture = makeRoot(world, 'acme', 'acme');
    const teamId = teamIdOf(fixture.root);

    const first = launch(fixture, 'worker', 'w1:p1');
    expect(first).toMatch(/^agt_[0-9a-f]{12}$/);
    expect(getAgent(world.home, first)!.reach).toMatchObject({ team: teamId, seat: 'worker', pane: 'w1:p1' });

    // The pane is gone and the seat moved: the agent is the same one, re-pointed.
    const second = launch(fixture, 'worker', 'w2:p9');
    expect(second).toBe(first);
    expect(findAgent(world.home, { team: teamId, seat: 'worker' })?.id).toBe(first);
    expect(readAgents(world.home)).toHaveLength(1);
    expect(getAgent(world.home, first)!.reach.pane).toBe('w2:p9');
  });

  test('a seat of the same name in another team is another agent: the team id tells them apart', () => {
    const world = makeWorld();
    const alpha = makeRoot(world, 'alpha', 'acme');
    const beta = makeRoot(world, 'beta', 'bee');
    const teamAlpha = teamIdOf(alpha.root);
    const teamBeta = teamIdOf(beta.root);
    expect(teamAlpha).not.toBe(teamBeta);

    const inAlpha = launch(alpha, 'worker', 'w1:p1');
    const inBeta = launch(beta, 'worker', 'w2:p1');
    expect(inAlpha).not.toBe(inBeta);
    expect(findAgent(world.home, { team: teamAlpha, seat: 'worker' })?.id).toBe(inAlpha);
    expect(findAgent(world.home, { team: teamBeta, seat: 'worker' })?.id).toBe(inBeta);
    expect(readAgents(world.home)).toHaveLength(2);
    expect(getAgent(world.home, inBeta)!.reach).toMatchObject({ team: teamBeta, seat: 'worker', session: 'bee' });
  });

  test('the same seat in the same team keeps its id across stop and relaunch, whatever the pane', () => {
    const world = makeWorld();
    const fixture = makeRoot(world, 'acme', 'acme');
    const teamId = teamIdOf(fixture.root);
    const id = launch(fixture, 'worker', 'w1:p1');

    endSeat(fixture, 'worker', 'stopped');
    const stopped = findAgent(world.home, { team: teamId, seat: 'worker' });
    expect(stopped?.id).toBe(id);
    expect(stopped?.lifecycle).toBe('stopped');
    expect(stopped?.reach.pane).toBeNull();

    const again = launch(fixture, 'worker', 'w3:p7');
    expect(again).toBe(id);
    expect(getAgent(world.home, id)!.lifecycle).toBe('running');
    expect(readAgents(world.home)).toHaveLength(1);
  });
});

describe('records are append-only', () => {
  test('a retired seat is marked ended, never deleted, and its history stays readable', () => {
    const world = makeWorld();
    const fixture = makeRoot(world, 'acme', 'acme');
    const teamId = teamIdOf(fixture.root);
    const id = launch(fixture, 'worker', 'w1:p1');
    const registered = getAgent(world.home, id)!;
    const files = readdirSync(agentsDir(world.home)).length;

    endSeat(fixture, 'worker', 'retired');

    // The seat is no longer held, and the roster no longer names it...
    expect(findAgent(world.home, { team: teamId, seat: 'worker' })).toBeNull();
    expect(getTeam(world.home, teamId)?.roster).toEqual([]);
    // ...but the record is not gone: its lifecycle says ended, its pane is cleared, and what was
    // registered is still what a reader gets.
    const kept = getAgent(world.home, id)!;
    expect(kept.lifecycle).toBe('retired');
    expect(kept.reach).toMatchObject({ team: teamId, seat: 'worker', pane: null });
    expect(kept.provenance.registered_at).toBe(registered.provenance.registered_at);
    expect(kept.provenance.registered_by).toBe(registered.provenance.registered_by);
    expect(readAgents(world.home).map((agent) => agent.id)).toEqual([id]);
    expect(readdirSync(agentsDir(world.home))).toHaveLength(files);
  });

  test("a retired seat's next launch is a new agent: the old record stays, and the id is never reused", () => {
    const world = makeWorld();
    const fixture = makeRoot(world, 'acme', 'acme');
    const teamId = teamIdOf(fixture.root);
    const first = launch(fixture, 'worker', 'w1:p1');
    endSeat(fixture, 'worker', 'retired');

    const second = launch(fixture, 'worker', 'w1:p2');
    expect(second).not.toBe(first);
    expect(findAgent(world.home, { team: teamId, seat: 'worker' })?.id).toBe(second);
    // Both records are there: the new agent holds the seat, the ended one keeps its history.
    expect(readAgents(world.home).map((agent) => agent.id).sort()).toEqual([first, second].sort());
    expect(getAgent(world.home, first)!.lifecycle).toBe('retired');
    expect(getAgent(world.home, second)!.lifecycle).toBe('running');
  });
});

describe('a record confers no right', () => {
  test('two live records and no rule: the pair is refused, exactly as a pair the registry never knew', () => {
    const world = makeWorld();
    const teamA = teamIdOf(join(world.base, 'team-a'));
    const teamB = teamIdOf(join(world.base, 'team-b'));

    // Both sides are registered, running records.
    const worker = record(world.home, teamA, 'worker', 's-a', 'w1:p1');
    const builder = record(world.home, teamB, 'builder', 's-b', 'w2:p1');
    upsertTeam(world.home, teamA, {
      project: 'alpha',
      session: 's-a',
      root: join(world.base, 'team-a'),
      roster: [{ agent: worker.id, seat: 'worker', role: 'implementer' }],
    });
    upsertTeam(world.home, teamB, {
      project: 'beta',
      session: 's-b',
      root: join(world.base, 'team-b'),
      roster: [{ agent: builder.id, seat: 'builder', role: 'implementer' }],
    });
    // One project names both teams, so the project rules are in play — and admit neither.
    upsertProject(world.home, 'p1', { name: 'P1', teams: [teamA, teamB], by: 'owner' });

    const teams = readTeams(world.home);
    const context: AdmitContext = { projects: readProjects(world.home), crossTeams: {} };

    const judged = admitSend(worker, builder, teams, undefined, context);
    expect(judged.ok).toBe(false);
    if (judged.ok) return;
    expect(judged.why).toContain(`worker@${teamA} may not send to builder@${teamB}`);
    expect(judged.why).toContain('no rule admits it');

    // The very same pair, judged as bare seats: the records changed nothing — verdict for verdict,
    // word for word, the record was never read as permission.
    const bare = admitSend(
      { seat: 'worker', team: teamA, role: 'implementer' },
      { seat: 'builder', team: teamB, role: 'implementer' },
      teams,
      undefined,
      context,
    );
    expect(bare).toEqual(judged);
    expect(readAgents(world.home).every((agent) => agent.lifecycle === 'running')).toBe(true);
  });

  test('the one thing that admits the pair is the `leads` capability, and the records stay untouched', () => {
    const world = makeWorld();
    const teamA = teamIdOf(join(world.base, 'team-a'));
    const teamB = teamIdOf(join(world.base, 'team-b'));
    const worker = record(world.home, teamA, 'worker', 's-a', 'w1:p1');
    const builder = record(world.home, teamB, 'builder', 's-b', 'w2:p1');
    upsertTeam(world.home, teamA, {
      project: 'alpha',
      session: 's-a',
      root: join(world.base, 'team-a'),
      roster: [{ agent: worker.id, seat: 'worker', role: 'implementer' }],
    });
    upsertTeam(world.home, teamB, {
      project: 'beta',
      session: 's-b',
      root: join(world.base, 'team-b'),
      roster: [{ agent: builder.id, seat: 'builder', role: 'implementer' }],
    });
    upsertProject(world.home, 'p1', { name: 'P1', teams: [teamA, teamB], by: 'owner' });
    const context: AdmitContext = { projects: readProjects(world.home), crossTeams: {} };

    // The records already existed and admitted nothing; the capability, and only the capability,
    // changes the verdict.
    upsertTeam(world.home, teamA, {
      roster: [{ agent: worker.id, seat: 'worker', role: 'implementer', leads: true }],
    });
    upsertTeam(world.home, teamB, {
      roster: [{ agent: builder.id, seat: 'builder', role: 'implementer', leads: true }],
    });

    expect(admitSend(worker, builder, readTeams(world.home), undefined, context)).toEqual({
      ok: true,
      rule: 'team leads within one project to each other',
    });
    // Neither agent record moved: the right came from the roster's own capability, never from a record.
    expect(getAgent(world.home, worker.id)).toEqual(worker);
    expect(getAgent(world.home, builder.id)).toEqual(builder);
  });
});
