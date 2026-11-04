// The five sidebar words (the sidebar-metadata design of 2026-11-04): their catalogue entries —
// names, aliases, defaults, vocabularies, bounds and the chain each word forms — and the reader
// that resolves all five at once, with the host cap clamping the ttl and the release defaults
// standing in for anything the chain cannot say.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { DEFAULT_SIDEBAR_ROWS, SIDEBAR_TTL_CAP_MS } from '../src/herdr.ts';
import { normalizePolicyName, POLICY_CATALOGUE, resolvePolicy, sidebarRowsOf, writePolicySet } from '../src/policy/index.ts';
import { sidebarPolicy, type SidebarPolicy } from '../src/settings/sidebar-policy.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';

const NOW = new Date('2026-11-04T12:00:00Z');

const TEAM_YAML = `format: 1
entity: floor
project: acme
session: acme-dev
coordinator: crew-lead
operator: crew-lead
workspace:
  mode: shared
seats:
  - name: crew-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    leads: true
`;

type World = { root: string; home: string; team: TeamFile };

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-sidebar-policy-')));
  dirs.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const root = join(base, 'repo');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);

  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    entity: 'floor',
    session: 'acme-dev',
    root,
    roster: [{ agent: 'agt_crewlead0000', seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });

  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return { root, home, team: validated.team };
}

const DEFAULTS: SidebarPolicy = {
  rows: DEFAULT_SIDEBAR_ROWS,
  indicators: 'symbols',
  manage: true,
  ttlMs: SIDEBAR_TTL_CAP_MS,
  refreshMs: 21_600_000,
};

describe('the workspace.sidebar.rows entry', () => {
  test('carries the default layout, the three word shapes, and refuses unknown or duplicate tokens', () => {
    const spec = POLICY_CATALOGUE['workspace.sidebar.rows'];
    expect(spec.kind).toBe('enforced');
    expect(spec.levels).toEqual(['entity', 'project', 'team']);
    expect(spec.defaultValue).toBe('state_icon,machine,workspace,tab;state_text,agent');
    expect(normalizePolicyName('sidebar-rows')).toBe('workspace.sidebar.rows');
    expect(normalizePolicyName('workspace_sidebar_rows')).toBe('workspace.sidebar.rows');

    // The canonical string, the YAML natural list of token lists, and a list of row strings.
    expect(spec.parseValue('state_icon,agent;machine')).toBe('state_icon,agent;machine');
    expect(spec.parseValue([['state_icon', 'agent'], ['machine']])).toBe('state_icon,agent;machine');
    expect(spec.parseValue(['state_icon,agent', 'machine'])).toBe('state_icon,agent;machine');
    // Tokens outside the host vocabulary, an empty token, and a duplicated token are refused.
    expect(spec.parseValue('state_icon,bogus')).toBeNull();
    expect(spec.parseValue('state_icon,,agent')).toBeNull();
    expect(spec.parseValue('state_icon,state_icon')).toBeNull();
    expect(spec.parseValue([])).toBeNull();
    expect(spec.parseValue('bogus')).toBeNull();
    expect(spec.valueProblem?.('state_icon,bogus')).toContain('no sidebar token "bogus"');
    expect(spec.valueProblem?.('state_icon,bogus')).toContain('state_icon, machine, workspace, tab, state_text, agent');

    // A canonical word reads back as its rows.
    expect(sidebarRowsOf('state_icon,agent;machine')).toEqual([['state_icon', 'agent'], ['machine']]);
    expect(sidebarRowsOf('bogus')).toBeNull();

    // The layout is presentation: the nearest level's word is the layout, whatever it is.
    const nearest = resolvePolicy('workspace.sidebar.rows', [
      { name: 'workspace.sidebar.rows', value: 'state_icon,agent', level: 'entity', setter: 'owner', date: '2026-11-04T10:00:00Z', kind: 'enforced' },
      { name: 'workspace.sidebar.rows', value: 'agent', level: 'team', setter: 'owner', date: '2026-11-04T11:00:00Z', kind: 'enforced' },
    ]);
    expect(nearest.ok).toBe(true);
    if (nearest.ok) expect(nearest.effective.value).toBe('agent');

    // A seat never sets a machine-wide layout.
    const seatLevel = resolvePolicy('workspace.sidebar.rows', [
      { name: 'workspace.sidebar.rows', value: 'agent', level: 'seat', setter: 'owner', date: '2026-11-04T11:00:00Z', kind: 'enforced' },
    ]);
    expect(seatLevel.ok).toBe(false);
  });
});

describe('the workspace.sidebar.manage entry', () => {
  test('defaults on, and a lower level may switch managing off but never back on', () => {
    const spec = POLICY_CATALOGUE['workspace.sidebar.manage'];
    expect(spec.defaultValue).toBe('on');
    expect(normalizePolicyName('sidebar-manage')).toBe('workspace.sidebar.manage');

    const off = resolvePolicy('workspace.sidebar.manage', [
      { name: 'workspace.sidebar.manage', value: 'on', level: 'entity', setter: 'owner', date: '2026-11-04T10:00:00Z', kind: 'enforced' },
      { name: 'workspace.sidebar.manage', value: 'off', level: 'team', setter: 'owner', date: '2026-11-04T11:00:00Z', kind: 'enforced' },
    ]);
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.effective.value).toBe('off');

    const backOn = resolvePolicy('workspace.sidebar.manage', [
      { name: 'workspace.sidebar.manage', value: 'off', level: 'entity', setter: 'owner', date: '2026-11-04T10:00:00Z', kind: 'enforced' },
      { name: 'workspace.sidebar.manage', value: 'on', level: 'team', setter: 'owner', date: '2026-11-04T11:00:00Z', kind: 'enforced' },
    ]);
    expect(backOn.ok).toBe(false);
    if (!backOn.ok) expect(backOn.refusals[0]).toMatchObject({ kind: 'loosening', policy: 'workspace.sidebar.manage' });
  });
});

