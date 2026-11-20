// Rebind a seat whose pane was started again around its recorded conversation: a machine
// restart, or the terminal host's session stopped and started (by hand or by the daemon's boot
// restore) within one boot.
//
// `team up --rebind` proves a seat by the process `team` launched: the recorded CLI pid still in
// front of its pane. After any restart no recorded pid can be, so the plain proof refuses every
// restored seat. This proof replaces the pid rule, and only that rule, with three readings that
// together say the pane is the seat's own launch carried across the restart:
//
// 1. the pane is a later process generation than the record: the live shell started after the
//    recorded launch did (the recorded shell's start, else the newest recorded CLI start, read
//    with the same clock as the record), so the record cannot name a newer launch than the pane;
// 2. the pane holds the conversation the record names, exactly, and no other pane of the session
//    reports it: the live agent session equals the recorded one, so a different or a blank
//    conversation is never adopted;
// 3. the declared CLI is in front of the pane.
//
// Anything weaker is refused. The caller has already proven the pane's place (the live agent is
// uniquely placed on the recorded pane, named for this seat or unnamed) and re-reads it after.
import { launchedIdentity, seatProcessVerdict, type LaunchedIdentity } from './identity.ts';
import { reportedLiveAgent } from './agent.ts';
import { profileFor } from '../profiles/index.ts';
import type { PaneProcesses } from '../herdr.ts';
import type { ProcessParent } from '../process-parent-adapter.ts';

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
  /** How many agents of the session report the live conversation (this pane's included). */
  sessionReports: number;
  /** A process's start instant, in the clock the record was written with. */
  startOf: (pid: number) => number | null;
  /** Pid, parent and birth, read together: proves that several foreground processes are one
   *  launch's tree. Absent: a foreground of more than one process is refused. */
  parentOf?: (pid: number) => ProcessParent | null;
};

export type RebootRebind =
  | { ok: true; launched: LaunchedIdentity; shell: number; shellStart: number }
  | { ok: false; why: string };

/** The instant the recorded launch began: its shell's start, else its newest CLI start. */
function recordedLaunchInstant(launched: LaunchedIdentity | undefined, paneShellStart: number | undefined): number | null {
  if (paneShellStart !== undefined) return paneShellStart;
  const starts = launched?.cli_start;
  if (starts === undefined || starts.length === 0 || !starts.every((one) => Number.isSafeInteger(one) && one > 0)) return null;
  return Math.max(...starts);
}

const ANCESTRY_DEPTH = 64;

/**
 * Whether the pane holds a later process generation than the record: no recorded CLI is in front
 * (`replaced`), or the recorded pids are in front but a birth read now positively differs from
 * the recorded one (reused pids). An unreadable birth is not a difference.
 */
export function restartedGeneration(
  launched: LaunchedIdentity | undefined,
  paneShellStart: number | undefined,
  processes: PaneProcesses | null,
  startOf: (pid: number) => number | null,
): boolean {
  const verdict = seatProcessVerdict(launched, processes);
  if (verdict === 'replaced') return true;
  if (verdict !== 'same' || launched === undefined || processes === null) return false;
  const differs = (pid: number, recorded: number | undefined): boolean => {
    if (recorded === undefined) return false;
    const now = startOf(pid);
    return now !== null && now !== recorded;
  };
  if (differs(processes.shell, paneShellStart)) return true;
  const starts = launched.cli_start;
  return starts !== undefined && launched.cli.some((pid, at) => processes.foreground.includes(pid) && differs(pid, starts[at]));
}

/** Several foreground processes must be one tree: exactly one is the shell's child, and every
 *  other descends from it within a bounded walk. One process needs no tree. */
function oneLaunchTree(cli: readonly number[], shell: number, parentOf: ((pid: number) => ProcessParent | null) | undefined): boolean {
  if (cli.length === 1) return true;
  if (parentOf === undefined) return false;
  const read = (pid: number): ProcessParent | null => {
    const node = parentOf(pid);
    return node !== null && node.pid === pid && Number.isSafeInteger(node.ppid) ? node : null;
  };
  const roots = cli.filter((pid) => read(pid)?.ppid === shell);
  if (roots.length !== 1) return false;
  const root = roots[0]!;
  for (const pid of cli) {
    if (pid === root) continue;
    let at = pid;
    let reached = false;
    for (let depth = 0; depth < ANCESTRY_DEPTH; depth++) {
      const node = read(at);
      if (node === null || node.ppid <= 1 || node.ppid === shell) break;
      if (node.ppid === root) { reached = true; break; }
      at = node.ppid;
    }
    if (!reached) return false;
  }
  return true;
}

export function rebootRebindProof(input: RebootRebindInput): RebootRebind {
  const no = (why: string) => ({ ok: false as const, why });
  if (!restartedGeneration(input.launched, input.paneShellStart, input.processes, input.startOf)) {
    return no('the pane does not hold a later process generation than the recorded launch');
  }
  const recorded = input.recordedSession;
  if (recorded === undefined || recorded === '' || input.liveSession !== recorded) {
    return no('the pane does not hold the recorded launched CLI process, and its conversation is not the one the record names');
  }
  if (input.sessionReports !== 1) {
    return no('the pane does not hold the recorded launched CLI process, and its conversation is not reported by this pane alone');
  }
  const names = profileFor(input.cli)?.processNames ?? [];
  if (!reportedLiveAgent(input.foreground, names)) {
    return no(`the pane does not hold the recorded launched CLI process, and ${input.cli} is not in front of it`);
  }
  const launchedAt = recordedLaunchInstant(input.launched, input.paneShellStart);
  if (launchedAt === null) {
    return no('the pane does not hold the recorded launched CLI process, and the record has no start to date its launch');
  }
  const next = launchedIdentity(input.processes, input.startOf);
  if (next === null) return no('the pane does not hold the recorded launched CLI process, and its live process cannot be read');
  // Every process recorded carries its birth: a record without them would let the typed proof
  // trust pids alone.
  if (next.cli_start === undefined) return no('the pane does not hold the recorded launched CLI process, and a live process birth cannot be read');
  if (!oneLaunchTree(next.cli, next.shell, input.parentOf)) {
    return no('the pane does not hold the recorded launched CLI process, and its foreground is not one launch\'s process tree');
  }
  const shellStart = input.startOf(next.shell);
  // The same shell (or a reused pid) started no later than the recorded launch is refused here.
  if (shellStart === null || shellStart < launchedAt + BOOT_SKEW_MS) {
    return no('the pane does not hold the recorded launched CLI process, and its live shell is not a later start than the recorded launch');
  }
  return { ok: true, launched: next, shell: next.shell, shellStart };
}
