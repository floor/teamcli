// Phase 0b: the project views. `team projects` lists the registry's projects; `team status
// --project <name>` covers one project's teams. Both read through the small injected sources, so
// no registry file, no herdr session and no caller gate is touched here. The roster's own project
// column is covered in test/send.test.ts.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ListedSession, RosterSeat } from '../src/commands/list.ts';
import { runProjects, type ProjectSources, type ProjectView } from '../src/commands/projects.ts';
import { runStatus, type ProjectLiveSources, type StatusSources } from '../src/commands/status.ts';
import { PROJECTS_OUTPUT_SCHEMA, STATUS_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { ProjectsError, upsertProject } from '../src/registry/projects.ts';
import { upsertTeam } from '../src/registry/teams.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

// Two teams of one project, by team ID — the ID a team record is stored under and the ID a
// project's own `teams` list names.
const TEAM_A = '1a2b3c4d5e6f';
const TEAM_B = '6f5e4d3c2b1a';

const PROVENANCE = { registered_by: 'test', registered_at: '2026-10-05T04:00:00.000Z', updated_at: '2026-10-05T04:00:00.000Z' };

function project(over: Partial<ProjectView> = {}): ProjectView {
  return {
    id: '4f2a1b7c9d0e',
    name: 'TeamCLI',
    entity: 'floor',
    lead: 'agt_2b9f',
    teams: [TEAM_A, TEAM_B],
    provenance: PROVENANCE,
    ...over,
  };
}

function sourcesOf(records: ProjectView[]): ProjectSources {
  return {
    list: () => records,
    byName: (key) => records.find((item) => item.name === key) ?? null,
    ofTeam: (teamId) => records.find((item) => item.teams.includes(teamId)) ?? null,
  };
}

/** A status sources whose every reading is a stand-in: the project path reads the projects
 *  source, the home and the live seat source, and nothing else. With no projects source or live
 *  source handed in, that field is left off — the shapes a caller reads when it has neither. */
function statusWith(home: string, projects?: ProjectSources, liveSeats?: ProjectLiveSources): StatusSources {
  return {
    live: () => null,
    branch: () => null,
    standing: () => ({ kind: 'none' }),
    now: () => new Date('2026-10-05T04:00:00.000Z'),
    home,
    ...(projects ? { projects } : {}),
    ...(liveSeats ? { list: liveSeats } : {}),
  };
}

/** The machine-wide live seat reading the project view takes — the same one `team list --seats`
 *  takes — stood in for, so no scene runs herdr. A session absent from the list is down; a
 *  session with no roster entry reads its roster as unreadable. */
function liveSeats(sessions: ListedSession[] | null, rosters: Record<string, RosterSeat[] | null> = {}): ProjectLiveSources {
  return {
    sessions: () => sessions,
    roster: (session) => rosters[session] ?? null,
  };
}

function seat(name: string, status: string | null, model: string | null = null): RosterSeat {
  return { name, status, model };
}

function home(): { dir: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'team-projects-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('team projects lists each project: id, name, entity, lead and teams', async () => {
  const io = testIo('/anywhere');
  const code = await runProjects([], io, sourcesOf([project()]));
  expect(code).toBe(0);
  expect(io.err).toBe('');
  expect(io.out).toBe(
    'ID            NAME     ENTITY  LEAD      TEAMS\n'
    + `4f2a1b7c9d0e  TeamCLI  floor   agt_2b9f  ${TEAM_A}, ${TEAM_B}\n`
    + '1 project\n',
  );
});

test('a project with no entity or lead prints a dash, and a wider id widens every row', async () => {
  const io = testIo('/anywhere');
  const code = await runProjects([], io, sourcesOf([
    project({ id: 'b', name: 'Beta', entity: null, lead: null, teams: [] }),
    project({ id: 'aaaa', name: 'Alpha', entity: 'x', lead: 'l', teams: ['t'] }),
  ]));
  expect(code).toBe(0);
  expect(io.out).toBe(
    'ID    NAME   ENTITY  LEAD  TEAMS\n'
    + 'b     Beta   -       -     -\n'
    + 'aaaa  Alpha  x       l     t\n'
    + '2 projects\n',
  );
});

