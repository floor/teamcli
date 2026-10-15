// The `information` layer's first reader: what one project's team file, state and approval store
// say about its labs, accounts and windows, in the rows `status` already prints. It reads files
// only — the live team file, the state beside it, the store — and writes nothing at all:
// no `last_valid` copy, no log line, no lock, no state. It runs nothing, reads no pane, no vendor file, no vendor key.
// The live quota sources (a seat's status line, a CLI's usage command, a quota screen) live in
// `quota-observe.ts` and are handed in as observations; nothing here reaches a pane itself.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { budgetsInForceOf, notInForce, watchInForceOf } from '../approve/approval.ts';
import { describe } from '../approve/fingerprint.ts';
import { checkOf, countedFor, paceFrom, recall, recallSpend, screenOf, type ReadingSource, type Seen, type SpendReading } from '../budgets/readings.ts';
import { budgetTable, budgetLine, reserveOf, sourcesOf, span, whenWord, WINDOWS, type BudgetRow, type BudgetState } from '../budgets/table.ts';
import { money } from '../budgets/gate.ts';
import { walkCaller } from '../caller.ts';
import { TEAM_FILE } from '../file/load.ts';
import type { BudgetAccount, Seat, TeamFile } from '../file/types.ts';
import { validateTeamFile, defaultBudgets } from '../file/validate.ts';
import type { Io } from '../io.ts';
import { collapseNotes, renderTable } from '../output/index.ts';
import { labOfSeat, machineAccountsByEntityOf, machineAccountsOf, ownerEntityOf, payingAccountOf, payingPoolOf } from './machine-accounts.ts';
import { readMachineReadings, type MachineReading } from './machine-readings.ts';
import { overridesInForceOf, quotaWith, type ProfileOverride } from '../profiles/overrides.ts';
import { shippedQuotaAccounts } from '../profiles/profile.ts';
import type { WindowName } from '../profiles/quota.ts';
import { marginOf, marginWord, NEAR_CAP, QUOTA_STALE_MS, quotaOf, quotaText, PANE_UNREAD, USAGE_ACCOUNTS, USAGE_UNANSWERED, windowState, type CostObservation, type QuotaLabInput, type QuotaObservation, type QuotaState, type ReportQuota } from './quota.ts';
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

/** The line a block prints when its file names no account: a person or an agent asking what is
 *  left must not get rows with no reason. Machine accounts count for every team
 *  (`accounts.yaml`), so it prints only when the file names no account and the machine names none
 *  either — with a machine account the block counts that account's rows, and this line would be
 *  false. It prints under the rows too, when the state still holds a reading the budgets in force
 *  do not name — such a row is that reading, not something a budget counts, so "nothing is
 *  counted" stays true. `status` has no words for this case to borrow — it omits its `budgets:`
 *  section and says nothing else (`status.ts:286-290`) — so the sentence is the coordinator's,
 *  ruled after their real run on this command. */
export const NOTHING_COUNTED = "not known: this team's file declares no account, so nothing is counted";

/** The machine's own account list: the file a lab with no account declaration points at, so the
 *  one line the owner asked for tells them where to declare it. */
export const ACCOUNTS_FILE = '~/.config/team/accounts.yaml';

/** The line a team's rows read when its live file cannot be read. */
export const NO_FIGURES = 'no figures (the file could not be read)';

/** The line a block shows a caller who is not the owner in place of a refused approval's own
 *  words. Those words are the store's, and they can carry the record's absolute path, the key's
 *  fate, or the root of another project (`store.ts:154`, `:169`, `:185` — the last is the leak the
 *  after-review found): they are the owner's, and `status` already prints them to the owner. Every
 *  other caller gets this one fixed sentence instead, so no reason text reaching a non-owner can
 *  carry a path or a root. It is the whole of the restricted view's answer for a refusal — one
 *  `Standing` carries one opaque `why`, so the sentence replaces it as a whole. */
export const NOT_VERIFIED = 'the approval on this machine does not verify for this project';

/** A restricted view shows a stored reading only when the live file names its account,
 *  either in budgets or through a seat's account/vendor. State strings alone do not bind names. */
export const UNBOUND_ACCOUNT = "a stored reading names an account this team's file does not: not shown";

/** The same line for a stored reading whose window or source is not one this tool writes: the
 *  three windows (`table.ts:28`) and the two sources (`readings.ts`). Nothing in the file can
 *  back any other value — the file names no window and no source but these — so such a reading is
 *  not rendered for a caller who is not the owner either, and says so in this line. */
export const UNBOUND_SHAPE = 'a stored reading carries a window or source this tool does not write: not shown';

/** Whether a watch is recording for a project, by the state's own record (design note § 1.4). */
export type WatchRecording = 'recording' | 'not-recording' | 'not-known';

/** One row of a project's table, the moment behind the figure it counts and the pace that figure
 *  is being used at: the numeric `changedAt` a machine-scope reader orders by, null when no
 *  reading counted for the row; the pace beside it, read from the same reading — null when there
 *  is nothing to read (no point, no counted reading, or a figure that is not fresh). */
export type UsageRow = { row: BudgetRow; changedAt: number | null; pace: number | null };

/** One account a team's file in force declares, as the machine view reads it: the kind a machine
 *  line is built by, and the lab the design's rule (§ 2.3) puts it under — the vendor of the first
 *  in-force seat that draws on it (`payingAccountOf`, the CLI-and-launcher rule,
 *  `machine-accounts.ts`), else the account's own name. Machine-only subscriptions are marked
 *  as fallbacks so an explicit declaration in any team takes precedence. */
export type DeclaredAccount = { account: string; kind: 'subscription' | 'spend'; lab: string; fallback?: true };

/** One row of the per-team breakdown: a seat, its CLI, and the account that pays for it. `vendor`
 *  is the lab the seat runs under (`labOfSeat`, `machine-accounts.ts`): the lab of the model its
 *  pane says it runs, else the file's vendor-and-launcher rule — a seat's stale vendor never
 *  overrides the model the live pane reports. `pane` is the seat's recorded herdr pane, when the
 *  state has one: the live quota observer reads it, and `reportOf` never carries the last two
 *  (each field of `ReportSeatRow` is copied by name). A seat the file marks `stopped` is not in
 *  force and is never a row. */
export type SeatAccountRow = { seat: string; cli: string; account: string; vendor: string; pool?: 'gemini' | 'claude-gpt'; pane?: string | null };

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
  | { kind: 'unreadable-file'; text: string }
  | { kind: 'not-verified'; reason: 'none' | 'legacy' | 'refused' | 'nothing-counted'; text: string }
  | { kind: 'moved'; text: string };

export type ProjectUsage = {
  /** The project's name as this caller reads it: the live file's own `project`, for the owner
   *  and for a caller who is not the owner alike — the live file is the record. Null when
   *  its live file cannot be read. */
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
  /** The accounts the file in force declares, kind and lab (§ 2.3's lab rule), sorted by name:
   *  the file's own `budgets.accounts`, plus the machine's accounts (`accounts.yaml`) the file
   *  does not name — every team draws on those, so a file with no budgets section still counts
   *  them. */
  accounts: DeclaredAccount[];
  /** The per-seat breakdown: every seat in force with the account that pays for it, in file
   *  order. The report prints it for the caller's own team, and for every team under `--all`. */
  seatAccounts: SeatAccountRow[];
  /** The team file's own herdr session: the live quota observer reads the seats' panes under it.
   *  Null when the file cannot be read; the observer then reads no pane for this team. */
  session: string | null;
  /** The borrowing this team does: one entry per account a seat of its own pays with that the
   *  machine's `accounts.yaml` gives to another entity — sorted by account, the owner resolved by
   *  the file's own order (`ownerEntityOf`). A team whose file names no `entity:` borrows every
   *  claimed account it spends; an account no entity claims, and a team spending its own entity's
   *  account, are never here. Display only: the account counts under this team either way. */
  borrows: Array<{ account: string; entity: string }>;
  /** The accounts this team's own seats' quota patterns (shipped, plus the overrides in force)
   *  can read: the machine report's `not readable from a CLI screen` sentence is the truth for
   *  an account neither this list nor any shipped pattern names. */
  quotaAccounts: string[];
  /** The vendors this team's seats put in use, distinct and in file order. */
  vendors: string[];
  /** For every declared account nothing can read, the tool's own reason (§ 2.3's why-lines). An
   *  account with no entry has no such reason — it may still read unknown, with nothing to say. */
  whys: AccountWhy[];
  /** This team's machine problems, structured, in the order a block prints them (the why-line
   *  first, then the state): the filter turns them into the restricted words and the reader who
   *  stands here reads `text`. */
  problems: TeamProblem[];
  /** What the block prints as its `note:` lines: for a caller who is not the owner, the fixed
   *  lines for stored readings the file does not bind (`UNBOUND_ACCOUNT`, `UNBOUND_SHAPE`). The
   *  state's own reason is a `problems` entry now, structured, so no raw message is left here. */
  notes: string[];
};

/** The model line each seat of a session runs, by seat name — the pane text the watch keeps as
 *  herdr's `display_agent`; null when the session cannot be asked. The lab a seat pays through
 *  is read from this line, never from the CLI's name (the owner's rule). */
export type RunningModels = (session: string) => ReadonlyMap<string, string> | null;

/** What a caller hands `projectUsage`: no field has a default, so no caller reads a project
 *  without saying whose view it is. */
export type ProjectUsageOptions = {
  /** The home whose approval store is read. */
  home: string;
  /** The clock: one moment for the whole block. */
  now: number;
  /** Whether the caller is not the owner — the restricted view's one difference. */
  restricted: boolean;
  /** The model each running seat shows, when the caller can ask: absent from a test's own
   *  sources, which then attribute every seat from its file as before. */
  running?: RunningModels;
};

