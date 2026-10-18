import { expect, test } from 'bun:test';
import { runList, type ListSources } from '../../src/commands/list.ts';
import { testIo } from '../helpers.ts';

function column(header: string, line: string, label: string, next: string | null): string {
  const start = header.indexOf(label);
  const end = next === null ? line.length : header.indexOf(next);
  return line.slice(start, end).trim();
}

test('a long name widens its column and the later columns stay under their headings', async () => {
  const sources: ListSources = {
    sessions: () => [
      { name: 'long-session-name', running: true },
      { name: 'ab', running: true },
    ],
    roster(session) {
      if (session === 'long-session-name') return [{ name: 'lead', status: 'idle' }];
      return [];
    },
    team(session) {
      if (session === 'ab') return { project: 'long-project-name', root: '/work/ab', seats: 4, unreadable: false };
      return { project: 'proj', root: '/work/long', seats: 1, unreadable: false };
    },
  };
  const io = testIo('/anywhere');
  expect(await runList([], io, sources)).toBe(0);
  expect(io.err).toBe('');
  const lines = io.out.trimEnd().split('\n');
  const header = lines[0] ?? '';
  const ab = lines[1] ?? '';
  const long = lines[2] ?? '';
  expect(lines).toHaveLength(4);
  expect(lines[3]).toBe('2 sessions');
  expect(header.indexOf('PROJECT')).toBeGreaterThan('long-session-name'.length);
  expect(column(header, ab, 'TEAM', 'PROJECT')).toBe('ab');
  expect(column(header, long, 'TEAM', 'PROJECT')).toBe('long-session-name');
  expect(column(header, ab, 'PROJECT', 'STATUS')).toBe('long-project-name');
  expect(column(header, long, 'PROJECT', 'STATUS')).toBe('proj');
  expect(column(header, ab, 'STATUS', 'SEATS')).toBe('running');
  expect(column(header, long, 'STATUS', 'SEATS')).toBe('running');
  expect(column(header, ab, 'SEATS', 'ACTIVITY')).toBe('4');
  expect(column(header, long, 'SEATS', 'ACTIVITY')).toBe('1');
  expect(column(header, ab, 'ACTIVITY', 'NOTE')).toBe('-');
  expect(column(header, long, 'ACTIVITY', 'NOTE')).toBe('1 idle');
  expect(column(header, ab, 'NOTE', null)).toBe('');
  expect(column(header, long, 'NOTE', null)).toBe('');
});

test('a newline or an escape in a session name stays one cell', async () => {
  const sources: ListSources = {
    sessions: () => [
      { name: 'two\nlines', running: true },
      { name: 'pre\x1b[31mpost', running: true },
    ],
    roster: () => [{ name: 'lead', status: 'idle' }],
    team: () => null,
  };
  const io = testIo('/anywhere');
  expect(await runList([], io, sources)).toBe(0);
  expect(io.err).toBe('');
  const lines = io.out.trimEnd().split('\n');
  expect(lines).toHaveLength(4);
  expect(lines[1]?.startsWith('prepost')).toBe(true);
  expect(lines[2]?.startsWith('two lines')).toBe(true);
  expect(lines[3]).toBe('2 sessions');
  expect(io.out).not.toContain('\x1b');
  expect(io.out).toContain('orphan');
});
