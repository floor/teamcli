// One pass of the watch: the core. It builds one observation per seat before any check runs,
// runs the registered checks in the order it owns, applies the report-once rule, and names the
// work drops and the ring. A check never reads herdr, a screen or the file itself — only the
// observation it is handed (RFC 0002 § 4.2).
import { observe, observeCheck, type Seen } from '../budgets/readings.ts';
import type { CheckOutcome } from '../budgets/run.ts';
import { CLIS } from '../clis.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { labOfRunningModel, payingAccountOf, payingPoolOf } from '../information/machine-accounts.ts';
import type { MachineFigure } from '../information/machine-readings.ts';
import type { PaneProcesses } from '../herdr.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
import { boxHoldsText } from '../launch/deliver.ts';
import { replacedSeat, seatProcessVerdict } from '../launch/identity.ts';
import { continuitySessionOf } from '../registry/resume.ts';
import { usesLauncher } from '../launch/line.ts';
import { herdrUnreliable, profileFor, quotaFor as shippedQuota } from '../profiles/profile.ts';
import { figuresOf, type QuotaFigure, type QuotaPattern } from '../profiles/quota.ts';
import { livenessOf, type LivenessThresholds, type SettingLevel, type StateThresholds } from '../settings/inherit.ts';
import { stateThresholds, thresholdRefusals, type ThresholdRefusal } from '../settings/resolve.ts';
import { watchWords } from '../settings/declared.ts';
import type { Tempo } from '../file/sections/tempo.ts';
import { pauseText, type PauseRecord, type SessionState } from '../state.ts';
import type { Live } from '../status/compare.ts';
import { workspaceLabel } from '../file/sections/seats.ts';
import { runningModel, seatModel } from '../status/statusline.ts';
import { liveDisplayAgent } from './seat-label.ts';
import {
  ALWAYS_ON,
  type Attention,
  type CheckContext,
  type ModelRulePass,
  type PaneModelReading,
  type Report,
  type SeatCheck,
  type SeatHistory,
  type SeatObservation,
  type TeamCheck,
  type TeamObservation,
} from './check.ts';
import { minutes } from './check.ts';
import { attention } from './checks/attention.ts';
import { providerError } from './checks/provider-error.ts';
import { approval } from './checks/approval.ts';
import { budget } from './checks/budget.ts';
import { disk } from './checks/disk.ts';
import { extra } from './checks/extra.ts';
import { idle } from './checks/idle.ts';
import { load } from './checks/load.ts';
import { memory as memoryCheck } from './checks/memory.ts';
import { missing } from './checks/missing.ts';
import { modelDrift } from './checks/model-drift.ts';
import { modelRule } from './checks/model-rule.ts';
import { promptEscalation } from './checks/prompt-escalation.ts';
import { restored } from './checks/restored.ts';
import { swapFree } from './checks/swap-free.ts';
import { swapGrowth } from './checks/swap-growth.ts';
import { idleQueueSummary, teamIdle } from './checks/team-idle.ts';
import type { QueueDepths } from '../queues.ts';
import { unsent } from './checks/unsent.ts';
import type { Machine } from './machine.ts';
import { readScreen, statusRow, type Screen } from './screen.ts';
export {
  classifyPromptKind,
  createSeatStatusEngine,
  herdrStatusSource,
  isScreenVerifiedStatusCli,
  isStatusWaiterSeat,
  reconcileStatusWithScreen,
  seatHasAssignedWorkOnDisk,
  shouldReadScreenForStatus,
  waitAgentStatus,
  type EmittedStatusEvent,
  type HerdrAgentStatus,
  type PromptKind,
  type SeatStatusEngine,
  type SeatStatusEngineInput,
  type SeatStatusStep,
  type SeatStatusWaitStep,
  type StatusSource,
  type StatusTarget,
  type StatusWaitResult,
  type StatusWaitSeat,
} from './status-events.ts';

// What the watch remembers between passes. It lives in the watch's process: a restarted watch
// starts its timers again, and reports again what is still true.
export type Memory = {
  // The seats' shared history, per seat name: the clock the idle check counts from.
  history: Record<string, SeatHistory>;
  // Each check's own slot, by kind. The core keeps them; no check reads another's.
  slots: Record<string, unknown>;
  // Conditions that were reported and have not cleared since.
  active: Set<string>;
  // The active conditions a check did not report on the last pass. One unseen pass is forgiven
  // — a screen can flicker — and a second one in a row drops the condition, so it reports again
  // only after it has genuinely cleared.
  grace: Set<string>;
  // The line this watch typed itself and has not seen sent, recorded at the typing: the pane,
  // and the exact text. Only this record — never the text alone — can make an unsent box the
  // watch's own, and it lives in this process: a restarted watch has none, and text it did not
  // type is left as its owner left it.
  ownNudge: { pane: string; text: string } | null;
  // `${recipient}/${id}` this process has already told the owner about. Two seats can hold the
  // same id. A restarted watch has none, so an old unacked record is said again; a receipt
  // takes the record off the list.
  mailboxTold: Set<string>;
  // Sidebar lines this process has pushed, and the last effort word a screen showed. `title`
  // and `line` are written only after herdr accepts the call. `effort` is the word last seen,
  // which a screen that shows none does not clear. A restarted watch has none, so the first
  // cycle paints every running seat again.
  seatLabels: Record<string, { title?: string; line?: string; effort?: string }>;
};

