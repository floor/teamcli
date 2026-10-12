// One pass of the watch: the core. It builds one observation per seat before any check runs,
// runs the registered checks in the order it owns, applies the report-once rule, and dials the
// nudge. A check never reads herdr, a screen or the file itself — only the observation it is
// handed (RFC 0002 § 4.2).
import { seatNamed } from '../approve/fingerprint.ts';
import { observe, observeCheck, type Seen } from '../budgets/readings.ts';
import type { CheckOutcome } from '../budgets/run.ts';
import type { TeamFile } from '../file/types.ts';
import type { PaneProcesses } from '../herdr.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
import { boxHoldsText } from '../launch/deliver.ts';
import { seatProcessVerdict } from '../launch/identity.ts';
import { profileFor, quotaFor as shippedQuota } from '../profiles/profile.ts';
import { figuresOf, type QuotaFigure, type QuotaPattern } from '../profiles/quota.ts';
import type { SessionState } from '../state.ts';
import type { Live } from '../status/compare.ts';
import { seatModel } from '../status/statusline.ts';
import {
  ALWAYS_ON,
  type Attention,
  type CheckContext,
  type Report,
  type SeatCheck,
  type SeatHistory,
  type SeatObservation,
  type TeamCheck,
  type TeamObservation,
} from './check.ts';
import { minutes } from './check.ts';
import { attention } from './checks/attention.ts';
import { approval } from './checks/approval.ts';
import { budget } from './checks/budget.ts';
import { disk } from './checks/disk.ts';
import { extra } from './checks/extra.ts';
import { idle } from './checks/idle.ts';
import { load } from './checks/load.ts';
import { memory as memoryCheck } from './checks/memory.ts';
import { missing } from './checks/missing.ts';
import { modelDrift } from './checks/model-drift.ts';
import { restored } from './checks/restored.ts';
import { swapFree } from './checks/swap-free.ts';
import { swapGrowth } from './checks/swap-growth.ts';
import { teamIdle } from './checks/team-idle.ts';
import { unsent } from './checks/unsent.ts';
import type { Machine } from './machine.ts';
import { readScreen, statusRow, type Screen } from './screen.ts';

// What the watch remembers between passes. It lives in the watch's process: a restarted watch
// starts its timers again, and reports again what is still true.
export type Memory = {
  // The seats' shared history, per seat name: the clock the idle check counts from.
  history: Record<string, SeatHistory>;
  // Each check's own slot, by kind. The core keeps them; no check reads another's.
  slots: Record<string, unknown>;
  // Conditions that were reported and have not cleared since.
  active: Set<string>;
  pending: string[];
  pendingSince: number | null;
  // The nudge line this watch typed itself and has not seen sent, recorded at the typing: the
  // pane, and the exact text. Only this record — never the text, which is one fixed public
  // constant — can make an unsent box the watch's own, and it lives in this process: a restarted
  // watch has none, and text it did not type is left as its owner left it.
  ownNudge: { pane: string; text: string } | null;
  // `${recipient}/${id}` this process has already told the owner about. Two seats can hold the
  // same id. A restarted watch has none, so an old unacked record is said again; a receipt
  // takes the record off the list.
  mailboxTold: Set<string>;
};

export function newMemory(): Memory {
  return { history: {}, slots: {}, active: new Set(), pending: [], pendingSince: null, ownNudge: null, mailboxTold: new Set() };
}

/** Whether a box, already read as unsent, holds this watch's own line: this process recorded
 *  typing exactly this text into this same pane, and the box still holds it. The record is the
 *  identity — the same text typed by anyone else, or found after a restart, is theirs. */
export function ownUnsent(memory: Memory, pane: string, text: string, cli: string, screen: string | undefined): boolean {
  return memory.ownNudge !== null && memory.ownNudge.pane === pane && memory.ownNudge.text === text
    && boxHoldsText(cli, text, screen);
}

export type { Report } from './check.ts';

// The one line the watch types into the operator's pane. Fixed, and free of report text: a dialog
// can open between the screen read and the typing, and a digit in the line would answer it. The
// reports go to the log and to the desktop notification; the line only says where they are.
export const NUDGE_TEXT = 'Team watch: reports are waiting in .agents/team.log';

