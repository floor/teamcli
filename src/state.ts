import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoredReading, StoredSpend } from './budgets/readings.ts';
import { BRIEF_ID_PATTERN, isBriefEpoch, isBriefId, isBriefIncarnation } from './launch/brief-id.ts';
import { validLockName } from './lock/name.ts';
import type { CliWatcher } from './launch/cli-hook.ts';
import type { LaunchedIdentity } from './launch/identity.ts';
import { cleanClassification, type Classification } from './launch/progress.ts';
import { cleanIdleClaims, type IdleClaimEntry } from './watch/claim-record.ts';
import { isWatchEpoch } from './watch/epoch.ts';
import { isPresenceBinding } from './daemon/presence/contract.ts';
import type { CodexEndpointRecord } from './daemon/presence/endpoint-record.ts';

// What a team keeps: the live session's seats, worktrees and watch, and the project's last
// readings, which outlive every session (§ 4.4). It lives beside the team file and is written by
// team alone: every write holds the lock and goes through a temporary file.

export const SEAT_ID_PATTERN = /^seat_[0-9a-f]{12}$/;

export { BRIEF_ID_PATTERN };

export function isSeatId(value: unknown): value is string {
  return typeof value === 'string' && SEAT_ID_PATTERN.test(value);
}

export function mintSeatId(): string {
  return `seat_${randomBytes(6).toString('hex')}`;
}

export type RetainedSeat = {
  id: string;
  last_active?: string;
};

/**
 * One seat's general-brief claim. `id` and `at` were the whole record before claims existed; a
 * claim written by an older build keeps them and carries none of the fields below, so it is
 * readable but stale — no reader serves it and the check names the seat until a delivery writes
 * a current claim. The claim is written before the drop and finalized (`stage: 'ready'`) once
 * the drop verifies, so a launch that dies between the two leaves a claim the next launch can
 * repair rather than a silent gap. `superseded` keeps the newest 50 earlier ids, bounded so the
 * state file cannot grow with a recovery loop.
 */
export type BriefRecord = {
  id: string;
  at: string;
  /** Delivery lifetime: kept across a reword, minted again for a new seat or a recovery. */
  incarnation?: string;
  /** The runtime epoch a running reader was started with; a receipt counts only while it matches. */
  epoch?: string;
  /** The delivered body's sha256, as the claim records it. */
  sha256?: string;
  /** Delivery attempt: 0 on the first, one more for each recovery from a held name. */
  attempt?: number;
  /** `claimed` while the drop is being written; `ready` once it was read back and verified. */
  stage?: 'claimed' | 'ready';
  /** The seat handle the launch wrote the drop for, when the registry had one. */
  seat_handle?: string;
  /** The pane the delivery's launch was recording, when it named one. */
  pane?: string;
  /** The pane's root process id at delivery, so a replaced pane can be told from the same one. */
  pane_root_pid?: number;
  /** Earlier ids this claim replaced, oldest first, newest 50 kept. */
  superseded?: readonly string[];
};

