import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runInit } from '../src/commands/init.ts';
import {
  findTeam,
  findTeams,
  getTeam,
  noteTeam,
  readTeams,
  setRoster,
  setTeamLifecycle,
  teamIdOf,
  teamsFile,
  TeamsError,
  upsertTeam,
} from '../src/registry/teams.ts';
import { get as getProject, list as listProjects, projectsFile } from '../src/registry/projects.ts';
import { ISSUE_TRACKER_LIMITS } from '../src/registry/issue-tracker.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T12:00:00Z');
const AT = '2026-10-16T12:00:00.000Z';
const owner = { kind: 'owner' } as const;

let base: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-registry-teams-')));
  home = join(base, 'home');
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const seed = { project: 'acme', session: 'acme', root: '/work/acme' };

describe('team ID', () => {
  test('is the first 12 hex digits of the sha256 of the real path', () => {
    const real = join(base, 'real');
    mkdirSync(real);
    const id = teamIdOf(real);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(id).toBe(
      execFileSync('shasum', ['-a', '256'], { input: real, encoding: 'utf8' }).slice(0, 12),
    );
  });

  test('a symlink to the root names the same team as the root', () => {
    const real = join(base, 'real');
    mkdirSync(real);
    const link = join(base, 'link');
    symlinkSync(real, link);
    expect(teamIdOf(link)).toBe(teamIdOf(real));
  });

  test('a root that does not exist yet is hashed as written, so the ID is still stable', () => {
    expect(teamIdOf(join(base, 'later'))).toBe(teamIdOf(join(base, 'later')));
    expect(teamIdOf(join(base, 'later'))).not.toBe(teamIdOf(join(base, 'other')));
  });

  test('two roots never share an ID, and one root keeps its ID', () => {
    expect(teamIdOf('/work/a')).not.toBe(teamIdOf('/work/b'));
    expect(teamIdOf('/work/a')).toBe(teamIdOf('/work/a'));
  });
});

describe('the registry file', () => {
  test('lives at <home>/.config/team/teams.yaml', () => {
    expect(teamsFile('/h')).toBe('/h/.config/team/teams.yaml');
  });

  test('no file is no teams, and reading writes nothing', () => {
    expect(readTeams(home)).toEqual({});
    expect(getTeam(home, 'abc')).toBeNull();
    expect(existsSync(teamsFile(home))).toBe(false);
  });

  test('an empty file is no teams', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(teamsFile(home), '');
    expect(readTeams(home)).toEqual({});
  });

  test('a registered team is written in the documented shape', () => {
    upsertTeam(home, 'abcdef012345', { ...seed, entity: 'acme', lobby: '/home/lobby', lifecycle: 'running', by: 'owner', at: AT });
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(
      [
        'teams:',
        '  abcdef012345:',
        '    project: acme',
        '    project_id: null',
        '    entity: acme',
        '    session: acme',
        '    root: /work/acme',
        '    lobby: /home/lobby',
        '    roster: []',
        '    lifecycle: running',
        `    provenance: { registered_by: owner, registered_at: "${AT}", updated_at: "${AT}" }`,
        '',
      ].join('\n'),
    );
  });

  test('what was written reads back whole, roster and null entity included', () => {
    const roster = [
      { agent: 'agt_0123456789ab', seat: 'builder-1', role: 'builder' },
      { agent: 'agt_ba9876543210', seat: 'orchestrator', role: 'orchestrator', leads: true },
    ];
    upsertTeam(home, 'abcdef012345', { ...seed, lobby: '/home/lobby', roster, by: 'owner', at: AT });
    expect(readTeams(home)).toEqual({
      abcdef012345: {
        id: 'abcdef012345',
        project: 'acme',
        projectId: null,
        entity: null,
        session: 'acme',
        root: '/work/acme',
        lobby: '/home/lobby',
        lobbies: { acme: '/home/lobby' },
        roster,
        lifecycle: 'defined',
        provenance: { registered_by: 'owner', registered_at: AT, updated_at: AT },
      },
    });
  });

  test('an ID of digits only, and text a plain scalar would misread, survive a round trip', () => {
    upsertTeam(home, '123456789012', { project: 'true', session: '1e5', root: '/work/with space: and # hash', lobby: '"quoted"', by: 'a: b', at: AT });
    const read = getTeam(home, '123456789012');
    expect(read).toMatchObject({ project: 'true', session: '1e5', root: '/work/with space: and # hash', lobby: '"quoted"' });
    expect(read?.provenance.registered_by).toBe('a: b');
  });

  test('teams are written in ID order, whatever order they were registered in', () => {
    upsertTeam(home, 'bbbbbbbbbbbb', { ...seed, at: AT });
    upsertTeam(home, 'aaaaaaaaaaaa', { ...seed, project: 'zeta', at: AT });
    expect(Object.keys(readTeams(home))).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    expect(readFileSync(teamsFile(home), 'utf8').indexOf('aaaaaaaaaaaa')).toBeLessThan(readFileSync(teamsFile(home), 'utf8').indexOf('bbbbbbbbbbbb'));
  });

  test('a write leaves no temp or lock file beside the registry', () => {
    upsertTeam(home, 'abcdef012345', { ...seed, at: AT });
    setTeamLifecycle(home, 'abcdef012345', 'running');
    const names = readdirOf(join(home, '.config', 'team'));
    expect(names).toEqual(['teams.yaml']);
  });

  test('a file that does not read as a registry is named in the error and never replaced', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    const broken = 'teams:\n  abc:\n    project: acme\n    lifecycle: flying\n';
    writeFileSync(teamsFile(home), broken);
    expect(() => readTeams(home)).toThrow(TeamsError);
    expect(() => readTeams(home)).toThrow(/team abc: "lifecycle" must be one of defined, running, stopped, archived/);
    expect(() => upsertTeam(home, 'def', { ...seed })).toThrow(TeamsError);
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(broken);
  });

  test('a file that is not YAML names its line', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(teamsFile(home), 'teams:\n\tbad: 1\n');
    expect(() => readTeams(home)).toThrow(/teams\.yaml: line 2:/);
  });

  test('a stale lock left by a dead run does not block a write', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    const lock = `${teamsFile(home)}.lock`;
    writeFileSync(lock, '999999\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    upsertTeam(home, 'abcdef012345', { ...seed, at: AT });
    expect(getTeam(home, 'abcdef012345')?.project).toBe('acme');
    expect(existsSync(lock)).toBe(false);
  });
});

