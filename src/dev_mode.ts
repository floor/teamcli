// The dev-mode scope, in one place. `TEAMCLI_DEV_MODE`, set to exactly `1`, folds the caller
// gate of these seven commands — up, down, remove, register, add, restart and init — into a
// warning and lets the run continue past it. No other command lifts anything, and no other
// gate of these seven is lifted: `broker` and `tempo` stay owner-only in every mode, a
// non-owner never abandons (`remove --abandon`), a delegate's `add` never edits the file, and
// every placement, aim, approval, grant, delegation and trust word stays the refusal it is.
//
// Every use writes the audit log line beside the warning it prints — the one sink every
// command logs through (`logLine`) — so a run that went past a gate is on record with the
// caller it admitted. A dry run prints the warning and decides nothing, so it writes no line.
import type { Io } from './io.ts';
import { logLine } from './log.ts';

/** The commands whose caller gate dev mode lifts: the one place the list is written. */
export const DEV_MODE_COMMANDS = ['up', 'down', 'remove', 'register', 'add', 'restart', 'init'] as const;

export type DevModeCommand = (typeof DEV_MODE_COMMANDS)[number];

/** Whether dev mode is on: the variable set to exactly `1`. Every other value, unset included,
 *  leaves every gate where it is. This is the one place the variable is read. */
export function devMode(io: Io): boolean {
  return io.env.TEAMCLI_DEV_MODE === '1';
}

/**
 * The caller gate of `command`, folded: dev mode on and the command one of
 * `DEV_MODE_COMMANDS` answers the warning line the run prints — the refusal's own words, then
 * `; dev mode continues` — and null otherwise, leaving the gate to refuse. A command outside
 * the list has no call to make: its gates are not dev mode's to lift.
 */
export function devModeCallerGate(command: DevModeCommand, io: Io, refusal: string): string | null {
  if (!DEV_MODE_COMMANDS.includes(command) || !devMode(io)) return null;
  return `warning: ${refusal}; dev mode continues`;
}

/** The audit line a folded gate writes: the warning itself, through the log's one sink. */
export function logDevMode(dir: string, command: DevModeCommand, caller: string, warning: string, now?: Date): void {
  logLine(dir, command, caller, warning, now);
}
