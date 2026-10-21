// The project registry: `~/.config/team/projects.yaml`. The record between the entity and the
// teams — a project groups teams under one lead, by agent ID, and a team no project names is its
// own project. This file grows with src/registry/projects.ts: the reads first, the writes next.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { byName, get, list, ofTeam, projectIdOf, projectsFile, ProjectsError, readProjects, upsertProject } from '../../src/registry/projects.ts';

const AT = '2026-10-17T00:30:00.000Z';

let base: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-registry-projects-')));
  home = join(base, 'home');
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function writeProjects(text: string): void {
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(projectsFile(home), text);
}

/** The first case: project TeamCLI, its two teams, and a lone project that names no entity. */
function twoProjects(): string {
  const prov = `{ registered_by: owner, registered_at: "${AT}", updated_at: "${AT}" }`;
  return [
    'projects:',
    '  site:',
    '    name: TeamCLI.io',
    '    entity: null',
    '    lead: null',
    '    teams: [site-id]',
    `    provenance: ${prov}`,
    '  teamcli:',
    '    name: TeamCLI',
    '    entity: TeamCLI',
    '    lead: agt_0123456789ab',
    '    teams: [cli-id, shared-id]',
    `    provenance: ${prov}`,
    '',
  ].join('\n');
}

describe('the project registry file', () => {
  test('lives at <home>/.config/team/projects.yaml, beside teams.yaml', () => {
    expect(projectsFile('/h')).toBe('/h/.config/team/projects.yaml');
  });

  test('no file is no projects, and reading writes nothing', () => {
    expect(readProjects(home)).toEqual({});
    expect(list(home)).toEqual([]);
    expect(get(home, 'teamcli')).toBeNull();
    expect(byName(home, 'TeamCLI')).toBeNull();
    expect(ofTeam(home, 'cli-id')).toBeNull();
    expect(existsSync(projectsFile(home))).toBe(false);
  });

  test('an empty file is no projects', () => {
    writeProjects('');
    expect(readProjects(home)).toEqual({});
  });

  test('what the file holds reads back whole, the ID filled from the key', () => {
    writeProjects(twoProjects());
    expect(readProjects(home)).toEqual({
      site: {
        id: 'site',
        name: 'TeamCLI.io',
        entity: null,
        lead: null,
        teams: ['site-id'],
        provenance: { registered_by: 'owner', registered_at: AT, updated_at: AT },
      },
      teamcli: {
        id: 'teamcli',
        name: 'TeamCLI',
        entity: 'TeamCLI',
        lead: 'agt_0123456789ab',
        teams: ['cli-id', 'shared-id'],
        provenance: { registered_by: 'owner', registered_at: AT, updated_at: AT },
      },
    });
  });

  test('list reads in ID order, whatever the file order', () => {
    writeProjects(twoProjects());
    expect(list(home).map((project) => project.id)).toEqual(['site', 'teamcli']);
  });

  test('get reads one project by ID, and a key no project has is null', () => {
    writeProjects(twoProjects());
    expect(get(home, 'site')?.name).toBe('TeamCLI.io');
    expect(get(home, 'nope')).toBeNull();
  });

  test('a file that does not read as a registry is named in the error', () => {
    writeProjects('projects: [1]\n');
    expect(() => readProjects(home)).toThrow(ProjectsError);
    expect(() => readProjects(home)).toThrow(/projects\.yaml: "projects" must be a map of project IDs/);
  });

  test('a record with a field of the wrong kind names the project and the field', () => {
    const prov = `    provenance: { registered_by: owner, registered_at: "${AT}", updated_at: "${AT}" }\n`;
    writeProjects(`projects:\n  teamcli:\n    name: 1\n${prov}`);
    expect(() => readProjects(home)).toThrow(/project teamcli: "name" must be text/);
    writeProjects(`projects:\n  teamcli:\n    name: TeamCLI\n    lead: 7\n${prov}`);
    expect(() => readProjects(home)).toThrow(/project teamcli: "lead" must be an agent ID or null/);
    writeProjects(`projects:\n  teamcli:\n    name: TeamCLI\n    teams: cli-id\n${prov}`);
    expect(() => readProjects(home)).toThrow(/project teamcli: "teams" must be a list of team IDs/);
    writeProjects(`projects:\n  teamcli:\n    name: TeamCLI\n    teams: [1]\n${prov}`);
    expect(() => readProjects(home)).toThrow(/project teamcli: teams line 1 must be a team ID/);
    writeProjects('projects:\n  teamcli:\n    name: TeamCLI\n');
    expect(() => readProjects(home)).toThrow(/project teamcli: "provenance" must be a map/);
  });
});

