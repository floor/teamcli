// The `information` layer's first reader: what one project's team file, state and approval store
// say about its labs, accounts and windows, in the rows `status` already prints. It reads files
// only — the team file (one that cannot be read falls back to the copy the approval stored), the
// state beside it, the store — and writes nothing at all: no `last_valid` copy, no log line, no
// lock, no state. It runs nothing, reads no pane, no vendor file, no vendor key.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { approvalCase, budgetsInForceOf, notInForce, teamInForceOf, watchInForceOf } from '../approve/approval.ts';
import { describe } from '../approve/fingerprint.ts';
import { checkOf, countedFor, paceFrom, recall, recallSpend, screenOf, type ReadingSource, type Seen, type SpendReading } from '../budgets/readings.ts';
import { budgetTable, budgetLine, reserveOf, sourcesOf, span, whenWord, WINDOWS, type BudgetRow, type BudgetState } from '../budgets/table.ts';
import { money } from '../budgets/gate.ts';
import { walkCaller } from '../caller.ts';
import { TEAM_FILE } from '../file/load.ts';
import type { BudgetAccount, Seat, TeamFile } from '../file/types.ts';
import { validateTeamFile, defaultBudgets } from '../file/validate.ts';
import type { Io } from '../io.ts';
import { overridesInForceOf, quotaWith, type ProfileOverride } from '../profiles/overrides.ts';
import type { WindowName } from '../profiles/quota.ts';
import { readState, type State } from '../state.ts';
import { approvalStanding, readApproval, storesFolder, type ApprovalRecord, type Standing } from '../store/store.ts';

/** The caller's view of the machine, decided once (design note § 2.1): whether every team's
 *  names, roots and rows print, and which project is the caller's own. */
export type UsageView = {
  /** True only for the full view: every team named, every root carried, every team's rows shown. */
  full: boolean;
  /** The resolved project's root — the caller's own team, the one whose block prints in full —
   *  or null outside any project. The stores are keyed by root (`store.ts:55-73`), so the root
   *  is the identity `machineUsage` matches a store entry by; the name the report prints for it
   *  is the one that team's own read produces. */
  mine: string | null;
};

/**
 * The one decision point for who reads which view (design note § 2.1). Placed by the walk alone —
 * the process table, never the environment (`caller.ts:11-12`, `:73-92`) — and applied by one
 * filter to every row, text or `--json`, so no other line decides a caller's view again.
 *
 * The full view is the owner at a terminal (`kind === 'owner'`). A run with no terminal reads the
 * restricted view, the same as every other caller who is not that owner. The widening field
 * (`usage: owner | seats`) is not read here: a seat's route to the full view is not built yet.
 */
export function viewFor(io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>, mine: string | null): UsageView {
  return { full: walkCaller(io).kind === 'owner', mine };
}

/** The line a team's rows read when neither its file nor an approved copy of it can be read. */
export const NO_FIGURES = 'no figures (the file could not be read)';

/** The line a block prints when its file names no account: a person or an agent asking what is
 *  left must not get rows with no reason. It prints under the rows too, when the state still
 *  holds a reading the budgets in force do not name — such a row is that reading, not something
 *  a budget counts, so "nothing is counted" stays true. `status` has no words for this case to
 *  borrow — it omits its `budgets:` section and says nothing else (`status.ts:286-290`) — so the
 *  sentence is the coordinator's, ruled after their real run on this command. */
export const NOTHING_COUNTED = "not known: this team's file declares no account, so nothing is counted";

/** The line a block shows a caller who is not the owner in place of a refused approval's own
 *  words. Those words are the store's, and they can carry the record's absolute path, the key's
 *  fate, or the root of another project (`store.ts:154`, `:169`, `:185` — the last is the leak the
 *  after-review found): they are the owner's, and `status` already prints them to the owner. Every
 *  other caller gets this one fixed sentence instead, so no reason text reaching a non-owner can
 *  carry a path or a root. It is the whole of the restricted view's answer for a refusal — one
 *  `Standing` carries one opaque `why`, so the sentence replaces it as a whole. */
export const NOT_VERIFIED = 'the approval on this machine does not verify for this project: the owner runs `team approve`';

/** The line a block shows a caller who is not the owner in place of a stored reading that names
 *  an account the approved team in force does not. The state file is signed by nothing — it is a
 *  cache, not the approved copy — so an account string in it is the state's, not this team's, and
 *  a caller who is not the owner reads a reading by that name only when the copy in force backs
 *  it: it is a budget in force's account, or the account a seat in force's own `account:`/`vendor:`
 *  resolves to (the counting rule's own resolution, `budgets/gate.ts:31`). The names come from the
 *  approved copy in force and never from the live file, so a name only the live file writes is
 *  unbound until the owner approves it — the third read's finding, and the reason a live edit
 *  could bind a state string by name. The reading is not rendered at all, and the owner reads it
 *  as before — the after-review's second read found the leak this line closes: `--json` as a seat
 *  printed a stored reading's `account: /…` and `seat: /…` verbatim. */
export const UNBOUND_ACCOUNT = "a stored reading names an account this team's file does not: not shown";

/** The same line for a stored reading whose window or source is not one this tool writes: the
 *  three windows (`table.ts:28`) and the two sources (`readings.ts`). Nothing in the file can
 *  back any other value — the file names no window and no source but these — so such a reading is
 *  not rendered for a caller who is not the owner either, and says so in this line. */
export const UNBOUND_SHAPE = 'a stored reading carries a window or source this tool does not write: not shown';

/** The line a caller who is not the owner reads when a verified approval's stored copy cannot be
 *  read: there is no validated copy of the team to bind any name to, so no row and no stored
 *  reading is shown by name — the fourth read's rule, release-blocking when the fingerprint
 *  shortcut let the live file stand in for the unreadable copy. The owner reads the live file's
 *  own names as before, exactly as `status` shows them. */
export const NO_COPY = 'the approved copy of the team file cannot be read: nothing is shown by name';

/** Whether a watch is recording for a project, by the state's own record (design note § 1.4). */
export type WatchRecording = 'recording' | 'not-recording' | 'not-known';

/** One row of a project's table, the moment behind the figure it counts and the pace that figure
 *  is being used at: the numeric `changedAt` a machine-scope reader orders by, null when no
 *  reading counted for the row; the pace beside it, read from the same reading — null when there
 *  is nothing to read (no point, no counted reading, or a figure that is not fresh). */
export type UsageRow = { row: BudgetRow; changedAt: number | null; pace: number | null };

/** One account a team's file in force declares, as the machine view reads it: the kind a machine
 *  line is built by, and the lab the design's rule (§ 2.3) puts it under — the vendor of the first
 *  in-force seat that spends it (`seat.account ?? seat.vendor`, the counting rule's own resolution,
 *  `budgets/gate.ts:31`), else the account's own name. */
export type DeclaredAccount = { account: string; kind: 'subscription' | 'spend'; lab: string };

/** Why nothing counts for an account, in the tool's own kinds — the words are the renderer's
 *  (`doctor.ts:154`, `:187`, `gate.ts:90`), never a message a read produced. `first-sight` is the
 *  gate's: a reading this tool has seen once is stored unconfirmed and counts for nothing yet. */
export type UnknownWhy = 'no-pattern' | 'check-unapproved' | 'first-sight';
export type AccountWhy = { account: string; why: UnknownWhy };

/** A machine problem with one team, structured: the filter — never a read's own message — turns
 *  these into words (§ 2.1), and `text` is the caller-appropriate sentence for the team's own
 *  reader (relative paths for a caller who is not the owner, `shownNote`) while every other
 *  caller reads the filter's fixed sentence for the kind. */
export type TeamProblem =
  | { kind: 'state'; tail: 'json' | 'format' | null; text: string }
  | { kind: 'no-figures'; text: string }
  | { kind: 'not-verified'; reason: 'none' | 'legacy' | 'refused' | 'differs' | 'nothing-counted'; text: string }
  | { kind: 'moved'; text: string };