export type SeatState = {
  /** Stable seat handle (`seat_<12 lowercase hex>`), minted when the seat is first recorded. */
  id?: string;
  stage: 'launched' | 'named' | 'ready';
  /** The CLI the seat was launched with: `down` stops it under it when the file renamed it. */
  cli?: string;
  /**
   * How the seat's CLI learns a drop is waiting: the turn-start hook the launch installed, the
   * MCP inbox its profile registers, or nothing. Written by the launch; absent on a seat
   * launched before it was recorded.
   */
  watcher?: CliWatcher;
  /** ISO 8601 timestamp when the seat last reached ready or was seen working. */
  last_active?: string;
  pane?: string;
  /** The herdr workspace, so a later command can close it without listing agents. */
  workspace?: string;
  /**
   * The folder the seat's launch line was run in, when the state records it. A resumed seat's
   * pane keeps that folder, so its launch line is checked there, never against the file's.
   */
  start_cwd?: string;
  cli_version?: string;
  rules?: 'option' | 'message' | 'prepend' | 'undelivered';
  worked?: boolean;
  /**
   * The process `team` launched for this seat, read after its idle prompt appeared: the pane's
   * shell pid and the foreground pids that are not the shell. A pane that no longer holds them
   * is not the seat (`src/launch/identity.ts`). Absent on a seat launched before this was
   * recorded, and on one herdr could not tell about: both keep today's behaviour.
   */
  launched?: LaunchedIdentity;
  /**
   * The agent session herdr reported for this seat when its idle prompt appeared, beside the
   * process ids. A later pane whose pids differ and whose live session equals this one is the
   * seat (`replacedSeat`). The same id is written to the agent registry's `reach.agent_session`
   * by the register and launch paths. Absent when the launch's reading had none.
   */
  agent_session?: string;
  /**
   * The presence runtime incarnation of the seat's current launch (`prs_<12 lowercase hex>`),
   * minted when that launch installs a presence writer and compared whole by the daemon's
   * presence ingester. Presence events carry it, so a late event from a predecessor process
   * cannot move a successor seat; a mismatch is set aside, never repaired. Internal state, not
   * a credential or a public identity, and never printed. Absent when the launch installs no
   * presence writer, which the ingester treats as no live presence rather than guessing.
   */
  presence_binding?: string;
  /**
   * The app-server endpoint the seat's managed launch started and owns, recorded in the same
   * locked write that re-checks `presence_binding` (`binding` must equal it). `binding` is the
   * presence incarnation the endpoint serves, so a predecessor server can never serve a
   * successor: its path carries the binding. Consumers may use `url` only while the two bindings
   * agree and the URL is an explicit `unix:///…` endpoint; otherwise the endpoint is unknown,
   * never guessed from `~/.codex`. `pid` names the process the launch started, for its own
   * cleanup. Written only by the managed launch, never by the daemon: internal state, never a
   * public identity.
   */
  codex_endpoint?: CodexEndpointRecord;
  /**
   * The daemon's activity reconciler's fence: the newest applied presence line of the seat's
   * current runtime binding that the canonical state has reconciled. `seq` must equal the current
   * projection's sequence for a consumer to treat the reading as known; while either side is
   * ahead the answer is `unknown`, never idle and never a stale claim. `applied_at` is the
   * writer's instant, never invented from the event. Absent until the first applied line.
   */
  presence_applied?: {
    seat_id: string;
    binding: string;
    seq: number;
    applied_at: string;
  };
  /**
   * The activity reconciler's own resume point in the seat's transition log, persisted separately
   * from `presence_applied`: it advances over every line read — audit lines that never became the
   * projection and predecessor-incarnation lines included — so a skipped line is never re-read
   * forever. Private to the scanner; no reader treats it as presence evidence.
   */
  presence_scan?: {
    binding: string | null;
    seq: number;
    offset: number;
  };
  /**
   * What this launch declared, written when the idle prompt appears and left in place when a
   * later ready write merges onto the record. A skip of a seat that is already ready does not
   * set them: the file may have drifted, and the record has to stay the launch. Absent on a
   * seat launched before they were stored.
   */
  model?: string;
  version?: string;
  /** Absent when the launch set no effort word. A later launch that sets none removes it. */
  effort?: string;
  /** The launch command of that idle record. Stored for the registry; reload does not compare it. */
  launch_line?: string;
  // `own_commits` is the home for a temporary seat whose end is `merged:` and that has no worktree.
  // A seat in a worktree keeps that record on the worktree instead.
  temporary?: { like: string; until: string; task?: string; own_commits?: boolean };
  /**
   * Set when a launch left the pane at a dialog. `waiting-owner` is the stored name
   * even when the orchestrator may answer: it is waiting for an authorised human path.
   */
  waiting?: {
    state: 'waiting-owner' | 'trust-sent-recovery';
    classification: Classification;
    manual?: true;
    sentAt?: string;
    version?: string;
    folder?: string;
  };
};

/** A seat's waiting record, as the seat shape above stores it. Named for the plan and the
 *  pause, which carry it between the state and the prompt. */
export type WaitingRecord = NonNullable<SeatState['waiting']>;

/**
 * Whether a state seat's record is one the team file still speaks for: a seat the file
 * declares, or a temporary seat — `team add --temporary` never writes one into the file, so
 * its record is the only place it exists. Any other record names a seat the file no longer
 * has, and the commands that resolve who holds a pane read past it: the file is the truth,
 * and only `team check --repair` drops the record.
 */
export function seatOfFile(name: string, seat: SeatState, declared: ReadonlySet<string>): boolean {
  return seat.temporary !== undefined || declared.has(name);
}

export type WorktreeState = {
  path: string;
  branch: string;
  own_commits?: boolean;
  seat?: string;
  setup: 'ok' | 'failed';
};

export type SwapRecord = { by: string; at: string };

/** The model fields a swap moves a seat between, as the file declares them. */
export type SwapModel = {
  cli: string;
  vendor: string;
  model: string;
  version: string;
  display: string;
};

/**
 * One queued model swap (Policies rule 11): the seat takes no new task while the
 * record stands, waits for the boundary the watch observes, and past `deadline` runs at the next
 * pause between two turns. `from` and `to` are the file's words at queue time; `to` carries the
 * launch line and the optional model fields a recipe brought. `waitFor` is the one line `status`
 * prints under the seat's row. `forced` is the owner's `team swap now`: the log says the deadline
 * did not decide. A record is the project's, not one session's, like the hold and the pause.
 */
export type QueuedSwap = {
  from: SwapModel;
  to: SwapModel & {
    launch: string;
    modelFrom?: 'launcher';
    effort?: string;
    account?: string;
  };
  reason: 'model-rule' | 'config' | 'owner';
  queuedAt: string;
  deadline: string;
  waitFor: string;
  /** The rule value in force when a rule-driven swap was queued. */
  rule?: string;
  /**
   * The handover file the old conversation is asked to write, when the launch will not resume
   * it: named when the swap is queued, so a run retried after a busy turn offers the same path
   * and a file already written is used without asking again.
   */
  handover?: string;
  forced?: { by: string; at: string };
};

/**
 * A hold on the team's work: the reason it was placed, who placed it and when, and the instant
 * it lapses (`until` absent: it stands until released). A hold past its `until` reads as no
 * hold at all (`liveHold`), so an expired record needs no writer to clear it.
 */
export type HoldRecord = { reason: string; by: string; at: string; until?: string };

/**
 * One seat's place when the team was paused: the stage its record held, the branch and folder of
 * the worktree it was given, and when it was last active. The pause writes a stop point for every
 * seat the file declares that is not a human's, so the lead restarts from what the tool recorded
 * rather than from memory. Human seats are never recorded: a pause does not touch them.
 */
