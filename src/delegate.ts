import { approvalDifferencesOf, approvedFingerprints, notInForce } from './approve/approval.ts';
import { compare, describe, fingerprints } from './approve/fingerprint.ts';
import { callerOf, describeCaller, readAncestors, type Caller, type CallerSources } from './caller.ts';
import type { ActingCommand, Delegate, DelegateCommand } from './delegate-types.ts';
import { ACTING_COMMANDS } from './delegate-types.ts';
import type { TeamFile } from './file/types.ts';
import { validateTeamFile } from './file/validate.ts';
import { agentList, paneRootPid, sessionRunning, type HerdrAgent } from './herdr.ts';
import type { Io } from './io.ts';
import { logLine } from './log.ts';
import { readState, type State } from './state.ts';
import { approvalStanding, approvedCopy, type Standing } from './store/store.ts';

/**
 * A delegated run, decided and not yet done. `passed` names the approved pane the caller
 * stood in. `refused` is what the command prints after `team <command>: `, with no newline;
 * the id is the exit id.
 */
export type DelegateVerdict =
  | { kind: 'passed'; pane: string }
  | { kind: 'refused'; id: string; text: string };

/**
 * The reads a test replaces. Each one left out is the real read: the approval standing and
 * its stored copy for `root` under `home`, the state in `dir`, the agent list herdr gives
 * for a session.
 * Placement is not here. It is `io`, asked about a session, the same way every other command
 * places its caller.
 */
export type DelegateSources = {
  standing?: (root: string) => Standing;
  /** Null when the approved copy cannot be read. */
  approvedCopy?: (root: string) => string | null;
  /** Null when the state cannot be read. */
  state?: (dir: string) => State | null;
  /** Null when herdr doesn't answer for that session. */
  agents?: (session: string) => HerdrAgent[] | null;
  /** False when the session is stopped or absent, null when herdr can't say. */
  sessionRunning?: (session: string) => boolean | null;
  /**
   * Placement sources for one session, when a test does not put them on `io`. The real
   * path uses `io.callerSources`.
   */
  callerSources?: (session: string | undefined) => CallerSources;
};

/** The refusal `add` gives a delegate whose add would edit the file or the approval. */
export const ADD_DELEGATE_EDIT: { id: 'add.delegate-edit'; text: string } = {
  id: 'add.delegate-edit',
  text: 'the approved delegate cannot change the file or the approval; the owner adds a missing or stopped seat',
};

const PREFLIGHT = ['delegate-approval', 'delegate-approved-copy', 'delegate-evidence', 'delegate-placement'] as const;

/**
 * The sections a delegated `approve` may move: `rules` alone — instructions for the team,
 * never power and never code. Every other owner section is the owner's, and the guard below
 * tests membership in this list, so a section the parser grows later is refused by default
 * rather than silently admitted. The list is deliberately written out and not derived from
 * the section modules: an owner section added there must not widen a delegate's reach, and
 * this line is where a widening would show.
 */
export const ORDINARY_SECTIONS: readonly string[] = ['rules'];

/**
 * The refusals before the evidence walk, in gate order. Between the approved copy and the
 * evidence each command has one difference step: the drift refusal for the four, and the
 * ordinary-change guard for `approve`, which admits the roster and `rules` where the others
 * refuse any difference at all.
 */
function preflightOf(command: ActingCommand): readonly string[] {
  const difference = command === 'approve' ? 'delegate-not-ordinary' : 'delegate-drift';
  return [PREFLIGHT[0], PREFLIGHT[1], difference, PREFLIGHT[2], PREFLIGHT[3]];
}

/** Every exit id the gate and `ADD_DELEGATE_EDIT` define. The command files record them. */
export const DELEGATE_EXIT_IDS: readonly string[] = [
  ...ACTING_COMMANDS.flatMap((command) => [
    ...preflightOf(command).map((suffix) => `${command}.${suffix}`),
    `${command}.delegate`,
    `${command}.delegate-command`,
    `${command}.delegate-flag`,
  ]),
  ADD_DELEGATE_EDIT.id,
];

// The flag order is the order a refusal names when several are present. A swap run (a lead seat's
// `remove --keep`) drops `keep` from `remove`'s list: the stop-for-replacement is what `swap` grants. `restore` and
// clearing `stopped` are not flags: `add` reports those with `ADD_DELEGATE_EDIT`. `approve`'s
// own flag is `--file` alone: a delegate approves the default placed file, never one of its
// choosing, while `--show` (a read) and `--confirm` (inert on the delegated path) are not the
// owner's to withhold.
const PROHIBITED: Record<ActingCommand, readonly string[]> = {
  up: ['session', 'file'],
  down: ['abandon', 'session', 'file'],
  add: ['temporary', 'like', 'until', 'worktree', 'session', 'file'],
  remove: ['keep', 'abandon', 'session', 'file'],
  approve: ['file'],
};

