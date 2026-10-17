import { expect, test } from 'bun:test';
import { runList, type ListSources, type ListedSession } from '../../src/commands/list.ts';
import type { FoundTeam } from '../../src/list/find.ts';
import { testIo } from '../helpers.ts';

const SESSIONS: ListedSession[] = [
  { name: 'west-old', running: false },
  { name: 'beta', running: true },
  { name: 'Alpha', running: true },
  { name: 'default', running: true },
  { name: 'west', running: true },
];

function teamOf(session: string): FoundTeam | null {
  if (session === 'Alpha') return { project: 'alpha', root: '/work/alpha', seats: 1, unreadable: false };
  if (session === 'west' || session === 'west-old') return { project: 'west', root: '/work/west', seats: 2, unreadable: false };
  return null;
}

function fleet(seen: string[]): ListSources {
  return {
    sessions: () => SESSIONS,
    roster(session) {
      seen.push(session);
      if (session === 'Alpha' || session === 'west') return [{ name: 'lead', status: 'idle' }];
      return [];
    },
    team: teamOf,
  };
}

async function listed(argv: string[], sources: ListSources): Promise<{ code: number; out: string; err: string }> {
  const io = testIo('/anywhere');
  const code = await runList(argv, io, sources);
  return { code, out: io.out, err: io.err };
}

function names(out: string): string[] {
  return out.trimEnd().split('\n').slice(1, -1).map((line) => line.split(/\s{2,}/)[0] ?? '');
}

function line(out: string, name: string): string {
  return out.trimEnd().split('\n').find((item) => item.split(/\s{2,}/)[0] === name) ?? '';
}

test('the default list is the running sessions in name order, and --all adds the stopped ones', async () => {
  const seen: string[] = [];
  const sources = fleet(seen);
  const running = await listed([], sources);
  expect(running.code).toBe(0);
  expect(running.err).toBe('');
  expect(names(running.out)).toEqual(['Alpha', 'beta', 'default', 'west']);
  expect(line(running.out, 'west')).not.toContain('west-old');
  expect(line(running.out, 'west')).not.toContain('same workspace');
  expect(line(running.out, 'beta')).toContain('orphan');
  expect(line(running.out, 'default')).toContain('orphan');
  expect(line(running.out, 'Alpha')).not.toContain('orphan');
  expect(seen).toEqual(['Alpha', 'beta', 'default', 'west']);

  seen.length = 0;
  const all = await listed(['--all'], sources);
  expect(all.code).toBe(0);
  expect(all.err).toBe('');
  expect(names(all.out)).toEqual(['Alpha', 'beta', 'default', 'west', 'west-old']);
  expect(line(all.out, 'west')).toContain('same workspace as west-old');
  expect(line(all.out, 'west-old')).toContain('stopped');
  expect(line(all.out, 'west-old')).toContain('same workspace as west');
  expect(seen).toEqual(['Alpha', 'beta', 'default', 'west']);
});

test('a session list that throws is the same empty state as herdr not answering', async () => {
  let roster = false;
  const sources: ListSources = {
    sessions() {
      throw new Error('herdr is not there');
    },
    roster() {
      roster = true;
      return [];
    },
    team: () => null,
  };
  const text = await listed([], sources);
  expect(text).toEqual({ code: 0, out: 'herdr is not running\n', err: '' });
  expect(roster).toBe(false);
  const json = await listed(['--json'], sources);
  expect(json.code).toBe(0);
  expect(json.err).toBe('');
  expect(JSON.parse(json.out)).toEqual({
    schema: { name: 'team.list', version: 1 },
    format: 1,
    rows: [],
  });
  expect(roster).toBe(false);
});

test('an empty registry with --all says there are no sessions', async () => {
  const run = await listed(['--all'], { sessions: () => [], roster: () => [], team: () => null });
  expect(run).toEqual({ code: 0, out: 'no sessions\n0 session(s)\n', err: '' });
});

