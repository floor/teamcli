import { expect, test } from 'bun:test';
import { runList, USAGE, type ListSources } from '../../src/commands/list.ts';
import { LIST_OUTPUT_SCHEMA } from '../../src/output/index.ts';
import { testIo } from '../helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from '../helpers/output.ts';

const quiet: ListSources = { sessions: () => [], roster: () => [], team: () => null };

test('a positional argument exits 2 and the session list is not read', async () => {
  let asked = false;
  const io = testIo('/anywhere');
  const code = await runList(['extra'], io, {
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

  const ioJson = testIo('/anywhere');
  expect(await runList(['--json', 'extra'], ioJson, quiet)).toBe(2);
  expect(ioJson.err).toBe('');
  assertJsonErrorShape(ioJson.out, { id: 'list.invocation', messageContains: 'unexpected "extra"', repair: null });
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
  const doc = assertMatchesOutputSchema<{ rows: unknown[] }>(json.out, LIST_OUTPUT_SCHEMA);
  expect(doc.rows).toEqual([]);
  expect(json.err).toBe('');
});

