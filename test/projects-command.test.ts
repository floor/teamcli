// Phase 0b: the project views. `team projects` lists the registry's projects; `team status
// --project <name>` covers one project's teams. Both read through the small injected sources, so
// no registry file, no herdr session and no caller gate is touched here. The roster's own project
// column is covered in test/send.test.ts.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProjects, type ProjectSources, type ProjectView } from '../src/commands/projects.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { PROJECTS_OUTPUT_SCHEMA } from '../src/output/index.ts';
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
 *  source and the home, and nothing else. With no projects source handed in, the field is left
 *  off — the shape a caller reads when only the home is known. */
function statusWith(home: string, projects?: ProjectSources): StatusSources {
  return {
    live: () => null,
    branch: () => null,
    standing: () => ({ kind: 'none' }),
    now: () => new Date('2026-10-05T04:00:00.000Z'),
    home,
    ...(projects ? { projects } : {}),
  };
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
    expect(io.out).toBe(
      'project TeamCLI  4f2a1b7c9d0e  entity floor  lead agt_2b9f\n'
      + `  ${TEAM_A}  session "teamcli"  defined  1 seat\n`
      + `  ${TEAM_B}  not registered\n`,
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
      + `  ${TEAM_A}  not registered\n`,
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
        { name: TEAM_A, session: 'teamcli', lifecycle: 'defined', seats: 0 },
        { name: TEAM_B, session: null, lifecycle: null, seats: null },
      ],
    });
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