export type PauseStop = {
  seat: string;
  stage?: SeatState['stage'];
  branch?: string;
  path?: string;
  last_active?: string;
};

/**
 * The team's pause: when it was placed, by whom, the reason when one was given, and the stop
 * points it recorded. A pause stands until `team resume` clears it; unlike a hold it names no
 * end, because the resume is the owner's next act, not a clock. A pause is the project's, not one
 * session's.
 */
export type PauseRecord = {
  by: string;
  at: string;
  reason?: string;
  stops: PauseStop[];
};

/**
 * One process a seat started, recorded by `team proc add`: who recorded it, when, the pid to
 * watch, and what it is. Nothing here launches or signals a process — a record is a seat's
 * note that something of its own is running, and a pid is how the note goes out on its own.
 */
export type ProcRecord = {
  /** The seat's herdr name, or `owner` for the owner at a terminal. */
  by: string;
  /** ISO 8601, printed as stored, one shape everywhere. */
  at: string;
  /** The process id to watch. Absent when the caller recorded no pid: the note then stands
   *  until `done` clears it. */
  pid?: number;
  /** One cleaned line: what the process is. */
  note?: string;
};

export type SessionState = {
  started?: { at: string; by: string };
  seats: Record<string, SeatState>;
  /**
   * Seat handles retained across `remove --keep`, `down`, and `up` repair so a declared seat keeps
   * its `id` and `last_active` when relaunched, while `seats` holds only active runtime records.
   */
  retained_seats?: Record<string, RetainedSeat>;
  /**
   * The general seat brief delivered to each seat: the record's id and when it landed, written by
   * the launch that wrote the drop. `team check` reads it to name a seat the brief never reached;
   * only a launch writes it, and only the delivery's own record is trusted to name its time. No
   * `rules` value and no stage: a seat's brief is not its lifecycle.
   */
  briefs?: Record<string, BriefRecord>;
  /**
   * A lead seat (the orchestrator's or the operator's) stopped for a replacement by `team remove
   * <lead> --keep`: who stopped it and when. The file is not edited — a lead is never `stopped:` —
   * so this record is what tells `doctor`, `status` and the next `add` that the gap is a swap in
   * progress and not a crash. `team add <lead>` (or `up`) clears it once the seat runs again.
   */
  swapping?: Record<string, SwapRecord>;
  worktrees: Record<string, WorktreeState>;
  /**
   * The watch: the pane and workspace it runs in, the process once a pass has recorded one, and
   * the last heartbeat. `pid` is absent from the moment `up` — or an owner's own run — starts the
   * watch until that pane's first pass records its process; `pane` is absent only on a record an
   * older detached watch left. `epoch` is the host's authority fence (`watch_` and 32 lowercase
   * hex); its absence marks a pane watch record, and a value this build cannot read is dropped at
   * the read door.
   */
  watch?: { pid?: number; heartbeat: string; pane?: string; workspace?: string; epoch?: string };
  /** The event bus `team up` started for this session: its pane and workspace, for `team down`. */
  bus?: { pane: string; workspace?: string; started: string };
  /**
   * The team file this session was launched from. A lead in the lobby resolves it from a pane
   * the state records, and from no other path. Absent on a session started before it was written.
   */
  launched_file?: string;
  /**
   * The team file `up` resolved, and who may read it. Written before the watch's pane runs its
   * command, because a flagless watch started in the project folder would miss this file or read
   * another one. The pane the record names, or the process a pass records on `watch.pid`, may
   * read it. Any other non-owner is refused.
   */
  watchdog?: { file: string; pane?: string };
  nudge?: { pending_since: string | null };
  /**
   * The processes this session's seats recorded with `team proc add`, by name. A record with a
   * `pid` is live while that pid is; one without a pid lives until `done`. Readers never tidy
   * the map — a dead record is skipped where it is read and leaves the file at the next write
   * to it (`add`, `done`), because expiry is a reading, never a timer.
   */
  procs?: Record<string, ProcRecord>;
  /**
   * One seat's spend of the watch's single direct-work attempt in one idle episode, keyed by seat
   * (src/watch/claim-record.ts holds the record's rules). The episode's identity is the seat's
   * persisted `last_active`, so the record survives a watch or host restart and a second host
   * reads the same spend. At most one entry per seat; no history. An entry this build cannot read
   * is kept as `{ unreadable: true }` at the read door — a malformed claim holds the episode, it
   * is never dropped to absence.
   */
  idle_claims?: Record<string, IdleClaimEntry>;
};

