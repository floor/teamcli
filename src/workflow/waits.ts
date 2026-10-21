// WF1-WAITS: the one shared derivation of the flat wait ledger. Replay and the dry runner keep
// the same `RunWait` records for the same definition, activations, signals and supplied settings;
// neither keeps a private copy and neither grows a second wait engine.
//
// The core `decide` stays the only decider. These helpers never choose a transition, never hold
// and never refuse: they start a state activation's pending wait and mark a recorded wait fired
// only in the exact window the core accepts (the state waits for the clock, the signal is
// `time-reached`, the setting is supplied and the recorded instant has reached it). Every other
// input is returned unchanged, so the core's own verdict — `settings.missing`,
// `wait.not-reached`, `wait.pending` — is what decides.
//
// Slice 1 only: no timer worker, no clock read, no ledger, no dispatch, no child identities,
// no close-or-hold ordering. Pure functions over the core's run-state contract.

import type { RunState, RunWait } from './core-state.ts';
import type { SettingSource } from './registry.ts';
import type { SignalName } from './signals.ts';
import type { Workflow } from './types.ts';

/**
 * The waits a fresh state activation starts with: one pending record when the state declares a
 * wait, none otherwise. Replay uses it for the run's initial state at activation 1; the dry
 * runner uses it wherever it enters a state without going through `waitsAfterStep`.
 */
export function waitsAtEntry(definition: Workflow, state: string, activation: number): RunWait[] {
  return definition.states[state]?.wait !== undefined ? [{ state, activation, status: 'pending' }] : [];
}

/**
 * The run with the current activation's recorded time wait marked fired, when the recorded
 * instant reaches its supplied setting. Returns `run` unchanged in every other case — a wait of
 * another kind, another signal, a missing setting, an instant before the setting, or no record
 * for this activation — so the core alone answers with `wait.pending`, `settings.missing` or
 * `wait.not-reached`. `input.settings` is the core's own `SettingSource`.
 */
export function fireRecordedWait(
  run: RunState,
  definition: Workflow,
  input: { signal: SignalName; at: string; settings: SettingSource },
): RunState {
  const wait = definition.states[run.state]?.wait;
  if (wait === undefined || wait.for !== 'time' || input.signal !== 'time-reached') return run;
  const reachedAt = input.settings.get(wait.at.name);
  if (reachedAt === undefined || input.at < reachedAt) return run;
  const index = run.waits.findIndex(
    (candidate) => candidate.state === run.state && candidate.activation === run.activation,
  );
  if (index < 0) return run;
  const waits = run.waits.map((candidate, position) =>
    position === index ? { ...candidate, status: 'fired' as const } : candidate,
  );
  return { ...run, waits };
}

/**
 * The waits after the core accepted a step: the leaving activation's wait is marked fired on the
 * signal that fired it (an approval wait on `approved`, a time wait on `time-reached`), a
 * pending record of another activation is untouched, and the entered state's activation starts
 * with a pending wait when it declares one. Call only after `decide` returns a step.
 */
export function waitsAfterStep(
  run: RunState,
  definition: Workflow,
  input: { signal: SignalName; nextState: string; nextActivation: number },
): RunWait[] {
  const wait = definition.states[run.state]?.wait;
  const fired =
    wait !== undefined &&
    (wait.for === 'approval' ? input.signal === 'approved' : input.signal === 'time-reached');
  const waits = run.waits.map((candidate) => {
    if (candidate.state !== run.state || candidate.activation !== run.activation) return candidate;
    return fired && candidate.status === 'pending' ? { ...candidate, status: 'fired' as const } : candidate;
  });
  if (definition.states[input.nextState]?.wait !== undefined) {
    waits.push({ state: input.nextState, activation: input.nextActivation, status: 'pending' });
  }
  return waits;
}
