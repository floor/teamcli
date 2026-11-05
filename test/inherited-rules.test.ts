import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config';
import { doctorFindings } from '../src/commands/doctor';
import {
  rulesFileDifferences,
  rulesFileProblem,
} from '../src/commands/status';
import {
  entityRules,
  planEntityRulesSet,
  writeEntityRulesSet,
} from '../src/entities';
import { validateTeamFile } from '../src/file/validate';
import type { Seat, TeamFile } from '../src/file/types';
import {
  composedRulesOf,
  formatComposedRules,
  rulesOf,
} from '../src/launch/rules';
import {
  checkRulesFile,
  rulesDeliveryOf,
  rulesFileHash,
  writeRulesFile,
} from '../src/launch/rules-file';
import {
  homeProjectIdOf,
  planProjectRulesSet,
  projectRules,
  writeProjectRulesSet,
} from '../src/registry/projects';
import { teamIdOf } from '../src/registry/teams';
import type { Standing } from '../src/trust/types';
import { testIo } from './helpers';

const OWNER_NO_BLOCKING_RULE =
  'No seat ever waits on a blocking prompt to a human … questions go to the orchestrator with team send.';

let home = '';
let teamRoot = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'team-inherited-rules-home-'));
  teamRoot = mkdtempSync(join(tmpdir(), 'team-inherited-rules-root-'));
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(teamRoot, { recursive: true, force: true });
});

function writeEntitiesYaml(content: string): void {
  writeFileSync(join(home, '.config', 'team', 'entities.yaml'), content);
}

function writeProjectsYaml(content: string): void {
  writeFileSync(join(home, '.config', 'team', 'projects.yaml'), content);
}

function writeTeamsYaml(content: string): void {
  writeFileSync(join(home, '.config', 'team', 'teams.yaml'), content);
}

function makeTeam(opts: {
  project?: string;
  entity?: string | null;
  inProject?: string | null;
  rules?: string[];
}): { team: TeamFile; rey: Seat; rawYaml: string } {
  const lines = [
    'format: 1',
    `project: ${opts.project ?? 'jedi'}`,
    'coordinator: orchestrator',
    'operator: orchestrator',
    `session: ${opts.project ?? 'jedi'}`,
  ];
  if (opts.entity !== undefined && opts.entity !== null) {
    lines.push(`entity: ${opts.entity}`);
  }
  if (opts.inProject !== undefined && opts.inProject !== null) {
    lines.push(`in_project: ${opts.inProject}`);
  }
  lines.push(
    'workspace:',
    '  mode: shared',
  );
  if (opts.rules && opts.rules.length > 0) {
    lines.push('rules:');
    for (const r of opts.rules) {
      lines.push(`  - ${JSON.stringify(r)}`);
    }
  }
  lines.push(
    'seats:',
    '  - role: coordinator',
    '    name: orchestrator',
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus 4.6',
    '    version: "1"',
    '    launch: claude',
    '  - role: builder',
    '    name: rey',
    '    cli: gemini',
    '    vendor: google',
    '    model: Gemini 3.1 Pro',
    '    version: "1"',
    '    launch: gemini',
  );
  const rawYaml = `${lines.join('\n')}\n`;
  const validated = validateTeamFile(rawYaml);
  if (!validated.ok) {
    throw new Error(`Invalid team YAML: ${JSON.stringify(validated.errors)}`);
  }
  const team = validated.team;
  const rey = team.seats.find((s) => s.name === 'rey')!;
  return { team, rey, rawYaml };
}

function verifiedStanding(rawYaml: string): Standing {
  return {
    kind: 'verified',
    record: {
      project: 'jedi',
      root: teamRoot,
      fileHash: '0'.repeat(64),
      file: rawYaml,
      approvedAt: '2026-11-05T00:00:00Z',
      approver: 'owner',
      signature: 'sig',
    },
    drift: [],
  } as unknown as Standing;
}

