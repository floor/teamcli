// `team list --seats` prints a roster it only partly believes: a seat's row holds what the
// sources gave and nothing more, and the ACTIVITY count folds the statuses it read into four
// buckets. These scenes hold the sources to the edges the docs name — a value not given is `-`,
// a status that cannot be read is `?`, a key the source never set is dropped from `--json`
// rather than nulled, an id that is not a seat id never prints as one, a blocked seat counts
// waiting and an idle one ready, and a roster that cannot be read leaves `?` and no rows.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeSeatsOf, formatActiveSeats, runList, type ListSeatsRow, type ListSources } from '../src/commands/list.ts';
import { testIo } from './helpers.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-list-seats-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the --seats rows and roster keys', () => {
  test('a value not given is "-", a status that cannot be read is "?", and a key never set is dropped', async () => {
    const sources: ListSources = {
      sessions: () => [{ name: 'acme', running: true }],
      roster: () => [
        { name: 'seen', status: null, id: null, cli: null, model: null, pane: null },
        { name: 'brief', status: 'idle' },
        { name: 'odd', status: 'working', id: 'nope', pane: 'w9:p3' },
      ],
      team: () => ({ project: 'acme', root: '/work/acme', seats: 2, unreadable: false }),
    };

    const ioTable = testIo(dir, { kind: 'owner' });
    expect(await runList(['--seats'], ioTable, sources)).toBe(0);
    const seatLine = (name: string): string => {
      const line = ioTable.out.split('\n').find((row) => row.startsWith(`  ${name}`));
      expect(line).toBeDefined();
      return line!;
    };
    expect(seatLine('seen')).toMatch(/^  seen\s+-\s+\?\s+-\s+-\s+-$/);
    expect(seatLine('brief')).toMatch(/^  brief\s+-\s+idle\s+-\s+-\s+-$/);
    expect(seatLine('odd')).toMatch(/^  odd\s+-\s+working\s+-\s+-\s+w9:p3$/);
    // The unread status counted nowhere, the idle one ready: two declared, two accounted.
    expect(ioTable.out).toContain('1 ready / 1 working / 0 waiting / 0 stopped');

    const ioJson = testIo(dir, { kind: 'owner' });
    expect(await runList(['--seats', '--json'], ioJson, sources)).toBe(0);
    const roster = (JSON.parse(ioJson.out) as ListSeatsRow[])[0]!.roster;
    expect(roster[0]).toEqual({ name: 'seen', status: null, id: null, cli: null, model: null, pane: null });
    expect(roster[1]).toEqual({ name: 'brief', status: 'idle' });
    expect(roster[2]).toEqual({ name: 'odd', status: 'working', id: null, pane: 'w9:p3' });
  });

  test('a blocked seat counts waiting, an idle one ready, and seats only the file declares count stopped', async () => {
    expect(activeSeatsOf([{ name: 'gate', status: 'blocked' }], 1, true)).toEqual({
      ready: 0,
      working: 0,
      waiting: 1,
      stopped: 0,
    });
    expect(formatActiveSeats(activeSeatsOf([{ name: 'rest', status: 'idle' }], 1, true))).toBe(
      '1 ready / 0 working / 0 waiting / 0 stopped',
    );
    expect(formatActiveSeats(activeSeatsOf([], 3, true))).toBe('0 ready / 0 working / 0 waiting / 3 stopped');
    expect(formatActiveSeats(activeSeatsOf(null, null, true))).toBe('?');

    const sources: ListSources = {
      sessions: () => [{ name: 'acme', running: true }],
      roster: () => [{ name: 'gate', status: 'blocked' }],
      team: () => ({ project: 'acme', root: '/work/acme', seats: 1, unreadable: false }),
    };
    const io = testIo(dir, { kind: 'owner' });
    expect(await runList(['--seats'], io, sources)).toBe(0);
    expect(io.out).toContain('0 ready / 0 working / 1 waiting / 0 stopped');
    expect(io.out).toMatch(/^  gate\s+-\s+blocked\s+-\s+-\s+-$/m);
  });

  test('a session no team file names lists the seats herdr has, carrying only what could be read', async () => {
    const sources: ListSources = {
      sessions: () => [{ name: 'solo', running: true }],
      roster: () => [{ name: 'hush', status: 'idle', pane: 'w9:p2' }],
      team: () => null,
    };

    const io = testIo(dir, { kind: 'owner' });
    expect(await runList(['--seats'], io, sources)).toBe(0);
    expect(io.out).toContain('orphan');
    expect(io.out).toMatch(/^  hush\s+-\s+idle\s+-\s+-\s+w9:p2$/m);

    const ioJson = testIo(dir, { kind: 'owner' });
    expect(await runList(['--seats', '--json'], ioJson, sources)).toBe(0);
    const row = (JSON.parse(ioJson.out) as ListSeatsRow[])[0]!;
    expect(row.seats).toBe('1');
    expect(row.activity).toBe('1 ready / 0 working / 0 waiting / 0 stopped');
    expect(row.active).toEqual({ ready: 1, working: 0, waiting: 0, stopped: 0 });
    expect(row.roster).toEqual([{ name: 'hush', status: 'idle', pane: 'w9:p2' }]);
  });

  test('a running session whose roster cannot be read shows "?" and no seat rows', async () => {
    const sources: ListSources = {
      sessions: () => [{ name: 'acme', running: true }],
      roster: () => null,
      team: () => ({ project: 'acme', root: '/work/acme', seats: 2, unreadable: false }),
    };

    const io = testIo(dir, { kind: 'owner' });
    expect(await runList(['--seats'], io, sources)).toBe(0);
    expect(io.out).toContain('roster unread');
    expect(io.out.split('\n').filter((line) => line.startsWith('  '))).toHaveLength(0);

    const ioJson = testIo(dir, { kind: 'owner' });
    expect(await runList(['--seats', '--json'], ioJson, sources)).toBe(0);
    const row = (JSON.parse(ioJson.out) as ListSeatsRow[])[0]!;
    expect(row.activity).toBe('?');
    expect(row.active).toBeNull();
    expect(row.roster).toEqual([]);
  });
});
