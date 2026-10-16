// The registry view of `team list` (spec section 5). A registered team shows the three states the
// contract names — DEFINED, APPROVED (its file loads and validates), RUNNING — beside the sessions
// nothing registered, one row per team, grouped by entity, filtered by the one word that names an
// entity. The view is inert until a registry is there to read: no registry file, and the command
// lists discovery alone, exactly as it did before the registry existed.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  realListSources,
  registryRowsOf,
  registryTable,
  runList,
  type ListSources,
  type RegistryRow,
  type RegistryTeam,
} from '../src/commands/list.ts';
import type { FoundTeam } from '../src/list/find.ts';
import { testIo } from './helpers.ts';

async function listed(argv: string[], sources: ListSources): Promise<{ code: number; out: string; err: string }> {
  const io = testIo('/anywhere');
  const code = await runList(argv, io, sources);
  return { code, out: io.out, err: io.err };
}

const ACME: RegistryTeam = {
  id: 'aaaa1111aaaa',
  entity: 'acme',
  project: 'acme',
  session: 'acme',
  root: '/work/acme',
  lobby: '/home/.config/team/lobbies/acme',
  roster: [
    { seat: 'lead', role: 'coordinator', agent: 'agt_0123456789ab' },
    { seat: 'worker', role: 'implementer', agent: 'agt_0fedcba98765' },
  ],
};

const BEACON: RegistryTeam = {
  id: 'beac0beac0be',
  entity: 'beacon',
  project: 'beacon',
  session: 'beacon',
  root: '/work/beacon',
  lobby: '/home/.config/team/lobbies/beacon',
  roster: [],
};

/** A registry and a discovery that agree: acme is running, beacon's file does not validate. */
function sources(registry: RegistryTeam[] | null, overrides: Partial<ListSources> = {}): ListSources {
  return {
    sessions: () => [
      { name: 'acme', running: true },
      { name: 'beacon', running: false },
    ],
    roster: () => [],
    team(session): FoundTeam | null {
      if (session === 'acme') return { project: 'acme', root: '/work/acme', seats: 2, unreadable: false };
      return null;
    },
    registry: () => registry,
    file(root) {
      if (root === '/work/acme') return { valid: true, seats: 2 };
      return { valid: false, seats: null };
    },
    ...overrides,
  };
}

test('one row per registered team: defined, approved from its file, running from herdr', () => {
  const rows = registryRowsOf([ACME, BEACON], [{ name: 'acme', running: true }, { name: 'beacon', running: false }], sources([]), false);
  expect(rows).toEqual([
    {
      entity: 'acme',
      team: 'acme',
      project: 'acme',
      lobby: '/home/.config/team/lobbies/acme',
      seats: 2,
      defined: true,
      approved: true,
      running: true,
      source: 'registry',
      roster: [
        { seat: 'lead', role: 'coordinator', agent: 'agt_0123456789ab' },
        { seat: 'worker', role: 'implementer', agent: 'agt_0fedcba98765' },
      ],
    },
    {
      entity: 'beacon',
      team: 'beacon',
      project: 'beacon',
      lobby: '/home/.config/team/lobbies/beacon',
      seats: null,
      defined: true,
      approved: false,
      running: false,
      source: 'registry',
      roster: [],
    },
  ] as RegistryRow[]);
});

test('a session the registry does not name is a discovered row, and one it names is not', async () => {
  const run = await listed(['--json', '--all'], sources([ACME], {
    sessions: () => [
      { name: 'acme', running: true },
      { name: 'stray', running: false },
    ],
    team: (session) => (session === 'stray' ? { project: 'stray', root: '/work/stray', seats: 1, unreadable: false } : { project: 'acme', root: '/work/acme', seats: 2, unreadable: false }),
  }));
  expect(run.code).toBe(0);
  const rows = JSON.parse(run.out) as RegistryRow[];
  expect(rows.map((row) => [row.team, row.source, row.defined])).toEqual([
    ['acme', 'registry', true],
    ['stray', 'discovered', false],
  ]);
  expect(Object.keys(rows[0] ?? {})).toEqual(['entity', 'team', 'project', 'lobby', 'seats', 'defined', 'approved', 'running', 'source']);
  expect(rows[1]?.lobby).toBeNull();
  expect(rows[1]?.approved).toBe(true);
  expect(rows[1]?.entity).toBe('stray');
});