describe('upsertTeam', () => {
  test('a new team needs a project, a session and a root', () => {
    expect(() => upsertTeam(home, 'abcdef012345', { session: 's', root: '/r' })).toThrow('a new team needs a project');
    expect(() => upsertTeam(home, 'abcdef012345', { project: 'p', root: '/r' })).toThrow('a new team needs a session');
    expect(() => upsertTeam(home, 'abcdef012345', { project: 'p', session: 's' })).toThrow('a new team needs a root');
    expect(existsSync(teamsFile(home))).toBe(false);
  });

  test('a new team starts defined, with an empty roster, and records who registered it and when', () => {
    const record = upsertTeam(home, 'abcdef012345', { ...seed, by: 'owner', at: AT });
    expect(record).toMatchObject({ id: 'abcdef012345', lifecycle: 'defined', roster: [], entity: null, provenance: { registered_by: 'owner', registered_at: AT, updated_at: AT } });
  });

  test('an update changes the fields it names and nothing else, and moves only updated_at', () => {
    const roster = [{ agent: 'agt_0123456789ab', seat: 'builder-1', role: 'builder' }];
    upsertTeam(home, 'abcdef012345', { ...seed, roster, lifecycle: 'running', by: 'owner', at: AT });
    const later = '2026-10-17T08:00:00.000Z';
    const updated = upsertTeam(home, 'abcdef012345', { session: 'renamed', by: 'someone else', at: later });
    expect(updated).toMatchObject({
      project: 'acme',
      session: 'renamed',
      roster,
      lifecycle: 'running',
      provenance: { registered_by: 'owner', registered_at: AT, updated_at: later },
    });
    expect(readTeams(home).abcdef012345).toEqual({ ...updated, id: 'abcdef012345' });
  });

  test('an undefined field in a patch is not a change', () => {
    upsertTeam(home, 'abcdef012345', { ...seed, lifecycle: 'running', at: AT });
    upsertTeam(home, 'abcdef012345', { lifecycle: undefined, entity: undefined, at: AT });
    expect(getTeam(home, 'abcdef012345')?.lifecycle).toBe('running');
  });

  test('another team in the file is left as it was', () => {
    upsertTeam(home, 'aaaaaaaaaaaa', { ...seed, project: 'one', at: AT });
    const before = readTeams(home).aaaaaaaaaaaa;
    upsertTeam(home, 'bbbbbbbbbbbb', { ...seed, project: 'two', at: AT });
    setTeamLifecycle(home, 'bbbbbbbbbbbb', 'stopped');
    expect(readTeams(home).aaaaaaaaaaaa).toEqual(before);
  });

  test('a lifecycle outside the four states is refused and the file stays as it was', () => {
    upsertTeam(home, 'abcdef012345', { ...seed, at: AT });
    const before = readFileSync(teamsFile(home), 'utf8');
    expect(() => upsertTeam(home, 'abcdef012345', { lifecycle: 'retired' as never })).toThrow('"retired" is not a team lifecycle');
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
  });
});

