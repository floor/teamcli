import { expect, test } from 'bun:test';
import { runList, type ListRow, type ListSources } from '../../src/commands/list.ts';
import { LIST_OUTPUT_SCHEMA } from '../../src/output/index.ts';
import { testIo } from '../helpers.ts';
import { assertMatchesOutputSchema } from '../helpers/output.ts';

async function listed(argv: string[], sources: ListSources): Promise<{ code: number; out: string; err: string }> {
  const io = testIo('/anywhere');
  const code = await runList(argv, io, sources);
  return { code, out: io.out, err: io.err };
}

test('--all --json prints one object per session, stopped rows included, keys in order', async () => {
  const run = await listed(['--json', '--all'], {
    sessions: () => [
      { name: 'beacon-old', running: false },
      { name: 'beacon', running: true },
    ],
    roster(session) {
      if (session === 'beacon') return [{ name: 'a', status: 'idle' }, { name: 'b', status: 'idle' }];
      return [];
    },
    team(session) {
      if (session === 'beacon') return { project: 'beacon', root: '/work/beacon', seats: 2, unreadable: false };
      if (session === 'beacon-old') return { project: 'beacon-old', root: '/work/beacon-old', seats: 2, unreadable: false };
      return null;
    },
  });
  const expected: ListRow[] = [
    { team: 'beacon', project: 'beacon', status: 'running', seats: '2', activity: '2 idle', note: '' },
    { team: 'beacon-old', project: 'beacon-old', status: 'stopped', seats: '2', activity: '-', note: '' },
  ];
  expect(run.code).toBe(0);
  expect(run.err).toBe('');
  const doc = assertMatchesOutputSchema<{ rows: ListRow[] }>(run.out, LIST_OUTPUT_SCHEMA);
  expect(doc.rows).toEqual(expected);
  expect(Object.keys(doc.rows[0] ?? {})).toEqual(['team', 'project', 'status', 'seats', 'activity', 'note']);
  expect(Object.keys(doc.rows[1] ?? {})).toEqual(['team', 'project', 'status', 'seats', 'activity', 'note']);
});

test('json is an empty rows array when every session is stopped', async () => {
  const run = await listed(['--json'], {
    sessions: () => [{ name: 'beacon-old', running: false }],
    roster: () => [],
    team: () => ({ project: 'beacon-old', root: '/work/beacon-old', seats: 2, unreadable: false }),
  });
  expect(run.code).toBe(0);
  expect(run.err).toBe('');
  const doc = assertMatchesOutputSchema<{ rows: ListRow[] }>(run.out, LIST_OUTPUT_SCHEMA);
  expect(doc.rows).toEqual([]);
});