test('a registry with no projects says so', async () => {
  const io = testIo('/anywhere');
  const code = await runProjects([], io, sourcesOf([]));
  expect(code).toBe(0);
  expect(io.out).toBe('ID  NAME  ENTITY  LEAD  TEAMS\n0 projects\n');
});

test('--json carries the records, ids, provenance and deliveryOrder included, and matches PROJECTS_OUTPUT_SCHEMA', async () => {
  const io = testIo('/anywhere');
  const withDelivery = project({ deliveryOrder: ['native', 'typed'] });
  const code = await runProjects(['--json'], io, sourcesOf([withDelivery]));
  expect(code).toBe(0);
  const parsed = assertMatchesOutputSchema(io.out, PROJECTS_OUTPUT_SCHEMA);
  expect(parsed).toEqual({
    schema: { name: 'team.projects', version: 1 },
    format: 1,
    projects: [withDelivery],
  });
});

test('an argument a project view does not take is refused', async () => {
  const io = testIo('/anywhere');
  const code = await runProjects(['extra'], io, sourcesOf([project()]));
  expect(code).toBe(2);
  expect(io.err).toContain('team projects: unexpected "extra"');
  expect(io.err).toContain('Usage: team projects [--json]');

  const ioJson = testIo('/anywhere');
  expect(await runProjects(['--json', 'extra'], ioJson, sourcesOf([project()]))).toBe(2);
  expect(ioJson.err).toBe('');
  assertJsonErrorShape(ioJson.out, { id: 'projects.invocation', messageContains: 'unexpected "extra"' });

  const ioNope = testIo('/anywhere');
  expect(await runProjects(['--nope', '--json'], ioNope, sourcesOf([project()]))).toBe(2);
  expect(ioNope.err).toBe('');
  assertJsonErrorShape(ioNope.out, { id: 'projects.invocation', messageContains: 'unknown option --nope' });

  const ioInline = testIo('/anywhere');
  expect(await runProjects(['--json=1'], ioInline, sourcesOf([project()]))).toBe(2);
  expect(ioInline.err).toBe('');
  assertJsonErrorShape(ioInline.out, { id: 'projects.invocation', messageContains: 'unknown option --json' });
});

test('a registry that cannot be read is the command\'s own line, exit 1', async () => {
  const io = testIo('/anywhere');
  const path = '/home/someone/.config/team/projects.yaml';
  const code = await runProjects([], io, {
    ...sourcesOf([]),
    list: () => { throw new ProjectsError(`${path}: line 2: "projects" must be a map`); },
  });
  expect(code).toBe(1);
  expect(io.out).toBe('');
  expect(io.err).toBe(`team projects: the project registry cannot be read: ${path}: line 2: "projects" must be a map\n`);

  const ioJson = testIo('/anywhere');
  expect(await runProjects(['--json'], ioJson, {
    ...sourcesOf([]),
    list: () => { throw new ProjectsError(`${path}: line 2: "projects" must be a map`); },
  })).toBe(1);
  expect(ioJson.err).toBe('');
  assertJsonErrorShape(ioJson.out, { id: 'projects.unreadable', messageContains: 'the project registry cannot be read' });
});

test('team status --project covers every team of the project, registered or not', async () => {
  const place = home();
  try {
    upsertTeam(place.dir, TEAM_A, {
      project: 'TeamCLI',
      session: 'teamcli',
      root: '/work/teamcli',
      roster: [{ agent: 'agt_1', seat: 'lead', role: 'coordinator', leads: true }],
    });
    const io = testIo('/anywhere');
    const code = await runStatus(['--project', 'TeamCLI'], io, statusWith(place.dir, sourcesOf([project()])));
    expect(code).toBe(0);
    expect(io.err).toBe('');
    // No live source stands in: every session reads down, so the recorded seat is stopped, and
    // the project says so instead of failing.
    expect(io.out).toBe(
      'project TeamCLI  4f2a1b7c9d0e  entity floor  lead agt_2b9f\n'
      + `  ${TEAM_A}  session "teamcli"  defined  1 seat  home  stopped\n`
      + `  ${TEAM_B}  not registered  home\n`
      + '  TEAM          SEAT  STATE    MODEL\n'
      + `  ${TEAM_A}  lead  stopped  -\n`
      + '0 active agents\n',
    );
  } finally {
    place.done();
  }
});