describe('FLO-1123: inherited entity-wide and project-wide rules', () => {
  test('1. inheritance: entity, home project, and team rules render in order under short headings in one text, one hash, one delivery', () => {
    const id = teamIdOf(teamRoot);
    writeEntitiesYaml(
      [
        'entities:',
        '  acme-corp:',
        '    name: Acme Corp',
        '    rules:',
        `      - ${JSON.stringify(OWNER_NO_BLOCKING_RULE)}`,
        '      - "Never force-push shared branches."',
        '',
      ].join('\n'),
    );
    writeProjectsYaml(
      [
        'projects:',
        '  floor:',
        '    name: Floor',
        '    entity: acme-corp',
        `    teams: [${id}]`,
        '    rules:',
        '      - "Write red tests before implementation."',
        '',
      ].join('\n'),
    );
    writeTeamsYaml(
      [
        'teams:',
        `  ${id}:`,
        '    name: jedi',
        `    path: ${teamRoot}`,
        '    project_id: floor',
        `    projects: [floor]`,
        '    registered_at: "2026-11-05T00:00:00Z"',
        '',
      ].join('\n'),
    );

    const { team, rey, rawYaml } = makeTeam({
      project: 'jedi',
      entity: 'acme-corp',
      inProject: 'Floor',
      rules: ['Commit with Agent trailer.', 'Run inbox_check every turn.'],
    });

    const text = rulesOf(team, rey, teamRoot, undefined, 'file', home);
    expect(text).toContain('Entity rules (acme-corp):');
    expect(text).toContain(`- ${OWNER_NO_BLOCKING_RULE}`);
    expect(text).toContain('- Never force-push shared branches.');
    expect(text).toContain('Project rules (floor):');
    expect(text).toContain('- Write red tests before implementation.');
    expect(text).toContain('Team rules:');
    expect(text).toContain('- Commit with Agent trailer.');
    expect(text).toContain('- Run inbox_check every turn.');

    const entityIdx = text.indexOf('Entity rules (acme-corp):');
    const entityRule1Idx = text.indexOf(`- ${OWNER_NO_BLOCKING_RULE}`);
    const entityRule2Idx = text.indexOf('- Never force-push shared branches.');
    const projectIdx = text.indexOf('Project rules (floor):');
    const projectRuleIdx = text.indexOf('- Write red tests before implementation.');
    const teamIdx = text.indexOf('Team rules:');
    const teamRule1Idx = text.indexOf('- Commit with Agent trailer.');
    const teamRule2Idx = text.indexOf('- Run inbox_check every turn.');

    expect(entityIdx).toBeGreaterThan(-1);
    expect(entityRule1Idx).toBeGreaterThan(entityIdx);
    expect(entityRule2Idx).toBeGreaterThan(entityRule1Idx);
    expect(projectIdx).toBeGreaterThan(entityRule2Idx);
    expect(projectRuleIdx).toBeGreaterThan(projectIdx);
    expect(teamIdx).toBeGreaterThan(projectRuleIdx);
    expect(teamRule1Idx).toBeGreaterThan(teamIdx);
    expect(teamRule2Idx).toBeGreaterThan(teamRule1Idx);

    const standing = verifiedStanding(rawYaml);
    const delivery = rulesDeliveryOf(standing, team, rey, teamRoot, home);
    expect('text' in delivery).toBe(true);
    if ('text' in delivery) {
      expect(delivery.text).toBe(text);
      expect(delivery.line).toContain(rulesFileHash(text));
    }
  });

  test('a team cannot drop an entity rule even if team.rules is empty or reworded', () => {
    writeEntitiesYaml(
      [
        'acme-corp:',
        '  name: Acme Corp',
        '  rules:',
        `    - ${JSON.stringify(OWNER_NO_BLOCKING_RULE)}`,
        '',
      ].join('\n'),
    );
    const { team, rey } = makeTeam({
      project: 'jedi',
      entity: 'acme-corp',
      rules: [],
    });
    const text = rulesOf(team, rey, teamRoot, undefined, 'file', home);
    expect(text).toContain(`- ${OWNER_NO_BLOCKING_RULE}`);
  });

  test('2. a team not in a project gets entity rules only (no project rules heading)', () => {
    const id = teamIdOf(teamRoot);
    writeEntitiesYaml(
      [
        'acme-corp:',
        '  name: Acme Corp',
        '  rules:',
        `    - ${JSON.stringify(OWNER_NO_BLOCKING_RULE)}`,
        '',
      ].join('\n'),
    );
    writeProjectsYaml(
      [
        'projects:',
        '  floor:',
        '    name: Floor',
        '    entity: acme-corp',
        '    teams: []',
        '    rules:',
        '      - "Project rule that must not apply to an unassigned team."',
        '',
      ].join('\n'),
    );
    writeTeamsYaml(
      [
        'teams:',
        `  ${id}:`,
        '    name: jedi',
        `    path: ${teamRoot}`,
        '    project_id: null',
        '    projects: []',
        '    registered_at: "2026-11-05T00:00:00Z"',
        '',
      ].join('\n'),
    );

    const { team, rey } = makeTeam({
      project: 'jedi',
      entity: 'acme-corp',
      inProject: null,
      rules: ['Team local rule.'],
    });

    expect(homeProjectIdOf(home, teamRoot, team)).toBeNull();
    const text = rulesOf(team, rey, teamRoot, undefined, 'file', home);
    expect(text).toContain('Entity rules (acme-corp):');
    expect(text).toContain(`- ${OWNER_NO_BLOCKING_RULE}`);
    expect(text).not.toContain('Project rules');
    expect(text).not.toContain('Project rule that must not apply');
    expect(text).toContain('Team rules:');
    expect(text).toContain('- Team local rule.');
  });

  test('3. a served project’s rules do NOT apply (home project only)', () => {
    const id = teamIdOf(teamRoot);
    writeEntitiesYaml(
      [
        'acme-corp:',
        '  name: Acme Corp',
        '  rules:',
        `    - ${JSON.stringify(OWNER_NO_BLOCKING_RULE)}`,
        '',
      ].join('\n'),
    );
    writeProjectsYaml(
      [
        'projects:',
        '  home-proj:',
        '    name: HomeProj',
        '    entity: acme-corp',
        `    teams: [${id}]`,
        '    rules:',
        '      - "Home project rule applies."',
        '  served-proj:',
        '    name: ServedProj',
        '    entity: acme-corp',
        `    teams: [${id}]`,
        '    rules:',
        '      - "Served project rule MUST NOT apply."',
        '',
      ].join('\n'),
    );
    writeTeamsYaml(
      [
        'teams:',
        `  ${id}:`,
        '    name: jedi',
        `    path: ${teamRoot}`,
        '    project_id: home-proj',
        '    projects: [home-proj, served-proj]',
        '    registered_at: "2026-11-05T00:00:00Z"',
        '',
      ].join('\n'),
    );

    const { team, rey } = makeTeam({
      project: 'jedi',
      entity: 'acme-corp',
      inProject: 'HomeProj',
      rules: ['Team rule applies.'],
    });

    expect(homeProjectIdOf(home, teamRoot, team)).toBe('home-proj');
    const text = rulesOf(team, rey, teamRoot, undefined, 'file', home);
    expect(text).toContain('Project rules (home-proj):');
    expect(text).toContain('- Home project rule applies.');
    expect(text).not.toContain('served-proj');
    expect(text).not.toContain('Served project rule MUST NOT apply.');

    // Also when a team has NO home project (project_id: null) and only serves served-proj:
    writeTeamsYaml(
      [
        'teams:',
        `  ${id}:`,
        '    name: jedi',
        `    path: ${teamRoot}`,
        '    project_id: null',
        '    projects: [served-proj]',
        '    registered_at: "2026-11-05T00:00:00Z"',
        '',
      ].join('\n'),
    );
    const { team: unassignedTeam, rey: unassignedRey } = makeTeam({
      project: 'jedi',
      entity: 'acme-corp',
      inProject: null,
      rules: ['Team rule applies.'],
    });
    expect(homeProjectIdOf(home, teamRoot, unassignedTeam)).toBeNull();
    const unassignedText = rulesOf(
      unassignedTeam,
      unassignedRey,
      teamRoot,
      undefined,
      'file',
      home,
    );
    expect(unassignedText).not.toContain('Project rules');
    expect(unassignedText).not.toContain('Served project rule MUST NOT apply.');
    expect(unassignedText).not.toContain('Home project rule applies.');
  });

  test('4. hash changes when an entity rule changes and drift is reported by status and doctor', () => {
    const id = teamIdOf(teamRoot);
    // Ensure `<home>/.config/team` has mode 0o700 so writeRulesFile's ladder check passes
    mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
    writeEntitiesYaml(
      [
        'acme-corp:',
        '  name: Acme Corp',
        '  rules:',
        `    - ${JSON.stringify(OWNER_NO_BLOCKING_RULE)}`,
        '',
      ].join('\n'),
    );
    writeProjectsYaml(
      [
        'projects:',
        '  floor:',
        '    name: Floor',
        '    entity: acme-corp',
        `    teams: [${id}]`,
        '    rules:',
        '      - "Initial project rule."',
        '',
      ].join('\n'),
    );
    writeTeamsYaml(
      [
        'teams:',
        `  ${id}:`,
        '    name: jedi',
        `    path: ${teamRoot}`,
        '    project_id: floor',
        '    projects: [floor]',
        '    registered_at: "2026-11-05T00:00:00Z"',
        '',
      ].join('\n'),
    );

    const { team, rey, rawYaml } = makeTeam({
      project: 'jedi',
      entity: 'acme-corp',
      inProject: 'Floor',
      rules: ['Team rule.'],
    });
    const standing = verifiedStanding(rawYaml);

    // Write the initial rules file on disk for seat rey
    const initialDelivery = rulesDeliveryOf(standing, team, rey, teamRoot, home);
    expect('text' in initialDelivery).toBe(true);
    if (!('text' in initialDelivery)) return;
    const initialHash = rulesFileHash(initialDelivery.text);
    const wrote = writeRulesFile(
      standing,
      'rey',
      teamRoot,
      home,
      initialDelivery.text,
      initialHash,
      undefined,
      team.project,
    );
    expect(wrote).toEqual({ ok: true });

    // Status and rulesFileChecks report no drift initially
    expect(checkRulesFile(initialDelivery.path, initialDelivery.text).ok).toBe(true);
    expect(rulesFileProblem(standing, team, rey, teamRoot, home)).toBeNull();
    expect(rulesFileDifferences(standing, team, teamRoot, home)).toEqual([]);

    // Now the owner updates an entity rule in entities.yaml
    writeEntitiesYaml(
      [
        'acme-corp:',
        '  name: Acme Corp',
        '  rules:',
        `    - ${JSON.stringify(OWNER_NO_BLOCKING_RULE)}`,
        '    - "New entity rule added after launch."',
        '',
      ].join('\n'),
    );

    const updatedDelivery = rulesDeliveryOf(standing, team, rey, teamRoot, home);
    expect('text' in updatedDelivery).toBe(true);
    if (!('text' in updatedDelivery)) return;
    const updatedHash = rulesFileHash(updatedDelivery.text);
    expect(updatedHash).not.toBe(initialHash);

    // Status and checkRulesFile report drift for rey
    const check = checkRulesFile(initialDelivery.path, updatedDelivery.text);
    expect(check.ok).toBe(false);
    const problem = rulesFileProblem(standing, team, rey, teamRoot, home);
    expect(problem).toContain("its rules file differs from the team file's rules");
    const diffs = rulesFileDifferences(standing, team, teamRoot, home);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.what).toContain('rey:');
    expect(diffs[0]?.what).toContain("its rules file differs from the team file's rules");
    expect(diffs[0]?.repair).toBe('team reload rey');
  });

  test('5. owner writes entity and project rules with --dry-run (Zeus §5.10) and applies them', async () => {
    writeEntitiesYaml(
      [
        'acme-corp:',
        '  name: Acme Corp',
        '',
      ].join('\n'),
    );
    writeProjectsYaml(
      [
        'projects:',
        '  floor:',
        '    name: Floor',
        '    entity: acme-corp',
        '    teams: []',
        '',
      ].join('\n'),
    );

    // Dry-run via programmatic planner
    const entityPlan = planEntityRulesSet(home, 'acme-corp', [OWNER_NO_BLOCKING_RULE]);
    expect(entityPlan.diff).toContain(OWNER_NO_BLOCKING_RULE);
    expect(entityRules(home, 'acme-corp')).toEqual([]);

    const projectPlan = planProjectRulesSet(home, 'floor', ['Write red tests first.']);
    expect(projectPlan.diff).toContain('Write red tests first.');
    expect(projectRules(home, 'floor')).toEqual([]);

    // Dry-run via CLI `team config set <entity>.rules ... --dry-run`
    const dryIo = testIo(teamRoot, { kind: 'owner' });
    const dryCode = await runConfig(
      ['set', 'acme-corp.rules', JSON.stringify([OWNER_NO_BLOCKING_RULE]), '--dry-run'],
      dryIo,
      { home },
    );
    expect(dryCode).toBe(0);
    expect(dryIo.out).toContain(OWNER_NO_BLOCKING_RULE);
    // File on disk must be untouched after --dry-run
    expect(entityRules(home, 'acme-corp')).toEqual([]);

    // Apply entity rules via CLI `team config set`
    const applyIo = testIo(teamRoot, { kind: 'owner' });
    const applyCode = await runConfig(
      ['set', 'acme-corp.rules', JSON.stringify([OWNER_NO_BLOCKING_RULE])],
      applyIo,
      { home },
    );
    expect(applyCode).toBe(0);
    expect(entityRules(home, 'acme-corp')).toEqual([OWNER_NO_BLOCKING_RULE]);

    // Dry-run via CLI `team config set project.floor.rules ... --dry-run`
    const projDryIo = testIo(teamRoot, { kind: 'owner' });
    const projDryCode = await runConfig(
      ['set', 'project.floor.rules', '["Write red tests first."]', '--dry-run'],
      projDryIo,
      { home },
    );
    expect(projDryCode).toBe(0);
    expect(projDryIo.out).toContain('Write red tests first.');
    expect(projectRules(home, 'floor')).toEqual([]);

    // Apply project rules via CLI `team config set project.floor.rules`
    const projApplyIo = testIo(teamRoot, { kind: 'owner' });
    const projApplyCode = await runConfig(
      ['set', 'project.floor.rules', '["Write red tests first."]'],
      projApplyIo,
      { home },
    );
    expect(projApplyCode).toBe(0);
    expect(projectRules(home, 'floor')).toEqual(['Write red tests first.']);

    // Read back via CLI `team config get <entity>.rules` and `team config get project.<id>.rules`
    const getEntityIo = testIo(teamRoot, { kind: 'owner' });
    expect(await runConfig(['get', 'acme-corp.rules'], getEntityIo, { home })).toBe(0);
    expect(getEntityIo.out).toContain(OWNER_NO_BLOCKING_RULE);

    const getProjectIo = testIo(teamRoot, { kind: 'owner' });
    expect(await runConfig(['get', 'project.floor.rules'], getProjectIo, { home })).toBe(0);
    expect(getProjectIo.out).toContain('Write red tests first.');

    // Write via programmatic writer with dryRun: false
    const wroteEntity = writeEntityRulesSet(home, 'acme-corp', [
      OWNER_NO_BLOCKING_RULE,
      'Always verify scoped tests.',
    ]);
    expect(wroteEntity.written).toBe(true);
    expect(entityRules(home, 'acme-corp')).toEqual([
      OWNER_NO_BLOCKING_RULE,
      'Always verify scoped tests.',
    ]);

    const wroteProject = writeProjectRulesSet(home, 'floor', [
      'Write red tests first.',
      'Document launch.md.',
    ]);
    expect(wroteProject.written).toBe(true);
    expect(projectRules(home, 'floor')).toEqual([
      'Write red tests first.',
      'Document launch.md.',
    ]);

    // Non-owner is rejected
    const nonOwnerIo = testIo(teamRoot, { kind: 'seat', name: 'rey', pane: 'pane1' });
    const nonOwnerCode = await runConfig(
      ['set', 'acme-corp.rules', '["Forbidden"]'],
      nonOwnerIo,
      { home },
    );
    expect(nonOwnerCode).toBe(1);
    expect(nonOwnerIo.err).toContain('only the owner');
  });

  test('6. composedRulesOf and formatComposedRules show the composed rules with their origin', () => {
    const id = teamIdOf(teamRoot);
    writeEntitiesYaml(
      [
        'entities:',
        '  acme-corp:',
        '    name: Acme Corp',
        '    rules:',
        `      - ${JSON.stringify(OWNER_NO_BLOCKING_RULE)}`,
        '',
      ].join('\n'),
    );
    writeProjectsYaml(
      [
        'projects:',
        '  floor:',
        '    name: Floor',
        '    entity: acme-corp',
        `    teams: [${id}]`,
        '    rules:',
        '      - "Write red tests before implementation."',
        '',
      ].join('\n'),
    );
    writeTeamsYaml(
      [
        'teams:',
        `  ${id}:`,
        '    name: jedi',
        `    path: ${teamRoot}`,
        '    project_id: floor',
        '    projects: [floor]',
        '    registered_at: "2026-11-05T00:00:00Z"',
        '',
      ].join('\n'),
    );

    const { team, rey } = makeTeam({
      project: 'jedi',
      entity: 'acme-corp',
      inProject: 'Floor',
      rules: ['Commit with Agent trailer.'],
    });

    const composed = composedRulesOf(team, rey, teamRoot, undefined, 'file', home);
    const entityEntries = composed.filter((item) => item.origin === 'entity');
    const projectEntries = composed.filter((item) => item.origin === 'project');
    const teamEntries = composed.filter((item) => item.origin === 'team');

    expect(entityEntries).toEqual([
      {
        origin: 'entity',
        source: 'acme-corp',
        rule: OWNER_NO_BLOCKING_RULE,
      },
    ]);
    expect(projectEntries).toEqual([
      {
        origin: 'project',
        source: 'floor',
        rule: 'Write red tests before implementation.',
      },
    ]);
    expect(teamEntries).toEqual([
      {
        origin: 'team',
        source: 'jedi',
        rule: 'Commit with Agent trailer.',
      },
    ]);

    const view = formatComposedRules(team, rey, teamRoot, undefined, home);
    expect(view).toContain('Entity rules (acme-corp):');
    expect(view).toContain(OWNER_NO_BLOCKING_RULE);
    expect(view).toContain('Project rules (floor):');
    expect(view).toContain('Write red tests before implementation.');
    expect(view).toContain('Team rules (jedi):');
    expect(view).toContain('Commit with Agent trailer.');
  });
});
