// The project registry: `~/.config/team/projects.yaml`. The record between the entity and the
// teams — a project groups teams under one lead, by agent ID, and a team no project names is its
// own project. This file grows with src/registry/projects.ts: the reads first, the writes next.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { byName, get, list, ofTeam, projectsFile, ProjectsError, readProjects } from '../../src/registry/projects.ts';

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
