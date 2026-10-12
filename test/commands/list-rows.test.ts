import { expect, test } from 'bun:test';
import { runList, type ListRow, type ListSources, type RosterSeat } from '../../src/commands/list.ts';
import type { FoundTeam } from '../../src/list/find.ts';
import { testIo } from '../helpers.ts';

async function listed(argv: string[], sources: ListSources): Promise<{ code: number; out: string; err: string }> {
  const io = testIo('/anywhere');
  const code = await runList(argv, io, sources);
  return { code, out: io.out, err: io.err };
}

function seat(status: string | null): RosterSeat {
  return { name: 's', status };
}

test('orphan rows, an unreadable seat count, and the neighbour stay in one list', async () => {
  const sources: ListSources = {
    sessions: () => [
      { name: 'ok', running: true },
      { name: 'ghost', running: false },
      { name: 'broken', running: true },
      { name: 'blank', running: true },
      { name: 'stray', running: true },
    ],
    roster(session) {
      if (session === 'broken') return null;
      if (session === 'blank') return [seat('idle')];
      if (session === 'stray') return [seat('idle'), seat('idle')];
      if (session === 'ok') return [seat('idle')];
      return [];
    },
    team(session): FoundTeam | null {
      if (session === 'ok') return { project: 'ok', root: '/work/ok', seats: 4, unreadable: false };
      if (session === 'broken') return { project: 'broken', root: '/work/broken', seats: null, unreadable: true };
      if (session === 'blank') return { project: null, root: '/work/blank', seats: null, unreadable: true };
      return null;
    },
  };
  const expected: ListRow[] = [
    { team: 'blank', project: '?', status: 'running', seats: '?', activity: '1 idle', note: 'team file unreadable' },
    { team: 'broken', project: 'broken', status: 'running', seats: '?', activity: '?', note: 'team file unreadable; roster unread' },
    { team: 'ghost', project: '-', status: 'stopped', seats: '-', activity: '-', note: 'orphan' },
    { team: 'ok', project: 'ok', status: 'running', seats: '4', activity: '1 idle', note: '' },
    { team: 'stray', project: '-', status: 'running', seats: '2', activity: '2 idle', note: 'orphan' },
  ];
  const json = await listed(['--all', '--json'], sources);
  expect(json.code).toBe(0);
  expect(json.err).toBe('');
  expect(json.out).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  const table = await listed(['--all'], sources);
  expect(table.code).toBe(0);
  expect(table.err).toBe('');
  for (const name of ['blank', 'broken', 'ghost', 'ok', 'stray']) expect(table.out).toContain(name);
});

test('activity counts known statuses first, then other names, and an empty roster is a dash', async () => {
  const crew: Array<string | null> = ['working', 'blocked', 'idle', 'idle', 'done', 'Working', 'asleep', 'zzz', null, ''];
  const run = await listed(['--json'], {
    sessions: () => [
      { name: 'quiet', running: true },
      { name: 'crew', running: true },
    ],
    roster(session) {
      if (session === 'crew') return crew.map(seat);
      return [];
    },
    team(session) {
      const seats = session === 'crew' ? 4 : 1;
      return { project: session, root: `/work/${session}`, seats, unreadable: false };
    },
  });
  const expected: ListRow[] = [
    {
      team: 'crew',
      project: 'crew',
      status: 'running',
      seats: '4',
      activity: '1 working, 1 blocked, 2 idle, 1 done, 1 Working, 1 asleep, 1 zzz, 2 ?',
      note: '',
    },
    { team: 'quiet', project: 'quiet', status: 'running', seats: '1', activity: '-', note: '' },
  ];
  expect(run.code).toBe(0);
  expect(run.err).toBe('');
  expect(run.out).toBe(`${JSON.stringify(expected, null, 2)}\n`);
});
