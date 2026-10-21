// The dry module's public surface: the script reader, the pure runner and the pure replay entry
// point. B3 wires these under the `run --dry` and `replay` commands; no command registration,
// permission row, generated contract or doc text lives here.

export { dryReplay } from './replay.ts';
export type { DryReplayInput, DryReplayResult } from './replay.ts';
export { dryRun, dryRunId, reachableUses, usesDeferredWhy } from './run.ts';
export type { DryRunInput, DryRunResult } from './run.ts';
export { readScript } from './script.ts';
export type { DryScript, DryScriptReadResult, DrySignal } from './script.ts';