export function newMemory(): Memory {
  return {
    history: {}, slots: {}, active: new Set(), grace: new Set(), ownNudge: null, mailboxTold: new Set(),
    seatLabels: {},
  };
}

/** Whether a box, already read as unsent, holds this watch's own line: this process recorded
 *  typing exactly this text into this same pane, and the box still holds it. The record is the
 *  identity — the same text typed by anyone else, or found after a restart, is theirs. */
export function ownUnsent(memory: Memory, pane: string, text: string, cli: string, screen: string | undefined): boolean {
  return memory.ownNudge !== null && memory.ownNudge.pane === pane && memory.ownNudge.text === text
    && boxHoldsText(cli, text, screen);
}

export type { Report } from './check.ts';

// The default body of a work drop, when the file sets no `watch.nudge`: what the seat reads from
// the drop file. It is never typed into a pane, and it is not the report line — reports go to the
// log and to the desktop notification, and no report text is ever put in front of a seat the
// report does not concern.
export const NUDGE_TEXT = 'Team watch: reports are waiting in .agents/team.log';

/** The shipped nameless ring line, used only when a record's sender cannot be named: the seat
 *  reads its own folder. A named record rings with the `message-display` line instead. */
export function ringText(seat: string, session: string): string {
  return `Team: run team drops --read --seat ${seat} --session ${session}`;
}

/** One unacked message the watch has already verified, joined to the seat's pane when it has one.
 *  `text` is the line the ring types: the message's `message-display` header and the fixed read
 *  hint, built once for the oldest waiting record. */
export type MailboxWaiting = {
  id: string;
  to: string;
  at: number;
  pane: string | null;
  status: string | null;
  cli: string;
  screen: string | undefined;
  /** Whether the reader the ring names — the seat's own `team drops --read` — would serve this
   *  record. A record waiting in the older mailbox store (`.agents/messages/<seat>`) waits for
   *  `team messages`, not for the drop read, so it can raise the owner's waiting note but is
   *  never rung: the line would name a read that serves nothing, and it would fire every pass. */
  served: boolean;
  /** The line the ring types: the record's message-display header, then the fixed read hint.
   *  Absent, the shipped nameless ring. */
  text?: string;
};

export type PassResult = {
  queueSummary?: { key: string; text: string } | null;
  reports: Report[];
  // One drop per idle worker that has reached `idle_first`, and again every `idle_repeat`
  // when that is set. `body` is `watch.nudge`, or the fixed line when the file omits it.
  // The command writes the drop and types the short trigger; this pass types nothing.
  work: { pane: string; seat: string; cli: string; body: string }[];
  // The one line to type when a message is waiting for a free seat.
  ring: { pane: string; text: string; cli: string; to: string; id: string } | null;
  // One owner line when an unacked message is older than `nudge_wait` and its box is not free.
  mailboxNote: string | null;
  // The readings that count, to be saved: the project's, with this pass's figures folded in (§ 4.4).
  readings: Seen[];
  machineReadings: MachineFigure[];
  // Sidebar lines to push for running file seats. The pass does not call herdr: the command
  // does, and records `title` and `line` only after the call returns true. A seat with neither
  // half changed is absent.
  labels: { name: string; pane: string; workspace: string; title?: string; displayAgent?: string }[];
  // Liveness words the chain set aside, each with the rule it broke. Not reports: they are
  // configuration facts, said once by the command, never nudged into a seat.
  refusals: ThresholdRefusal[];
};

// The seat checks, in the order their reports land in the log; the team checks, after them. The
// order is the core's: a seat's wrong model is reported before its permission prompt, and every
// seat before the team. Disabling a check in the `watch` section in force takes it out of the
// run, except the six that can't be turned off.
export const SEAT_CHECKS: SeatCheck[] = [missing, restored, modelDrift, modelRule, attention, providerError, unsent, idle];
export const TEAM_CHECKS: TeamCheck[] = [extra, teamIdle, promptEscalation, approval, load, memoryCheck, disk, swapFree, swapGrowth, budget];