const ANCESTORS = 'its parent processes can\'t be read to the top';
const HERDR = 'it runs under herdr, and herdr doesn\'t answer';
const ROOTS = 'it runs under herdr, and no pane root can be read';

/**
 * The audit line, written through `logLine` so it is the same cleaning and the same
 * `<time> command [caller] what` shape as every other line. A delegated run calls this
 * exactly when it passes the gate and proceeds to effects. `detail` is what the act was,
 * for an act that needs saying — a delegated `approve` records the differences it sealed —
 * and is left out entirely when there is nothing to add.
 */
export function logDelegated(dir: string, pane: string, command: DelegateCommand, now?: Date, detail?: string): void {
  logLine(dir, 'delegate', 'delegate', `${pane} ${command}${detail ? `: ${detail}` : ''}`, now);
}

/**
 * Whether this caller may run `command` for the live file. The command calls it only after
 * its ordinary caller rule has refused, and only when `team.delegates` is set. It reads that
 * file and nothing remembered: no earlier valid copy and no unverified approval is consulted.
 * It decides and stops. It does not print, write, or launch.
 *
 * An earlier refusal wins. The live file is the record for every act but `approve`: a
 * stored copy and a fingerprint difference are not a gate. `approve` keeps the ordinary-change
 * guard: it admits an ordinary difference — the roster and `rules` — and refuses every other
 * owner section.
 */
export function delegateGate(input: {
  command: ActingCommand;
  /**
   * The target is the orchestrator's or the operator's seat and the run replaces its agent.
   * `remove <lead> --keep` is admitted by `swap` alone — `remove` never admits a lead —
   * and `add <lead>` by `add` or `swap`. `--keep` is then not the owner's to withhold.
   */
  swap?: boolean;
  team: TeamFile;
  root: string;
  dir: string;
  flags: readonly string[];
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>;
  /** Approval store home. Absent: the owner's home, the same default the store uses. */
  home?: string;
  sources?: DelegateSources;
}): DelegateVerdict {
  const { command, team, root, dir, flags, home } = input;
  const sources = input.sources ?? {};
  const refuse = (suffix: string, text: string): DelegateVerdict => ({ kind: 'refused', id: `${command}.${suffix}`, text });

  const standing = sources.standing ? sources.standing(root) : approvalStanding(root, home);
  if (standing.kind !== 'verified') {
    return refuse('delegate-approval', `delegation needs a verified approval: ${notInForce(standing)}`);
  }

  // `approve` still refuses an owner section outside the ordinary list, and still needs a
  // readable stored copy. Every other act reads the live file. A fingerprint difference is
  // not a refusal, and a stored copy that cannot be read does not block the act.
  if (command === 'approve') {
    const copy = sources.approvedCopy ? sources.approvedCopy(root) : approvedCopy(root, home);
    if (copy === null || validated(copy) === null) {
      return refuse('delegate-approved-copy', 'delegation needs a readable approved copy: run `team approve`');
    }
    const kept = compare(approvedFingerprints(standing.record), fingerprints(team)).filter(
      (difference) => difference.kind === 'section' && !ORDINARY_SECTIONS.includes(difference.name),
    );
    if (kept.length > 0) {
      return refuse('delegate-not-ordinary', `this change needs the owner: ${kept.map(describe).join('; ')}`);
    }
  }

  const entries = team.delegates ?? [];
  const io = sources.callerSources ? { ...input.io, callerSources: sources.callerSources } : input.io;
  const evidence = evidenceOf(team, dir, io, sources, entries);
  if (!evidence.ok) return refuse('delegate-evidence', `delegation cannot verify its placement or seats: ${evidence.reason}`);
  if (entries.some((entry) => collides(team, entry, evidence.state))) {
    return refuse('delegate-placement', 'the approved delegate must be an external non-seat pane');
  }

  const found = findEntry(entries, io);
  if (found.kind === 'evidence') return refuse('delegate-evidence', `delegation cannot verify its placement or seats: ${found.reason}`);
  if (found.kind === 'none') return refuse('delegate', nonDelegate(command, describeCaller(found.caller)));
  const words: readonly DelegateCommand[] = !input.swap ? [command] : command === 'remove' ? ['swap'] : [command, 'swap'];
  if (!words.some((word) => found.entry.commands.includes(word))) {
    const list = found.entry.commands.join(', ');
    const what = input.swap && command === 'remove' ? 'swap a lead seat (`swap`)' : `run \`${command}\``;
    return refuse('delegate-command', `the approved delegate ${found.entry.pane} may not ${what}; its approved commands are ${list}`);
  }
  const prohibited = input.swap ? PROHIBITED[command].filter((name) => name !== 'keep') : PROHIBITED[command];
  const flag = prohibited.find((name) => flags.includes(name));
  if (flag !== undefined) return refuse('delegate-flag', `--${flag} is the owner's; the approved delegate cannot use it`);
  return { kind: 'passed', pane: found.entry.pane };
}

