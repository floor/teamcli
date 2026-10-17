import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.ts';
import { runList, USAGE, type ListSources, type ListedSession, type RosterSeat } from '../../src/commands/list.ts';
import { findTeam } from '../../src/list/find.ts';
import type { Io } from '../../src/io.ts';

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

function capture(): Io & { out: string; err: string } {
  const state = {
    out: '',
    err: '',
    stdout(text: string) { state.out += text; },
    stderr(text: string) { state.err += text; },
    cwd: '/anywhere',
    env: {},
    stdinIsTTY: false,
  };
  return state;
}

function sources(input: {
  sessions: ListedSession[] | null;
  roster?: Record<string, RosterSeat[] | null>;
  team?: ListSources['team'];
}): ListSources {
  return {
    sessions: () => input.sessions,
    roster: (session) => {
      if (input.roster && Object.prototype.hasOwnProperty.call(input.roster, session)) return input.roster[session] ?? null;
      return [];
    },
    team: input.team ?? (() => null),
  };
}

test('--help says the command runs from any folder and states the duplicate rule', async () => {
  const run = capture();
  expect(await main(['list', '--help'], run)).toBe(0);
  expect(run.out).toBe(USAGE);
  expect(run.out).toContain('Run from any folder');
  expect(run.out).toContain('same directory');
  expect(run.out).toContain('two teams and is not flagged');
  expect(run.out).toContain('near-duplicates');
});

test('a bad option exits 2 and herdr is not asked', async () => {
  let asked = false;
  const run = capture();
  const code = await runList(['--nope'], run, {
    sessions: () => {
      asked = true;
      return [];
    },
    roster: () => [],
    team: () => null,
  });
  expect(code).toBe(2);
  expect(asked).toBe(false);
  expect(run.err).toContain('unknown option --nope');
  expect(run.err).toContain(USAGE);
  expect(run.out).toBe('');
});

test('herdr not answering is an empty list and exit 0', async () => {
  const text = capture();
  expect(await runList([], text, sources({ sessions: null }))).toBe(0);
  expect(text.out).toBe('herdr is not running\n');
  const json = capture();
  expect(await runList(['--json'], json, sources({ sessions: null }))).toBe(0);
  expect(JSON.parse(json.out)).toEqual({
    schema: { name: 'team.list', version: 1 },
    format: 1,
    rows: [],
  });
});

test('no running session is empty, and --all shows a stopped one', async () => {
  const team = () => ({ project: 'acme', root: '/work/acme', seats: 2, unreadable: false });
  const stopped = sources({
    sessions: [{ name: 'acme', running: false }],
    team,
  });
  const text = capture();
  expect(await runList([], text, stopped)).toBe(0);
  expect(text.out).toBe('no running sessions\n');
  const all = capture();
  expect(await runList(['--all'], all, stopped)).toBe(0);
  expect(all.out).toBe('TEAM  PROJECT  STATUS   SEATS  ACTIVITY  NOTE\nacme  acme     stopped  2      -\n1 session(s)\n');
  const none = capture();
  expect(await runList(['--all', '--json'], none, sources({ sessions: [] }))).toBe(0);
  expect(JSON.parse(none.out)).toEqual({
    schema: { name: 'team.list', version: 1 },
    format: 1,
    rows: [],
  });
});

test('running rows, orphans, unreadable rosters and --json', async () => {
  const run = capture();
  const code = await runList(['--json'], run, sources({
    sessions: [
      { name: 'zeta', running: true },
      { name: 'acme', running: true },
      { name: 'gone', running: false },
    ],
    roster: {
      acme: [
        { name: 'lead', status: 'idle' },
        { name: 'worker', status: 'working' },
        { name: 'stuck', status: null },
      ],
      zeta: null,
    },
    team(session) {
      if (session === 'acme') return { project: 'acme', root: '/work/acme', seats: 4, unreadable: false };
      if (session === 'zeta') return { project: 'zeta', root: '/work/zeta', seats: 1, unreadable: false };
      return null;
    },
  }));
  expect(code).toBe(0);
  const doc = JSON.parse(run.out) as { rows: Array<Record<string, string>> };
  const rows = doc.rows;
  expect(rows.map((row) => row.team)).toEqual(['acme', 'zeta']);
  expect(rows[0]).toEqual({
    team: 'acme',
    project: 'acme',
    status: 'running',
    seats: '4',
    activity: '1 working, 1 idle, 1 ?',
    note: '',
  });
  expect(rows[1]).toEqual({
    team: 'zeta',
    project: 'zeta',
    status: 'running',
    seats: '1',
    activity: '?',
    note: 'roster unread',
  });
});