test("team status --project reads the registry the home holds when no projects source is injected", async () => {
  const place = home();
  try {
    // Written through the registry's own writer into the injected home: the reading that finds it
    // is the one bound to this home — a read through another directory would find nothing.
    upsertProject(place.dir, '4f2a1b7c9d0e', { name: 'TeamCLI', entity: 'floor', lead: 'agt_2b9f', teams: [TEAM_A] });
    const io = testIo('/anywhere');
    const code = await runStatus(['--project', 'TeamCLI'], io, statusWith(place.dir));

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe(
      'project TeamCLI  4f2a1b7c9d0e  entity floor  lead agt_2b9f\n'
      + `  ${TEAM_A}  not registered  home\n`
      + '0 active agents\n',
    );

    // The same fallback still refuses a name the registry does not hold.
    const nopeIo = testIo('/anywhere');
    const nope = await runStatus(['--project', 'nope'], nopeIo, statusWith(place.dir));
    expect(nope).toBe(1);
    expect(nopeIo.err).toBe('team status: no project named "nope"; nothing to show\n');
  } finally {
    place.done();
  }
});

test('team status --project --json carries the record and each team\'s own reading', async () => {
  const place = home();
  try {
    upsertTeam(place.dir, TEAM_A, { project: 'TeamCLI', session: 'teamcli', root: '/work/teamcli' });
    const io = testIo('/anywhere');
    const code = await runStatus(['--project', 'TeamCLI', '--json'], io, statusWith(place.dir, sourcesOf([project()])));
    expect(code).toBe(0);
    expect(JSON.parse(io.out)).toEqual({
      schema: { name: 'team.status.project', version: 1 },
      format: 1,
      project: project(),
      teams: [
        {
          name: TEAM_A, membership: 'home', session: 'teamcli', lifecycle: 'defined', seats: 0,
          running: false, active: { ready: 0, working: 0, waiting: 0, stopped: 0 }, roster: [],
        },
        {
          name: TEAM_B, membership: 'home', session: null, lifecycle: null, seats: null,
          running: false, active: null, roster: [],
        },
      ],
      active_agents: 0,
    });
  } finally {
    place.done();
  }
});

test('team status --project reads each seat live: state, model and team, and counts the active agents', async () => {
  const place = home();
  try {
    upsertTeam(place.dir, TEAM_A, {
      project: 'TeamCLI',
      session: 'teamcli',
      root: '/work/teamcli',
      roster: [
        { agent: 'agt_1', seat: 'lead', role: 'coordinator', leads: true },
        { agent: 'agt_2', seat: 'dev', role: 'builder' },
      ],
    });
    upsertTeam(place.dir, TEAM_B, {
      project: 'TeamCLI',
      session: 'teamcli-io',
      root: '/work/teamcli-io',
      roster: [{ agent: 'agt_3', seat: 'web', role: 'builder' }],
    });
    const io = testIo('/anywhere');
    const code = await runStatus(['--project', 'TeamCLI'], io, statusWith(place.dir, sourcesOf([project()]), liveSeats(
      [{ name: 'teamcli', running: true }, { name: 'teamcli-io', running: true }],
      {
        teamcli: [seat('lead', 'working', 'Claude Opus 5.5'), seat('dev', 'ready', 'Claude Sonnet 5.5')],
        'teamcli-io': [seat('web', 'waiting', 'Claude Opus 5.5')],
      },
    )));
    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe(
      'project TeamCLI  4f2a1b7c9d0e  entity floor  lead agt_2b9f\n'
      + `  ${TEAM_A}  session "teamcli"  defined  2 seats  home  running\n`
      + `  ${TEAM_B}  session "teamcli-io"  defined  1 seat  home  running\n`
      + '  TEAM          SEAT  STATE    MODEL\n'
      + `  ${TEAM_A}  lead  working  Claude Opus 5.5\n`
      + `  ${TEAM_A}  dev   ready    Claude Sonnet 5.5\n`
      + `  ${TEAM_B}  web   waiting  Claude Opus 5.5\n`
      + '3 active agents\n',
    );
  } finally {
    place.done();
  }
});