// The one exclusive reading of a seat's screen and herdr status. herdr can report a seat at a
// permission prompt as idle, so the screen decides first. `team check` reads it too, over a pane
// the state records for a seat of this team: one reading, two readers, and no second rule.
// `theirWord` is a profile herdr cannot report: the screen alone is the reading there, so an idle
// table, a running turn or a limit the CLI draws itself is never "herdr's word is unknown", and
// only a screen no profile reads is.
export function attentionOf(screen: Screen, status: string, quiet: boolean, theirWord = false): Attention {
  if (screen.kind === 'permission' || screen.kind === 'trust') return 'permission';
  if (screen.kind === 'question' || screen.kind === 'exit question') return 'question';
  if (screen.kind === 'vendor notice') return 'vendor notice';
  if (theirWord) return screen.kind === 'unknown' ? 'unknown' : null;
  if (status === 'blocked') return 'blocked';
  // A quiet seat on a screen no profile reads is not "nothing to report": it is the shape a
  // stalled seat leaves — herdr says idle or done, and nothing may ever free it. The report is
  // the watch's existing unknown, which quotes herdr's word rather than vouching for it; a
  // classify-miss must not go silent, and nothing is typed either way.
  if (quiet && screen.kind === 'unknown') return 'unknown';
  if (!quiet && status !== 'working') return 'unknown';
  return null;
}

// The figures off a seat's own pane: only a composer screen — idle, unsent or working — shows a
// status row at all, and only that row's line is read. A dialog, a question, a trust screen or an
// unknown one gives no figures, and neither does a line the seat printed or typed. And only a
// pane where herdr reports the seat's CLI still running: a shell's last row is a last row by
// position, not a status row, and a pane herdr could not read gives none either — no figure is
// invented where the CLI was not seen. (`down` and `remove` read that same null the other way at
// their departure wait; not knowing must not end a wait.)
function quotaOf(cli: string, screen: Screen, pane: string | undefined, runs: boolean, patterns: readonly QuotaPattern[]): QuotaFigure[] {
  if (pane === undefined || !runs) return [];
  if (screen.kind !== 'idle' && screen.kind !== 'unsent' && screen.kind !== 'working') return [];
  return figuresOf(patterns, statusRow(cli, pane));
}

// What one pass is handed: the file, the session, the observed world, the clock, the watch's
// memory, and what the caller knows that the world does not. `approval` says whether a record is
// in force — [] under a verified standing, null when there is none, undefined when that wasn't
// looked at — and nothing compares the file against it: the live file is the record. `watch` and
// `budgets` are the sections in force — the live file's under a verified standing, the defaults
// under none — and the checks read those, never the file's.
// `outcomes` is what the accounts' check commands read outside the pass, when the watch last ran
// them. `readings` is the project's stored cache, recalled by the caller; this pass folds its
// figures into it, whatever session they were seen in (§ 4.4). `foreground` is herdr's
// process-info per pane: the pane's foreground process names, or null where herdr could not be
// read. Only a pane it reports the seat's CLI in gives a figure — a null, or a pane the map
// doesn't hold, gives none; the departure wait (`paneStillRunning`) reads that same null the
// other way, keeping its wait.
export type PassInput = {
  team: TeamFile;
  state: SessionState;
  live: Live;
  machine: Machine;
  now: number;
  memory: Memory;
  queueDepths?: QueueDepths | null;
  /** Unclaimed items in the queue directory's backlog file, read beside the depths. */
  queueBacklog?: number | null;
  approval?: string[] | null;
  // The case in one line when no verified approval is in force and the record says why. The
  // watch says it itself, once; the pass's approval check reads it and adds nothing.
  approvalReason?: string | null;
  watch: TeamFile['watch'];
  // The liveness words of the levels above the team, already read: the machine's settings file,
  // the entity's and the project's records. The team's own words come from `watch` — its
  // `idle_first`, `idle_owner` and `blind_after` — and the seat's from its file entry; a caller
  // never repeats those here.
  liveness?: Partial<Record<SettingLevel, Partial<StateThresholds> | undefined>>;
  /** The team's own liveness words from the watch section as written, before `tempo` scaled it.
   *  Omitted, they are read from `watch` itself. */
  livenessTeam?: Partial<StateThresholds>;
  /** The tempo in force. It scales the idle window after the tighten-only check, so a longer
   *  tempo word is the owner's dial on the timing, never a team's loosening. */
  tempo?: Tempo;
  outcomes?: readonly CheckOutcome[];
  budgets?: TeamFile['budgets'];
  readings?: readonly Seen[];
  /** Machine subscriptions observed without adding a launch budget. */
  machineAccounts?: readonly string[];
  foreground?: Readonly<Record<string, readonly string[] | null>>;
  // Each pane's process identity, by pane id, as the caller read it — null where herdr can't
  // tell, and absent for a pane it wasn't read for. A seat's recorded identity is compared with
  // its pane's reading: `gone`/`replaced` is no longer the seat. A null, or a pane the map
  // doesn't hold, is exactly a seat with no record: the restored check reports nothing.
  processes?: Readonly<Record<string, PaneProcesses | null>>;
  /** Registry signing model/version by seat; null means no current registry record. */
  signing?: ReadonlyMap<string, { model: string; version: string } | null>;
  /** The continuity each declared seat's records bind, by seat: the registry's session where a
   *  record exists, the state's own copy where none does, null where a record refuses. A caller
   *  that read no registry leaves it out, and the state's copy stands. */
  continuityIds?: ReadonlyMap<string, string | null>;
  /** Screen readings with the approved overrides applied. The shipped profiles, when omitted. */
  readScreen?: (cli: string, screen: string | undefined) => Screen;
  /** The seats this pass must not type at or count idle: their native presence proves a turn, a
   *  person wait or a session end, or the record or channel cannot be trusted. Absent, the screen
   *  classification is exactly the one a watch without the native store makes. */
  nativeHeld?: ReadonlySet<string>;
  /** Quota patterns in force, shipped plus the approved override. The shipped list, when omitted. */
  quotaFor?: (cli: string) => readonly QuotaPattern[];
  /** The entity model rule as the caller read it once for this pass. Omitted or null, no rule is
   *  in force; a refusal is said once, to the owner. The pass never reads the entity's files. */
  modelRule?: ModelRulePass;
  /** Unacked messages already verified. Omitted, the pass rings nothing. */
  mailbox?: readonly MailboxWaiting[];
  /**
   * The team's pause, when one stands. It replaces the work nudges of this pass with one notice
   * per non-human seat: the team is stopped, finish the step in hand and take nothing new. A
   * human seat's pane is never typed into, exactly as it is never nudged.
   */
  pause?: PauseRecord | null;
  /**
   * The seats paused on their own with `team pause <seat>`, keyed by name. They are skipped by
   * the work nudges exactly as a human seat is — the rest of the team keeps its nudges. The
   * team's pause, when it stands too, is still the one notice every seat gets.
   */
  seatPauses?: Readonly<Record<string, PauseRecord>> | null;
};