export type State = {
  format: 1;
  last_valid?: { read_at: string; file: string };
  /**
   * The project's last readings, whatever session saw them: a screen reading keyed by account,
   * window and seat, a check reading by account and window (§ 4.4).
   */
  budgets?: Record<string, StoredReading>;
  /** The project's last spend check readings, keyed by account. */
  spend?: Record<string, StoredSpend>;
  /**
   * The team's own hold: `team hold`'s one record, cleared by `team hold --release` and read as
   * absent once `until` has passed. A hold is the project's, not one session's.
   */
  hold?: HoldRecord;
  /**
   * The team's pause: `team pause`'s one record, cleared by `team resume`. While it stands, the
   * watch types no work nudge, `team next` claims nothing, and `status` and `seats` show it. Like
   * the hold it is the project's, not one session's.
   */
  pause?: PauseRecord;
  /**
   * One record per seat paused on its own with `team pause <seat>`, cleared by
   * `team resume <seat>`. While a seat's record stands, `team next` called by that seat claims
   * nothing and the watch types no work nudge or wake to it; the rest of the team keeps working.
   * The team-wide `pause` and this map are independent: either can stand without the other, and
   * a team resume clears only the team's record. Like the hold and the pause, the map is the
   * project's, not one session's.
   */
  seat_pauses?: Record<string, PauseRecord>;
  /**
   * Unsigned markers of expired policy declarations whose expiry reading has already been logged
   * to `team.log`, so the expiry reading is logged at most once per expired entry while leaving
   * the signed policy file untouched.
   */
  expired_policies?: string[];
  /**
   * The queued model swaps, by seat (Policies rule 11): the project's record, read and written
   * by `team swap` and carried out by the watch. A seat keeps no new task while its entry stands.
   */
  swaps?: Record<string, QueuedSwap>;
  sessions: Record<string, SessionState>;
};

export const STATE_FILE = 'team.state.json';
export const LOCK_FILE = 'team.lock';
export const LOG_FILE = 'team.log';

export function emptySession(): SessionState {
  return { seats: {}, worktrees: {} };
}

/** Whether a value from the state file is the record `team hold` writes: a reason with text, a
 *  name and an instant that parse, and an `until`, when present, that parses too. Anything else
 *  is dropped at the read door, so a hand-edited file can never print what it made up. */
function isHoldRecord(value: unknown): value is HoldRecord {
  if (value === null || typeof value !== 'object') return false;
  const hold = value as Partial<HoldRecord>;
  if (typeof hold.reason !== 'string' || hold.reason === '') return false;
  if (typeof hold.by !== 'string' || typeof hold.at !== 'string') return false;
  if (Number.isNaN(Date.parse(hold.at))) return false;
  if (hold.until !== undefined && (typeof hold.until !== 'string' || Number.isNaN(Date.parse(hold.until)))) return false;
  return true;
}

/** The hold in force at `now`: the stored record, or null when none stands — none stored, or
 *  one past its `until`. The record itself is left where it is; the next hold write replaces
 *  it. Every reader goes through here, so the expiry is one rule in one place. */
export function liveHold(state: State, now: Date): HoldRecord | null {
  const hold = state.hold;
  if (hold === undefined) return null;
  if (hold.until !== undefined && Date.parse(hold.until) <= now.getTime()) return null;
  return hold;
}

/** The hold as its readers print it — `team hold`'s own line, `status`'s note and `doctor`'s
 *  line: `hold until <instant>: <reason>`, or `hold: <reason>` when it names no end. One
 *  shape for every reader, so the three can never drift apart. */
export function holdText(hold: HoldRecord): string {
  return hold.until === undefined ? `hold: ${hold.reason}` : `hold until ${hold.until}: ${hold.reason}`;
}

/** Whether a value from the state file is the record `team pause` writes: who placed it, an
 *  instant that parses, a reason with text when one is there, and stop points whose every field
 *  is the shape the command writes. Anything else is dropped at the read door, so a hand-edited
 *  file can never print what it made up. */
function isPauseRecord(value: unknown): value is PauseRecord {
  if (value === null || typeof value !== 'object') return false;
  const pause = value as Partial<PauseRecord>;
  if (typeof pause.by !== 'string' || pause.by === '') return false;
  if (typeof pause.at !== 'string' || Number.isNaN(Date.parse(pause.at))) return false;
  if (pause.reason !== undefined && (typeof pause.reason !== 'string' || pause.reason === '')) return false;
  if (!Array.isArray(pause.stops)) return false;
  for (const stop of pause.stops) {
    if (stop === null || typeof stop !== 'object') return false;
    const entry = stop as Partial<PauseStop>;
    if (typeof entry.seat !== 'string' || entry.seat === '') return false;
    if (entry.stage !== undefined && entry.stage !== 'launched' && entry.stage !== 'named' && entry.stage !== 'ready') return false;
    if (entry.branch !== undefined && typeof entry.branch !== 'string') return false;
    if (entry.path !== undefined && typeof entry.path !== 'string') return false;
    if (entry.last_active !== undefined && (typeof entry.last_active !== 'string' || Number.isNaN(Date.parse(entry.last_active)))) return false;
  }
  return true;
}

/** The pause as its readers print it: `status`'s note and `seats`' header line, one shape for
 *  both, so the two can never drift apart. */
export function pauseText(pause: PauseRecord): string {
  return `paused since ${pause.at} by ${pause.by}${pause.reason === undefined ? '' : `: ${pause.reason}`}`;
}

/** One stop point as `team pause` and `team resume` print it under the pause's own line: what the
 *  seat's record held, and the worktree it was given when it had one. */
export function stopText(stop: PauseStop): string {
  const at: string[] = [];
  if (stop.stage !== undefined) at.push(stop.stage);
  if (stop.branch !== undefined) at.push(`branch ${stop.branch}`);
  if (stop.path !== undefined) at.push(stop.path);
  if (stop.last_active !== undefined) at.push(`last active ${stop.last_active}`);
  return `stop ${stop.seat}: ${at.length > 0 ? at.join(', ') : 'no record'}`;
}