describe('the workspace.sidebar.status_indicators entry', () => {
  test('takes the host vocabulary only, defaulting to symbols', () => {
    const spec = POLICY_CATALOGUE['workspace.sidebar.status_indicators'];
    expect(spec.defaultValue).toBe('symbols');
    expect(spec.parseValue('dots')).toBe('dots');
    expect(spec.parseValue('symbols')).toBe('symbols');
    expect(spec.parseValue('bogus')).toBeNull();
    expect(spec.valueProblem?.('bogus')).toContain('dots or symbols');
    expect(normalizePolicyName('sidebar-status-indicators')).toBe('workspace.sidebar.status_indicators');
  });
});

describe('the daemon.sidebar timing entries', () => {
  test('the ttl word has no ceiling at set; the host cap clamps at the reader', () => {
    const spec = POLICY_CATALOGUE['daemon.sidebar-ttl-ms'];
    expect(spec.defaultValue).toBe(86_400_000);
    expect(spec.parseValue('3600000')).toBe(3_600_000);
    expect(spec.parseValue(1_000)).toBe(1_000);
    // A word above the host cap is a valid word: a stored word stays readable when a future
    // host raises the cap, and the reader clamps what is sent.
    expect(spec.parseValue(200_000_000)).toBe(200_000_000);
    expect(spec.parseValue(999)).toBeNull();
    expect(spec.parseValue('2.5')).toBeNull();
    expect(spec.valueProblem?.(999)).toContain('from 1000 up');
    expect(normalizePolicyName('sidebar-ttl-ms')).toBe('daemon.sidebar-ttl-ms');

    const loosened = resolvePolicy('daemon.sidebar-ttl-ms', [
      { name: 'daemon.sidebar-ttl-ms', value: 3_600_000, level: 'entity', setter: 'owner', date: '2026-11-04T10:00:00Z', kind: 'enforced' },
      { name: 'daemon.sidebar-ttl-ms', value: 7_200_000, level: 'team', setter: 'owner', date: '2026-11-04T11:00:00Z', kind: 'enforced' },
    ]);
    expect(loosened.ok).toBe(false);
  });

  test('the refresh word is bounded from one minute to seven days', () => {
    const spec = POLICY_CATALOGUE['daemon.sidebar-refresh-ms'];
    expect(spec.defaultValue).toBe(21_600_000);
    expect(spec.parseValue(60_000)).toBe(60_000);
    expect(spec.parseValue(604_800_000)).toBe(604_800_000);
    expect(spec.parseValue(59_999)).toBeNull();
    expect(spec.parseValue(604_800_001)).toBeNull();
    expect(spec.valueProblem?.(30_000)).toContain('from 60000 to 604800000');
    expect(normalizePolicyName('sidebar-refresh-ms')).toBe('daemon.sidebar-refresh-ms');
  });
});

describe('the sidebar reader', () => {
  test('no team and no word leave every release default in force', () => {
    expect(sidebarPolicy({ home: '/nowhere', root: '/nowhere', team: null, now: NOW })).toEqual(DEFAULTS);
    const world = makeWorld();
    expect(sidebarPolicy({ home: world.home, root: world.root, team: world.team, now: NOW })).toEqual(DEFAULTS);
  });

  test('one chain read fills all five words', () => {
    const world = makeWorld();
    expect(writePolicySet(world.home, { level: 'team', target: world.root, teamRoot: world.root, name: 'workspace.sidebar.rows', value: [['agent'], ['state_text']] }, { now: NOW }).ok).toBe(true);
    expect(writePolicySet(world.home, { level: 'team', target: world.root, teamRoot: world.root, name: 'workspace.sidebar.manage', value: 'off' }, { now: NOW }).ok).toBe(true);
    expect(writePolicySet(world.home, { level: 'team', target: world.root, teamRoot: world.root, name: 'workspace.sidebar.status_indicators', value: 'dots' }, { now: NOW }).ok).toBe(true);
    expect(writePolicySet(world.home, { level: 'team', target: world.root, teamRoot: world.root, name: 'daemon.sidebar-ttl-ms', value: 200_000_000 }, { now: NOW }).ok).toBe(true);
    expect(writePolicySet(world.home, { level: 'team', target: world.root, teamRoot: world.root, name: 'daemon.sidebar-refresh-ms', value: '3600000' }, { now: NOW }).ok).toBe(true);

    const read = sidebarPolicy({ home: world.home, root: world.root, team: world.team, now: NOW });
    // The YAML natural rows list reads the same as the word.
    expect(read.rows).toEqual([['agent'], ['state_text']]);
    expect(read.manage).toBe(false);
    expect(read.indicators).toBe('dots');
    // A ttl above the host cap is clamped to it, never refused at set.
    expect(read.ttlMs).toBe(SIDEBAR_TTL_CAP_MS);
    expect(read.refreshMs).toBe(3_600_000);
  });

  test('a chain that cannot be ordered keeps the release defaults', () => {
    const world = makeWorld();
    expect(writePolicySet(world.home, { level: 'entity', target: 'floor', name: 'workspace.sidebar.manage', value: 'off' }, { now: NOW }).ok).toBe(true);
    expect(writePolicySet(world.home, { level: 'team', target: world.root, teamRoot: world.root, name: 'workspace.sidebar.manage', value: 'on' }, { now: NOW }).ok).toBe(true);
    // The team word loosens the entity word, so the whole chain refuses and the defaults stand.
    expect(sidebarPolicy({ home: world.home, root: world.root, team: world.team, now: NOW })).toEqual(DEFAULTS);
  });
});
