import { describe, expect, test } from 'bun:test';
import { fingerprints, OWNER_SECTIONS } from '../src/approve/fingerprint.ts';
import { SECTIONS } from '../src/file/sections/index.ts';
import { membershipsOfFile } from '../src/file/memberships.ts';
import { validateTeamFile } from '../src/file/validate.ts';

const TEAM = `format: 1
project: team-a
operator: seat-a
trust: []
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: seat-a
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function loaded(extra: string) {
  const result = validateTeamFile(TEAM + extra);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function errors(extra: string) {
  const result = validateTeamFile(TEAM + extra);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

describe('also_in', () => {
  test('older files and an empty list serve no additional projects', () => {
    expect(loaded('').alsoIn).toEqual([]);
    expect(loaded('in_project: project-x\nalso_in: []\n').alsoIn).toEqual([]);
  });

  test('served names keep their spelling and order beside the home', () => {
    const team = loaded('in_project: project-x\nalso_in: [Project-Y, project-z]\nproject_lead: true\n');
    expect(team.inProject).toBe('project-x');
    expect(team.alsoIn).toEqual(['Project-Y', 'project-z']);
    expect(team.projectLead).toBe(true);
  });

  test('a served list requires a home, including an explicitly empty list', () => {
    for (const value of ['[project-y]', '[]']) {
      expect(errors(`also_in: ${value}\n`)).toContainEqual({
        line: 16, message: 'also_in needs in_project: name the home project first',
      });
    }
  });

  test('the home cannot also be served, regardless of name casing', () => {
    for (const name of ['project-x', 'Project-X', 'project-x-']) {
      expect(errors(`in_project: project-x\nalso_in: [${name}]\n`)).toContainEqual({
        line: 17, message: `also_in repeats the home project "${name}": keep it in in_project only`,
      });
    }
  });

  test('served names have the home name shape and cannot repeat', () => {
    expect(errors('in_project: project-x\nalso_in: [project-y, Project-Y]\n')).toContainEqual({
      line: 17, message: 'also_in names "Project-Y" twice',
    });
    for (const name of ['project y', '../project-y', 'x'.repeat(129)]) {
      expect(errors(`in_project: project-x\nalso_in: ["${name}"]\n`).some((error) => error.message.startsWith('each project in also_in must be a short name:'))).toBe(true);
    }
    for (const value of ['project-y', 'true', '[true]', '[""]', '{project-y: true}', '']) {
      expect(errors(`in_project: project-x\nalso_in: ${value}\n`).length).toBeGreaterThan(0);
    }
  });

  test('a served project cannot supply the home required by project_lead', () => {
    expect(errors('also_in: [project-y]\nproject_lead: true\n').map((error) => error.message)).toContain(
      'project_lead needs in_project: name the project this team leads',
    );
  });

  test('adding served projects changes no owner or seat fingerprint', () => {
    const home = loaded('in_project: project-x\n');
    const served = loaded('in_project: project-x\nalso_in: [project-y]\n');
    expect(SECTIONS.find((section) => section.name === 'also_in')?.owner).toBe(false);
    expect(OWNER_SECTIONS).not.toContain('also_in');
    expect(fingerprints(served)).toEqual(fingerprints(home));
  });

  test('the membership helper separates home and served names without sharing mutable lists', () => {
    const team = loaded('in_project: project-x\nalso_in: [project-y, project-z]\n');
    const memberships = membershipsOfFile(team);
    expect(memberships).toEqual({ home: 'project-x', served: ['project-y', 'project-z'] });
    memberships.served.push('project-w');
    expect(team.alsoIn).toEqual(['project-y', 'project-z']);
    expect(membershipsOfFile({ inProject: null })).toEqual({ home: null, served: [] });
    expect(membershipsOfFile({ inProject: 'project-x' })).toEqual({ home: 'project-x', served: [] });
  });
});
