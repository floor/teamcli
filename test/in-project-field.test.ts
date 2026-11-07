// The team file's project level. `project:` still names the team itself; the new `in_project:`
// names the project the team sits in, by the project's name, and `project_lead: true` says this
// is the project's lead team. All are optional for the project (a team that names none is its own
// project), so no file written before these fields existed loads any differently — the last part
// of this file walks every team file already in the tree.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateTeamFile } from '../src/file/validate.ts';

/** A file that names both levels: the team `teamcli` inside project `TeamCLI`. */
function file(inProject: string | null, extra: string[] = []): string {
  return [
    'format: 1',
    'project: teamcli',
    ...(inProject === null ? [] : [`in_project: ${inProject}`]),
    'operator: lead',
    ...extra,
    'trust: []',
    'workspace:',
    '  mode: shared',
    'seats:',
    '  - role: coordinator',
    '    name: lead',
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    '    leads: true',
    '',
  ].join('\n');
}

function loaded(text: string): ReturnType<typeof validateTeamFile> {
  return validateTeamFile(text);
}

describe('a team names the project it sits in', () => {
  test('`in_project:` reads as the project, and `project:` stays the team\'s own name', () => {
    const result = loaded(file('TeamCLI'));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.team.inProject).toBe('TeamCLI');
    expect(result.team.project).toBe('teamcli');
    expect(result.warnings).toEqual([]);
  });

  test('a file that names no project reads null: the team is its own project', () => {
    const result = loaded(file(null));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.team.inProject).toBeNull();
  });

  test('a name outside the short names is refused, naming the line', () => {
    const result = loaded(file('Team CLI'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      {
        line: 3,
        message: 'in_project must be a short name: letters, digits, ".", "_" and "-", starting with a letter or a digit, 128 at most',
      },
    ]);
  });
});

describe('the default session of a team in a project', () => {
  /** A file with an entity, a project the team sits in, and optionally an explicit session. */
  function fileInProject(team: string, inProject: string | null, entity: string | null, session: string | null = null): string {
    return [
      'format: 1',
      `project: ${team}`,
      ...(entity === null ? [] : [`entity: ${entity}`]),
      ...(inProject === null ? [] : [`in_project: ${inProject}`]),
      ...(session === null ? [] : [`session: ${session}`]),
      'operator: lead',
      'trust: []',
      'workspace:',
      '  mode: shared',
      'seats:',
      '  - role: coordinator',
      '    name: lead',
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude --model claude-opus-5-5',
      '    leads: true',
      '',
    ].join('\n');
  }

  test('a team that is its project\'s namesake collapses to <entity>-<project>', () => {
    const result = loaded(fileInProject('teamcli', 'TeamCLI', 'floor'));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.team.session).toBe('floor-teamcli');
    expect(result.warnings).toEqual([]);
  });

  test('a team that is not the namesake derives <entity>-<project>-<team>', () => {
    const result = loaded(fileInProject('web', 'TeamCLI', 'floor'));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.team.session).toBe('floor-teamcli-web');
  });

  test('two teams in one project never share a default session', () => {
    const web = loaded(fileInProject('web', 'TeamCLI', 'floor'));
    const api = loaded(fileInProject('api', 'TeamCLI', 'floor'));
    const own = loaded(fileInProject('teamcli', 'TeamCLI', 'floor'));
    if (!web.ok || !api.ok || !own.ok) throw new Error('a file was refused');
    expect(new Set([web.team.session, api.team.session, own.team.session])).toEqual(
      new Set(['floor-teamcli-web', 'floor-teamcli-api', 'floor-teamcli']),
    );
  });

  test('a team with no in_project keeps <entity>-<team>, and a team with no entity keeps its own name', () => {
    const withEntity = loaded(fileInProject('docs', null, 'floor'));
    const bare = loaded(fileInProject('docs', null, null));
    if (!withEntity.ok || !bare.ok) throw new Error('a file was refused');
    expect(withEntity.team.session).toBe('floor-docs');
    expect(bare.team.session).toBe('docs');
  });

  test('with no entity the project id leads: <project> or <project>-<team>', () => {
    const namesake = loaded(fileInProject('teamcli', 'TeamCLI', null));
    const other = loaded(fileInProject('web', 'TeamCLI', null));
    if (!namesake.ok || !other.ok) throw new Error('a file was refused');
    expect(namesake.team.session).toBe('teamcli');
    expect(other.team.session).toBe('teamcli-web');
  });

  test('an explicit session still wins, and draws no warning when it matches the default', () => {
    const matching = loaded(fileInProject('teamcli', 'TeamCLI', 'floor', 'floor-teamcli'));
    if (!matching.ok) throw new Error(JSON.stringify(matching.errors));
    expect(matching.team.session).toBe('floor-teamcli');
    expect(matching.warnings).toEqual([]);
    const own = loaded(fileInProject('teamcli', 'TeamCLI', 'floor', 'mine'));
    if (!own.ok) throw new Error(JSON.stringify(own.errors));
    expect(own.team.session).toBe('mine');
  });

  test('an explicit session off the default is named in one warning line', () => {
    const result = loaded(fileInProject('web', 'project-x', 'entity-a', 'stale-name'));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.team.session).toBe('stale-name');
    expect(result.warnings).toEqual([
      {
        line: 5,
        message: 'session "stale-name" is not the default "entity-a-project-x-web" for this entity and project: kept as written; a drifted name is how a stale session gets reused',
      },
    ]);
  });
});