const BRIEF_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * One brief claim as the state may hold it, or null when the entry does not hold an id and a
 * time at all. A field that is not the shape this build writes is dropped, not the whole claim:
 * an entry an older build wrote (`{id, at}` alone) stays readable as a stale claim, never served
 * and never deleted, so an upgrade cannot silently erase which seats received the old brief.
 */
function cleanedBrief(brief: unknown): BriefRecord | null {
  if (!brief || typeof brief !== 'object') return null;
  const raw = brief as Record<string, unknown>;
  if (!isBriefId(raw.id) || typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) return null;
  const claim: BriefRecord = { id: raw.id, at: raw.at };
  if (isBriefIncarnation(raw.incarnation)) claim.incarnation = raw.incarnation;
  if (isBriefEpoch(raw.epoch)) claim.epoch = raw.epoch;
  if (typeof raw.sha256 === 'string' && BRIEF_SHA256_PATTERN.test(raw.sha256)) claim.sha256 = raw.sha256;
  if (typeof raw.attempt === 'number' && Number.isInteger(raw.attempt) && raw.attempt >= 0) claim.attempt = raw.attempt;
  if (raw.stage === 'claimed' || raw.stage === 'ready') claim.stage = raw.stage;
  if (isSeatId(raw.seat_handle)) claim.seat_handle = raw.seat_handle;
  if (typeof raw.pane === 'string' && raw.pane !== '') claim.pane = raw.pane;
  if (typeof raw.pane_root_pid === 'number' && Number.isInteger(raw.pane_root_pid) && raw.pane_root_pid > 0) {
    claim.pane_root_pid = raw.pane_root_pid;
  }
  if (Array.isArray(raw.superseded)) {
    const ids: string[] = [];
    for (const id of raw.superseded) if (isBriefId(id) && !ids.includes(id)) ids.push(id);
    if (ids.length > 0) claim.superseded = ids.slice(-50);
  }
  return claim;
}

/** Whether a value from the state file is a swap's model word: the five fields the file declares
 *  and a recipe carries, each with text. */
function isSwapModel(value: unknown): value is SwapModel {
  if (value === null || typeof value !== 'object') return false;
  const model = value as Partial<SwapModel>;
  return ['cli', 'vendor', 'model', 'version', 'display'].every(
    (key) => typeof (model as Record<string, unknown>)[key] === 'string' && (model as Record<string, string>)[key] !== '',
  );
}

/** Whether a value from the state file is the record `team swap queue` writes. Anything else is
 *  dropped at the read door, so a hand-edited file can never print or run what it made up. */
function isQueuedSwap(value: unknown): value is QueuedSwap {
  if (value === null || typeof value !== 'object') return false;
  const swap = value as Partial<QueuedSwap>;
  if (!isSwapModel(swap.from) || !isSwapModel(swap.to)) return false;
  const to = swap.to as Partial<QueuedSwap['to']>;
  if (typeof to.launch !== 'string' || to.launch === '') return false;
  if (to.modelFrom !== undefined && to.modelFrom !== 'launcher') return false;
  if (to.effort !== undefined && typeof to.effort !== 'string') return false;
  if (to.account !== undefined && typeof to.account !== 'string') return false;
  if (swap.reason !== 'model-rule' && swap.reason !== 'config' && swap.reason !== 'owner') return false;
  if (typeof swap.queuedAt !== 'string' || Number.isNaN(Date.parse(swap.queuedAt))) return false;
  if (typeof swap.deadline !== 'string' || Number.isNaN(Date.parse(swap.deadline))) return false;
  if (typeof swap.waitFor !== 'string' || swap.waitFor === '') return false;
  if (swap.rule !== undefined && typeof swap.rule !== 'string') return false;
  if (swap.handover !== undefined && (typeof swap.handover !== 'string' || swap.handover === '')) return false;
  if (swap.forced !== undefined) {
    if (!swap.forced || typeof swap.forced.by !== 'string' || swap.forced.by === '') return false;
    if (typeof swap.forced.at !== 'string' || Number.isNaN(Date.parse(swap.forced.at))) return false;
  }
  return true;
}

