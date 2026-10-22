// `team next`: claim one record from the team's one task source, with a lease in this clone.
// The source is a file the owner committed, or a tracker the owner's broker reads. The broker
// holds the only tracker credential: this command asks it over `.agents/broker.sock`, one
// request line out and one answer line back, and never sees the key — the answer is the record
// after the team file's task policy filtered it. With no broker running, a broker source
// refuses and claims nothing. The lease stays local either way: a tracker-side claim is a write,
// and this build does not write to a tracker. `team plan` prints the takeable queue and claims
// nothing. `--wait` re-reads the source at `tasks.cadence` while a pass finds nothing takeable;
// without the key it refuses, and a stop ends the wait with one line.
import { dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import { askBroker, DEADLINE, NOT_RUNNING, WRONG_ANSWER } from '../broker/client.ts';
import type { BrokerRequest } from '../broker/protocol.ts';
import {
  anotherPaneRefusal,
  callerVerdict,
  describeCaller,
  judgeCallerOf,
  noPaneRefusal,
  standingOf,
} from '../caller.ts';
import { isNoRepository, loadTeamFile, withoutFileOffer } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import type { DaemonNextInput, DaemonNextOutcome } from '../daemon/next-client.ts';
import type { Command, Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import { contextLine, hasJsonFlag, writeJson, writeJsonError } from '../output/index.ts';
import type { TaskAdapter, TaskRecord, TaskRefusal } from '../tasks/adapter.ts';
import { fileRegistry } from '../tasks/file.ts';
import { formatRecords } from '../tasks/format.ts';
import { claimLocal, releaseLocal } from '../tasks/lease.ts';
import { order, takeable } from '../tasks/select.ts';
import { fileSourceOf, LOCAL_TASKS, readFileSource } from '../tasks/queue.ts';
import { pauseText, readState, type State } from '../state.ts';
import { queuedSwap, swapLine } from '../swap/queue.ts';
import { waitOrStop } from '../wait.ts';

export const USAGE = `Usage: team next [--mine | --release] [--wait] [--json]

Claims one record from the source the team file names and holds it with a lease in this clone;
without one takeable it stands down. --release unlinks the caller's own lease. --wait re-reads
the source every tasks.cadence while a pass finds nothing takeable, and cannot be read as one
--json document. A claim is a local lease: the tracker is never written.

Exits 0 when a task is claimed, released, or none is open, 1 when the caller, policy, broker, or file is refused, 2 when the invocation can't be read or this folder is neither a checkout nor a team root.
`;

export type NextSources = {
  home?: string;
  /** Injected the way a watch's sources are. The shipped registry is the file adapter alone. */
  registry?: Record<string, TaskAdapter>;
  now?: () => number;
  /** The broker client's deadline, injected the way the release check injects its timeout: a
   *  test shortens it instead of hanging. Production leaves it at the client's own. */
  deadlineMs?: number;
  /** The pause between `--wait`'s polls, in seconds; false ends the wait, the shape the watch's
   *  own wait has. Injected the way the watch's sleep is: a test steps a virtual clock through
   *  it and never sleeps. The shipped wait is `waitOrStop`. */
  wait?: (seconds: number) => Promise<boolean>;
  /** The machine daemon's next proxy. Absent, this command serves the source itself, byte for
   *  byte as before; present, one request replaces the source read and the claim, and the daemon
   *  applies its own caller, pause, swap and source gates after verifying the same claim. */
  daemonNext?: (input: DaemonNextInput) => Promise<DaemonNextOutcome>;
};

/** The one run's output state: the context line's words, whether `--json` asked for the one
 *  envelope, and whether the context line has printed. A wait prints it once, with its first
 *  answer; every later event of the same run prints only its own line. */
type Emit = {
  context: string;
  project: string;
  session: string;
  json: boolean;
  printed: boolean;
};

export type NextTaskJson = {
  id: string;
  title: string;
};

export type NextStatus = 'claimed' | 'released' | 'none';

export type NextAction = 'claim' | 'release' | 'none';

export const next: Command = (argv, io) => runNext(argv, io);
export default next;

export async function runNext(argv: string[], io: Io, sources: NextSources = {}): Promise<number> {
  const args = readArgs(argv, [], ['mine', 'release', 'wait', 'json']);
  // The raw argv, not the parser's flags: an unknown option before `--json`, or `--json=<value>`,
  // must still route the refusal through the `team.next` error document on stdout.
  const json = hasJsonFlag(argv);
  // A wait prints its events as they happen; that stream is not one document, so the two are
  // refused together, the same way `team seats` refuses --watch with --json.
  if (args.flags.has('wait') && json) {
    return invocation(io, '--wait and --json can\'t be used together', true, json);
  }
  if (args.flags.has('mine') && args.flags.has('release')) {
    return invocation(io, '--mine and --release are not used together', false, json);
  }
  if (args.flags.has('wait') && args.flags.has('release')) {
    return invocation(io, '--wait and --release are not used together', false, json);
  }
  if (args.error || args.rest.length) {
    return invocation(io, args.error ?? `unexpected "${args.rest[0]}"`, true, json);
  }
  // The folder is resolved the way every command resolves it: the checkout git names, or, in a
  // folder that is not a repository, the plain team root this folder holds (`.agents/team.yaml`
  // beside it). A folder that is neither is the no-repository refusal — `team next` takes no
  // `--file`, so the shared sentence must not offer one — and any other unreadable file keeps its
  // own exit.
  const loaded = loadTeamFile(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const problem = loaded.errors[0];
    const message = problem?.message ?? 'the team file can\'t be read';
    if (problem !== undefined && isNoRepository(problem)) {
      const shown = withoutFileOffer(message);
      if (json) writeJsonError(io, 'next.not-a-repo', shown, 'run team next from inside a checkout, or from the folder that holds .agents/team.yaml');
      else io.stderr(`team next: ${shown}\n`);
      // exit: next.not-a-repo
      return 2;
    }
    return file(io, message, json);
  }
  // A team that declares no source reads its own local queue; a missing one is an empty queue,
  // not a refusal. The declared sources keep their own reads and refusals unchanged.
  const tasks = loaded.team.tasks ?? LOCAL_TASKS;
  const emit: Emit = {
    context: contextLine(loaded.team.project, loaded.team.session),
    project: loaded.team.project,
    session: loaded.team.session,
    json,
    printed: false,
  };
  const mine = args.flags.has('mine');
  if (args.flags.has('wait')) {
    const cadence = tasks.cadence;
    if (cadence === undefined) {
      return invocation(io, '--wait needs tasks.cadence in the team file', false, json);
    }
    return pass(io, loaded, tasks, sources, mine, false, true, emit, {
      loaded,
      tasks,
      sources,
      mine,
      cadence,
      wait: sources.wait ?? waitOrStop,
      now: sources.now ?? Date.now,
    });
  }
  return pass(io, loaded, tasks, sources, mine, args.flags.has('release'), true, emit, undefined);
}

/**
 * The `--wait` loop's carry, built once by `runNext` — the one place that already holds every
 * piece — and handed down the take's chain: the cadence, the pause and the clock the loop
 * re-reads through, and what one re-pass needs to run again. A run without `--wait` carries
 * `undefined`, and its empty answer stays the one stand-down answer.
 */
type Hold = {
  loaded: { team: TeamFile; root: string; path: string };
  tasks: NonNullable<TeamFile['tasks']>;
  sources: NextSources;
  mine: boolean;
  cadence: number;
  wait: (seconds: number) => Promise<boolean>;
  now: () => number;
};

/**
 * One read-and-take pass: the whole of what a stand-down run does once the flags are read, and
 * the wait's one unit of work. `speak` decides whether the empty answer is printed: the first
 * pass prints it once, and an empty re-pass in the wait stays silent. Everything but the empty
 * answer ends the wait too, through its own printer — waiting is for emptiness, not for errors.
 */
async function pass(
  io: Io,
  loaded: { team: TeamFile; root: string; path: string },
  tasks: NonNullable<TeamFile['tasks']>,
  sources: NextSources,
  mine: boolean,
  release: boolean,
  speak: boolean,
  emit: Emit,
  hold: Hold | undefined,
): Promise<number> {
  // The team's pause and the seat's queued swap stop every claim; `--release` still runs,
  // because unlinking the lease a seat holds is how a paused or waiting seat lets go. A state
  // that can't be read claims nothing either: the pause is unknown, and an unknown stop is not
  // an absent one.
  let state: State | undefined;
  if (!release) {
    try {
      state = readState(dirname(loaded.path));
    } catch (error) {
      return file(io, plainText(error instanceof Error ? error.message : String(error)), emit.json);
    }
    const standing = state.pause;
    if (standing !== undefined) {
      const message = `the team is paused (${pauseText(standing)}); nothing new is claimed until \`team resume\``;
      return pausedAnswer(io, message, 'team resume', emit.json);
    }
  }
  // The seat gate runs before either source, and so does the queue: a seat that waits on a swap
  // takes no new task until the swap runs or is cancelled, and the line is the one `team swap`
  // and `team status` print for the record.
  const placed = place(loaded.team, loaded.root, io);
  if (placed.kind === 'refused') return callerRefuse(io, placed.message, emit.json);
  // The seat's own pause: `team pause <seat>` stops this seat alone, while the rest of the team
  // keeps claiming. It is read after the seat is placed, because the record is keyed by the
  // seat's name, and `--release` has already skipped the state read above.
  const seatStanding = state?.seat_pauses?.[placed.seat];
  if (seatStanding !== undefined) {
    const message = `the seat is paused (${pauseText(seatStanding)}); nothing new is claimed until \`team resume ${placed.seat}\``;
    return pausedAnswer(io, message, `team resume ${placed.seat}`, emit.json);
  }
  const waiting = state === undefined ? null : queuedSwap(state, placed.seat);
  if (waiting !== null) {
    const now = (sources.now ?? Date.now)();
    const message = `${placed.seat} waits on a swap: ${swapLine(placed.seat, waiting, new Date(now))}; nothing new is claimed until it runs or \`team swap cancel ${placed.seat}\``;
    return swapAnswer(io, message, `team swap cancel ${placed.seat}`, emit.json);
  }
  if (sources.daemonNext !== undefined) {
    return nextViaDaemon(io, loaded, sources.daemonNext, mine, release, speak, emit, hold, placed);
  }
  if (tasks.source === 'linear') return nextFromBroker(io, loaded, tasks, sources, mine, release, speak, emit, hold, placed);
  const registry = sources.registry ?? fileRegistry;
  const adapter = registry[tasks.source];
  if (!adapter) return file(io, 'tasks.source must be file', emit.json);
  const now = sources.now ?? Date.now;
  const at = now();
  if (release) {
    const result = adapter.release
      ? adapter.release({ root: loaded.root, seat: placed.seat, pane: placed.pane, now: at })
      : releaseLocal(loaded.root, placed.seat, placed.pane, at);
    if (result.kind === 'released') return released(io, result.id, emit);
    return none(io, 'nothing is held', speak, emit);
  }
  const source = fileSourceOf(loaded.team);
  const read = source !== null && source.local
    ? readFileSource(loaded.root, source)
    : adapter.read({ root: loaded.root, path: tasks.path });
  if (read.kind === 'missing') return missing(io, emit.json);
  if (read.kind === 'outside') return file(io, 'tasks.path must stay inside the checkout', emit.json);
  if (read.kind === 'not-a-list') {
    if (emit.json) writeJsonError(io, 'next.shape', 'the task file is not a list', 'make the task file a YAML list');
    else io.stderr('team next: the task file is not a list\n');
    return shape();
  }
  const claimFn = adapter.claim;
  const claim = claimFn
    ? (record: TaskRecord) =>
        claimFn({ root: loaded.root, path: tasks.path, record, seat: placed.seat, pane: placed.pane, now: at }).kind === 'held'
    : undefined;
  return take(io, loaded.root, read, placed, tasks.pull ?? 'self', tasks.fallback ?? 'file', mine, at, claim, speak, emit, hold);
}

/**
 * The broker source: the S2 seat gate first — the broker checks the same facts again, on the
 * request — then one request line and one answer line. The seat sends its claimed (seat, pane)
 * and nothing else; no token, because a token would live where a sibling of the same principal
 * can read it. Every failure is a refusal that claims nothing.
 */
async function nextFromBroker(
  io: Io,
  loaded: { team: TeamFile; root: string },
  tasks: Extract<NonNullable<TeamFile['tasks']>, { source: 'linear' }>,
  sources: NextSources,
  mine: boolean,
  release: boolean,
  speak: boolean,
  emit: Emit,
  hold: Hold | undefined,
  placed: { seat: string; pane: string },
): Promise<number> {
  const now = sources.now ?? Date.now;
  const at = now();
  if (release) {
    // The tracker holds no claim: the lease is local, and `--release` unlinks it without
    // reaching the broker at all.
    const result = releaseLocal(loaded.root, placed.seat, placed.pane, at);
    if (result.kind === 'released') return released(io, result.id, emit);
    return none(io, 'nothing is held', speak, emit);
  }
  const request: BrokerRequest = { op: 'read', seat: placed.seat, pane: placed.pane };
  const options = sources.deadlineMs === undefined ? {} : { deadlineMs: sources.deadlineMs };
  const outcome = await askBroker(loaded.root, request, options);
  if (outcome.kind === 'unavailable') return broker(io, NOT_RUNNING, emit.json);
  if (outcome.kind === 'wrong') return broker(io, WRONG_ANSWER, emit.json);
  if (outcome.kind === 'deadline') return broker(io, DEADLINE, emit.json);
  if (outcome.kind === 'refused') {
    if (outcome.at === 'caller') return callerRefuse(io, outcome.message, emit.json);
    return readFail(io, outcome.message, emit.json);
  }
  // This build's broker answers records for a linear source; any other read kind is an answer
  // the seat fails safe on, exactly like an unparseable line.
  if (outcome.read.kind !== 'records') return broker(io, WRONG_ANSWER, emit.json);
  // A notice about the read is for a person reading the table; a `--json` run's stderr stays
  // empty, the document on stdout being the whole answer.
  if (outcome.notice !== undefined && !emit.json) io.stderr(`team next: ${outcome.notice}\n`);
  return take(io, loaded.root, outcome.read, placed, tasks.pull ?? 'self', tasks.fallback ?? 'file', mine, at, undefined, speak, emit, hold);
}

/** The daemon proxy's transport failures. The source being unavailable keeps the command's
 *  existing `next.broker` exit; a daemon answer carries its own id and repair instead. */
const DAEMON_UNAVAILABLE = 'the team daemon is not running; nothing is claimed';
const DAEMON_WRONG_ANSWER = 'the team daemon\'s answer is not one this build knows; the owner restarts it';
const DAEMON_DEADLINE = 'the team daemon accepted the request and did not answer; nothing is claimed';

/**
 * The proxied take: the local gates have already run, and one request now stands where the
 * source read and the claim stood. The answer is the daemon's own — its success prints through
 * the same record, release and empty printers, and its refusal prints through the same exit its
 * code names, so a proxied run and a direct run cannot drift in bytes or exits.
 */
async function nextViaDaemon(
  io: Io,
  loaded: { team: TeamFile; root: string },
  proxy: (input: DaemonNextInput) => Promise<DaemonNextOutcome>,
  mine: boolean,
  release: boolean,
  speak: boolean,
  emit: Emit,
  hold: Hold | undefined,
  placed: { seat: string; pane: string },
): Promise<number> {
  let outcome: DaemonNextOutcome;
  try {
    outcome = await proxy({
      root: loaded.root,
      team: loaded.team.project,
      session: loaded.team.session,
      caller: { seat: placed.seat, pane: placed.pane },
      action: release ? 'release' : 'claim',
      mine,
    });
  } catch (error) {
    return daemonRefuse(io, plainText(error instanceof Error ? error.message : String(error)), emit.json);
  }
  if (outcome.kind === 'unavailable') return daemonRefuse(io, DAEMON_UNAVAILABLE, emit.json);
  if (outcome.kind === 'wrong') return daemonRefuse(io, DAEMON_WRONG_ANSWER, emit.json);
  if (outcome.kind === 'deadline') return daemonRefuse(io, DAEMON_DEADLINE, emit.json);
  if (outcome.kind === 'refused') return daemonRefuse(io, outcome.message, emit.json);
  const answer = outcome.answer;
  if (answer.notice !== undefined && !emit.json) io.stderr(`team next: ${answer.notice}\n`);
  if (answer.ok) {
    if (answer.kind === 'claimed') return taken(io, answer.record, emit);
    if (answer.kind === 'released') return released(io, answer.id, emit);
    const sentence = answer.why === 'nothing-held'
      ? 'nothing is held'
      : answer.why === 'nothing-assigned' ? 'nothing is assigned to you' : 'nothing is takeable';
    return blank(io, sentence, speak, emit, hold);
  }
  switch (answer.code) {
    case 'next.caller': return callerRefuse(io, answer.message, emit.json);
    case 'next.broker': return broker(io, answer.message, emit.json);
    case 'next.read': return readFail(io, answer.message, emit.json);
    case 'next.missing': return missing(io, emit.json);
    case 'next.shape':
      if (emit.json) writeJsonError(io, 'next.shape', answer.message, 'fix the named record or remove it from the task file');
      else io.stderr(`team next: ${answer.message}\n`);
      return shape();
    case 'next.paused': return pausedAnswer(io, answer.message, answer.hint ?? null, emit.json);
    case 'next.swap': return swapAnswer(io, answer.message, answer.hint ?? null, emit.json);
    case 'next.file': return file(io, answer.message, emit.json);
  }
  return daemonRefuse(io, DAEMON_WRONG_ANSWER, emit.json);
}

/** A daemon that is not there — or whose line is not one this build knows — claims nothing.
 *  It shares `broker`'s one `next.broker` site, with the daemon's own repair. */
function daemonRefuse(io: Io, message: string, json: boolean): number {
  return broker(io, message, json, 'the owner checks `team daemon status`');
}

function pausedAnswer(io: Io, message: string, hint: string | null, json: boolean): number {
  if (json) writeJsonError(io, 'next.paused', message, hint);
  else io.stderr(`team next: ${message}\n`);
  // exit: next.paused
  return 1;
}

function swapAnswer(io: Io, message: string, hint: string | null, json: boolean): number {
  if (json) writeJsonError(io, 'next.swap', message, hint);
  else io.stderr(`team next: ${message}\n`);
  // exit: next.swap
  return 1;
}

/**
 * The take itself, identical for both sources once a read exists: order the takeable records,
 * claim one — through the adapter when it carries a tracker-side claim, through the local lease
 * otherwise — and report. A notice about the read has already gone to stderr; a refusal in the
 * read is named and the exit is the shape's. The two empty answers leave through `blank`, which
 * is also where `--wait` starts and where a wait's silent re-pass continues.
 */
async function take(
  io: Io,
  root: string,
  read: { records: readonly TaskRecord[]; refusals: readonly TaskRefusal[] },
  placed: { seat: string; pane: string },
  pull: 'self' | 'any',
  fallback: 'file' | 'id',
  mine: boolean,
  at: number,
  claim: ((record: TaskRecord) => boolean) | undefined,
  speak: boolean,
  emit: Emit,
  hold: Hold | undefined,
): Promise<number> {
  const known = new Map(read.records.map((record) => [record.id, record]));
  const candidates = order(takeable(read.records, placed.seat, pull, mine), fallback);
  let outcome: { kind: 'held'; record: TaskRecord } | { kind: 'none' } | { kind: 'kept' };
  if (claim) {
    let held: TaskRecord | undefined;
    for (const record of candidates) {
      if (claim(record)) {
        held = record;
        break;
      }
    }
    outcome = held ? { kind: 'held', record: held } : { kind: 'none' };
  } else {
    outcome = claimLocal(root, { now: at, seat: placed.seat, pane: placed.pane, known, candidates });
  }
  const refused = read.refusals.map((refusal) => `${refusal.id ?? `record ${refusal.index}`} is not a task: ${refusal.reason}`);
  for (const line of refused) {
    if (!emit.json) io.stderr(`team next: ${line}\n`);
  }
  if (outcome.kind === 'held') return taken(io, outcome.record, emit);
  if (read.refusals.length) {
    if (emit.json) writeJsonError(io, 'next.shape', refused.join('; '), 'fix the named record or remove it from the task file');
    return shape();
  }
  if (outcome.kind === 'none' && mine) return blank(io, 'nothing is assigned to you', speak, emit, hold);
  return blank(io, 'nothing is takeable', speak, emit, hold);
}

/** The seat gate both `team next` and `team plan` run first: a named seat of this team, on the
 *  pane the state records for it. Shared so the two commands cannot drift. */
export function place(team: TeamFile, root: string, io: Io): { kind: 'ok'; seat: string; pane: string } | { kind: 'refused'; message: string } {
  const { caller, shown } = judgeCallerOf(io, team.session);
  const named = caller.kind === 'seat' && team.seats.some((seat) => seat.name === caller.name) ? caller : null;
  if (!named) return { kind: 'refused', message: `only a seat of this team pulls a task; this call is ${describeCaller(shown)}` };
  const verdict = callerVerdict(named, named.name, standingOf(join(root, '.agents'), team.session, named));
  if (verdict.kind === 'no-pane') return { kind: 'refused', message: noPaneRefusal(verdict.name) };
  if (verdict.kind === 'another-pane') return { kind: 'refused', message: anotherPaneRefusal(verdict.name, verdict.recordedPane) };
  if (verdict.kind !== 'ok') return { kind: 'refused', message: `only a seat of this team pulls a task; this call is ${describeCaller(shown)}` };
  return { kind: 'ok', seat: named.name, pane: named.pane };
}

function invocation(io: Io, message: string, usage: boolean, json = false): number {
  if (json) writeJsonError(io, 'next.invocation', message, null);
  else io.stderr(`team next: ${message}\n${usage ? USAGE : ''}`);
  // exit: next.invocation
  return 2;
}

/** The team file, or the tasks section's rules: the policy refusals leave through here too —
 *  the exit-codes suite's other face of this same return. */
function file(io: Io, message: string, json: boolean): number {
  if (json) writeJsonError(io, 'next.file', message, null);
  else io.stderr(`team next: ${message}\n`);
  // exit: next.file
  // exit: next.policy
  return 1;
}

function missing(io: Io, json: boolean): number {
  if (json) writeJsonError(io, 'next.missing', 'the task file is not there', null);
  else io.stderr('team next: the task file is not there\n');
  // exit: next.missing
  return 1;
}

function shape(): number {
  // exit: next.shape
  return 1;
}

function callerRefuse(io: Io, message: string, json: boolean): number {
  if (json) writeJsonError(io, 'next.caller', message, 'the owner records this seat\'s pane and runs `team up`');
  else io.stderr(`team next: ${message}\n`);
  // exit: next.caller
  return 1;
}

function broker(io: Io, message: string, json: boolean, repair = 'the owner starts the broker with `team broker`'): number {
  if (json) writeJsonError(io, 'next.broker', message, repair);
  else io.stderr(`team next: ${message}\n`);
  // exit: next.broker
  return 1;
}

function readFail(io: Io, message: string, json: boolean): number {
  if (json) writeJsonError(io, 'next.read', message, null);
  else io.stderr(`team next: ${message}\n`);
  // exit: next.read
  return 1;
}

/** The plain answer's context line, once per run: a wait's later events do not repeat it. */
function contextOut(io: Io, emit: Emit): void {
  if (emit.printed) return;
  io.stdout(`${emit.context}\n`);
  emit.printed = true;
}

/** The claimed record, as the `--json` envelope carries it: id and title, the contract's pair. */
function taskJson(record: TaskRecord): NextTaskJson {
  return { id: record.id, title: record.title };
}

function success(io: Io, emit: Emit, status: NextStatus, action: NextAction, actionSummary: string, task: NextTaskJson | null): void {
  writeJson(io, 'team.next', {
    format: 1 as const,
    dry_run: false,
    status,
    action,
    action_summary: actionSummary,
    project: emit.project,
    session: emit.session,
    task,
  });
}

function none(io: Io, sentence: string, speak: boolean, emit: Emit): number {
  const summary = `team next: ${sentence}`;
  if (emit.json) success(io, emit, 'none', 'none', summary, null);
  else if (speak) {
    contextOut(io, emit);
    io.stdout(`${summary}\n`);
  }
  // exit: next.none
  return 0;
}

function released(io: Io, id: string, emit: Emit): number {
  const summary = `team next: released ${id}`;
  if (emit.json) success(io, emit, 'released', 'release', summary, null);
  else {
    contextOut(io, emit);
    io.stdout(`${summary}\n`);
  }
  // exit: next.released
  return 0;
}

function taken(io: Io, record: TaskRecord, emit: Emit): number {
  if (emit.json) {
    success(io, emit, 'claimed', 'claim', `team next: claimed ${record.id}`, taskJson(record));
  } else {
    contextOut(io, emit);
    io.stdout(formatRecords([record]));
    io.stdout(`team next: claimed ${record.id}\n`);
  }
  // exit: next.taken
  return 0;
}

/** The wait's own end: the signal, or a clock that did not advance. One line, exit 0, and the
 *  wait's own row — a take or a refusal ends the wait through its own printer instead. */
function stopped(io: Io, emit: Emit): number {
  contextOut(io, emit);
  io.stdout('team next: stopped waiting\n');
  // exit: next.wait
  return 0;
}

/**
 * The take's two empty answers, and the wait's door. Without a hold it is one answer and the
 * stand-down exit. Under `--wait` the first empty pass prints the shipped sentence once and the
 * waiting line, and the loop takes over; an empty re-pass is silent, and the loop's pace and
 * clock are the hold's.
 */
async function blank(io: Io, sentence: string, speak: boolean, emit: Emit, hold: Hold | undefined): Promise<number> {
  if (!hold) return none(io, sentence, speak, emit);
  if (speak) {
    contextOut(io, emit);
    io.stdout(`team next: ${sentence}\n`);
    return begin(io, hold, emit);
  }
  return poll(io, hold, emit);
}

/** The wait's opening: the one waiting line, then the first poll. Reached from the first empty
 *  pass alone — that pass has already printed the shipped sentence once. */
async function begin(io: Io, hold: Hold, emit: Emit): Promise<number> {
  io.stdout(`team next: waiting every ${hold.cadence}s\n`);
  return poll(io, hold, emit);
}

/**
 * One poll of the wait: pause, then re-read and re-take. The pause's false — a stop signal —
 * ends the wait, and so does a clock that did not move past the reading taken before it: a
 * stuck time must not spin a seat's pane forever. The re-pass is a full pass: a record taken,
 * and a refusal, end the wait through their own printers and their own bytes.
 */
async function poll(io: Io, hold: Hold, emit: Emit): Promise<number> {
  const before = hold.now();
  if (!(await hold.wait(hold.cadence))) return stopped(io, emit);
  if (hold.now() <= before) return stopped(io, emit);
  return pass(io, hold.loaded, hold.tasks, hold.sources, hold.mine, false, false, emit, hold);
}
