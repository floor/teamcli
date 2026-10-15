// Adversarial rows for the live view (`team list --seats`, PR #364): the launch line never
// reaches the machine-wide listing, ids that are not seat ids print as nothing, escape
// sequences in a seat's fields reach no terminal, a roster that cannot be read degrades to
// `?` without failing the listing, the activity summary counts only the words it knows, and
// the team lookup hands the roster a team of this session only.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeSeatsOf, formatActiveSeats, runList, type ListSeatsRow, type ListSources, type RosterSeat } from '../src/commands/list.ts';
import { findTeamFile, findTeam } from '../src/list/find.ts';
import { testIo } from './helpers.ts';

const SENTINEL = 'claude --model claude-opus-5-5 --api-key LIVE-SECRET-7f3a1b';

function sourcesOf(roster: RosterSeat[] | null): ListSources {
  return {
    sessions: () => [{ name: 'acme', running: true }],
    roster: () => {
      if (roster === null) throw new Error('herdr is not answering');
      return roster;
    },
    team: () => ({ project: 'acme', root: '/work/acme', seats: 4, unreadable: false }),
  };
}

const fullSeat = (over: Partial<RosterSeat> = {}): RosterSeat => ({
  name: 'lead',
  status: 'working',
  id: 'seat_111111111111',
  role: 'coordinator',
  cli: 'claude-code',
  model: 'Claude Opus 5.5',
  effort: 'high',
  pane: 'pane-1',
  last_active: '2026-10-03T14:09:48Z',
  ...over,
});

test('a launch line on the source rows reaches neither the table nor the json', async () => {
  const leaky = [fullSeat(), fullSeat({ name: 'builder', pane: 'pane-2' })].map((seat) => ({ ...seat, launch_line: SENTINEL }));

  const ioTable = testIo(join(tmpdir(), 'x'), { kind: 'owner' });
  expect(await runList(['--seats'], ioTable, sourcesOf(leaky))).toBe(0);
  expect(ioTable.out).not.toContain(SENTINEL);
  expect(ioTable.out).not.toContain('LIVE-SECRET');
  expect(ioTable.out).toContain('lead');

  const ioJson = testIo(join(tmpdir(), 'x'), { kind: 'owner' });
  expect(await runList(['--seats', '--json'], ioJson, sourcesOf(leaky))).toBe(0);
  expect(ioJson.out).not.toContain(SENTINEL);
  const rows = JSON.parse(ioJson.out) as ListSeatsRow[];
  expect(rows[0]?.roster).toHaveLength(2);
  expect(Object.keys(rows[0]?.roster[0] ?? {}).sort()).toEqual([
    'cli', 'effort', 'id', 'last_active', 'model', 'name', 'pane', 'role', 'status',
  ]);
});

test('an id that is not a seat id prints as nothing; a seat id prints', async () => {
  const roster = [fullSeat({ name: 'ghost', id: 'not-a-seat-id' }), fullSeat({ name: 'real', id: 'seat_222222222222', pane: 'pane-2' })];

  const ioTable = testIo(join(tmpdir(), 'x'), { kind: 'owner' });
  expect(await runList(['--seats'], ioTable, sourcesOf(roster))).toBe(0);
  expect(ioTable.out).toContain('ghost  -');
  expect(ioTable.out).toContain('real   seat_222222222222');
  expect(ioTable.out).not.toContain('not-a-seat-id');

  const ioJson = testIo(join(tmpdir(), 'x'), { kind: 'owner' });
  expect(await runList(['--seats', '--json'], ioJson, sourcesOf(roster))).toBe(0);
  const rows = JSON.parse(ioJson.out) as ListSeatsRow[];
  expect(rows[0]?.roster.map((seat) => seat.id)).toEqual([null, 'seat_222222222222']);
});

test('escape sequences in a seat\'s fields reach no terminal', async () => {
  const roster = [
    fullSeat({ name: '\x1b[2Jghost', model: '\x1b]0;evil\x07Claude', effort: 'hi\x1b[8mgh' }),
    fullSeat({ name: 'clean', pane: 'pane-2' }),
  ];
  const ioTable = testIo(join(tmpdir(), 'x'), { kind: 'owner' });
  expect(await runList(['--seats'], ioTable, sourcesOf(roster))).toBe(0);
  expect(ioTable.out).not.toContain('\x1b');
  expect(ioTable.out).toContain('ghost');
  expect(ioTable.out).toContain('Claude');

  const ioJson = testIo(join(tmpdir(), 'x'), { kind: 'owner' });
  expect(await runList(['--seats', '--json'], ioJson, sourcesOf(roster))).toBe(0);
  expect(ioJson.out).not.toContain('\x1b');
});