// The state in `dir` (the folder of the team file). A missing file is an empty state; a file
// that can't be read as a state is an error, never silently replaced.
export function readState(dir: string): State {  const path = join(dir, STATE_FILE);
  if (!existsSync(path)) return { format: 1, sessions: {} };
  let parsed: unknown;
  try {
    // A file replaced under this reader (a writer that is not the atomic one) can parse as a
    // truncated prefix on the first read: the retry reads the settled file once more.
    parsed = readParsed(path, (text) => JSON.parse(text) as unknown);
  } catch {
    throw new Error(`${path} is not valid JSON; move it aside and run the command again`);
  }
  const state = parsed as Partial<State> | null;
  if (!state || typeof state !== 'object' || state.format !== 1 || typeof state.sessions !== 'object' || !state.sessions) {
    throw new Error(`${path} is not a team state of format 1; move it aside and run the command again`);
  }
  // The hold, cleaned at the same door: a record that is not the one `team hold` writes is
  // dropped here, so the reason, the name and the instants later readers print are the ones
  // the command wrote, never a hand-edited file's.
  if (state.hold !== undefined && !isHoldRecord(state.hold)) delete state.hold;
  // The pause, cleaned at the same door and for the same reason: the line every reader prints
  // is the record this command wrote, never a hand-edited file's.
  if (state.pause !== undefined && !isPauseRecord(state.pause)) delete state.pause;
  // The per-seat pauses are cleaned at the same door: a key that is not a name by the lock's
  // rule, a value that is not the record the command writes, or a record whose stop points do
  // not name its own seat is dropped. Only `team pause <seat>` writes a key, so a key that
  // survives this door is a seat name a reader prints.
  if (state.seat_pauses && typeof state.seat_pauses === 'object') {
    for (const [seat, record] of Object.entries(state.seat_pauses)) {
      if (!validLockName(seat) || !isPauseRecord(record)
        || !record.stops.some((stop) => stop.seat === seat)) delete state.seat_pauses[seat];
    }
    if (Object.keys(state.seat_pauses).length === 0) delete state.seat_pauses;
  } else if (state.seat_pauses !== undefined) {
    delete state.seat_pauses;
  }
  if (Array.isArray(state.expired_policies)) {
    state.expired_policies = state.expired_policies.filter((item): item is string => typeof item === 'string');
  } else if (state.expired_policies !== undefined) {
    delete state.expired_policies;
  }
  // The queue enters from the file like the hold and the pause, and is cleaned at the same door:
  // a key that is not a name by the lock's rule is dropped, and so is a record that is not the
  // one `team swap queue` writes. Only that command writes a key, and it refuses anything but
  // `validLockName`, so a key that survives this door is a seat name a reader prints.
  if (state.swaps && typeof state.swaps === 'object') {
    for (const [seat, swap] of Object.entries(state.swaps)) {
      if (!validLockName(seat) || !isQueuedSwap(swap)) delete state.swaps[seat];
    }
  } else if (state.swaps !== undefined) {
    delete state.swaps;
  }
  for (const session of Object.values(state.sessions)) {
    session.seats ??= {};
    session.worktrees ??= {};
    // The watch record enters from the file like every other value: a record whose heartbeat is
    // not text is not a watch, and an epoch this build does not write is dropped rather than
    // trusted as a fence. A pane watch record without an epoch stays one.
    if (session.watch !== undefined) {
      if (typeof session.watch !== 'object' || session.watch === null || Array.isArray(session.watch)
        || typeof session.watch.heartbeat !== 'string') {
        delete session.watch;
      } else if (session.watch.epoch !== undefined && !isWatchEpoch(session.watch.epoch)) {
        delete session.watch.epoch;
      }
    }
    // A stored classification is validated here, at the one door a value from outside the program
    // enters through: one of the closed list, or `unknown` for anything else. Every later reader —
    // the log line a waiting seat writes, the status row and its `difference:` line, the prompt a
    // resumed wait draws — takes the reading from here, so a hand-edited or corrupted record can
    // never print whatever it holds.
    const seenIds = new Set<string>();
    for (const seat of Object.values(session.seats)) {
      if (seat.id !== undefined && (!isSeatId(seat.id) || seenIds.has(seat.id))) delete seat.id;
      else if (seat.id !== undefined) seenIds.add(seat.id);
      if (seat.model !== undefined && typeof seat.model !== 'string') delete seat.model;
      if (seat.version !== undefined && typeof seat.version !== 'string') delete seat.version;
      if (seat.effort !== undefined && typeof seat.effort !== 'string') delete seat.effort;
      if (seat.launch_line !== undefined && typeof seat.launch_line !== 'string') delete seat.launch_line;
      if (seat.last_active !== undefined && typeof seat.last_active !== 'string') delete seat.last_active;
      // The presence fence and cursor enter from the file like every other value. The fence is
      // consumer evidence, so a malformed one is dropped whole — the consumer's answer is then
      // `unknown`, never a guess — and a malformed cursor only makes the scanner start over.
      if (seat.presence_applied !== undefined) {
        const fence = seat.presence_applied;
        if (fence === null || typeof fence !== 'object'
          || !isSeatId(fence.seat_id) || !isPresenceBinding(fence.binding)
          || !Number.isInteger(fence.seq) || fence.seq < 1
          || typeof fence.applied_at !== 'string' || Number.isNaN(Date.parse(fence.applied_at))) {
          delete seat.presence_applied;
        }
      }
      if (seat.presence_scan !== undefined) {
        const scan = seat.presence_scan;
        if (scan === null || typeof scan !== 'object'
          || !(scan.binding === null || isPresenceBinding(scan.binding))
          || !Number.isInteger(scan.seq) || scan.seq < 0
          || !Number.isInteger(scan.offset) || scan.offset < 0) {
          delete seat.presence_scan;
        }
      }
      // A session id is the measured string herdr reported, never an object handed to this build
      // by a hand-edited file: anything else is not an id and is dropped the way a malformed
      // model or launch line is.
      if (seat.agent_session !== undefined && (typeof seat.agent_session !== 'string' || seat.agent_session === '')) {
        delete seat.agent_session;
      }
      if (seat.waiting && typeof seat.waiting === 'object') {
        seat.waiting.classification = cleanClassification(seat.waiting.classification);
      }
    }
    // A brief claim enters from the file like every other value, and is cleaned here: the id is
    // the record id the drop leg writes, the time must parse, and every field this build does not
    // know the shape of is dropped rather than trusted. A seat name is a key, never a path, so any
    // non-empty one stands; only a launch writes the map. An entry with no id or no parseable time
    // is not a claim at all and is dropped; an old `{id, at}` entry is kept as a stale claim.
    if (session.briefs && typeof session.briefs === 'object') {
      for (const [seat, brief] of Object.entries(session.briefs)) {
        const claim = seat === '' ? null : cleanedBrief(brief);
        if (claim === null) delete session.briefs[seat];
        else session.briefs[seat] = claim;
      }
    } else if (session.briefs !== undefined) {
      delete session.briefs;
    }
    if (session.retained_seats && typeof session.retained_seats === 'object') {
      for (const [name, retained] of Object.entries(session.retained_seats)) {
        if (!retained || typeof retained !== 'object' || !isSeatId(retained.id) || seenIds.has(retained.id)) {
          delete session.retained_seats[name];
          continue;
        }
        seenIds.add(retained.id);
        if (retained.last_active !== undefined && typeof retained.last_active !== 'string') {
          delete retained.last_active;
        }
      }
    } else if (session.retained_seats !== undefined) {
      delete session.retained_seats;
    }
    if (session.swapping && typeof session.swapping === 'object') {
      for (const [name, swap] of Object.entries(session.swapping)) {
        if (!swap || typeof swap !== 'object' || typeof swap.by !== 'string' || typeof swap.at !== 'string') {
          delete session.swapping[name];
        }
      }
    } else if (session.swapping !== undefined) {
      delete session.swapping;
    }
    // A proc record enters from the file like every other value, and is cleaned here at the same
    // door: a key that is not a name by the lock's rule is dropped, and so is a record that does
    // not name who recorded it and when; a pid or note of the wrong shape goes with it. Only
    // `add` writes a key, and it refuses anything but `validLockName` — a key that survives this
    // door is a name that was printed by a reader, never a path.
    if (session.procs && typeof session.procs === 'object') {
      for (const [name, proc] of Object.entries(session.procs)) {
        if (
          !validLockName(name) ||
          !proc ||
          typeof proc !== 'object' ||
          typeof proc.by !== 'string' ||
          proc.by === '' ||
          typeof proc.at !== 'string'
        ) {
          delete session.procs[name];
          continue;
        }
        if (proc.pid !== undefined && !(Number.isInteger(proc.pid) && proc.pid > 0)) delete proc.pid;
        if (proc.note !== undefined && typeof proc.note !== 'string') delete proc.note;
      }
    } else if (session.procs !== undefined) {
      delete session.procs;
    }
    // An idle-episode claim enters from the file like every other value, and is cleaned here at
    // the same door. A claim this build cannot read is kept as `{ unreadable: true }` and never
    // dropped to absence: its presence holds the seat's episode, because a claim that may
    // already have spent the attempt must not be read as no claim at all. A map that is not a
    // map at all holds every seat the session records; only a trusted episode end (the seat
    // leaving the actionable reading) or manual recovery releases it. No other writer writes a
    // seat key, so a surviving key is a seat name that was printed by a reader, never a path.
    if (session.idle_claims !== undefined) {
      const cleaned = cleanIdleClaims(session.idle_claims, Object.keys(session.seats));
      if (Object.keys(cleaned).length === 0) delete session.idle_claims;
      else session.idle_claims = cleaned;
    }
    // Read old, write new: readings used to be held under a session. They are the project's
    // (§ 4.4), so every session's records are merged to the top level here — no reader loses one,
    // and the next write persists the new shape.
    const held = session as SessionState & { budgets?: Record<string, StoredReading>; spend?: Record<string, StoredSpend> };
    if (held.budgets) {
      state.budgets = mergeReadings(state.budgets, held.budgets);
      delete held.budgets;
    }
    if (held.spend) {
      state.spend = mergeSpend(state.spend, held.spend);
      delete held.spend;
    }
  }
  return state as State;
}