test('a team whose session is down reads stopped, not an error; herdr down reads the same', async () => {
  const place = home();
  try {
    upsertTeam(place.dir, TEAM_A, {
      project: 'TeamCLI',
      session: 'teamcli',
      root: '/work/teamcli',
      roster: [{ agent: 'agt_1', seat: 'lead', role: 'coordinator', leads: true }],
    });
    const expected =
      'project TeamCLI  4f2a1b7c9d0e  entity floor  lead agt_2b9f\n'
      + `  ${TEAM_A}  session "teamcli"  defined  1 seat  home  stopped\n`
      + `  ${TEAM_B}  not registered  home\n`
      + '  TEAM          SEAT  STATE    MODEL\n'
      + `  ${TEAM_A}  lead  stopped  -\n`
      + '0 active agents\n';
    const scenarios: Array<ListedSession[] | null> = [[{ name: 'teamcli', running: false }], null];
    for (const sessions of scenarios) {
      const io = testIo('/anywhere');
      const code = await runStatus(['--project', 'TeamCLI'], io, statusWith(place.dir, sourcesOf([project()]), liveSeats(sessions)));
      expect(code).toBe(0);
      expect(io.err).toBe('');
      expect(io.out).toBe(expected);
    }
  } finally {
    place.done();
  }
});

test('a running session whose roster cannot be read reads unknown, never zero active', async () => {
  const place = home();
  try {
    upsertTeam(place.dir, TEAM_A, {
      project: 'TeamCLI',
      session: 'teamcli',
      root: '/work/teamcli',
      roster: [{ agent: 'agt_1', seat: 'lead', role: 'coordinator', leads: true }],
    });
    const io = testIo('/anywhere');
    const code = await runStatus(['--project', 'TeamCLI', '--json'], io, statusWith(place.dir, sourcesOf([project()]), liveSeats(
      [{ name: 'teamcli', running: true }],
      { teamcli: null },
    )));
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out);
    expect(parsed.teams[0]).toMatchObject({ running: true, active: null, roster: [] });
    expect(parsed.active_agents).toBeNull();

    const text = testIo('/anywhere');
    expect(await runStatus(['--project', 'TeamCLI'], text, statusWith(place.dir, sourcesOf([project()]), liveSeats(
      [{ name: 'teamcli', running: true }],
      { teamcli: null },
    )))).toBe(0);
    expect(text.out).toContain('home  running\n');
    expect(text.out).toContain('? active agents\n');
  } finally {
    place.done();
  }
});

test('the project view marks a team that serves the project, and the home team beside it', async () => {
  const place = home();
  try {
    upsertTeam(place.dir, TEAM_A, {
      project: 'TeamCLI',
      session: 'teamcli',
      root: '/work/teamcli',
      roster: [
        { agent: 'agt_1', seat: 'lead', role: 'coordinator', leads: true },
        { agent: 'agt_2', seat: 'dev', role: 'builder' },
      ],
    });
    upsertTeam(place.dir, TEAM_B, {
      project: 'TeamCLI',
      projectId: 'ff00ff00ff00',
      session: 'teamcli-io',
      root: '/work/teamcli-io',
      roster: [{ agent: 'agt_3', seat: 'web', role: 'builder' }],
    });
    const io = testIo('/anywhere');
    const code = await runStatus(['--project', 'TeamCLI', '--json'], io, statusWith(place.dir, sourcesOf([project()]), liveSeats(
      [{ name: 'teamcli', running: true }],
      { teamcli: [seat('lead', 'working', 'Claude Opus 5.5'), seat('dev', 'idle', null)] },
    )));
    expect(code).toBe(0);
    const parsed = assertMatchesOutputSchema(io.out, STATUS_OUTPUT_SCHEMA);
    expect(parsed).toEqual({
      schema: { name: 'team.status.project', version: 1 },
      format: 1,
      project: project(),
      teams: [
        {
          name: TEAM_A, membership: 'home', session: 'teamcli', lifecycle: 'defined', seats: 2,
          running: true,
          active: { ready: 1, working: 1, waiting: 0, stopped: 0 },
          roster: [
            { team: TEAM_A, name: 'lead', state: 'working', model: 'Claude Opus 5.5' },
            { team: TEAM_A, name: 'dev', state: 'idle', model: null },
          ],
        },
        {
          name: TEAM_B, membership: 'serves', session: 'teamcli-io', lifecycle: 'defined', seats: 1,
          running: false,
          active: { ready: 0, working: 0, waiting: 0, stopped: 1 },
          roster: [{ team: TEAM_B, name: 'web', state: 'stopped', model: null }],
        },
      ],
      active_agents: 2,
    });
  } finally {
    place.done();
  }
});