// The one line the watch types into a seat's pane when a message is waiting. Fixed, and not the
// body: the body is what `team messages` prints after it verifies.
export const RING_TEXT = 'Team: run team messages';

/** One unacked message the watch has already verified, joined to the seat's pane when it has one. */
export type MailboxWaiting = {
  id: string;
  to: string;
  at: number;
  pane: string | null;
  status: string | null;
  cli: string;
  screen: string | undefined;
};

export type PassResult = {
  reports: Report[];
  // The one line to type into the operator's pane, when the operator is free. `pending` holds the
  // report texts it stands for, so a delivery that fails puts them back rather than losing them.
  nudge: { pane: string; text: string; pending: string[] } | null;
  // What to notify instead, when a nudge has waited too long.
  fallback: string | null;
  // The one line to type when a message is waiting and this pass is not already typing a nudge.
  ring: { pane: string; text: string; cli: string; to: string; id: string } | null;
  // One owner line when an unacked message is older than `nudge_wait` and its box is not free.
  mailboxNote: string | null;
  // The readings that count, to be saved: the project's, with this pass's figures folded in (§ 4.4).
  readings: Seen[];
};

// The seat checks, in the order their reports land in the log; the team checks, after them. The
// order is the core's: a seat's wrong model is reported before its permission prompt, and every
// seat before the team. Disabling a check in the `watch` section in force takes it out of the
// run, except the four that can't be turned off.
export const SEAT_CHECKS: SeatCheck[] = [missing, restored, modelDrift, attention, unsent, idle];
export const TEAM_CHECKS: TeamCheck[] = [extra, teamIdle, approval, load, memoryCheck, disk, swapFree, swapGrowth, budget];

// The one exclusive reading of a seat's screen and herdr status. herdr can report a seat at a
// permission prompt as idle, so the screen decides first. `team check` reads it too, over a pane
// the state records for a seat of this team: one reading, two readers, and no second rule.
export function attentionOf(screen: Screen, status: string, quiet: boolean): Attention {
  if (screen.kind === 'permission' || screen.kind === 'trust') return 'permission';
  if (screen.kind === 'question' || screen.kind === 'exit question') return 'question';
  if (screen.kind === 'vendor notice') return 'vendor notice';
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
// memory, and what the caller knows that the world does not. `approval` is how the file differs
// from the approved one: [] when it doesn't, null when it was never approved, undefined when that
// wasn't looked at. `watch` and `budgets` are the sections in force — the approved ones, or the
// defaults while the file's own are not approved — and the checks read those, never the file's.
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
  approval?: string[] | null;
  // The case in one line when no verified approval is in force and the record says why. The
  // watch says it itself, once; the pass's approval check reads it and adds nothing.
  approvalReason?: string | null;
  watch: TeamFile['watch'];
  outcomes?: readonly CheckOutcome[];
  budgets?: TeamFile['budgets'];
  readings?: readonly Seen[];
  foreground?: Readonly<Record<string, readonly string[] | null>>;
  // Each pane's process identity, by pane id, as the caller read it — null where herdr can't
  // tell, and absent for a pane it wasn't read for. A seat's recorded identity is compared with
  // its pane's reading: `gone`/`replaced` is no longer the seat. A null, or a pane the map
  // doesn't hold, is exactly a seat with no record: the restored check reports nothing.
  processes?: Readonly<Record<string, PaneProcesses | null>>;
  /** Screen readings with the approved overrides applied. The shipped profiles, when omitted. */
  readScreen?: (cli: string, screen: string | undefined) => Screen;
  /** Quota patterns in force, shipped plus the approved override. The shipped list, when omitted. */
  quotaFor?: (cli: string) => readonly QuotaPattern[];
  /** The operator the nudge may type to. Omitted, the pass uses `team`. Null, it types nothing. */
  nudgeOperator?: { name: string; cli: string } | null;
  /** Unacked messages already verified. Omitted, the pass rings nothing. */
  mailbox?: readonly MailboxWaiting[];
};