/**
 * One record per slot when two sessions hold the same account, window and seat: the reading that
 * counts wins — a confirmed one, and among those the newest change (§ 4.3).
 */
function mergeReadings(
  top: Record<string, StoredReading> | undefined,
  held: Record<string, StoredReading>,
): Record<string, StoredReading> {
  const merged = top ?? {};
  for (const [key, reading] of Object.entries(held)) {
    const current = merged[key];
    merged[key] = !current
      || (reading.confirmed && !current.confirmed)
      || (reading.confirmed === current.confirmed && Date.parse(reading.changedAt) > Date.parse(current.changedAt))
      ? reading
      : current;
  }
  return merged;
}

/** The same for spend: one record per account, the reading whose check ran last winning. */
function mergeSpend(
  top: Record<string, StoredSpend> | undefined,
  held: Record<string, StoredSpend>,
): Record<string, StoredSpend> {
  const merged = top ?? {};
  for (const [key, reading] of Object.entries(held)) {
    const current = merged[key];
    merged[key] = !current || Date.parse(reading.at) > Date.parse(current.at) ? reading : current;
  }
  return merged;
}

/**
 * The `team proc` records of one session a reader may show, in name order: a record with a `pid`
 * while that pid is alive, and one without a pid until `done`. A dead record is skipped here and
 * taken out of the file by the next write (`pruneProcs`), never by a reader.
 */