test('--watch redraws the project reading once per pass and stops on the wait', async () => {
  const place = home();
  try {
    upsertTeam(place.dir, TEAM_A, { project: 'TeamCLI', session: 'teamcli', root: '/work/teamcli' });
    let passes = 0;
    const sources: StatusSources = {
      ...statusWith(place.dir, sourcesOf([project()]), liveSeats([{ name: 'teamcli', running: false }])),
      wait: async () => {
        passes += 1;
        return false;
      },
    };
    const io = testIo('/anywhere');
    const code = await runStatus(['--project', 'TeamCLI', '--watch'], io, sources);
    expect(code).toBe(0);
    expect(passes).toBe(1);
    expect(io.out).toContain('project TeamCLI  4f2a1b7c9d0e');
    expect(io.out).toContain('0 active agents\n');
  } finally {
    place.done();
  }
});

test('--watch with --json, or without --project, is an invocation that cannot be read', async () => {
  const place = home();
  try {
    const both = testIo('/anywhere');
    expect(await runStatus(['--project', 'TeamCLI', '--watch', '--json'], both, statusWith(place.dir, sourcesOf([project()])))).toBe(2);
    // A --json run reports its refusals as the one error document, like every other invocation.
    assertJsonErrorShape(both.out, { id: 'status.invocation', messageContains: "--watch and --json can't be used together" });

    const aimless = testIo('/anywhere');
    expect(await runStatus(['--watch'], aimless, statusWith(place.dir, sourcesOf([project()])))).toBe(2);
    expect(aimless.err).toContain('--watch needs --project <name>');
  } finally {
    place.done();
  }
});

test('a project no registry holds is refused by name', async () => {
  const place = home();
  try {
    const io = testIo('/anywhere');
    const code = await runStatus(['--project', 'nope'], io, statusWith(place.dir, sourcesOf([project()])));
    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe('team status: no project named "nope"; nothing to show\n');
  } finally {
    place.done();
  }
});

test('--project beside --session is an invocation that cannot be read', async () => {
  const place = home();
  try {
    const io = testIo('/anywhere');
    const code = await runStatus(['--project', 'TeamCLI', '--session', 'teamcli'], io, statusWith(place.dir, sourcesOf([project()])));
    expect(code).toBe(2);
    expect(io.out).toBe('');
    expect(io.err).toContain('--project reads the project; --session and --file name one team');
  } finally {
    place.done();
  }
});

test('a registry that cannot answer is not swallowed by the view', async () => {
  const io = testIo('/anywhere');
  // The real registry refuses a name two projects carry, naming both; the view lets that
  // refusal through to the one place that reports it, rather than picking one of the two.
  const twoNamed: ProjectSources = {
    ...sourcesOf([project()]),
    byName: (key) => {
      const found = [project(), project({ id: 'ff00' })].filter((item) => item.name === key);
      if (found.length > 1) throw new Error(`two projects are named ${key}: ${found.map((item) => item.id).join(', ')}`);
      return found[0] ?? null;
    },
  };
  await expect(runStatus(['--project', 'TeamCLI'], io, statusWith('/nowhere', twoNamed)))
    .rejects.toThrow('two projects are named TeamCLI: 4f2a1b7c9d0e, ff00');
});
