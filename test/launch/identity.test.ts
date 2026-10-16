// The comparison at the heart of "a pane is its seat only while the process team launched is still
// in it": recorded pids in, one verdict out. Reads pids only — never a command line, an argument or
// an environment.
import { expect, test } from 'bun:test';
import type { PaneProcesses } from '../../src/herdr.ts';
import { launchedIdentity, replacedSeat, seatProcessVerdict, type LaunchedIdentity } from '../../src/launch/identity.ts';

const recorded: LaunchedIdentity = { shell: 400, cli: [401] };
const pane = (shell: number, foreground: number[]): PaneProcesses => ({ shell, foreground });

test('same: the recorded shell, with the recorded CLI pid in front', () => {
  expect(seatProcessVerdict(recorded, pane(400, [401]))).toBe('same');
});

test('same: several recorded CLI pids, one still in front', () => {
  // A wrapper that hands over, or a helper beside the CLI: the seat is accepted while any
  // recorded pid is in front. An extra pid beside the recorded ones, or another order, changes
  // nothing.
  expect(seatProcessVerdict({ shell: 400, cli: [401, 402] }, pane(400, [402, 999]))).toBe('same');
  expect(seatProcessVerdict({ shell: 400, cli: [401, 402] }, pane(400, [999, 401, 402]))).toBe('same');
  expect(seatProcessVerdict({ shell: 400, cli: [401, 402] }, pane(400, [402, 401]))).toBe('same');
});

test('gone: the pane runs no CLI — its own shell is in front', () => {
  expect(seatProcessVerdict(recorded, pane(400, [400]))).toBe('gone');
});

test('gone: a restored pane with a shell of its own, nothing else in front', () => {
  expect(seatProcessVerdict(recorded, pane(500, [500]))).toBe('gone');
});

test('replaced: a different shell pid, a CLI in front', () => {
  expect(seatProcessVerdict(recorded, pane(500, [501]))).toBe('replaced');
});

test('replaced: another CLI pid under the recorded shell', () => {
  expect(seatProcessVerdict(recorded, pane(400, [500]))).toBe('replaced');
});

test('replaced: the recorded CLI pid in front under another shell pid', () => {
  // A restore restarted the shell, and a process carrying the recorded CLI pid sits in front of
  // it: the pid alone is not the seat — the shell must be the recorded one too. A mutation that
  // ignores `recorded.shell` passes every other test here and fails this one.
  expect(seatProcessVerdict(recorded, pane(500, [401]))).toBe('replaced');
});

test("herdr can't tell: no reading, or no foreground process at all", () => {
  expect(seatProcessVerdict(recorded, null)).toBe('unknown');
  expect(seatProcessVerdict(recorded, undefined)).toBe('unknown');
  expect(seatProcessVerdict(recorded, pane(400, []))).toBe('unknown');
});

test('no record: every pane reads as today', () => {
  expect(seatProcessVerdict(undefined, pane(400, [401]))).toBe('unknown');
  expect(seatProcessVerdict(undefined, pane(400, [400]))).toBe('unknown');
  expect(seatProcessVerdict(undefined, null)).toBe('unknown');
});

test('the identity recorded: the shell, and the foreground pids that are not it', () => {
  expect(launchedIdentity(pane(400, [400, 401, 402]))).toEqual({ shell: 400, cli: [401, 402] });
});

test('nothing is recorded for a pane with no CLI in front, or an unreadable one', () => {
  expect(launchedIdentity(pane(400, [400]))).toBeNull();
  expect(launchedIdentity(pane(400, []))).toBeNull();
  expect(launchedIdentity(null)).toBeNull();
  expect(launchedIdentity(undefined)).toBeNull();
});

const tied = { asked: true, namedOnPane: true, recordedSession: 'conversation', liveSession: 'conversation' };

test('restored: a pid mismatch whose agent session is the one stored at launch', () => {
  expect(replacedSeat('replaced', tied)).toBe('restored');
});

test('doubt: a pid mismatch with no stored session, no live session, or a different one', () => {
  expect(replacedSeat('replaced', { ...tied, recordedSession: undefined })).toBe('doubt');
  expect(replacedSeat('replaced', { ...tied, liveSession: undefined })).toBe('doubt');
  expect(replacedSeat('replaced', { ...tied, liveSession: 'other' })).toBe('doubt');
  expect(replacedSeat('replaced', { ...tied, asked: false })).toBe('doubt');
  expect(replacedSeat('replaced', { ...tied, namedOnPane: false })).toBe('doubt');
});

test('a shell in front is not restored, even when the name and the session match', () => {
  expect(replacedSeat('gone', tied)).toBe('other');
  expect(seatProcessVerdict(recorded, pane(500, [500]))).toBe('gone');
});