test('an orphan is a row, not a crash, and a thrown read does not fail the list', async () => {
  const run = capture();
  const code = await runList([], run, {
    sessions: () => [{ name: 'stray', running: true }, { name: 'boom', running: true }],
    roster(session) {
      if (session === 'boom') throw new Error('roster exploded');
      return [{ name: null, status: 'idle' }];
    },
    team(session) {
      if (session === 'boom') throw new Error('team exploded');
      return null;
    },
  });
  expect(code).toBe(0);
  expect(run.out).toContain('stray');
  expect(run.out).toContain('orphan');
  expect(run.out).toContain('boom');
  expect(run.out).toContain('team file unreadable');
  expect(run.out).toContain('roster unread');
  expect(run.err).toBe('');
});

test('the same project name in two directories is not a duplicate; one directory is', async () => {
  const run = capture();
  await runList(['--all'], run, sources({
    sessions: [
      { name: 'acme', running: true },
      { name: 'acme-2', running: false },
      { name: 'other', running: true },
    ],
    roster: { acme: [], other: [] },
    team(session) {
      if (session === 'acme') return { project: 'acme', root: '/work/acme', seats: 1, unreadable: false };
      if (session === 'acme-2') return { project: 'acme', root: '/work/acme', seats: 1, unreadable: false };
      if (session === 'other') return { project: 'acme', root: '/work/other', seats: 1, unreadable: false };
      return null;
    },
  }));
  const lines = run.out.trim().split('\n').slice(1);
  const note = (name: string) => lines.find((line) => line.startsWith(name)) ?? '';
  expect(note('acme ')).toContain('same workspace as acme-2');
  expect(note('acme ')).not.toContain('near');
  expect(note('acme-2')).toContain('same workspace as acme');
  expect(note('other')).not.toContain('same workspace');
  expect(note('other')).not.toContain('near');
});

test('near-duplicate names are names equal after stripping separators', async () => {
  const run = capture();
  await runList([], run, sources({
    sessions: [
      { name: 'md3-io', running: true },
      { name: 'md3io', running: true },
      { name: 'radiooooo', running: true },
      { name: 'radiooooo-ios', running: true },
      { name: 'teamcli', running: true },
      { name: 'teamcli.io', running: true },
    ],
    roster: {},
    team: () => null,
  }));
  const line = (name: string) => run.out.split('\n').find((item) => item.startsWith(`${name} `)) ?? '';
  expect(line('md3-io')).toContain('near md3io');
  expect(line('md3io')).toContain('near md3-io');
  expect(line('radiooooo')).not.toContain('near');
  expect(line('radiooooo-ios')).not.toContain('near');
  expect(line('teamcli')).not.toContain('near');
  expect(line('teamcli.io')).not.toContain('near');
});

test('a team file is found from a session registry cwd, and a link is not opened', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-list-')));
  try {
    const root = join(base, 'proj');
    const nested = join(root, 'src', 'pkg');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
    const sessionDir = join(base, 'session');
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      workspaces: [{ identity_cwd: nested }],
    }));
    const found = findTeam('acme', sessionDir, base);
    expect(found).toEqual({ project: 'acme', root, seats: 1, unreadable: false });

    const elsewhere = join(base, 'other');
    mkdirSync(join(elsewhere, '.agents'), { recursive: true });
    writeFileSync(join(elsewhere, '.agents', 'team.yaml'), TEAM.replaceAll('session: acme', 'session: other'));
    expect(findTeam('acme', join(base, 'missing'), base)).toBeNull();

    const linked = join(base, 'linked');
    mkdirSync(join(linked, '.agents'), { recursive: true });
    symlinkSync(join(root, '.agents', 'team.yaml'), join(linked, '.agents', 'team.yaml'));
    const linkDir = join(base, 'link-session');
    mkdirSync(linkDir);
    writeFileSync(join(linkDir, 'session.json'), JSON.stringify({ workspaces: [{ identity_cwd: linked }] }));
    expect(findTeam('acme', linkDir, base)).toBeNull();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an unreadable team file is still that session, and a store names one the registry does not', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-list-store-')));
  try {
    const root = join(base, 'proj');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), 'format: 1\nproject: acme\nsession: acme\n');
    const sessionDir = join(base, 'session');
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ workspaces: [{ identity_cwd: root }] }));
    const broken = findTeam('acme', sessionDir, base);
    expect(broken?.project).toBe('acme');
    expect(broken?.unreadable).toBe(true);
    expect(broken?.seats).toBeNull();
    expect(broken?.root).toBe(root);

    const stored = join(base, 'stored');
    mkdirSync(join(stored, '.agents'), { recursive: true });
    writeFileSync(join(stored, '.agents', 'team.yaml'), TEAM.replaceAll('acme', 'kept'));
    const store = join(base, '.config', 'team', 'kept-0123456789ab');
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'approval.json'), JSON.stringify({ root: stored }));
    const fromStore = findTeam('kept', null, base);
    expect(fromStore).toEqual({ project: 'kept', root: stored, seats: 1, unreadable: false });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