describe('byName, ofTeam', () => {
  test('byName is exact: the display name finds the project, its lowercased spelling does not', () => {
    writeProjects(twoProjects());
    expect(byName(home, 'TeamCLI')?.id).toBe('teamcli');
    expect(byName(home, 'teamcli')).toBeNull();
    expect(byName(home, 'TeamCLI.io')?.id).toBe('site');
  });

  test('ofTeam answers by the project records` own team lists', () => {
    writeProjects(twoProjects());
    expect(ofTeam(home, 'cli-id')?.id).toBe('teamcli');
    expect(ofTeam(home, 'site-id')?.id).toBe('site');
    expect(ofTeam(home, 'shared-id')?.id).toBe('teamcli');
  });

  test('a team no project names is its own project: ofTeam is null, not an error', () => {
    writeProjects(twoProjects());
    expect(ofTeam(home, 'unlisted-id')).toBeNull();
  });

  test('a team two projects name is refused, naming both', () => {
    writeProjects(twoProjects().replace('teams: [site-id]', 'teams: [site-id, cli-id]'));
    expect(() => ofTeam(home, 'cli-id')).toThrow(ProjectsError);
    expect(() => ofTeam(home, 'cli-id')).toThrow(/team cli-id is named in 2 projects: site, teamcli/);
  });

  test('two projects under one name are refused, naming both', () => {
    writeProjects(twoProjects().replace('name: TeamCLI.io', 'name: TeamCLI'));
    expect(() => byName(home, 'TeamCLI')).toThrow(/two projects are named TeamCLI: site, teamcli/);
  });

  test('the two-project file reads whole: only ofTeam refuses, list and get answer', () => {
    writeProjects(twoProjects().replace('teams: [site-id]', 'teams: [site-id, cli-id]'));
    expect(list(home).map((project) => project.id)).toEqual(['site', 'teamcli']);
    expect(get(home, 'site')?.teams).toEqual(['site-id', 'cli-id']);
  });
});