/**
 * One project's block: the accounts its budgets in force name, and any reading its state still
 * holds, each row exactly as `status` builds it. The team file is read through
 * `validateTeamFile`; when it cannot be read, `project` is null and there are no rows
 * (`NO_FIGURES`). The state is read
 * once and never written, and nothing here opens a lock, a pane or a vendor file; it never opens a
 * CLI's session file or a lab's credential; it reads TeamCLI's own key only to verify the
 * agreement, as `status` does. The key read is `approvalStanding`'s, and it was promised away in
 * the design's first draft; that promise was corrected — the sentence above is the ruled one.
 * `restricted` says the caller is not the owner: it keeps the store's own words for a refused
 * approval out of what the block can print (`NOT_VERIFIED`), shows the project's own paths
 * relative to the project root (`shownNote`), and renders a stored reading only when the live
 * file binds its name — the state's strings are the state's, and only an account and a seat the
 * file names are shown by name. The budgets, the declared rows and the project name it prints
 * — the header, the watch line, `--json`'s `mine` — are the live file's own, for the owner and
 * for a caller who is not the owner alike.
 */
export function projectUsage(root: string, options: ProjectUsageOptions): ProjectUsage {
  const { home, now, restricted } = options;
  const standing = approvalStanding(root, home);
  const team = teamOf(root, home);
  // The machine's own accounts, read once for this block: every team draws on them, so they
  // count for this one whatever its own file declares.
  const machine = machineAccountsOf(home);
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
    stateProblem = { kind: 'state', tail: stateTailOf(message), text: shownNote(message, root, restricted, home) };
  }
  if (team === null) {
    // The live file cannot be read: no figures at all (`NO_FIGURES`),
    // plus the state's own problem when there is one.
    const problems: TeamProblem[] = [{ kind: 'unreadable-file', text: NO_FIGURES }];
    if (stateProblem !== null) problems.push(stateProblem);
    return { project: null, rows: [], whyNotCounted: null, spend: [], watch: 'not-known', staleAfter: defaultBudgets().staleAfter, accounts: [], seatAccounts: [], session: null, borrows: [], quotaAccounts: [], vendors: [], whys: [], problems, notes };
  }
  // The live file is the record for every caller: the budgets in force, the project name and
  // the seats all read from it, the owner and a caller who is not the owner alike. Before any
  // approval the budgets in force name no account, so the rows are the state's own
  // (`LEFTOVER_ROWS` in the suite's words), exactly as they were.
  const budgets = budgetsInForceOf(standing, team);
  const bound = restricted ? boundReadings(readings, budgets, team, machine, notes) : readings;
  const rows = budgetTable(budgets, bound, now).map((row) => ({
    row,
    changedAt: countedMoment(budgets, bound, row, now),
    pace: paceOf(budgets, bound, row, now),
  }));
  const whyNotCounted = whyNotCountedOf(standing, team, budgets, restricted, machine);
  const project = team.project;
  // A seat the file marks stopped is a record of one that ran, not one the team has: its row is
  // never a breakdown row, never a seat behind an account, never a pane worth reading.
  const seats = team.seats.filter((seat) => !seat.stopped);
  const patterns = overridesInForceOf(standing, team.project, root, home).profiles;
  const problems: TeamProblem[] = [];
  if (whyNotCounted !== null) problems.push(problemOf(standing, whyNotCounted));
  else if (project === null) problems.push({ kind: 'no-figures', text: NO_FIGURES });
  if (stateProblem !== null) problems.push(stateProblem);
  // The seat's recorded pane, when the state holds one: the live quota observer's only handle on
  // a seat's screen. A read state that failed leaves every pane absent, and the observer then
  // reads nothing for this team — never a pane number invented from another session.
  const sessionState = state?.sessions[team.session];
  // The model each running seat shows on its own pane, when the caller can ask: the lab comes
  // from the model the seat RUNS, never from the CLI's name (the owner's rule). A session herdr
  // cannot be asked about, and a seat it does not list, keep the file's own attribution.
  const running = options.running === undefined || team.session === null ? null : options.running(team.session);
  const runningOf = (seat: { name: string }) => running?.get(seat.name);
  return {
    project,
    rows,
    whyNotCounted,
    spend,
    watch: recordedWatch(state, team, watchInForceOf(standing, team), now),
    staleAfter: budgets.staleAfter,
    accounts: declaredOf(budgets, seats, machine, runningOf),
    seatAccounts: seats.map((seat) => {
      const line = runningOf(seat);
      const pool = payingPoolOf(seat);
      return { seat: seat.name, cli: seat.cli, account: payingAccountOf(seat, line), vendor: labOfSeat(seat, line), ...(pool ? { pool } : {}), pane: sessionState?.seats[seat.name]?.pane ?? null };
    }),
    session: team.session,
    borrows: borrowedBy(team, seats, home, runningOf),
    // Only the accounts a screen's patterns can NAME are readable: a seat's paying account is
    // where its figure is spent, never an account its screen can read (a DeepSeek seat on Claude
    // Code shows the Claude subscription's bar, and that is Anthropic's reading).
    quotaAccounts: [...new Set(seats.flatMap((seat) => quotaWith(seat.cli, patterns)
      .map((one) => one.account)))].sort(),
    vendors: [...new Set(seats.map((seat) => labOfSeat(seat, runningOf(seat))))],
    whys: Object.entries(budgets.accounts).flatMap(([account, entry]) => {
      const why = unknownWhyOf(account, entry, seats, patterns, standing, rows);
      return why === null ? [] : [{ account, why }];
    }),
    problems,
    notes,
  };
}

/** The accounts this team borrows: every account one of its seats pays with that the machine's
 *  entity map gives to another entity (`ownerEntityOf`'s first claim decides a name two entries
 *  list), sorted by account. A team whose file names no `entity:` borrows every claimed account
 *  it spends; an account no entry claims, and one the team's own entity claims, are not
 *  borrowing. An account is borrowed however the team budgets it — the map says whose
 *  subscription it is. */
function borrowedBy(team: TeamFile, seats: readonly Seat[], home: string, runningOf: (seat: { name: string }) => string | undefined): Array<{ account: string; entity: string }> {
  const owners = ownerEntityOf(machineAccountsByEntityOf(home));
  const accounts = [...new Set(seats.map((seat) => payingAccountOf(seat, runningOf(seat))))].sort();
  return accounts.flatMap((account) => {
    const entity = owners.get(account);
    return entity === undefined || entity === team.entity ? [] : [{ account, entity }];
  });
}

/** The account list a machine line is built from: every account the file's own budgets declare,
 *  plus every machine account the file does not name (the owner's subscriptions count for every
 *  team; a file entry of the same name overrides one), sorted by name, each with its kind and its
 *  lab (§ 2.3's rule, the paying rule's own attribution). */
function declaredOf(budgets: TeamFile['budgets'], seats: readonly Seat[], machine: readonly string[], runningOf: (seat: { name: string }) => string | undefined): DeclaredAccount[] {
  const declared = Object.entries(budgets.accounts).map(([account, entry]): DeclaredAccount => ({
    account,
    kind: entry.kind,
    lab: labOfAccount(account, seats, runningOf),
  }));
  const named = new Set(declared.map((one) => one.account));
  for (const account of machine) {
    if (named.has(account)) continue;
    // The machine's file names subscriptions only: it is the owner's own list of them.
    declared.push({ account, kind: 'subscription', lab: labOfAccount(account, seats, runningOf), fallback: true });
  }
  return declared.sort((a, b) => (a.account < b.account ? -1 : 1));
}

/** § 2.3's lab rule under the paying attribution: the seat's own lab — the model it RUNS, else
 *  its vendor — for the first in-force seat that draws on the account, else the account's own
 *  name. */
