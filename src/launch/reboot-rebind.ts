// Rebind a seat whose pane the terminal host restored after a machine restart.
//
// `team up --rebind` proves a seat by the process `team` launched: the recorded CLI pid still in
// front of its pane. After a restart no recorded pid can be, so the plain proof refuses every
// restored lead. This proof replaces the pid rule, and only that rule, with three readings that
// together say the pane is the seat's own launch carried across the restart:
//
// 1. the record's launch predates this boot: the recorded shell started before the machine's
//    first process did (pid 1, read with the same clock as the record), and the live shell
//    started after it;
// 2. the pane holds the conversation the record names, exactly: the live agent session equals
//    the recorded one, so a different or a blank conversation is never adopted;
// 3. the declared CLI is in front of the pane.
//
// Anything weaker is refused. The caller has already proven the pane's place (the live agent is
// uniquely placed on the recorded pane, named for this seat or unnamed) and re-reads it after.
import { launchedIdentity, seatProcessVerdict, type LaunchedIdentity } from './identity.ts';
import { reportedLiveAgent } from './agent.ts';
import { profileFor } from '../profiles/index.ts';
import type { PaneProcesses } from '../herdr.ts';

/** Clock granularity of a process start reading (one second) plus a small margin. */
export const BOOT_SKEW_MS = 2_000;

export type RebootRebindInput = {
  cli: string;
  /** The state's record: the launched identity, its shell's start, and its conversation. */
  launched: LaunchedIdentity | undefined;
  paneShellStart: number | undefined;
  recordedSession: string | undefined;
  /** The live readings. */
  processes: PaneProcesses | null;
  foreground: readonly string[] | null;
  liveSession: string | undefined;
  /** A process's start instant, in the clock the record was written with. */
  startOf: (pid: number) => number | null;
};

export type RebootRebind =
  | { ok: true; launched: LaunchedIdentity; shell: number; shellStart: number; boot: number }
  | { ok: false; why: string };

export function rebootRebindProof(input: RebootRebindInput): RebootRebind {
  const no = (why: string) => ({ ok: false as const, why });
  if (seatProcessVerdict(input.launched, input.processes) !== 'replaced') {
    return no('the pane does not hold the recorded launched CLI process');
  }
  const recorded = input.recordedSession;
  if (recorded === undefined || recorded === '' || input.liveSession !== recorded) {
    return no('the pane does not hold the recorded launched CLI process, and its conversation is not the one the record names');
  }
  const names = profileFor(input.cli)?.processNames ?? [];
  if (!reportedLiveAgent(input.foreground, names)) {
    return no(`the pane does not hold the recorded launched CLI process, and ${input.cli} is not in front of it`);
  }
  if (input.paneShellStart === undefined) {
    return no('the pane does not hold the recorded launched CLI process, and the record has no shell start to date its launch');
  }
  const boot = input.startOf(1);
  if (boot === null) return no('the pane does not hold the recorded launched CLI process, and the boot instant cannot be read');
  if (input.paneShellStart >= boot - BOOT_SKEW_MS) {
    return no('the pane does not hold the recorded launched CLI process, and the record was launched in this boot');
  }
  const next = launchedIdentity(input.processes);
  if (next === null) return no('the pane does not hold the recorded launched CLI process, and its live process cannot be read');
  const shellStart = input.startOf(next.shell);
  if (shellStart === null || shellStart < boot - BOOT_SKEW_MS) {
    return no('the pane does not hold the recorded launched CLI process, and its live shell does not date from this boot');
  }
  return { ok: true, launched: next, shell: next.shell, shellStart, boot };
}
