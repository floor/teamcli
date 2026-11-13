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
