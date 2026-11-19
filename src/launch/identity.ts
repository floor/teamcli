import type { PaneProcesses } from '../herdr.ts';
import type { ProcessParent } from '../process-parent-adapter.ts';

// The process identity `team` records for a seat it launched: the pane's own shell process and
// the pids of the foreground processes that are not the shell — the CLI, and any helper herdr
// lists beside it. Read from `herdr pane process-info` after the idle prompt appears. Pids only:
// a command line, an argument or an environment can hold secrets, and none is ever stored,
// logged or printed.
//
// One recorded shell pid tells the two failures apart: a pane whose shell is still the recorded
// one but whose CLI is gone was restarted in place; a pane whose shell is another process was
// restored by something that started both again. Several CLI pids cover a CLI that shows a
// helper process beside it: the seat is the seat while any one of them is still in front.
export type LaunchedIdentity = {
  shell: number;
  cli: number[];
  /** Each CLI pid's start instant (epoch ms), in `cli`'s order, when it was read at launch: the
   *  typed path's proof that the CLI in front is the launch's, not a pid reused under the same
   *  shell. Absent on records written before it, or when a start could not be read. */
  cli_start?: number[];
};

// What the recorded identity says of the pane today.
// - `same`: the pane's shell is the recorded one and a recorded CLI pid is in front.
// - `gone`: the pane's own shell is in front and no CLI is: the seat is not running.
// - `replaced`: a process is in front that the record does not name: not the one team launched.
// - `unknown`: herdr can't tell — no record, no reading, no foreground process. Treated exactly
//   as a seat without a record (today's behaviour): a relaunch would record nothing either, so
//   there is no repair to make.
export type SeatProcessVerdict = 'same' | 'gone' | 'replaced' | 'unknown';

/** The pane's own shell is in front and no CLI is. Knowable without a recorded identity: the
 *  same reading `gone` uses once an identity exists. An empty foreground, or no reading, is
 *  not a shell — herdr could not say. */
export function paneHoldsShell(pane: PaneProcesses | null | undefined): boolean {
  if (!pane || pane.foreground.length === 0) return false;
  return pane.foreground.includes(pane.shell);
}

/** The pane's own shell is the only process in front. This is the reading a pane gives before
 *  a program is started in it and after the program is gone: no CLI, and no helper beside it.
 *  It is stricter than `paneHoldsShell`, which a foreground of `[shell, cli]` also satisfies —
 *  a pane that lists its shell *and* a process beside it is not one to launch into or close. */
export function paneHoldsOnlyShell(pane: PaneProcesses | null | undefined): boolean {
  if (!pane || pane.foreground.length === 0) return false;
  return pane.foreground.every((pid) => pid === pane.shell);
}

export function seatProcessVerdict(recorded: LaunchedIdentity | undefined, pane: PaneProcesses | null | undefined): SeatProcessVerdict {
  if (!recorded || !pane || pane.foreground.length === 0) return 'unknown';
  if (recorded.shell === pane.shell && recorded.cli.some((pid) => pane.foreground.includes(pid))) return 'same';
  // No CLI in front: the pane is back at its own shell. This is the bare-shell restore whether
  // or not the shell pid is still the recorded one.
  if (paneHoldsShell(pane)) return 'gone';
  return 'replaced';
}

/** Fresh metadata readers shared by activation and the watch's per-key ownership check. */
export type TypedPaneSources = {
  agents(session: string): { name: string; pane: string; session?: string }[] | null;
  processes(pane: string, session: string): PaneProcesses | null;
  processStart(pid: number): number | null;
  /** Atomic pid/parent/birth metadata; required only to prove new Claude descendants. */
  processParent?(pid: number): ProcessParent | null;
};

export type TypedPaneRecord = {
  pane?: string;
  launched?: LaunchedIdentity;
  pane_shell?: number;
  pane_shell_start?: number;
  agent_session?: string;
};

type PaneProof = { ok: true } | { ok: false; why: string };
const ANCESTRY_DEPTH = 64;
const ANCESTRY_PROCESSES = 256;

/** Additional foreground processes must descend from the fully verified recorded launch.
 *  Parent and birth are sampled together, then sampled again: a recycled intermediate pid
 *  cannot connect an older child to a newly born parent, or change identity during the walk. */
