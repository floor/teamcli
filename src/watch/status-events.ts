// Seat status from herdr as events (workspace-adapters §6):
// One `herdr wait agent-status` waiter per eligible seat turns herdr's status transitions into
// signed events in `.agents/events.jsonl`, replacing periodic screen polling where herdr's
// status is reliable:
// - `blocked` -> `seat.at-prompt` (reads the screen once via `promptKind` to classify the prompt;
//   routes to the seat's lead at once, and if the blocked seat IS the lead or the lead does not
//   clear it within `prompt_escalation_seconds`, escalates to the entity's orchestrator and the
//   owner at once with a desktop notification)
// - `done` -> `seat.done` (`"<seat> finished its turn"`)
// - `idle` for N (`idle_lead_seconds`) -> `seat.idle` (once per idle stretch, never repeated;
//   marks one nudge due for eligible worker seats)
// - `working` after `blocked` -> `seat.unblocked` (closes the open at-prompt notice and cancels
//   the escalation timer; honours the 1-pass flicker grace so `blocked -> working -> blocked`
//   within grace does not double-emit `seat.at-prompt`)
// - `unknown` -> no event (logged)
//
// Safety invariants:
// 1. `human: true` seats are NEVER waited on and NEVER typed into.
// 2. Profiles with `herdr_status: unreliable` (`jules`) keep the screen module as their status
//    source and are never handed to `herdr wait agent-status`.
// 3. Status waiters are strictly read-only and never send text or keys into any pane.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TeamFile } from '../file/types.ts';
import {
  isHerdrAgentStatus,
  PANE_WINDOW,
  paneRead,
  parseWaitAgentStatusOutput,
  waitAgentStatus,
  HERDR_AGENT_STATUSES,
  type HerdrAgentStatus,
  type HerdrWaitOutcome,
} from '../herdr.ts';
import { leadSeatsOf, recipientsForEvent, type TeamRoutingRoles } from '../bus/kinds.ts';
import { appendEvent, eventLogPath, type EventAppendInput, type SignedEventRecord } from '../bus/log.ts';
import { writeRuntimeMailboxRecord } from '../bus/owner.ts';
import { readEntityOrchestrator } from '../bus/seats.ts';
import type { BusPublishOutcome } from '../bus/server.ts';
import { EVENT_THRESHOLDS } from '../policy/events.ts';
import { herdrUnreliable } from '../profiles/index.ts';
import { teamIdOf } from '../registry/teams.ts';
import { readState } from '../state.ts';
import { minutes } from './check.ts';
import { notify as defaultNotify } from './notify.ts';
import { readScreen, screenWord, type Screen, type ScreenOptions } from './screen.ts';

export {
  HERDR_AGENT_STATUSES,
  isHerdrAgentStatus,
  parseWaitAgentStatusOutput,
  waitAgentStatus,
  type HerdrAgentStatus,
  type HerdrWaitOutcome,
};

export type StatusTarget = { is: HerdrAgentStatus } | { not: HerdrAgentStatus };

export type StatusWaitSeat = {
  name: string;
  pane: string;
  cli: string;
  session?: string;
  human?: boolean;
  stopped?: boolean;
  parked?: boolean;
  leads?: boolean;
};

export type StatusWaitResult =
  | { outcome: 'changed'; status: HerdrAgentStatus; at: number }
  | { outcome: 'timeout'; at: number }
  | { outcome: 'error'; error: string; at: number };

export type PromptKind =
  | 'permission'
  | 'trust'
  | 'guard'
  | 'question'
  | 'login'
  | 'vendor notice'
  | 'rate limit'
  | 'unknown';

/** Backend-neutral status-source contract (workspace-adapters §6).
 *  Strictly read-only: no typing or key-sending method exists on this interface. */
