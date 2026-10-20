// Policies rule 10 across an entity: the breach listing, donor ranking and visibility, and the
// read that fails closed on an unverifiable rule.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entitiesPath } from '../src/entities.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { teamIdOf, teamsFile, upsertTeam } from '../src/registry/teams.ts';
import { listModelRuleBreaches } from '../src/swap/rule.ts';

type SeatLine = {
  role: string;
  name: string;
  cli?: string;
  vendor: string;
  model?: string;
  version?: string;
  launch?: string;
  leads?: boolean;
};

const NOW = new Date('2026-10-19T09:00:00Z');

function teamYaml(project: string, entity: string | null, visibility: string, seats: SeatLine[]): string {
  const lines = ['format: 1', `project: ${project}`];
  if (entity) lines.push(`entity: ${entity}`);
  lines.push(`visibility: ${visibility}`, 'operator: ' + seats[0]!.name, 'workspace:', '  mode: shared', 'seats:');
  for (const seat of seats) {
    lines.push(`  - role: ${seat.role}`);
    lines.push(`    name: ${seat.name}`);
    lines.push(`    cli: ${seat.cli ?? 'claude-code'}`);
    lines.push(`    vendor: ${seat.vendor}`);
    lines.push(`    model: ${seat.model ?? 'Model'}`);
    lines.push(`    version: "${seat.version ?? '1.0'}"`);
    lines.push(`    launch: ${seat.launch ?? 'claude --model model-1'}`);
    if (seat.leads) lines.push('    leads: true');
  }
  return `${lines.join('\n')}\n`;
}

let base: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-model-rule-')));
  home = join(base, 'home');
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function makeTeam(folder: string, yaml: string): { root: string; file: string } {
  const root = join(base, folder);
  mkdirSync(join(root, '.agents'), { recursive: true });
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, yaml);
  return { root, file };
}

function load(root: string) {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return loaded.team;
}

function setRule(value: string, target = 'lab'): void {
  const wrote = writePolicySet(home, { level: 'entity', target, name: 'model-rule', value }, { now: NOW });
  if (!wrote.ok) throw new Error(wrote.why);
}

function register(root: string, project: string, entity: string | null): string {
  const id = teamIdOf(root);
  upsertTeam(home, id, { project, session: project, root, entity, lifecycle: 'running', by: 'owner' });
  return id;
}

