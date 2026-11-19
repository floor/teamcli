// The comparison at the heart of "a pane is its seat only while the process team launched is still
// in it": recorded pids in, one verdict out. Reads pids only — never a command line, an argument or
// an environment.
import { expect, test } from 'bun:test';
import type { PaneProcesses } from '../../src/herdr.ts';
import { launchedIdentity, replacedSeat, seatProcessVerdict, typedPaneProof, type LaunchedIdentity } from '../../src/launch/identity.ts';

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

const heldClaude = { pane: 'fixture', pane_shell: 400, pane_shell_start: 1000, launched: { shell: 400, cli: [401], cli_start: [2000] } };
type Parent = { pid: number; ppid: number; birth: number };
const family = (): Map<number, Parent> => new Map([
  [401, { pid: 401, ppid: 400, birth: 2_000_000 }],
  [402, { pid: 402, ppid: 401, birth: 2_000_010 }], // MCP server
  [403, { pid: 403, ppid: 401, birth: 2_000_020 }], // tool shell
  [404, { pid: 404, ppid: 403, birth: 2_000_030 }], // tool subprocess
]);
function claudeProof(nodes = family(), extra: { starts?: number; front?: number[]; read?: (pid: number) => Parent | null; claude?: boolean } = {}) {
  return typedPaneProof(heldClaude, 'worker', 'fixture', 'acme', {
    agents: () => [{ name: 'worker', pane: 'fixture' }],
    processes: () => pane(400, extra.front ?? [401, 402, 403, 404]),
    processStart: pid => pid === 400 ? 1000 : extra.starts ?? 2000,
    processParent: extra.read ?? (pid => nodes.get(pid) ?? null),
  }, extra.claude ?? true);
}

test('a Claude CLI with its MCP server, tool shell and tool subprocess in front passes', () => {
  expect(claudeProof()).toEqual({ ok: true });
});

test('an unrelated sibling, replaced CLI birth and missing recorded CLI still refuse', () => {
  const unrelated = family();
  unrelated.set(404, { pid: 404, ppid: 400, birth: 2_000_030 });
  expect(claudeProof(unrelated).ok).toBe(false);
  expect(claudeProof(family(), { starts: 3000 }).ok).toBe(false);
  expect(claudeProof(family(), { front: [402, 403, 404] }).ok).toBe(false);
  expect(claudeProof(family(), { claude: false }).ok).toBe(false);
});

test('a reused intermediate pid born after its child refuses, including within one second', () => {
  const nodes = family();
  nodes.set(403, { pid: 403, ppid: 401, birth: 2_000_040 });
  expect(claudeProof(nodes).ok).toBe(false);
});

test('a changed parent or birth during the proof refuses', () => {
  for (const change of [{ ppid: 400 }, { birth: 2_000_050 }]) {
    const nodes = family();
    const seen = new Map<number, number>();
    expect(claudeProof(nodes, { read: pid => {
      const node = nodes.get(pid);
      const count = (seen.get(pid) ?? 0) + 1;
      seen.set(pid, count);
      return node === undefined ? null : { ...node, ...(pid === 403 && count > 1 ? change : {}) };
    } }).ok).toBe(false);
  }
});

test('unreadable ancestry, cycles and excessive depth refuse', () => {
  expect(claudeProof(family(), { read: () => null }).ok).toBe(false);
  const loop = family();
  loop.set(403, { pid: 403, ppid: 404, birth: 2_000_030 });
  expect(claudeProof(loop).ok).toBe(false);
  const deep = family();
  for (let pid = 500; pid < 600; pid++) deep.set(pid, { pid, ppid: pid === 500 ? 401 : pid - 1, birth: 2_001_000 + pid });
  expect(claudeProof(deep, { front: [401, 599] }).ok).toBe(false);
});

test('descendants need recorded births; legacy recorded-only proof is unchanged', () => {
  const legacy = { ...heldClaude, launched: { shell: 400, cli: [401] } };
  const nodes = family();
  const owner = {
    agents: () => [{ name: 'worker', pane: 'fixture' }],
    processes: () => pane(400, [401, 402]),
    processStart: () => 1000,
    processParent: (pid: number) => nodes.get(pid) ?? null,
  };
  expect(typedPaneProof(legacy, 'worker', 'fixture', 'acme', owner, true).ok).toBe(false);
  expect(typedPaneProof(legacy, 'worker', 'fixture', 'acme', { ...owner, processes: () => pane(400, [401]) }, true).ok).toBe(true);
});

test('a wide foreground tree cannot exceed the metadata-sample bound', () => {
  const nodes = family();
  const front = [401];
  for (let pid = 500; pid < 756; pid++) {
    nodes.set(pid, { pid, ppid: 401, birth: 2_001_000 + pid });
    front.push(pid);
  }
  expect(claudeProof(nodes, { front }).ok).toBe(false);
});

test('a recorded unrelated sibling cannot authorize descendants; helper-first recording still works', () => {
  const nodes = family();
  nodes.set(405, { pid: 405, ppid: 400, birth: 2_000_005 });
  nodes.set(406, { pid: 406, ppid: 405, birth: 2_000_010 });
  const owner = {
    agents: () => [{ name: 'worker', pane: 'fixture' }],
    processes: () => pane(400, [401, 405, 406]),
    processStart: (pid: number) => pid === 400 ? 1000 : 2000,
    processParent: (pid: number) => nodes.get(pid) ?? null,
  };
  const siblings = { ...heldClaude, launched: { shell: 400, cli: [405, 401], cli_start: [2000, 2000] } };
  expect(typedPaneProof(siblings, 'worker', 'fixture', 'acme', owner, true).ok).toBe(false);
  const helperFirst = { ...heldClaude, launched: { shell: 400, cli: [403, 401], cli_start: [2000, 2000] } };
  expect(typedPaneProof(helperFirst, 'worker', 'fixture', 'acme', { ...owner,
    processes: () => pane(400, [401, 402, 403, 404]),
  }, true).ok).toBe(true);
});