export type StatusSource = {
  /** Blocks until the seat's status matches `target`, or `timeoutMs` elapses. */
  waitStatus(
    seat: StatusWaitSeat,
    target: StatusTarget,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<StatusWaitResult>;
  /** Reads the pane's screen once when a seat enters `blocked` to classify the prompt kind. */
  promptKind?(seat: StatusWaitSeat): PromptKind;
  /** Reads the pane's screen for `herdr_status: unreliable` profiles (`jules`) or screen-verified statuses. */
  readUnreliableScreen?(seat: StatusWaitSeat): Screen;
  /** Desktop notification when a prompt climbs to the owner. */
  notify?(title: string, body: string, sound?: string): void;
};

/** Classifies a pane's visible text into a prompt kind when a seat enters `blocked`. */
export function classifyPromptKind(
  cli: string,
  rawScreen: string | undefined | null,
  options?: ScreenOptions,
): PromptKind {
  if (rawScreen === undefined || rawScreen === null || rawScreen === '') return 'unknown';
  const screen = readScreen(cli, rawScreen, options);
  if (screen.kind === 'permission') return 'permission';
  if (screen.kind === 'trust') return 'trust';
  if (screen.kind === 'question' || screen.kind === 'exit question') return 'question';
  if (screen.kind === 'vendor notice') return 'vendor notice';
  if (screen.kind === 'rate limit') return 'rate limit';
  if (/\bguard\b.*\b(prompt|hook|refused|blocked|allow)\b/i.test(rawScreen)) return 'guard';
  if (/\b(log\s*in|sign\s*in|authenticate|authentication required)\b/i.test(rawScreen)) return 'login';
  return 'unknown';
}

/** Whether a CLI's herdr status requires screen verification (`practice/herdr.md` §"Herdr Agent Status Limitations"):
 *  - `jules`: `herdr_status: unreliable`
 *  - `antigravity` / `gemini`: can report `idle` while actually working
 *  - `cursor`: can report `done` while actually still running */
export function isScreenVerifiedStatusCli(cli: string): boolean {
  if (herdrUnreliable(cli)) return true;
  return cli === 'antigravity' || cli === 'gemini' || cli === 'cursor';
}

/** Reconciles herdr's `agent_status` with a visible screen reading ONLY for CLIs whose herdr status can lie
 *  (`isScreenVerifiedStatusCli(cli)`: `jules`, `antigravity`, `gemini`, `cursor`):
 *  - reliable CLIs (`claude-code`, `codex`, `grok`, etc.) keep `status` unchanged even if a stale working frame is on screen
 *  - any prompt screen (`permission`, `trust`, `question`, `exit question`, `vendor notice`, `rate limit`, `guard`, `login`) -> `'blocked'`
 *  - `antigravity`/`gemini`/`jules` reporting `'idle'` while the screen shows `'working'` -> `'working'`
 *  - `cursor`/`jules` reporting `'done'` while the screen shows `'working'` -> `'working'`
 *  - empty/absent `rawScreen` preserves `status` unchanged. */
export function reconcileStatusWithScreen(
  cli: string,
  status: HerdrAgentStatus,
  rawScreen: string | undefined | null,
  options?: ScreenOptions,
): HerdrAgentStatus {
  if (!isScreenVerifiedStatusCli(cli)) return status;
  if (rawScreen === undefined || rawScreen === null || rawScreen === '') return status;
  const screen = readScreen(cli, rawScreen, options);
  if (
    screen.kind === 'permission'
    || screen.kind === 'trust'
    || screen.kind === 'question'
    || screen.kind === 'exit question'
    || screen.kind === 'vendor notice'
    || screen.kind === 'rate limit'
  ) {
    return 'blocked';
  }
  if (classifyPromptKind(cli, rawScreen, options) !== 'unknown') {
    return 'blocked';
  }
  if (screen.kind === 'working') {
    if (herdrUnreliable(cli) && (status === 'idle' || status === 'done')) {
      return 'working';
    }
    if ((cli === 'antigravity' || cli === 'gemini') && status === 'idle') {
      return 'working';
    }
    if (cli === 'cursor' && status === 'done') {
      return 'working';
    }
  }
  return status;
}

/** Whether a seat is eligible for a `herdr wait agent-status` waiter:
 *  - `human: true` seats are NEVER waited on and NEVER typed into;
 *  - `stopped: true` seats are not running;
 *  - `herdrUnreliable(cli)` seats (`jules`) keep the screen module as their status source. */
export function isStatusWaiterSeat(seat: {
  cli: string;
  human?: boolean;
  stopped?: boolean;
}): boolean {
  if (seat.human === true) return false;
  if (seat.stopped === true) return false;
  if (herdrUnreliable(seat.cli)) return false;
  return true;
}

/** Whether a periodic watch pass needs to read a seat's screen when status waiters are active:
 *  - never for `human: true` or `stopped: true` seats;
 *  - always for `herdrUnreliable(cli)` (`jules`);
 *  - at startup before the sidebar label is painted (`!hasSidebarLabel`);
 *  - when `status === 'blocked'` (to classify the prompt kind);
 *  - when `antigravity`/`gemini` reports `'idle'` (can read `idle` while working) or `cursor`
 *    reports `'done'` (can read `done` while running). */
export function shouldReadScreenForStatus(
  seat: { cli: string; human?: boolean; stopped?: boolean },
  status: string,
  hasSidebarLabel: boolean,
): boolean {
  if (seat.human === true || seat.stopped === true) return false;
  if (herdrUnreliable(seat.cli)) return true;
  if (!hasSidebarLabel) return true;
  if (status === 'blocked') return true;
  if ((seat.cli === 'antigravity' || seat.cli === 'gemini') && status === 'idle') return true;
  if (seat.cli === 'cursor' && status === 'done') return true;
  return false;
}

export type HerdrStatusSourceOptions = {
  session?: string;
  now?: () => number;
  readPane?: (pane: string, lines: number, session?: string) => string | null;
  waitFn?: typeof waitAgentStatus;
  notifyFn?: (text: string) => void;
  screenOptions?: ScreenOptions;
};

/** Ordered candidate target states for `{ not: current }` single-client transition waiting.
 *  `herdr wait agent-status <pane> --status <s>` accepts a single status token per client and
 *  returns immediately (`exit 0`) when the pane is already at `<s>`, so cycling one waiter process
 *  per seat through likely target states keeps fleet process count at strictly 1 client per seat. */
const WAIT_CANDIDATE_ORDER: Record<HerdrAgentStatus, readonly HerdrAgentStatus[]> = {
  working: ['blocked', 'done', 'idle'],
  idle: ['working', 'blocked', 'done'],
  done: ['working', 'blocked', 'idle'],
  blocked: ['working', 'done', 'idle'],
  unknown: ['blocked', 'done', 'idle', 'working'],
};

/** Default `StatusSource` backed by `herdr wait agent-status` and `herdr pane read`. */
export function herdrStatusSource(options: HerdrStatusSourceOptions = {}): StatusSource {
  const now = options.now ?? (() => Date.now());
  const readPane = options.readPane ?? paneRead;
  const waitFn = options.waitFn ?? waitAgentStatus;
  const notifyFn = options.notifyFn ?? defaultNotify;

  return {
    async waitStatus(seat, target, timeoutMs, signal): Promise<StatusWaitResult> {
      if (seat.human === true) {
        return { outcome: 'error', error: `${seat.name} is a human seat and cannot be waited on`, at: now() };
      }
      if (herdrUnreliable(seat.cli)) {
        return {
          outcome: 'error',
          error: `${seat.name} (${seat.cli}) has unreliable herdr status and uses the screen module`,
          at: now(),
        };
      }
      const session = seat.session ?? options.session;
      if ('is' in target) {
        const res = await waitFn(seat.pane, target.is, timeoutMs, session, signal);
        const at = now();
        if (res.outcome === 'changed') return { outcome: 'changed', status: res.status, at };
        if (res.outcome === 'timeout') return { outcome: 'timeout', at };
        return { outcome: 'error', error: res.message, at };
      }

      // `{ not: current }`: keep strictly ONE `herdr wait agent-status` client process per seat
      // by cycling sequentially through the candidate target statuses across `timeoutMs`.
      const candidates =
        WAIT_CANDIDATE_ORDER[target.not]
        ?? (['blocked', 'done', 'idle', 'working'] as const).filter((candidate) => candidate !== target.not);
      const totalTimeoutMs = Math.max(1, Math.round(timeoutMs));
      const sliceTimeoutMs = Math.max(1, Math.floor(totalTimeoutMs / candidates.length));

      for (const candidate of candidates) {
        if (signal?.aborted) {
          return { outcome: 'timeout', at: now() };
        }
        const res = await waitFn(seat.pane, candidate, sliceTimeoutMs, session, signal);
        const at = now();
        if (res.outcome === 'changed') {
          return { outcome: 'changed', status: res.status, at };
        }
        if (res.outcome === 'error') {
          if (signal?.aborted) return { outcome: 'timeout', at };
          return { outcome: 'error', error: res.message, at };
        }
      }
      return { outcome: 'timeout', at: now() };
    },

    promptKind(seat): PromptKind {
      if (seat.human === true) return 'unknown';
      const raw = readPane(seat.pane, PANE_WINDOW, seat.session ?? options.session);
      return classifyPromptKind(seat.cli, raw, options.screenOptions);
    },

    readUnreliableScreen(seat): Screen {
      if (seat.human === true) return { kind: 'unknown' };
      const raw = readPane(seat.pane, PANE_WINDOW, seat.session ?? options.session);
      return readScreen(seat.cli, raw ?? undefined, options.screenOptions);
    },

    notify(title, body): void {
      notifyFn(title ? `${title}: ${body}` : body);
    },
  };
}

export type EmittedStatusEvent = {
  input: EventAppendInput;
  record?: SignedEventRecord;
  recipients: Set<string>;
  notifiedOwner: boolean;
  escalatedMailboxPaths: string[];
};

export type SeatStatusStep = {
  seat: string;
  status: HerdrAgentStatus;
  events: EmittedStatusEvent[];
  nudgeDue: boolean;
  skipped?: 'human' | 'unreliable' | 'stopped' | 'missing';
};

export type SeatStatusWaitStep = {
  seat: string;
  outcome: 'changed' | 'timeout' | 'error' | 'skipped';
  status?: HerdrAgentStatus;
  rearmed: boolean;
  error?: string;
  skipped?: 'human' | 'unreliable' | 'stopped' | 'missing';
  events: EmittedStatusEvent[];
  nudgeDue: boolean;
};

type PromptSpell = {
  prompt: PromptKind;
  since: number;
  escalated: boolean;
  clearedAt?: number;
};

type IdleStretch = {
  since: number;
  emitted: boolean;
  nudged: boolean;
};

type SeatTrackerState = {
  status?: HerdrAgentStatus;
  rawStatus?: HerdrAgentStatus;
  promptSpell?: PromptSpell;
  idleStretch?: IdleStretch;
  seq: number;
};

export type SeatStatusEngineInput = {
  team: TeamFile;
  session?: string;
  root?: string;
  home?: string;
  source?: StatusSource;
  now?: () => number;
  /** Flicker grace window in ms for `blocked -> working -> blocked` (defaults to `watch.interval * 1000`). */
  graceMs?: number;
  /** Prompt escalation window in seconds (shorten-only against `EVENT_THRESHOLDS.prompt_escalation_seconds`). */
  promptEscalationSeconds?: number;
  /** Idle threshold in seconds (defaults to seat's `liveness.idle_lead_seconds` or `team.watch.idleFirst`). */
  idleThresholdSeconds?: number;
  /** Optional entity orchestrator seat name when no registry is on disk in unit tests. */
  entityOrchestrator?: string;
  /** Optional bus publisher invoked for each emitted event in addition to durable log append. */
  publish?: (root: string, event: EventAppendInput) => Promise<BusPublishOutcome>;
  /** Optional log callback for `unknown` statuses or waiter errors. */
  onLog?: (seat: string, message: string) => void;
  /** Optional callback invoked when a worker seat's idle window elapses and a nudge is due. */
  onNudge?: (seatName: string, pane: string) => void;
  /** Optional assigned-work predicate overriding or supplementing disk checks. */
  hasAssignedWork?: (seatName: string, atMs: number) => boolean;
  /** Optional set/list of seats with assigned work in unit tests without disk state. */
  assignedSeats?: ReadonlySet<string> | readonly string[];
};

export type SeatStatusEngine = {
  /** Synchronously records a status observation for `seatName` and emits any transition events. */
  observeSync(
    seatName: string,
    status: HerdrAgentStatus,
    atMs?: number,
    pane?: string,
    rawScreen?: string,
  ): SeatStatusStep;
  /** Records a status observation for `seatName`, appends to `events.jsonl`, and publishes to bus. */
  observe(
    seatName: string,
    status: HerdrAgentStatus,
    atMs?: number,
    pane?: string,
    rawScreen?: string,
  ): Promise<SeatStatusStep>;
  /** Synchronously advances the clock to `atMs`, firing any due `seat.idle` or `seat.prompt-escalated` events. */
  tickSync(atMs?: number): EmittedStatusEvent[];
  /** Advances the clock to `atMs`, firing and publishing any due `seat.idle` or `seat.prompt-escalated` events. */
  tick(atMs?: number): Promise<EmittedStatusEvent[]>;
  /** Polls a `herdr_status: unreliable` seat (`jules`) via the screen module instead of `herdr wait`. */
  pollUnreliableSeat(seatName: string, rawScreen?: string, atMs?: number, pane?: string): Promise<SeatStatusStep>;
  /** Runs one `waitStatus` cycle for `seatName`. Re-arms on timeout without emitting a transition event. */
  waitSeatOnce(seatName: string, timeoutMs?: number, pane?: string, signal?: AbortSignal): Promise<SeatStatusWaitStep>;
  /** Starts one background `waitSeatOnce` loop per eligible running seat. */
  startWaiters(
    panesBySeat: Readonly<Record<string, string>>,
    options?: { timeoutMs?: number; maxIterations?: number; errorBackoffMs?: number },
  ): { stop(): void; done: Promise<void> };
  /** Drains worker seat names for which a nudge became due (`seat.idle`) since the last drain. */
  drainNudges(): string[];
  /** Read-only snapshot of a seat's current tracked status. */
  statusOf(seatName: string): HerdrAgentStatus | undefined;
};

/** Checks whether `seatName` currently has assigned work on disk under `root`:
 *  1. Active lease in `.agents/leases/<id>.json` (`lease.seat === seatName && Date.parse(lease.until) > atMs`)
 *  2. Assigned worktree (`worktrees[task].seat === seatName`) or temporary seat task in `.agents/state.json`
 *  3. Unacked message drop in `.agents/send-drops/<session>/<seatName>` (excluding the startup brief — its
 *     current id and the superseded ids its claim replaced — `work-*`, and sidecars)
 *  4. Open `work.claimed` event for `seatName` in `.agents/events.jsonl` not yet closed by `work.done` or `work.released`. */
export function seatHasAssignedWorkOnDisk(
  root: string,
  session: string,
  seatName: string,
  atMs: number,
  options?: { project?: string; home?: string },
): boolean {
  const agentsDir = existsSync(join(root, '.agents')) ? join(root, '.agents') : root;

  // 1. Live lease in `.agents/leases/*.json`.
  const leasesDir = join(agentsDir, 'leases');
  if (existsSync(leasesDir)) {
    try {
      for (const entry of readdirSync(leasesDir)) {
        if (!entry.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(readFileSync(join(leasesDir, entry), 'utf8')) as {
            seat?: unknown;
            until?: unknown;
          };
          if (parsed.seat !== seatName) continue;
          const untilMs = typeof parsed.until === 'string' ? Date.parse(parsed.until) : Number.POSITIVE_INFINITY;
          if (!Number.isNaN(untilMs) && untilMs > atMs) return true;
        } catch {
          // Ignore malformed lease files.
        }
      }
    } catch {
      // Ignore unreadable directory.
    }
  }

  // 2. Assigned worktree or temporary task in `state.json`.
  let briefId: string | undefined;
  let supersededBriefs: ReadonlySet<string> = new Set();
  try {
    const state = readState(agentsDir);
    const sessionState = state.sessions[session];
    briefId = sessionState?.briefs?.[seatName]?.id;
    supersededBriefs = new Set(sessionState?.briefs?.[seatName]?.superseded ?? []);
    if (sessionState?.seats?.[seatName]?.temporary?.task) return true;
    for (const wt of Object.values(sessionState?.worktrees ?? {})) {
      if (wt.seat === seatName) return true;
    }
  } catch {
    // Ignore unreadable state.
  }

  // 3. Unacked message drop in `.agents/send-drops/<session>/<seatName>`.
  const dropDir = join(agentsDir, 'send-drops', session, seatName);
  if (existsSync(dropDir)) {
    try {
      for (const name of readdirSync(dropDir)) {
        if (
          name.startsWith('.')
          || name.startsWith('work-')
          || name.endsWith('.pending')
          || name.endsWith('.delivered')
          || name.endsWith('.closed.json')
          || (briefId !== undefined && name === briefId)
          || supersededBriefs.has(name)
        ) {
          continue;
        }
        return true;
      }
    } catch {
      // Ignore unreadable directory.
    }
  }

  // 4. Open `work.claimed` in `events.jsonl` (store or `.agents`) not yet closed by `work.done` or `work.released`.
  const candidateEventPaths = [
    join(agentsDir, 'events.jsonl'),
    ...(options?.project !== undefined && options?.home !== undefined
      ? [eventLogPath(options.project, root, options.home)]
      : []),
  ];
  for (const eventsPath of candidateEventPaths) {
    if (!existsSync(eventsPath)) continue;
    try {
      const raw = readFileSync(eventsPath, 'utf8');
      let openClaims = 0;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as {
            payload?: { kind?: unknown; seat?: unknown; from?: unknown; subject?: unknown };
            kind?: unknown;
            seat?: unknown;
            from?: unknown;
            subject?: unknown;
          };
          const payload = parsed.payload ?? parsed;
          const actor = payload.seat ?? payload.from ?? payload.subject;
          if (actor !== seatName) continue;
          if (payload.kind === 'work.claimed') openClaims += 1;
          else if (payload.kind === 'work.done' || payload.kind === 'work.released') {
            openClaims = Math.max(0, openClaims - 1);
          }
        } catch {
          // Ignore malformed lines.
        }
      }
      if (openClaims > 0) return true;
    } catch {
      // Ignore unreadable events log.
    }
  }

  return false;
}

