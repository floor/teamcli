import type { HerdrAgent, PaneProcesses } from '../herdr.ts';
import { refusalReport, type Refusal } from './deliver.ts';
import { profileFor, versionVerdict } from '../profiles/profile.ts';
import { canShowModel, modelDiffers, seatModel, type Running } from '../status/statusline.ts';
import { launchedIdentity, seatProcessVerdict, type LaunchedIdentity } from './identity.ts';
import { IDLE_POLL_MS, type Step } from './plan.ts';
import {
  closeTarget,
  waitingProblem,
  type CloseReads,
  type PauseInput,
  type PauseResult,
  type WaitingProblem,
  type WaitingReads,
} from './pause.ts';
import { plainPaneText } from './plain.ts';
import { recordWhat, cleanRecord, classificationOf, type Classification, type FinalRecord, type ProgressState } from './progress.ts';
import type { LobbyRefusal } from '../lobby/gate.ts';
import type { SeatState, WaitingRecord } from '../state.ts';
import { vendorNoticeRange } from '../watch/screen.ts';

export type ScreenKind = 'idle' | 'working' | 'permission' | 'trust' | 'question' | 'exit question' | 'vendor notice' | 'unsent' | 'unknown';

/** What a live `up` or `down` can do, apart from deciding it. Tests stand in for all of it. */
/** What one live exit typing ended in. `true`: the box read back as the typed text and the
 *  Enter was pressed. `false`: nothing was confirmed, nothing was sent — the step's own line.
 *  `'no-agent'`: the CLI was not the pane's foreground process when a key was due. `'cleared'`:
 *  the text did not read back, and the profile's one clearing key emptied the box. `{ left }`:
 *  the text was not confirmed and the box was left holding something; `left` is the line that
 *  says what is in the box now. */
export type ExitTyping = boolean | 'no-agent' | 'cleared' | { left: string };

export type Host = {
  startServer(session: string): boolean;
  sessionUp(session: string): boolean | null;
  /**
   * Confirms the starting folder of an `op.lobby` create is still the lobby the gate verified,
   * run directly before `createWorkspace` with nothing in between. A refusal stops everything:
   * nothing is created, that seat (or the watch) is left out — its record and the log hold the
   * reason in words — and the fuller sentence, the folder it names, is stderr detail alone.
   */
  confirmLobby?(): LobbyRefusal | null;
  createWorkspace(session: string, cwd: string, label: string): { pane: string; workspace: string } | null;
  paneRun(session: string, pane: string, command: string): boolean;
  /** The live exit typing; see `ExitTyping`. May wait: the pane draws typed text late, and the
   *  reading that decides the Enter or the clearing key waits for it. */
  typeLine(session: string, pane: string, text: string): ExitTyping | Promise<ExitTyping>;
  /** `false` is a delivery that stopped without a reading worth reporting (no host, or no live
   *  pane); a `Refusal` is one that stopped on a screen the report can name. `file` is the
   *  seat's rules delivery: the text the file holds, the file's path, the one line typed, and
   *  the seat's name — the writer builds its own path from the name, never from a path a
   *  caller hands it. */
  deliverRules?(
    session: string,
    pane: string,
    cli: string,
    file: { text: string; path: string; line: string; seat: string },
    seconds: number,
  ): Promise<boolean | 'no-agent' | Refusal>;
  renameAgent(session: string, pane: string, name: string): boolean;
  closeWorkspace(session: string, workspace: string): boolean;
  stopSession(session: string): boolean;
  /** Clears the session this run has just stopped. Present on `down` only: `up` never deletes. */
  deleteSession?(session: string): boolean | Promise<boolean>;
  kill(pid: number): boolean;
  /** Pane ids herdr lists an agent in, or null when the list can't be read. */
  agentPanes(session: string): string[] | null;
  /** The session's agents as herdr lists them now; null when the list can't be read. The repair
   *  step reads it again, immediately before the close, to bind the seat to its pane. */
  agentList?(session: string): HerdrAgent[] | null;
  /** Pane ids in a workspace as herdr lists them now; null when the list can't be read. The repair
   *  step checks that the workspace holds only the seat's pane before closing it. */
  workspacePanes?(session: string, workspace: string): string[] | null;
  /** The session's workspaces with their labels as herdr lists them now; null when unreadable.
   *  The waiting proof compares the pane's workspace label with the seat's launch label. */
  workspaces?(session: string): { id: string; label: string }[] | null;
  /** The session's recorded seats, read fresh; null when unreadable. The waiting proof refuses a
   *  pane or workspace any other seat's record names. */
  seatStates?(session: string): Record<string, SeatState> | null;
  classify(session: string, pane: string, cli: string): ScreenKind;
  /** The pane's visible text, ANSI styling and all, or null when the pane can't be read. */
  paneText?(session: string, pane: string): string | null;
  /** Whether the pane's foreground program is back to its shell; null when herdr can't tell. */
  shellBack?(session: string, pane: string): boolean | null;
  /** The pane's process identity, read to record it for the seat; null when herdr can't tell. */
  processInfo?(session: string, pane: string): PaneProcesses | null;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Null when this seat may launch. A string is the reason it may not. */
  allow(seat: string): string | null;
  record(
    seat: string,
    patch: {
      stage: 'launched' | 'named' | 'ready';
      pane?: string;
      workspace?: string;
      rules?: 'option' | 'message';
      createdWorkspace?: boolean;
      launched?: LaunchedIdentity;
      /** A waiting record to write, or null to remove the seat's waiting field. */
      waiting?: WaitingRecord | null;
    },
  ): void;
  /** The seat is really running, so the next seat's ceiling check counts it. */
  running(seat: string): void;
  drop(seat: string): void;
  say(line: string): void;
  log(who: string, what: string): void;
  /** Records the file the watchdog pane may read, before that pane's command runs. */
  noteWatch?(pane: string, file: string): void;
  /** The seat's line: first drawn before its workspace is created, rewritten in place as it
   *  advances. Present on `up` and `add`; `down` has none, and its records keep their old lines. */
  progress?(seat: string, state: ProgressState): void;
  /** The seat's one final record, already cleaned (`cleanRecord`: its fields are one physical
   *  line each). Present wherever `progress` is. */
  final?(seat: string, record: FinalRecord): void;
  /** One detail line of the record just finalized: one call per line, on stderr, after the
   *  record. Present wherever `final` is. */
  detail?(line: string): void;
  /** What the installed `<cli>` reports as its version, for a vendor notice's `untested on`
   *  detail. Null when it can't be read. */
  cliVersion?(cli: string): string | null;
  /**
   * How this run treats a seat it finds at a dialog, and one it resumes from a recorded
   * waiting state. `prompt`: the owner is at a terminal — `pause.ts` asks with `o`/`s`/`q`.
   * `keep`: `add` — the workspace stays, the waiting record is written, the seat is left out.
   * `close-no-terminal`: an owner whose stdin is not a terminal — the workspace is closed
   * without input and the record says so. `timeoutIsDialog` on that mode: a delegated run,
   * whose idle wait's timeout is a dialog like any other stop — closed without input, never
   * left at launched. Absent: the close path that predates the pause.
   */
  dialog?:
    | { mode: 'prompt'; run(input: PauseInput): Promise<PauseResult> }
    | { mode: 'keep' }
    | { mode: 'close-no-terminal'; timeoutIsDialog?: boolean };
  /** Records a seat's waiting state, with the process identity read at that moment in the same
   *  write. `add`'s keep path; `up`'s prompt path records through `pause.ts`'s own write. */
  recordWaiting?(seat: string, waiting: WaitingRecord, pane: string, workspace?: string): void;
  /** Removes a seat's waiting field alone, leaving the rest of its state: the screen is back at
   *  the seat's prompt and the seat carries on. */
  clearWaiting?(seat: string): void;
  /** The seat's exclusive lock, as `pause.ts` takes it: the release, or the pid holding it.
   *  The stop pass takes it before it closes a seat this run created. Absent: none is taken. */
  seatLock?(seat: string): { release(): void } | { held: number };
};