describe('a team record points to its project by id', () => {
  test('a team registered into a project keeps the id, and a team with none reads null — its own project', () => {
    upsertTeam(home, 'abcdef012345', { ...seed, projectId: 'teamcli', at: AT });
    upsertTeam(home, 'fedcba987654', { ...seed, at: AT });
    expect(getTeam(home, 'abcdef012345')?.projectId).toBe('teamcli');
    expect(getTeam(home, 'fedcba987654')?.projectId).toBeNull();
  });

  test('the pointer is written, moves on an update, and can be cleared', () => {
    upsertTeam(home, 'abcdef012345', { ...seed, projectId: 'teamcli', at: AT });
    expect(readFileSync(teamsFile(home), 'utf8')).toContain('    project_id: teamcli');
    expect(upsertTeam(home, 'abcdef012345', { projectId: 'site', at: AT }).projectId).toBe('site');
    expect(upsertTeam(home, 'abcdef012345', { projectId: null, at: AT }).projectId).toBeNull();
  });

  test('a pointer of the wrong kind is refused and the file stays as it was', () => {
    upsertTeam(home, 'abcdef012345', { ...seed, at: AT });
    const before = readFileSync(teamsFile(home), 'utf8');
    expect(() => upsertTeam(home, 'abcdef012345', { projectId: 7 } as never)).toThrow('"project_id" must be a project ID or null');
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
  });

  test('a registry written before the project level reads, every team its own project', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(
      teamsFile(home),
      [
        'teams:',
        '  abcdef012345:',
        '    project: acme',
        '    entity: null',
        '    session: acme',
        '    root: /work/acme',
        '    lobby: /home/lobby',
        '    roster: []',
        '    lifecycle: running',
        `    provenance: { registered_by: owner, registered_at: "${AT}", updated_at: "${AT}" }`,
        '',
      ].join('\n'),
    );
    expect(getTeam(home, 'abcdef012345')).toMatchObject({ project: 'acme', projectId: null });
  });

  test('a project_id that is neither text nor null names the file and the team', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(teamsFile(home), 'teams:\n  abcdef012345:\n    project: acme\n    lifecycle: running\n    project_id: 7\n');
    expect(() => readTeams(home)).toThrow(/"project_id" must be a project ID or null/);
  });
});

describe('setRoster and setTeamLifecycle', () => {
  test('set the roster, replacing it whole', () => {
    upsertTeam(home, 'abcdef012345', { ...seed, at: AT });
    setRoster(home, 'abcdef012345', [{ agent: 'agt_000000000001', seat: 'a', role: 'builder' }]);
    const next = [{ agent: 'agt_000000000002', seat: 'b', role: 'tester', leads: true }];
    expect(setRoster(home, 'abcdef012345', next).roster).toEqual(next);
    expect(getTeam(home, 'abcdef012345')?.roster).toEqual(next);
  });

  test('move a team through every lifecycle state', () => {
    upsertTeam(home, 'abcdef012345', { ...seed, at: AT });
    for (const state of ['running', 'stopped', 'archived', 'defined'] as const) {
      expect(setTeamLifecycle(home, 'abcdef012345', state).lifecycle).toBe(state);
      expect(getTeam(home, 'abcdef012345')?.lifecycle).toBe(state);
    }
  });

  test('refuse a team that is not registered, and write nothing', () => {
    expect(() => setRoster(home, 'abcdef012345', [])).toThrow('no team abcdef012345 in the registry');
    expect(() => setTeamLifecycle(home, 'abcdef012345', 'running')).toThrow('no team abcdef012345 in the registry');
    expect(existsSync(teamsFile(home))).toBe(false);
  });
});

describe('the roster line carries the lead capability', () => {
  test('the seat that leads is written and read back whole', () => {
    upsertTeam(home, 'abcdef012345', {
      ...seed,
      at: AT,
      roster: [
        { agent: 'agt_0123456789ab', seat: 'lead', role: 'builder', leads: true },
        { agent: 'agt_ba9876543210', seat: 'worker', role: 'builder' },
      ],
    });
    const text = readFileSync(teamsFile(home), 'utf8');
    expect(text).toContain('      - { agent: agt_0123456789ab, seat: lead, role: builder, leads: true }');
    expect(text).toContain('      - { agent: agt_ba9876543210, seat: worker, role: builder }');
    expect(getTeam(home, 'abcdef012345')?.roster.map((entry) => entry.leads)).toEqual([true, undefined]);
  });

  test('a line written before the field existed reads as before: not known to lead', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(
      teamsFile(home),
      'teams:\n  abcdef012345:\n    project: acme\n    lifecycle: running\n    session: acme\n    root: /work/acme\n    roster:\n      - { agent: agt_0123456789ab, seat: lead, role: builder }\n    provenance: { registered_by: owner, registered_at: "2026-10-16T12:00:00.000Z", updated_at: "2026-10-16T12:00:00.000Z" }\n',
    );
    expect(getTeam(home, 'abcdef012345')?.roster).toEqual([
      { agent: 'agt_0123456789ab', seat: 'lead', role: 'builder' },
    ]);
  });

  test('a leads of the wrong kind names the line', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(
      teamsFile(home),
      'teams:\n  abcdef012345:\n    project: acme\n    lifecycle: running\n    roster:\n      - { agent: agt_0123456789ab, seat: lead, role: builder, leads: 1 }\n    provenance: { registered_by: owner, registered_at: "2026-10-16T12:00:00.000Z", updated_at: "2026-10-16T12:00:00.000Z" }\n',
    );
    expect(() => readTeams(home)).toThrow(/roster line 1: "leads" must be true or false/);
  });
});