describe('upsertProject', () => {
  test('a new project needs a name', () => {
    expect(() => upsertProject(home, 'teamcli', {})).toThrow('a new project needs a name');
    expect(() => upsertProject(home, 'teamcli', { name: '' })).toThrow('a new project needs a name');
    expect(existsSync(projectsFile(home))).toBe(false);
  });

  test('a new project starts with no entity, no lead and no teams, and records who registered it and when', () => {
    const record = upsertProject(home, 'teamcli', { name: 'TeamCLI', by: 'owner', at: AT });
    expect(record).toMatchObject({
      id: 'teamcli',
      name: 'TeamCLI',
      entity: null,
      lead: null,
      teams: [],
      provenance: { registered_by: 'owner', registered_at: AT, updated_at: AT },
    });
  });

  test('what was written is the documented shape, in ID order whatever order they were registered in', () => {
    upsertProject(home, 'teamcli', { name: 'TeamCLI', entity: 'TeamCLI', lead: 'agt_0123456789ab', teams: ['cli-id', 'shared-id'], by: 'owner', at: AT });
    upsertProject(home, 'site', { name: 'TeamCLI.io', at: AT });
    expect(readFileSync(projectsFile(home), 'utf8')).toBe(
      [
        'projects:',
        '  site:',
        '    name: TeamCLI.io',
        '    entity: null',
        '    lead: null',
        '    teams: []',
        `    provenance: { registered_by: team, registered_at: "${AT}", updated_at: "${AT}" }`,
        '  teamcli:',
        '    name: TeamCLI',
        '    entity: TeamCLI',
        '    lead: agt_0123456789ab',
        '    teams: [cli-id, shared-id]',
        `    provenance: { registered_by: owner, registered_at: "${AT}", updated_at: "${AT}" }`,
        '',
      ].join('\n'),
    );
  });

  test('what was written reads back whole', () => {
    upsertProject(home, 'teamcli', { name: 'TeamCLI', entity: 'TeamCLI', lead: 'agt_0123456789ab', teams: ['cli-id'], by: 'owner', at: AT });
    expect(readProjects(home)).toEqual({
      teamcli: {
        id: 'teamcli',
        name: 'TeamCLI',
        entity: 'TeamCLI',
        lead: 'agt_0123456789ab',
        teams: ['cli-id'],
        provenance: { registered_by: 'owner', registered_at: AT, updated_at: AT },
      },
    });
  });

  test('an update changes the fields it names and nothing else, and moves only updated_at', () => {
    upsertProject(home, 'teamcli', { name: 'TeamCLI', entity: 'TeamCLI', lead: 'agt_0123456789ab', teams: ['cli-id'], by: 'owner', at: AT });
    const later = '2026-10-17T08:00:00.000Z';
    const updated = upsertProject(home, 'teamcli', { teams: ['cli-id', 'site-id'], by: 'someone else', at: later });
    expect(updated).toMatchObject({
      name: 'TeamCLI',
      entity: 'TeamCLI',
      lead: 'agt_0123456789ab',
      teams: ['cli-id', 'site-id'],
      provenance: { registered_by: 'owner', registered_at: AT, updated_at: later },
    });
    expect(readProjects(home).teamcli).toEqual({ ...updated, id: 'teamcli' });
  });

  test('an undefined field in a patch is not a change', () => {
    upsertProject(home, 'teamcli', { name: 'TeamCLI', lead: 'agt_0123456789ab', at: AT });
    upsertProject(home, 'teamcli', { lead: undefined, entity: undefined, at: AT });
    expect(get(home, 'teamcli')?.lead).toBe('agt_0123456789ab');
  });

  test('a rename moves the display name and never the ID, and byName follows', () => {
    upsertProject(home, 'teamcli', { name: 'TeamCLI', at: AT });
    const renamed = upsertProject(home, 'teamcli', { name: 'Team CLI', at: AT });
    expect(renamed.id).toBe('teamcli');
    expect(get(home, 'teamcli')?.name).toBe('Team CLI');
    expect(byName(home, 'Team CLI')?.id).toBe('teamcli');
    expect(byName(home, 'TeamCLI')).toBeNull();
  });

  test('a name another project already holds is refused, and the file stays as it was', () => {
    upsertProject(home, 'site', { name: 'TeamCLI.io', at: AT });
    upsertProject(home, 'teamcli', { name: 'TeamCLI', at: AT });
    const before = readFileSync(projectsFile(home), 'utf8');
    expect(() => upsertProject(home, 'teamcli', { name: 'TeamCLI.io' })).toThrow('a project named TeamCLI.io is already site');
    expect(() => upsertProject(home, 'other', { name: 'TeamCLI' })).toThrow('a project named TeamCLI is already teamcli');
    expect(readFileSync(projectsFile(home), 'utf8')).toBe(before);
  });

  test('a field of the wrong kind is refused and the file stays as it was', () => {
    upsertProject(home, 'teamcli', { name: 'TeamCLI', at: AT });
    const before = readFileSync(projectsFile(home), 'utf8');
    expect(() => upsertProject(home, 'teamcli', { lead: 7 } as never)).toThrow('"lead" must be an agent ID or null');
    expect(() => upsertProject(home, 'teamcli', { teams: 'cli-id' } as never)).toThrow('"teams" must be a list of team IDs');
    expect(() => upsertProject(home, 'teamcli', { teams: [1] } as never)).toThrow('a team ID in "teams" must be text');
    expect(readFileSync(projectsFile(home), 'utf8')).toBe(before);
  });

  test('another project in the file is left as it was', () => {
    upsertProject(home, 'site', { name: 'TeamCLI.io', at: AT });
    const before = readProjects(home).site;
    upsertProject(home, 'teamcli', { name: 'TeamCLI', teams: ['cli-id'], at: AT });
    expect(readProjects(home).site).toEqual(before);
  });

  test('a write leaves no temp or lock file beside the registry', () => {
    upsertProject(home, 'teamcli', { name: 'TeamCLI', at: AT });
    upsertProject(home, 'teamcli', { teams: ['cli-id'], at: AT });
    expect(readdirSync(join(home, '.config', 'team')).sort()).toEqual(['projects.yaml']);
  });

  test('a stale lock left by a dead run does not block a write', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    const lock = `${projectsFile(home)}.lock`;
    writeFileSync(lock, '999999\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    upsertProject(home, 'teamcli', { name: 'TeamCLI', at: AT });
    expect(get(home, 'teamcli')?.name).toBe('TeamCLI');
    expect(existsSync(lock)).toBe(false);
  });

  test('an ID of digits, and text a plain scalar would misread, survive a round trip', () => {
    upsertProject(home, '123456789012', { name: 'true', lead: 'null', teams: ['1e5'], at: AT });
    const read = get(home, '123456789012');
    expect(read).toMatchObject({ name: 'true', lead: 'null', teams: ['1e5'] });
    expect(read?.provenance.updated_at).toBe(AT);
  });

  test('a file that does not read as a registry is never replaced', () => {
    writeProjects('projects: [1]\n');
    expect(() => upsertProject(home, 'teamcli', { name: 'TeamCLI' })).toThrow(ProjectsError);
    expect(readFileSync(projectsFile(home), 'utf8')).toBe('projects: [1]\n');
  });
});

