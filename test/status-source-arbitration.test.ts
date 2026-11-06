// Synthetic snapshots for source arbitration. Tokens are fixtures. Nothing here reads a clock, a
// process table, or a session.
import { describe, expect, test } from 'bun:test';
import {
  arbitrateSources,
  initialArbitration,
  type ArbitrationView,
  type PromptClass,
} from '../src/status/source-arbitration.ts';

const GATE = {
  gateId: 'gate-a',
  toolId: 'tool-a',
  mainTurn: 'turn-a',
  binding: 'bind-a',
  ownerRequired: true as const,
};

function native(extra: Record<string, unknown> = {}) {
  return {
    seatId: 'id-a',
    incarnation: 'inc-a',
    health: 'healthy',
    continuity: 'proven',
    advisory: 'quiet',
    gate: null,
    processConfirmation: 'not_requested',
    promptCoverage: 'full',
    ...extra,
  };
}

function host(extra: Record<string, unknown> = {}) {
  return {
    seatId: 'id-a',
    incarnation: 'inc-a',
    health: 'healthy',
    advisory: 'quiet',
    prompt: 'none',
    ...extra,
  };
}

function screen(extra: Record<string, unknown> = {}) {
  return {
    seatId: 'id-a',
    incarnation: 'inc-a',
    health: 'healthy',
    advisory: 'quiet',
    prompt: 'none' as PromptClass,
    current: true,
    ...extra,
  };
}

function proc(fence: number, exit: string, extra: Record<string, unknown> = {}) {
  return {
    seatId: 'id-a',
    incarnation: 'inc-a',
    processId: 'proc-a',
    expectedProcessId: 'proc-a',
    fence,
    exit,
    ...extra,
  };
}

function snap(extra: Record<string, unknown> = {}) {
  return {
    context: { seatId: 'id-a', incarnation: 'inc-a' },
    native: native(),
    host: null,
    screen: null,
    process: null,
    ...extra,
  };
}

function run(current: ArbitrationView, extra: Record<string, unknown> = {}) {
  return arbitrateSources(current, snap(extra));
}

