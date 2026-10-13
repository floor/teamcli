import { expect, test } from 'bun:test';
import { runList, USAGE, type ListSources } from '../../src/commands/list.ts';
import { testIo } from '../helpers.ts';

const quiet: ListSources = { sessions: () => [], roster: () => [], team: () => null };

test('a positional argument exits 2 on stderr and the session list is not read', async () => {
  let asked = false;
  const io = testIo('/anywhere');
  const code = await runList(['--json', 'extra'], io, {
    sessions() {
      asked = true;
      return [];
    },
    roster: () => [],
    team: () => null,
  });
  expect(code).toBe(2);
  expect(asked).toBe(false);
  expect(io.out).toBe('');
  expect(io.err).toBe(`team list: unexpected "extra"\n${USAGE}`);
});

test('empty results go to stdout and leave stderr empty', async () => {
  const down = testIo('/anywhere');
  expect(await runList([], down, { ...quiet, sessions: () => null })).toBe(0);
  expect(down.out).toBe('herdr is not running\n');
  expect(down.err).toBe('');

  const none = testIo('/anywhere');
  expect(await runList([], none, quiet)).toBe(0);
  expect(none.out).toBe('no running sessions\n');
  expect(none.err).toBe('');

  const json = testIo('/anywhere');
  expect(await runList(['--json'], json, { ...quiet, sessions: () => null })).toBe(0);
  expect(json.out).toBe('[]\n');
  expect(json.err).toBe('');
});