describe('the roster line carries the assistant capability', () => {
  test('the seat that assists is written and read back whole, beside the lead', () => {
    upsertTeam(home, 'abcdef012345', {
      ...seed,
      at: AT,
      roster: [
        { agent: 'agt_0123456789ab', seat: 'lead', role: 'builder', leads: true },
        { agent: 'agt_ba9876543210', seat: 'assistant', role: 'builder', assistant: true },
        { agent: 'agt_000000000001', seat: 'worker', role: 'builder' },
      ],
    });
    const text = readFileSync(teamsFile(home), 'utf8');
    expect(text).toContain('      - { agent: agt_ba9876543210, seat: assistant, role: builder, assistant: true }');
    expect(text).toContain('      - { agent: agt_0123456789ab, seat: lead, role: builder, leads: true }');
    expect(getTeam(home, 'abcdef012345')?.roster.map((entry) => entry.assistant)).toEqual([undefined, true, undefined]);
  });

  test('a line written before the field existed reads as before: not the assistant', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(
      teamsFile(home),
      'teams:\n  abcdef012345:\n    project: acme\n    lifecycle: running\n    session: acme\n    root: /work/acme\n    roster:\n      - { agent: agt_0123456789ab, seat: assistant, role: builder }\n    provenance: { registered_by: owner, registered_at: "2026-10-16T12:00:00.000Z", updated_at: "2026-10-16T12:00:00.000Z" }\n',
    );
    expect(getTeam(home, 'abcdef012345')?.roster).toEqual([
      { agent: 'agt_0123456789ab', seat: 'assistant', role: 'builder' },
    ]);
  });

  test('an assistant of the wrong kind names the line', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(
      teamsFile(home),
      'teams:\n  abcdef012345:\n    project: acme\n    lifecycle: running\n    roster:\n      - { agent: agt_0123456789ab, seat: assistant, role: builder, assistant: 1 }\n    provenance: { registered_by: owner, registered_at: "2026-10-16T12:00:00.000Z", updated_at: "2026-10-16T12:00:00.000Z" }\n',
    );
    expect(() => readTeams(home)).toThrow(/roster line 1: "assistant" must be true or false/);
  });
});

describe('findTeam', () => {
  beforeEach(() => {
    upsertTeam(home, 'aaaaaaaaaaaa', { project: 'acme', session: 'acme-main', root: '/r/1', at: AT });
    upsertTeam(home, 'bbbbbbbbbbbb', { project: 'acme', session: 'acme-docs', root: '/r/2', at: AT });
    upsertTeam(home, 'cccccccccccc', { project: 'solo', session: 'solo', root: '/r/3', at: AT });
  });

  test('finds a team by its ID', () => {
    expect(findTeam(home, 'bbbbbbbbbbbb')?.root).toBe('/r/2');
  });

  test('finds a team by its session, and by its project when only one has it', () => {
    expect(findTeam(home, 'acme-docs')?.root).toBe('/r/2');
    expect(findTeam(home, 'solo')?.root).toBe('/r/3');
  });

  test('a project two teams share names no team, and findTeams lists both', () => {
    expect(findTeam(home, 'acme')).toBeNull();
    expect(findTeams(home, 'acme').map((team) => team.id)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  });

  test('a team whose project and session are the same word is one team, not two', () => {
    expect(findTeams(home, 'solo')).toHaveLength(1);
  });

  test('an ID wins over a project or session of the same spelling', () => {
    upsertTeam(home, 'dddddddddddd', { project: 'aaaaaaaaaaaa', session: 'x', root: '/r/4', at: AT });
    expect(findTeam(home, 'aaaaaaaaaaaa')?.root).toBe('/r/1');
  });

  test('a key no team has finds nothing', () => {
    expect(findTeam(home, 'nope')).toBeNull();
    expect(findTeams(home, 'nope')).toEqual([]);
  });
});

describe('noteTeam', () => {
  test('registers a team by its real root, with its lobby worked out from the file', () => {
    const root = join(base, 'acme');
    mkdirSync(root);
    expect(noteTeam(home, root, { project: 'acme', entity: 'Acme', session: 'acme', lobby: null }, 'defined', 'owner')).toBeNull();
    expect(readTeams(home)[teamIdOf(root)]).toMatchObject({
      project: 'acme',
      entity: 'Acme',
      session: 'acme',
      root,
      lobby: join(home, '.config', 'team', 'lobbies', 'acme'),
      lifecycle: 'defined',
      roster: [],
    });
  });

  test('keeps the roster and the registration when it records the team again', () => {
    const root = join(base, 'acme');
    mkdirSync(root);
    const the = { project: 'acme', entity: null, session: 'acme', lobby: null };
    noteTeam(home, root, the, 'defined', 'owner');
    const roster = [{ agent: 'agt_0123456789ab', seat: 'a', role: 'builder', leads: true }];
    setRoster(home, teamIdOf(root), roster);
    noteTeam(home, root, the, 'stopped', 'someone else');
    expect(getTeam(home, teamIdOf(root))).toMatchObject({ roster, lifecycle: 'stopped', provenance: { registered_by: 'owner' } });
  });

  test('says what went wrong instead of throwing when the registry cannot be written', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(teamsFile(home), 'teams: [1]\n');
    const said = noteTeam(home, base, { project: 'p', entity: null, session: 's', lobby: null }, 'defined', 'owner');
    expect(said).toMatch(/^the team registry was not updated: .*"teams" must be a map/);
  });
});