export type ProjectUsage = {
  /** The project's name as this caller reads it. For a caller who is not the owner that is the
   *  one validated copy in force's own `project` — never the live file's, whatever a rename wrote
   *  there — and null when that copy cannot be read, so the block prints no project name and
   *  `NO_COPY` names the reason; the live file's for the owner, as this command always read it.
   *  Null, too, when neither its file nor an approved copy of it can be read. */
  project: string | null;
  rows: UsageRow[];
  /** The one line the block prints when nothing the file declares is counted, in the tool's own
   *  words; null when the file's own accounts are the ones in force. Rows can print under it: a
   *  reading the state still holds for an account no budget in force names is not an account. */
  whyNotCounted: string | null;
  /** The spend checks' readings, as the state holds them (§ 5). Read here, printed from S2 on. */
  spend: SpendReading[];
  watch: WatchRecording;
  /** The budgets in force's staleness, in seconds: a machine spend line reads `fresh` or `stale`
   *  by the same rule the gate applies (`gate.ts:40`), and the numbers must be this team's own. */
  staleAfter: number;
  /** The accounts the file in force declares, kind and lab (§ 2.3's lab rule), sorted by name. */
  accounts: DeclaredAccount[];
  /** The labs a seat of this team puts in use — its vendors, distinct, in file order — whether or
   *  not an account is declared for them: the machine view's `not known (no team declares an
   *  account for it yet)` line counts a lab with none. */
  vendors: string[];
  /** For every declared account nothing can read, the tool's own reason (§ 2.3's why-lines). An
   *  account with no entry has no such reason — it may still read unknown, with nothing to say. */
  whys: AccountWhy[];
  /** This team's machine problems, structured, in the order a block prints them (the why-line
   *  first, then the state): the filter turns them into the restricted words and the reader who
   *  stands here reads `text`. */
  problems: TeamProblem[];
  /** What the block prints as its `note:` lines: for a caller who is not the owner, the fixed
   *  lines for stored readings the file does not bind (`UNBOUND_ACCOUNT`, `UNBOUND_SHAPE`) or for
   *  a copy in force that cannot be read (`NO_COPY`, which stands for the declared rows too). The
   *  state's own reason is a `problems` entry now, structured, so no raw message is left here. */
  notes: string[];
};

/** What a caller hands `projectUsage`: no field has a default, so no caller reads a project
 *  without saying whose view it is. */
export type ProjectUsageOptions = {
  /** The home whose approval store is read. */
  home: string;
  /** The clock: one moment for the whole block. */
  now: number;
  /** Whether the caller is not the owner — the restricted view's one difference. */
  restricted: boolean;
};

/**
 * One project's block: the accounts its budgets in force name, and any reading its state still
 * holds, each row exactly as `status` builds it. The team file is read through
 * `validateTeamFile`; a file that cannot be read falls back to the copy its approval stored; when
 * neither can be read, `project` is null and there are no rows (`NO_FIGURES`). The state is read
 * once and never written, and nothing here opens a lock, a pane or a vendor file; it never opens a
 * CLI's session file or a lab's credential; it reads TeamCLI's own key only to verify the
 * agreement, as `status` does. The key read is `approvalStanding`'s, and it was promised away in
 * the design's first draft; that promise was corrected — the sentence above is the ruled one.
 * `restricted` says the caller is not the owner: it keeps the store's own words for a refused
 * approval out of what the block can print (`NOT_VERIFIED`), shows the project's own paths
 * relative to the project root (`shownNote`), renders a stored reading — and builds the
 * declared rows — only from the one validated copy in force (`teamInForceOf`), and takes the
 * project name it prints — the header, the watch line, `--json`'s `mine` — from that same copy,
 * never from the live file: the state's strings are the state's, and only the ones that copy
 * backs are shown by name, never one a live edit added and never one the fingerprint shortcut let
 * in when the copy cannot be read (`NO_COPY` is the line that case reads; the project name a live
 * edit wrote is not shown either — the second lab's route).
 */
export function projectUsage(root: string, options: ProjectUsageOptions): ProjectUsage {
  const { home, now, restricted } = options;
  const standing = approvalStanding(root, home);
  const team = teamOf(root, standing, home);
  const notes: string[] = [];
  let readings: Seen[] = [];
  let spend: SpendReading[] = [];
  let state: State | null = null;
  let stateProblem: TeamProblem | null = null;
  try {
    state = readState(join(root, '.agents'));
    readings = recall(state.budgets);
    spend = recallSpend(state.spend);
  } catch (error) {
    // The state's own reason, path and all, as *structured* text: the team's own reader prints it
    // (a caller who is not the owner the project's own path relative to the project root — the
    // state beside the file), and the filter turns the kind into a fixed sentence for every other
    // team, so no message a state read produced can cross teams (§ 2.1).
    const message = error instanceof Error ? error.message : String(error);
    stateProblem = { kind: 'state', tail: stateTailOf(message), text: shownNote(message, root, restricted) };
  }
  if (team === null) {
    // Neither the file nor an approved copy of it can be read: no figures at all (`NO_FIGURES`),
    // plus the state's own problem when there is one.
    const problems: TeamProblem[] = [{ kind: 'no-figures', text: NO_FIGURES }];
    if (stateProblem !== null) problems.push(stateProblem);
    return { project: null, rows: [], whyNotCounted: null, spend: [], watch: 'not-known', staleAfter: defaultBudgets().staleAfter, accounts: [], vendors: [], whys: [], problems, notes };
  }
  const inForce = teamInForceOf(standing, team);
  // The rows a caller who is not the owner reads are built from the one validated copy in force,
  // never from `budgetsInForceOf`'s fingerprint shortcut: the shortcut lets the live file stand in
  // for an approved copy the tool cannot read, and the fourth read's route ran through it — the
  // allow-list and the declared rows now read the same one object (`teamInForceOf`). Before any
  // approval the budgets in force name no account, so the rows are the state's own (`LEFTOVER_ROWS`
  // in the suite's words), exactly as they were; the owner's rows stay `status`'s, shortcut and all.
  const budgets = restricted && standing.kind === 'verified'
    ? inForce?.budgets ?? defaultBudgets()
    : budgetsInForceOf(standing, team);
  const bound = restricted ? boundReadings(readings, budgets, inForce, notes) : readings;
  const rows = budgetTable(budgets, bound, now).map((row) => ({
    row,
    changedAt: countedMoment(budgets, bound, row, now),
    pace: paceOf(budgets, bound, row, now),
  }));
  const whyNotCounted = whyNotCountedOf(standing, team, budgets, restricted);
  // The project name this caller reads. A caller who is not the owner reads the one validated
  // copy in force's own name — a live `project:` edit is not approved, and the approval stays
  // verified whatever it says, so the live value must not stand in — and no name at all when
  // that copy cannot be read (`inForce` null, the standing verified; `NO_COPY` names the
  // reason). The owner reads the live file's name, as this command always did.
  const project = restricted ? inForce?.project ?? null : team.project;
  // The seats this caller reads: the in-force ones for a caller who is not the owner (the same
  // object the binding used), the live file's for the owner — as `status` reads them.
  const seats = restricted ? inForce?.seats ?? [] : team.seats;
  const patterns = overridesInForceOf(standing, team.project, root, home).profiles;
  const problems: TeamProblem[] = [];
  if (whyNotCounted !== null) problems.push(problemOf(standing, whyNotCounted));
  else if (project === null) problems.push({ kind: 'no-figures', text: NO_FIGURES });
  if (stateProblem !== null) problems.push(stateProblem);
  return {
    project,
    rows,
    whyNotCounted,
    spend,
    watch: recordedWatch(state, team, watchInForceOf(standing, team), now),
    staleAfter: budgets.staleAfter,
    accounts: declaredOf(budgets, seats),
    vendors: [...new Set(seats.map((seat) => seat.vendor))],
    whys: Object.entries(budgets.accounts).flatMap(([account, entry]) => {
      const why = unknownWhyOf(account, entry, seats, patterns, standing, rows);
      return why === null ? [] : [{ account, why }];
    }),
    problems,
    notes,
  };
}

