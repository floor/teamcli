import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import {
  rulesFileDifferences,
  rulesFileProblem,
} from '../src/commands/status.ts';
import {
  declaredRoots,
  entitiesLockPath,
  entitiesPath,
  entityRules,
  namesUniqueFor,
  planEntityRulesSet,
  writeEntityRulesSet,
} from '../src/entities.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Seat, TeamFile } from '../src/file/types.ts';
import {
  composedRulesOf,
  formatComposedRules,
  rulesOf,
} from '../src/launch/rules.ts';
import {
  checkRulesFile,
  rulesDeliveryOf,
  rulesFileHash,
  writeRulesFile,
} from '../src/launch/rules-file.ts';
import { readEntityPolicySource, writePolicySet } from '../src/policy/sources.ts';
import {
  get as getProject,
  homeProjectIdOf,
  list as listProjects,
  planProjectRulesSet,
  projectRules,
  projectsFile,
  setProjectRules,
  upsertProject,
  writeProjectRulesSet,
} from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import type { Standing } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

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
}): { team: TeamFile; worker: Seat; rawYaml: string } {
  const lines = [
    'format: 1',
    `project: ${opts.project ?? 'alpha'}`,
    'coordinator: orchestrator',
    'operator: orchestrator',
    `session: ${opts.project ?? 'alpha'}`,
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
    '    name: worker',
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
  const worker = team.seats.find((s) => s.name === 'worker')!;
  return { team, worker, rawYaml };
}

function verifiedStanding(rawYaml: string): Standing {
  return {
    kind: 'verified',
    record: {
      project: 'alpha',
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

describe('inherited entity-wide and project-wide rules', () => {
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
        '  beacon:',
        '    name: Beacon',
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
        '    name: alpha',
        `    path: ${teamRoot}`,
        '    project_id: beacon',
        `    projects: [beacon]`,
        '    registered_at: "2026-11-05T00:00:00Z"',
        '',
      ].join('\n'),
    );

    const { team, worker, rawYaml } = makeTeam({
      project: 'alpha',
      entity: 'acme-corp',
      inProject: 'Beacon',
      rules: ['Commit with Agent trailer.', 'Run inbox_check every turn.'],
    });

    const text = rulesOf(team, worker, teamRoot, undefined, 'file', home);
    expect(text).toContain('Entity rules (acme-corp):');
    expect(text).toContain(`- ${OWNER_NO_BLOCKING_RULE}`);
    expect(text).toContain('- Never force-push shared branches.');
    expect(text).toContain('Project rules (beacon):');
    expect(text).toContain('- Write red tests before implementation.');
    expect(text).toContain('Team rules:');
    expect(text).toContain('- Commit with Agent trailer.');
    expect(text).toContain('- Run inbox_check every turn.');

    const entityIdx = text.indexOf('Entity rules (acme-corp):');
    const entityRule1Idx = text.indexOf(`- ${OWNER_NO_BLOCKING_RULE}`);
    const entityRule2Idx = text.indexOf('- Never force-push shared branches.');
    const projectIdx = text.indexOf('Project rules (beacon):');
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
    const delivery = rulesDeliveryOf(standing, team, worker, teamRoot, home);
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
    const { team, worker } = makeTeam({
      project: 'alpha',
      entity: 'acme-corp',
      rules: [],
    });
    const text = rulesOf(team, worker, teamRoot, undefined, 'file', home);
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
        '  beacon:',
        '    name: Beacon',
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
        '    name: alpha',
        `    path: ${teamRoot}`,
        '    project_id: null',
        '    projects: []',
        '    registered_at: "2026-11-05T00:00:00Z"',
        '',
      ].join('\n'),
    );

    const { team, worker } = makeTeam({
      project: 'alpha',
      entity: 'acme-corp',
      inProject: null,
      rules: ['Team local rule.'],
    });

    expect(homeProjectIdOf(home, teamRoot, team)).toBeNull();
    const text = rulesOf(team, worker, teamRoot, undefined, 'file', home);
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
        '    name: alpha',
        `    path: ${teamRoot}`,
        '    project_id: home-proj',
        '    projects: [home-proj, served-proj]',
        '    registered_at: "2026-11-05T00:00:00Z"',
        '',
      ].join('\n'),
    );

    const { team, worker } = makeTeam({
      project: 'alpha',
      entity: 'acme-corp',
      inProject: 'HomeProj',
      rules: ['Team rule applies.'],
    });

    expect(homeProjectIdOf(home, teamRoot, team)).toBe('home-proj');
    const text = rulesOf(team, worker, teamRoot, undefined, 'file', home);
    expect(text).toContain('Project rules (home-proj):');
    expect(text).toContain('- Home project rule applies.');
    expect(text).not.toContain('served-proj');
    expect(text).not.toContain('Served project rule MUST NOT apply.');

    // Also when a team has NO home project (project_id: null) and only serves served-proj:
    writeTeamsYaml(
      [
        'teams:',
        `  ${id}:`,
        '    name: alpha',
        `    path: ${teamRoot}`,
        '    project_id: null',
        '    projects: [served-proj]',
        '    registered_at: "2026-11-05T00:00:00Z"',
        '',
      ].join('\n'),
    );
    const { team: unassignedTeam, worker: unassignedWorker } = makeTeam({
      project: 'alpha',
      entity: 'acme-corp',
      inProject: null,
      rules: ['Team rule applies.'],
    });
    expect(homeProjectIdOf(home, teamRoot, unassignedTeam)).toBeNull();
    const unassignedText = rulesOf(
      unassignedTeam,
      unassignedWorker,
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
        '  beacon:',
        '    name: Beacon',
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
        '    name: alpha',
        `    path: ${teamRoot}`,
        '    project_id: beacon',
        '    projects: [beacon]',
        '    registered_at: "2026-11-05T00:00:00Z"',
        '',
      ].join('\n'),
    );

    const { team, worker, rawYaml } = makeTeam({
      project: 'alpha',
      entity: 'acme-corp',
      inProject: 'Beacon',
      rules: ['Team rule.'],
    });
    const standing = verifiedStanding(rawYaml);

    // Write the initial rules file on disk for seat worker
    const initialDelivery = rulesDeliveryOf(standing, team, worker, teamRoot, home);
    expect('text' in initialDelivery).toBe(true);
    if (!('text' in initialDelivery)) return;
    const initialHash = rulesFileHash(initialDelivery.text);
    const wrote = writeRulesFile(
      standing,
      'worker',
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
    expect(rulesFileProblem(standing, team, worker, teamRoot, home)).toBeNull();
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

    const updatedDelivery = rulesDeliveryOf(standing, team, worker, teamRoot, home);
    expect('text' in updatedDelivery).toBe(true);
    if (!('text' in updatedDelivery)) return;
    const updatedHash = rulesFileHash(updatedDelivery.text);
    expect(updatedHash).not.toBe(initialHash);

    // Status and checkRulesFile report drift for worker
    const check = checkRulesFile(initialDelivery.path, updatedDelivery.text);
    expect(check.ok).toBe(false);
    const problem = rulesFileProblem(standing, team, worker, teamRoot, home);
    expect(problem).toContain("its rules file differs from the team file's rules");
    const diffs = rulesFileDifferences(standing, team, teamRoot, home);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.what).toContain('worker:');
    expect(diffs[0]?.what).toContain("its rules file differs from the team file's rules");
    expect(diffs[0]?.repair).toBe('team reload worker');
  });

  test('5. owner writes entity and project rules with --dry-run and applies them', async () => {
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
        '  beacon:',
        '    name: Beacon',
        '    entity: acme-corp',
        '    teams: []',
        '',
      ].join('\n'),
    );

    // Dry-run via programmatic planner
    const entityPlan = planEntityRulesSet(home, 'acme-corp', [OWNER_NO_BLOCKING_RULE]);
    expect(entityPlan.diff).toContain(OWNER_NO_BLOCKING_RULE);
    expect(entityRules(home, 'acme-corp')).toEqual([]);

    const projectPlan = planProjectRulesSet(home, 'beacon', ['Write red tests first.']);
    expect(projectPlan.diff).toContain('Write red tests first.');
    expect(projectRules(home, 'beacon')).toEqual([]);

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

    // Dry-run via CLI `team config set project.beacon.rules ... --dry-run`
    const projDryIo = testIo(teamRoot, { kind: 'owner' });
    const projDryCode = await runConfig(
      ['set', 'project.beacon.rules', '["Write red tests first."]', '--dry-run'],
      projDryIo,
      { home },
    );
    expect(projDryCode).toBe(0);
    expect(projDryIo.out).toContain('Write red tests first.');
    expect(projectRules(home, 'beacon')).toEqual([]);

    // Apply project rules via CLI `team config set project.beacon.rules`
    const projApplyIo = testIo(teamRoot, { kind: 'owner' });
    const projApplyCode = await runConfig(
      ['set', 'project.beacon.rules', '["Write red tests first."]'],
      projApplyIo,
      { home },
    );
    expect(projApplyCode).toBe(0);
    expect(projectRules(home, 'beacon')).toEqual(['Write red tests first.']);

    // Read back via CLI `team config get <entity>.rules` and `team config get project.<id>.rules`
    const getEntityIo = testIo(teamRoot, { kind: 'owner' });
    expect(await runConfig(['get', 'acme-corp.rules'], getEntityIo, { home })).toBe(0);
    expect(getEntityIo.out).toContain(OWNER_NO_BLOCKING_RULE);

    const getProjectIo = testIo(teamRoot, { kind: 'owner' });
    expect(await runConfig(['get', 'project.beacon.rules'], getProjectIo, { home })).toBe(0);
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

    const wroteProject = writeProjectRulesSet(home, 'beacon', [
      'Write red tests first.',
      'Document launch.md.',
    ]);
    expect(wroteProject.written).toBe(true);
    expect(projectRules(home, 'beacon')).toEqual([
      'Write red tests first.',
      'Document launch.md.',
    ]);

    // Non-owner is rejected
    const nonOwnerIo = testIo(teamRoot, { kind: 'seat', name: 'worker', pane: 'pane1' });
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
        '  beacon:',
        '    name: Beacon',
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
        '    name: alpha',
        `    path: ${teamRoot}`,
        '    project_id: beacon',
        '    projects: [beacon]',
        '    registered_at: "2026-11-05T00:00:00Z"',
        '',
      ].join('\n'),
    );

    const { team, worker } = makeTeam({
      project: 'alpha',
      entity: 'acme-corp',
      inProject: 'Beacon',
      rules: ['Commit with Agent trailer.'],
    });

    const composed = composedRulesOf(team, worker, teamRoot, undefined, 'file', home);
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
        source: 'beacon',
        rule: 'Write red tests before implementation.',
      },
    ]);
    expect(teamEntries).toEqual([
      {
        origin: 'team',
        source: 'alpha',
        rule: 'Commit with Agent trailer.',
      },
    ]);

    const view = formatComposedRules(team, worker, teamRoot, undefined, home);
    expect(view).toContain('Entity rules (acme-corp):');
    expect(view).toContain(OWNER_NO_BLOCKING_RULE);
    expect(view).toContain('Project rules (beacon):');
    expect(view).toContain('Write red tests before implementation.');
    expect(view).toContain('Team rules (alpha):');
    expect(view).toContain('Commit with Agent trailer.');
  });

  test('7. concurrent upsertProject and project rules write serialize on projects.yaml.lock and lose neither update', async () => {
    upsertProject(home, 'beacon', {
      name: 'Beacon',
      entity: 'acme-corp',
      lead: null,
      teams: [],
      by: 'owner',
      at: '2026-11-05T00:00:00Z',
    });

    // Simulate an in-flight upsertProject holding `projects.yaml.lock`: while the lock is held,
    // a background worker updates `lead` and `teams` on disk and then releases `projects.yaml.lock`.
    // Meanwhile, `team config set project.beacon.rules` must wait on `projects.yaml.lock`, re-read
    // `projects.yaml` under the lock after the concurrent writer finishes, and write `rules`
    // without clobbering `lead` or `teams`.
    const path = projectsFile(home);
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });

    const concurrentText = [
      'projects:',
      '  beacon:',
      '    name: Beacon',
      '    entity: acme-corp',
      '    lead: agent-lead-01',
      '    teams: [team-a]',
      '    provenance: { registered_by: owner, registered_at: "2026-11-05T00:00:00Z", updated_at: "2026-11-05T00:00:01Z" }',
      '',
    ].join('\n');

    const workerScript = `
      import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
      setTimeout(() => {
        const tmp = ${JSON.stringify(`${path}.worker.tmp`)};
        writeFileSync(tmp, ${JSON.stringify(concurrentText)}, { mode: 0o600 });
        renameSync(tmp, ${JSON.stringify(path)});
        unlinkSync(${JSON.stringify(lockPath)});
        self.postMessage('released');
      }, 45);
    `;
    const blobUrl = URL.createObjectURL(
      new Blob([workerScript], { type: 'application/javascript' }),
    );
    const worker = new globalThis.Worker(blobUrl);
    const workerDone = new Promise<void>((resolve) => {
      worker.addEventListener('message', () => resolve());
    });

    try {
      const cliIo = testIo(teamRoot, { kind: 'owner' });
      const code = await runConfig(
        ['set', 'project.beacon.rules', '["Keep locks on every write.", "Re-read under the lock."]'],
        cliIo,
        { home },
      );
      expect(code).toBe(0);
      await workerDone;
    } finally {
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
      try {
        unlinkSync(lockPath);
      } catch {}
    }

    // Neither the concurrent upsertProject fields (`lead`, `teams`) nor the CLI rules write was lost:
    upsertTeam(home, 'team-a', {
      project: 'team-a',
      session: 'team-a',
      root: teamRoot,
      projectId: 'beacon',
    });
    const afterCli = getProject(home, 'beacon');
    expect(afterCli).not.toBeNull();
    expect(afterCli?.lead).toBe('agent-lead-01');
    expect(afterCli?.teams).toEqual(['team-a']);
    expect(afterCli?.rules).toEqual([
      'Keep locks on every write.',
      'Re-read under the lock.',
    ]);
    expect(projectRules(home, 'beacon')).toEqual([
      'Keep locks on every write.',
      'Re-read under the lock.',
    ]);

    // Subsequent `upsertProject` preserves `rules`, and `setProjectRules` preserves `upsertProject`:
    upsertTeam(home, 'team-b', {
      project: 'team-b',
      session: 'team-b',
      root: teamRoot,
      projectId: 'beacon',
    });
    upsertProject(home, 'beacon', {
      teams: ['team-a', 'team-b'],
      at: '2026-11-05T00:00:02Z',
    });
    expect(getProject(home, 'beacon')?.rules).toEqual([
      'Keep locks on every write.',
      'Re-read under the lock.',
    ]);

    setProjectRules(home, 'beacon', [
      'Keep locks on every write.',
      'Re-read under the lock.',
      'Never drop sibling fields.',
    ]);
    const finalRecord = getProject(home, 'beacon');
    expect(finalRecord?.lead).toBe('agent-lead-01');
    expect(finalRecord?.teams).toEqual(['team-a', 'team-b']);
    expect(finalRecord?.rules).toEqual([
      'Keep locks on every write.',
      'Re-read under the lock.',
      'Never drop sibling fields.',
    ]);
    expect(readFileSync(path, 'utf8')).toContain('Never drop sibling fields.');
  });

  test('8. setting project.<DisplayName>.rules and project.<id>.rules write the same record in projects.yaml', async () => {
    upsertProject(home, 'teamcli', {
      name: 'TeamCLI',
      entity: 'acme-corp',
      lead: null,
      teams: [],
      by: 'owner',
      at: '2026-11-05T00:00:00Z',
    });

    // Write via CLI using display name `project.TeamCLI.rules`
    const setByDisplayIo = testIo(teamRoot, { kind: 'owner' });
    const setByDisplayCode = await runConfig(
      ['set', 'project.TeamCLI.rules', '["Resolve display name to record id."]'],
      setByDisplayIo,
      { home },
    );
    expect(setByDisplayCode).toBe(0);
    expect(listProjects(home)).toHaveLength(1);
    expect(getProject(home, 'teamcli')?.rules).toEqual(['Resolve display name to record id.']);
    expect(projectRules(home, 'teamcli')).toEqual(['Resolve display name to record id.']);
    expect(projectRules(home, 'TeamCLI')).toEqual(['Resolve display name to record id.']);

    // Read back via CLI by display name and by id
    const getByDisplayIo = testIo(teamRoot, { kind: 'owner' });
    expect(await runConfig(['get', 'project.TeamCLI.rules'], getByDisplayIo, { home })).toBe(0);
    expect(getByDisplayIo.out).toContain('Resolve display name to record id.');

    const getByIdIo = testIo(teamRoot, { kind: 'owner' });
    expect(await runConfig(['get', 'project.teamcli.rules'], getByIdIo, { home })).toBe(0);
    expect(getByIdIo.out).toContain('Resolve display name to record id.');

    // Now write via CLI using record id `project.teamcli.rules` — updates the exact same record
    const setByIdIo = testIo(teamRoot, { kind: 'owner' });
    const setByIdCode = await runConfig(
      [
        'set',
        'project.teamcli.rules',
        '["Resolve display name to record id.", "One locked writer for project rules."]',
      ],
      setByIdIo,
      { home },
    );
    expect(setByIdCode).toBe(0);
    expect(listProjects(home)).toHaveLength(1);
    expect(getProject(home, 'teamcli')?.rules).toEqual([
      'Resolve display name to record id.',
      'One locked writer for project rules.',
    ]);

    const getAfterIo = testIo(teamRoot, { kind: 'owner' });
    expect(await runConfig(['get', 'project.TeamCLI.rules'], getAfterIo, { home })).toBe(0);
    expect(getAfterIo.out).toContain('One locked writer for project rules.');
  });

  test('9. two interleaved writers to entities.yaml serialize on entities.yaml.lock and keep both updates', async () => {
    writeEntitiesYaml(
      [
        'entities:',
        '  acme-corp:',
        '    name: Acme Corp',
        '    roots:',
        '      - /tmp/acme-root',
        '',
      ].join('\n'),
    );

    const path = entitiesPath(home);
    const lockPath = entitiesLockPath(home);
    writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });

    const concurrentEntityText = [
      'entities:',
      '  acme-corp:',
      '    name: Acme Corp',
      '    roots:',
      '      - /tmp/acme-root',
      '    names:',
      '      unique: project',
      '',
    ].join('\n');

    const workerScript = `
      import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
      setTimeout(() => {
        const tmp = ${JSON.stringify(`${path}.worker.tmp`)};
        writeFileSync(tmp, ${JSON.stringify(concurrentEntityText)}, { mode: 0o600 });
        renameSync(tmp, ${JSON.stringify(path)});
        unlinkSync(${JSON.stringify(lockPath)});
        self.postMessage('released');
      }, 45);
    `;
    const blobUrl = URL.createObjectURL(
      new Blob([workerScript], { type: 'application/javascript' }),
    );
    const worker = new globalThis.Worker(blobUrl);
    const workerDone = new Promise<void>((resolve) => {
      worker.addEventListener('message', () => resolve());
    });

    try {
      const cliIo = testIo(teamRoot, { kind: 'owner' });
      const code = await runConfig(
        ['set', 'acme-corp.rules', JSON.stringify([OWNER_NO_BLOCKING_RULE, 'Hold entities.yaml.lock on every write.'])],
        cliIo,
        { home },
      );
      expect(code).toBe(0);
      await workerDone;
    } finally {
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
      try {
        unlinkSync(lockPath);
      } catch {}
    }

    // Both the worker's `names.unique: project` update and the CLI's `rules` update landed:
    expect(namesUniqueFor(home, 'acme-corp')).toBe('project');
    expect(declaredRoots(home).get('acme-corp')).toEqual(['/tmp/acme-root']);
    expect(entityRules(home, 'acme-corp')).toEqual([
      OWNER_NO_BLOCKING_RULE,
      'Hold entities.yaml.lock on every write.',
    ]);

    // Interleaved `writePolicySet` at entity level and `writeEntityRulesSet` also serialize on
    // `entities.yaml.lock` and keep policies, rules, roots, and names.unique intact:
    writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
    const afterRulesText = readFileSync(path, 'utf8');
    const workerScript2 = `
      import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
      setTimeout(() => {
        const tmp = ${JSON.stringify(`${path}.worker2.tmp`)};
        writeFileSync(tmp, ${JSON.stringify(afterRulesText)}, { mode: 0o600 });
        renameSync(tmp, ${JSON.stringify(path)});
        unlinkSync(${JSON.stringify(lockPath)});
        self.postMessage('released');
      }, 45);
    `;
    const blobUrl2 = URL.createObjectURL(
      new Blob([workerScript2], { type: 'application/javascript' }),
    );
    const worker2 = new globalThis.Worker(blobUrl2);
    const workerDone2 = new Promise<void>((resolve) => {
      worker2.addEventListener('message', () => resolve());
    });

    try {
      const policyPlan = writePolicySet(home, {
        level: 'entity',
        target: 'acme-corp',
        name: 'dev-mode',
        value: 'off',
      });
      expect(policyPlan.ok).toBe(true);
      await workerDone2;
    } finally {
      worker2.terminate();
      URL.revokeObjectURL(blobUrl2);
      try {
        unlinkSync(lockPath);
      } catch {}
    }

    // Now write rules via `writeEntityRulesSet` after `writePolicySet` and verify both survive:
    writeEntityRulesSet(home, 'acme-corp', [
      OWNER_NO_BLOCKING_RULE,
      'Hold entities.yaml.lock on every write.',
      'Entity policy and rules coexist cleanly.',
    ]);

    expect(entityRules(home, 'acme-corp')).toEqual([
      OWNER_NO_BLOCKING_RULE,
      'Hold entities.yaml.lock on every write.',
      'Entity policy and rules coexist cleanly.',
    ]);
    expect(namesUniqueFor(home, 'acme-corp')).toBe('project');
    expect(declaredRoots(home).get('acme-corp')).toEqual(['/tmp/acme-root']);
    const policyRead = readEntityPolicySource(home, 'acme-corp');
    expect(policyRead.ok).toBe(true);
    if (policyRead.ok) {
      expect(policyRead.policies).toHaveLength(1);
      expect(policyRead.policies[0]?.name).toBe('dev-mode');
      expect(policyRead.policies[0]?.value).toBe('off');
    }
  });
});