// The project's word on the delivery order: read when a record writes one, kept by every write
// that does not name it, and written back in the record's own shape. A record without one keeps
// the bytes it had — the documented shape test above writes none and pins exactly that.
describe('delivery_order', () => {
  test('a written word reads back, and a record without one carries no field', () => {
    writeProjects(
      'projects:\n  teamcli:\n    name: TeamCLI\n    entity: null\n    lead: null\n    teams: []\n' +
        `    delivery_order: [native, typed]\n    provenance: { registered_by: owner, registered_at: "${AT}", updated_at: "${AT}" }\n`,
    );
    expect(get(home, 'teamcli')?.deliveryOrder).toEqual(['native', 'typed']);
    writeProjects(twoProjects());
    expect('deliveryOrder' in (get(home, 'teamcli') as object)).toBe(false);
  });

  test('a word that is not a non-empty list of distinct legs is refused, naming the project', () => {
    const prov = `    provenance: { registered_by: owner, registered_at: "${AT}", updated_at: "${AT}" }\n`;
    const record = (word: string) => `projects:\n  teamcli:\n    name: TeamCLI\n    ${word}\n${prov}`;
    writeProjects(record('delivery_order: []'));
    expect(() => readProjects(home)).toThrow(/project teamcli: "delivery_order" must name at least one leg/);
    writeProjects(record('delivery_order: typed'));
    expect(() => readProjects(home)).toThrow(/project teamcli: "delivery_order" must be a list of legs/);
    writeProjects(record('delivery_order: [telepathy]'));
    expect(() => readProjects(home)).toThrow(/project teamcli: delivery_order line 1 must be one of: native, mcp-inbox, typed, drop/);
    writeProjects(record('delivery_order: [typed, typed]'));
    expect(() => readProjects(home)).toThrow(/project teamcli: "delivery_order" names a leg twice/);
  });

  test('a written word is the record’s own line, and an unrelated patch keeps it', () => {
    upsertProject(home, 'teamcli', { name: 'TeamCLI', deliveryOrder: ['typed'], by: 'owner', at: AT });
    expect(readFileSync(projectsFile(home), 'utf8')).toBe(
      [
        'projects:',
        '  teamcli:',
        '    name: TeamCLI',
        '    entity: null',
        '    lead: null',
        '    teams: []',
        '    delivery_order: [typed]',
        `    provenance: { registered_by: owner, registered_at: "${AT}", updated_at: "${AT}" }`,
        '',
      ].join('\n'),
    );
    upsertProject(home, 'teamcli', { teams: ['cli-id'], at: AT });
    expect(get(home, 'teamcli')?.deliveryOrder).toEqual(['typed']);
    expect(get(home, 'teamcli')?.teams).toEqual(['cli-id']);
  });

  test('a patch with a word the reader would refuse is refused, and the file stays as it was', () => {
    upsertProject(home, 'teamcli', { name: 'TeamCLI', at: AT });
    const before = readFileSync(projectsFile(home), 'utf8');
    expect(() => upsertProject(home, 'teamcli', { deliveryOrder: [] })).toThrow('"delivery_order" must name at least one leg');
    expect(() => upsertProject(home, 'teamcli', { deliveryOrder: ['telepathy'] as never })).toThrow('a "delivery_order" leg must be one of: native, mcp-inbox, typed, drop');
    expect(() => upsertProject(home, 'teamcli', { deliveryOrder: ['typed', 'typed'] })).toThrow('"delivery_order" names a leg twice');
    expect(readFileSync(projectsFile(home), 'utf8')).toBe(before);
  });
});

describe('projectIdOf', () => {
  test('lowercases the name and writes every other run as one dash', () => {
    expect(projectIdOf('teamcli')).toBe('teamcli');
    expect(projectIdOf('TeamCLI')).toBe('teamcli');
    expect(projectIdOf('Team CLI')).toBe('team-cli');
    expect(projectIdOf('TeamCLI.io')).toBe('teamcli.io');
    expect(projectIdOf('  Team  CLI  ')).toBe('team-cli');
    expect(projectIdOf('A')).toBe('a');
  });

  test('the ID derives the same every time, and a name with nothing to keep is refused', () => {
    expect(projectIdOf('Team CLI')).toBe(projectIdOf('Team CLI'));
    expect(() => projectIdOf('***')).toThrow(ProjectsError);
    expect(() => projectIdOf('***')).toThrow('"***" is not a project name');
  });

  test("the ID is the key a team file's in_project name reaches, and the record it mints answers by the name as written", () => {
    upsertProject(home, projectIdOf('Team CLI'), { name: 'Team CLI', lead: 'agt_0123456789ab', at: AT });
    expect(get(home, 'team-cli')?.name).toBe('Team CLI');
    expect(byName(home, 'Team CLI')?.id).toBe('team-cli');
  });
});