/** The account list a machine line is built from: every declared account, sorted by name, each
 *  with its kind and its lab (§ 2.3's rule). */
function declaredOf(budgets: TeamFile['budgets'], seats: readonly Seat[]): DeclaredAccount[] {
  return Object.entries(budgets.accounts)
    .map(([account, entry]): DeclaredAccount => ({
      account,
      kind: entry.kind,
      lab: seats.find((seat) => (seat.account ?? seat.vendor) === account)?.vendor ?? account,
    }))
    .sort((a, b) => (a.account < b.account ? -1 : 1));
}

/** The tool's own reason nothing counts for an account, or null when no such reason applies (the
 *  account may simply have no reading yet — there is nothing to say, and nothing is invented).
 *  The file's conditions are `doctor`'s (`doctor.ts:190-193`, `:148-158`): the status line is
 *  named with no seat's CLI shipping a quota pattern for the account, or a check is named with no
 *  command; and a check-sourced account reads unknown when the approval does not record that
 *  check — doctor's own rule, followed exactly: only a verified standing's record can approve a
 *  check, and the "changed since approval" variant is doctor's business, not this reading's.
 *  The last reason is the gate's (`gate.ts:88-90`): a reading this tool has seen once is stored
 *  unconfirmed and counts for nothing yet — no figure of this account counted anywhere, and at
 *  least one window holding a first-sight reading. */
function unknownWhyOf(
  account: string,
  entry: BudgetAccount,
  seats: readonly Seat[],
  patterns: readonly ProfileOverride[],
  standing: Standing,
  rows: readonly UsageRow[],
): UnknownWhy | null {
  const readable = seats
    .filter((seat) => (seat.account ?? seat.vendor) === account)
    .some((seat) => quotaWith(seat.cli, patterns).some((one) => one.account === account));
  if (entry.sources.includes('status_line') && !readable) return 'no-pattern';
  if (entry.sources.includes('check') && entry.check === null) return 'no-pattern';
  if (entry.sources.includes('check') && standing.kind === 'verified') {
    const approved = standing.record.approval.checks;
    if (!approved || approved[account] === undefined) return 'check-unapproved';
  }
  const mine = rows.filter((one) => one.row.account === account);
  if (mine.every((one) => one.changedAt === null) && mine.some((one) => one.row.state === 'unconfirmed')) {
    return 'first-sight';
  }
  return null;
}

/** The structured problem behind a `whyNotCounted` line: which kind of nothing it is. The switch
 *  is on the structured standing and the tool's own sentence, never on a message's words. */
function problemOf(standing: Standing, whyNotCounted: string): TeamProblem {
  if (whyNotCounted === NOTHING_COUNTED) return { kind: 'not-verified', reason: 'nothing-counted', text: whyNotCounted };
  if (standing.kind !== 'verified') return { kind: 'not-verified', reason: standing.kind, text: whyNotCounted };
  return { kind: 'not-verified', reason: 'differs', text: whyNotCounted };
}

/** Which of the state reader's own two tails an unreadable state carries — matched against the
 *  tool's own sentences (`state.ts:100`, `:104`), so the fixed restricted tail is one of exactly
 *  those two and any other read error (an unreadable file, an errno message) carries none. */
function stateTailOf(message: string): 'json' | 'format' | null {
  if (message.includes('is not valid JSON')) return 'json';
  if (message.includes('is not a team state of format 1')) return 'format';
  return null;
}

/**
 * The readings a caller who is not the owner reads by name: the ones the copy in force binds. The
 * state file is signed by nothing — it is a cache, not the approved copy — and the one door a
 * value from outside the program passes (`state.ts`'s `cleanClassification`) does not reach budget
 * readings, so every string a stored reading carries is the state's, whatever it looks like. A
 * reading is bound when its account is one the budgets in force name — for this caller those are
 * the copy in force's own, never one the fingerprint shortcut let stand in for it — or the account
 * one of the in-force seats' own `account:`/`vendor:` resolves to (the counting rule's own
 * resolution, `budgets/gate.ts:31`, over the same budgets); its window and source are ones this
 * tool writes (`WINDOWS`, and the two `ReadingSource`s — no file can write any other value). The
 * seat names come from the one object `teamInForceOf` returns, never from the live file when a
 * copy is approved: a name only the live file writes is unbound, and the standing's own line
 * already says the file differs from the approved one. A copy that cannot be read binds nothing at
 * all — the fourth read's rule — and `NO_COPY` says so in the one line; there is no name to
 * compare, so neither `UNBOUND_ACCOUNT` nor `UNBOUND_SHAPE` applies. A reading that fails those is
 * not rendered at all, and one fixed line per kind says so; a seat's name is narrower than that —
 * it does not hide the figures behind it — so a reading whose seat the seats in force do not name
 * (the string `watch` writes, `watch/pass.ts:331`) prints with no seat (`-` in the block, null in
 * `--json`). The owner reads every reading the state holds, as before.
 */
function boundReadings(list: readonly Seen[], budgets: TeamFile['budgets'], inForce: TeamFile | null, notes: string[]): Seen[] {
  if (inForce === null) {
    notes.push(NO_COPY);
    return [];
  }
  const accounts = new Set(Object.keys(budgets.accounts));
  const seats = new Set<string>();
  for (const seat of inForce.seats) {
    accounts.add(seat.account ?? seat.vendor);
    seats.add(seat.name);
  }
  const kept: Seen[] = [];
  let account = false;
  let shape = false;
  for (const reading of list) {
    if (!accounts.has(reading.account)) {
      account = true;
      continue;
    }
    if (!WINDOWS.includes(reading.window) || (reading.source !== 'status_line' && reading.source !== 'check')) {
      shape = true;
      continue;
    }
    kept.push(reading.seat !== null && !seats.has(reading.seat) ? { ...reading, seat: null } : reading);
  }
  if (account) notes.push(UNBOUND_ACCOUNT);
  if (shape) notes.push(UNBOUND_SHAPE);
  return kept;
}

/** The one line the block prints when nothing its file declares is counted, in the tool's own
 *  words; null when the file's own accounts are the ones in force. Two conditions, ruled after
 *  the coordinator's real run. A file that names no account prints the ruled sentence — also
 *  when leftover readings print rows under it, while no budget in force names one. A file that
 *  declares accounts the approval does not back counts none of them, rows or no rows: not
 *  verified prints `notInForce`'s why-line for that standing (`approval.ts:47-52`), and a
 *  verified standing prints `status`'s own line for a file the owner has not approved
 *  (`status.ts:229`) whenever the budgets in force are the approved copy's — that is exactly
 *  when `compare` reports the `budgets` section, the same digests `budgetsInForceOf` reads. A
 *  refused approval's `why` is the store's own text and is the owner's; a caller who is not the
 *  owner gets `NOT_VERIFIED` instead, while `none` and `legacy` — the tool's own two lines, with
 *  no path in them (`approval.ts:47-52`) — print to everyone. */
function whyNotCountedOf(standing: Standing, team: TeamFile, budgets: TeamFile['budgets'], restricted: boolean): string | null {
  if (Object.keys(team.budgets.accounts).length === 0) {
    return Object.keys(budgets.accounts).length === 0 ? NOTHING_COUNTED : null;
  }
  if (standing.kind !== 'verified') {
    // The switch is on the structured standing, never on the store's wording: a new refusal
    // reason cannot leak because nobody thought to match its text.
    return restricted && standing.kind === 'refused' ? NOT_VERIFIED : notInForce(standing);
  }
  const changed = describe({ kind: 'section', name: 'budgets' });
  const { differences } = approvalCase(standing, team);
  return differences !== null && differences.includes(changed) ? `the file differs from the approved one: ${changed}` : null;
}

/** The team file at the root as the layer reads it: the file itself through `validateTeamFile`,
 *  and the copy the approval stored when the file cannot be read (§ 2.1). */