describe('the model rule across the entity', () => {
  test('lists a breaching seat and proposes a same-team, same-CLI donor', () => {
    const alpha = makeTeam('alpha', teamYaml('alpha', 'lab', 'private', [
      { role: 'coordinator', name: 'lead', vendor: 'anthropic', leads: true },
      { role: 'implementer', name: 'worker', vendor: 'deepseek', model: 'DeepSeek Flash' },
    ]));
    register(alpha.root, 'alpha', 'lab');
    setRule('*=!anthropic');
    const lookup = listModelRuleBreaches({ home, team: load(alpha.root), root: alpha.root, teamId: teamIdOf(alpha.root) });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.listing.entity).toBe('lab');
    expect(lookup.listing.rule).toBe('*=!anthropic');
    expect(lookup.listing.breaches.map((breach) => breach.seat.name)).toEqual(['lead']);
    const breach = lookup.listing.breaches[0]!;
    expect(breach.proposal?.donor).toEqual({ team: 'alpha', root: alpha.root, seat: 'worker' });
    expect(breach.proposal?.recipe).toMatchObject({ cli: 'claude-code', vendor: 'deepseek', model: 'DeepSeek Flash' });
  });

  test('a same-CLI donor in the same team wins over another CLI there', () => {
    const alpha = makeTeam('alpha', teamYaml('alpha', 'lab', 'private', [
      { role: 'coordinator', name: 'lead', vendor: 'anthropic', leads: true },
      { role: 'implementer', name: 'codex-worker', cli: 'codex', vendor: 'openai' },
      { role: 'implementer', name: 'claude-worker', cli: 'claude-code', vendor: 'google' },
    ]));
    setRule('lead=deepseek+google');
    const lookup = listModelRuleBreaches({ home, team: load(alpha.root), root: alpha.root });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.listing.breaches).toHaveLength(1);
    expect(lookup.listing.breaches[0]!.proposal?.donor.seat).toBe('claude-worker');
  });

  test('a public team draws no recipe from a private team and says why when none is left', () => {
    const alpha = makeTeam('alpha', teamYaml('alpha', 'lab', 'public', [
      { role: 'coordinator', name: 'lead', vendor: 'anthropic', leads: true },
    ]));
    const beta = makeTeam('beta', teamYaml('beta', 'lab', 'private', [
      { role: 'implementer', name: 'helper', vendor: 'deepseek' },
    ]));
    register(beta.root, 'beta', 'lab');
    setRule('*=!anthropic');
    const lookup = listModelRuleBreaches({ home, team: load(alpha.root), root: alpha.root });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.listing.breaches).toHaveLength(1);
    expect(lookup.listing.breaches[0]!.proposal).toBeNull();
    expect(lookup.listing.breaches[0]!.reason).toContain('public team');
  });

  test('another public team of the entity is a donor when the same team has none', () => {
    const alpha = makeTeam('alpha', teamYaml('alpha', 'lab', 'public', [
      { role: 'coordinator', name: 'lead', vendor: 'anthropic', leads: true },
    ]));
    const beta = makeTeam('beta', teamYaml('beta', 'lab', 'public', [
      { role: 'implementer', name: 'helper', vendor: 'deepseek', leads: true },
    ]));
    register(beta.root, 'beta', 'lab');
    setRule('*=!anthropic');
    const lookup = listModelRuleBreaches({ home, team: load(alpha.root), root: alpha.root });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.listing.breaches[0]!.proposal?.donor).toMatchObject({ team: 'beta', seat: 'helper' });
  });

  test('a registry record whose file moved to another entity is named, not read', () => {
    const alpha = makeTeam('alpha', teamYaml('alpha', 'lab', 'private', [
      { role: 'coordinator', name: 'lead', vendor: 'anthropic', leads: true },
    ]));
    const moved = makeTeam('moved', teamYaml('moved', 'other', 'private', [
      { role: 'implementer', name: 'x', vendor: 'deepseek', leads: true },
    ]));
    register(moved.root, 'moved', 'lab');
    setRule('*=!anthropic');
    const lookup = listModelRuleBreaches({ home, team: load(alpha.root), root: alpha.root });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.listing.teams.map((team) => team.name)).toEqual(['alpha']);
    expect(lookup.listing.ignored).toHaveLength(1);
    expect(lookup.listing.ignored[0]!.root).toBe(moved.root);
    expect(lookup.listing.ignored[0]!.why).toContain('entity "other"');
  });

  test('a team with no entity has no rule and no breach', () => {
    const alpha = makeTeam('alpha', teamYaml('alpha', null, 'private', [
      { role: 'coordinator', name: 'lead', vendor: 'anthropic', leads: true },
    ]));
    const lookup = listModelRuleBreaches({ home, team: load(alpha.root), root: alpha.root });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.listing).toMatchObject({ entity: null, rule: '', breaches: [] });
  });

  test('a tampered entity policy file refuses the read rather than reading no rule', () => {
    const alpha = makeTeam('alpha', teamYaml('alpha', 'lab', 'private', [
      { role: 'coordinator', name: 'lead', vendor: 'anthropic', leads: true },
    ]));
    setRule('*=!anthropic');
    const path = entitiesPath(home);
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.replace('*=!anthropic', '*=anthropic'));
    const lookup = listModelRuleBreaches({ home, team: load(alpha.root), root: alpha.root });
    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.why).toContain('cannot be read or verified');
  });

  test('a team registry that cannot be read refuses the entity-wide read', () => {
    const alpha = makeTeam('alpha', teamYaml('alpha', 'lab', 'private', [
      { role: 'coordinator', name: 'lead', vendor: 'anthropic', leads: true },
    ]));
    setRule('*=!anthropic');
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(teamsFile(home), 'teams: [not a map]\n');
    const lookup = listModelRuleBreaches({ home, team: load(alpha.root), root: alpha.root });
    expect(lookup.ok).toBe(false);
    if (lookup.ok) return;
    expect(lookup.why).toContain('team registry cannot be read');
  });
});