export function liveProcs(session: SessionState, alive: (pid: number) => boolean = pidAlive): Array<[string, ProcRecord]> {
  const procs = session.procs ?? {};
  return Object.entries(procs)
    .filter(([, proc]) => proc.pid === undefined || alive(proc.pid))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Drops one session's records whose pid is dead — what `add` and `done` do before they write,
 *  so a record a reader skipped is gone from the file too. */
export function pruneProcs(session: SessionState, alive: (pid: number) => boolean = pidAlive): void {
  if (!session.procs) return;
  for (const [name, proc] of Object.entries(session.procs)) {
    if (proc.pid !== undefined && !alive(proc.pid)) delete session.procs[name];
  }
}

// Reads the state, lets `change` edit it, and writes it back, all under the lock. `waitMs` is the
// lock's; `0` makes one attempt and throws `LockBusyError` instead of pausing, for a caller on a
// scheduler tick that must defer the same work to a later tick. `writeWhen` decides from the
// result whether the file is written at all: a caller that found the record it must not act on
// can leave the file exactly as it stands, sanitizing read included.
export function updateState<T>(
  dir: string,
  change: (state: State) => T,
  options: { waitMs?: number; writeWhen?: (result: T) => boolean } = {},
): T {
  return withLock(dir, () => {
    const state = readState(dir);
    const result = change(state);
    if (!options.writeWhen || options.writeWhen(result)) {
      writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    }
    return result;
  }, options);
}

/** The watch record exactly as the state file holds it, before the read door cleans it. A record
 *  the parser cannot use must not look absent to a writer that has to judge the holder: this lets
 *  a locked writer tell a malformed record that stands from no record at all.
 *
 *  Only a file that is not there is an absent holder. Any other read or parse failure refuses
 *  upward: an I/O error is never permission for a writer to acquire. */
export function storedWatchRecord(dir: string, session: string): unknown {
  const path = join(dir, STATE_FILE);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const raw = JSON.parse(text) as { sessions?: Record<string, { watch?: unknown }> };
  return raw?.sessions?.[session]?.watch;
}

export function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/**
 * Creates a file that must not exist yet, the atomic way `writeAtomic` replaces one: the text
 * lands in a same-directory temporary, and the link into place is the create — it fails with
 * `EEXIST` when the path is taken rather than clobbering what is there, so the name either holds
 * nothing or the whole text, never a prefix. The temporary is removed either way.
 */
export function createAtomic(path: string, text: string, mode?: number): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, mode === undefined ? {} : { mode });
  try {
    linkSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary is this process's own pid-named file; a failed cleanup must not mask
      // what the link said.
    }
  }
}

/**
 * Reads a file and parses it; a parse failure reads and parses once more before any error goes
 * out — a file replaced under the reader has settled by the re-read. The retry's own error is
 * the one reported, so the message describes what the file holds now.
 */
export function readParsed<T>(path: string, parse: (text: string) => T): T {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch {
    // The first read or parse failed; one more read and parse, reporting that attempt's error,
    // which describes what the file holds now.
    return parse(readFileSync(path, 'utf8'));
  }
}

/** Whether a process with this pid exists. A pid owned by another user counts as alive
 *  (`EPERM`), which is also what the lock's stale-holder rule wants. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Removes a lock whose holder is dead. Two commands may see the same dead holder: the lock is
// moved aside first, which only one of them can do, and put back if it turns out to be a fresh
// one that another command took in between.
function takeOver(path: string, holder: number): boolean {
  const aside = `${path}.${process.pid}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return false;
  }
  const found = Number(readFileSync(aside, 'utf8').trim());
  if (found !== holder && Number.isInteger(found) && found > 0 && pidAlive(found)) {
    try {
      renameSync(aside, path);
    } catch {}
    return false;
  }
  unlinkSync(aside);
  return true;
}

/** A lock another live holder keeps: the work did not run and may be retried once it is released.
 *  A scheduler that must not block catches this and defers the work to its next pass. */
export class LockBusyError extends Error {
  readonly path: string;
  readonly holder: number | null;
  constructor(path: string, holder: number | null) {
    super(
      holder === null
        ? `${path} is held and its holder is not readable yet; try again when it is done`
        : `another team command (pid ${holder}) holds ${path}; try again when it is done`,
    );
    this.name = 'LockBusyError';
    this.path = path;
    this.holder = holder;
  }
}

// One writer at a time. The lock file holds its holder's pid; a lock whose holder is dead is
// taken over, and `onStale` is told. `waitMs: 0` tries once and throws `LockBusyError` at the
// first held lock instead of pausing, so a caller on a scheduler tick can defer the same work to
// a later tick without blocking its event loop.
export function withLock<T>(dir: string, work: () => T, options: { waitMs?: number; onStale?: (pid: number) => void } = {}): T {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  const waitMs = options.waitMs ?? 5000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder = NaN;
      try {
        holder = Number(readFileSync(path, 'utf8').trim());
      } catch {
        continue; // released between the two calls
      }
      if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
        if (waitMs === 0 || Date.now() > deadline) throw new LockBusyError(path, holder);
        pause(50);
        continue;
      }
      // A dead holder, or a lock file too young to hold its pid yet. A file just created holds
      // no pid until its writer writes one — it reads as 0, not as a number that names a
      // process — so anything that is not a positive integer is young, not stale. Past the
      // one-second window a pid-less lock is stale by this age heuristic alone; that is not
      // proof its writer is dead, and no takeover pretends otherwise.
      if (!(Number.isInteger(holder) && holder > 0) && Date.now() - statSync(path).mtimeMs < 1000) {
        if (waitMs === 0) throw new LockBusyError(path, null);
        pause(20);
        continue;
      }
      if (takeOver(path, holder)) options.onStale?.(holder);
    }
  }
  try {
    return work();
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}