export function createSeatStatusEngine(input: SeatStatusEngineInput): SeatStatusEngine {
  const { team } = input;
  const session = input.session ?? team.session;
  const now = input.now ?? (() => Date.now());
  const source = input.source ?? herdrStatusSource({ session, now });
  const graceMs = input.graceMs ?? team.watch.interval * 1000;
  // Shorten-only: never exceeds `EVENT_THRESHOLDS.prompt_escalation_seconds` (300s).
  const promptEscalationSeconds = input.promptEscalationSeconds !== undefined
    ? Math.max(0, Math.min(input.promptEscalationSeconds, EVENT_THRESHOLDS.prompt_escalation_seconds))
    : EVENT_THRESHOLDS.prompt_escalation_seconds;
  const escalationWindowMs = promptEscalationSeconds * 1000;

  const states = new Map<string, SeatTrackerState>();
  const pendingNudges = new Set<string>();
  const leads = leadSeatsOf(team);
  const assignedSeatSet = input.assignedSeats !== undefined
    ? (input.assignedSeats instanceof Set ? input.assignedSeats : new Set(input.assignedSeats))
    : undefined;

  function hasAssignedWorkForSeat(seatName: string, atMs: number): boolean {
    if (input.hasAssignedWork !== undefined && input.hasAssignedWork(seatName, atMs)) return true;
    if (assignedSeatSet !== undefined && assignedSeatSet.has(seatName)) return true;
    if (
      input.root !== undefined
      && seatHasAssignedWorkOnDisk(input.root, session, seatName, atMs, {
        project: team.project,
        home: input.home,
      })
    ) {
      return true;
    }
    return false;
  }

  function resolveEntityTarget(): { seat: string; root: string; session: string } | null {
    if (input.home !== undefined && input.root !== undefined) {
      const target = readEntityOrchestrator(input.home, teamIdOf(input.root));
      if (target !== null) return target;
    }
    return null;
  }

  function routingRolesFor(): TeamRoutingRoles {
    const entityTarget = resolveEntityTarget();
    const entityOrchestrator = input.entityOrchestrator ?? entityTarget?.seat;
    return {
      orchestrator: team.orchestrator,
      operator: team.operator,
      seats: team.seats,
      ...(entityOrchestrator !== undefined ? { entityOrchestrator } : {}),
    };
  }

  function idleWindowMsFor(seatName: string): number {
    if (input.idleThresholdSeconds !== undefined) {
      return Math.max(0, input.idleThresholdSeconds) * 1000;
    }
    const seat = team.seats.find((item) => item.name === seatName);
    const seconds = seat?.liveness?.idle_lead_seconds ?? team.watch.idleFirst;
    return Math.max(0, seconds) * 1000;
  }

  function seatTargetOf(seatName: string, pane = `${seatName}:p1`): StatusWaitSeat | null {
    const seat = team.seats.find((item) => item.name === seatName);
    if (!seat) return null;
    return {
      name: seat.name,
      pane,
      cli: seat.cli,
      session,
      human: seat.human,
      stopped: seat.stopped,
      parked: seat.parked,
      leads: leads.has(seat.name),
    };
  }

  function recordEvent(
    eventInput: EventAppendInput,
    options: { notifyOwner?: boolean; climbMailboxWhy?: string; leadOnlyAtPrompt?: boolean } = {},
  ): EmittedStatusEvent {
    let record: SignedEventRecord | undefined;
    if (input.root !== undefined && input.home !== undefined) {
      try {
        const appended = appendEvent(team.project, input.root, input.home, eventInput);
        if (appended.ok) record = appended.record;
        else input.onLog?.(eventInput.seat ?? 'watch', `event append refused: ${appended.reason}`);
      } catch (error) {
        input.onLog?.(eventInput.seat ?? 'watch', `event append failed: ${String(error)}`);
      }
    }

    const roles = routingRolesFor();
    let recipients: Set<string>;
    if (options.leadOnlyAtPrompt) {
      // First rung of the prompt ladder for a non-lead seat: the team's own lead/operator at once;
      // the entity's orchestrator and the owner are reached only if the lead does not clear it
      // within `prompt_escalation_seconds` (or immediately when the blocked seat IS the lead).
      recipients = new Set<string>();
      for (const lead of leads) recipients.add(lead);
      if (team.operator !== '') recipients.add(team.operator);
    } else {
      recipients = recipientsForEvent(
        {
          kind: eventInput.kind,
          ...(eventInput.seat !== undefined ? { seat: eventInput.seat } : {}),
          ...(eventInput.from !== undefined ? { from: eventInput.from } : {}),
          ...(eventInput.to !== undefined ? { to: eventInput.to } : {}),
          ...(eventInput.subject !== undefined ? { subject: eventInput.subject } : {}),
          ...(eventInput.prompt !== undefined ? { prompt: eventInput.prompt } : {}),
        },
        roles,
      );
      if (eventInput.to === 'owner') recipients.add('owner');
    }

    const escalatedMailboxPaths: string[] = [];
    if (
      options.climbMailboxWhy !== undefined
      && input.home !== undefined
      && input.root !== undefined
      && eventInput.seat !== undefined
    ) {
      const target = resolveEntityTarget();
      if (target !== null && target.seat !== eventInput.seat) {
        const stamp = (eventInput.ts ?? new Date(now()).toISOString()).replace(/[^0-9A-Za-z]/g, '');
        const climbed = eventInput.kind === 'seat.prompt-escalated';
        const outcome = writeRuntimeMailboxRecord({
          root: target.root,
          home: input.home,
          to: target.seat,
          id: `evt-prompt-${climbed ? 'climb' : 'lead'}-${eventInput.seat}-${stamp}`,
          text: `${team.project}: ${options.climbMailboxWhy}`,
          session: target.session,
          at: eventInput.ts,
        });
        if (outcome.ok) escalatedMailboxPaths.push(outcome.path);
      }
    }

    let notifiedOwner = false;
    if (options.notifyOwner && source.notify !== undefined) {
      source.notify(team.project, eventInput.reason ?? `${eventInput.seat ?? session}: ${eventInput.kind}`);
      notifiedOwner = true;
    }

    return {
      input: eventInput,
      ...(record !== undefined ? { record } : {}),
      recipients,
      notifiedOwner,
      escalatedMailboxPaths,
    };
  }

  function applyStatusTransition(
    seatName: string,
    rawStatus: HerdrAgentStatus,
    at: number,
    pane = `${seatName}:p1`,
    allowUnreliable = false,
    rawScreen?: string,
  ): SeatStatusStep {
    const seat = team.seats.find((item) => item.name === seatName);
    if (!seat) {
      return { seat: seatName, status: rawStatus, events: [], nudgeDue: false, skipped: 'missing' };
    }
    if (seat.human === true) {
      return { seat: seatName, status: rawStatus, events: [], nudgeDue: false, skipped: 'human' };
    }
    if (seat.stopped === true) {
      return { seat: seatName, status: rawStatus, events: [], nudgeDue: false, skipped: 'stopped' };
    }
    if (!allowUnreliable && herdrUnreliable(seat.cli)) {
      return { seat: seatName, status: rawStatus, events: [], nudgeDue: false, skipped: 'unreliable' };
    }

    // Reconcile status with screen only for CLIs whose herdr status can report `idle` while working
    // (`antigravity`/`gemini`), `done` while running (`cursor`), or unreliable status (`jules`).
    let status: HerdrAgentStatus = isScreenVerifiedStatusCli(seat.cli)
      ? reconcileStatusWithScreen(seat.cli, rawStatus, rawScreen)
      : rawStatus;
    if (
      rawScreen === undefined
      && isScreenVerifiedStatusCli(seat.cli)
      && status !== 'blocked'
      && shouldReadScreenForStatus(seat, status, true)
      && source.readUnreliableScreen !== undefined
    ) {
      const target = seatTargetOf(seatName, pane)!;
      const screen = source.readUnreliableScreen(target);
      if (
        screen.kind === 'permission'
        || screen.kind === 'trust'
        || screen.kind === 'question'
        || screen.kind === 'exit question'
        || screen.kind === 'vendor notice'
        || screen.kind === 'rate limit'
      ) {
        status = 'blocked';
      } else if (
        screen.kind === 'working'
        && ((herdrUnreliable(seat.cli) && (status === 'idle' || status === 'done'))
          || ((seat.cli === 'antigravity' || seat.cli === 'gemini') && status === 'idle')
          || (seat.cli === 'cursor' && status === 'done'))
      ) {
        status = 'working';
      }
    }

    let state = states.get(seatName);
    if (!state) {
      state = { seq: 0 };
      states.set(seatName, state);
    }
    state.rawStatus = rawStatus;

    const isLead = leads.has(seatName);
    const events: EmittedStatusEvent[] = [];
    let nudgeDue = false;
    const ts = new Date(at).toISOString();

    if (status === 'unknown') {
      input.onLog?.(seatName, `${seatName}: herdr reports the status "unknown"`);
      return { seat: seatName, status, events, nudgeDue: false };
    }

    if (status === 'blocked') {
      delete state.idleStretch;
      // 1. Already blocked: no second `seat.at-prompt`; check if escalation window has elapsed.
      if (state.status === 'blocked' && state.promptSpell && state.promptSpell.clearedAt === undefined) {
        if (!state.promptSpell.escalated && !isLead && at - state.promptSpell.since >= escalationWindowMs) {
          state.promptSpell.escalated = true;
          const promptLabel = state.promptSpell.prompt === 'unknown' ? 'blocked' : state.promptSpell.prompt;
          const reason = `${seatName} is still at a ${promptLabel} prompt after ${minutes(escalationWindowMs)} minutes: the team's lead has not cleared it, and the entity's lead and the owner are told`;
          events.push(
            recordEvent(
              {
                ts,
                kind: 'seat.prompt-escalated',
                session,
                record_id: `status:prompt-escalated:${seatName}:${new Date(state.promptSpell.since).toISOString()}`,
                seat: seatName,
                subject: seatName,
                ...(state.promptSpell.prompt !== 'unknown' ? { prompt: state.promptSpell.prompt } : {}),
                to: 'owner',
                reason,
              },
              { notifyOwner: true, climbMailboxWhy: reason },
            ),
          );
        }
        return { seat: seatName, status, events, nudgeDue: false };
      }

      // 2. Flicker (`blocked -> working -> blocked` within the 1-pass grace): resume the open spell
      //    without emitting a second `seat.at-prompt` or notifying a second time.
      if (
        state.promptSpell !== undefined
        && state.promptSpell.clearedAt !== undefined
        && at - state.promptSpell.clearedAt <= graceMs
      ) {
        delete state.promptSpell.clearedAt;
        state.status = 'blocked';
        if (!state.promptSpell.escalated && !isLead && at - state.promptSpell.since >= escalationWindowMs) {
          state.promptSpell.escalated = true;
          const promptLabel = state.promptSpell.prompt === 'unknown' ? 'blocked' : state.promptSpell.prompt;
          const reason = `${seatName} is still at a ${promptLabel} prompt after ${minutes(escalationWindowMs)} minutes: the team's lead has not cleared it, and the entity's lead and the owner are told`;
          events.push(
            recordEvent(
              {
                ts,
                kind: 'seat.prompt-escalated',
                session,
                record_id: `status:prompt-escalated:${seatName}:${new Date(state.promptSpell.since).toISOString()}`,
                seat: seatName,
                subject: seatName,
                ...(state.promptSpell.prompt !== 'unknown' ? { prompt: state.promptSpell.prompt } : {}),
                to: 'owner',
                reason,
              },
              { notifyOwner: true, climbMailboxWhy: reason },
            ),
          );
        }
        return { seat: seatName, status, events, nudgeDue: false };
      }

      // 3. Fresh transition into `blocked`: read the screen once via `promptKind`.
      const target = seatTargetOf(seatName, pane)!;
      const fromScreen = rawScreen ? classifyPromptKind(seat.cli, rawScreen) : 'unknown';
      const prompt = fromScreen !== 'unknown'
        ? fromScreen
        : source.promptKind
          ? source.promptKind(target)
          : 'unknown';
      state.status = 'blocked';
      state.promptSpell = {
        prompt,
        since: at,
        escalated: isLead,
      };
      state.seq += 1;
      const reason = prompt === 'unknown'
        ? `${seatName} is blocked, and its screen is not one the watch recognises`
        : `${seatName} waits at a ${prompt} prompt`;

      if (isLead) {
        // The blocked seat IS the lead: skip the first rung and escalate at once to entity's
        // orchestrator and owner with a desktop notification.
        const climbWhy = `${reason} — its lead is the seat at the prompt, so the climb starts above it`;
        events.push(
          recordEvent(
            {
              ts,
              kind: 'seat.at-prompt',
              session,
              record_id: `status:at-prompt:${seatName}:${ts}:${state.seq}`,
              seat: seatName,
              subject: seatName,
              ...(prompt !== 'unknown' ? { prompt } : {}),
              to: 'owner',
              reason,
            },
            { notifyOwner: true, climbMailboxWhy: climbWhy },
          ),
        );
      } else {
        // Non-lead seat: notify the seat's lead at once; start the escalation clock.
        events.push(
          recordEvent(
            {
              ts,
              kind: 'seat.at-prompt',
              session,
              record_id: `status:at-prompt:${seatName}:${ts}:${state.seq}`,
              seat: seatName,
              subject: seatName,
              ...(prompt !== 'unknown' ? { prompt } : {}),
              reason,
            },
            { notifyOwner: false, leadOnlyAtPrompt: true },
          ),
        );
        if (escalationWindowMs === 0) {
          state.promptSpell.escalated = true;
          const promptLabel = prompt === 'unknown' ? 'blocked' : prompt;
          const climbReason = `${seatName} is still at a ${promptLabel} prompt after 0 minutes: the team's lead has not cleared it, and the entity's lead and the owner are told`;
          events.push(
            recordEvent(
              {
                ts,
                kind: 'seat.prompt-escalated',
                session,
                record_id: `status:prompt-escalated:${seatName}:${ts}:${state.seq}`,
                seat: seatName,
                subject: seatName,
                ...(prompt !== 'unknown' ? { prompt } : {}),
                to: 'owner',
                reason: climbReason,
              },
              { notifyOwner: true, climbMailboxWhy: climbReason },
            ),
          );
        }
      }
      return { seat: seatName, status, events, nudgeDue: false };
    }

    if (status === 'working') {
      delete state.idleStretch;
      if (state.status === 'working') {
        return { seat: seatName, status, events, nudgeDue: false };
      }
      const wasBlocked =
        state.status === 'blocked'
        || (state.promptSpell !== undefined && state.promptSpell.clearedAt === undefined);
      state.status = 'working';
      if (wasBlocked && state.promptSpell !== undefined) {
        state.promptSpell.clearedAt = at;
        state.seq += 1;
        const prompt = state.promptSpell.prompt;
        events.push(
          recordEvent({
            ts,
            kind: 'seat.unblocked',
            session,
            record_id: `status:unblocked:${seatName}:${ts}:${state.seq}`,
            seat: seatName,
            subject: seatName,
            ...(prompt !== 'unknown' ? { prompt } : {}),
            reason: `${seatName} cleared its prompt and is working`,
          }),
        );
      }
      return { seat: seatName, status, events, nudgeDue: false };
    }

    if (status === 'done') {
      delete state.promptSpell;
      if (state.status !== 'done') {
        state.status = 'done';
        state.idleStretch ??= { since: at, emitted: false, nudged: false };
        state.seq += 1;
        events.push(
          recordEvent({
            ts,
            kind: 'seat.done',
            session,
            record_id: `status:done:${seatName}:${ts}:${state.seq}`,
            seat: seatName,
            subject: seatName,
            reason: `${seatName} finished its turn`,
          }),
        );
      }
      return { seat: seatName, status, events, nudgeDue: false };
    }

    // `status === 'idle'`
    delete state.promptSpell;
    state.status = 'idle';
    const stretch = (state.idleStretch ??= { since: at, emitted: false, nudged: false });
    const idleWindowMs = idleWindowMsFor(seatName);
    if (
      !stretch.emitted
      && !isLead
      && !seat.parked
      && !seat.stopped
      && seat.human !== true
      && at - stretch.since >= idleWindowMs
      && hasAssignedWorkForSeat(seatName, at)
    ) {
      stretch.emitted = true;
      if (!stretch.nudged) {
        stretch.nudged = true;
        nudgeDue = true;
        pendingNudges.add(seatName);
        input.onNudge?.(seatName, pane);
      }
      events.push(
        recordEvent({
          ts,
          kind: 'seat.idle',
          session,
          record_id: `status:idle:${seatName}:${new Date(stretch.since).toISOString()}`,
          seat: seatName,
          subject: seatName,
          reason: `${seatName} has been idle for ${minutes(at - stretch.since)} minutes`,
        }),
      );
    }

    return { seat: seatName, status, events, nudgeDue };
  }

  function tickSync(atMs = now()): EmittedStatusEvent[] {
    const emitted: EmittedStatusEvent[] = [];
    const ts = new Date(atMs).toISOString();
    for (const [seatName, state] of states.entries()) {
      const seat = team.seats.find((item) => item.name === seatName);
      if (!seat || seat.human === true || seat.stopped === true) continue;
      const isLead = leads.has(seatName);

      if (
        state.status === 'blocked'
        && state.promptSpell !== undefined
        && state.promptSpell.clearedAt === undefined
        && !state.promptSpell.escalated
        && !isLead
        && atMs - state.promptSpell.since >= escalationWindowMs
      ) {
        state.promptSpell.escalated = true;
        const promptLabel = state.promptSpell.prompt === 'unknown' ? 'blocked' : state.promptSpell.prompt;
        const reason = `${seatName} is still at a ${promptLabel} prompt after ${minutes(escalationWindowMs)} minutes: the team's lead has not cleared it, and the entity's lead and the owner are told`;
        emitted.push(
          recordEvent(
            {
              ts,
              kind: 'seat.prompt-escalated',
              session,
              record_id: `status:prompt-escalated:${seatName}:${new Date(state.promptSpell.since).toISOString()}`,
              seat: seatName,
              subject: seatName,
              ...(state.promptSpell.prompt !== 'unknown' ? { prompt: state.promptSpell.prompt } : {}),
              to: 'owner',
              reason,
            },
            { notifyOwner: true, climbMailboxWhy: reason },
          ),
        );
      }

      if (
        (state.status === 'idle' || state.status === 'done')
        && state.idleStretch !== undefined
        && !state.idleStretch.emitted
        && !isLead
        && !seat.parked
        && atMs - state.idleStretch.since >= idleWindowMsFor(seatName)
        && hasAssignedWorkForSeat(seatName, atMs)
      ) {
        state.idleStretch.emitted = true;
        if (!state.idleStretch.nudged) {
          state.idleStretch.nudged = true;
          pendingNudges.add(seatName);
          input.onNudge?.(seatName, `${seatName}:p1`);
        }
        emitted.push(
          recordEvent({
            ts,
            kind: 'seat.idle',
            session,
            record_id: `status:idle:${seatName}:${new Date(state.idleStretch.since).toISOString()}`,
            seat: seatName,
            subject: seatName,
            reason: `${seatName} has been idle for ${minutes(atMs - state.idleStretch.since)} minutes`,
          }),
        );
      }
    }
    return emitted;
  }

  async function publishEmitted(events: readonly EmittedStatusEvent[]): Promise<void> {
    if (input.publish === undefined || input.root === undefined) return;
    for (const ev of events) {
      await input.publish(input.root, ev.input).catch(() => {});
    }
  }

  return {
    observeSync(seatName, status, atMs = now(), pane, rawScreen) {
      return applyStatusTransition(seatName, status, atMs, pane, false, rawScreen);
    },

    async observe(seatName, status, atMs = now(), pane, rawScreen) {
      const step = applyStatusTransition(seatName, status, atMs, pane, false, rawScreen);
      await publishEmitted(step.events);
      return step;
    },

    tickSync,

    async tick(atMs = now()) {
      const events = tickSync(atMs);
      await publishEmitted(events);
      return events;
    },

    async pollUnreliableSeat(seatName, rawScreen, atMs = now(), pane) {
      const target = seatTargetOf(seatName, pane);
      if (!target) {
        return { seat: seatName, status: 'unknown', events: [], nudgeDue: false, skipped: 'missing' };
      }
      if (target.human === true) {
        return { seat: seatName, status: 'unknown', events: [], nudgeDue: false, skipped: 'human' };
      }
      if (target.stopped === true) {
        return { seat: seatName, status: 'unknown', events: [], nudgeDue: false, skipped: 'stopped' };
      }
      const screen = rawScreen !== undefined
        ? readScreen(target.cli, rawScreen)
        : source.readUnreliableScreen
          ? source.readUnreliableScreen(target)
          : { kind: 'unknown' as const };
      const word = screenWord(screen);
      const step = applyStatusTransition(seatName, word, atMs, target.pane, true, rawScreen);
      await publishEmitted(step.events);
      return step;
    },

    async waitSeatOnce(seatName, timeoutMs = 30_000, pane, signal) {
      const target = seatTargetOf(seatName, pane);
      if (!target) {
        return {
          seat: seatName,
          outcome: 'skipped',
          rearmed: false,
          skipped: 'missing',
          events: [],
          nudgeDue: false,
        };
      }
      if (target.human === true) {
        return {
          seat: seatName,
          outcome: 'skipped',
          rearmed: false,
          skipped: 'human',
          events: [],
          nudgeDue: false,
        };
      }
      if (target.stopped === true) {
        return {
          seat: seatName,
          outcome: 'skipped',
          rearmed: false,
          skipped: 'stopped',
          events: [],
          nudgeDue: false,
        };
      }
      if (herdrUnreliable(target.cli)) {
        return {
          seat: seatName,
          outcome: 'skipped',
          rearmed: false,
          skipped: 'unreliable',
          events: [],
          nudgeDue: false,
        };
      }

      const seatState = states.get(seatName);
      const current = seatState?.status;
      const currentRaw = seatState?.rawStatus ?? current;
      const waitTarget: StatusTarget =
        currentRaw !== undefined && currentRaw !== 'unknown' ? { not: currentRaw } : { not: 'unknown' };

      let waited: StatusWaitResult;
      try {
        waited = await source.waitStatus(target, waitTarget, timeoutMs, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        input.onLog?.(seatName, `herdr wait agent-status failed: ${message}`);
        return {
          seat: seatName,
          outcome: 'error',
          rearmed: false,
          error: message,
          events: [],
          nudgeDue: false,
        };
      }

      if (waited.outcome === 'changed') {
        const step = await this.observe(seatName, waited.status, waited.at, target.pane);
        return {
          seat: seatName,
          outcome: 'changed',
          status: step.status,
          rearmed: true,
          events: step.events,
          nudgeDue: step.nudgeDue,
        };
      }

      if (waited.outcome === 'timeout') {
        const tickAt = waited.at > 0 ? waited.at : now();
        const dueEvents = await this.tick(tickAt);
        const seatEvents = dueEvents.filter((ev) => ev.input.seat === seatName);
        return {
          seat: seatName,
          outcome: 'timeout',
          ...(current !== undefined ? { status: current } : {}),
          rearmed: true,
          events: seatEvents,
          nudgeDue: seatEvents.some((ev) => ev.input.kind === 'seat.idle') && !leads.has(seatName),
        };
      }

      input.onLog?.(seatName, `herdr wait agent-status error: ${waited.error}`);
      return {
        seat: seatName,
        outcome: 'error',
        rearmed: false,
        error: waited.error,
        events: [],
        nudgeDue: false,
      };
    },

    startWaiters(panesBySeat, options = {}) {
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? 30_000;
      const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
      const errorBackoffMs = options.errorBackoffMs ?? 1_000;

      const sleepOrAbort = (ms: number): Promise<void> =>
        new Promise<void>((resolve) => {
          if (controller.signal.aborted || ms <= 0) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, ms);
          controller.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });

      const loops: Promise<void>[] = [];
      for (const seat of team.seats) {
        const pane = panesBySeat[seat.name];
        if (!pane || !isStatusWaiterSeat(seat)) continue;
        loops.push(
          (async () => {
            let iterations = 0;
            while (!controller.signal.aborted && iterations < maxIterations) {
              iterations += 1;
              const prevStatus = states.get(seat.name)?.status;
              const beforeMs = now();
              const step = await this.waitSeatOnce(seat.name, timeoutMs, pane, controller.signal);
              if (controller.signal.aborted || step.outcome === 'skipped') break;
              if (step.outcome === 'error') {
                if (errorBackoffMs <= 0) break;
                await sleepOrAbort(errorBackoffMs);
                continue;
              }
              if (
                (step.outcome === 'timeout' || step.status === prevStatus)
                && iterations < maxIterations
                && now() <= beforeMs
              ) {
                // Synchronous stub in tests that returned timeout or unchanged status without advancing
                // the clock: yield on an abortable timer so the background loop does not spin.
                await sleepOrAbort(Math.min(timeoutMs, 50));
              }
            }
          })(),
        );
      }

      return {
        stop() {
          controller.abort();
        },
        done: Promise.all(loops).then(() => {}),
      };
    },

    drainNudges() {
      const nudged = [...pendingNudges];
      pendingNudges.clear();
      return nudged;
    },

    statusOf(seatName) {
      return states.get(seatName)?.status;
    },
  };
}