function descendantProof(recorded: number[], extra: number[], shell: number, owner: TypedPaneSources): PaneProof {
  const no = (why: string): PaneProof => ({ ok: false, why });
  const read = owner.processParent;
  if (read === undefined) return no('foreground ancestry cannot be read');
  const sampled = new Map<number, ProcessParent>();
  const sample = (pid: number): ProcessParent | null => {
    const seen = sampled.get(pid);
    if (seen !== undefined) return seen;
    if (sampled.size >= ANCESTRY_PROCESSES) return null;
    const node = read(pid);
    if (node === null || node.pid !== pid || !Number.isSafeInteger(node.ppid) || node.ppid < 0
      || !Number.isSafeInteger(node.birth) || node.birth <= 0) return null;
    const kept = { ...node };
    sampled.set(pid, kept);
    return kept;
  };
  const anchors = new Set(recorded);
  for (const pid of anchors) if (sample(pid) === null) return no('recorded CLI ancestry cannot be read');
  // Launch readings may include helpers beside the CLI, in any order. They must share
  // one recorded ancestor: an unrelated process accidentally recorded beside the CLI
  // must not become a second root that authorizes its own descendants.
  let root = recorded[0]!;
  if (anchors.size > 1) {
    const roots = new Set<number>();
    for (const pid of anchors) {
      let at = pid;
      let highest = pid;
      let childBirth = Number.POSITIVE_INFINITY;
      let ended = false;
      const seen = new Set<number>();
      for (let depth = 0; depth < ANCESTRY_DEPTH; depth++) {
        if (at <= 1 || at === shell) { ended = true; break; }
        if (seen.has(at)) return no('recorded CLI ancestry contains a cycle');
        seen.add(at);
        const node = sample(at);
        if (node === null) return no('recorded CLI ancestry cannot be read within its bound');
        if (node.birth > childBirth) return no('a recorded CLI ancestor was born after its child');
        if (anchors.has(at)) highest = at;
        childBirth = node.birth;
        at = node.ppid;
      }
      if (!ended) return no('recorded CLI ancestry exceeds its depth bound');
      roots.add(highest);
    }
    if (roots.size !== 1) return no('recorded CLI processes do not share one recorded ancestor');
    root = roots.values().next().value!;
  }
  for (const pid of extra) {
    let at = pid;
    let childBirth = Number.POSITIVE_INFINITY;
    let reached = false;
    const seen = new Set<number>();
    for (let depth = 0; depth < ANCESTRY_DEPTH; depth++) {
      if (at <= 1 || at === shell) return no('foreground ancestry does not reach the recorded CLI');
      if (seen.has(at)) return no('foreground ancestry contains a cycle');
      seen.add(at);
      const node = sample(at);
      if (node === null) return no('foreground ancestry cannot be read within its bound');
      if (node.birth > childBirth) return no('a foreground ancestor was born after its child');
      if (at === root) { reached = true; break; }
      childBirth = node.birth;
      at = node.ppid;
    }
    if (!reached) return no('foreground ancestry exceeds its depth bound');
  }
  for (const [pid, was] of sampled) {
    const now = read(pid);
    if (now === null || now.pid !== pid || now.ppid !== was.ppid || now.birth !== was.birth) return no('foreground process ancestry changed during the proof');
  }
  return { ok: true };
}

/** The typed ownership proof. Claude pointers additionally accept birth-checked descendants,
 *  and conversation continuity for legacy records lacking anchors. No arguments or environments. */