/**
 * Whether this caller may read the team's answer as an approved delegate pane: the acting gate's
 * authorization in the acting gate's order, and nothing else — no command word, no flag list, no
 * check of the entry's commands, and no audit line (`logDelegated` is the act's record, and a read
 * performs no act). It decides and stops, and it speaks nothing of its own: every failure —
 * approval not verified, no readable copy, drift, unreadable evidence, a collision, no matching
 * entry — is simply "does not pass", so an unapproved caller learns no detail: not which step
 * failed, not whose pane an entry is, not that a `delegates` section exists at all.
 */
export function delegateReadGate(input: {
  team: TeamFile;
  root: string;
  dir: string;
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>;
  /** Approval store home. Absent: the owner's home, the same default the store uses. */
  home?: string;
  sources?: DelegateSources;
}): boolean {
  const { team, root, dir, home } = input;
  const sources = input.sources ?? {};
  const standing = sources.standing ? sources.standing(root) : approvalStanding(root, home);
  if (standing.kind !== 'verified') return false;
  const copy = sources.approvedCopy ? sources.approvedCopy(root) : approvedCopy(root, home);
  if (copy === null || validated(copy) === null) return false;
  if (approvalDifferencesOf(standing, team).length > 0) return false;
  const entries = team.delegates ?? [];
  const io = sources.callerSources ? { ...input.io, callerSources: sources.callerSources } : input.io;
  const evidence = evidenceOf(team, dir, io, sources, entries);
  if (!evidence.ok) return false;
  if (entries.some((entry) => collides(team, entry, evidence.state))) return false;
  return findEntry(entries, io).kind === 'match';
}

const NON_DELEGATE: Record<ActingCommand, (caller: string) => string> = {
  up: (caller) => `only the owner or the approved delegate runs \`up\`; this call is ${caller}`,
  down: (caller) => `only the owner, the orchestrator, the operator or the approved delegate stops the team; this call is ${caller}`,
  add: (caller) => `only the owner, the orchestrator, the operator or the approved delegate runs it; this call is ${caller}`,
  remove: (caller) => `only the owner, the orchestrator, the operator or the approved delegate runs it; this call is ${caller}`,
  approve: (caller) => `only the owner or the approved delegate approves a team file; this call is ${caller}`,
};

function nonDelegate(command: ActingCommand, caller: string): string {
  return NON_DELEGATE[command](caller);
}

function validated(text: string): TeamFile | null {
  try {
    const result = validateTeamFile(text);
    return result.ok ? result.team : null;
  } catch {
    return null;
  }
}

function splitPane(pane: string): { session: string; id: string } | null {
  const slash = pane.indexOf('/');
  if (slash <= 0 || slash !== pane.lastIndexOf('/') || slash === pane.length - 1) return null;
  if (/\s/.test(pane)) return null;
  return { session: pane.slice(0, slash), id: pane.slice(slash + 1) };
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'the evidence can\'t be read';
}

type Evidence =
  | { ok: true; state: State }
  | { ok: false; reason: string };

/**
 * The first unreadable read, in the order a refusal names it: the caller's ancestors, herdr
 * for a delegate's session and for the team's session, then the state. A null from herdr is
 * its own refusal, distinct from a caller who is simply somewhere else. The herdr read stays
 * for that refusal; the live list is not a seat.
 *
 * The team's session is read in two steps. An agent list is null both when herdr refuses the
 * call and when the session does not run, and a session that does not run has no seats to
 * collide with: `sessionRunning` tells the two apart. False — stopped or absent — is the
 * evidence of an empty session and the gate goes on. True, null or a throw leaves the seats
 * unread, and the refusal keeps its text.
 */
