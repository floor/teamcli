import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TeamFile } from '../src/file/types.ts';
import { projectIdOfTeam } from '../src/dev_mode.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { DEFAULT_SIDEBAR_ROWS, SIDEBAR_TTL_CAP_MS } from '../src/herdr.ts';
import {
  loadAndResolvePolicyChain,
  normalizePolicyName,
  POLICY_CATALOGUE,
  resolvePolicy,
  writePolicySet,
  type CataloguePolicyName,
} from '../src/policy/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { sidebarPolicy, type SidebarPolicy } from '../src/settings/sidebar-policy.ts';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const ONE_MINUTE_MS = 60_000;
const SEVEN_DAYS_MS = 604_800_000;
const SIX_HOURS_MS = 21_600_000;

const FIVE_SIDEBAR_WORDS: readonly {
  name: CataloguePolicyName;
  aliases: readonly string[];
  sampleValidValue: unknown;
}[] = [
  {
    name: 'workspace.sidebar.rows',
    aliases: ['workspace_sidebar_rows', 'workspace-sidebar-rows', 'sidebar_rows', 'sidebar-rows'],
    sampleValidValue: 'state_icon,agent;state_text,tab',
  },
  {
    name: 'workspace.sidebar.manage',
    aliases: ['workspace_sidebar_manage', 'workspace-sidebar-manage', 'sidebar_manage', 'sidebar-manage'],
    sampleValidValue: 'off',
  },
  {
    name: 'workspace.sidebar.status_indicators',
    aliases: [
      'workspace_sidebar_status_indicators',
      'workspace-sidebar-status-indicators',
      'sidebar_status_indicators',
      'sidebar-status-indicators',
    ],
    sampleValidValue: 'dots',
  },
  {
    name: 'daemon.sidebar-ttl-ms',
    aliases: ['daemon_sidebar_ttl_ms', 'daemon-sidebar-ttl-ms', 'sidebar_ttl_ms', 'sidebar-ttl-ms'],
    sampleValidValue: 30_000,
  },
  {
    name: 'daemon.sidebar-refresh-ms',
    aliases: ['daemon_sidebar_refresh_ms', 'daemon-sidebar-refresh-ms', 'sidebar_refresh_ms', 'sidebar-refresh-ms'],
    sampleValidValue: 120_000,
  },
];

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

const DEFAULTS: SidebarPolicy = {
  rows: DEFAULT_SIDEBAR_ROWS,
  indicators: 'symbols',
  manage: true,
  ttlMs: SIDEBAR_TTL_CAP_MS,
  refreshMs: SIX_HOURS_MS,
};

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

function createWorld(): { root: string; home: string; team: TeamFile } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sidebar-slice2-ind-')));
  cleanupDirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
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