test('rows are grouped by entity: sorted by entity, then by team', async () => {
  const beta: RegistryTeam = { ...BEACON, id: 'beac0beac0be', entity: 'beta', session: 'beta-one', project: 'beta', root: '/work/beta' };
  const run = await listed(['--json'], sources([BEACON, beta, ACME], { sessions: () => [] }));
  expect(run.code).toBe(0);
  expect((JSON.parse(run.out) as RegistryRow[]).map((row) => [row.entity, row.team])).toEqual([
    ['acme', 'acme'],
    ['beacon', 'beacon'],
    ['beta', 'beta-one'],
  ]);
});

test('the one word filters by entity; a word no entity has is an empty list', async () => {
  const run = await listed(['--json', 'acme'], sources([ACME, BEACON]));
  expect(run).toEqual({ code: 0, out: `${JSON.stringify([...JSON.parse(run.out) as RegistryRow[]], null, 2)}\n`, err: '' });
  expect((JSON.parse(run.out) as RegistryRow[]).map((row) => row.team)).toEqual(['acme']);

  const none = await listed(['acme2'], sources([ACME, BEACON]));
  expect(none).toEqual({ code: 0, out: 'no teams\n', err: '' });
  const json = await listed(['--json', 'acme2'], sources([ACME, BEACON]));
  expect(json).toEqual({ code: 0, out: '[]\n', err: '' });
});

test('the table carries the contract columns, one state each', async () => {
  const run = await listed([], sources([ACME, BEACON], { sessions: () => [{ name: 'acme', running: true }] }));
  expect(run.code).toBe(0);
  const lines = run.out.trimEnd().split('\n');
  expect(lines[0]?.split(/\s{2,}/)).toEqual([
    'ENTITY', 'TEAM/SESSION', 'PROJECT', 'LOBBY', 'SEATS', 'DEFINED', 'APPROVED', 'RUNNING', 'SOURCE',
  ]);
  expect(lines[1]?.split(/\s{2,}/)).toEqual([
    'acme', 'acme', 'acme', '/home/.config/team/lobbies/acme', '2', 'yes', 'yes', 'yes', 'registry',
  ]);
  expect(lines[2]?.split(/\s{2,}/)).toEqual([
    'beacon', 'beacon', 'beacon', '/home/.config/team/lobbies/beacon', '?', 'yes', 'no', 'no', 'registry',
  ]);
});

test('--seats adds the registry roster to the row, table and json alike', async () => {
  const run = await listed(['--seats'], sources([ACME], { sessions: () => [{ name: 'acme', running: true }] }));
  expect(run.out.split('\n').slice(2, 4).map((line) => line.trimStart().split(/\s{2,}/))).toEqual([
    ['lead', 'agt_0123456789ab', 'coordinator'],
    ['worker', 'agt_0fedcba98765', 'implementer'],
  ]);
  const json = await listed(['--json', '--seats'], sources([ACME], { sessions: () => [{ name: 'acme', running: true }] }));
  const rows = JSON.parse(json.out) as RegistryRow[];
  expect(Object.keys(rows[0] ?? {})).toEqual(['entity', 'team', 'project', 'lobby', 'seats', 'defined', 'approved', 'running', 'source', 'roster']);
  expect(rows[0]?.roster.map((seat) => seat.seat)).toEqual(['lead', 'worker']);
});

test('herdr cannot be asked: a registered team still lists, its RUNNING unknown', async () => {
  const run = await listed([], sources([ACME], { sessions: () => null }));
  expect(run.code).toBe(0);
  expect(run.out.trimEnd().split('\n')[1]?.split(/\s{2,}/)).toEqual([
    'acme', 'acme', 'acme', '/home/.config/team/lobbies/acme', '2', 'yes', 'yes', '?', 'registry',
  ]);
  const json = await listed(['--json'], sources([ACME], { sessions: () => null }));
  expect((JSON.parse(json.out) as RegistryRow[])[0]?.running).toBeNull();
});