// One pass of the watch. Pure: it reads what it is handed and changes only `memory`.
export function pass({
  team,
  state,
  live,
  machine,
  now,
  memory,
  queueDepths,
  queueBacklog,
  approval,
  approvalReason,
  watch,
  liveness: declaredLiveness,
  livenessTeam,
  tempo = 'normal',
  outcomes = [],
  budgets = team.budgets,
  readings: stored = [],
  machineAccounts = [],
  foreground,
  processes,
  signing,
  continuityIds,
  readScreen: read = readScreen,
  nativeHeld,
  quotaFor: patternsOf = shippedQuota,
  mailbox = [],
  pause,
  seatPauses = null,
  modelRule: rule = null,
}: PassInput): PassResult {
  const reports: Report[] = [];
  const current = new Set<string>();
  // Reported when it starts, and again only after it has cleared. Clearing is judged at the end
  // of the pass, with one pass of grace: a condition the check does not report on stays active
  // through that pass, and only two in a row drop it.
  const once = (key: string, text: string, to: Report['to'] = 'operator'): Report | null => {
    current.add(key);
    return memory.active.has(key) ? null : { key, text, to };
  };
  // A reading herdr can't give is no change: `keep` carries an active key through a pass that
  // could not read, so the next pass that can read again doesn't report what it already
  // reported. A key that was not active is not made active — nothing has been reported yet.
  const keep = (key: string): void => {
    if (memory.active.has(key)) current.add(key);
  };

  const known = new Set<string>();
  const workers: { idle: boolean }[] = [];
  const observations: SeatObservation[] = [];
  const labels: PassResult['labels'] = [];

  // A stopped seat is kept in the file and not started; should its owner start one by hand, herdr
  // shows it running, and the watch gives it a parked seat's treatment: attention (permission,
  // trust, question, blocked) and unsent text are reported, idle is not — and it is never an agent
  // the file doesn't hold. A stopped seat that is not running is the normal state, and draws nothing.
  const seats = [
    ...team.seats.map((seat) => ({
      name: seat.name,
      cli: seat.cli,
      vendor: seat.vendor,
      account: seat.account ?? seat.vendor,
      parked: seat.parked || seat.stopped,
      stopped: seat.stopped,
      seat,
    })),
    ...Object.entries(state.seats).filter(([, recorded]) => recorded.temporary).map(([name, recorded]) => {
      // A temporary seat signs like the seat it is like: its CLI, and its account.
      const like = team.seats.find((seat) => seat.name === recorded.temporary?.like);
      return {
        name,
        cli: like?.cli ?? '',
        vendor: like?.vendor ?? '',
        account: like?.account ?? like?.vendor ?? '',
        parked: false,
        stopped: false,
        seat: undefined,
      };
    }),
  ];

  // The team's own word is the section in force minus the values that section ships: a default
  // the file never wrote is no declaration, and passing it would make a tighter word above look
  // like a loosening attempt. Each seat resolves the same chain with its own word on top, and
  // every word the chain set aside is collected once, however many seats repeat it.
  const teamWords = livenessTeam ?? watchWords(watch);
  const above = declaredLiveness ?? {};
  const refused: ThresholdRefusal[] = [];
  const toldRefusals = new Set<string>();
  const factor = tempo === 'relaxed' ? 2 : tempo === 'urgent' ? 0.5 : 1;
  const limitsFor = (seat: Seat | undefined): LivenessThresholds => {
    const chain = { ...above, team: teamWords, ...(seat?.liveness !== undefined ? { seat: seat.liveness } : {}) };
    for (const refusal of thresholdRefusals(chain)) {
      const key = `${refusal.setting}:${refusal.level}:${refusal.value}`;
      if (toldRefusals.has(key)) continue;
      toldRefusals.add(key);
      refused.push(refusal);
    }
    const resolved = livenessOf(stateThresholds(chain));
    // `tempo` is the owner's dial on how fast the watch runs, applied to the window the chain
    // resolved: a longer word here is not a level loosening a threshold, and `relaxed` still
    // slows the idle nudge while `urgent` quickens it.
    if (factor === 1) return resolved;
    return { ...resolved, idle_lead_seconds: Math.max(1, Math.round(resolved.idle_lead_seconds * factor)) };
  };

  for (const { name, cli, vendor, account, parked, stopped, seat } of seats) {
    const liveness = limitsFor(seat);
    const agent = live.agents.find((candidate) => candidate.name === name);
    const lead = name === team.orchestrator || name === team.operator;
    if (!agent) {
      delete memory.history[name];
      delete memory.seatLabels[name];
      observations.push({
        name,
        seat,
        rule: rule !== null && rule.ok ? rule.breaches.get(name) : undefined,
        agent: undefined,
        herdr: live.running,
        screen: { kind: 'unknown' },
        cli,
        vendor,
        account,
        quota: [],
        identity: 'unknown',
        launcher: false,
        continuity: 'other',
        running: false,
        recorded: state.seats[name]?.stage,
        quiet: false,
        working: false,
        prompt: false,
        lead,
        parked,
        stopped,
        attention: null,
        model: null,
        history: { lastWorking: undefined, idleSince: undefined },
        liveness,
      });
      continue;
    }
    known.add(agent.pane);
    const pane = live.screens[agent.pane];
    const screen = read(cli, pane);
    // Herdr's word, unless the profile says herdr cannot report this CLI: its own screen is the
    // reading there, and the two states `team` types into are an idle table and a composer
    // holding text. A screen it cannot read is not quiet.
    const theirWord = herdrUnreliable(cli);
    // A seat the native store holds is not quiet, whatever the screen still shows: the store
    // proved a turn, a person wait, a session end, or a projection this pass cannot trust.
    const nativeBusy = nativeHeld?.has(name) === true;
    const quiet = !nativeBusy && (theirWord
      ? screen.kind === 'idle' || screen.kind === 'unsent'
      : agent.status === 'idle' || agent.status === 'done');
    // Working is herdr's word or the screen's: a seat mid-turn is never idle, whatever its
    // status says.
    const working = agent.status === 'working' || screen.kind === 'working';
    const prompt = screen.kind === 'permission' || screen.kind === 'trust' || screen.kind === 'question' || screen.kind === 'exit question' || screen.kind === 'vendor notice' || screen.kind === 'provider error' || screen.kind === 'rate limit';
    if (!lead && !parked) workers.push({ idle: quiet && !working && !prompt });

    // The history the idle clock counts from. A seat seen working starts it again; a seat quiet
    // with no work behind it was already idle when the watch started, and counts from then. A
    // native non-idle reading restarts the clock the same way without claiming the seat is
    // working to any consumer: the next idle stretch counts from the last moment it was not idle.
    const history = (memory.history[name] ??= { lastWorking: undefined, idleSince: undefined });
    if (nativeBusy) {
      history.lastWorking = now;
      delete history.idleSince;
    } else if (working) {
      history.lastWorking = now;
      delete history.idleSince;
    } else if (quiet && !prompt && !lead && !parked && history.lastWorking === undefined) {
      history.idleSince ??= now;
    }

    const verdict = seatProcessVerdict(state.seats[name]?.launched, processes?.[agent.pane] ?? null);
    observations.push({
      name,
      seat,
      ...(signing === undefined ? {} : { signing: signing.get(name) ?? null }),
      rule: rule !== null && rule.ok ? rule.breaches.get(name) : undefined,
      agent,
      herdr: live.running,
      screen,
      cli,
      vendor,
      account,
      quota: quotaOf(cli, screen, pane, reportedLiveAgent(foreground?.[agent.pane] ?? null, profileFor(cli)?.processNames ?? []), patternsOf(cli)),
      identity: verdict,
      launcher: seat ? usesLauncher(seat) : false,
      continuity: replacedSeat(verdict, {
        asked: true,
        namedOnPane: state.seats[name]?.pane === agent.pane,
        recordedSession: continuitySessionOf(continuityIds, name, state.seats[name]?.agent_session),
        liveSession: agent.session,
      }),
      running: true,
      recorded: state.seats[name]?.stage,
      quiet,
      working,
      prompt,
      lead,
      parked,
      stopped,
      attention: attentionOf(screen, agent.status, quiet, theirWord),
      model: seat
        ? signing?.get(name)
          ? runningModel(seat.cli, live.screens[agent.pane] ?? '')
          : seatModel(seat, live.screens[agent.pane])
        : null,
      history: { lastWorking: history.lastWorking, idleSince: history.idleSince },
      liveness,
    });
    if (seat) labels.push(...labelOf(seat, agent.pane, agent.workspace, live.screens[agent.pane], memory));
  }

  // The figures this pass saw, folded into the readings the project keeps (§ 4.3, § 4.4). Only an
  // account whose `sources` name `status_line` takes a screen reading: a check-only account never
  // records one here, and neither does an account the budgets in force don't name (#50). A figure
  // names the account its pattern measures (§ 3b): one that measures this seat's vendor is this
  // seat's account — its own `account:` when the file names one, so two accounts of one vendor
  // keep two buckets — while a figure on another account (a launcher showing the vendor it really
  // runs on) stays that account's, whichever seat's screen showed it.
  //
  // The live file is the record: a seat's figures fold under the account the file names now,
  // and a change since the last approval holds no seat's figures back. A running seat's figure
  // is also folded into the machine's own observations, under the account that pays for it.
  const machineReadings: MachineFigure[] = [];
  let readings = stored.slice();
  for (const seat of observations) {
    if (!seat.running) continue;
    const declared = team.seats.find((one) => one.name === seat.name)
      ?? team.seats.find((one) => one.name === state.seats[seat.name]?.temporary?.like);
    for (const figure of seat.quota) {
      const payer = declared === undefined ? seat.account : payingAccountOf(declared);
      const backing = declared === undefined ? seat.vendor : payingAccountOf({ ...declared, account: undefined });
      const account = figure.account === backing ? payer : figure.account === seat.vendor ? seat.account : figure.account;
      if (declared && seat.identity !== 'gone' && seat.identity !== 'replaced') {
        const pool = payingPoolOf(declared);
        // The figure is stored under the account it MEASURES, never under the account that pays
        // the seat: a DeepSeek seat on Claude Code shows the Claude subscription's own L:/W:
        // bar, and that bar is Anthropic's reading. Storing it under the paying account is what
        // made the report read another subscription's figure as DeepSeek's (owner, 2026-10-17).
        machineReadings.push({ ...figure, account, ...(pool ? { pool } : {}) });
      }
      const entry = budgets.accounts[account];
      if (entry !== undefined ? entry.sources.includes('status_line') : machineAccounts.includes(account) && (figure.account === backing || figure.account === payer)) {
        readings = observe(readings, { ...figure, account }, seat.name, now);
      }
    }
  }
  // A check reading lands in the same slot (§ 5): what an approved check read outlives the watch,
  // so `up` and `add` count it after the watch has exited. Only an account whose sources name
  // `check`, and only when its check actually read this pass.
  for (const outcome of outcomes) {
    if (outcome.state !== 'read' || outcome.reading.kind !== 'subscription') continue;
    if (!budgets.accounts[outcome.account]?.sources.includes('check')) continue;
    readings = observeCheck(readings, outcome.account, outcome.reading.windows);
  }

  // The model every pane outside the file shows, where a shipped profile reads one. The lab is
  // the one the pane's own model line names, never the CLI's name (the owner's rule); a pane no
  // profile's process names claim, or whose screen names no maker, stays unread — the extra
  // check reports it as it always did and judges no rule on it.
  const paneModels = new Map<string, PaneModelReading>();
  for (const agent of live.agents) {
    if (known.has(agent.pane)) continue;
    const names = foreground?.[agent.pane] ?? null;
    const cli = CLIS.find((name) => reportedLiveAgent(names, profileFor(name)?.processNames ?? []));
    if (cli === undefined) continue;
    const running = runningModel(cli, live.screens[agent.pane] ?? '');
    if (running === null) continue;
    const lab = labOfRunningModel(`${running.model} ${running.version}`);
    if (lab === undefined) continue;
    paneModels.set(agent.pane, { model: running.model, version: running.version, lab });
  }

  const teamObservation: TeamObservation = {
    queueDepths,
    queueBacklog,
    team,
    state,
    live,
    machine,
    limits: team.machine,
    seats: observations,
    known,
    modelRule: rule,
    paneModels,
    workers,
    approval,
    approvalReason,
    readings,
    outcomes,
  };

  const ctx: CheckContext = {
    now,
    watch,
    budgets,
    once,
    keep,
    memory: <T>(kind: string, start: () => T): T => {
      if (!Object.hasOwn(memory.slots, kind)) memory.slots[kind] = start();
      return memory.slots[kind] as T;
    },
  };

  // The four § 4.2 keeps out of `watch.checks` run whatever the list says: the validation refuses
  // them, and this holds even for a file that reached memory another way.
  //
  // The off list is the section in force, which the caller passes as `watch`. A file with a
  // record in force — `approval` is a list, empty or not — runs that list, edited or not: the
  // live file is the record. A file with no record, or one whose record was not looked at,
  // turns nothing off.
  const off = Array.isArray(approval) ? new Set(watch.checks) : new Set<string>();
  const enabled = (name: string) => ALWAYS_ON.includes(name) || !off.has(name);
  for (const seat of observations) {
    for (const check of SEAT_CHECKS) if (enabled(check.name)) reports.push(...check.run(seat, ctx));
  }
  for (const check of TEAM_CHECKS) if (enabled(check.name)) reports.push(...check.run(teamObservation, ctx));

  // A rule that cannot be read is said once, to the owner, and no breach is judged: an
  // unreadable rule must never read as a rule every seat satisfies. `team check` says the same
  // sentence for the same refusal.
  if (rule !== null && !rule.ok) {
    const report = once('model-rule:unreadable', `the entity model rule cannot be read, so no breach is judged: ${rule.why}`, 'owner');
    if (report) reports.push(report);
  }

  // One pass of grace for an attention key that stops being named: a screen can flicker, and a
  // report for every flicker is noise. An attention key stays active through the first pass that
  // does not name it, and two in a row drop it — so a flicker reports once, and a condition that
  // really cleared reports again when it comes back. Every other key keeps the drop-on-first-
  // clear rule, and a check turned off drops its keys at once. A key `keep` carried through an
  // unreadable pass is named above, and that clears its grace.
  const attentionKeys: [prefix: string, check: string][] = [
    ['blocked:', 'attention'],
    ['question:', 'attention'],
    ['vendor notice:', 'attention'],
    ['unknown:', 'attention'],
    ['unsent:', 'unsent'],
  ];
  const flickers = (key: string): boolean =>
    attentionKeys.some(([prefix, check]) => key.startsWith(prefix) && enabled(check));
  const next = new Set(current);
  const grace = new Set<string>();
  for (const key of memory.active) {
    if (current.has(key) || memory.grace.has(key) || !flickers(key)) continue;
    next.add(key);
    grace.add(key);
  }
  memory.active = next;
  memory.grace = grace;

  // The ring is typed only when this pass types no work drop. The record stays: the receipt is
  // what clears it.
  let ring: PassResult['ring'] = null;
  let mailboxNote: string | null = null;
  const ordered = [...mailbox].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const record of ordered) {
    const screen = record.pane ? read(record.cli, record.screen) : null;
    // The receiver's own line: its message's header and the fixed read hint, the same words the
    // typed wake uses. The record stays: the receipt is what clears it.
    const text = record.text ?? ringText(record.to, team.session);
    const mine = record.pane !== null && screen?.kind === 'unsent'
      && ownUnsent(memory, record.pane, text, record.cli, record.screen);
    // A held seat's record is not rung: a native turn, a person wait, a session end or an
    // unproven projection outranks the idle screen the mailbox record carries.
    const held = nativeHeld?.has(record.to) === true;
    const free = !held && record.pane !== null && (record.status === 'idle' || record.status === 'done')
      && (screen?.kind === 'idle' || mine);
    if (free && record.served && ring === null && record.pane !== null) {
      ring = { pane: record.pane, text, cli: record.cli, to: record.to, id: record.id };
      continue;
    }
    const toldKey = `${record.to}/${record.id}`;
    if (!free && mailboxNote === null && now - record.at >= watch.nudgeWait * 1000 && !memory.mailboxTold.has(toldKey)) {
      mailboxNote = `message ${record.id} for ${record.to} has been waiting ${minutes(now - record.at)} minutes`;
      memory.mailboxTold.add(toldKey);
    }
  }
  return {
    reports,
    ...(queueDepths ? { queueSummary: enabled('team-idle') ? idleQueueSummary(teamObservation) : null } : {}),
    work: pause ? pauseDrops(team, live, observations, pause, now, memory, read, nativeHeld) : workDrops(team, live, observations, watch, now, memory, read, nativeHeld, seatPauses),
    ring,
    mailboxNote,
    readings,
    machineReadings,
    labels,
    refusals: refused,
  };
}

