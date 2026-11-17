// A Codex app-server another Codex process started serves every TUI that attaches to it, in any
// pane (codex-cli 0.169 after the 2026-11-17 machine restart: Hermes's tools in pane w56 ran under
// the server the Codex tester's TUI in w53 had spawned, and his send was placed "in pane w53").
// Such a caller is placed only by a managed endpoint record, never by the pane above the server.
import { describe, expect, test } from 'bun:test';
import { placeCaller, SHARED_CODEX_REASON, sharedCodexServer } from '../src/caller.ts';
import type { CallerSources, Process } from '../src/caller.ts';
import type { HerdrAgent } from '../src/herdr.ts';

const agent = (name: string | null, pane: string, cli = 'codex'): HerdrAgent => ({ name, agent: cli, pane, workspace: pane, status: 'idle', cwd: null });

// The tool's shell, the shared app-server (spawned by the TUI of pane A), that TUI, pane A's shell, herdr.
const underShared: Process[] = [
  { pid: 950, name: 'zsh' },
  { pid: 940, name: 'codex' },
  { pid: 930, name: 'codex' },
  { pid: 920, name: 'zsh' },
  { pid: 10, name: 'herdr' },
];

function sources(over: Partial<CallerSources> = {}): CallerSources {
  return {
    ancestors: () => underShared,
    agents: () => [agent('tester-codex', 'paneA'), agent('operator-02', 'paneB')],
    paneRootPid: (pane) => ({ paneA: 920, paneB: 820 })[pane] ?? null,
    env: { HERDR_PANE_ID: 'paneA' },
    stdinIsTTY: false,
    ...over,
  };
}

describe('a caller under a shared Codex app-server', () => {
  test('is never placed as the seat whose pane spawned the server', () => {
    expect(placeCaller(sources(), 'floor')).toEqual({ kind: 'unplaced', reason: SHARED_CODEX_REASON });
    expect(placeCaller(sources())).toEqual({ kind: 'unplaced', reason: SHARED_CODEX_REASON });
  });

  test('is never placed by an unnamed pane either', () => {
    const unnamed = sources({ agents: () => [agent(null, 'paneA'), agent(null, 'paneB')] });
    expect(placeCaller(unnamed, 'floor')).toEqual({ kind: 'unplaced', reason: SHARED_CODEX_REASON });
  });

  test('is still placed by a managed endpoint record that names it', () => {
    const served = (pid: number) => (pid === 940 ? { session: 'floor', seat: 'operator-02', pane: 'paneB' } : null);
    expect(placeCaller(sources({ managedEndpointSeat: served }), 'floor'))
      .toEqual({ kind: 'seat', name: 'operator-02', pane: 'paneB', session: 'floor' });
  });

  test('an endpoint record for another session does not place it', () => {
    const served = (pid: number) => (pid === 940 ? { session: 'material', seat: 'operator', pane: 'paneB' } : null);
    expect(placeCaller(sources({ managedEndpointSeat: served }), 'floor')).toEqual({ kind: 'unplaced', reason: SHARED_CODEX_REASON });
  });
});

describe('sharedCodexServer', () => {
  test('a Codex started directly by a Codex is a shared server', () => {
    expect(sharedCodexServer(underShared)).toBe(true);
  });

  test('a pane\'s own Codex TUI is not', () => {
    expect(sharedCodexServer([{ pid: 5, name: 'zsh' }, { pid: 4, name: 'codex' }, { pid: 3, name: 'zsh' }, { pid: 2, name: 'herdr' }])).toBe(false);
  });

  test('a Codex the seat runs from its own shell is not', () => {
    expect(sharedCodexServer([
      { pid: 7, name: 'zsh' }, { pid: 6, name: 'codex' }, { pid: 5, name: 'zsh' }, { pid: 4, name: 'codex' }, { pid: 3, name: 'zsh' }, { pid: 2, name: 'herdr' },
    ])).toBe(false);
  });

  test('a caller with no Codex above it is not', () => {
    expect(sharedCodexServer([{ pid: 5, name: 'zsh' }, { pid: 4, name: 'claude' }, { pid: 2, name: 'herdr' }])).toBe(false);
  });
});
