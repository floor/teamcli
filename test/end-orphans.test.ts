// A closed pane's CLI that outlives it as an orphan is ended (2026-11-13: four Codex processes
// reparented to pid 1 after restarts; one held a seat's conversation). Only the pids read in front
// of the closed pane, and only once reparented to pid 1.
import { expect, test } from 'bun:test';
import { endOrphans } from '../src/herdr.ts';

const noSleep = () => {};

test('a CLI reparented to pid 1 after the close is ended; one that exited or kept its parent is not', () => {
  const parents = new Map<number, number | null>([[200, 1], [201, null], [202, 4242]]);
  const ended: number[] = [];
  const result = endOrphans([200, 201, 202, 200], (pid) => parents.get(pid) ?? null, (pid) => ended.push(pid), noSleep);
  expect(result).toEqual([200]);
  expect(ended).toEqual([200]);
});

test('a CLI that exits on the hangup inside the wait is never signalled', () => {
  let reads = 0;
  const ended: number[] = [];
  endOrphans([300], () => (reads++ < 2 ? 1 : null), (pid) => ended.push(pid), noSleep);
  expect(ended).toEqual([]);
});

// Where a service manager runs the user's processes, an orphan is handed to that manager — the
// subreaper the daemon recorded at its start — not to pid 1. The rule is the recorded pid, never
// a process name; macOS records none, so its rule is unchanged.
test('a CLI handed to the recorded reaper is ended like one handed to pid 1; any other parent keeps it', () => {
  const parents = new Map<number, number | null>([[400, 1116], [401, 1], [402, 4242], [403, null]]);
  const ended: number[] = [];
  const result = endOrphans([400, 401, 402, 403], (pid) => parents.get(pid) ?? null, (pid) => ended.push(pid), noSleep, [1116]);
  expect(result).toEqual([400, 401]);
  expect(ended).toEqual([400, 401]);
});

test('with no reaper recorded, a CLI under that same parent is left alone: the rule is pid 1 alone', () => {
  const ended: number[] = [];
  expect(endOrphans([500], () => 1116, (pid) => ended.push(pid), noSleep)).toEqual([]);
  expect(endOrphans([500], () => 1116, (pid) => ended.push(pid), noSleep, [])).toEqual([]);
  expect(ended).toEqual([]);
});

test('a pid not read in front of the closed pane is never ended, whatever its parent', () => {
  const ended: number[] = [];
  endOrphans([], () => 1116, (pid) => ended.push(pid), noSleep, [1116]);
  expect(ended).toEqual([]);
});