function labOfAccount(account: string, seats: readonly Seat[], runningOf: (seat: { name: string }) => string | undefined): string {
  if (['xai', 'google-antigravity', 'google-gemini', 'openai', 'anthropic', 'zai', 'deepseek', 'cursor'].includes(account)) return account;
  const paying = seats.find((seat) => payingAccountOf(seat, runningOf(seat)) === account);
  return paying === undefined ? account : labOfSeat(paying, runningOf(paying));
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
    .filter((seat) => payingAccountOf(seat) === account)
    .some((seat) => quotaWith(seat.cli, patterns).length > 0);
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
  // The only other why-lines are the not-verified standings' own.
  return standing.kind === 'verified'
    ? { kind: 'not-verified', reason: 'nothing-counted', text: whyNotCounted }
    : { kind: 'not-verified', reason: standing.kind, text: whyNotCounted };
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
 * The readings a caller who is not the owner reads by name: the ones the live file binds. The
 * state file is signed by nothing — it is a cache — and the one door a value from outside the
 * program passes (`state.ts`'s `cleanClassification`) does not reach budget readings, so every
 * string a stored reading carries is the state's, whatever it looks like. A reading is bound
 * when its account is one the budgets in force name — for this caller those are the live
 * file's own — one of the machine's accounts (`accounts.yaml`, every team's to draw on), or
 * the account one of the file's seats' CLI and launcher resolve to (the paying rule's own
 * resolution, `machine-accounts.ts`, over the same budgets); its window and source are ones
 * this tool writes (`WINDOWS`, and the two `ReadingSource`s — no file can write any other
 * value). The seat names come from the same live file: a name the file does not write is
 * unbound. A reading that fails those is not rendered at all, and one fixed line per kind says
 * so; a seat's name is narrower than that — it does not hide the figures behind it — so a
 * reading whose seat the file's seats do not name (the string `watch` writes, `watch/pass.ts:331`)
 * prints with no seat (`-` in the block, null in `--json`). The owner reads every reading the
 * state holds, as before.
 */
function boundReadings(list: readonly Seen[], budgets: TeamFile['budgets'], inForce: TeamFile, machine: readonly string[], notes: string[]): Seen[] {
  const accounts = new Set<string>(machine);
  for (const account of Object.keys(budgets.accounts)) accounts.add(account);
  const seats = new Set<string>();
  for (const seat of inForce.seats) {
    accounts.add(payingAccountOf(seat));
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

/** Why the live accounts count nothing. A refused approval's details are shown only to
 *  the owner; other callers receive the fixed NOT_VERIFIED sentence. A machine account
 *  (`accounts.yaml`) counts for every team, so even a file that names none still counts
 *  one, and the sentence holds only when no account at all is in play. */
/** Why the live accounts count nothing. A refused approval's details are shown only to
 *  the owner; other callers receive the fixed NOT_VERIFIED sentence. The machine's own accounts
 *  (`accounts.yaml`) count for every team, so they are the one thing that makes the sentence
 *  false: the row a machine account prints is a figure counted, with no declaration under it. */
function whyNotCountedOf(standing: Standing, team: TeamFile, budgets: TeamFile['budgets'], restricted: boolean, machine: readonly string[]): string | null {
  if (Object.keys(team.budgets.accounts).length === 0) {
    return Object.keys(budgets.accounts).length === 0 && machine.length === 0 ? NOTHING_COUNTED : null;
  }
  if (standing.kind !== 'verified') {
    // The switch is on the structured standing, never on the store's wording: a new refusal
    // reason cannot leak because nobody thought to match its text.
    return restricted && standing.kind === 'refused' ? NOT_VERIFIED : notInForce(standing);
  }
  return null;
}

/** Validate the live team file; an unreadable or invalid file has no fallback. */
function teamOf(root: string, home: string): TeamFile | null {
  const live = readText(join(root, TEAM_FILE));
  if (live !== null) {
    const checked = validateTeamFile(live, { home, root });
    if (checked.ok) return checked.team;
  }
  return null;
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
 *  note itself names is absolute. The owner reads the message as it was written, except that the
 *  home folder it may name prints as `~/…` (the owner's own rule for the machine report: a path
 *  a reader can click through is the exception, never the rule). The wording after the path is
 *  the state's, quoted as it stands, for both callers. */
function shownNote(message: string, root: string, restricted: boolean, home: string): string {
  return restricted ? message.replaceAll(join(root, '.agents'), '.agents') : tildify(message, home);
}

/** The home folder in a message as `~/…`: the owner's rule that a report names no absolute path.
 *  A message naming no path under the home folder is returned unchanged. */
export function tildify(text: string, home: string): string {
  if (home === '' || home === '/') return text;
  return text.replaceAll(home, '~');
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
export type TeamEntry = {
  kind: 'team';
  root: string;
  usage: ProjectUsage;
  /** The project name the store's own folder records, when this entry came from one: the name
   *  the machine counted the team under before its file broke, so a team whose file cannot be
   *  read still prints by name — never by path. */
  recorded?: string;
};
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
  /** The home folder the walk read, so a path in a note prints as `~/…` (the report's rule). */
  home: string;
  machineAccounts: string[];
  readings: MachineReading[];
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

/** A path's real form, so two stores recording one root compare equal. Exported for the live
 *  quota observer, which matches the caller's own team by the same rule the report does. */
export function realKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether a team's herdr session still runs, as `machineUsage` asks it: false is a session that
 *  is gone or stopped, null is one herdr cannot be asked about (no evidence either way). */
export type SessionLiveness = (session: string) => boolean | null;

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
 *
 * `sessions` is the live machine's answer to whether a team's session still runs. A team whose
 * session is gone or stopped leaves a record, not seats: its file's declarations still count as
 * declarations, but no seat row, vendor or pane from it reaches a report. Omitted (a test's own
 * call), nothing is filtered — the fixture's teams are all live by construction.
 */
export function machineUsage(home: string, now: number, view: UsageView, sessions?: SessionLiveness, running?: RunningModels): MachineUsage {
  const machineAccounts = machineAccountsOf(home);
  const readings = readMachineReadings(home);
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
      entries.push({ kind: 'store', text: tildify(error instanceof Error ? error.message : String(error), home) });
      continue;
    }
    // A store folder with no record at all is not a team: nothing was ever approved in it.
    if (record === null) continue;
    const root = record.approval.root;
    const key = realKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    const usage = projectUsage(root, { home, now, restricted, ...(running === undefined ? {} : { running }) });
    if (!existsSync(root)) {
      // The path is this machine's own derivation, so a caller who is not the owner reads the
      // sentence without it — its own project's included (§ 2.3's paths rule); the owner reads
      // the path under their home as `~/…`, never absolute (the owner's own rule). The folder's
      // absence is the whole reason: without this filter the same team would also carry the
      // unreadable-file problem, and a named team would print both sentences for one cause.
      usage.problems = usage.problems.filter((problem) => problem.kind !== 'unreadable-file');
      usage.problems.push({ kind: 'moved', text: restricted ? 'the project folder is not there anymore' : `the project folder ${tildify(root, home)} is not there anymore` });
    }
    // The store's folder names the team (`<project>-<12 hex>`, `store.ts:59-64`): the recorded
    // name rides the entry so a file that cannot be read still prints as a team, by name.
    entries.push({ kind: 'team', root, recorded: name.replace(/-[0-9a-f]{12}$/, ''), usage });
  }
  if (view.mine !== null && !seen.has(realKey(view.mine))) {
    entries.push({ kind: 'team', root: view.mine, usage: projectUsage(view.mine, { home, now, restricted, ...(running === undefined ? {} : { running }) }) });
  }
  const teams = entries.filter((entry): entry is TeamEntry => entry.kind === 'team');
  // A team whose herdr session no longer runs is a record: the file still declares what it
  // declares, but its seat rows, vendors and panes are history, and a history row is exactly the
  // stale name a report must not show (the owner's rule: never a seat from a stale record). A
  // session herdr cannot be asked about (null) is left alone: no evidence, no removal.
  if (sessions !== undefined) {
    for (const team of teams) {
      if (team.usage.session === null || sessions(team.usage.session) !== false) continue;
      team.usage.seatAccounts = [];
      team.usage.vendors = [];
    }
  }
  // An explicit budget declaration decides an account's kind and lab before any machine
  // fallback, regardless of store order. Among explicit declarations, the first team still
  // decides: an account appears once even when teams give it different labs.
  const declarationOf = new Map<string, DeclaredAccount>();
  for (const team of teams) for (const declared of team.usage.accounts) {
    const known = declarationOf.get(declared.account);
    if (known === undefined || (known.fallback && !declared.fallback)) declarationOf.set(declared.account, declared);
  }
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
      const preferred = declarationOf.get(declared.account) ?? declared;
      const slot = labSlot(preferred.lab);
      // The lab name is the winning declaration's, which may be another team's: a team belongs
      // here only when the name is its own — its own explicit declaration under this lab, or its
      // own vendor below. A fallback declaration (the machine's account list reaching a team that
      // never named the account) is no team's metadata, so it carries the account, never the lab.
      if (declared.fallback !== true && declared.lab === preferred.lab && !slot.carried.includes(team)) slot.carried.push(team);
      const account = slot.accounts.get(declared.account) ?? { account: declared.account, kind: preferred.kind, declaring: [] };
      account.declaring.push(team);
      slot.accounts.set(declared.account, account);
    }
    for (const vendor of team.usage.vendors) {
      const slot = labSlot(vendor);
      if (!slot.carried.includes(team)) slot.carried.push(team);
    }
  }
  // A subscription is machine-wide even before the first team is approved.
  for (const account of machineAccounts) {
    const slot = labSlot(declarationOf.get(account)?.lab ?? account);
    if (!slot.accounts.has(account)) slot.accounts.set(account, { account, kind: 'subscription', declaring: [] });
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
  // The zero-config accounts: a lab its seats draw on and no file declares is one account named
  // after the lab (the owner's rule), counted on the machine before its first reading. A name a
  // declaration or a reading already counts is not counted twice.
  for (const lab of built) {
    if (lab.accounts.length === 0 && lab.carried.length > 0) accountNames.add(lab.lab);
  }
  return {
    home,
    machineAccounts, readings,
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
  /** Machine screen observation time, distinct from a team's last percentage change. */
  observedAt?: string;
  window: WindowName | null;
  left: number | null;
  used: number | null;
  resetsIn: string | null;
  /** ISO, null when nothing counted for the line: the line reads `unknown` then. */
  changedAt: string | null;
  age: string | null;
  /** Where the figure was read. A budget reading's own two sources (`status_line`, `check`), or
   *  a live/beside-the-line figure: a seat's status row, a CLI's own usage print, or the watch's
   *  machine-wide reading store. */
  source: ReadingSource | 'cli_usage' | 'machine_reading' | null;
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

export type ReportTeamRow = {
  team: string;
  root?: string;
  row: ReportRow;
  /** Set when this team's row counts an account it borrows: the entity the machine's own map
   *  gives that account to (`borrowedBy`). The same fact in both views, like the row's figures;
   *  absent whenever the account is the team's own or no entity claims it. */
  borrowedFrom?: string;
};

export type ReportSpendRow = {
  team: string;
  root?: string;
  reading: { amount: number; currency: string; at: string; age: string; source: 'check'; state: BudgetState };
  /** The borrowing clause, exactly as `ReportTeamRow`'s. */
  borrowedFrom?: string;
};

/** One machine line's entry. One entry per line, so the text and the array walk side by side. */
export type ReportAccount =
  | { account: string; kind: 'subscription'; machine: ReportMachine; teams: ReportTeamRow[]; readable: boolean; pool?: 'gemini' | 'claude-gpt' }
  | { account: string; kind: 'spend'; machine: ReportSpendMachine; teams: ReportSpendRow[] };

export type ReportLab = {
  lab: string;
  accounts: ReportAccount[];
  /** Other teams' accounts this lab holds that the caller's own file does not name (restricted
   *  only): counted beside the lab, never named and never given a figure. */
  others?: number;
  /** The seats drawing on a lab no screen reads and no reading reached: the one line that stands
   *  for the lab says how many, in place of an `unknown` row that would read as a missing figure. */
  seats?: number;
};

export type ReportWhy = { scope: string; account: string; why: string };
export type ReportNote = { scope: string; why: string; count?: number };

/** One quota figure a seat's own screen (or the watch's record of it) gave: the window, its two
 *  percentages, the reset and margin the report already reads, and whether this run measured the
 *  figure or read an earlier record. A seat's screen may name a different account from the one
 *  that pays for it (a DeepSeek seat on the Claude Code CLI prints Anthropic's own bar), so the
 *  row carries the account the figure belongs to. */
export type ReportSeatWindow = {
  window: WindowName;
  /** The account the figure measures — not always the account that pays for the seat. */
  account: string;
  left: number | null;
  used: number | null;
  resetsAt: string | null;
  resetsIn: string | null;
  /** Expected minus used, one decimal, when the window's clock allows one. */
  margin: number | null;
  /** `measured` when this run read the seat's own screen; `estimated` when the figure is read
   *  from an older record (the watch's per-seat reading in the project state). */
  mark: 'measured' | 'estimated';
  source: string;
  readAt: string | null;
  age: string;
  stale: boolean;
};

/** A seat's spend in money, per run. `source` carries the session registry's own two words
 *  (`SessionRecord['cost']['source']`, sessions format 1) plus `unknown`, which the registry
 *  spells by omitting the field and printing `unknown`, never a zero: `measured` when this run
 *  read the amount off the seat's own screen — the claude-family status row's `S: $5.8`
 *  (test/usage-quota.test.ts:47) is the one grammar a capture showed printing money — or
 *  `unknown` with its reason when no screen printed an amount. The figure is per seat and per
 *  run: the pane's own session, stamped with the herdr session it was read in; `readFrom`,
 *  `readAt` and `age` say where and when this run read it. */
export type ReportSeatCost = {
  amount: number | null;
  currency: 'USD';
  /** The session registry's own word for how the amount was obtained. */
  source: 'measured' | 'estimated' | 'unknown';
  /** The screen a measured amount was read from (the status line). */
  readFrom?: string;
  /** ISO, when this run read the figure. */
  readAt?: string;
  age?: string;
  /** Why no amount is known, in the tool's own words. */
  why?: string;
};

/** One seat of a breakdown block: the seat's name, its CLI, the account that pays for it, the
 *  run (herdr session) it belongs to, its quota figures with their marks, and its spend. Copied
 *  field by field: the internal row also carries the lab's vendor and the pane, and neither is
 *  another reader's business. */
export type ReportSeatRow = {
  seat: string;
  cli: string;
  account: string;
  pool?: 'gemini' | 'claude-gpt';
  /** The team file's herdr session: the run the seat and its readings belong to. */
  run?: string;
  windows: ReportSeatWindow[];
  cost: ReportSeatCost;
};

/** One team's breakdown block: its seats and the account each draws on. The default report
 *  carries the caller's own team; `--all` under the full view carries every team's. */
export type ReportTeamBlock = { team: string; root?: string; seats: ReportSeatRow[] };

/** The live observations a caller made before the filter ran: `observeQuota`'s output, or none
 *  when the command has no live source (a test's own sources, a run outside herdr). `notes` are
 *  already collapsed to one entry per distinct why with its count. */
export type QuotaFacts = {
  observations: QuotaObservation[];
  /** The money figures the same live read produced; absent from a caller with no cost source. */
  costs?: readonly CostObservation[];
  notes: Array<{ why: string; count: number }>;
};

/** The one report both renderers print (design § 2.3, restricted shape). */
export type UsageReport = {
  format: 1;
  at: string;
  view: 'full' | 'restricted';
  mine: string | null;
  counts: { teams: number; labs: number; accounts: number };
  labs: ReportLab[];
  /** The quota view: the same visible labs and accounts with their window figures, margins,
   *  states, seats and the one advice line. Built from observations the caller handed in and the
   *  machine's own reading store; never from a team the view hides. */
  quota: ReportQuota;
  unknown: ReportWhy[];
  notes: ReportNote[];
  /** The per-team seat breakdowns this view prints: the caller's own team by default, every
   *  team under `--all` — a flag only the full view honours, so another team's names stay the
   *  owner's. */
  teams: ReportTeamBlock[];
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
  {
    why: PANE_UNREAD,
    sentence: (n) => (n === 1 ? '1 seat pane could not be read' : `${n} seat panes could not be read`),
  },
  {
    why: USAGE_UNANSWERED,
    sentence: (n) => (n === 1 ? 'a CLI usage command did not answer' : `${n} CLI usage commands did not answer`),
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
    : problem.kind === 'no-figures' || problem.kind === 'unreadable-file'
      ? 'its file could not be read'
      : problem.kind === 'moved'
        ? 'its project folder is not there anymore'
        : {
            none: 'its file was never approved on this machine',
            legacy: 'its file was approved before records were signed',
            refused: 'its approval on this machine does not verify',
            'nothing-counted': 'its file declares no account, so nothing is counted',
          }[problem.reason];
  return ANON.find((one) => one.why === why) ?? { why, sentence: (n) => `${n === 1 ? '1 team' : `${n} teams`} cannot be read (${why})` };
}

/**
 * Whether a team problem is the usage report's to print. A file that declares no account is no
 * longer a reason the report shows nothing: the zero-config accounts read its seats' status rows,
 * and a lab nothing reads yet prints its account `unknown` with no figure. The problem still
 * exists on the block (`team status`'s own sentence); only this report stops counting it.
 */
function shownProblem(problem: TeamProblem): boolean {
  return !(problem.kind === 'not-verified' && problem.reason === 'nothing-counted');
}

/**
 * The zero-config accounts (owner, 2026-10-17): a live status row or a CLI's own usage print
 * names the account behind its figure, and a machine that declares nothing still shows it. A
 * figure whose account no visible lab carries is put under the account's lab — the lab of that
 * name when the machine has one, else the one lab the seats paying it belong to, else a lab
 * named after the account — and, with no `accounts.yaml` to name accounts, the account prints
 * under the lab's own name: one account per lab, the lab's seats behind it. A declared account
 * is never synthesized, so `accounts.yaml` stays the way to name an account or split a lab.
 *
 * Only an observation this view may make can create a lab: the full view's every read, and the
 * restricted view's reads from the caller's own seats. A machine-wide reading (no seat) attaches
 * to a lab that already prints; it never invents one for a caller another team's material.
 */
type Synthesized = {
  /** The observations, with each synthesized figure's account renamed to its lab's account. */
  observations: QuotaObservation[];
  /** `account\0pool` of a synthesized account -> what it merges. */
  merged: Map<string, { lab: string; pool?: 'gemini' | 'claude-gpt'; from: Set<string> }>;
  /** How many labs and accounts the synthesis added, for the report's closing counts. */
  created: { labs: number; accounts: number };
};

function synthesizeAccounts(
  labs: ReportLab[],
  machine: MachineUsage,
  view: UsageView,
  mineEntry: TeamEntry | null,
  now: number,
  observations: QuotaObservation[],
  withFigure: Set<string>,
  readable: ReadonlySet<string>,
): Synthesized {
  const named = new Set<string>();
  const labByName = new Map<string, ReportLab>();
  for (const lab of labs) {
    labByName.set(lab.lab, lab);
    for (const entry of lab.accounts) named.add(entry.account);
  }
  // The labs the machine already holds: a figure that lands in one of them renames or fills a
  // lab the machine has, and adds no lab or account to the closing counts.
  const knownLabs = new Set(machine.labs.map((lab) => lab.lab));
  const mineSeats = new Set((mineEntry?.usage.seatAccounts ?? []).map((seat) => seat.seat));
  // The accounts the caller's own seats draw on: a machine-wide read (a CLI's own usage print
  // names no seat) may land on a lab when the caller pays that account, and on no other.
  const minePays = new Set((mineEntry?.usage.seatAccounts ?? []).map((seat) => seat.account));
  const merged = new Map<string, { lab: string; pool?: 'gemini' | 'claude-gpt'; from: Set<string> }>();
  const created = { labs: 0, accounts: 0 };
  /** The lab an undeclared account belongs to: by name, then the lab its paying seats' vendor
   *  names — the one lab whose name the account starts with when several vendors pay it (a
   *  `google-antigravity` account paid by a `google` seat and a claude-family seat lands under
   *  `google`), then the only paying vendor, then the account's own name. */
  const labFor = (account: string): string => {
    if (labByName.has(account)) return account;
    const payers = new Set<string>();
    for (const team of machine.teams) {
      for (const seat of team.usage.seatAccounts) if (seat.account === account && labByName.has(seat.vendor)) payers.add(seat.vendor);
    }
    const byName = [...payers].filter((lab) => lab === account || account.startsWith(`${lab}-`));
    if (byName.length === 1) return byName[0] as string;
    if (payers.size === 1) return [...payers][0] as string;
    return account;
  };
  const rewritten: QuotaObservation[] = [];
  for (const one of observations) {
    if (one.account === '') continue;
    // A declared account is the machine's own naming: it keeps its name and its lab.
    if (named.has(one.account)) {
      rewritten.push(one);
      continue;
    }
    const mayName = view.full || (one.seat !== null ? mineSeats.has(one.seat) : minePays.has(one.account));
    if (!mayName) continue;
    const labName = labFor(one.account);
    const key = `${labName}\0${one.pool ?? ''}`;
    let info = merged.get(key);
    if (info === undefined) {
      info = { lab: labName, ...(one.pool ? { pool: one.pool } : {}), from: new Set() };
      merged.set(key, info);
      if (!knownLabs.has(labName)) created.accounts += 1;
    }
    info.from.add(one.account);
    let lab = labByName.get(labName);
    if (lab === undefined) {
      lab = { lab: labName, accounts: [] };
      labByName.set(labName, lab);
      labs.push(lab);
      if (!knownLabs.has(labName)) created.labs += 1;
    }
    rewritten.push(one.account === labName ? one : { ...one, account: labName });
  }

  // One machine-table row per synthesized account and window, from the freshest figure read:
  // the table's own nine columns, filled from the observation and never a guess. A wall carries
  // no figure, so it rides only in the quota block below.
  for (const info of merged.values()) {
    const lab = labByName.get(info.lab);
    if (lab === undefined) continue;
    const newest = new Map<string, QuotaObservation>();
    for (const one of rewritten) {
      if (one.account !== info.lab || (one.pool ?? undefined) !== info.pool) continue;
      if (one.wall || one.window === null) continue;
      const known = newest.get(one.window);
      if (known === undefined || one.observedAt > known.observedAt) newest.set(one.window, one);
    }
    for (const one of newest.values()) {
      const source = one.source === 'status line' ? 'status_line' as const
        : one.source === 'cli usage' ? 'cli_usage' as const
          : one.source === 'machine reading' ? 'machine_reading' as const : null;
      const fresh = now - one.observedAt < QUOTA_STALE_MS && (one.resetsAt === null || one.resetsAt > now);
      lab.accounts.push({
        account: info.lab,
        kind: 'subscription',
        readable: true,
        ...(info.pool ? { pool: info.pool } : {}),
        teams: [],
        machine: {
          window: one.window,
          left: one.left,
          used: one.used,
          resetsIn: one.resetsAt === null ? one.resetText : span(Math.max(0, one.resetsAt - now)),
          changedAt: new Date(one.observedAt).toISOString(),
          observedAt: new Date(one.observedAt).toISOString(),
          age: span(Math.max(0, now - one.observedAt)),
          source,
          fallback: false,
          state: fresh ? 'fresh' : 'stale',
          inside: false,
          reserve: null,
          pace: null,
          other: false,
          seat: one.seat,
        },
      });
      if (fresh) withFigure.add(info.lab);
    }
    lab.accounts.sort(byLine);
  }

  // A lab no file declares, whose seats draw on it: without `accounts.yaml` the lab's seats are
  // one account named after the lab (the owner's zero-config rule), and it prints before its
  // first reading — `unknown` with no window, exactly as a declared account with no reading does.
  // The seats behind it join below by the accounts they pay with, so a lab whose seats pay an
  // account of another name (`google-antigravity` under the `google` lab) still lists them.
  for (const lab of labs) {
    if (lab.accounts.length > 0) continue;
    const pays = new Set<string>();
    for (const team of machine.teams) {
      for (const seat of team.usage.seatAccounts) if (seat.vendor === lab.lab) pays.add(seat.account);
    }
    if (pays.size === 0) continue;
    const key = `${lab.lab}\0`;
    if (!merged.has(key)) merged.set(key, { lab: lab.lab, from: pays });
    lab.accounts.push({
      account: lab.lab,
      kind: 'subscription',
      // Readable when any account its seats pay with is: the `google` lab's seats pay
      // `google-antigravity`, and a CLI usage print reads that account.
      readable: [...pays].some((account) => readable.has(account)),
      teams: [],
      machine: {
        window: null,
        left: null,
        used: null,
        resetsIn: null,
        changedAt: null,
        age: null,
        source: null,
        fallback: false,
        state: 'unknown',
        inside: false,
        reserve: null,
        pace: null,
        other: false,
        seat: null,
      },
    });
  }
  // A lab the synthesis gave a figure prints that figure, not a seat count: the seats line was
  // counted for a lab with no reading, and a reading arrived. A lab whose own name a screen can
  // read keeps its `unknown` row too — that is a figure not yet seen, not one no screen reads.
  for (const lab of labs) {
    if (lab.seats === undefined) continue;
    if (readable.has(lab.lab) || lab.accounts.some((entry) => entry.machine.state !== 'unknown')) delete lab.seats;
  }
  // A lab a figure added is placed by its name with the machine's own labs, so the table's order
  // never depends on which lab was seen first.
  labs.sort((a, b) => (a.lab < b.lab ? -1 : a.lab > b.lab ? 1 : 0));
  return { observations: rewritten, merged, created };
}

/**
 * The one filter: the machine's facts in, exactly the report's fields out. A team the caller does
 * not own contributes counts, fixed sentences and figures of accounts the caller's own file
 * names — never a name, a root, a seat, a path or a message a read produced. When the caller
 * stands outside any project (`view.mine` null, `mineNotes` the position's own notes) every lab,
 * account and row belonging to another team is out, and the counts and fixed sentences stand in.
 * `allTeams` is the command's `--all`: under the full view it widens the breakdown blocks to
 * every team; a caller the view does not widen gets one note saying so, and no other team's name.
 */
export function reportOf(machine: MachineUsage, view: UsageView, now: number, mineNotes: readonly string[], allTeams = false, live: QuotaFacts | null = null): UsageReport {
  const mineEntry = view.mine === null ? null : machine.teams.find((team) => realKey(team.root) === realKey(view.mine as string)) ?? null;
  const mineName = mineEntry?.usage.project ?? null;
  const nameOf = (team: TeamEntry) => team.usage.project ?? team.root;
  /** The name a member's own material prints under: its name, or `mine` when it has none. */
  const scopeOf = (team: TeamEntry) => (team === mineEntry ? mineName ?? 'mine' : view.full ? nameOf(team) : 'another');
  // The accounts the caller's own file names: the only accounts the restricted view may name.
  const mineAccounts = new Set((mineEntry?.usage.accounts ?? []).map((declared) => declared.account));
  for (const account of machine.machineAccounts) mineAccounts.add(account);
  const visible = (account: string) => view.full || mineAccounts.has(account);
  // The accounts a CLI screen on this machine can expose a figure for: any shipped quota
  // pattern's account, plus any account a team's own seats' patterns read. An account outside
  // the set prints `not readable from a CLI screen` — the truth about where its figure can come
  // from, never `unknown`, which reads as a figure not yet seen.
  const readable = new Set<string>([...shippedQuotaAccounts(), ...USAGE_ACCOUNTS]);
  for (const team of machine.teams) for (const account of team.usage.quotaAccounts) readable.add(account);

  const labs: ReportLab[] = [];
  /** The accounts some line of this report carries a figure for: the why-lines print only under
   *  an account that reads `unknown` everywhere (`§ 2.3`'s example), never under one with figures
   *  — an account whose newest counted reading is another team's says nothing about the team
   *  whose own pattern cannot read it. */
  const withFigure = new Set<string>();
  for (const lab of machine.labs) {
    const mineCarries = mineEntry !== null && lab.carried.includes(mineEntry);
    // A lab the caller's own team does not carry prints for the machine subscriptions in it alone,
    // and under a machine-owned name: the account's own name, the one a subscription prints under
    // when no team declares it. A custom account's lab is the vendor of the seat that draws on it
    // in the team that declares it first — that team's own metadata, which this view never carries.
    const name: string | undefined = view.full || mineCarries ? lab.lab
      : lab.accounts.filter((entry) => machine.machineAccounts.includes(entry.account))
          .map((entry) => entry.account).sort()[0];
    if (name === undefined) continue;
    const accounts: ReportAccount[] = [];
    let others = 0;
    for (const account of lab.accounts) {
      if (!visible(account.account)) {
        others += 1;
        continue;
      }
      if (account.kind === 'spend') {
        const entry = spendEntryOf(account, view, mineEntry, now, allTeams);
        if (entry.machine.state !== 'unknown') withFigure.add(account.account);
        accounts.push(entry);
      } else {
        for (const line of account.lines) {
          const entry = subscriptionEntryOf(account.account, line, view, mineEntry, now, readable.has(account.account), allTeams);
          if (entry.machine.state !== 'unknown') withFigure.add(account.account);
          accounts.push(entry);
        }
      }
    }
    accounts.sort(byLine);
    // A lab no screen reads and no reading reached yet is still the lab its team's seats draw
    // on: count them, so the one line that stands for the lab says how many instead of the lab
    // printing an `unknown` row that reads as a figure not yet seen.
    const noFigure = accounts.length === 0 || accounts.every((entry) =>
      entry.machine.state === 'unknown' && entry.kind === 'subscription' && !entry.readable);
    let seats = 0;
    if (noFigure && others === 0) {
      for (const team of machine.teams) {
        if (team !== mineEntry && !view.full) continue;
        for (const seat of team.usage.seatAccounts) if (seat.vendor === lab.lab) seats += 1;
      }
    }
    labs.push({ lab: name, accounts, ...(others > 0 ? { others } : {}), ...(seats > 0 ? { seats } : {}) });
  }

  // Screen observations are informational at first sight, separate from budget confirmation. A
  // stored figure counts only for the lab whose subscription it is: the store is written by
  // every watch on this machine, so an entry under an account no CLI screen's pattern can name
  // (an older watch's paying-account bucket) is not that account's reading, and the account
  // reads unknown — DeepSeek has no reading of its own until one names it.
  for (const reading of machine.readings) {
    if (reading.observedAt > now) continue;
    if (!readable.has(reading.account)) continue;
    const lab = labs.find((one) => one.accounts.some((entry) => entry.account === reading.account));
    if (!lab) continue;
    if (lab.accounts.some((entry) => entry.account === reading.account && entry.kind === 'spend')) continue;
    const previous = lab.accounts.find((entry) => entry.kind === 'subscription' && entry.account === reading.account
      && entry.machine.window === reading.window && entry.pool === reading.pool);
    if (previous?.kind === 'subscription' && previous.machine.changedAt !== null
      && Date.parse(previous.machine.changedAt) > reading.observedAt) continue;
    lab.accounts = lab.accounts.filter((entry) => entry.account !== reading.account || entry.kind !== 'subscription'
      || (entry.machine.window !== null && (entry.machine.window !== reading.window || entry.pool !== reading.pool)));
    lab.accounts.push({ account: reading.account, kind: 'subscription', readable: true,
      ...(reading.pool ? { pool: reading.pool } : {}), teams: previous?.kind === 'subscription' ? previous.teams : [],
      machine: { window: reading.window, left: reading.left, used: reading.used,
        resetsIn: reading.resetsAt === null ? null : span(Math.max(0, reading.resetsAt - now)),
        changedAt: new Date(reading.observedAt).toISOString(), observedAt: new Date(reading.observedAt).toISOString(),
        age: span(Math.max(0, now - reading.observedAt)),
        source: 'status_line', fallback: false, state: now - reading.observedAt < 300000
          && (reading.resetsAt === null || reading.resetsAt > now) ? 'fresh' : 'stale',
        inside: false, reserve: null, pace: null, other: false, seat: null } });
    lab.accounts.sort(byLine);
    withFigure.add(reading.account);
  }

  // The quota block: the same visible labs and accounts, joined with the seats this view may name
  // on each account and with every observation the caller could make. The store's readings are
  // observations like any other — the watch wrote them from the same status rows — and a live
  // read of the same account and window is newer, so it wins the merge inside `quotaOf`. A wall
  // screen is a fact of its own and rides beside the figures. An account this view hides is never
  // built here, so no aggregate can leak a walled account from another team.
  // A reading stamped after this report's own moment is no observation of the present — the
  // account rows above drop the same entries — so the block never reads it as a fresh figure.
  const observations: QuotaObservation[] = machine.readings.filter((reading) => reading.observedAt <= now && readable.has(reading.account)).map((reading) => ({
    account: reading.account,
    ...(reading.pool ? { pool: reading.pool } : {}),
    window: reading.window === 'daily' ? null : reading.window,
    left: reading.left,
    used: reading.used,
    resetsAt: reading.resetsAt,
    resetText: null,
    observedAt: reading.observedAt,
    source: 'machine reading' as const,
    seat: null,
    margin: null,
    wall: false,
  }));
  if (live !== null) observations.push(...live.observations);
  // The zero-config accounts: a figure no visible lab names lands under its lab's own account
  // name, and gets the table rows above from the freshest reading. A declared account never
  // comes here, so `accounts.yaml` is still the way to name an account or split a lab.
  const synthesized = synthesizeAccounts(labs, machine, view, mineEntry, now, observations, withFigure, readable);
  const quotaLabs: QuotaLabInput[] = labs.map((lab) => {
    const seenAccounts = new Set<string>();
    const accounts: QuotaLabInput['accounts'] = [];
    for (const entry of lab.accounts) {
      if (entry.kind !== 'subscription') continue;
      const key = `${entry.account}\0${entry.pool ?? ''}`;
      if (seenAccounts.has(key)) continue;
      seenAccounts.add(key);
      // A synthesized account is the lab's own name: the seats behind it are the ones its merged
      // accounts PAY for (a CLI usage print names no seat). A seat stands under the account that
      // pays for it, never under the account whose bar its pane happens to show: a DeepSeek seat
      // on Claude Code reads Anthropic's status row, and the figure is Anthropic's while the
      // seat is DeepSeek's.
      const synth = synthesized.merged.get(key);
      const pays = synth?.from ?? new Set<string>([entry.account]);
      const seats: string[] = [];
      let seatsOther = 0;
      for (const team of machine.teams) {
        for (const seat of team.usage.seatAccounts) {
          if (!pays.has(seat.account)) continue;
          // A seat whose model names no pool draws on the account as a whole, so it stands on
          // every pool's entry; a seat with a pool stands only on its own.
          if (seat.pool !== undefined && entry.pool !== undefined && seat.pool !== entry.pool) continue;
          if (team === mineEntry) seats.push(seat.seat);
          else if (view.full) seats.push(`${seat.seat} (${nameOf(team)})`);
          else seatsOther += 1;
        }
      }
      accounts.push({ account: entry.account, ...(entry.pool ? { pool: entry.pool } : {}), seats, ...(seatsOther > 0 ? { seatsOther } : {}) });
    }
    return { lab: lab.lab, accounts };
  });
  const quota = quotaOf({ labs: quotaLabs, observations: synthesized.observations, accountsFile: ACCOUNTS_FILE, now });

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
  // The live source's own problems, already collapsed to one entry per distinct why: a pane that
  // would not read and a CLI usage command that did not answer each print one counted note, never
  // one per seat.
  if (live !== null) for (const note of live.notes) notes.push({ scope: 'usage', why: note.why, ...(note.count > 1 ? { count: note.count } : {}) });
  for (const text of mineNotes) notes.push({ scope: mineName ?? 'mine', why: text });
  const teamOrder = [...machine.teams].sort(byName);
  if (mineEntry !== null) {
    for (const problem of mineEntry.usage.problems) if (shownProblem(problem)) notes.push({ scope: mineName ?? 'mine', why: problem.text });
    for (const note of mineEntry.usage.notes) notes.push({ scope: mineName ?? 'mine', why: note });
  }
  // Every other team's problems are one fixed sentence per kind, with its count, in both views:
  // the owner's rule is one summary line for the teams with no data, never one note per team —
  // and the sentence names no team, so a name the view holds back never rides one. The caller's
  // own team's problems keep their own words above (`mineEntry`), and a store's message is the
  // machine's, not a team's, and keeps its own rule below.
  const groups = new Map<string, number>();
  const namedTeams: ReportNote[] = [];
  for (const team of teamOrder) {
    if (team === mineEntry) continue;
    for (const problem of team.usage.problems) {
      if (!shownProblem(problem)) continue;
      // A team the machine still records by name keeps its name: the store's own folder is the
      // record of which team this is, and the owner asked a team whose file cannot be read to
      // print by that name and its `~/…` root (the report's own rule for a path) as one sentence.
      // A `~/…` root prints in every view, so a seat's line says what the owner's says; a root
      // outside the home is a location this tool derived, and only the owner reads it.
      if (problem.kind === 'unreadable-file' && team.recorded !== undefined && team.recorded !== '') {
        const shownRoot = tildify(team.root, machine.home);
        namedTeams.push(view.full || shownRoot.startsWith('~/')
          ? { scope: 'named-team', why: `the team "${team.recorded}" (${shownRoot}): its file could not be read.` }
          : { scope: team.recorded, why: 'its file could not be read' });
        continue;
      }
      const { why } = anonOf(problem);
      groups.set(why, (groups.get(why) ?? 0) + 1);
    }
  }
  for (const [why, count] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    notes.push({ scope: 'another', why, ...(count > 1 ? { count } : {}) });
  }
  for (const note of namedTeams) notes.push(note);
  // A store problem's message is the read's own and carries the store's path: the owner reads it
  // as it stands; every other caller reads the fixed sentence with the count (§ 2.3's note rule).
  if (view.full) for (const message of machine.stores) notes.push({ scope: 'store', why: message });
  else if (machine.stores.length > 0) {
    notes.push({ scope: 'store', why: 'a store on this machine cannot be read', ...(machine.stores.length > 1 ? { count: machine.stores.length } : {}) });
  }

  // The breakdown blocks: the caller's own team first, then — only under `--all` and only in the
  // full view, where another team's name is already allowed — every other team by name. A caller
  // the view does not widen reads one note instead, never a name the view holds back.
  // The breakdowns carry each seat's own figures: read live this run where the seat's pane
  // answered (measured), from the project state's per-seat record otherwise (estimated), and no
  // row where neither exists — a seat with no figure reads `unknown` in the tree, never a zero.
  // Only a block this view prints is asked for its state, so the restricted view reads no other
  // team's store.
  const breakdowns: ReportTeamBlock[] = [];
  if (mineEntry !== null && mineName !== null) {
    breakdowns.push({ team: mineName ?? 'mine', seats: seatRowsOf(mineEntry, live, now) });
  }
  if (allTeams && view.full) {
    for (const team of teamOrder) {
      if (team === mineEntry) continue;
      breakdowns.push({ team: nameOf(team), root: team.root, seats: seatRowsOf(team, live, now) });
    }
  }
  if (allTeams && !view.full) {
    notes.push({ scope: 'usage', why: "the full team list is the owner's view: --all shows this team's seats only" });
  }

  return {
    format: 1,
    at: new Date(now).toISOString(),
    view: view.full ? 'full' : 'restricted',
    mine: mineName,
    // Copied, not carried: the report is stringified for the `--json` face, so a field the
    // machine's counts grows later must not reach the DTO by reference (the `reportRowOf` rule).
    // The machine's own counts already include the zero-config accounts (one per undeclared lab
    // its seats draw on); a figure that names a lab the machine does not hold adds its own.
    counts: {
      teams: machine.counts.teams,
      labs: machine.counts.labs + synthesized.created.labs,
      accounts: machine.counts.accounts + synthesized.created.accounts,
    },
    labs,
    quota,
    unknown,
    notes,
    teams: breakdowns,
  };
}

/** The tool's words for a seat whose screen printed no amount this run: the report shows the
 *  spend unknown with this reason, never a zero that would read as a measured spend. */
const SEAT_COST_UNREAD = 'no money cost was read from this seat\'s screen this run';

/**
 * One team's seats, each with its own figures. The state is read once per block for the watch's
 * per-seat record; a state that cannot be read leaves every seat `estimated`-less rather than
 * failing the report, which is what every other read of a broken store already does. A figure
 * this run measured wins over an older record of the same account and window; the record fills
 * the windows the live read did not answer, marked `estimated`. A seat with neither carries no
 * window at all — the tree prints `unknown`, never a zero.
 */
function seatRowsOf(entry: TeamEntry, live: QuotaFacts | null, now: number): ReportSeatRow[] {
  const run = entry.usage.session;
  let stored: Seen[] = [];
  try {
    stored = recall(readState(join(entry.root, '.agents')).budgets);
  } catch {
    stored = [];
  }
  // The same binding the report's rows use (`boundReadings`): a reading names an account the
  // file in force declares (or the machine holds) and a seat the file names. A stored reading
  // for anything else is not the seat's figure and never becomes one here.
  const boundAccounts = new Set(entry.usage.accounts.map((one) => one.account));
  const observations = live?.observations ?? [];
  const costs = live?.costs ?? [];
  // A stamp the observer made keeps two teams' same-named seats apart; a reading made before the
  // stamp existed (a test's own) still belongs to the row that names its seat.
  const mine = (one: { session?: string | null }): boolean => one.session === undefined || one.session === null || run === null || one.session === run;
  return entry.usage.seatAccounts.map((row) => {
    const bound = stored.filter((one) => boundAccounts.has(one.account));
    const measured = observations.filter((one) => one.seat === row.seat && !one.wall && one.window !== null && mine(one));
    const paid = costs
      .filter((one) => one.seat === row.seat && mine(one))
      .sort((a, b) => b.observedAt - a.observedAt)[0] ?? null;
    return {
      seat: row.seat,
      cli: row.cli,
      account: row.account,
      ...(row.pool ? { pool: row.pool } : {}),
      ...(run === null ? {} : { run }),
      windows: seatWindowsOf(row.seat, measured, bound, now),
      cost: costOf(paid, now),
    };
  });
}

/** One seat's spend as this run read it: the newest observation of its own screen, marked
 *  measured, or unknown with one reason. A screen that printed no amount is never a zero. */
function costOf(paid: CostObservation | null, now: number): ReportSeatCost {
  if (paid === null) return { amount: null, currency: 'USD', source: 'unknown', why: SEAT_COST_UNREAD };
  return {
    amount: paid.amount,
    currency: paid.currency,
    source: 'measured',
    readFrom: paid.source,
    readAt: new Date(paid.observedAt).toISOString(),
    age: span(now - paid.observedAt),
  };
}

/** One seat's windows: the newest live figure per account and window, then the state's record
 *  for every account and window the live read left open. `measured` is this run's own read of
 *  the seat's screen; `estimated` is the watch's earlier record. The state is the project's own,
 *  so its readings need no session stamp: within one project a seat name is one seat. */
function seatWindowsOf(seat: string, measured: readonly QuotaObservation[], stored: readonly Seen[], now: number): ReportSeatWindow[] {
  const windows = new Map<string, ReportSeatWindow>();
  for (const one of measured) {
    if (one.window === null) continue;
    const window = one.window;
    const stale = now - one.observedAt > QUOTA_STALE_MS || (one.resetsAt !== null && one.resetsAt <= now);
    const key = `${one.account}\0${window}`;
    const candidate: ReportSeatWindow = {
      window,
      account: one.account,
      left: one.left,
      used: one.used,
      resetsAt: one.resetsAt === null ? null : new Date(one.resetsAt).toISOString(),
      resetsIn: one.resetsAt === null ? one.resetText : span(one.resetsAt - now),
      margin: stale ? null : marginOf(one, now),
      mark: 'measured',
      source: one.source,
      readAt: new Date(one.observedAt).toISOString(),
      age: span(now - one.observedAt),
      stale,
    };
    const known = windows.get(key);
    if (known === undefined || (known.readAt ?? '') < (candidate.readAt ?? '')) windows.set(key, candidate);
  }
  for (const one of stored) {
    if (one.seat !== seat) continue;
    const key = `${one.account}\0${one.window}`;
    // A figure this run measured is newer by construction; the record only fills the gaps.
    if (windows.has(key)) continue;
    const resetsAt = one.resetsAt;
    const stale = now - one.changedAt > QUOTA_STALE_MS || (resetsAt !== null && resetsAt <= now);
    windows.set(key, {
      window: one.window,
      account: one.account,
      left: one.left,
      used: one.used,
      resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
      resetsIn: resetsAt === null ? null : span(resetsAt - now),
      margin: stale || (one.window !== 'session' && one.window !== 'weekly') ? null : marginOf({ used: one.used, window: one.window, resetsAt, margin: null }, now),
      mark: 'estimated',
      // Not the word `watch`: the watch clause is the machine line's own, and a seat figure
      // read from the project state must not read as one.
      source: 'state record',
      readAt: new Date(one.changedAt).toISOString(),
      age: span(now - one.changedAt),
      stale,
    });
  }
  // The account first, the table's window order inside it: the same order the machine lines
  // print, so a seat's figures read in the order its team's accounts do.
  const rank = (one: ReportSeatWindow) => `${one.account}\0${String(WINDOWS.indexOf(one.window)).padStart(2, '0')}`;
  return [...windows.values()].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
}

/** The entity a team's account is borrowed from, or undefined: the fact rides the team's own rows
 *  in both views — it names an entity of the owner's own machine file and the account prints
 *  there already, so a caller who is not the owner reads the same clause the owner does. */
function borrowedOf(team: TeamEntry, account: string): string | undefined {
  return team.usage.borrows.find((one) => one.account === account)?.entity;
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
  readable: boolean,
  allTeams: boolean,
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
  const rows = view.full && allTeams ? line.rows : line.rows.filter((one) => one.team === mineEntry);
  const teams: ReportTeamRow[] = rows
    .map((one) => {
      const from = borrowedOf(one.team, account);
      return {
        team: view.full ? one.team.usage.project ?? one.team.root : one.team.usage.project ?? '',
        ...(view.full ? { root: one.team.root } : {}),
        row: reportRowOf(one.row, one.pace),
        ...(from === undefined ? {} : { borrowedFrom: from }),
      };
    })
    .sort((a, b) => (a.team < b.team ? -1 : 1));
  return { account, kind: 'subscription', machine, teams, readable };
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

function spendEntryOf(account: MachineAccount & { kind: 'spend' }, view: UsageView, mineEntry: TeamEntry | null, now: number, allTeams: boolean): ReportAccount {
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
  const rows = view.full && allTeams ? account.spend.rows : account.spend.rows.filter((one) => one.team === mineEntry);
  const teams: ReportSpendRow[] = rows
    .map((one) => {
      const from = borrowedOf(one.team, account.account);
      return {
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
        ...(from === undefined ? {} : { borrowedFrom: from }),
      };
    })
    .sort((a, b) => (a.team < b.team ? -1 : 1));
  return { account: account.account, kind: 'spend', machine, teams };
}

/**
 * The text both views print (§ 2.3): the header's counts, then each lab's lines — an account's
 * machine line, its allowed rows, its why-lines — then the per-team seat breakdowns, then the
 * notes. An account no CLI screen can expose a figure for prints `not readable from a CLI
 * screen` in place of a figure line, and its `no pattern can read this account` why-line is the
 * same fact said per team, so the line does not repeat under it. The full view differs only in
 * what the report carries, never here: one renderer, one shape.
 */
/** The nine headers the output contract names for this command's machine table (§ 1.1, the
 *  `usage` row). */
const USAGE_HEADERS = ['ACCOUNT', 'WINDOW', 'LEFT', 'USED', 'RESETS', 'RESERVE', 'READ', 'SOURCE', 'STATE'] as const;

export function reportText(report: UsageReport, tree = false): string {
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  // The machine reading is one headed table (§ 1.3), top-level and first: the contract's nine
  // columns in its order, one row per account+window. Everything a row cannot hold as a cell —
  // its per-team rows and its why-lines — follows as list lines in the same account order, and a
  // lab's declaration line follows its lab's rows. The counts sentence closes the report as its
  // summary line.
  const rows: string[][] = [];
  const extras: string[] = [];
  for (const lab of report.labs) {
    // A lab no screen reads stands for its seats in one line, in place of the `unknown` row its
    // account would print: the seat count is the fact, and `not readable from a screen` says why.
    if (lab.seats !== undefined) {
      extras.push(`${lab.lab}  not readable from a screen  (${lab.seats} seat${lab.seats === 1 ? '' : 's'})`);
      continue;
    }
    let at = 0;
    while (at < lab.accounts.length) {
      const first = lab.accounts[at];
      if (first === undefined) break;
      let end = at;
      while (end < lab.accounts.length && lab.accounts[end]?.account === first.account) end += 1;
      for (const entry of lab.accounts.slice(at, end)) {
        rows.push(accountCells(entry, report));
        if (entry.kind === 'spend') {
          for (const row of entry.teams) extras.push(spendRowText(entry.account, row));
        } else {
          for (const row of entry.teams) extras.push(teamRowText(row));
        }
      }
      // A not-readable account's `no pattern can read this account` why is the same fact the
      // machine row above it just said, machine-wide; every other why still prints, named by its
      // account now that the line no longer sits directly under it.
      const unreadable = first.kind === 'subscription' && !first.readable;
      for (const why of report.unknown.filter((one) => one.account === first.account && !(unreadable && one.why === WHY_WORDS['no-pattern']))) {
        extras.push(`  ${first.account}  (${why.scope === 'another' ? 'another team' : why.scope}: ${why.why})`);
      }
      at = end;
    }
    if (lab.accounts.length === 0 && lab.others === undefined) {
      // A lab with no seats and no account keeps the declaration sentence, in the owner's words.
      extras.push(`${lab.lab}  not known: no account declared; declare it in ${report.quota.accountsFile}`);
    } else if (lab.others !== undefined) {
      extras.push(`${lab.lab}: ${lab.others} other account${lab.others === 1 ? '' : 's'}`);
    }
  }
  // The RESERVE column is only there when a row has something in it: a table whose every row
  // reads `-` drops the column, headers and cells together.
  const reserveAt = USAGE_HEADERS.indexOf('RESERVE');
  const keepReserve = rows.length === 0 || rows.some((row) => row[reserveAt] !== '-');
  const lines = [
    ...renderTable({
      headers: keepReserve ? [...USAGE_HEADERS] : USAGE_HEADERS.filter((header) => header !== 'RESERVE'),
      rows: keepReserve ? rows : rows.map((row) => row.filter((_, at) => at !== reserveAt)),
      indent: '',
    }),
    ...extras,
  ];
  // The advice line is the report's answer, not the tree's detail: the default view prints it
  // too, under the table, so near cap and walled always have their one sentence beside them.
  if (!tree) lines.push(`advice: ${report.quota.advice}`);
  // The tree is the second view, behind `--tree` (owner, 2026-10-17): per lab and per account the
  // window figures, margin, state, seats and the one advice line. The table alone is the default
  // report, and each of its STATE cells carries the margin the tree would print -- so the one
  // view never says `pace not known` where the other reads a margin. One blank separates the
  // blocks; a report with no machine row at all has nothing above the tree to separate from.
  if (tree) {
    if (lines.length > 0) lines.push('');
    lines.push(...quotaText(report.quota));
  }
  for (const block of report.teams) {
    lines.push('', block.team);
    lines.push(...renderTable({
      headers: ['SEAT', 'CLI', 'ACCOUNT'],
      rows: block.seats.map((seat) => [seat.seat, seat.cli, `${seat.account}${seat.pool ? ` (${seat.pool})` : ''}`]),
    }));
    // The seat figures are the tree's detail: the default table stays the table it was, and
    // `--tree` adds each seat's own windows, their marks and the one spend line under it.
    if (tree) lines.push(...seatFiguresText(block));
  }
  // A reason repeated is one note with its count (§ 2.2), never the same line twice.
  for (const note of collapseNotes(report.notes.map(noteText))) lines.push(`note: ${note}`);
  lines.push('');
  lines.push(`usage on this machine, ${count(report.counts.teams, 'team')}, ${count(report.counts.labs, 'lab')}, ${count(report.counts.accounts, 'account')}`);
  return `${lines.join('\n')}\n`;
}

/** One team's per-seat figures, under its seat table in the tree: the run the seats belong to,
 *  one line per figure with its window, reset, margin and mark, one spend line per seat, and
 *  `unknown  no reading for this seat` where neither this run nor the watch's record has a
 *  figure. A quota figure a screen printed is `measured`; one read from the watch's per-seat
 *  record is `estimated`; a spend a screen printed is `measured`, and one no screen printed is
 *  `unknown` with its reason — never `0`. */
function seatFiguresText(block: ReportTeamBlock): string[] {
  // The run rides the rows (`run`, `--json`), not a line of its own: the block's header is the
  // team the caller already read, and a session name here would be one more line to keep true.
  const lines: string[] = [];
  for (const seat of block.seats) {
    if (seat.windows.length === 0) lines.push(`  ${seat.seat}  ${seat.cli}  ${seat.account}  unknown  no reading for this seat`);
    for (const one of seat.windows) {
      const left = one.left === null ? 'left unknown' : `left ${one.left}%`;
      const used = one.used === null ? 'used unknown' : `used ${one.used}%`;
      const reset = one.resetsIn === null ? 'resets unknown' : `resets in ${one.resetsIn}`;
      const stale = one.stale ? '  stale' : '';
      lines.push(`  ${seat.seat}  ${seat.cli}  ${one.account}  ${one.window}  ${left}  ${used}  ${reset}  ${marginWord(one.margin)}  ${one.mark}  ${one.source}  read ${one.age} ago${stale}`);
    }
    // The spend line belongs to its seat: the amount is the pane's own session, so two seats on
    // one account print their own figures, and one no screen answered for prints `unknown`.
    const cost = seat.cost.source === 'unknown' || seat.cost.amount === null
      ? `unknown  ${seat.cost.why ?? SEAT_COST_UNREAD}`
      : `$${seat.cost.amount}  ${seat.cost.source}  ${seat.cost.readFrom ?? 'status line'}${seat.cost.age === undefined ? '' : `  read ${seat.cost.age} ago`}`;
    lines.push(`  ${seat.seat}  ${seat.cli}  ${seat.account}  cost  ${cost}`);
  }
  return lines;
}

/** The pace word a line carries (§ 3-S3): one decimal always, in used points per hour — never a
 *  bare integer — or the tool's own words when there is no pace to read. A line with no figure at
 *  all (`unknown`) carries no word: there is nothing to pace. */
function paceWord(pace: number | null): string {
  return pace === null ? 'pace not known' : `pace ${pace.toFixed(1)}%/h`;
}

/** The nine cells of one machine table row: the account, its window, the two percentages, when it
 *  resets, its reserve clause, where the figure was read, from which source, and the state with
 *  the pace word and the watch clause beside it. The pace element is omitted on a restricted row
 *  whose newest reading is another team's — the one row whose pace is withheld (§ 3.3): nothing
 *  stands in its place, since `pace not known` would read as a failed computation where the
 *  figure is real and withheld. Every other row keeps its word, in either view. */
function accountCells(entry: ReportAccount, report: UsageReport): string[] {
  const account = entry.kind === 'subscription' && entry.pool ? `${entry.account} (${entry.pool})` : entry.account;
  if (entry.kind === 'spend') {
    const m = entry.machine;
    if (m.state === 'unknown' || m.amount === null || m.currency === null || m.age === null) {
      return [account, 'spend', '-', '-', '-', '-', '-', '-', 'unknown'];
    }
    const read = m.other
      ? m.team === undefined
        ? `read by another team, ${m.age} ago`
        : `read by ${m.team}, ${m.age} ago`
      : `read ${m.age} ago`;
    return [account, 'spend', `${money(m.amount)} ${m.currency}`, '-', '-', '-', read, 'check', m.state];
  }
  const m = entry.machine;
  if (m.state === 'unknown' || m.left === null || m.used === null) {
    // An account no CLI screen can expose a figure for says so, machine-wide: `unknown` reads as
    // a figure not yet seen, and this account cannot be seen at all. The state word stays one of
    // the block's four — a wall with no figure is `walled` here — and the readability is the
    // marker after it, never the word itself.
    const state = quotaAccountState(report.quota, entry.account, entry.kind === 'subscription' ? entry.pool : undefined);
    return [account, m.window ?? '-', '-', '-', '-', '-', '-', '-', `${state}${entry.readable ? '' : '  not readable from a CLI screen'}`];
  }
  const reset = m.resetsIn === null ? 'unknown' : `in ${m.resetsIn}`;
  const from = m.source === 'status_line' ? 'status line'
    : m.source === 'check' ? 'check'
      : m.source === 'cli_usage' ? 'cli usage'
        : m.source === 'machine_reading' ? 'machine reading' : 'unknown source';
  const source = m.fallback ? `${from} (fallback)` : from;
  const reserve = m.inside && m.reserve !== null ? `inside reserve ${m.reserve}%` : '-';
  // The pace where one is known; where it is not, the margin the tree reads for the same row —
  // one report, two faces, and the table never says `pace not known` beside a margin the other
  // view prints (owner, 2026-10-17). With neither, the tool's own words stand.
  const margin = m.pace === null ? marginOnRow(report.quota, entry.account, entry.kind === 'subscription' ? entry.pool : undefined, m.window) : null;
  const pace = m.other && report.view === 'restricted' ? '' : m.pace === null && margin !== null ? marginWord(margin) : paceWord(m.pace);
  // The STATE cell is the block's four words — ok, near cap, walled, unknown — with freshness as
  // the marker after them: an account at 89% used and half a window
  // ahead said `fresh` and nothing else, which is where it was read, not where it stands.
  const state = quotaStateOnRow(report.quota, entry.account, entry.kind === 'subscription' ? entry.pool : undefined, m.window)
    ?? figureState(m);
  const stale = m.state === 'stale' ? '  stale' : '';
  const cell = `${state}  ${pace}${stale}${watchOf(m, report)}`.trimEnd();
  return [account, m.window ?? '-', `${m.left}%`, `${m.used}%`, reset, reserve, provenanceOf(m, report), source, cell];
}

/** The state a row's own figure reads, when the quota block carries no window for it: fresh at
 *  `NEAR_CAP` or above is near cap, at 100 walled, anything else ok; not fresh is unknown. The
 *  margin's half-window-ahead reading is the block's (it needs the window's clock), and a block
 *  window that exists always wins through `quotaStateOnRow`. */
function figureState(m: ReportMachine): QuotaState {
  if (m.state !== 'fresh' || m.used === null) return 'unknown';
  if (m.used >= 100) return 'walled';
  return m.used >= NEAR_CAP ? 'near cap' : 'ok';
}

/** The quota state the block reads for one machine row: the same account, pool and window, and
 *  that window's own state — so a row at 89% used but half a window ahead says `near cap`, the
 *  same word the tree prints. Null when the block carries no window of that name, so the row's
 *  own figure decides (`figureState`). */
function quotaStateOnRow(
  quota: ReportQuota,
  account: string,
  pool: 'gemini' | 'claude-gpt' | undefined,
  window: string | null,
): QuotaState | null {
  for (const lab of quota.labs) {
    for (const entry of lab.accounts) {
      if (entry.account !== account || entry.pool !== pool) continue;
      const one = entry.windows.find((w) => w.window === window);
      return one === undefined ? null : windowState(one);
    }
  }
  return null;
}

/** The account's own state, for a row with no figure at all: a live wall reads `walled` even
 *  with nothing to show beside it, and an account the block does not build reads `unknown`. */
function quotaAccountState(
  quota: ReportQuota,
  account: string,
  pool: 'gemini' | 'claude-gpt' | undefined,
): QuotaState {
  for (const lab of quota.labs) {
    for (const entry of lab.accounts) {
      if (entry.account === account && entry.pool === pool) return entry.state;
    }
  }
  return 'unknown';
}

/** The margin the quota block reads for one machine row: the same account, pool and window, and
 *  a fresh figure only — the block's own staleness rule decides, so the table and the tree can
 *  never disagree about a margin. Null when the block carries none. */
function marginOnRow(
  quota: ReportQuota,
  account: string,
  pool: 'gemini' | 'claude-gpt' | undefined,
  window: string | null,
): number | null {
  for (const lab of quota.labs) {
    for (const entry of lab.accounts) {
      if (entry.account !== account || entry.pool !== pool) continue;
      const one = entry.windows.find((w) => w.window === window && !w.stale);
      if (one !== undefined) return one.margin;
    }
  }
  return null;
}

/** How a machine line says where its figure came from: the caller's own reading prints as its own
 *  seat and moment (`scout  changed 4m ago`, `status`'s own shape); another team's is that team's
 *  name when the full view allows it and `another team` when it does not. */
function provenanceOf(m: ReportMachine, report: UsageReport): string {
  if (m.observedAt !== undefined) return `read ${m.age} ago`;
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

/** A team's own row, below the machine table: the account it reads first now that the row no
 *  longer sits under the account's own line, then the team, then the figure the team's reading
 *  holds. */
function teamRowText(row: ReportTeamRow): string {
  return `  ${row.row.account}  ${row.team}  ${budgetLine(row.row).slice(row.row.account.length + 2)}  ${paceWord(row.row.pace)}${borrowedClause(row.borrowedFrom)}`;
}

function spendRowText(account: string, row: ReportSpendRow): string {
  return `  ${account}  ${row.team}  spend  ${money(row.reading.amount)} ${row.reading.currency} left  read ${row.reading.age} ago  check  ${row.reading.state}${borrowedClause(row.borrowedFrom)}`;
}

/** The borrowing clause a team's row carries: the owning entity, in the parenthesised tail the
 *  `(pool)` suffix and the watch clause already sit in, so the report stays one line per row. */
function borrowedClause(from: string | undefined): string {
  return from === undefined ? '' : `  (borrowed from ${from})`;
}

/** One `note:` line's words: an anonymized machine problem is its fixed sentence for the count,
 *  the caller's own notes are printed as they stand, and any other note is named. A note with a
 *  team's own name in its scope is named, never replaced by the counted sentence: a team whose
 *  file cannot be read prints by name (the owner's rule), and the counted sentence speaks only
 *  for the anonymous scope. A store's own message is printed as it stands for the owner; the
 *  store's fixed sentence every other caller reads is one of the counted sentences. */
function noteText(note: ReportNote): string {
  if (note.scope === 'mine') return note.why;
  // The owner's one sentence for a team whose file cannot be read is whole in `why`: the name
  // and the root it sits at are the line, so no scope stands in front of it.
  if (note.scope === 'named-team') return note.why;
  if (note.scope === 'store' && !ANON.some((one) => one.why === note.why)) return note.why;
  if (note.scope !== 'another' && note.scope !== 'usage' && note.scope !== 'store') return `${note.scope}: ${note.why}`;
  const anon = ANON.find((one) => one.why === note.why);
  if (anon !== undefined) return anon.sentence(note.count ?? 1);
  return `${note.scope}: ${note.why}`;
}