test('a registry that reads but names no team still shows what discovery found, source-tagged', async () => {
  const run = await listed(['--json'], sources([], {
    sessions: () => [{ name: 'stray', running: true }],
    team: () => ({ project: 'stray', root: '/work/stray', seats: 1, unreadable: false }),
  }));
  expect((JSON.parse(run.out) as Array<Omit<RegistryRow, 'roster'>>)).toEqual([
    {
      entity: 'stray',
      team: 'stray',
      project: 'stray',
      lobby: null,
      seats: 1,
      defined: false,
      approved: true,
      running: true,
      source: 'discovered',
    },
  ]);
  expect(await listed([], sources([], { sessions: () => null }))).toEqual({ code: 0, out: 'no teams\n', err: '' });
});

test('no registry to read: discovery alone, and a positional is still not this command\'s', async () => {
  const withoutRegistry: ListSources = {
    sessions: () => [{ name: 'beacon', running: true }],
    roster: () => [],
    team: () => ({ project: 'beacon', root: '/work/beacon', seats: 2, unreadable: false }),
  };
  const run = await listed([], withoutRegistry);
  expect(run.code).toBe(0);
  expect(run.out).toBe('TEAM    PROJECT  STATUS   SEATS  ACTIVITY  NOTE\nbeacon  beacon   running  2      -\n');

  const nulled = await listed([], { ...withoutRegistry, registry: () => null });
  expect(nulled.out).toBe(run.out);

  const extra = await listed(['--json', 'extra'], { ...withoutRegistry, registry: () => null });
  expect(extra.code).toBe(2);
  expect(extra.out).toBe('');
  expect(extra.err).toContain('team list: unexpected "extra"');
});

test('a registry row whose session is not listed still reads running: no', () => {
  const rows = registryRowsOf([ACME], [], sources([ACME]), false);
  expect(rows[0]?.running).toBe(false);
  expect(rows[0]?.seats).toBe(2);
});

test('the table pads every column but the last, and never leaves a trailing run of spaces', () => {
  const rows = registryRowsOf([ACME], [{ name: 'acme', running: true }], sources([ACME]), false);
  const text = registryTable(rows, false);
  expect(text.endsWith('\n')).toBe(true);
  for (const line of text.trimEnd().split('\n')) expect(line).toBe(line.trimEnd());
});

// The real sources, on a home of their own: the registry file is read by the registry module and
// the file at a record's root by the validator, so the two halves of the wiring are covered here
// rather than only through fixtures.
test('home with a registry file: the record and its team file are read from disk', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'list-registry-')));
  try {
    const root = join(base, 'acme');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), [
      'format: 1',
      'project: acme',
      'coordinator: lead',
      'operator: lead',
      'workspace:',
      '  mode: shared',
      'seats:',
      '  - role: coordinator',
      '    name: lead',
      '    label: lead',
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude --model claude-opus-5-5',
      '',
    ].join('\n'));
    const home = join(base, 'home');
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(join(home, '.config', 'team', 'teams.yaml'), [
      'teams:',
      '  aaaa1111aaaa:',
      '    project: acme',
      '    entity: acme',
      '    session: acme',
      `    root: ${root}`,
      '    lobby: /home/.config/team/lobbies/acme',
      '    roster:',
      '      - agent: agt_0123456789ab',
      '        seat: lead',
      '        role: coordinator',
      '      - agent: agt_0fedcba98765',
      '        seat: worker',
      '        role: implementer',
      '    lifecycle: running',
      '    provenance:',
      '      registered_by: owner',
      '      registered_at: "2026-10-16T09:00:00Z"',
      '      updated_at: "2026-10-16T09:00:00Z"',
      '',
    ].join('\n'));
    const run = await listed(['--json'], {
      ...realListSources(home),
      sessions: () => [{ name: 'acme', running: true }],
      team: () => null,
    });
    expect(run.code).toBe(0);
    const rows = JSON.parse(run.out) as Array<Omit<RegistryRow, 'roster'>>;
    expect(rows).toEqual([{
      entity: 'acme',
      team: 'acme',
      project: 'acme',
      lobby: '/home/.config/team/lobbies/acme',
      seats: 2,
      defined: true,
      approved: true,
      running: true,
      source: 'registry',
    }]);

    const bare = join(base, 'bare');
    mkdirSync(bare, { recursive: true });
    const none = await listed([], { ...realListSources(bare), sessions: () => [] });
    expect(none.out).toBe('no running sessions\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