describe('noteTeam and the project level', () => {
  const cli = () => join(base, 'cli');
  const site = () => join(base, 'site');
  const seedOf = (inProject?: string | null) => ({ project: 'acme', entity: 'Acme', session: 'acme', lobby: null, inProject });

  beforeEach(() => {
    mkdirSync(cli(), { recursive: true });
    mkdirSync(site(), { recursive: true });
  });

  test('a file that names a project joins it, and the record is made with the name written and the team', () => {
    expect(noteTeam(home, cli(), seedOf('TeamCLI'), 'defined', 'owner')).toBeNull();
    const teamId = teamIdOf(cli());
    expect(getTeam(home, teamId)?.projectId).toBe('teamcli');
    expect(getProject(home, 'teamcli')).toMatchObject({ name: 'TeamCLI', entity: 'Acme', lead: null, teams: [teamId] });
  });

  test('the second team joins the first project, not a second record', () => {
    noteTeam(home, cli(), seedOf('TeamCLI'), 'defined', 'owner');
    noteTeam(home, site(), seedOf('TeamCLI'), 'defined', 'owner');
    expect(listProjects(home)).toHaveLength(1);
    expect(getProject(home, 'teamcli')?.teams).toEqual([teamIdOf(cli()), teamIdOf(site())]);
  });

  test('a team moved to another project leaves the one that named it', () => {
    noteTeam(home, cli(), seedOf('TeamCLI'), 'defined', 'owner');
    noteTeam(home, cli(), seedOf('Site'), 'defined', 'owner');
    expect(getProject(home, 'teamcli')?.teams).toEqual([]);
    expect(getProject(home, 'site')?.teams).toEqual([teamIdOf(cli())]);
    expect(getTeam(home, teamIdOf(cli()))?.projectId).toBe('site');
  });

  test('a file that stops naming a project leaves it, and reads as its own project', () => {
    noteTeam(home, cli(), seedOf('TeamCLI'), 'defined', 'owner');
    noteTeam(home, cli(), seedOf(null), 'defined', 'owner');
    expect(getTeam(home, teamIdOf(cli()))?.projectId).toBeNull();
    expect(getProject(home, 'teamcli')?.teams).toEqual([]);
  });

  test('a seed that names no project at all leaves the pointer as it is', () => {
    noteTeam(home, cli(), seedOf('TeamCLI'), 'defined', 'owner');
    noteTeam(home, cli(), seedOf(), 'defined', 'owner');
    expect(getTeam(home, teamIdOf(cli()))?.projectId).toBe('teamcli');
    expect(getProject(home, 'teamcli')?.teams).toEqual([teamIdOf(cli())]);
  });

  test('a project registry that cannot be written is its own line, and the team record is still written', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(projectsFile(home), 'projects: [1]\n');
    const said = noteTeam(home, cli(), seedOf('TeamCLI'), 'defined', 'owner');
    expect(said).toMatch(/^the project registry was not updated: .*"projects" must be a map/);
    expect(getTeam(home, teamIdOf(cli()))?.projectId).toBe('teamcli');
  });

  test('a project name with nothing to keep is a line, and nothing is written at all', () => {
    const said = noteTeam(home, cli(), seedOf('***'), 'defined', 'owner');
    expect(said).toMatch(/^the project registry was not updated: "\*\*\*" is not a project name/);
    expect(getTeam(home, teamIdOf(cli()))).toBeNull();
    expect(existsSync(projectsFile(home))).toBe(false);
  });
});

function readdirOf(dir: string): string[] {
  return readdirSync(dir).sort();
}

describe('team init registers the team', () => {
  let project: string;
  const noLogin = { loggedIn: () => false };

  beforeEach(() => {
    project = join(base, 'acme');
    mkdirSync(project);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env: gitEnv(), stdio: 'ignore' });
  });

  test('with the lifecycle defined, under the ID of its real root', async () => {
    const io = testIo(project, owner);
    expect(await runInit([], io, home, undefined, { ...noLogin, now: () => NOW })).toBe(0);
    const record = getTeam(home, teamIdOf(project));
    expect(record).toMatchObject({
      project: 'acme',
      entity: null,
      session: 'acme',
      root: project,
      lobby: join(home, '.config', 'team', 'lobby'),
      lifecycle: 'defined',
      roster: [],
    });
    expect(record?.provenance.registered_by).toBe('owner');
    expect(io.err).toBe('');
  });

  test('a refused init registers nothing', async () => {
    const io = testIo(project, { kind: 'seat', name: 'builder-1' } as never);
    expect(await runInit([], io, home, undefined, noLogin)).toBe(1);
    expect(existsSync(teamsFile(home))).toBe(false);
  });

  test('an init that finds the file already there registers nothing', async () => {
    expect(await runInit([], testIo(project, owner), home, undefined, noLogin)).toBe(0);
    rmSync(teamsFile(home));
    expect(await runInit([], testIo(project, owner), home, undefined, noLogin)).toBe(1);
    expect(existsSync(teamsFile(home))).toBe(false);
  });

  test('a caller that names no home leaves the registry alone', async () => {
    expect(await runInit([], testIo(project, owner), undefined, undefined, noLogin)).toBe(0);
    expect(existsSync(teamsFile(home))).toBe(false);
  });

  test('a registry that cannot be read is a stderr line and the init still succeeds', async () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(teamsFile(home), 'teams: [1]\n');
    const io = testIo(project, owner);
    expect(await runInit([], io, home, undefined, noLogin)).toBe(0);
    expect(io.err).toMatch(/^team init: the team registry was not updated: /);
    expect(existsSync(join(project, '.agents', 'team.yaml'))).toBe(true);
    expect(readFileSync(teamsFile(home), 'utf8')).toBe('teams: [1]\n');
  });
});