export function typedPaneProof(held: TypedPaneRecord | undefined, seat: string, pane: string, session: string, owner: TypedPaneSources, claudePointer = false): PaneProof {
  const no = (why: string) => ({ ok: false as const, why });
  try {
    if (held === undefined || held.pane !== pane || held.launched === undefined) return no('the recorded pane or launched identity is absent or different');
    const agents = owner.agents(session);
    if (agents === null) return no('the terminal host agent list cannot be read');
    const onPane = agents.filter(agent => agent.pane === pane);
    if (onPane.length !== 1 || onPane[0]?.name !== seat) return no('the recorded pane does not uniquely name this seat');
    if (agents.filter(agent => agent.name === seat).length !== 1) return no('the seat name is not unique');
    const processes = owner.processes(pane, session);
    if (processes === null) return no('the pane process identity cannot be read');
    if (processes.shell !== (held.pane_shell ?? held.launched.shell)) return no('the shell is not the recorded shell');
    if (seatProcessVerdict(held.launched, processes) !== 'same') return no('the recorded CLI is not in front of its shell');
    if (held.pane_shell === undefined && held.pane_shell_start === undefined) {
      if (!claudePointer) return no('the shell anchors are absent');
      const conversation = held.agent_session;
      if (conversation === undefined || conversation === '' || onPane[0]?.session !== conversation) return no('the live conversation does not match the recorded conversation');
      if (agents.filter(agent => agent.session === conversation).length !== 1) return no('the recorded conversation is not unique');
    } else {
      if (held.pane_shell === undefined || held.pane_shell_start === undefined) return no('the shell anchors are incomplete');
      if (owner.processStart(processes.shell) !== held.pane_shell_start) return no('the shell start does not match the recorded start');
    }
    const starts = held.launched.cli_start;
    const extra = processes.foreground.filter(pid => pid !== processes.shell && !held.launched!.cli.includes(pid));
    if (starts === undefined) {
      if (claudePointer && extra.length > 0) return no('descendant proof requires recorded CLI starts');
      return { ok: true };
    }
    if (starts.length !== held.launched.cli.length) return no('the recorded CLI starts are incomplete');
    if (!held.launched.cli.every((pid, at) => processes.foreground.includes(pid) && owner.processStart(pid) === starts[at])) return no('a recorded CLI process or its birth no longer matches');
    if (extra.length > 0) {
      if (!claudePointer) return no('an unrecorded process is in front of the shell');
      const descendants = descendantProof(held.launched.cli, extra, processes.shell, owner);
      if (!descendants.ok) return descendants;
      // The longer proof must not outlive its starting pane or recorded process generation.
      const current = owner.processes(pane, session);
      if (current === null || current.shell !== processes.shell
        || current.foreground.length !== processes.foreground.length
        || !current.foreground.every(pid => processes.foreground.includes(pid))) return no('the foreground process set changed during the proof');
      if (!held.launched.cli.every((pid, at) => owner.processStart(pid) === starts[at])) return no('a recorded CLI process or its birth no longer matches');
    }
    return { ok: true };
  } catch {
    return no('the pane ownership proof could not be read');
  }
}

/** The identity to record from a pane reading, or null when herdr can't give one: no shell pid,
 *  or no foreground process beside it. A seat with no record keeps today's behaviour. */
export function launchedIdentity(pane: PaneProcesses | null | undefined, startOf?: (pid: number) => number | null): LaunchedIdentity | null {
  if (!pane) return null;
  const cli = pane.foreground.filter((pid) => pid !== pane.shell);
  if (cli.length === 0) return null;
  const starts = startOf === undefined ? null : cli.map((pid) => startOf(pid));
  return starts === null || starts.some((one) => one === null)
    ? { shell: pane.shell, cli }
    : { shell: pane.shell, cli, cli_start: starts as number[] };
}

// What a `replaced` pane is, once the pid verdict is known. The pid comparison above is unchanged.
// - `restored`: a program is in front, herdr names this seat on the recorded pane, and the live
//   agent session is the one stored at launch. The seat is the seat. Nothing is closed.
// - `doubt`: a program is in front and that session cannot be shown. Nothing is closed.
// - `other`: the verdict is not `replaced` (`same`, `gone`, `unknown`). Callers keep the pid verdict.
export type ReplacedContinuity = 'restored' | 'doubt' | 'other';

export function replacedSeat(
  verdict: SeatProcessVerdict,
  input: {
    /** False when herdr's agent list could not be read. */
    asked: boolean;
    /** The agent list names this seat on the recorded pane. */
    namedOnPane: boolean;
    recordedSession: string | undefined;
    liveSession: string | undefined;
  },
): ReplacedContinuity {
  if (verdict !== 'replaced') return 'other';
  const recorded = input.recordedSession;
  const live = input.liveSession;
  if (
    input.asked &&
    input.namedOnPane &&
    typeof recorded === 'string' &&
    recorded !== '' &&
    typeof live === 'string' &&
    live !== '' &&
    recorded === live
  ) {
    return 'restored';
  }
  return 'doubt';
}
