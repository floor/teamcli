// The placement walk answers from one `ps -ax` table read, whether it runs by itself or through
// the process reader a caller hands in. That read is a synchronous child like every other, so it
// is cut at the same bound — a sleeping ps refuses placement instead of holding it past the
// bound.
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { placeCaller, readAncestors, readWithPs } from '../src/caller.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const PANE = 'fixture-pane-one';

const KEEPER: HerdrAgent = {
  name: 'keeper',
  agent: 'claude',
  pane: PANE,
  workspace: 'floor',
  status: 'idle',
  cwd: null,
};

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

function withPs(body: string, timeoutMs: string | undefined, run: () => void): void {
  const base = fixtureBase('placement-ps-');
  scratchParent ??= dirname(base);
  made.push(base);
  const dir = join(base, 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ps'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const path = process.env.PATH;
  const bound = process.env.TEAM_SYNC_CHILD_TIMEOUT_MS;
  process.env.PATH = `${dir}${delimiter}${path ?? ''}`;
  if (timeoutMs === undefined) delete process.env.TEAM_SYNC_CHILD_TIMEOUT_MS;
  else process.env.TEAM_SYNC_CHILD_TIMEOUT_MS = timeoutMs;
  try {
    run();
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    if (bound === undefined) delete process.env.TEAM_SYNC_CHILD_TIMEOUT_MS;
    else process.env.TEAM_SYNC_CHILD_TIMEOUT_MS = bound;
  }
}

function place(ancestors: () => ReturnType<typeof readAncestors>): ReturnType<typeof placeCaller> {
  return placeCaller({
    ancestors,
    agents: () => [KEEPER],
    paneRootPid: () => process.pid,
    env: { HERDR_PANE_ID: PANE },
    stdinIsTTY: false,
  }, 'home-session');
}

describe('placement-time process reads', () => {
  test('the walk answers from one table read and refuses a sleeping ps at the bound', () => {
    // Linux reads /proc for the default walk and never runs ps. The one-table snapshot is the
    // ps reader, which is the default on every other platform.
    const read = process.platform === 'linux' ? readWithPs : undefined;
    withPs("printf '%s 1 herdr\\n' \"$PPID\"", undefined, () => {
      const placed = place(() => readAncestors(process.pid, read));
      expect(placed).toEqual({ kind: 'seat', name: 'keeper', pane: PANE, session: 'home-session' });
    });
    withPs("sleep 0.35\nprintf '%s 1 herdr\\n' \"$PPID\"", '60', () => {
      const started = performance.now();
      const placed = place(() => readAncestors(process.pid, read));
      expect(performance.now() - started).toBeLessThan(250);
      expect(placed).toEqual({ kind: 'unplaced', reason: 'its parent processes can\'t be read to the top' });
    });
  });

  test('the walk through the process reader answers from the same table, under the same bound', () => {
    withPs("printf '%s 1 herdr\\n' \"$PPID\"", undefined, () => {
      const placed = place(() => readAncestors(process.pid, readWithPs));
      expect(placed).toEqual({ kind: 'seat', name: 'keeper', pane: PANE, session: 'home-session' });
    });
    withPs("sleep 0.35\nprintf '%s 1 herdr\\n' \"$PPID\"", '60', () => {
      const started = performance.now();
      const placed = place(() => readAncestors(process.pid, readWithPs));
      expect(performance.now() - started).toBeLessThan(250);
      expect(placed).toEqual({ kind: 'unplaced', reason: 'its parent processes can\'t be read to the top' });
    });
  });
});


test('a fresh table after a hole places the caller and keeps the first diagnostic', () => {
  withPs(`if [ -f "$0.once" ]; then
  printf '%s 1 herdr\\n' "$PPID"
else
  : > "$0.once"
  printf '%s 999999 fixture\\n' "$PPID"
fi`, undefined, () => {
    const causes: string[] = [];
    const placed = place(() => readAncestors(process.pid, readWithPs, cause => causes.push(cause)));
    expect(placed).toEqual({ kind: 'seat', name: 'keeper', pane: PANE, session: 'home-session' });
    expect(causes).toEqual(['missing pid 999999']);
  });
});

test('two holed tables and two reader timeouts keep placement closed', () => {
  withPs("printf '%s 999999 fixture\\n' \"$PPID\"", undefined, () => {
    const causes: string[] = [];
    const placed = place(() => readAncestors(process.pid, readWithPs, cause => causes.push(cause)));
    expect(placed.kind).toBe('unplaced');
    expect(causes).toEqual(['missing pid 999999', 'missing pid 999999']);
  });
  withPs('sleep 0.35', '60', () => {
    const causes: string[] = [];
    const placed = place(() => readAncestors(process.pid, readWithPs, cause => causes.push(cause)));
    expect(placed.kind).toBe('unplaced');
    expect(causes).toEqual(['snapshot unread (timeout)', 'snapshot unread (timeout)']);
  });
});