/** Idle workers due a work drop this pass. Leads, parked and stopped seats, a seat whose pane is
 *  a human's, a dialog and a box that already holds text are not due. The stamp lives in this
 *  process: a restart starts the idle clock again. A seat seen working clears its stamp, so the
 *  next quiet stretch waits `idle_first` once more. */
function workDrops(
  team: TeamFile,
  live: Live,
  observations: SeatObservation[],
  watch: TeamFile['watch'],
  now: number,
  memory: Memory,
  read: (cli: string, screen: string | undefined) => Screen,
  nativeHeld: ReadonlySet<string> | undefined,
  seatPauses: Readonly<Record<string, PauseRecord>> | null | undefined = null,
): PassResult['work'] {
  const sent = (memory.slots['work-nudge'] ??= {}) as Record<string, number>;
  const body = team.watch.nudge ?? NUDGE_TEXT;
  const due: PassResult['work'] = [];
  for (const obs of observations) {
    const fileSeat = team.seats.find((item) => item.name === obs.name);
    if (obs.lead || obs.parked || obs.stopped || fileSeat?.human === true || !obs.seat || !obs.agent) {
      delete sent[obs.name];
      continue;
    }
    // A seat paused on its own gets no work nudge, and its stamp is cleared so a resume starts
    // a fresh stretch rather than a nudge the same second it wakes. Only this seat is skipped.
    if (seatPauses?.[obs.name] !== undefined) {
      delete sent[obs.name];
      continue;
    }
    // A held seat is not due a work drop: native presence outranks the idle screen, and the
    // stamp is cleared so a later stretch starts fresh after the hold lifts.
    if (nativeHeld?.has(obs.name) === true) {
      delete sent[obs.name];
      continue;
    }
    if (live.agents.filter((agent) => agent.name === obs.name).length !== 1) {
      delete sent[obs.name];
      continue;
    }
    const quiet = (obs.agent.status === 'idle' || obs.agent.status === 'done') && !obs.working && !obs.prompt;
    if (!quiet) {
      delete sent[obs.name];
      continue;
    }
    const since = now - (obs.history.lastWorking ?? obs.history.idleSince ?? now);
    const at = sent[obs.name];
    const waiting = since >= obs.liveness.idle_lead_seconds * 1000
      && (at === undefined || (watch.idleRepeat !== undefined && now - at >= watch.idleRepeat * 1000));
    if (!waiting) continue;
    const screen = read(obs.cli, live.screens[obs.agent.pane]);
    // A dialog or unsent text stays the seat's. The stamp is not set, so a later empty prompt
    // in this same stretch still gets the drop.
    if (screen.kind !== 'idle') continue;
    sent[obs.name] = now;
    due.push({
      pane: obs.agent.pane,
      seat: obs.name,
      cli: obs.cli,
      body: body.replaceAll('<your seat name>', obs.name),
    });
  }
  return due;
}