function evidenceOf(
  team: TeamFile,
  dir: string,
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
  sources: DelegateSources,
  entries: readonly Delegate[],
): Evidence {
  if (io.caller === undefined) {
    const sessions = sessionsOf(entries);
    const asked = sessions.length > 0 ? sessions : [undefined];
    for (const session of asked) {
      const placement = placementSources(io, sources, session);
      const reason = placementReason(placement, entryPane(entries, session));
      if (reason !== null) return { ok: false, reason };
    }
  }
  let listed: HerdrAgent[] | null;
  try {
    listed = (sources.agents ?? agentList)(team.session);
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
  if (listed === null) {
    let running: boolean | null;
    try {
      running = (sources.sessionRunning ?? sessionRunning)(team.session);
    } catch {
      running = null;
    }
    // Only a session herdr reports as not running is known to have no seats in it.
    if (running !== false) return { ok: false, reason: 'herdr doesn\'t answer' };
  }
  try {
    const state = (sources.state ?? readState)(dir);
    if (state === null) return { ok: false, reason: 'the state can\'t be read' };
    return { ok: true, state };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

function sessionsOf(entries: readonly Delegate[]): string[] {
  const sessions: string[] = [];
  for (const entry of entries) {
    const split = splitPane(entry.pane);
    if (split && !sessions.includes(split.session)) sessions.push(split.session);
  }
  return sessions;
}

function entryPane(entries: readonly Delegate[], session: string | undefined): string | undefined {
  if (session === undefined) return undefined;
  return entries.find((entry) => splitPane(entry.pane)?.session === session)?.pane;
}

function placementSources(
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
  sources: DelegateSources,
  session: string | undefined,
): CallerSources {
  const factory = sources.callerSources ?? io.callerSources;
  if (factory) return factory(session);
  return {
    ancestors: () => readAncestors(),
    agents: () => (session === undefined ? [] : (sources.agents ?? agentList)(session)),
    paneRootPid: (pane) => paneRootPid(pane, session),
    env: io.env,
    stdinIsTTY: io.stdinIsTTY,
  };
}

function placementReason(sources: CallerSources, pane: string | undefined): string | null {
  let ancestors;
  try {
    ancestors = sources.ancestors();
  } catch (error) {
    return reasonOf(error);
  }
  if (!ancestors?.length) return ANCESTORS;
  if (!ancestors.some((process) => process.name === 'herdr')) return null;
  let agents: HerdrAgent[] | null;
  try {
    agents = sources.agents();
  } catch (error) {
    return reasonOf(error);
  }
  if (agents === null) return HERDR;
  const root = (id: string): number | null => {
    try {
      return sources.paneRootPid(id);
    } catch {
      return null;
    }
  };
  if (agents.length > 0 && agents.every((agent) => root(agent.pane) === null)) return ROOTS;
  const id = pane === undefined ? undefined : splitPane(pane)?.id;
  if (id !== undefined && agents.some((agent) => agent.pane === id) && root(id) === null) return ROOTS;
  return null;
}

/**
 * A seat collision is exactly two things: the entry's session is the team's configured
 * session, or a seat the state records — under the session it was recorded in — is this pane.
 * A live agent's name is not one. Any process can rename a pane, and the delegate's own pane
 * may bear a name the team also uses.
 */
function collides(team: TeamFile, entry: Delegate, state: State): boolean {
  const split = splitPane(entry.pane);
  if (split === null || split.session === team.session) return true;
  for (const [session, recorded] of Object.entries(state.sessions)) {
    for (const seat of Object.values(recorded.seats ?? {})) {
      if (seat.pane && `${session}/${seat.pane}` === entry.pane) return true;
    }
  }
  return false;
}

type Found =
  | { kind: 'match'; entry: Delegate }
  | { kind: 'none'; caller: Caller }
  | { kind: 'evidence'; reason: string };

/**
 * The entry whose `<session>/<pane id>` is the caller's. A seat matches on that pair, and so
 * does an agentless pane the root vouched. The agent name is not compared: a rename of the
 * agent in the approved pane still matches, and a pane renamed to that agent's name does not.
 * The caller is placed in each entry's session, because a pane id only means something inside
 * the session that lists it.
 */
/** Whether the live file names this caller for `command`. No approval record is read. */
export function delegateNamedFor(
  team: TeamFile,
  command: DelegateCommand,
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
): boolean {
  const entries = team.delegates;
  if (!entries || entries.length === 0) return false;
  const found = findEntry(entries, io);
  return found.kind === 'match' && found.entry.commands.includes(command);
}

function findEntry(entries: readonly Delegate[], io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>): Found {
  let shown: Caller | undefined;
  for (const entry of entries) {
    const split = splitPane(entry.pane);
    if (split === null) continue;
    const placed = callerOf(io, split.session);
    const reason = evidenceCaller(placed);
    if (reason !== null) return { kind: 'evidence', reason };
    if (placed.kind === 'seat' && placed.session === split.session && placed.pane === split.id) return { kind: 'match', entry };
    if (placed.kind === 'pane' && placed.session === split.session && placed.pane === split.id) return { kind: 'match', entry };
    // A seat is still what a refusal names when one was placed. A pane is what it names when
    // nothing matched and no seat was placed; an unplaced caller stays the last resort.
    if (
      shown === undefined
      || (shown.kind !== 'seat' && placed.kind === 'seat')
      || (shown.kind === 'unplaced' && placed.kind === 'pane')
    ) shown = placed;
  }
  return { kind: 'none', caller: shown ?? callerOf(io) };
}

function evidenceCaller(caller: Caller): string | null {
  if (caller.kind !== 'unplaced') return null;
  if (caller.reason === ANCESTORS || caller.reason === HERDR || caller.reason === ROOTS) return caller.reason;
  return null;
}