function teamOf(root: string, standing: Standing, home: string): TeamFile | null {
  const live = readText(join(root, TEAM_FILE));
  if (live !== null) {
    const checked = validateTeamFile(live, { home, root });
    if (checked.ok) return checked.team;
  }
  if (standing.kind !== 'verified') return null;
  const stored = validateTeamFile(standing.record.file);
  return stored.ok ? stored.team : null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** A note for a caller who is not the owner: this project's own absolute paths in it — the state
 *  file's, here — read relative to the project root (`.agents/team.state.json`), so no path the
 *  note itself names is absolute. The owner reads the message as it was written, its absolute
 *  path included (`status`'s own behavior). The wording after the path is the state's, quoted as
 *  it stands, for both callers. */
function shownNote(message: string, root: string, restricted: boolean): string {
  return restricted ? message.replaceAll(join(root, '.agents'), '.agents') : message;
}

/** The moment behind a row's figure: the same rule that chose the figure, over the same group
 *  `budgetTable` built the row from, so the two can never drift apart. Null for a blank row or
 *  one nothing counted for. */
function countedMoment(budgets: TeamFile['budgets'], list: readonly Seen[], row: BudgetRow, now: number): number | null {
  const group = list.filter((reading) => reading.account === row.account && reading.window === row.window);
  if (group.length === 0) return null;
  const result = countedFor(
    sourcesOf(budgets, row.account),
    screenOf(group),
    checkOf(group),
    now,
    budgets.staleAfter * 1000,
    reserveOf(budgets, row.account),
  );
  return result.kind === 'unknown' ? null : result.reading.changedAt;
}

/** The pace the row's figure is being used at (§ 3-S3): read from the same reading the moment
 *  above comes from — the same `countedFor` call over the same group, so the two can never drift
 *  apart. Null for a blank row, one nothing counted for, or one whose reading has no point or is
 *  not fresh; `paceFrom` holds that rule. */
function paceOf(budgets: TeamFile['budgets'], list: readonly Seen[], row: BudgetRow, now: number): number | null {
  const group = list.filter((reading) => reading.account === row.account && reading.window === row.window);
  if (group.length === 0) return null;
  const result = countedFor(
    sourcesOf(budgets, row.account),
    screenOf(group),
    checkOf(group),
    now,
    budgets.staleAfter * 1000,
    reserveOf(budgets, row.account),
  );
  return result.kind === 'unknown' ? null : paceFrom(result.reading, now, budgets.staleAfter * 1000);
}

/** § 1.4's rule, in the tool's existing words: a record whose heartbeat is no older than two
 *  in-force intervals is a watch that is recording; no record is a watch that is not; a state
 *  that cannot be read, or a heartbeat that cannot, leaves it not known either way. */
function recordedWatch(state: State | null, team: TeamFile, watch: TeamFile['watch'], now: number): WatchRecording {
  if (state === null) return 'not-known';
  const recorded = state.sessions[team.session]?.watch;
  if (!recorded) return 'not-recording';
  const beat = typeof recorded.heartbeat === 'string' ? Date.parse(recorded.heartbeat) : Number.NaN;
  if (!Number.isFinite(beat)) return 'not-known';
  return (now - beat) / 1000 <= 2 * watch.interval ? 'recording' : 'not-recording';
}

// ---------------------------------------------------------------------------------------------
// The machine view (design note § 2.1-§ 2.3, S2). `machineUsage` reads every store this machine
// holds and returns structured facts; `reportOf` is the one filter that turns those facts into
// the report both renderers print — a closed allow-list DTO for the restricted view, the wider
// same-shaped report for the full one. Nothing here writes, runs or reads a pane.

/** One team the machine walk read: the root its store records and its own reading. */
export type TeamEntry = { kind: 'team'; root: string; usage: ProjectUsage };
/** A store whose own record cannot be read: `text` is the read's message, the owner's to see. */
export type StoreEntry = { kind: 'store'; text: string };
export type MachineTeam = TeamEntry | StoreEntry;

/** One account+window machine line: the newest reading with a figure, whichever team it is, and
 *  every declaring team's own row for that window — each with the pace of its own reading, so a
 *  team row can print it (`ReportRow` carries no field the line did not). */
export type MachineLine = {
  window: WindowName | null;
  newest: { team: TeamEntry; row: BudgetRow; changedAt: number; pace: number | null } | null;
  rows: Array<{ team: TeamEntry; row: BudgetRow; pace: number | null }>;
};

/** A spend account's machine line: the newest spend reading across teams, never a sum. */
export type MachineSpend = {
  newest: { team: TeamEntry; reading: SpendReading } | null;
  rows: Array<{ team: TeamEntry; reading: SpendReading }>;
};

export type MachineAccount =
  | { account: string; kind: 'subscription'; lines: MachineLine[]; declaring: TeamEntry[] }
  | { account: string; kind: 'spend'; spend: MachineSpend; declaring: TeamEntry[] };

export type MachineLab = {
  lab: string;
  accounts: MachineAccount[];
  /** The teams this lab belongs to: the ones declaring one of its accounts, and the ones putting
   *  it in use as a seat's vendor. The restricted view prints a lab, and its lines, only for a
   *  lab the caller's own team carries (the coordinator's ruling of 7 Oct). */
  carried: TeamEntry[];
};

export type MachineUsage = {
  /** Every team the walk read, in walk order. */
  teams: TeamEntry[];
  /** Store-level problems: a record that cannot be read, its read's own message. */
  stores: string[];
  counts: { teams: number; labs: number; accounts: number };
  labs: MachineLab[];
};

/** The store folder itself cannot be read: the command's `usage.store` refusal (§ 2.4). Carries
 *  the folder and the read's own why, so the owner reads both and no note line claims it. */
export class StoreUnreadable extends Error {
  folder: string;
  why: string;
  constructor(folder: string, why: string) {
    super(`the store folder ${folder} could not be read: ${why}`);
    this.name = 'StoreUnreadable';
    this.folder = folder;
    this.why = why;
  }
}

/** The stores' own suffix: `<project>-<12 hex of the root's path>` (`store.ts:55-73`). A folder
 *  that does not end in it is not a store and is skipped — the lobby's own `lobby` entry among
 *  them — and every store read is one team counted. */
function isStoreName(name: string): boolean {
  return /-[0-9a-f]{12}$/.test(name);
}

function realKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Every store this machine holds, read the one way the design note rules (§ 2.1): the stores
 * folder listed, each name ending `-<12 hex>`, each record read whole for its root, each root
 * read by `projectUsage` under this caller's view. One bad store, one moved project, one
 * unreadable state is a problem on that entry, never a refusal for the rest. A root two stores
 * record (a rename keeps the old folder) is one team: the approval read is the current project's
 * store, and another store for that root is left in place. The walk counts the root once. The
 * caller's own project is the one entry that needs no store: it prints whether or not the owner
 * ever approved it, because it is the caller's own material. The store folder not existing is an
 * empty machine; the folder itself unreadable is `StoreUnreadable`, the one refusal (§ 2.4).
 */
export function machineUsage(home: string, now: number, view: UsageView): MachineUsage {
  const folder = storesFolder(home);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = [];
    else throw new StoreUnreadable(folder, error instanceof Error ? error.message : String(error));
  }
  const restricted = !view.full;
  const mineKey = view.mine === null ? null : realKey(view.mine);
  const entries: MachineTeam[] = [];
  const seen = new Set<string>();
  for (const name of names.filter(isStoreName).sort()) {
    const store = join(folder, name);
    let record: ApprovalRecord | null;
    try {
      record = readApproval(store);
    } catch (error) {
      entries.push({ kind: 'store', text: error instanceof Error ? error.message : String(error) });
      continue;
    }
    // A store folder with no record at all is not a team: nothing was ever approved in it.
    if (record === null) continue;
    const root = record.approval.root;
    const key = realKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    const usage = projectUsage(root, { home, now, restricted });
    if (!existsSync(root)) {
      // The path is this machine's own derivation, so a caller who is not the owner reads the
      // sentence without it — its own project's included (§ 2.3's paths rule); the owner reads
      // the path, as every owner's line does.
      usage.problems.push({ kind: 'moved', text: restricted ? 'the project folder is not there anymore' : `the project folder ${root} is not there anymore` });
    }
    entries.push({ kind: 'team', root, usage });
  }
  if (view.mine !== null && !seen.has(realKey(view.mine))) {
    entries.push({ kind: 'team', root: view.mine, usage: projectUsage(view.mine, { home, now, restricted }) });
  }
  const teams = entries.filter((entry): entry is TeamEntry => entry.kind === 'team');
  // The labs: every declared account under the lab its own team's rule gives it, and every vendor
  // a seat puts in use. One account keeps one lab — the first team in walk order decides — so two
  // teams that map a shared account differently cannot print it twice. Each lab also keeps the
  // teams it is carried by: the teams declaring one of its accounts, and the teams putting it in
  // use as a seat's vendor. The restricted view prints a lab, and its lines, only for a lab the
  // caller's own team carries.
  const labOf = new Map<string, string>();
  type LabSlot = { accounts: Map<string, { account: string; kind: 'subscription' | 'spend'; declaring: TeamEntry[] }>; carried: TeamEntry[] };
  const labs = new Map<string, LabSlot>();
  const labSlot = (lab: string): LabSlot => {
    const known = labs.get(lab);
    if (known) return known;
    const made: LabSlot = { accounts: new Map(), carried: [] };
    labs.set(lab, made);
    return made;
  };
  for (const team of teams) {
    for (const declared of team.usage.accounts) {
      const lab = labOf.get(declared.account) ?? declared.lab;
      labOf.set(declared.account, lab);
      const slot = labSlot(lab);
      if (!slot.carried.includes(team)) slot.carried.push(team);
      const account = slot.accounts.get(declared.account) ?? { account: declared.account, kind: declared.kind, declaring: [] };
      account.declaring.push(team);
      slot.accounts.set(declared.account, account);
    }
    for (const vendor of team.usage.vendors) {
      const slot = labSlot(vendor);
      if (!slot.carried.includes(team)) slot.carried.push(team);
    }
  }
  const accountNames = new Set<string>();
  const built: MachineLab[] = [...labs.entries()]
    .map(([lab, slot]) => ({
      lab,
      accounts: [...slot.accounts.values()]
        .map((account) => {
          accountNames.add(account.account);
          return machineAccountOf(account, mineKey);
        })
        .sort((a, b) => (a.account < b.account ? -1 : 1)),
      carried: [...slot.carried].sort(byName),
    }))
    .sort((a, b) => (a.lab < b.lab ? -1 : 1));
  // An account a state holds without any file declaring it — a reading that survived a removed
  // declaration — is still an account this machine counts; it gets no lab and no line (the report
  // is keyed by declarations, and a name no team's file backs is no team's to show).
  for (const team of teams) {
    for (const entry of team.usage.rows) if (entry.row.window !== null) accountNames.add(entry.row.account);
    for (const reading of team.usage.spend) accountNames.add(reading.account);
  }
  return {
    teams,
    stores: entries.filter((entry): entry is StoreEntry => entry.kind === 'store').map((entry) => entry.text),
    counts: { teams: entries.length, labs: labs.size, accounts: accountNames.size },
    labs: built,
  };
}

function byName(a: TeamEntry, b: TeamEntry): number {
  const name = (team: TeamEntry) => team.usage.project ?? team.root;
  return name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0;
}

/** One account's machine lines. Subscription rows are grouped by window: one line per window any
 *  team read, in the table's window order; a window nobody counted anywhere still gets a line
 *  from the rows that exist (`unknown`, `budgetLine`'s word), and an account with no row at all
 *  gets one line with no window (a blank row's own shape). Spend accounts take the spend rule:
 *  newest, never a sum. On equal moments the caller's own team stands first: the machine line
 *  says least about another team when the figure could be the caller's. */
function machineAccountOf(
  slot: { account: string; kind: 'subscription' | 'spend'; declaring: TeamEntry[] },
  mineKey: string | null,
): MachineAccount {
  const declaring = [...slot.declaring].sort(byName);
  if (slot.kind === 'spend') {
    const rows = declaring
      .flatMap((team) => team.usage.spend.filter((reading) => reading.account === slot.account).map((reading) => ({ team, reading })))
      .sort((a, b) => byName(a.team, b.team));
    const newest = rows.reduce<{ reading: SpendReading; team: TeamEntry } | null>(
      (best, one) => (best === null || isNewerSpend(one, best, mineKey) ? one : best),
      null,
    );
    return { account: slot.account, kind: 'spend', spend: { newest, rows }, declaring };
  }
  const rows = declaring
    .flatMap((team) => team.usage.rows.filter((entry) => entry.row.account === slot.account).map((entry) => ({ team, ...entry })))
    .sort((a, b) => byName(a.team, b.team));
  const windowed = rows.filter((one) => one.row.window !== null);
  const counted = windowed.filter((one) => one.changedAt !== null);
  let lines: MachineLine[];
  if (counted.length > 0) {
    lines = WINDOWS.filter((window) => counted.some((one) => one.row.window === window)).map((window) =>
      lineOf(window, windowed, mineKey),
    );
  } else if (windowed.length > 0) {
    const entry = windowed[0];
    const first = WINDOWS.find((window) => windowed.some((one) => one.row.window === window)) ?? entry?.row.window ?? null;
    lines = [lineOf(first, windowed, mineKey)];
  } else {
    lines = [{ window: null, newest: null, rows: rows.map(({ team, row, pace }) => ({ team, row, pace })) }];
  }
  return { account: slot.account, kind: 'subscription', lines, declaring };
}

function lineOf(
  window: WindowName | null,
  windowed: Array<{ team: TeamEntry; row: BudgetRow; changedAt: number | null; pace: number | null }>,
  mineKey: string | null,
): MachineLine {
  const rows = windowed.filter((one) => one.row.window === window).map(({ team, row, pace }) => ({ team, row, pace }));
  const counted = windowed.filter(
    (one): one is { team: TeamEntry; row: BudgetRow; changedAt: number; pace: number | null } => one.row.window === window && one.changedAt !== null,
  );
  let newest: MachineLine['newest'] = null;
  for (const one of counted) {
    if (newest === null || isNewerRow(one, newest, mineKey)) newest = one;
  }
  return { window, newest, rows };
}

/** Which of two counted readings of one window is newer: the later moment first, the caller's own
 *  team on an equal moment, then name order. Both sides carry their moment, so the comparison
 *  never has to read it back off a row. */
function isNewerRow(
  one: { team: TeamEntry; row: BudgetRow; changedAt: number },
  best: { team: TeamEntry; row: BudgetRow; changedAt: number },
  mineKey: string | null,
): boolean {
  if (one.changedAt !== best.changedAt) return one.changedAt > best.changedAt;
  return isFirst(one.team, best.team, mineKey);
}

function isNewerSpend(
  one: { team: TeamEntry; reading: SpendReading },
  best: { reading: SpendReading; team: TeamEntry },
  mineKey: string | null,
): boolean {
  if (one.reading.at !== best.reading.at) return one.reading.at > best.reading.at;
  return isFirst(one.team, best.team, mineKey);
}

/** The tie-break both newest rules share: the caller's own team stands first, then name order. */
function isFirst(one: TeamEntry, best: TeamEntry, mineKey: string | null): boolean {
  const mine = (team: TeamEntry) => mineKey !== null && realKey(team.root) === mineKey;
  if (mine(one) !== mine(best)) return mine(one);
  return byName(one, best) < 0;
}

// ---------------------------------------------------------------------------------------------
// The report (design § 2.3, revision 3): one filter over the machine's facts, a closed
// allow-list DTO. `reportOf` names every field the design names and nothing else, so a field
// added later to `ProjectUsage`, `TeamEntry` or `MachineUsage` cannot reach a renderer until it
// is added to these types; the text and `--json` both render that one object and can never
// disagree. The full view is the same object with the names allowed: `root` on every team entry,
// `team` on every provenance, every team's rows, every lab, and the notes named per team.

/** One machine line in the report: the newest counted reading's figure, provenance and state.
 *  Every field is the design's; how a line is spelled is the renderer's business. */
export type ReportMachine = {
  window: WindowName | null;
  left: number | null;
  used: number | null;
  resetsIn: string | null;
  /** ISO, null when nothing counted for the line: the line reads `unknown` then. */
  changedAt: string | null;
  age: string | null;
  source: ReadingSource | null;
  fallback: boolean;
  state: BudgetState;
  inside: boolean;
  reserve: number | null;
  /** The pace the newest reading's figure is being used at (§ 3-S3): null when there is none to
   *  read, and null in the restricted view when the newest reading is another team's — that pace
   *  is that team's figure, withheld. The renderer omits the element on that line rather than
   *  print `pace not known`, which would read as a failed computation; the full view prints it. */
  pace: number | null;
  /** True when the newest reading is another team's: the restricted view names no team for it. */
  other: boolean;
  /** The clause the line carries when the newest team's watch is not recording (§ 1.4). */
  watch?: 'not-recording' | 'not-known';
  /** The newest team's name: the full view only. */
  team?: string;
  /** The newest reading's seat: the caller's own data, so the restricted view carries it for its
   *  own rows and omits it for another team's; the full view carries every seat. */
  seat?: string | null;
};

export type ReportSpendMachine = {
  amount: number | null;
  currency: string | null;
  /** ISO, null when no team has a spend reading: the line reads `unknown` then. */
  at: string | null;
  age: string | null;
  source: 'check' | null;
  state: BudgetState;
  other: boolean;
  team?: string;
};

/** A team row's figure, field by field: the report is `JSON.stringify`'d for the `--json` face,
 *  so an internal row carried by reference would print whatever field `BudgetRow` grows next.
 *  Each field here is copied in `reportRowOf`; a field absent here is absent from both faces. */
export type ReportRow = {
  account: string;
  window: WindowName | null;
  left: number | null;
  used: number | null;
  resetsIn: string | null;
  seat: string | null;
  age: string | null;
  source: ReadingSource | null;
  fallback: boolean;
  state: BudgetState;
  inside: boolean;
  reserve: number | null;
  /** The pace the row's figure is being used at (§ 3-S3): null when there is none to read. */
  pace: number | null;
};

export type ReportTeamRow = { team: string; root?: string; row: ReportRow };

export type ReportSpendRow = {
  team: string;
  root?: string;
  reading: { amount: number; currency: string; at: string; age: string; source: 'check'; state: BudgetState };
};

/** One machine line's entry. One entry per line, so the text and the array walk side by side. */
export type ReportAccount =
  | { account: string; kind: 'subscription'; machine: ReportMachine; teams: ReportTeamRow[] }
  | { account: string; kind: 'spend'; machine: ReportSpendMachine; teams: ReportSpendRow[] };

export type ReportLab = {
  lab: string;
  accounts: ReportAccount[];
  /** Other teams' accounts this lab holds that the caller's own file does not name (restricted
   *  only): counted beside the lab, never named and never given a figure. */
  others?: number;
};

export type ReportWhy = { scope: string; account: string; why: string };
export type ReportNote = { scope: string; why: string; count?: number };

/** The one report both renderers print (design § 2.3, restricted shape). */
export type UsageReport = {
  format: 1;
  at: string;
  view: 'full' | 'restricted';
  mine: string | null;
  counts: { teams: number; labs: number; accounts: number };
  labs: ReportLab[];
  unknown: ReportWhy[];
  notes: ReportNote[];
};

/** The tool's own words for the three whys nothing counts (`doctor.ts:154`, `:192`, `gate.ts:90`). */
const WHY_WORDS: Record<UnknownWhy, string> = {
  'no-pattern': 'no pattern can read this account',
  'check-unapproved': 'its check is unapproved; that account reads unknown',
  'first-sight': 'first sight only, not yet counted',
};

/**
 * The fixed words an anonymized machine problem takes (§ 2.3's note bullet): `why` is the
 * fragment `--json` carries, `sentence(n)` the line the text prints about n such teams. Every
 * fragment is the tool's own, never a read's message, so nothing another team's read produced
 * can cross.
 */
const ANON: Array<{ why: string; sentence: (count: number) => string }> = [
  {
    why: 'its file could not be read',
    sentence: (n) => (n === 1 ? '1 team has no figures (its file could not be read)' : `${n} teams have no figures (their files could not be read)`),
  },
  {
    why: 'its file was never approved on this machine',
    sentence: (n) => (n === 1 ? '1 team has no figures (its file was never approved on this machine)' : `${n} teams have no figures (their files were never approved on this machine)`),
  },
  {
    why: 'its file was approved before records were signed',
    sentence: (n) => (n === 1 ? '1 team has no figures (its file was approved before records were signed)' : `${n} teams have no figures (their files were approved before records were signed)`),
  },
  {
    why: 'its approval on this machine does not verify',
    sentence: (n) => (n === 1 ? '1 team has no figures (its approval on this machine does not verify)' : `${n} teams have no figures (their approvals on this machine do not verify)`),
  },
  {
    why: 'its file differs from the approved one',
    sentence: (n) => (n === 1 ? '1 team has no figures (its file differs from the approved one)' : `${n} teams have no figures (their files differ from the approved one)`),
  },
  {
    why: 'its file declares no account, so nothing is counted',
    sentence: (n) => (n === 1 ? '1 team has no figures (its file declares no account, so nothing is counted)' : `${n} teams have no figures (their files declare no account, so nothing is counted)`),
  },
  {
    why: 'its state cannot be read',
    sentence: (n) => (n === 1 ? "1 team's state cannot be read" : `${n} teams' states cannot be read`),
  },
  {
    why: 'its state cannot be read (not valid JSON; move it aside and run the command again)',
    sentence: (n) => (n === 1 ? "1 team's state cannot be read (not valid JSON; move it aside and run the command again)" : `${n} teams' states cannot be read (not valid JSON; move it aside and run the command again)`),
  },
  {
    why: 'its state cannot be read (not a team state of format 1; move it aside and run the command again)',
    sentence: (n) => (n === 1 ? "1 team's state cannot be read (not a team state of format 1; move it aside and run the command again)" : `${n} teams' states cannot be read (not a team state of format 1; move it aside and run the command again)`),
  },
  {
    why: 'its project folder is not there anymore',
    sentence: (n) => (n === 1 ? "1 team's project folder is not there anymore" : `${n} teams' project folders are not there anymore`),
  },
  {
    why: 'a store on this machine cannot be read',
    sentence: (n) => (n === 1 ? 'a store on this machine cannot be read: the owner reads the reason' : `${n} stores on this machine cannot be read: the owner reads the reason`),
  },
];

/** The anonymized words for one problem: the fragment `--json` carries and the text's sentence. */
function anonOf(problem: TeamProblem): { why: string; sentence: (count: number) => string } {
  const why = problem.kind === 'state'
    ? problem.tail === 'json'
      ? 'its state cannot be read (not valid JSON; move it aside and run the command again)'
      : problem.tail === 'format'
        ? 'its state cannot be read (not a team state of format 1; move it aside and run the command again)'
        : 'its state cannot be read'
    : problem.kind === 'no-figures'
      ? 'its file could not be read'
      : problem.kind === 'moved'
        ? 'its project folder is not there anymore'
        : {
            none: 'its file was never approved on this machine',
            legacy: 'its file was approved before records were signed',
            refused: 'its approval on this machine does not verify',
            differs: 'its file differs from the approved one',
            'nothing-counted': 'its file declares no account, so nothing is counted',
          }[problem.reason];
  return ANON.find((one) => one.why === why) ?? { why, sentence: (n) => `${n === 1 ? '1 team' : `${n} teams`} cannot be read (${why})` };
}

/**
 * The one filter: the machine's facts in, exactly the report's fields out. A team the caller does
 * not own contributes counts, fixed sentences and figures of accounts the caller's own file
 * names — never a name, a root, a seat, a path or a message a read produced. When the caller
 * stands outside any project (`view.mine` null, `mineNotes` the position's own notes) every lab,
 * account and row belonging to another team is out, and the counts and fixed sentences stand in.
 */
export function reportOf(machine: MachineUsage, view: UsageView, now: number, mineNotes: readonly string[]): UsageReport {
  const mineEntry = view.mine === null ? null : machine.teams.find((team) => realKey(team.root) === realKey(view.mine as string)) ?? null;
  const mineName = mineEntry?.usage.project ?? null;
  const nameOf = (team: TeamEntry) => team.usage.project ?? team.root;
  /** The name a member's own material prints under: its name, or `mine` when it has none. */
  const scopeOf = (team: TeamEntry) => (team === mineEntry ? mineName ?? 'mine' : view.full ? nameOf(team) : 'another');
  // The accounts the caller's own file names: the only accounts the restricted view may name.
  const mineAccounts = new Set((mineEntry?.usage.accounts ?? []).map((declared) => declared.account));
  const visible = (account: string) => view.full || mineAccounts.has(account);

  const labs: ReportLab[] = [];
  /** The accounts some line of this report carries a figure for: the why-lines print only under
   *  an account that reads `unknown` everywhere (`§ 2.3`'s example), never under one with figures
   *  — an account whose newest counted reading is another team's says nothing about the team
   *  whose own pattern cannot read it. */
  const withFigure = new Set<string>();
  for (const lab of machine.labs) {
    if (!view.full && (mineEntry === null || !lab.carried.includes(mineEntry))) continue;
    const accounts: ReportAccount[] = [];
    let others = 0;
    for (const account of lab.accounts) {
      if (!visible(account.account)) {
        others += 1;
        continue;
      }
      if (account.kind === 'spend') {
        const entry = spendEntryOf(account, view, mineEntry, now);
        if (entry.machine.state !== 'unknown') withFigure.add(account.account);
        accounts.push(entry);
      } else {
        for (const line of account.lines) {
          const entry = subscriptionEntryOf(account.account, line, view, mineEntry, now);
          if (entry.machine.state !== 'unknown') withFigure.add(account.account);
          accounts.push(entry);
        }
      }
    }
    accounts.sort(byLine);
    labs.push({ lab: lab.lab, accounts, ...(others > 0 ? { others } : {}) });
  }

  // Every why-line, the caller's own first, then by the words and the account: the order holds
  // in both views, so hiding a name cannot reshuffle the lines around it.
  const mineWhys = (mineEntry?.usage.whys ?? []).map((one) => ({ team: mineEntry as TeamEntry, ...one }));
  const otherWhys = machine.teams
    .filter((team) => team !== mineEntry)
    .flatMap((team) => team.usage.whys.map((one) => ({ team, ...one })))
    .filter((one) => visible(one.account));
  const byWord = (a: { account: string; why: UnknownWhy }, b: { account: string; why: UnknownWhy }): number =>
    a.why === b.why ? a.account.localeCompare(b.account) : a.why < b.why ? -1 : 1;
  const unknown: ReportWhy[] = [
    ...mineWhys.filter((one) => !withFigure.has(one.account)).sort(byWord),
    ...otherWhys.filter((one) => !withFigure.has(one.account)).sort(byWord),
  ].map((one) => ({
    scope: scopeOf(one.team),
    account: one.account,
    why: WHY_WORDS[one.why],
  }));

  const notes: ReportNote[] = [];
  for (const text of mineNotes) notes.push({ scope: mineName ?? 'mine', why: text });
  const teamOrder = [...machine.teams].sort(byName);
  if (mineEntry !== null) {
    for (const problem of mineEntry.usage.problems) notes.push({ scope: mineName ?? 'mine', why: problem.text });
    for (const note of mineEntry.usage.notes) notes.push({ scope: mineName ?? 'mine', why: note });
  }
  if (view.full) {
    for (const team of teamOrder) {
      if (team === mineEntry) continue;
      for (const problem of team.usage.problems) notes.push({ scope: nameOf(team), why: problem.text });
    }
  } else {
    const groups = new Map<string, number>();
    for (const team of teamOrder) {
      if (team === mineEntry) continue;
      for (const problem of team.usage.problems) {
        const { why } = anonOf(problem);
        groups.set(why, (groups.get(why) ?? 0) + 1);
      }
    }
    for (const [why, count] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      notes.push({ scope: 'another', why, ...(count > 1 ? { count } : {}) });
    }
  }
  // A store problem's message is the read's own and carries the store's path: the owner reads it
  // as it stands; every other caller reads the fixed sentence with the count (§ 2.3's note rule).
  if (view.full) for (const message of machine.stores) notes.push({ scope: 'store', why: message });
  else if (machine.stores.length > 0) {
    notes.push({ scope: 'store', why: 'a store on this machine cannot be read', ...(machine.stores.length > 1 ? { count: machine.stores.length } : {}) });
  }

  return {
    format: 1,
    at: new Date(now).toISOString(),
    view: view.full ? 'full' : 'restricted',
    mine: mineName,
    // Copied, not carried: the report is stringified for the `--json` face, so a field the
    // machine's counts grows later must not reach the DTO by reference (the `reportRowOf` rule).
    counts: { teams: machine.counts.teams, labs: machine.counts.labs, accounts: machine.counts.accounts },
    labs,
    unknown,
    notes,
  };
}

/** The report's line order: subscription accounts by name first, then spend accounts by name, the
 *  windows in the table's own order inside an account (`table.ts:26`), spend last (§ 2.3). */
function byLine(a: ReportAccount, b: ReportAccount): number {
  if (a.kind !== b.kind) return a.kind === 'subscription' ? -1 : 1;
  if (a.account !== b.account) return a.account < b.account ? -1 : 1;
  const rank = (account: ReportAccount) => (account.kind !== 'subscription' || account.machine.window === null ? WINDOWS.length : WINDOWS.indexOf(account.machine.window));
  return rank(a) - rank(b);
}

function subscriptionEntryOf(
  account: string,
  line: MachineLine,
  view: UsageView,
  mineEntry: TeamEntry | null,
  now: number,
): ReportAccount {
  const newest = line.newest;
  const other = newest !== null && newest.team !== mineEntry;
  const machine: ReportMachine = {
    window: line.window,
    left: newest?.row.left ?? null,
    used: newest?.row.used ?? null,
    resetsIn: newest?.row.resetsIn ?? null,
    changedAt: newest === null ? null : new Date(newest.changedAt).toISOString(),
    age: newest?.row.age ?? null,
    source: newest?.row.source ?? null,
    fallback: newest?.row.fallback ?? false,
    state: newest?.row.state ?? 'unknown',
    inside: newest?.row.inside ?? false,
    reserve: newest?.row.reserve ?? null,
    pace: other && !view.full ? null : newest?.pace ?? null,
    other,
    ...(newest !== null && newest.team.usage.watch !== 'recording' ? { watch: newest.team.usage.watch } : {}),
    ...(view.full && newest !== null ? { team: newest.team.usage.project ?? newest.team.root } : {}),
    ...(newest !== null && (view.full || !other) ? { seat: newest.row.seat } : {}),
  };
  const rows = view.full ? line.rows : line.rows.filter((one) => one.team === mineEntry);
  const teams: ReportTeamRow[] = rows
    .map((one) => ({ team: view.full ? one.team.usage.project ?? one.team.root : one.team.usage.project ?? '', ...(view.full ? { root: one.team.root } : {}), row: reportRowOf(one.row, one.pace) }))
    .sort((a, b) => (a.team < b.team ? -1 : 1));
  return { account, kind: 'subscription', machine, teams };
}

/** The row's figure, copied field by field — `BudgetRow`'s own order, so the `--json` face stays
 *  byte-identical. The report is `JSON.stringify`'d, so a row carried by reference would print
 *  whatever field the internal type grows next; a field away from this list is away from both
 *  faces. The spend row's `reading` (`spendEntryOf`) is the same rule for the same reason. */
function reportRowOf(row: BudgetRow, pace: number | null): ReportRow {
  return {
    account: row.account,
    window: row.window,
    left: row.left,
    used: row.used,
    resetsIn: row.resetsIn,
    seat: row.seat,
    age: row.age,
    source: row.source,
    fallback: row.fallback,
    state: row.state,
    inside: row.inside,
    reserve: row.reserve,
    pace,
  };
}

function spendEntryOf(account: MachineAccount & { kind: 'spend' }, view: UsageView, mineEntry: TeamEntry | null, now: number): ReportAccount {
  const newest = account.spend.newest;
  const other = newest !== null && newest.team !== mineEntry;
  const staleAfterMs = (newest?.team ?? mineEntry)?.usage.staleAfter ?? 0;
  const machine: ReportSpendMachine = {
    amount: newest?.reading.amount ?? null,
    currency: newest?.reading.currency ?? null,
    at: newest === null ? null : new Date(newest.reading.at).toISOString(),
    age: newest === null ? null : span(now - newest.reading.at),
    source: newest === null ? null : 'check',
    state: newest === null ? 'unknown' : now - newest.reading.at < staleAfterMs * 1000 ? 'fresh' : 'stale',
    other,
    ...(view.full && newest !== null ? { team: newest.team.usage.project ?? newest.team.root } : {}),
  };
  const rows = view.full ? account.spend.rows : account.spend.rows.filter((one) => one.team === mineEntry);
  const teams: ReportSpendRow[] = rows
    .map((one) => ({
      team: view.full ? one.team.usage.project ?? one.team.root : one.team.usage.project ?? '',
      ...(view.full ? { root: one.team.root } : {}),
      reading: {
        amount: one.reading.amount,
        currency: one.reading.currency,
        at: new Date(one.reading.at).toISOString(),
        age: span(now - one.reading.at),
        source: 'check' as const,
        state: now - one.reading.at < one.team.usage.staleAfter * 1000 ? ('fresh' as const) : ('stale' as const),
      },
    }))
    .sort((a, b) => (a.team < b.team ? -1 : 1));
  return { account: account.account, kind: 'spend', machine, teams };
}

/**
 * The text both views print (§ 2.3): the header's counts, then each lab's lines — an account's
 * machine line, its allowed rows, its why-lines — then the notes. The full view differs only in
 * what the report carries, never here: one renderer, one shape.
 */
export function reportText(report: UsageReport): string {
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const lines = [
    `usage on this machine, ${count(report.counts.teams, 'team')}, ${count(report.counts.labs, 'lab')}, ${count(report.counts.accounts, 'account')}`,
    '',
  ];
  for (const lab of report.labs) {
    let at = 0;
    while (at < lab.accounts.length) {
      const first = lab.accounts[at];
      if (first === undefined) break;
      let end = at;
      while (end < lab.accounts.length && lab.accounts[end]?.account === first.account) end += 1;
      for (const entry of lab.accounts.slice(at, end)) {
        if (entry.kind === 'spend') {
          lines.push(spendText(entry, report));
          for (const row of entry.teams) lines.push(spendRowText(row));
        } else {
          lines.push(subscriptionText(entry, report));
          for (const row of entry.teams) lines.push(teamRowText(row));
        }
      }
      for (const why of report.unknown.filter((one) => one.account === first.account)) {
        lines.push(`  (${why.scope === 'another' ? 'another team' : why.scope}: ${why.why})`);
      }
      at = end;
    }
    if (lab.accounts.length === 0 && lab.others === undefined) {
      lines.push(`${lab.lab}  not known (no team declares an account for it yet)`);
    } else if (lab.others !== undefined) {
      lines.push(`${lab.lab}: ${lab.others} other account${lab.others === 1 ? '' : 's'}`);
    }
  }
  for (const note of report.notes) lines.push(`note: ${noteText(note)}`);
  return `${lines.join('\n')}\n`;
}

/** The pace word a line carries (§ 3-S3): one decimal always, in used points per hour — never a
 *  bare integer — or the tool's own words when there is no pace to read. A line with no figure at
 *  all (`unknown`) carries no word: there is nothing to pace. */
function paceWord(pace: number | null): string {
  return pace === null ? 'pace not known' : `pace ${pace.toFixed(1)}%/h`;
}

function subscriptionText(entry: ReportAccount & { kind: 'subscription' }, report: UsageReport): string {
  const m = entry.machine;
  if (m.state === 'unknown' || m.left === null || m.used === null) {
    return [entry.account, m.window, 'unknown'].filter((part) => part).join('  ');
  }
  const reset = m.resetsIn === null ? 'resets unknown' : `resets in ${m.resetsIn}`;
  const from = m.source === 'status_line' ? 'status line' : m.source === 'check' ? 'check' : 'unknown source';
  const source = m.fallback ? `${from} (fallback)` : from;
  const state = m.inside && m.reserve !== null ? `${m.state}, inside reserve ${m.reserve}%` : m.state;
  // The pace element is omitted on a restricted line whose newest reading is another team's — the
  // one line whose pace is withheld (§ 3.3): nothing stands in its place, since `pace not known`
  // would read as a failed computation where the figure is real and withheld. Every other line
  // keeps its word, in either view.
  const pace = m.other && report.view === 'restricted' ? '' : `  ${paceWord(m.pace)}`;
  return `${entry.account}  ${m.window}  left ${m.left}%  used ${m.used}%  ${reset}  ${provenanceOf(m, report)}  ${source}  ${state}${pace}${watchOf(m, report)}`;
}

function spendText(entry: ReportAccount & { kind: 'spend' }, report: UsageReport): string {
  const m = entry.machine;
  if (m.state === 'unknown' || m.amount === null || m.currency === null || m.age === null) {
    return [entry.account, 'spend', 'unknown'].filter((part) => part).join('  ');
  }
  const read = m.other
    ? m.team === undefined
      ? `read by another team, ${m.age} ago`
      : `read by ${m.team}, ${m.age} ago`
    : `read ${m.age} ago`;
  return `${entry.account}  spend  ${money(m.amount)} ${m.currency} left  ${read}  check  ${m.state}`;
}

/** How a machine line says where its figure came from: the caller's own reading prints as its own
 *  seat and moment (`scout  changed 4m ago`, `status`'s own shape); another team's is that team's
 *  name when the full view allows it and `another team` when it does not. */
function provenanceOf(m: ReportMachine, report: UsageReport): string {
  if (!m.other) return `${m.seat ?? '-'}  ${whenWord(m)} ${m.age} ago`;
  return m.team === undefined ? `read by another team, ${m.age} ago` : `read by ${m.team}, ${m.age} ago`;
}

/** The clause a machine line carries when the team behind its figure has no watch recording. */
function watchOf(m: ReportMachine, report: UsageReport): string {
  if (m.watch === undefined) return '';
  if (m.watch === 'not-known') return '  (not known whether a watch is recording)';
  const who = m.team ?? (m.other || report.mine === null ? 'it' : report.mine);
  return `  (no watch is recording for ${who})`;
}

function teamRowText(row: ReportTeamRow): string {
  return `  ${row.team}  ${budgetLine(row.row).slice(row.row.account.length)}  ${paceWord(row.row.pace)}`;
}

function spendRowText(row: ReportSpendRow): string {
  return `  ${row.team}  spend  ${money(row.reading.amount)} ${row.reading.currency} left  read ${row.reading.age} ago  check  ${row.reading.state}`;
}

/** One `note:` line's words: an anonymized machine problem is its fixed sentence for the count,
 *  the caller's own and store notes are printed as they stand, and any other note is named. */
function noteText(note: ReportNote): string {
  const anon = ANON.find((one) => one.why === note.why);
  if (anon !== undefined) return anon.sentence(note.count ?? 1);
  if (note.scope === 'mine' || note.scope === 'store') return note.why;
  return `${note.scope}: ${note.why}`;
}
