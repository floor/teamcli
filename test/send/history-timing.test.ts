// Send timing on the history log: `ms` (send to outcome) and `via` (the path) are written when a
// sender measures them, shown by `team feed`, and absent from every line written without them.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFeed } from '../../src/commands/feed.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { appendHistory, historyPath, parseHistoryLine, readHistory } from '../../src/send/history.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-14T15:30:00.000Z');

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function teamFile(root: string, lobby: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: helper
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
}

function world(): { root: string; home: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-timing-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamFile(root, lobbyDir(home)));
  return { root, home };
}

test('a measured send keeps its milliseconds and path through the log', () => {
  const { root, home } = world();
  const written = appendHistory('acme', root, home, {
    ts: NOW.toISOString(),
    from: 'lead',
    to: 'helper',
    body: 'hello',
    id: 'm1',
    outcome: 'delivered',
    ms: 812,
    via: 'socket',
  });
  expect(written.ok).toBe(true);
  const read = readHistory('acme', root, home);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.entries).toHaveLength(1);
  expect(read.entries[0]).toMatchObject({ id: 'm1', outcome: 'delivered', ms: 812, via: 'socket' });
});

test('a send that measured nothing writes no ms or via key at all', () => {
  const { root, home } = world();
  const ts = NOW.toISOString();
  expect(
    appendHistory('acme', root, home, { ts, from: 'lead', to: 'helper', body: 'hello', id: 'm1', outcome: 'held' }).ok,
  ).toBe(true);
  const line = readFileSync(historyPath('acme', root, home), 'utf8').trim();
  expect(JSON.parse(line)).toEqual({ ts, from: 'lead', to: 'helper', body: 'hello', id: 'm1', outcome: 'held' });
  expect(line).not.toContain('"ms"');
  expect(line).not.toContain('"via"');
});

test('the parser keeps old lines and drops only a wrong-typed timing field', () => {
  const old = parseHistoryLine('{"ts":"t","from":"a","to":"b","body":"x","id":"i","outcome":"delivered"}');
  expect(old).toMatchObject({ id: 'i', outcome: 'delivered' });
  expect(old?.ms).toBeUndefined();
  expect(old?.via).toBeUndefined();

  const bad = parseHistoryLine(
    '{"ts":"t","from":"a","to":"b","body":"x","id":"i","outcome":"delivered","ms":"fast","via":""}',
  );
  expect(bad).toMatchObject({ id: 'i', outcome: 'delivered' });
  expect(bad?.ms).toBeUndefined();
  expect(bad?.via).toBeUndefined();
});

test('team feed names the path and the milliseconds, and leaves an unmeasured line as it was', async () => {
  const { root, home } = world();
  appendHistory('acme', root, home, {
    ts: NOW.toISOString(),
    from: 'lead',
    to: 'helper',
    body: 'took the socket',
    id: 'm1',
    outcome: 'delivered',
    ms: 812,
    via: 'socket',
  });
  appendHistory('acme', root, home, {
    ts: new Date(NOW.getTime() + 1000).toISOString(),
    from: 'helper',
    to: 'lead',
    body: 'plain',
    id: 'm2',
    outcome: 'delivered',
  });

  const io = testIo(root);
  expect(await runFeed([], io, { home })).toBe(0);
  expect(io.out).toContain('15:30:00  lead -> helper  [delivered] via socket in 812 ms  took the socket');
  expect(io.out).toContain('15:30:01  helper -> lead  [delivered]  plain');

  const json = testIo(root);
  expect(await runFeed(['--json'], json, { home })).toBe(0);
  const lines = json.out
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines[0]).toMatchObject({ id: 'm1', outcome: 'delivered', ms: 812, via: 'socket' });
  expect(lines[1]).toMatchObject({ id: 'm2', outcome: 'delivered' });
  expect(lines[1]).not.toHaveProperty('ms');
  expect(lines[1]).not.toHaveProperty('via');
});