export type Report = {
  serverFailed: boolean;
  watchFailed: boolean;
  /** A seat or the watch was left behind, so the session must not be stopped. */
  held: boolean;
  dropped: readonly string[];
};

type Place = { pane: string; workspace?: string };

/** Where the launch line's echo sits among the lines, or -1 when it is not there. A prompt may
 *  stand in front of the echo and the command may wrap after it, so only the command's first
 *  characters are looked for — never the program word alone, which the failure message below
 *  the echo often repeats. A marker too short to be sure of is not used. */
function echoIndex(lines: readonly string[], command: string): number {
  const head = (command.trim().split('\n')[0] ?? '').slice(0, 24).trimEnd();
  return head.length >= 8 ? lines.findLastIndex((line) => line.includes(head)) : -1;
}

/** The pane's last lines for a report: at most six, the newest kept, empty lines dropped,
 *  control characters and styling gone (`plainPaneText`). The launch line's own echo comes
 *  first when it is within reach: the last line holding the start of the command that was
 *  typed, when six lines or fewer follow it. A launch line that scrolled further up leaves
 *  only the newest six, with the failure among them. */
export function paneExcerpt(text: string | null, command: string, limit = 6): string {
  if (text === null) return '';
  const lines = plainPaneText(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return '';
  const echo = echoIndex(lines, command);
  const tail = Math.max(0, lines.length - limit);
  const start = echo >= tail ? echo : tail;
  return lines.slice(start).map((line) => `  | ${line}\n`).join('');
}

async function until(seconds: number, pace: number, host: Host, ready: () => boolean): Promise<boolean> {
  const deadline = host.now() + seconds * 1000;
  for (;;) {
    if (ready()) return true;
    if (host.now() >= deadline) return false;
    const before = host.now();
    await host.sleep(pace);
    // A clock that does not move would spin. Treat that as the wait running out.
    if (host.now() <= before) return false;
  }
}

/** Runs a plan. Steps carry the operation beside the command the dry run prints. */
export async function executePlan(steps: readonly Step[], session: string, host: Host): Promise<Report> {
  const places = new Map<string, Place>();
  const dropped = new Set<string>();
  const logged = new Set<string>();
  let serverFailed = false;
  let watchFailed = false;
  let held = false;
  let abort = false;
  // `q` (and Ctrl-C, which is the same): the run stops cleanly after the loop — what this
  // invocation created is closed, and every seat without a final record gets one (§3).
  let stopped = false;
  /** The seats that reached ready in this run: the stop pass never closes one. */
  const ready = new Set<string>();
  /** seat -> what this run created for it: the workspace the stop pass closes, and the seat's
   *  own repair line (`relaunchRepair`), for a refusal that leaves its record behind. */
  const created = new Map<string, { workspace: string; repairLine: string }>();
  /** Seats whose workspace this run closed: no path closes one twice. */
  const closed = new Set<string>();
  /** Whether this run started the session: only then may `q` stop it. */
  let createdSession = false;

  // The reading is what is logged: screen text may follow it on the terminal (`detail`), and
  // never reaches the log file. `down`'s records keep this line exactly.
  const finish = (seat: string, what: string, detail = '') => {
    if (logged.has(seat)) return;
    logged.add(seat);
    host.say(`${seat}: ${what}\n${detail}`);
    host.log(seat, what);
  };

  // The lines a run says about a seat between its line's first draw and its final record are
  // held and said right after the record: while a seat's line is provisional, that line is the
  // only one open on the terminal.
  const pending = new Map<string, string[]>();
  const hold = (seat: string, line: string) => {
    const lines = pending.get(seat);
    if (lines) lines.push(line);
    else pending.set(seat, [line]);
  };
  const release = (seat: string): string => {
    const lines = (pending.get(seat) ?? []).join('');
    pending.delete(seat);
    return lines;
  };

  // A seat's one final record: the record line, then its detail lines on stderr, one writer call
  // each. The record is cleaned once here, before the log and the writer both take it, so the log
  // line and the terminal line are the same cleaned words; the writer cleans again at its own
  // boundary. A host without `final` (no `up` or `add` record path reaches it) says the record's
  // own words as one line. The log's line is the record's words, with one exception: §7 writes
  // the stopped-cleanly record's log line as `<seat>: stopped cleanly`, without the `left out:`
  // the terminal line and §3's record keep.
  const final = (seat: string, record: FinalRecord, detail = '') => {
    if (logged.has(seat)) return;
    logged.add(seat);
    const clean = cleanRecord(record);
    const what = clean.kind === 'left out' && clean.reason === 'stopped cleanly' ? 'stopped cleanly' : recordWhat(clean);
    const rest = detail + release(seat);
    if (host.final) {
      host.final(seat, clean);
      for (const line of rest.split('\n')) host.detail?.(line);
    } else host.say(`${seat}: ${what}\n${rest}`);
    host.log(seat, what);
  };

  /** A seat this run will not touch again, left exactly as it is, with its record said. */
  const leftOut = (seat: string, reason: string, detail = ''): 'settled' => {
    held = true;
    dropped.add(seat);
    final(seat, { kind: 'left out', reason }, detail);
    return 'settled';
  };

  /** A pause's outcome, become this run's final record or its continuation into the seat's
   *  ordinary steps. `stopped` carries `q` out to the pass after the loop. */
  const settle = (seat: string, result: PauseResult): 'idle' | 'settled' => {
    switch (result.kind) {
      case 'idle':
        return 'idle';
      case 'ready':
        ready.add(seat);
        final(seat, { kind: 'ready' }, result.detail);
        return 'settled';
      case 'skipped':
        // The pause closed the workspace itself, without input, and cleared the state.
        closed.add(seat);
        dropped.add(seat);
        final(seat, { kind: 'left out', reason: 'skipped by owner' });
        return 'settled';
      case 'stopped':
        stopped = true;
        abort = true;
        return 'settled';
      default:
        // A fail-closed refusal, or a close that did not happen: the seat keeps its state,
        // and nothing may claim a close that did not happen.
        return leftOut(seat, result.reason, result.detail);
    }
  };

  // A seat whose pane no longer held the process team launched is closed without input and
  // launched again; it is ready when it reaches its prompt, and the detail says why it was
  // launched. Any other end of that seat keeps its own record, and the close is what the plan
  // and the state already show.
  const relaunched = new Map<string, 'gone' | 'replaced' | 'drift'>();
  const finishReady = (seat: string) => {
    ready.add(seat);
    const verdict = relaunched.get(seat);
    if (verdict === 'gone') {
      final(seat, { kind: 'ready' }, '  its pane held no CLI; closed without input and launched again\n');
    } else if (verdict === 'replaced') {
      final(seat, { kind: 'ready' }, '  its pane held a process team did not launch; closed without input and launched again\n');
    } else if (verdict === 'drift') {
      final(seat, { kind: 'ready' }, '  its model drifted; closed without input and launched again\n');
    } else final(seat, { kind: 'ready' });
  };
  // The identity read after the idle prompt, to carry into every later record of the seat.
  const identities = new Map<string, LaunchedIdentity>();

  // The display label may be shared. The seat's name is the only key; the watch has no seat.
  const place = (key: string, pane?: string, workspace?: string): Place | null => {
    const have = places.get(key);
    if (have) return have;
    if (!pane) return null;
    const made = { pane, workspace };
    places.set(key, made);
    return made;
  };

  /** The reads a waiting record's proof and its closes are made of: herdr's list, the pane's
   *  process, the workspaces with their labels, the session's recorded seats, the workspace's
   *  panes. Every one is read at the moment it is called — directly before the act it guards. */
  const waitingReads = (pane: string): WaitingReads & CloseReads => ({
    agents: () => host.agentList?.(session) ?? null,
    process: () => host.processInfo?.(session, pane) ?? null,
    workspaces: () => host.workspaces?.(session) ?? null,
    seats: () => host.seatStates?.(session) ?? null,
    workspacePanes: (workspace) => host.workspacePanes?.(session, workspace) ?? null,
  });

  /** The identity a dialog is judged by, and the one a refused close writes back: the identity
   *  this run recorded when it launched the seat — its records' own, where an earlier run left
   *  one, else the read taken when the dialog was found. Read once, here, and never read again;
   *  the close's own fresh read of a changed process is never the identity kept. */
  const dialogIdentity = (seat: string, pane: string): LaunchedIdentity | undefined => {
    const recorded = identities.get(seat) ?? host.seatStates?.(session)?.[seat]?.launched;
    return recorded ?? launchedIdentity(host.processInfo?.(session, pane) ?? null) ?? undefined;
  };

  /** A seat left behind by a close this run refused. Its waiting record — with the reading that
   *  stopped it — and the identity recorded at launch go back into its state, so the next `up`
   *  reads it as a waiting seat instead of adopting a pane it finds idle, or refusing the whole
   *  session over state that records none. The identity the close itself reads is never written:
   *  it is the changed process the close was refused for, and proves nothing. */
  const keepWaiting = (seat: string, here: Place, classification: Classification, launched?: LaunchedIdentity): void => {
    host.record(seat, {
      stage: 'launched',
      pane: here.pane,
      ...(here.workspace ? { workspace: here.workspace } : {}),
      ...(launched ? { launched } : {}),
      waiting: { state: 'waiting-owner', classification },
    });
  };

  /** A fresh seat found at a dialog. `prompt` asks the owner; `keep` records the wait and
   *  leaves the seat out; `close-no-terminal` closes without input and says so. The identity is
   *  read once, here, and the close is judged against it; a close that is refused writes the
   *  seat's state back the way the next `up` can read it. */
  const atDialog = async (
    seat: string,
    here: Place,
    label: string,
    classification: Classification,
    identity: LaunchedIdentity | undefined,
    repairLine: string,
  ): Promise<'idle' | 'settled'> => {
    const dialog = host.dialog;
    if (dialog?.mode === 'prompt') {
      return settle(
        seat,
        await dialog.run({
          seat,
          classification,
          pane: here.pane,
          label,
          repairLine,
          ...(here.workspace ? { workspace: here.workspace } : {}),
        }),
      );
    }
    if (dialog?.mode === 'keep') {
      host.recordWaiting?.(seat, { state: 'waiting-owner', classification }, here.pane, here.workspace);
      dropped.add(seat);
      final(seat, { kind: 'left out', reason: classification }, `  the owner finishes it with \`team up\`\n`);
      return 'settled';
    }
    if (dialog?.mode === 'close-no-terminal') {
      // An owner whose stdin is not a terminal: the workspace is closed without input, and the
      // record says why. Nothing is read from stdin, and nothing is sent into the pane. The close
      // itself makes the stop pass's reads, directly before it: the workspace is the one herdr
      // returns for the seat's pane, holding that pane and no other seat's, and the pane's
      // process must still be the one read when the dialog was found — a pane whose process
      // changed is not closed, and neither is one with no identity to prove it by. A close that
      // cannot be proven leaves everything as it is — and, so the next `up` can read the seat,
      // writes its waiting record and the launch identity the close was judged by back.
      if (here.workspace) {
        const target = closeTarget(waitingReads(here.pane), { seat, pane: here.pane, workspace: here.workspace, repairLine, ...(identity ? { launched: identity } : {}) });
        if ('problem' in target) {
          keepWaiting(seat, here, classification, identity);
          return leftOut(seat, target.problem.reason, target.problem.detail);
        }
        if (!host.closeWorkspace(session, target.workspace)) {
          keepWaiting(seat, here, classification, identity);
          return leftOut(seat, `${classification}; its workspace did not close; left as it is`);
        }
      }
      host.drop(seat);
      dropped.add(seat);
      if (here.workspace) closed.add(seat);
      final(seat, { kind: 'left out', reason: `${classification} (no terminal for owner)` }, '  its workspace was closed without input\n');
      return 'settled';
    }
    return 'settled';
  };

  /** §5: a seat recorded waiting, resumed. Its recorded pane and workspace are reused — nothing
   *  is created for it — and its screen is read fresh. Only a pause, or an `add` or a
   *  terminal-less run, ever closes it, and only after its pane is verified to be the seat's. */
  const resumeWaiting = async (op: {
    seat: string;
    cli: string;
    label: string;
    pane: string;
    workspace?: string;
    record: WaitingRecord;
    launched?: LaunchedIdentity;
    repairLine: string;
  }): Promise<'idle' | 'settled'> => {
    const dialog = host.dialog;
    if (!dialog) {
      // No pause path at all (a host that predates it): nothing here may close or type into a
      // waiting seat, so it is left exactly as it is, record and all.
      return leftOut(op.seat, 'its waiting pane cannot be asked about; left as it is');
    }
    const lock = host.seatLock?.(op.seat);
    if (lock && 'held' in lock) return leftOut(op.seat, 'another command holds it; left as it is');
    let classification: Classification = op.record.classification;
    try {
      // The state is a hint of where to look, never an authority: the pane is proven this seat's
      // from fresh reads before anything acts on the record — nothing else's record names the
      // pane or the workspace, the multiplexer's agent is unnamed or this seat, the workspace
      // carries this seat's launch label, and the process is still the recorded one (`pause.ts`).
      const proof = {
        seat: op.seat,
        pane: op.pane,
        ...(op.workspace ? { workspace: op.workspace } : {}),
        label: op.label,
        repairLine: op.repairLine,
        ...(op.launched ? { launched: op.launched } : {}),
      };
      const problem = waitingProblem(waitingReads(op.pane), proof);
      if (problem) return leftOut(op.seat, problem.reason, problem.detail);
      const kind = host.classify(session, op.pane, op.cli);
      if (kind === 'idle') {
        // The owner answered in the pane between runs: the seat carries on and finishes.
        host.clearWaiting?.(op.seat);
        return 'idle';
      }
      classification = kind === 'working' ? op.record.classification : classificationOf(kind);
      if (dialog.mode === 'keep') {
        host.recordWaiting?.(op.seat, { state: 'waiting-owner', classification }, op.pane, op.workspace);
        dropped.add(op.seat);
        final(op.seat, { kind: 'left out', reason: classification }, `  the owner finishes it with \`team up\`\n`);
        return 'settled';
      }
      if (dialog.mode === 'close-no-terminal') {
        // A resumed wait is not closed from a run with no terminal. The workspace stays, and
        // the record stays. A fresh launch that meets a dialog still closes, above.
        return leftOut(op.seat, 'a run with no terminal does not close a waiting seat; left as it is');
      }
    } finally {
      // §1: the lock is never held while the owner's key is waited for, nor across a poll. The
      // resume's fresh read was under it; the prompt below takes it again for each of open,
      // skip and close, through the pause's own `o`/`s`/`q` paths.
      if (lock && 'release' in lock) lock.release();
    }
    if (dialog.mode === 'prompt') {
      return settle(
        op.seat,
        await dialog.run({
          seat: op.seat,
          classification,
          pane: op.pane,
          label: op.label,
          repairLine: op.repairLine,
          ...(op.workspace ? { workspace: op.workspace } : {}),
          recorded: op.record,
        }),
      );
    }
    return 'settled';
  };

  for (const step of steps) {
    const op = step.do;
    const seat = op && 'seat' in op ? op.seat : undefined;
    if (abort) continue;
    if (seat && dropped.has(seat)) continue;

    if (step.kind === 'skip') {
      if (op?.do === 'record' && op.seat) {
        final(op.seat, op.record, op.detail ?? '');
      } else if (op?.do === 'ready' && op.seat) {
        if (op.notice) hold(op.seat, `${op.seat}: ${op.notice}\n`);
        host.record(op.seat, { stage: 'ready', rules: op.rules });
        finishReady(op.seat);
      } else if (op?.do === 'refuse') {
        // The record carries the reason in words; the full finding — the start folder it names —
        // follows as the record's detail, on stderr alone.
        final(op.seat, { kind: 'left out', reason: `refused: ${op.why}` }, op.detail ? `  ${op.detail}\n` : '');
      } else host.say(`  skip ${step.text}\n`);
      continue;
    }
    if (!op) continue;

    switch (op.do) {
      case 'server': {
        if (!host.startServer(op.session)) {
          serverFailed = true;
          abort = true;
          host.say(`session ${op.session}: its server did not start\n`);
        } else createdSession = true;
        break;
      }
      case 'wait-session': {
        const up = await until(op.seconds, 1000, host, () => host.sessionUp(op.session) === true);
        if (!up) {
          serverFailed = true;
          abort = true;
          host.say(`session ${op.session}: it was not running within ${op.seconds} s\n`);
        }
        break;
      }
      case 'create': {
        // Before the allow and lobby checks, and before the workspace: the seat's line is drawn
        // whole, and nothing sits between the lobby's last look and the create it guards.
        if (op.seat) host.progress?.(op.seat, 'launching');
        if (op.seat && op.notice) hold(op.seat, `${op.seat}: ${op.notice}\n`);
        if (op.seat) {
          const why = host.allow(op.seat);
          if (why) {
            dropped.add(op.seat);
            final(op.seat, { kind: 'left out', reason: why });
            break;
          }
        }
        if (op.lobby && host.confirmLobby) {
          // The last look at the starting folder, with nothing between it and the create. The
          // host call takes a path, not a handle, so the multiplexer resolves the path itself:
          // that window is left, and the page says exactly which.
          const why = host.confirmLobby();
          if (why) {
            // The record (and the log) hold the reason in words; the folder the fuller sentence
            // names is stderr detail, under the record, for the owner's terminal alone.
            abort = true;
            if (op.seat) {
              dropped.add(op.seat);
              final(op.seat, { kind: 'left out', reason: why.reason }, `  ${why.detail}\n`);
            } else {
              watchFailed = true;
              host.say(`watch: ${why.reason}\n  ${why.detail}\n`);
              host.log('watch', why.reason);
            }
            break;
          }
        }
        const made = host.createWorkspace(session, op.cwd, op.label);
        if (!made) {
          if (op.seat) {
            host.record(op.seat, { stage: 'launched' });
            dropped.add(op.seat);
            final(op.seat, { kind: 'left out', reason: 'its workspace was not created; left at launched' });
          } else {
            watchFailed = true;
            host.say('watch: its workspace was not created\n');
            host.log('watch', 'its workspace was not created');
          }
          break;
        }
        places.set(op.seat ?? op.label, made);
        if (op.seat) {
          created.set(op.seat, { workspace: made.workspace, repairLine: op.repairLine });
          // A seat whose earlier workspace was closed and then made again in the same run — a
          // repair followed by a create — is not "already closed": the stop pass must close
          // this new workspace too.
          closed.delete(op.seat);
          // A fresh workspace is a fresh seat: any waiting record named an older pane, and is
          // void here. Clearing it in the same write is what makes the whole-team repair
          // (`team down` then `team up`) clear the record the next `up` would otherwise resume.
          host.record(op.seat, {
            stage: 'launched',
            pane: made.pane,
            workspace: made.workspace,
            createdWorkspace: true,
            waiting: null,
          });
          host.running(op.seat);
        }
        break;
      }
      case 'launch': {
        host.progress?.(op.seat, 'launching');
        if (op.notice) hold(op.seat, `${op.seat}: ${op.notice}\n`);
        const why = host.allow(op.seat);
        if (why) {
          dropped.add(op.seat);
          final(op.seat, { kind: 'left out', reason: why });
          break;
        }
        const here = place(op.seat, op.pane);
        if (!here || !host.paneRun(session, here.pane, op.command)) {
          dropped.add(op.seat);
          final(op.seat, { kind: 'left out', reason: 'its launch command did not run; left at launched' });
          break;
        }
        host.running(op.seat);
        break;
      }
      case 'idle': {
        host.progress?.(op.seat, 'waiting for its prompt');
        if (op.notice) hold(op.seat, `${op.seat}: ${op.notice}\n`);
        if (op.waiting && op.resumeGap) {
          dropped.add(op.seat);
          final(
            op.seat,
            {
              kind: 'left out',
              reason: op.resumeGap === 'many'
                ? 'herdr lists more than one agent of this name; left as it is'
                : 'its waiting pane is gone',
            },
            op.resumeGap === 'none' ? `  its record still names it; ${op.repairLine}, clears it\n` : '',
          );
          break;
        }
        const here = place(op.seat, op.pane, op.workspace);
        if (!here) {
          dropped.add(op.seat);
          final(op.seat, { kind: 'left out', reason: 'has no pane to read; left at launched' });
          break;
        }
        // What an idle screen means for the seat, wherever it was found: the model check, then
        // the identity record. The seat carries on to its rename or its delivery either way.
        const idleOnwards = (): void => {
          // After the idle wait, before the rename and the rules: the same "differs" the watch uses.
          // Unread is not a difference, and the seat continues. A different model is left unnamed.
          if (op.model !== undefined && op.version !== undefined) {
            const screen = host.paneText?.(session, here.pane) ?? null;
            const running = screen === null ? null : seatModel({ cli: op.cli, model: op.model }, screen);
            const declared = { model: op.model, version: op.version };
            // `init` writes version "0" — the placeholder before the owner fills the release
            // number in — and the release before this one left whole teams carrying it. Exactly
            // that literal is read as "no version declared": the family is still compared, and
            // any other value ("0.0", "00", a real number) is compared as today.
            const differs = running !== null
              && (op.version === '0' ? running.model !== op.model : modelDiffers(running, declared));
            if (differs) {
              dropped.add(op.seat);
              final(op.seat, { kind: 'left out', reason: modelLeft(running, declared, op.cli) });
              return;
            }
            if (!running) {
              // The note is not a record: it is held and said as the seat's record's detail —
              // stderr alone — and the log keeps the one line the record writes, `ready`.
              hold(op.seat, `${op.seat}: its screen doesn't show a model this version knows; not checked\n`);
            }
          }
          // The seat's own process, read now that its idle prompt is on the screen: the pane's
          // shell and the pids in front of it that are not the shell. Nothing is recorded when
          // herdr can't tell: a seat without the record keeps today's behaviour.
          const identity = launchedIdentity(host.processInfo?.(session, here.pane) ?? null);
          if (identity) {
            identities.set(op.seat, identity);
            host.record(op.seat, {
              stage: 'launched',
              pane: here.pane,
              launched: identity,
              ...(here.workspace ? { workspace: here.workspace } : {}),
            });
          }
        };
        if (op.waiting) {
          // §5: a seat recorded waiting. Its recorded pane and workspace are reused — nothing is
          // created for it — and its screen is read fresh, before any unnamed or wrong-name
          // handling. The pause's outcome is this seat's outcome; only an idle screen lets it
          // carry on into its ordinary steps.
          const settled = await resumeWaiting({
            seat: op.seat,
            cli: op.cli,
            label: op.label,
            pane: here.pane,
            ...(here.workspace ? { workspace: here.workspace } : {}),
            record: op.waiting.record,
            ...(op.waiting.launched ? { launched: op.waiting.launched } : {}),
            repairLine: op.repairLine,
          });
          if (settled === 'idle') idleOnwards();
          break;
        }
        const startedAt = host.now();
        const deadline = startedAt + op.seconds * 1000;
        const pollMs = IDLE_POLL_MS;
        let outcome: 'idle' | 'permission' | 'trust' | 'question' | 'vendor notice' | 'ended' | 'timeout' = 'timeout';
        let last: ScreenKind = 'unknown';
        let endedRead: string | null = null;
        let endedFor = 0;
        // The launch line was run a moment ago, and herdr can still report the pane's shell for
        // a poll or two after it. Captured on herdr 0.7.1 in a scratch pane: right after
        // `pane run node -e …`, `pane process-info` listed the pane's shell (`shell_pid` 11915)
        // beside the shell's own startup child, and 600 ms later listed the program alone; a
        // launch line whose relative path was missing listed the shell at once, and 400 ms later
        // still. A slow wrapper looks the same for longer: one drew its CLI on the
        // fourth poll, so a stretch of one or two polls is not an end.
        //
        // The echo is NOT evidence the line ran: captured over 24 synthetic trials, a fresh
        // pane's shell can leave the typed line unread for seconds while the tty's echo sits on
        // the screen — 8.9 s to 10.3 s across 7 trials, and one capture had the pane's process
        // appear 60 ms after the verdict was said. The end is said only on what was read: the
        // shell's own process is the pane's foreground program, with the launch line's echo
        // still up, across the stretch of `12 * pollMs` — one reading starts it and twelve more
        // carry it past twelve poll intervals (24 s at the 2 s poll, 2.3x the longest silence
        // measured) — and a single reading, the verdict's mutation, can never reach it. A pane
        // read before the line arrived, one whose echo scrolled away, or a herdr that can't say
        // (no shell process info) is waited out to the deadline: the end is never inferred from
        // the screen's text.
        let shellBackSince: number | null = null;
        // The whole time the shell has been seen back in this wait, for the report: unlike the
        // stretch above it is never cleared, so a stretch broken by one unreadable poll does not
        // restart the count the message states.
        let shellBackFirst: number | null = null;
        for (;;) {
          const kind = host.classify(session, here.pane, op.cli);
          last = kind;
          const back = host.shellBack?.(session, here.pane) ?? null;
          const at = host.now();
          if (kind === 'unknown' && back === true) {
            shellBackSince ??= at;
            shellBackFirst ??= at;
            if (at - shellBackSince >= 12 * pollMs) {
              const read = host.paneText?.(session, here.pane) ?? null;
              if (read !== null && echoIndex(plainPaneText(read).split('\n'), op.command) >= 0) {
                endedRead = read;
                endedFor = Math.round((at - shellBackFirst) / 1000);
                outcome = 'ended';
                break;
              }
            }
          } else shellBackSince = null;
          if (kind === 'idle' || kind === 'permission' || kind === 'trust' || kind === 'question' || kind === 'vendor notice') {
            outcome = kind;
            break;
          }
          if (host.now() >= deadline) break;
          const before = host.now();
          await host.sleep(pollMs);
          if (host.now() <= before) break;
        }
        if (outcome === 'idle') {
          idleOnwards();
          break;
        }
        const workspace = here.workspace ?? places.get(op.seat)?.workspace;
        if (outcome === 'permission' || outcome === 'trust' || outcome === 'question' || outcome === 'vendor notice') {
          const reading = outcome === 'trust' ? 'trust' : outcome;
          if (host.dialog) {
            // The seat's owner decides what happens next, at their own keyboard. The identity is
            // read once, now that the dialog is found, and the close that may follow (a
            // no-terminal owner's) is judged against this read: a pane whose process changed
            // while the owner looked is not closed. This run's own read wins; the state's record
            // is the fallback for a seat an earlier run launched; a live read is all that is left
            // for a dialog found before the seat was ever recorded — and it is the identity a
            // refused close writes back, so the next `up` has one to compare against.
            const settled = await atDialog(op.seat, here, op.label, reading, dialogIdentity(op.seat, here.pane), op.repairLine);
            if (settled === 'idle') idleOnwards();
            break;
          }
          // A trust question is closed with no key and no text. The same for a permission or a
          // question, and for a vendor notice: it is never answered here, or anywhere.
          // The installed version is read only after the close: nothing sits between the reading
          // and the act it decides. A version outside the record's range never changes the
          // reading — a reading is never made less cautious by a version — it is what the
          // detail adds.
          const untested = () => (outcome === 'vendor notice' ? untestedOn(op.cli, host.cliVersion?.(op.cli) ?? null) : '');
          if (workspace && !host.closeWorkspace(session, workspace)) {
            // The close did not happen: nothing may claim it did, and the seat keeps its state
            // exactly as it is — a later `up` finds it where this run left it.
            held = true;
            dropped.add(op.seat);
            final(op.seat, { kind: 'left out', reason: `${reading}; its workspace did not close; left as it is` }, untested());
            break;
          }
          host.drop(op.seat);
          dropped.add(op.seat);
          const closed = `  its workspace was closed without ${outcome === 'trust' ? 'an answer' : 'input'} and the seat left out\n`;
          final(op.seat, { kind: 'left out', reason: reading }, untested() + closed);
          break;
        }
        if (
          outcome === 'timeout' &&
          (host.dialog?.mode === 'prompt' ||
            (host.dialog?.mode === 'close-no-terminal' && host.dialog.timeoutIsDialog === true))
        ) {
          // The idle wait ran out with the owner at a terminal: the owner is asked about the
          // timeout itself — open the pane, skip the seat, or stop cleanly. (The identity read is
          // the same one a found dialog makes; a prompt never closes on it.) A delegated run
          // takes the same stop as any dialog it finds: closed without input, its record saying
          // the timeout — never left at launched, which only a run that can ask may do.
          const settled = await atDialog(op.seat, here, op.label, 'timeout', dialogIdentity(op.seat, here.pane), op.repairLine);
          if (settled === 'idle') idleOnwards();
          break;
        }
        dropped.add(op.seat);
        const read = endedRead ?? host.paneText?.(session, here.pane) ?? null;
        if (outcome === 'ended') {
          // The report says only what was read: the shell has been the pane's foreground
          // program for `endedFor` seconds — the whole time since it was first seen back in
          // this wait — and no CLI prompt is on the screen. The workspace is left open; the
          // seat stays at launched, and a later `up` resumes it — the same reading covers a CLI
          // that exited and one that never began.
          final(
            op.seat,
            { kind: 'left out', reason: `its pane has been back at its shell for ${endedFor} s and shows no CLI prompt; left at launched` },
            `${paneExcerpt(read, op.command)}  run \`team up\` again to resume it\n`,
          );
          break;
        }
        const waited = Math.round((host.now() - startedAt) / 1000);
        final(
          op.seat,
          { kind: 'left out', reason: 'timeout' },
          `  timed out after ${waited} s waiting for its idle prompt; the screen last read ${last}; left at launched\n`
            + `${paneExcerpt(read, op.command)}  run \`team up\` again to resume it\n`,
        );
        break;
      }
      case 'rename': {
        host.progress?.(op.seat, 'naming');
        const here = place(op.seat, op.pane);
        if (!here) {
          dropped.add(op.seat);
          final(op.seat, { kind: 'left out', reason: 'has no pane to name; left at launched' });
          break;
        }
        const seen = await until(
          op.seconds,
          2000,
          host,
          () => host.agentPanes(session)?.includes(here.pane) === true,
        );
        if (!seen || !host.renameAgent(session, here.pane, op.seat)) {
          dropped.add(op.seat);
          final(op.seat, { kind: 'left out', reason: 'was not in the agent list in time; left at launched' });
          break;
        }
        host.record(op.seat, {
          stage: 'named',
          pane: here.pane,
          ...(here.workspace ? { workspace: here.workspace } : {}),
          ...(identities.has(op.seat) ? { launched: identities.get(op.seat) } : {}),
        });
        if (op.rules === 'option') {
          host.record(op.seat, {
            stage: 'ready',
            rules: 'option',
            pane: here.pane,
            ...(here.workspace ? { workspace: here.workspace } : {}),
            ...(identities.has(op.seat) ? { launched: identities.get(op.seat) } : {}),
          });
          finishReady(op.seat);
        }
        break;
      }
      case 'deliver': {
        host.progress?.(op.seat, 'sending its rules');
        if (op.notice) hold(op.seat, `${op.seat}: ${op.notice}\n`);
        const here = place(op.seat, op.pane);
        const file = { text: op.rules, path: op.path, line: op.line, seat: op.seat };
        const delivered = here ? await host.deliverRules?.(session, here.pane, op.cli, file, op.seconds) : false;
        if (delivered === 'no-agent') {
          dropped.add(op.seat);
          final(op.seat, { kind: 'left out', reason: 'no live agent in its pane; its rules were not delivered' });
          break;
        }
        if (typeof delivered === 'object') {
          // The specific reading goes into the log; a row of the screen itself is said on the
          // terminal alone, stripped and cut, never logged.
          dropped.add(op.seat);
          if (delivered.row !== null) {
            hold(op.seat, `${op.seat}: first row of its box that is not the rules line: ${plainPaneText(delivered.row)}\n`);
          }
          final(op.seat, { kind: 'left out', reason: refusalReport(delivered) });
          break;
        }
        if (!here || !delivered) {
          dropped.add(op.seat);
          final(op.seat, { kind: 'left out', reason: 'its rules were not delivered; left at named' });
          break;
        }
        host.record(op.seat, {
          stage: 'ready',
          rules: 'message',
          pane: here.pane,
          ...(identities.has(op.seat) ? { launched: identities.get(op.seat) } : {}),
        });
        finishReady(op.seat);
        break;
      }
      case 'watch': {
        const here = places.get(op.label);
        if (here && op.file) host.noteWatch?.(here.pane, op.file);
        if (!here || !host.paneRun(session, here.pane, op.command)) {
          watchFailed = true;
          host.say('watch: it did not start\n');
          host.log('watch', 'it did not start');
          break;
        }
        host.say('watch: started\n');
        host.log('watch', 'started');
        break;
      }
      case 'type': {
        // A seat this run asked, whose exit could not be typed or confirmed, cannot be asked.
        // `--abandon` closes its workspace in this same run, the close a not-free seat gets at
        // planning. Without it the seat stays, and the line names that close.
        const unasked = (heldLine: string, closedLine: string) => {
          if (op.closeUnasked && op.workspace) {
            if (!host.closeWorkspace(session, op.workspace)) {
              held = true;
              finish(op.seat, `${closedLine}; its workspace did not close`);
            } else {
              host.drop(op.seat);
              finish(op.seat, closedLine);
            }
          } else {
            held = true;
            finish(op.seat, op.unasked ? `${heldLine} (${op.unasked})` : heldLine);
          }
          dropped.add(op.seat);
        };
        const typed = await host.typeLine(session, op.pane, op.text);
        if (typed === 'no-agent') {
          unasked('no live agent in its pane; its exit was not typed', 'no live agent in its pane; its workspace was closed');
          break;
        }
        if (typed === 'cleared') {
          unasked(
            'its exit was not confirmed; the text was cleared; left running',
            'its exit was not confirmed; its workspace was closed',
          );
          break;
        }
        if (typeof typed === 'object') {
          unasked(typed.left, 'its exit was not confirmed; its workspace was closed');
          break;
        }
        if (!typed) {
          unasked('its exit was not typed; left as it is', 'its exit was not typed; its workspace was closed');
        }
        break;
      }
      case 'gone': {
        const gone = await until(
          op.seconds,
          2000,
          host,
          () => host.agentPanes(session)?.includes(op.pane) === false,
        );
        if (!gone) {
          if (op.closeUnasked && op.workspace) {
            if (!host.closeWorkspace(session, op.workspace)) {
              held = true;
              finish(op.seat, 'timed out leaving its pane; its workspace did not close');
            } else {
              host.drop(op.seat);
              finish(op.seat, 'timed out leaving its pane; its workspace was closed');
            }
          } else {
            held = true;
            finish(op.seat, op.unasked ? `timed out leaving its pane; left as it is (${op.unasked})` : 'timed out leaving its pane; left as it is');
          }
          dropped.add(op.seat);
        }
        break;
      }
      case 'repair': {
        host.progress?.(op.seat, 'launching');
        // The pane holds a process team did not launch (or no CLI at all): the workspace is
        // closed with no key and no text sent into it, the seat's launch state is cleared, and
        // the steps after this one launch the seat fresh, exactly as for a seat never launched.
        //
        // The close is the one destructive thing here, and the plan's reading may be minutes
        // old. Read herdr again, with nothing between these reads and the close, and close
        // only what is provably still the seat's stale pane: herdr must name this seat on the
        // recorded pane, that pane's workspace must be the recorded one, the process reading
        // must still be gone or replaced against the record, and a replaced pane's screen must
        // not read working. A drift close asks the opposite of the process: it must still be
        // the one team launched, the model must still differ, and the seat must still be free.
        // Anything else: nothing closed, nothing launched for this seat, its state left as it
        // is, and the seat out of this run.
        const listed = host.agentList ? host.agentList(session)?.find((agent) => agent.name === op.seat) : null;
        if (!listed || listed.pane !== op.pane || listed.workspace !== op.workspace) {
          held = true;
          dropped.add(op.seat);
          final(op.seat, { kind: 'left out', reason: 'herdr no longer shows this seat on its recorded pane; nothing closed; run team status' });
          break;
        }
        const panes = host.workspacePanes ? host.workspacePanes(session, op.workspace) : null;
        if (panes === null || panes.length === 0) {
          held = true;
          dropped.add(op.seat);
          final(op.seat, { kind: 'left out', reason: 'its pane could not be read; nothing closed' });
          break;
        }
        if (panes.length !== 1 || panes[0] !== op.pane) {
          held = true;
          dropped.add(op.seat);
          final(op.seat, { kind: 'left out', reason: 'its workspace holds other panes; nothing closed (close its pane there, then run team up)' });
          break;
        }
        const verdict = seatProcessVerdict(op.launched, host.processInfo?.(session, op.pane));
        if (op.drift) {
          // The process must still be the one team launched: a drift close is not the
          // stale-pane repair. Then the model must still differ, and the seat must still
          // be free. A match is the seat's again and is not an error. Anything unreadable
          // closes nothing.
          const refuse = (reason: string, error: boolean) => {
            if (error) held = true;
            dropped.add(op.seat);
            final(op.seat, { kind: 'left out', reason });
          };
          if (verdict === 'unknown') {
            refuse('its pane could not be read; nothing closed', true);
            break;
          }
          if (verdict !== 'same') {
            refuse('the process in its pane is not the one team launched; nothing closed', true);
            break;
          }
          const text = host.paneText?.(session, op.pane) ?? null;
          const running = text === null || text === '' ? null : seatModel({ cli: op.cli, model: op.drift.model }, text);
          if (text === null || text === '' || running === null || !canShowModel({ cli: op.cli, model: op.drift.model, version: op.drift.version })) {
            refuse('its pane could not be read; nothing closed', true);
            break;
          }
          if (!modelDiffers(running, op.drift)) {
            refuse('its model matches the file again; left as it is', false);
            break;
          }
          const kind = host.classify(session, op.pane, op.cli);
          const status = listed.status;
          if (status === 'working' || kind === 'working') {
            refuse(`its model drifted; left as it is (${op.drift.way})`, true);
            break;
          }
          if (!((status === 'idle' || status === 'done') && (kind === 'idle' || kind === 'unsent'))) {
            refuse('its screen is not idle or done; nothing closed', true);
            break;
          }
        } else if (verdict === 'same') {
          dropped.add(op.seat);
          final(op.seat, { kind: 'left out', reason: "its pane is the seat's again; left as it is" });
          break;
        } else if (verdict === 'unknown') {
          held = true;
          dropped.add(op.seat);
          final(op.seat, { kind: 'left out', reason: 'its pane could not be read; nothing closed' });
          break;
        } else if (verdict === 'replaced') {
          const kind = host.classify(session, op.pane, op.cli);
          if (kind === 'unknown') {
            held = true;
            dropped.add(op.seat);
            final(op.seat, { kind: 'left out', reason: 'its pane could not be read; nothing closed' });
            break;
          }
          if (kind === 'working') {
            held = true;
            dropped.add(op.seat);
            final(op.seat, { kind: 'left out', reason: `the process in its pane is working; nothing closed (stop it there, or run team remove ${op.seat})` });
            break;
          }
          if (kind === 'unsent') {
            held = true;
            dropped.add(op.seat);
            final(op.seat, { kind: 'left out', reason: `the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove ${op.seat})` });
            break;
          }
        }
        if (!host.closeWorkspace(session, op.workspace)) {
          held = true;
          dropped.add(op.seat);
          final(op.seat, { kind: 'left out', reason: 'its workspace did not close; left as it is' });
          break;
        }
        host.drop(op.seat);
        relaunched.set(op.seat, op.drift || verdict === 'same' ? 'drift' : verdict);
        break;
      }
      case 'close': {
        if (!host.closeWorkspace(session, op.workspace)) {
          held = true;
          finish(op.seat, 'its workspace did not close');
          break;
        }
        host.drop(op.seat);
        finish(op.seat, op.said ?? 'stopped');
        break;
      }
      case 'kill': {
        if (!host.kill(op.pid)) {
          held = true;
          host.say(`watch: pid ${op.pid} did not stop\n`);
        } else host.say('watch: stopped\n');
        break;
      }
      case 'stop': {
        if (held) {
          host.say(`session ${op.session}: not stopped, something was left in it\n`);
          break;
        }
        if (!host.stopSession(op.session)) {
          host.say(`session ${op.session}: it did not stop\n`);
          break;
        }
        // Without a `deleteSession` the stop is the whole step. `down` goes one further and clears
        // the session it has itself just stopped, retrying while herdr still lists it running.
        // A clear that does not happen is reported here; the next `up` of this team's own
        // session clears a stopped one itself.
        if (host.deleteSession === undefined) host.say(`session ${op.session}: stopped\n`);
        else if (await host.deleteSession(op.session)) host.say(`session ${op.session}: stopped and cleared\n`);
        else host.say(`session ${op.session}: stopped; it did not clear\n`);
        break;
      }
      default:
        break;
    }
  }

  if (stopped) {
    // §3's `q`, and Ctrl-C, which is the same: every workspace this invocation created that
    // isn't already ready is closed without input, and its seat's state cleared; then every
    // seat this run never gave a final record — the current one and the later configured,
    // non-stopped ones — is recorded `stopped cleanly`, in file order, while earlier final
    // records stand. The session goes only when this run created it and nothing is left in it:
    // a session that existed before, a ready seat and a watchdog stay. `q` is only ever read
    // inside a seat's pause, and the plan appends the watchdog's two steps after every seat's
    // (`upPlan`), so a session this run created holds no watchdog at this point — its absence
    // needs no check of its own; a watchdog running in a session is a previous run's, and such
    // a session is not this run's to stop. The agent list is what still tells of a ready seat:
    // a watchdog pane would not be on it (captured on herdr 0.7.1: a pane running `node -e …`
    // answered `herdr agent list` with `"agents":[]`).
    for (const [seat, made] of created) {
      if (ready.has(seat) || closed.has(seat)) continue;
      const lock = host.seatLock?.(seat);
      if (lock && 'held' in lock) {
        held = true;
        dropped.add(seat);
        final(seat, { kind: 'left out', reason: 'another command holds it; its workspace was left as it is' });
        continue;
      }
      try {
        // The state is never the authority for this close either: herdr's list, the workspace's
        // panes and the pane's process are read now, directly before it, with nothing between
        // the last read and the close — and the process must still be the one this run started
        // (its own read, then the record; never the pane read at the close, which would prove
        // nothing). A workspace whose pane's process changed, or cannot be proven, is left as it
        // is. The close is the workspace herdr returns for the pane, never the stored one when
        // they differ.
        const here = places.get(seat);
        const launched = identities.get(seat) ?? host.seatStates?.(session)?.[seat]?.launched;
        const target: { workspace: string } | { problem: WaitingProblem } = here
          ? closeTarget(waitingReads(here.pane), { seat, pane: here.pane, workspace: made.workspace, repairLine: made.repairLine, launched })
          : { problem: { reason: 'its pane is not known; left as it is', detail: '' } };
        if ('problem' in target) {
          held = true;
          dropped.add(seat);
          final(seat, { kind: 'left out', reason: target.problem.reason }, target.problem.detail);
          continue;
        }
        if (!host.closeWorkspace(session, target.workspace)) {
          // The close did not happen: nothing may claim it did, and the seat keeps its state.
          held = true;
          dropped.add(seat);
          final(seat, { kind: 'left out', reason: 'its workspace did not close; left as it is' });
          continue;
        }
        host.drop(seat);
        closed.add(seat);
      } finally {
        if (lock && 'release' in lock) lock.release();
      }
    }
    for (const step of steps) {
      const op = step.do;
      const seat = op && 'seat' in op ? op.seat : undefined;
      if (!seat || logged.has(seat)) continue;
      if (step.kind === 'skip' && op?.do === 'ready') {
        if (op.notice) hold(seat, `${seat}: ${op.notice}\n`);
        host.record(seat, { stage: 'ready', rules: op.rules });
        finishReady(seat);
      } else if (step.kind === 'skip' && op?.do === 'record') {
        final(seat, op.record, op.detail ?? '');
      } else {
        dropped.add(seat);
        final(seat, { kind: 'left out', reason: 'stopped cleanly' });
      }
    }
    if (createdSession) {
      const left = host.agentList?.(session) ?? null;
      if (held) host.say(`session ${session}: not stopped, something was left in it\n`);
      else if (left === null) host.say(`session ${session}: not stopped, its agents could not be read\n`);
      else if (left.length > 0) host.say(`session ${session}: not stopped, something is left in it\n`);
      else if (host.stopSession(session)) host.say(`session ${session}: stopped\n`);
      else host.say(`session ${session}: it did not stop\n`);
    }
  }

  return { serverFailed, watchFailed, held, dropped: [...dropped] };
}

// A vendor notice is classified by its predicate whatever version the CLI reports — a reading is
// never made less cautious by a version — and the record's detail says the reading was not tested
// there. Nothing is added while the record's own range covers the installed version, and nothing
// when the version cannot be read.
function untestedOn(cli: string, version: string | null): string {
  const range = vendorNoticeRange(cli);
  if (range === null || version === null) return '';
  const verdict = versionVerdict(version, range);
  return verdict === 'older' || verdict === 'newer' ? `  untested on ${version}\n` : '';
}

// The owner adds the CLI's model flag for the file's model, or corrects the file and approves it.
function modelLeft(running: Running, declared: { model: string; version: string }, cli: string): string {
  const profile = profileFor(cli);
  const flag = profile?.modelFlag(declared.model, declared.version) ?? { option: '--model', id: null };
  const id = flag.id ?? '<id>';
  return (
    `runs ${running.model} ${running.version}; the file says ${declared.model} ${declared.version}; ` +
    `left at launched, not named. Add ${flag.option} ${id} to its launch, or correct the file's model and version and run \`team approve\``
  );
}