describe('team down sets the lifecycle stopped', () => {
  let project: string;

  function teamYaml(root: string): string {
    return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  }

  function sources(opts: { running: boolean; home?: string; held?: boolean }): DownSources {
    return {
      sessionRunning: () => opts.running,
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => '',
      status: () => 'idle',
      foreground: () => [],
      now: () => NOW,
      sleep: async () => {},
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      launch: {
        typeText: () => true,
        sendKey: () => true,
        pressEnter: () => true,
        agentPanes: () => [],
        closeWorkspace: () => true,
        stopSession: () => true,
        deleteSession: () => true,
        kill: () => true,
        sleep: async () => {},
        now: () => NOW,
      },
    };
  }

  beforeEach(() => {
    project = join(base, 'acme');
    mkdirSync(join(project, '.agents'), { recursive: true });
    writeFileSync(join(project, '.agents', 'team.yaml'), teamYaml(project));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env: gitEnv(), stdio: 'ignore' });
  });

  test('a stop that finished moves a running team to stopped', async () => {
    upsertTeam(home, teamIdOf(project), { project: 'acme', session: 'acme', root: project, lifecycle: 'running', by: 'owner', at: AT });
    const io = testIo(project, owner);
    expect(await runDown([], io, sources({ running: true, home }))).toBe(0);
    expect(getTeam(home, teamIdOf(project))).toMatchObject({ lifecycle: 'stopped', provenance: { registered_at: AT } });
    expect(io.err).toBe('');
  });

  test('a team not yet registered is registered, stopped', async () => {
    expect(await runDown([], testIo(project, owner), sources({ running: true, home }))).toBe(0);
    expect(getTeam(home, teamIdOf(project))).toMatchObject({ project: 'acme', session: 'acme', root: project, lifecycle: 'stopped' });
  });

  test('a session that was not running is a stopped team too', async () => {
    upsertTeam(home, teamIdOf(project), { project: 'acme', session: 'acme', root: project, lifecycle: 'running', at: AT });
    const io = testIo(project, owner);
    expect(await runDown([], io, sources({ running: false, home }))).toBe(0);
    expect(io.out).toContain('is not running: nothing to stop');
    expect(getTeam(home, teamIdOf(project))?.lifecycle).toBe('stopped');
  });

  test('a dry run changes nothing', async () => {
    upsertTeam(home, teamIdOf(project), { project: 'acme', session: 'acme', root: project, lifecycle: 'running', at: AT });
    const before = readFileSync(teamsFile(home), 'utf8');
    expect(await runDown(['--dry-run'], testIo(project, owner), sources({ running: true, home }))).toBe(0);
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
  });

  test('a refused caller changes nothing', async () => {
    upsertTeam(home, teamIdOf(project), { project: 'acme', session: 'acme', root: project, lifecycle: 'running', at: AT });
    const before = readFileSync(teamsFile(home), 'utf8');
    const io = testIo(project, { kind: 'unplaced', reason: 'it runs under herdr' });
    expect(await runDown([], io, sources({ running: true, home }))).toBe(1);
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
  });

  test('a stop of another session than the team file names changes nothing', async () => {
    upsertTeam(home, teamIdOf(project), { project: 'acme', session: 'acme', root: project, lifecycle: 'running', at: AT });
    const before = readFileSync(teamsFile(home), 'utf8');
    expect(await runDown(['--session', 'elsewhere'], testIo(project, owner), sources({ running: true, home }))).toBe(0);
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
  });

  test('a run given no home leaves the registry alone', async () => {
    expect(await runDown([], testIo(project, owner), sources({ running: true }))).toBe(0);
    expect(existsSync(teamsFile(home))).toBe(false);
  });
});