/**
 * The pause's own drops: one notice per non-human agent seat, at the first quiet prompt after the
 * pause was placed, and never twice for the same pause. The notice says what the pause means for
 * the seat — finish the step in hand, take nothing new, hold no lock — and names the way out.
 * Leads, parked and stopped seats and a human seat's pane are skipped exactly as `workDrops`
 * skips them; a dialog or a box holding unsent text is left alone and tried again next pass. The
 * stamps are keyed by the pause instant, so a resume and a later pause notice again.
 */
function pauseDrops(
  team: TeamFile,
  live: Live,
  observations: SeatObservation[],
  pause: PauseRecord,
  now: number,
  memory: Memory,
  read: (cli: string, screen: string | undefined) => Screen,
  nativeHeld: ReadonlySet<string> | undefined,
): PassResult['work'] {
  const slot = (memory.slots['pause-notice'] ??= {}) as { at?: string; seats?: Record<string, number> };
  if (slot.at !== pause.at) {
    slot.at = pause.at;
    slot.seats = {};
  }
  const told = (slot.seats ??= {});
  const body = `Team watch: ${pauseText(pause)} — finish the step you are on, take nothing new, and hold no lock until \`team resume\``;
  const due: PassResult['work'] = [];
  for (const obs of observations) {
    const fileSeat = team.seats.find((item) => item.name === obs.name);
    if (obs.lead || obs.parked || obs.stopped || fileSeat?.human === true || !obs.seat || !obs.agent) continue;
    // The pause's notice is typed too: a seat the native store holds is skipped and stays due
    // when the hold lifts, because no stamp is written for it here.
    if (nativeHeld?.has(obs.name) === true) continue;
    if (live.agents.filter((agent) => agent.name === obs.name).length !== 1) continue;
    if (told[obs.name] !== undefined) continue;
    const quiet = (obs.agent.status === 'idle' || obs.agent.status === 'done') && !obs.working && !obs.prompt;
    if (!quiet) continue;
    const screen = read(obs.cli, live.screens[obs.agent.pane]);
    if (screen.kind !== 'idle') continue;
    told[obs.name] = now;
    due.push({ pane: obs.agent.pane, seat: obs.name, cli: obs.cli, body: body.replaceAll('<your seat name>', obs.name) });
  }
  return due;
}

/** The sidebar lines a running file seat needs this pass. The first cycle paints both lines
 *  from the file, with a live model or effort in place of the file's when the screen shows
 *  one. A later cycle paints only a line that changed. A temporary seat has no file seat and
 *  is not passed here. */
function labelOf(
  seat: Seat,
  pane: string,
  workspace: string,
  screen: string | undefined,
  memory: Memory,
): PassResult['labels'] {
  const prior = memory.seatLabels[seat.name];
  const live = liveDisplayAgent(seat, screen, prior?.effort);
  if (live.effort) (memory.seatLabels[seat.name] ??= {}).effort = live.effort;
  const title = workspaceLabel(seat);
  const push: PassResult['labels'][number] = { name: seat.name, pane, workspace };
  if (prior?.title !== title) push.title = title;
  if (prior?.line !== live.line) push.displayAgent = live.line;
  return push.title || push.displayAgent ? [push] : [];
}
