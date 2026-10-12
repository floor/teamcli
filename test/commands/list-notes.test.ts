import { expect, test } from 'bun:test';
import { runList, type ListSources, type ListedSession } from '../../src/commands/list.ts';
import type { FoundTeam } from '../../src/list/find.ts';
import { testIo } from '../helpers.ts';

function sources(sessions: ListedSession[], team: ListSources['team']): ListSources {
  return { sessions: () => sessions, roster: () => [], team };
}

async function notes(argv: string[], sessions: ListedSession[], team: ListSources['team']): Promise<Record<string, string>> {
  const io = testIo('/anywhere');
  expect(await runList(argv, io, sources(sessions, team))).toBe(0);
  expect(io.err).toBe('');
  const rows = JSON.parse(io.out) as Array<{ team: string; note: string }>;
  return Object.fromEntries(rows.map((row) => [row.team, row.note]));
}

const found = (root: string, project = 'vlist'): FoundTeam => ({ project, root, seats: 1, unreadable: false });

test('the directory rule suppresses a near-name, and the same project name does not make a duplicate', async () => {
  const team = (session: string): FoundTeam | null => {
    if (session === 'vlist-io' || session === 'vlist.io') return found('/work/same');
    if (session === 'VList_IO') return found('/work/other');
    return null;
  };
  expect(await notes(['--json'], [
    { name: 'vlist.io', running: true },
    { name: 'VList_IO', running: true },
    { name: 'vlist-io', running: true },
  ], team)).toEqual({
    'VList_IO': 'near vlist-io, vlist.io',
    'vlist-io': 'same workspace as vlist.io; near VList_IO',
    'vlist.io': 'same workspace as vlist-io; near VList_IO',
  });
});

test('three sessions in one directory name each other in order', async () => {
  const team = (): FoundTeam => found('/work/trees', 'grove');
  expect(await notes(['--json'], [
    { name: 'cedar', running: true },
    { name: 'alder', running: true },
    { name: 'birch', running: true },
  ], team)).toEqual({
    alder: 'same workspace as birch, cedar',
    birch: 'same workspace as alder, cedar',
    cedar: 'same workspace as alder, birch',
  });
});

test('a stopped session is not a duplicate or a near-duplicate until --all', async () => {
  const sessions: ListedSession[] = [
    { name: 'md3io', running: false },
    { name: 'pair-2', running: false },
    { name: 'md3-io', running: true },
    { name: 'pair', running: true },
  ];
  const team = (session: string): FoundTeam | null => {
    if (session === 'md3-io') return found('/work/one', 'md3');
    if (session === 'md3io') return found('/work/two', 'md3');
    if (session === 'pair' || session === 'pair-2') return found('/work/pair', 'pair');
    return null;
  };
  expect(await notes(['--json'], sessions, team)).toEqual({ 'md3-io': '', pair: '' });
  expect(await notes(['--all', '--json'], sessions, team)).toEqual({
    'md3-io': 'near md3io',
    md3io: 'near md3-io',
    pair: 'same workspace as pair-2',
    'pair-2': 'same workspace as pair',
  });
});