describe('a team record names its issue tracker', () => {
  const id = 'abcdef012345';
  const linear = { type: 'linear', project: 'Team CLI', team: 'FLO' };
  const github = { type: 'github', project: 'acme/widgets', url: 'https://github.com/acme/widgets' };
  const custom = { type: 'youtrack-cloud', project: 'Platform: core, v2' };

  /** A registry as an older build wrote it: no `issue_tracker` anywhere. */
  const OLD_FILE = [
    'teams:',
    `  ${id}:`,
    '    project: acme',
    '    project_id: null',
    '    entity: null',
    '    session: acme',
    '    root: /work/acme',
    '    lobby: /home/lobby',
    '    roster: []',
    '    lifecycle: running',
    `    provenance: { registered_by: owner, registered_at: "${AT}", updated_at: "${AT}" }`,
    '',
  ].join('\n');

  function writeRaw(tracker: string): void {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(teamsFile(home), OLD_FILE.replace('    lifecycle: running\n', `    lifecycle: running\n    issue_tracker: ${tracker}\n`));
  }

  test('a Linear project, with its team key, is written in the documented shape and reads back whole', () => {
    upsertTeam(home, id, { ...seed, lobby: '/home/lobby', issueTracker: linear, by: 'owner', at: AT });
    expect(readFileSync(teamsFile(home), 'utf8')).toContain('    lifecycle: defined\n    issue_tracker: { type: linear, project: "Team CLI", team: FLO }\n    provenance:');
    expect(getTeam(home, id)?.issueTracker).toEqual(linear);
  });

  test('a GitHub repository, with its link, reads back whole', () => {
    upsertTeam(home, id, { ...seed, issueTracker: github, at: AT });
    expect(getTeam(home, id)?.issueTracker).toEqual(github);
    expect(readFileSync(teamsFile(home), 'utf8')).toContain('issue_tracker: { type: github, project: acme/widgets, url: "https://github.com/acme/widgets" }');
  });

  test('a type nobody listed is valid and kept as written, and text a plain scalar would misread survives', () => {
    upsertTeam(home, id, { ...seed, issueTracker: custom, at: AT });
    expect(getTeam(home, id)?.issueTracker).toEqual(custom);
  });

  test('a value read from the file by hand reads back the same as one written by the module', () => {
    writeRaw('{ type: linear, project: "Team CLI", team: FLO }');
    expect(getTeam(home, id)?.issueTracker).toEqual(linear);
    writeRaw('\n      type: github\n      project: acme/widgets');
    expect(getTeam(home, id)?.issueTracker).toEqual({ type: 'github', project: 'acme/widgets' });
  });

  test.each([
    ['an uppercase word', 'Linear'],
    ['a word that starts with a digit', '1tracker'],
    ['a word with an underscore', 'my_tracker'],
    ['an empty word', ''],
    ['a word of 33 characters', 'a'.repeat(33)],
    ['a word with a space', 'my tracker'],
  ])('a type that is %s is refused and the file stays as it was', (_what, type) => {
    upsertTeam(home, id, { ...seed, at: AT });
    const before = readFileSync(teamsFile(home), 'utf8');
    expect(() => upsertTeam(home, id, { issueTracker: { type, project: 'p' } })).toThrow(/"issue_tracker\.type" must be a lowercase word/);
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
  });

  test('a type of 32 characters is the longest', () => {
    upsertTeam(home, id, { ...seed, issueTracker: { type: `t${'a'.repeat(31)}`, project: 'p' }, at: AT });
    expect(getTeam(home, id)?.issueTracker?.type).toHaveLength(32);
  });

  test.each([
    ['an empty project', { type: 'linear', project: '' }, /"issue_tracker\.project" must be text, and is required/],
    ['a project over the cap', { type: 'linear', project: 'p'.repeat(ISSUE_TRACKER_LIMITS.project + 1) }, /"issue_tracker\.project" is longer than 200 characters/],
    ['a project with a line break', { type: 'linear', project: 'Team\nCLI' }, /"issue_tracker\.project" must not hold control characters/],
    ['a project with a tab', { type: 'linear', project: 'Team\tCLI' }, /must not hold control characters/],
    ['a project with spaces at the end', { type: 'linear', project: 'Team CLI ' }, /must not start or end with whitespace/],
    ['a project that is a token', { type: 'github', project: 'ghp_0123456789abcdefghij' }, /looks like a credential/],
    ['a team key over the cap', { type: 'linear', project: 'p', team: 'T'.repeat(ISSUE_TRACKER_LIMITS.team + 1) }, /"issue_tracker\.team" is longer than 64 characters/],
    ['an empty team key', { type: 'linear', project: 'p', team: '' }, /"issue_tracker\.team" must be non-empty text/],
    ['a url with credentials', { type: 'github', project: 'p', url: 'https://user:secret@github.com/acme/widgets' }, /must not carry credentials/],
    ['a url with a query', { type: 'github', project: 'p', url: 'https://github.com/acme/widgets?token=abc' }, /must not carry a query or a fragment/],
    ['a url that is not http', { type: 'github', project: 'p', url: 'ftp://example.com/x' }, /must be an http or https URL/],
    ['a url that is not absolute', { type: 'github', project: 'p', url: 'acme/widgets' }, /must be an absolute http or https URL/],
    ['a url with a space', { type: 'github', project: 'p', url: 'https://example.com/a b' }, /must not hold whitespace/],
    ['a url over the cap', { type: 'github', project: 'p', url: `https://example.com/${'a'.repeat(ISSUE_TRACKER_LIMITS.url)}` }, /"issue_tracker\.url" is longer than 512 characters/],
    ['a key it does not take', { type: 'linear', project: 'p', token: 'x' }, /"issue_tracker" has no key "token"/],
  ])('%s is refused and the file stays as it was', (_what, tracker, message) => {
    upsertTeam(home, id, { ...seed, at: AT });
    const before = readFileSync(teamsFile(home), 'utf8');
    expect(() => upsertTeam(home, id, { issueTracker: tracker as never })).toThrow(message);
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
  });

  test('a project of 200 characters is the longest', () => {
    const project = 'p'.repeat(ISSUE_TRACKER_LIMITS.project);
    upsertTeam(home, id, { ...seed, issueTracker: { type: 'linear', project }, at: AT });
    expect(getTeam(home, id)?.issueTracker?.project).toBe(project);
  });

  test('a record on file that does not read as a tracker names the file, the team and the key, and is never replaced', () => {
    for (const [tracker, message] of [
      ['linear', /team abcdef012345: "issue_tracker" must be a map/],
      ['{ type: Linear, project: p }', /team abcdef012345: "issue_tracker\.type" must be a lowercase word/],
      ['{ type: linear }', /"issue_tracker\.project" must be text, and is required/],
      ['{ type: linear, project: p, owner: x }', /"issue_tracker" has no key "owner"/],
      ['{ type: linear, project: 7 }', /"issue_tracker\.project" must be text/],
    ] as const) {
      writeRaw(tracker);
      const before = readFileSync(teamsFile(home), 'utf8');
      expect(() => readTeams(home)).toThrow(TeamsError);
      expect(() => readTeams(home)).toThrow(message);
      expect(() => upsertTeam(home, 'def', { ...seed })).toThrow(TeamsError);
      expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
    }
  });

  test('a team that names none reads as before: no field, and a rewrite leaves the file byte for byte', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(teamsFile(home), OLD_FILE);
    const read = getTeam(home, id);
    expect(read).not.toBeNull();
    expect(read).not.toHaveProperty('issueTracker');
    // A write that changes nothing but the lifecycle it already holds moves only updated_at.
    const later = '2026-10-17T08:00:00.000Z';
    upsertTeam(home, id, { lifecycle: 'running', at: later });
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(OLD_FILE.replace(`updated_at: "${AT}"`, `updated_at: "${later}"`));
    expect(readFileSync(teamsFile(home), 'utf8')).not.toContain('issue_tracker');
  });

  test('a new team with no tracker is written without one, and the field is never null or empty', () => {
    upsertTeam(home, id, { ...seed, at: AT });
    expect(readFileSync(teamsFile(home), 'utf8')).not.toContain('issue_tracker');
    expect(getTeam(home, id)).not.toHaveProperty('issueTracker');
  });

  test('every writer that rewrites the record keeps the field exactly as it was', () => {
    const root = join(base, 'acme');
    mkdirSync(root);
    const teamId = teamIdOf(root);
    const the = { project: 'acme', entity: null, session: 'acme', lobby: null };
    noteTeam(home, root, the, 'defined', 'owner');
    upsertTeam(home, teamId, { issueTracker: linear });
    const tracker = () => getTeam(home, teamId)?.issueTracker;
    expect(tracker()).toEqual(linear);
    setRoster(home, teamId, [{ agent: 'agt_0123456789ab', seat: 'a', role: 'builder', leads: true }]);
    expect(tracker()).toEqual(linear);
    setTeamLifecycle(home, teamId, 'stopped');
    expect(tracker()).toEqual(linear);
    // The `up`, `init` and `down` paths all record the team through noteTeam.
    expect(noteTeam(home, root, the, 'running', 'someone else')).toBeNull();
    expect(tracker()).toEqual(linear);
    expect(noteTeam(home, root, { ...the, inProject: 'Acme Suite' }, 'stopped', 'someone else')).toBeNull();
    expect(tracker()).toEqual(linear);
    upsertTeam(home, teamId, { settingsDelta: { 'some.key': 'value' }, by: 'owner' });
    expect(tracker()).toEqual(linear);
    upsertTeam(home, teamId, { session: 'renamed', lifecycle: 'archived' });
    expect(tracker()).toEqual(linear);
    // A second team's writes never touch it either.
    upsertTeam(home, 'bbbbbbbbbbbb', { ...seed, project: 'other', issueTracker: github, at: AT });
    expect(tracker()).toEqual(linear);
    expect(getTeam(home, 'bbbbbbbbbbbb')?.issueTracker).toEqual(github);
    // And the file reads back to the same record after all of it.
    const before = readTeams(home);
    upsertTeam(home, teamId, {});
    expect(readTeams(home)[teamId]?.issueTracker).toEqual(before[teamId]?.issueTracker);
  });

  test('a patch with a tracker replaces it whole, and null removes it', () => {
    upsertTeam(home, id, { ...seed, issueTracker: linear, at: AT });
    upsertTeam(home, id, { issueTracker: { type: 'github', project: 'acme/widgets' } });
    expect(getTeam(home, id)?.issueTracker).toEqual({ type: 'github', project: 'acme/widgets' });
    const set = upsertTeam(home, id, { issueTracker: null });
    expect(set).not.toHaveProperty('issueTracker');
    expect(readFileSync(teamsFile(home), 'utf8')).not.toContain('issue_tracker');
    expect(getTeam(home, id)).not.toHaveProperty('issueTracker');
  });

  test('only the known keys are kept: a value is written in a fixed key order whatever order it came in', () => {
    upsertTeam(home, id, { ...seed, issueTracker: { url: 'https://example.com/p', team: 'T', project: 'p', type: 'x' }, at: AT });
    expect(readFileSync(teamsFile(home), 'utf8')).toContain('issue_tracker: { type: x, project: p, team: T, url: "https://example.com/p" }');
  });

  test('a record with a tracker differs from one without only in that field', () => {
    upsertTeam(home, id, { ...seed, lobby: '/home/lobby', issueTracker: linear, by: 'owner', at: AT });
    const { issueTracker: _tracker, ...rest } = getTeam(home, id) as NonNullable<ReturnType<typeof getTeam>>;
    mkdirSync(join(base, 'plain'), { recursive: true });
    const plain = join(base, 'plain');
    upsertTeam(plain, id, { ...seed, lobby: '/home/lobby', by: 'owner', at: AT });
    expect(getTeam(plain, id)).toEqual(rest);
  });
});
