// The typed pane proof (src/launch/identity.ts) after a launch whose CLI started short-lived
// helpers. A launch records every foreground pid at the idle prompt; Claude Code starts children
// in its own process group as it comes up, and those that exit afterwards stay in the record.
// For a Claude pointer the CLI anchor the launch verified (a direct child of the shell under the
// CLI's own name), at its recorded birth, and its birth-checked descendants still prove the pane;
// every other typed proof, and a record without an anchor, keeps the whole recorded set. A helper
// or a sibling left in front without the anchor is never the seat.
import { describe, expect, test } from 'bun:test';
import { cliAnchorOf, launchedIdentity, typedPaneProof, type TypedPaneSources } from '../src/launch/identity.ts';

const SESSION = 'acme';

describe('the typed pane proof after a launch whose CLI started short-lived helpers', () => {
  // The launch reads every foreground pid at the idle prompt. Claude Code starts helpers in its
  // own process group as it comes up; those that exit afterwards stay in the record.
  const held = {
    pane: 'pane-lead', agent_session: 'session-of-lead', pane_shell: 111, pane_shell_start: 1_700_000_000_000,
    launched: { shell: 111, cli: [224, 223, 222], cli_start: [1_700_000_001_000, 1_700_000_001_000, 1_700_000_000_000], cli_anchor: 222 },
  };
  const births: Record<number, number> = { 111: 1_700_000_000_000, 222: 1_700_000_000_000 };
  function owner(foreground: number[], born: Record<number, number> = births): TypedPaneSources {
    return {
      agents: () => [{ name: 'lead', pane: 'pane-lead', session: 'session-of-lead' }],
      processes: () => ({ shell: 111, foreground }),
      processStart: (pid: number) => born[pid] ?? null,
      processParent: (pid: number) => pid === 999 ? { pid, ppid: 222, birth: 1_700_000_002_000_000 }
        : pid === 223 ? { pid, ppid: 222, birth: 1_700_000_001_000_000 }
        : pid === 225 ? { pid, ppid: 111, birth: 1_700_000_001_000_000 }
        : pid === 222 ? { pid, ppid: 111, birth: 1_700_000_000_000_000 } : null,
    };
  }
  const NO_MATCH = { ok: false, why: 'a recorded CLI process or its birth no longer matches' };

  test('for a Claude pointer, helpers that exited are not asked: the launch still in front at its birth, and its descendants, prove the pane', () => {
    expect(typedPaneProof(held, 'lead', 'pane-lead', SESSION, owner([222]), true)).toEqual({ ok: true });
    expect(typedPaneProof(held, 'lead', 'pane-lead', SESSION, owner([222, 223], { ...births, 223: 1_700_000_001_000 }), true)).toEqual({ ok: true });
    expect(typedPaneProof(held, 'lead', 'pane-lead', SESSION, owner([999, 222], { ...births, 999: 1_700_000_002_000 }), true)).toEqual({ ok: true });
  });

  test('a missing member still fails closed off the Claude pointer, and for a helper left alone, a changed birth or an unrelated process', () => {
    // Every other typed proof keeps the whole recorded set.
    expect(typedPaneProof(held, 'lead', 'pane-lead', SESSION, owner([222]), false)).toEqual(NO_MATCH);
    // A recorded helper left in front without the launch is not the seat.
    expect(typedPaneProof(held, 'lead', 'pane-lead', SESSION, owner([223], { ...births, 223: 1_700_000_001_000 }), true)).toEqual(NO_MATCH);
    // The launch at another birth, or a recorded helper pid reused by a newer process.
    expect(typedPaneProof(held, 'lead', 'pane-lead', SESSION, owner([222], { ...births, 222: 1_700_000_009_000 }), true)).toEqual(NO_MATCH);
    expect(typedPaneProof(held, 'lead', 'pane-lead', SESSION, owner([222, 223], { ...births, 223: 1_700_000_005_000 }), true)).toEqual(NO_MATCH);
    // A process in front that does not descend from the launch.
    expect(typedPaneProof(held, 'lead', 'pane-lead', SESSION, owner([222, 777], { ...births, 777: 1_700_000_002_000 }), true).ok).toBe(false);
    // A recorded sibling the shell itself started, left in front after the CLI exited: its pid,
    // birth and parent all pass, and it is still not the CLI the launch verified.
    const sibling = { ...held, launched: { shell: 111, cli: [225, 222], cli_start: [1_700_000_001_000, 1_700_000_000_000], cli_anchor: 222 } };
    expect(typedPaneProof(sibling, 'lead', 'pane-lead', SESSION, owner([225], { ...births, 225: 1_700_000_001_000 }), true)).toEqual(NO_MATCH);
    // A record with no anchor keeps the whole-set rule, even for the shell's own child.
    const { cli_anchor: _anchor, ...bare } = held.launched;
    expect(typedPaneProof({ ...held, launched: bare }, 'lead', 'pane-lead', SESSION, owner([222]), true)).toEqual(NO_MATCH);
    // No parent reader: no exception.
    const blind = { ...owner([222]) };
    delete blind.processParent;
    expect(typedPaneProof(held, 'lead', 'pane-lead', SESSION, blind, true)).toEqual(NO_MATCH);
  });
});

describe('the CLI anchor the launch records', () => {
  const table: Record<number, { ppid: number; name: string }> = {
    222: { ppid: 111, name: 'claude' }, 223: { ppid: 222, name: 'bun' }, 225: { ppid: 111, name: 'security' }, 226: { ppid: 111, name: 'claude' },
  };
  const read = (pid: number) => table[pid] ?? null;
  test('exactly one direct child of the shell under the CLI\'s name, or none', () => {
    expect(cliAnchorOf([223, 225, 222], 111, ['claude'], read)).toBe(222);
    expect(cliAnchorOf([223, 225], 111, ['claude'], read)).toBeNull();
    expect(cliAnchorOf([222, 226], 111, ['claude'], read)).toBeNull();
    expect(cliAnchorOf([222], 111, [], read)).toBeNull();
    expect(cliAnchorOf([222], 999, ['claude'], read)).toBeNull();
  });
  test('the launch reading carries it only beside the recorded starts', () => {
    const pane = { shell: 111, foreground: [223, 222] };
    expect(launchedIdentity(pane, () => 5, { processNames: ['claude'], read })).toEqual({ shell: 111, cli: [223, 222], cli_start: [5, 5], cli_anchor: 222 });
    expect(launchedIdentity(pane, () => null, { processNames: ['claude'], read })).toEqual({ shell: 111, cli: [223, 222] });
    expect(launchedIdentity(pane, () => 5)).toEqual({ shell: 111, cli: [223, 222], cli_start: [5, 5] });
  });
});