test('a roster that cannot be read degrades to ? without failing the listing', async () => {
  const broken: ListSources = {
    sessions: () => [{ name: 'acme', running: true }],
    roster: () => {
      throw new Error('herdr is not answering');
    },
    team: () => {
      throw new Error('unreadable');
    },
  };
  const ioTable = testIo(join(tmpdir(), 'x'), { kind: 'owner' });
  expect(await runList(['--seats'], ioTable, broken)).toBe(0);
  expect(ioTable.out).toContain('?');
  expect(ioTable.out).toContain('team file unreadable');
  expect(ioTable.out).toContain('roster unread');

  const ioJson = testIo(join(tmpdir(), 'x'), { kind: 'owner' });
  expect(await runList(['--seats', '--json'], ioJson, broken)).toBe(0);
  const rows = JSON.parse(ioJson.out) as ListSeatsRow[];
  expect(rows[0]).toMatchObject({ activity: '?', active: null, roster: [], seats: '?' });
});

test('the activity summary counts only the words it knows, and pads stopped to the declared count', () => {
  const unknown = [{ name: 'a', status: 'paused' }, { name: 'b', status: 'paused' }, { name: 'c', status: 'paused' }];
  expect(activeSeatsOf(unknown, 5, true)).toEqual({ ready: 0, working: 0, waiting: 0, stopped: 5 });
  expect(activeSeatsOf(unknown, null, true)).toEqual({ ready: 0, working: 0, waiting: 0, stopped: 0 });
  expect(formatActiveSeats(activeSeatsOf(unknown, null, true))).toBe('-');
  expect(activeSeatsOf(unknown, 0, true)).toEqual({ ready: 0, working: 0, waiting: 0, stopped: 0 });

  const mixed = [
    { name: 'a', status: 'working-branch' },
    { name: 'b', status: 'waiting-review' },
    { name: 'c', status: 'idle' },
    { name: 'd', status: 'done' },
    { name: 'e', status: 'blocked' },
    { name: 'f', status: 'stopped' },
  ];
  expect(activeSeatsOf(mixed, null, true)).toEqual({ ready: 2, working: 1, waiting: 2, stopped: 1 });
});

test('a stopped session reports only its declared seats as stopped', () => {
  expect(activeSeatsOf(null, 4, false)).toEqual({ ready: 0, working: 0, waiting: 0, stopped: 4 });
  expect(formatActiveSeats(activeSeatsOf(null, 4, false))).toBe('0 ready / 0 working / 0 waiting / 4 stopped');
  expect(activeSeatsOf(null, null, false)).toEqual({ ready: 0, working: 0, waiting: 0, stopped: 0 });
  expect(activeSeatsOf(null, -3, false)).toEqual({ ready: 0, working: 0, waiting: 0, stopped: 0 });
  expect(activeSeatsOf(null, null, true)).toBeNull();
  expect(formatActiveSeats(null)).toBe('?');
});

const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
trust:
  - /srv/lobby
`;

function teamYaml(project: string, session: string = project): string {
  return TEAM.replaceAll('acme', project).replace(`session: ${project}`, `session: ${session}`);
}

function writeTeam(dir: string, text: string): void {
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'team.yaml'), text);
}

function sessionAt(base: string, name: string, cwd: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ workspaces: [{ identity_cwd: cwd }] }));
  return dir;
}

function writeStore(home: string, folder: string, root: string): void {
  const store = join(home, '.config', 'team', folder);
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'approval.json'), JSON.stringify({ root }));
}

function withFixture(run: (base: string) => void): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-active-view-')));
  try {
    run(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('the roster is handed the validated team of this session only, and no team for another session\'s file', () => {
  withFixture((base) => {
    const proj = join(base, 'proj');
    const child = join(proj, 'child');
    writeTeam(proj, teamYaml('acme'));
    writeTeam(child, teamYaml('beta-project', 'beta'));
    const reg = sessionAt(base, 'reg', child);
    const mine = findTeamFile('acme', reg, base);
    expect(mine?.found).toEqual({ project: 'acme', root: proj, seats: 1, unreadable: false });
    expect(mine?.team?.seats[0]?.name).toBe('lead');
    expect(findTeamFile('beta', reg, base)?.found.root).toBe(child);
    // The file exists but names no session of ours: no found team at all, not an unreadable one.
    const deep = join(base, 'hole', 'd');
    mkdirSync(deep, { recursive: true });
    writeTeam(deep, teamYaml('beta-project', 'beta'));
    expect(findTeamFile('acme', sessionAt(base, 'reg2', deep), base)).toBeNull();
  });
});

test('an earlier store that names another session does not stop the search', () => {
  withFixture((base) => {
    const foreign = join(base, 'foreign');
    const mine = join(base, 'mine');
    writeTeam(foreign, teamYaml('beta-project', 'beta'));
    writeTeam(mine, teamYaml('acme'));
    writeStore(base, 'a-000000000001', foreign);
    writeStore(base, 'b-000000000002', mine);
    expect(findTeam('acme', null, base)).toEqual({ project: 'acme', root: mine, seats: 1, unreadable: false });
    expect(findTeam('beta', null, base)?.root).toBe(foreign);
  });
});

test('a file of this session that does not validate gives the roster no team', () => {
  withFixture((base) => {
    const proj = join(base, 'proj');
    writeTeam(proj, teamYaml('acme').replace('session: acme', 'session: ""'));
    const resolved = findTeamFile('acme', sessionAt(base, 'reg', proj), base);
    expect(resolved?.found).toEqual({ project: 'acme', root: proj, seats: null, unreadable: true });
    expect(resolved?.team).toBeNull();
  });
});