describe('sidebar slice 2 policy keys independent verification', () => {
  test('all five words are allowed at entity/project/team and refused below team level (seat)', () => {
    const world = createWorld();

    for (const entry of FIVE_SIDEBAR_WORDS) {
      const spec = POLICY_CATALOGUE[entry.name];
      expect(spec.kind).toBe('enforced');
      expect(spec.levels).toEqual(['entity', 'project', 'team']);
      expect(spec.levels).not.toContain('seat');

      for (const alias of entry.aliases) {
        expect(normalizePolicyName(alias)).toBe(entry.name);
      }

      // resolvePolicy refuses seat level with invalid-policy at level seat
      const seatResolved = resolvePolicy(entry.name, [
        {
          name: entry.name,
          value: spec.parseValue(entry.sampleValidValue) as never,
          level: 'seat',
          setter: 'owner',
          date: '2026-11-04T10:00:00Z',
          kind: 'enforced',
        },
      ]);
      expect(seatResolved.ok).toBe(false);
      if (!seatResolved.ok) {
        expect(seatResolved.refusals[0]).toMatchObject({
          kind: 'invalid-policy',
          policy: entry.name,
          level: 'seat',
        });
      }

      // writePolicySet refuses seat level before writing
      const seatWrite = writePolicySet(
        world.home,
        {
          level: 'seat',
          target: 'agt_crewlead0000',
          name: entry.name,
          value: entry.sampleValidValue,
        },
        { now: NOW },
      );
      expect(seatWrite.ok).toBe(false);
      if (!seatWrite.ok) {
        expect(seatWrite.why).toContain('seat');
      }
    }
  });

  test('workspace.sidebar.manage defaults to on and off is absolute across entity, project, and team', () => {
    const spec = POLICY_CATALOGUE['workspace.sidebar.manage'];
    expect(spec.defaultValue).toBe('on');
    expect(spec.parseValue('on')).toBe('on');
    expect(spec.parseValue('off')).toBe('off');
    expect(spec.parseValue(true)).toBe('on');
    expect(spec.parseValue(false)).toBe('off');
    for (const invalid of ['yes', 'no', 'true', 'false', 1, 0, null, 'auto']) {
      expect(spec.parseValue(invalid)).toBeNull();
    }

    // Allowed progressions: on -> on -> off, on -> off -> off
    const onToOff = resolvePolicy('workspace.sidebar.manage', [
      { name: 'workspace.sidebar.manage', value: 'on', level: 'entity', setter: 'owner', date: '2026-11-04T09:00:00Z', kind: 'enforced' },
      { name: 'workspace.sidebar.manage', value: 'off', level: 'project', setter: 'owner', date: '2026-11-04T10:00:00Z', kind: 'enforced' },
      { name: 'workspace.sidebar.manage', value: 'off', level: 'team', setter: 'owner', date: '2026-11-04T11:00:00Z', kind: 'enforced' },
    ]);
    expect(onToOff.ok).toBe(true);
    if (onToOff.ok) expect(onToOff.effective.value).toBe('off');

    // Disallowed loosenings: entity off -> project on, entity off -> team on, project off -> team on
    for (const [higherLevel, lowerLevel] of [
      ['entity', 'project'],
      ['entity', 'team'],
      ['project', 'team'],
    ] as const) {
      const loosened = resolvePolicy('workspace.sidebar.manage', [
        { name: 'workspace.sidebar.manage', value: 'off', level: higherLevel, setter: 'owner', date: '2026-11-04T09:00:00Z', kind: 'enforced' },
        { name: 'workspace.sidebar.manage', value: 'on', level: lowerLevel, setter: 'owner', date: '2026-11-04T10:00:00Z', kind: 'enforced' },
      ]);
      expect(loosened.ok).toBe(false);
      if (!loosened.ok) {
        expect(loosened.refusals[0]).toMatchObject({
          kind: 'loosening',
          policy: 'workspace.sidebar.manage',
          lowerLevel,
          higherLevel,
        });
      }
    }

    // End-to-end chain: entity off with no lower override resolves manage: false in sidebarPolicy
    const world = createWorld();
    const projectId = projectIdOfTeam(world.home, world.team, world.root)!;
    expect(
      writePolicySet(world.home, { level: 'entity', target: 'floor', name: 'workspace.sidebar.manage', value: 'off' }, { now: NOW }).ok,
    ).toBe(true);
    expect(sidebarPolicy({ home: world.home, root: world.root, team: world.team, now: NOW }).manage).toBe(false);

    // If project attempts to turn manage back on, chain resolution fails and sidebarPolicy falls back to DEFAULTS
    expect(
      writePolicySet(world.home, { level: 'project', target: projectId, name: 'workspace.sidebar.manage', value: 'on' }, { now: NOW }).ok,
    ).toBe(true);
    const chain = loadAndResolvePolicyChain(
      { home: world.home, projectId, teamRoot: world.root, team: world.team },
      { now: NOW, upToLevel: 'team' },
    );
    expect(chain.ok).toBe(false);
    expect(sidebarPolicy({ home: world.home, root: world.root, team: world.team, now: NOW })).toEqual(DEFAULTS);
  });

  test('workspace.sidebar.status_indicators defaults to symbols, accepts only dots/symbols, and allows presentation override in either direction', () => {
    const spec = POLICY_CATALOGUE['workspace.sidebar.status_indicators'];
    expect(spec.defaultValue).toBe('symbols');
    expect(spec.parseValue('dots')).toBe('dots');
    expect(spec.parseValue('symbols')).toBe('symbols');

    for (const invalid of ['none', 'icons', 'squares', 'DOTS', 'SYMBOLS', '', 1, true, ['dots']]) {
      expect(spec.parseValue(invalid)).toBeNull();
      expect(spec.valueProblem?.(invalid)).toContain('dots or symbols');
    }

    // Presentation policy: nearest level wins in both directions (symbols -> dots -> symbols, and dots -> symbols)
    const world = createWorld();
    const projectId = projectIdOfTeam(world.home, world.team, world.root)!;
    expect(sidebarPolicy({ home: world.home, root: world.root, team: world.team, now: NOW }).indicators).toBe('symbols');

    expect(
      writePolicySet(
        world.home,
        { level: 'entity', target: 'floor', name: 'workspace.sidebar.status_indicators', value: 'dots' },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expect(sidebarPolicy({ home: world.home, root: world.root, team: world.team, now: NOW }).indicators).toBe('dots');

    expect(
      writePolicySet(
        world.home,
        { level: 'project', target: projectId, name: 'workspace.sidebar.status_indicators', value: 'symbols' },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expect(sidebarPolicy({ home: world.home, root: world.root, team: world.team, now: NOW }).indicators).toBe('symbols');

    expect(
      writePolicySet(
        world.home,
        { level: 'team', target: world.root, teamRoot: world.root, name: 'workspace.sidebar.status_indicators', value: 'dots' },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expect(sidebarPolicy({ home: world.home, root: world.root, team: world.team, now: NOW }).indicators).toBe('dots');

    // Invalid status_indicators value is refused by writePolicySet
    const badWrite = writePolicySet(
      world.home,
      { level: 'team', target: world.root, teamRoot: world.root, name: 'workspace.sidebar.status_indicators', value: 'stars' },
      { now: NOW },
    );
    expect(badWrite.ok).toBe(false);
    if (!badWrite.ok) expect(badWrite.why).toContain('dots or symbols');
  });

  test('daemon.sidebar-refresh-ms is bounded from 1m (60000) to 7d (604800000), defaults to 6h (21600000), and tightens toward shorter intervals', () => {
    const spec = POLICY_CATALOGUE['daemon.sidebar-refresh-ms'];
    expect(spec.defaultValue).toBe(SIX_HOURS_MS);

    // Exact bounds accepted as numbers and strings
    expect(spec.parseValue(ONE_MINUTE_MS)).toBe(ONE_MINUTE_MS);
    expect(spec.parseValue(String(ONE_MINUTE_MS))).toBe(ONE_MINUTE_MS);
    expect(spec.parseValue(SEVEN_DAYS_MS)).toBe(SEVEN_DAYS_MS);
    expect(spec.parseValue(String(SEVEN_DAYS_MS))).toBe(SEVEN_DAYS_MS);

    // Out-of-bounds and non-integers refused
    for (const invalid of [ONE_MINUTE_MS - 1, 0, -ONE_MINUTE_MS, SEVEN_DAYS_MS + 1, 60_000.5, '60000ms', '1m', Number.NaN]) {
      expect(spec.parseValue(invalid)).toBeNull();
      expect(spec.valueProblem?.(invalid)).toContain('from 60000 to 604800000');
    }

    // Tightening (shorter or equal refresh interval) is allowed; loosening (longer interval) is refused
    const tightened = resolvePolicy('daemon.sidebar-refresh-ms', [
      { name: 'daemon.sidebar-refresh-ms', value: SEVEN_DAYS_MS, level: 'entity', setter: 'owner', date: '2026-11-04T09:00:00Z', kind: 'enforced' },
      { name: 'daemon.sidebar-refresh-ms', value: SIX_HOURS_MS, level: 'project', setter: 'owner', date: '2026-11-04T10:00:00Z', kind: 'enforced' },
      { name: 'daemon.sidebar-refresh-ms', value: ONE_MINUTE_MS, level: 'team', setter: 'owner', date: '2026-11-04T11:00:00Z', kind: 'enforced' },
    ]);
    expect(tightened.ok).toBe(true);
    if (tightened.ok) expect(tightened.effective.value).toBe(ONE_MINUTE_MS);

    const loosened = resolvePolicy('daemon.sidebar-refresh-ms', [
      { name: 'daemon.sidebar-refresh-ms', value: ONE_MINUTE_MS, level: 'entity', setter: 'owner', date: '2026-11-04T09:00:00Z', kind: 'enforced' },
      { name: 'daemon.sidebar-refresh-ms', value: ONE_MINUTE_MS + 1, level: 'team', setter: 'owner', date: '2026-11-04T10:00:00Z', kind: 'enforced' },
    ]);
    expect(loosened.ok).toBe(false);
    if (!loosened.ok) expect(loosened.refusals[0]).toMatchObject({ kind: 'loosening', policy: 'daemon.sidebar-refresh-ms' });
  });

  test('daemon.sidebar-ttl-ms has no ceiling at set (min 1000ms) and is clamped to SIDEBAR_TTL_CAP_MS (86400000) on read', () => {
    const spec = POLICY_CATALOGUE['daemon.sidebar-ttl-ms'];
    expect(spec.defaultValue).toBe(SIDEBAR_TTL_CAP_MS);
    expect(spec.parseValue(1_000)).toBe(1_000);
    expect(spec.parseValue('1000')).toBe(1_000);
    expect(spec.parseValue(SIDEBAR_TTL_CAP_MS + 1)).toBe(SIDEBAR_TTL_CAP_MS + 1);
    expect(spec.parseValue(1_000_000_000)).toBe(1_000_000_000);

    for (const invalid of [999, 0, -1_000, 1_000.25, '1000ms', Number.NaN]) {
      expect(spec.parseValue(invalid)).toBeNull();
      expect(spec.valueProblem?.(invalid)).toContain('from 1000 up');
    }

    const world = createWorld();
    const projectId = projectIdOfTeam(world.home, world.team, world.root)!;

    // 1. Value above SIDEBAR_TTL_CAP_MS is accepted by writePolicySet and clamped to SIDEBAR_TTL_CAP_MS on read
    expect(
      writePolicySet(
        world.home,
        { level: 'entity', target: 'floor', name: 'daemon.sidebar-ttl-ms', value: 500_000_000 },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expect(sidebarPolicy({ home: world.home, root: world.root, team: world.team, now: NOW }).ttlMs).toBe(SIDEBAR_TTL_CAP_MS);

    // 2. Tightening to another value still above SIDEBAR_TTL_CAP_MS succeeds and remains clamped to SIDEBAR_TTL_CAP_MS
    expect(
      writePolicySet(
        world.home,
        { level: 'project', target: projectId, name: 'daemon.sidebar-ttl-ms', value: SIDEBAR_TTL_CAP_MS + 5_000 },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expect(sidebarPolicy({ home: world.home, root: world.root, team: world.team, now: NOW }).ttlMs).toBe(SIDEBAR_TTL_CAP_MS);

    // 3. Tightening to a value below SIDEBAR_TTL_CAP_MS returns that exact value on read
    expect(
      writePolicySet(
        world.home,
        { level: 'team', target: world.root, teamRoot: world.root, name: 'daemon.sidebar-ttl-ms', value: 45_000 },
        { now: NOW },
      ).ok,
    ).toBe(true);
    expect(sidebarPolicy({ home: world.home, root: world.root, team: world.team, now: NOW }).ttlMs).toBe(45_000);
  });
});