describe('source arbitration', () => {
  test('a healthy proven quiet reading stays quiet and does not expire by an extra time field', () => {
    const first = run(initialArbitration());
    expect(first.reason).toBe('native_quiet');
    expect(first.view.advisory).toBe('quiet');
    expect(first.view.exit).toBe('unproven');
    expect(JSON.stringify(first.view)).not.toContain('idle');
    const again = arbitrateSources(first.view, snap());
    expect(again.view).toBe(first.view);
    expect(again.applied).toBe(false);
    const timed = arbitrateSources(first.view, { ...snap(), observedAt: '2026-01-01T00:00:00Z' });
    expect(timed.view).toBe(first.view);
    expect(timed.reason).toBe('malformed');
  });

  test('native working wins over a lower-tier quiet reading, and full coverage ignores a screen prompt', () => {
    const decided = run(initialArbitration(), {
      native: native({ advisory: 'working' }),
      host: host({ advisory: 'quiet' }),
      screen: screen({ prompt: 'question', advisory: 'quiet' }),
    });
    expect(decided.reason).toBe('native_advisory');
    expect(decided.view.source).toBe('native');
    expect(decided.view.advisory).toBe('working');
    expect(decided.view.prompt).toBe('none');
    expect(decided.view.disagreement).toBeNull();
  });

  test('an open native gate stays owner-required across host, screen, and a false owner flag', () => {
    const opened = run(initialArbitration(), {
      native: native({ advisory: 'gated', gate: GATE }),
      host: host({ advisory: 'quiet' }),
      screen: screen({ advisory: 'quiet', prompt: 'none' }),
    });
    expect(opened.view.gate).toEqual(GATE);
    expect(opened.view.advisory).toBe('gated');
    expect(opened.reason).toBe('native_gate');
    const classified = arbitrateSources(opened.view, snap({
      native: native({ advisory: 'gated', gate: GATE }),
      screen: screen({ prompt: 'permission' }),
    }));
    expect(classified.reason).toBe('gate_preserved');
    expect(classified.view.disagreement).toBe('prompt_classified');
    expect(classified.view.prompt).toBe('permission');
    expect(classified.view.gate?.ownerRequired).toBe(true);
    const lowered = arbitrateSources(classified.view, snap({
      native: native({ advisory: 'gated', gate: { ...GATE, ownerRequired: false } }),
    }));
    expect(lowered.view).toBe(classified.view);
    expect(lowered.reason).toBe('malformed');
    expect(Object.keys(classified).sort()).toEqual(['applied', 'reason', 'view']);
    expect(JSON.stringify(classified)).not.toContain('dispatch');
  });

  test('a current screen prompt refines native quiet and partial working, not full working', () => {
    const quiet = run(initialArbitration(), {
      screen: screen({ prompt: 'login' }),
    });
    expect(quiet.reason).toBe('screen_refined_quiet');
    expect(quiet.view.source).toBe('screen');
    expect(quiet.view.advisory).toBe('quiet');
    expect(quiet.view.prompt).toBe('login');
    const partial = run(initialArbitration(), {
      native: native({ advisory: 'working', promptCoverage: 'partial' }),
      screen: screen({ prompt: 'trust' }),
    });
    expect(partial.reason).toBe('screen_refined_partial_working');
    expect(partial.view.advisory).toBe('working');
    const staleScreen = run(initialArbitration(), {
      screen: screen({ prompt: 'login', current: false }),
    });
    expect(staleScreen.reason).toBe('native_quiet');
    expect(staleScreen.view.prompt).toBe('none');
  });

  test('missing and unhealthy native fall back host then screen, otherwise unknown', () => {
    const byHost = run(initialArbitration(), {
      native: native({ health: 'unhealthy', advisory: 'working' }),
      host: host({ advisory: 'working' }),
      screen: screen({ advisory: 'quiet', prompt: 'question' }),
    });
    expect(byHost.reason).toBe('host_fallback');
    expect(byHost.view.source).toBe('host');
    expect(byHost.view.advisory).toBe('working');
    const byScreen = run(initialArbitration(), {
      native: null,
      host: host({ health: 'missing', advisory: 'working' }),
      screen: screen({ advisory: 'quiet' }),
    });
    expect(byScreen.reason).toBe('screen_fallback');
    expect(byScreen.view.source).toBe('screen');
    const none = run(initialArbitration(), { native: null, host: null, screen: null });
    expect(none.reason).toBe('none_usable');
    expect(none.view.advisory).toBe('unknown');
    expect(none.view.source).toBe('none');
  });

  test('unproven continuity cannot win, and a foreign tier cannot overwrite', () => {
    const fallen = run(initialArbitration(), {
      native: native({ continuity: 'unproven', advisory: 'working' }),
      host: host({ advisory: 'quiet' }),
    });
    expect(fallen.reason).toBe('host_fallback');
    expect(fallen.view.disagreement).toBe('continuity_unproven');
    expect(fallen.view.advisory).toBe('quiet');
    const held = arbitrateSources(fallen.view, snap({
      context: { seatId: 'id-b', incarnation: 'inc-a' },
      native: native({ seatId: 'id-b', advisory: 'working' }),
    }));
    expect(held.view).toBe(fallen.view);
    expect(held.reason).toBe('context_mismatch');
    const foreignHost = arbitrateSources(fallen.view, snap({
      host: host({ seatId: 'id-b', advisory: 'working' }),
    }));
    expect(foreignHost.view.advisory).toBe('quiet');
    expect(foreignHost.view.source).toBe('native');
  });

  test('session-end without process proof stays unconfirmed and never quiet', () => {
    const ended = run(initialArbitration(), {
      native: native({ processConfirmation: 'needed' }),
    });
    expect(ended.reason).toBe('session_end_unconfirmed');
    expect(ended.view.exit).toBe('confirmation-needed');
    expect(ended.view.advisory).toBe('unknown');
    expect(JSON.stringify(ended.view)).not.toContain('idle');
    expect(JSON.stringify(ended.view)).not.toContain('done');
    const gated = run(initialArbitration(), {
      native: native({ advisory: 'gated', gate: GATE, processConfirmation: 'needed' }),
    });
    expect(gated.view.gate).toEqual(GATE);
    expect(gated.view.exit).toBe('confirmation-needed');
    expect(gated.view.advisory).toBe('gated');
  });

  test('process proof is fenced, and only a matching clean exit with no gate completes', () => {
    const base = run(initialArbitration());
    const clean = arbitrateSources(base.view, snap({ process: proc(1, 'clean') }));
    expect(clean.reason).toBe('clean_exit');
    expect(clean.view.exit).toBe('exited');
    expect(clean.view.advisory).toBe('unknown');
    const stale = arbitrateSources(clean.view, snap({ process: proc(1, 'abnormal') }));
    expect(stale.view).toBe(clean.view);
    expect(stale.reason).toBe('process_stale');
    const blocked = run(initialArbitration(), {
      native: native({ advisory: 'gated', gate: GATE }),
      process: proc(2, 'clean'),
    });
    expect(blocked.reason).toBe('exit_blocked_by_gate');
    expect(blocked.view.exit).toBe('confirmation-needed');
    expect(blocked.view.gate).toEqual(GATE);
    const abnormal = run(initialArbitration(), { process: proc(3, 'abnormal') });
    expect(abnormal.reason).toBe('abnormal_exit');
    expect(abnormal.view.exit).toBe('unreachable');
    expect(abnormal.view.exit).not.toBe('exited');
    const mismatched = arbitrateSources(base.view, snap({
      process: proc(4, 'clean', { processId: 'proc-b' }),
    }));
    expect(mismatched.reason).toBe('process_mismatch');
    expect(mismatched.view.exit).toBe('unproven');
    const unknown = run(initialArbitration(), { process: proc(5, 'unknown') });
    expect(unknown.reason).toBe('exit_unknown');
    expect(unknown.view.exit).toBe('unconfirmed');
  });

  test('malformed and unsupported snapshots do not throw or replace the current view', () => {
    const current = run(initialArbitration()).view;
    const inputs: unknown[] = [
      null,
      snap({ native: native({ advisory: 'idle' }) }),
      snap({ native: native({ advisory: 'done' }) }),
      snap({ process: proc(1, 'clean', { fence: 1.5 }) }),
      { context: { seatId: 'id-a', incarnation: 'inc-a' } },
    ];
    for (const input of inputs) {
      expect(() => arbitrateSources(current, input)).not.toThrow();
      const decided = arbitrateSources(current, input);
      expect(decided.view).toBe(current);
      expect(decided.applied).toBe(false);
      expect(['malformed', 'unsupported']).toContain(decided.reason);
    }
    expect(arbitrateSources(current, snap({ native: native({ advisory: 'idle' }) })).reason).toBe('unsupported');
  });

  test('a process reason overrides the selection reason while the gated view stays', () => {
    const opened = run(initialArbitration(), {
      native: native({ advisory: 'gated', gate: GATE }),
      process: proc(1, 'running'),
    });
    expect(opened.reason).toBe('native_gate');
    expect(opened.view.advisory).toBe('gated');
    expect(opened.view.processFence).toBe(1);
    const stale = arbitrateSources(opened.view, snap({
      native: native({ advisory: 'gated', gate: GATE }),
      screen: screen({ prompt: 'permission', advisory: 'quiet' }),
      process: proc(1, 'clean'),
    }));
    expect(stale.reason).toBe('process_stale');
    expect(stale.view.advisory).toBe('gated');
    expect(stale.view.source).toBe('native');
    expect(stale.view.gate).toEqual(GATE);
    expect(stale.view.prompt).toBe('permission');
    expect(stale.view.disagreement).toBe('prompt_classified');
    expect(stale.view.exit).toBe('unproven');
    expect(stale.view.processFence).toBe(1);
    expect(stale.applied).toBe(true);
  });

  test('a foreign native tier is discarded and cannot import or clear a gate', () => {
    const opened = run(initialArbitration(), {
      native: native({ advisory: 'gated', gate: GATE }),
    });
    const kept = arbitrateSources(opened.view, snap({
      native: native({ seatId: 'id-b', advisory: 'quiet', gate: null }),
      host: host({ advisory: 'working' }),
    }));
    expect(kept.reason).toBe('native_gate');
    expect(kept.view.advisory).toBe('gated');
    expect(kept.view.gate).toEqual(GATE);
    expect(kept.view.source).toBe('native');
    const quiet = run(initialArbitration());
    const fallback = arbitrateSources(quiet.view, snap({
      native: native({ seatId: 'id-b', advisory: 'gated', gate: GATE }),
      host: host({ advisory: 'working' }),
    }));
    expect(fallback.reason).toBe('host_fallback');
    expect(fallback.view.source).toBe('host');
    expect(fallback.view.advisory).toBe('working');
    expect(fallback.view.gate).toBeNull();
    expect(fallback.view.disagreement).toBeNull();
  });

  test('leaves its inputs unchanged', () => {
    const current = initialArbitration();
    const input = snap({ native: native({ advisory: 'gated', gate: GATE }) });
    Object.freeze(input);
    Object.freeze(input.native);
    Object.freeze(GATE);
    const decided = arbitrateSources(current, input);
    expect(current.gate).toBeNull();
    expect(decided.view).not.toBe(current);
    expect(decided.view.gate).not.toBe(GATE);
    expect(decided.view.gate).toEqual(GATE);
  });
});
