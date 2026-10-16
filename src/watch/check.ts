// One watch check: a small module with a name, run against one seat or against the whole team.
//
// The core (pass.ts) builds one observation per seat before any check runs, and the checks only
// read it: a check that reaches for herdr, a screen or the file itself can be wrong in a way the
// observation cannot. The core owns the order the checks run in, the report-once rule, and the
// nudge; a check owns the conditions it knows and the memory slot it keeps them in.
import type { CheckOutcome } from '../budgets/run.ts';
import type { Seen } from '../budgets/readings.ts';
import type { TeamFile } from '../file/types.ts';
import type { HerdrAgent } from '../herdr.ts';
import type { ReplacedContinuity, SeatProcessVerdict } from '../launch/identity.ts';
import type { QuotaFigure } from '../profiles/quota.ts';
import type { Live } from '../status/compare.ts';
import type { SessionState } from '../state.ts';
import type { Machine } from './machine.ts';
import type { Screen } from './screen.ts';

// A report says what is. The model and launcher reports also name the restart; a report never
// starts a seat. `to` is who can act on it.
export type Report = { key: string; text: string; to: 'operator' | 'owner' };

// The one exclusive reading of a seat's screen and herdr status: a seat at a permission prompt is
// never also merely idle. `permission` covers a permission or trust screen; `question` a question
// the agent asked; `vendor notice` the CLI's own captured notice; `blocked` a herdr status the
// screen doesn't explain; `unknown` a herdr status the watch doesn't know.
export type Attention = 'permission' | 'question' | 'vendor notice' | 'blocked' | 'unknown' | null;

// A seat's history, kept by the core across passes: what the idle clock counts from.
export type SeatHistory = {
  // When the seat was last seen working — herdr said working, or its screen showed a running turn.
  lastWorking: number | undefined;
  // When the watch first saw the seat quiet with no work behind it.
  idleSince: number | undefined;
};

// Everything a seat check may read about the seat it is handed. One is built per seat per pass,
// before any check runs; a check never reads the live team itself.
export type SeatObservation = {
  name: string;
  // The seat the file declares; undefined for a temporary seat, which signs with no file model.
  seat: { cli: string; model: string; version: string; display: string } | undefined;
  // The agent herdr lists for the seat; undefined when no agent answers for it.
  agent: HerdrAgent | undefined;
  // Whether the session answered at all: false is every seat absent for the same reason.
  herdr: boolean;
  screen: Screen;
  cli: string;
  // The model's maker: the file's seat vendor, or the one a temporary seat is like. For the
  // ceilings, and the model a seat was declared to run; the budget's account is `account` below.
  vendor: string;
  // The account whose budget this seat spends (RFC 0003 § 3b): its own `account:` when the file
  // names one, its vendor when it does not, and the seat it is like for a temporary one. ''
  // when neither says.
  account: string;
  // The quota figures the seat's screen showed (RFC 0003 § 4.1), parsed by the core so a
  // check never reads a screen. Empty for a seat that is not running, or shows none.
  quota: QuotaFigure[];
  // What the recorded process identity says of the pane the seat answers in: `same` while the
  // process team launched is still there, `gone` for a pane back at its shell, `replaced` for
  // one held by a process team did not launch, and `unknown` when herdr can't tell or the seat
  // was launched before the identity was recorded — treated as today everywhere.
  identity: SeatProcessVerdict;
  // The launch line starts a program other than the CLI's own binary, or the file says the
  // launcher chooses the model. A temporary seat has no launch line.
  launcher: boolean;
  // `restored` when a pid mismatch still carries the agent session stored at launch.
  // The restored check stays quiet for it. `doubt` is a mismatch the session does not tie.
  continuity: ReplacedContinuity;
  // Whether an agent answers for the seat. False: the seat's own checks never run.
  running: boolean;
  // The stage the session state records, when it records one. `named` and `ready` mean the
  // seat was running even when this pass sees no agent.
  recorded: 'launched' | 'named' | 'ready' | undefined;
  quiet: boolean;
  working: boolean;
  prompt: boolean;
  // The orchestrator and the operator: the leads, which are reported on but not counted idle.
  lead: boolean;
  // Parked or stopped: watched for attention, unsent text and model drift; idle is skipped.
  parked: boolean;
  stopped: boolean;
  attention: Attention;
  // The model the seat's screen shows it running, when it has a file seat and the screen says.
  model: { model: string; version: string } | null;
  history: SeatHistory;
};