// One pass of the watch. Pure: it reads what it is handed and changes only `memory`.
export function pass({
  team,
  state,
  live,
  machine,
  now,
  memory,
  approval,
  approvalReason,
  watch,
  outcomes = [],
  budgets = team.budgets,
  readings: stored = [],
  foreground,
  processes,
  readScreen: read = readScreen,
  quotaFor: patternsOf = shippedQuota,
  nudgeOperator,
  mailbox = [],
}: PassInput): PassResult {
  const reports: Report[] = [];
  const current = new Set<string>();
  // Reported when it starts, and again only after it has cleared.
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

  for (const { name, cli, vendor, account, parked, stopped, seat } of seats) {
    const agent = live.agents.find((candidate) => candidate.name === name);
    const lead = name === team.orchestrator || name === team.operator;
    if (!agent) {
      delete memory.history[name];
      observations.push({
        name,
        seat,
        agent: undefined,
        herdr: live.running,
        screen: { kind: 'unknown' },
        cli,
        vendor,
        account,
        quota: [],
        identity: 'unknown',
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
      });
      continue;
    }
    known.add(agent.pane);
    const pane = live.screens[agent.pane];
    const screen = read(cli, pane);
    const quiet = agent.status === 'idle' || agent.status === 'done';
    // Working is herdr's word or the screen's: a seat mid-turn is never idle, whatever its
    // status says.
    const working = agent.status === 'working' || screen.kind === 'working';
    const prompt = screen.kind === 'permission' || screen.kind === 'trust' || screen.kind === 'question' || screen.kind === 'exit question' || screen.kind === 'vendor notice';
    if (!lead && !parked) workers.push({ idle: quiet && !working && !prompt });

    // The history the idle clock counts from. A seat seen working starts it again; a seat quiet
    // with no work behind it was already idle when the watch started, and counts from then.
    const history = (memory.history[name] ??= { lastWorking: undefined, idleSince: undefined });
    if (working) {
      history.lastWorking = now;
      delete history.idleSince;
    } else if (quiet && !prompt && !lead && !parked && history.lastWorking === undefined) {
      history.idleSince ??= now;
    }

    observations.push({
      name,
      seat,
      agent,
      herdr: live.running,
      screen,
      cli,
      vendor,
      account,
      quota: quotaOf(cli, screen, pane, reportedLiveAgent(foreground?.[agent.pane] ?? null, profileFor(cli)?.processNames ?? []), patternsOf(cli)),
      identity: seatProcessVerdict(state.seats[name]?.launched, processes?.[agent.pane] ?? null),
      running: true,
      recorded: state.seats[name]?.stage,
      quiet,
      working,
      prompt,
      lead,
      parked,
      stopped,
      attention: attentionOf(screen, agent.status, quiet),
      model: seat ? seatModel(seat, live.screens[agent.pane]) : null,
      history: { lastWorking: history.lastWorking, idleSince: history.idleSince },
    });
  }

  // The figures this pass saw, folded into the readings the project keeps (§ 4.3, § 4.4). Only an
  // account whose `sources` name `status_line` takes a screen reading: a check-only account never
  // records one here, and neither does an account the budgets in force don't name (#50). A figure
  // names the account its pattern measures (§ 3b): one that measures this seat's vendor is this
  // seat's account — its own `account:` when the file names one, so two accounts of one vendor
  // keep two buckets — while a figure on another account (a launcher showing the vendor it really
  // runs on) stays that account's, whichever seat's screen showed it.
  //
  // A seat the approval lists as changed — or as not in the approved file — is drift, and its
  // figures are read as they are but none is folded: an unapproved edit to its `account:` must
  // not move its figure into another account's bucket, where `up` and `add` would count it.
  // Nothing is saved for that seat until the owner approves.
  const drift = new Set(
    (Array.isArray(approval) ? approval : []).map(seatNamed).filter((name): name is string => name !== null),
  );
  for (const [name, recorded] of Object.entries(state.seats)) {
    if (recorded.temporary && drift.has(recorded.temporary.like)) {
      drift.add(name);
    }
  }
  let readings = stored.slice();
  for (const seat of observations) {
    if (!seat.running || drift.has(seat.name)) continue;
    for (const figure of seat.quota) {
      const account = figure.account === seat.vendor ? seat.account : figure.account;
      if (budgets.accounts[account]?.sources.includes('status_line')) {
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

  const teamObservation: TeamObservation = {
    team,
    state,
    live,
    machine,
    limits: team.machine,
    seats: observations,
    known,
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
  // The off list is the section in force, which the caller passes as `watch`. A file that was
  // approved — `approval` is a list, empty or not — runs that list. An unapproved `watch.checks`
  // edit does not turn anything new off, and a check the approved list turned off stays off.
  // A file never approved, or whose approval was not looked at, turns nothing off.
  const off = Array.isArray(approval) ? new Set(watch.checks) : new Set<string>();
  const enabled = (name: string) => ALWAYS_ON.includes(name) || !off.has(name);
  for (const seat of observations) {
    for (const check of SEAT_CHECKS) if (enabled(check.name)) reports.push(...check.run(seat, ctx));
  }
  for (const check of TEAM_CHECKS) if (enabled(check.name)) reports.push(...check.run(teamObservation, ctx));

  memory.active = current;

  // The nudge: kept until the operator is free — an empty idle prompt, or a box holding the line
  // this watch typed itself and never saw sent, which is sent rather than typed again — and
  // typed into nothing else.
  for (const report of reports) {
    if (report.to === 'operator' && !memory.pending.includes(report.text)) {
      memory.pending.push(report.text);
    }
  }
  let nudge: PassResult['nudge'] = null;
  let fallback: string | null = null;
  if (memory.pending.length) {
    memory.pendingSince ??= now;
    const chosen = nudgeOperator === undefined
      ? { name: team.operator, cli: team.seats.find((seat) => seat.name === team.operator)?.cli ?? '' }
      : nudgeOperator;
    const named = chosen === null ? [] : live.agents.filter((agent) => agent.name === chosen.name);
    const operator = named.length === 1 ? named[0] : undefined;
    const cli = chosen?.cli ?? '';
    const screen = operator ? read(cli, live.screens[operator.pane]) : null;
    // The operator's box, read once more: an empty idle prompt is free to type into, and so is a
    // box still holding the line this watch typed itself, recorded in memory at the typing. The
    // line is one fixed public constant, so the text alone proves nothing: the same text typed
    // by a person or an agent, or found by a restarted watch, is someone's text — never typed
    // over, sent or cleared, and left to them or to the next stop.
    const mine = operator !== undefined && screen?.kind === 'unsent'
      && ownUnsent(memory, operator.pane, NUDGE_TEXT, cli, live.screens[operator.pane]);
    const free = operator !== undefined && (operator.status === 'idle' || operator.status === 'done')
      && (screen?.kind === 'idle' || mine);
    if (operator && free) {
      nudge = {
        pane: operator.pane,
        text: NUDGE_TEXT,
        pending: memory.pending.slice(),
        ...(nudgeOperator ? { cli: nudgeOperator.cli } : {}),
      };
    } else if (now - memory.pendingSince >= watch.nudgeWait * 1000) {
      fallback = `the operator could not be nudged for ${minutes(now - memory.pendingSince)} minutes; ${memory.pending.length} report(s) wait: ${memory.pending.join('; ')}`;
    }
    if (nudge || fallback) {
      memory.pending = [];
      memory.pendingSince = null;
    }
  }
  // A report nudge is the one typed line of this pass. A ring is typed only when this pass is
  // not already typing that nudge. The record stays either way: the receipt is what clears it.
  let ring: PassResult['ring'] = null;
  let mailboxNote: string | null = null;
  const ordered = [...mailbox].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const record of ordered) {
    const screen = record.pane ? read(record.cli, record.screen) : null;
    const mine = record.pane !== null && screen?.kind === 'unsent'
      && ownUnsent(memory, record.pane, RING_TEXT, record.cli, record.screen);
    const free = record.pane !== null && (record.status === 'idle' || record.status === 'done')
      && (screen?.kind === 'idle' || mine);
    if (nudge === null && free && ring === null && record.pane !== null) {
      ring = { pane: record.pane, text: RING_TEXT, cli: record.cli, to: record.to, id: record.id };
      continue;
    }
    const toldKey = `${record.to}/${record.id}`;
    if (!free && mailboxNote === null && now - record.at >= watch.nudgeWait * 1000 && !memory.mailboxTold.has(toldKey)) {
      mailboxNote = `message ${record.id} for ${record.to} has been waiting ${minutes(now - record.at)} minutes`;
      memory.mailboxTold.add(toldKey);
    }
  }
  return { reports, nudge, fallback, ring, mailboxNote, readings };
}