describe('a team says whether it leads the project it sits in', () => {
  test('`project_lead: true` reads as the lead, beside the project it names', () => {
    const result = loaded(file('TeamCLI', ['project_lead: true']));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.team.projectLead).toBe(true);
    expect(result.team.inProject).toBe('TeamCLI');
  });

  test('a file that says nothing reads false: this team leads no project', () => {
    const result = loaded(file('TeamCLI'));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.team.projectLead).toBe(false);
  });

  test('`project_lead: true` with no `in_project` is refused: there is no project to lead', () => {
    const result = loaded(file(null, ['project_lead: true']));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      { line: 4, message: 'project_lead needs in_project: name the project this team leads' },
    ]);
  });

  test('a `project_lead` that is not true or false is refused', () => {
    const result = loaded(file('TeamCLI', ['project_lead: maybe']));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([{ line: 5, message: 'project_lead must be true or false' }]);
  });
});

describe('every team file already in the tree loads unchanged', () => {
  // The team files the repository carries: its own, the shipped example, the fixtures the file
  // tests validate, and the v0.1.2 copies. The schema fixtures are not here — they are written
  // to fail, and the tests that use them assert the refusals.
  const files = [
    '../.github/team.yaml',
    '../examples/team.yaml',
    './fixtures/example.yaml',
    './fixtures/doctor-models.yaml',
    './fixtures/legacy/v0.1.2/example.yaml',
    './fixtures/legacy/v0.1.2/examples-team.yaml',
    './fixtures/legacy/v0.1.2/team.yaml',
  ];

  for (const path of files) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    // The line the file's legacy `coordinator:` key sits on, per file: the one warning each of
    // these files carries today, asserted so a new field cannot quietly add another.
    const legacyLine = /^coordinator:/m.exec(text)?.index ?? 0;

    test(`${path} still loads, with the only warning it had`, () => {
      const result = loaded(text);
      if (!result.ok) throw new Error(`${path} is refused: ${JSON.stringify(result.errors)}`);
      const line = text.slice(0, legacyLine).split('\n').length;
      expect(result.warnings).toEqual([
        {
          line,
          message: '`coordinator:` is now `leads: true` on the lead\'s seat, and is still read',
        },
      ]);
      expect(result.team.inProject).toBeNull();
      expect(result.team.projectLead).toBe(false);
    });
  }
});