// Everything a team check may read about the team it is handed, built after the seat loop.
export type TeamObservation = {
  // The file, and the session's state: the budget check (RFC 0003 § 9) reads both.
  team: TeamFile;
  state: SessionState;
  live: Live;
  // This pass's machine figures, and the file's thresholds to read them against.
  machine: Machine;
  limits: TeamFile['machine'];
  seats: SeatObservation[];
  // The panes the file's seats answer for: an agent in none of them is extra.
  known: Set<string>;
  // The seats that count as the team's workers (not the leads, not parked), and their idle flag.
  workers: { idle: boolean }[];
  // How the file differs from the last approval: [] none, null never approved, undefined unlooked.
  approval: string[] | null | undefined;
  // The one-line case when no verified approval is in force and the record says why — a legacy
  // record, or one the verification refused. The watch itself has said it; the check stays silent.
  approvalReason: string | null | undefined;
  // The readings that count this pass (§ 4.3): the state's, with the seats' figures folded in.
  readings: Seen[];
  // What each checked account's command read this pass, or why it has none (§ 5).
  outcomes: readonly CheckOutcome[];
};

// What every check is handed: the pass's clock, the watch and budget sections in force, the
// report-once rule, and the check's own memory.
export type CheckContext = {
  now: number;
  // The `watch` section in force: the thresholds the checks report against.
  watch: TeamFile['watch'];
  // The `budgets` section in force: the accounts, marks and thresholds the checks read against.
  budgets: TeamFile['budgets'];
  // The report-once rule. The key goes into this pass's active set; the report comes back the
  // first time and is null while the condition holds. Cleared conditions clear themselves: a
  // check that stops calling `once` for a key drops it from the set at the end of the pass.
  once(key: string, text: string, to?: Report['to']): Report | null;
  // Keeps a key in the active set without reporting, for a pass whose reading is no change:
  // a check that read `unknown` (herdr can't tell) calls this, so the next pass that can read
  // again doesn't report what it already reported. A key that was not active stays inactive.
  keep(key: string): void;
  // The check's own slot, under a kind of its own (`idle`, `unsent`, `team-idle`, `swap-growth`).
  // Created by `start` on first use; kept across passes. Two checks must not share a kind.
  memory<T>(kind: string, start: () => T): T;
};

export interface SeatCheck {
  name: string;
  run(seat: SeatObservation, ctx: CheckContext): Report[];
}

export interface TeamCheck {
  name: string;
  run(team: TeamObservation, ctx: CheckContext): Report[];
}

// Every check there is, in the order the core runs them: the seat checks first, then the team
// checks. The order decides the order of the lines in the log, nothing else.
export const CHECK_NAMES = [
  'missing',
  'restored',
  'model-drift',
  'attention',
  'provider-error',
  'unsent',
  'idle',
  'extra',
  'team-idle',
  'approval',
  'load',
  'memory',
  'disk',
  'swap-free',
  'swap-growth',
  'budget',
] as const;

// The checks the file cannot turn off (RFC 0002 § 4.2): the four whose condition is the one thing
// the watch exists for. The schema refuses them in `watch.checks`, and the pass runs them
// whatever the list says.
export const ALWAYS_ON: readonly string[] = ['attention', 'missing', 'model-drift', 'approval'];

/** A duration in whole minutes, as the report texts write it. */
export function minutes(ms: number): number {
  return Math.floor(ms / 60_000);
}

/** The report `ctx.once` may have made, as the list `run` returns. */
export function reported(report: Report | null): Report[] {
  return report ? [report] : [];
}
