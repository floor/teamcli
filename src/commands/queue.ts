// `team queue add|list|ready|install`: the team's local task queue. The queue is the task source only when the
// team file declares none — then `.agents/queue.yaml` under the team root. A team that declares
// a file source keeps its own path and a team that declares a broker source has no local queue:
// this command writes no tracker ever. Adding is the owner's or a declared seat's, on the pane
// the state records; the add itself is atomic and validated through the file adapter, so a file
// the reader would refuse is never installed. A listing claims nothing and writes nothing.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readArgs } from '../args.ts';
import { version } from '../version.ts';
import {
  anotherPaneRefusal,
  callerVerdict,
  describeCaller,
  judgeCallerOf,
  noPaneRefusal,
  standingOf,
} from '../caller.ts';
import { isNoRepository, withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import {
  contextLine,
  hasJsonFlag,
  pluralCount,
  writeJson,
  writeJsonError,
} from '../output/index.ts';
import type { TaskRecord, TaskRefusal } from '../tasks/adapter.ts';
import { formatRecords } from '../tasks/format.ts';
import { addToQueue, fileSourceOf, isTaskId, readFileSource, type FileSource } from '../tasks/queue.ts';
import { installSlice, readySlice, readSliceWords, type SliceRefusal } from '../tasks/slice-handler.ts';

export const USAGE = `Usage: team queue add <title> --id <id> [--assignee <name>] [--priority <value>] [--json]
       team queue list [--json]
       team queue ready <task> --commit <sha> [--version <version>] [--json]
       team queue install <task> --commit <sha> [--version <version>] [--json]

Adds one record to the team's local task queue, or lists it. The local queue is the task source
only when the team file declares none: then \`.agents/queue.yaml\` under the team root. A team
that declares a file source is written at its own path; a team that declares a broker source
(\`linear\`) has no local queue, and the tracker is never written. An id already queued is present
and not rewritten; the same id with another record is refused. A listing claims nothing.

A seat records a slice ready for a task it holds the live lease of, and the owner, or the one
seat the approved team file designates as the installer, records an install. The seat and the
installer are the verified caller, never an argument. Only an install record covers a ready
slice: no merge, clock, or version comparison does.

Exits 0 when the record is added or already present, when the queue is listed, and when a green
slice is recorded or already held, 1 when the caller, source, lease, installer, or queue file is
refused, 2 when the invocation can't be read or this folder is neither a checkout nor a team root.
`;

export type QueueSources = {
  home?: string;
  /** The clock the lease and the journal are judged against; the machine's when unset. */
  now?: () => number;
};

export const queue: Command = (argv, io) => runQueue(argv, io);
export default queue;

export async function runQueue(argv: string[], io: Io, sources: QueueSources = {}): Promise<number> {
  const out = cleanedIo(io);
  // One readArgs call for every verb: the first positional is the verb, the next word the title
  // or the task. Each verb then refuses the flags it does not read.
  const args = readArgs(argv, ['id', 'assignee', 'priority', 'commit', 'version'], ['json']);
  // The raw argv, not the parser's flags: an unknown option before `--json`, or `--json=<value>`,
  // must still route the refusal through the `team.queue` error document on stdout.
  const json = hasJsonFlag(argv);
  if (args.error) return invocation(io, out, json, args.error, true);
  const word = args.rest[0];
  if (word === undefined) return invocation(io, out, json, 'a word is required', true);
  if (word !== 'add' && word !== 'list' && word !== 'ready' && word !== 'install') {
    return invocation(io, out, json, `unexpected "${word}"`, true);
  }
  // The folder is resolved the way every command resolves it: the checkout git names, or, in a
  // folder that is not a repository, the plain team root this folder holds (`.agents/team.yaml`
  // beside it). A folder that is neither is the no-repository refusal — `team queue` takes no
  // `--file`, so the shared sentence must not offer one — and any other unreadable file keeps
  // its own exit.
  const home = sources.home ?? homedir();
  const loaded = readTeamConfig(io.cwd, { home });
  if (!loaded.ok) {
    const problem = loaded.errors[0];
    const message = problem?.message ?? 'the team file can\'t be read';
    if (problem !== undefined && isNoRepository(problem)) {
      const shown = withoutFileOffer(message);
      if (json) writeJsonError(io, 'queue.not-a-repo', shown, 'run team queue from inside a checkout, or from the folder that holds .agents/team.yaml');
      else out.stderr(`team queue: ${shown}\n`);
      // exit: queue.not-a-repo
      return 2;
    }
    return fileRefuse(io, json, message);
  }
  const source = fileSourceOf(loaded.team);
  if (source === null) {
    return sourceRefuse(io, json, 'the team file declares a linear task source; there is no local queue, and the tracker is never written');
  }
  if (word === 'list') return list(io, out, loaded.team, loaded.root, source, args, json);
  if (word === 'ready') return ready(io, out, loaded.team, loaded.root, args, json, sources);
  if (word === 'install') return install(io, out, loaded.team, loaded.root, args, json, home, sources);
  return add(io, out, loaded.team, loaded.root, source, args, json);
}

/** The add: argument validation, the caller gate, then the queue module's atomic add. */
function add(
  io: Io,
  out: Io,
  team: TeamFile,
  root: string,
  source: FileSource,
  args: { values: Record<string, string>; rest: string[] },
  json: boolean,
): number {
  const title = args.rest[1];
  if (title === undefined) return invocation(io, out, json, 'a title is required', true);
  if (args.rest.length > 2) return invocation(io, out, json, `unexpected "${args.rest[2]}"`, false);
  for (const flag of ['commit', 'version']) {
    if (args.values[flag] !== undefined) return invocation(io, out, json, `--${flag} is not used by queue add`, false);
  }
  const id = args.values.id;
  if (id === undefined) return invocation(io, out, json, '--id is required', true);
  if (!isTaskId(id)) {
    return invocation(io, out, json, `"${id}" is not a task id: use letters, digits, dot, dash or underscore, starting with a letter or digit`, false);
  }
  if (title.length === 0 || title.length > 200 || title.includes('\n') || title.includes('\r')) {
    return invocation(io, out, json, 'the title must be one line of 1 to 200 characters', false);
  }
  const assignee = args.values.assignee;
  if (assignee !== undefined && !team.seats.some((seat) => seat.name === assignee)) {
    return invocation(io, out, json, `assignee "${assignee}" is not a seat of this team`, false);
  }
  const priority = priorityOf(args.values.priority);
  if (priority === 'bad') {
    return invocation(io, out, json, '--priority must be one line of text or a number', false);
  }
  const allowed = addCaller(team, root, io);
  if (allowed.kind === 'refused') return callerRefuse(io, json, allowed.message);
  const record: TaskRecord = { id, title };
  if (priority !== undefined) record.priority = priority;
  if (assignee !== undefined) record.assignee = assignee;
  const result = addToQueue(root, source, record);
  if (result.kind === 'outside') return readRefuse(io, json, 'tasks.path must stay inside the checkout');
  if (result.kind === 'missing') return readRefuse(io, json, 'the task file is not there');
  if (result.kind === 'not-a-list') return readRefuse(io, json, 'the queue file is not a list');
  if (result.kind === 'unreadable') return readRefuse(io, json, result.message);
  if (result.kind === 'duplicate') {
    if (json) writeJsonError(io, 'queue.duplicate', `${result.record.id} is already queued with a different record`, `edit ${result.path} or choose another id`);
    else out.stderr(`team queue: ${result.record.id} is already queued with a different record; edit ${result.path} or choose another id\n`);
    // exit: queue.duplicate
    return 1;
  }
  const refusals = result.refusals.map(refusalLine);
  // A refusal beside the added record is a note to a person; under `--json` the document on
  // stdout is the whole answer, and stderr stays empty.
  if (!json) for (const line of refusals) out.stderr(`team queue: ${line}\n`);
  if (json) {
    writeJson(io, 'team.queue', {
      format: 1 as const,
      project: team.project,
      session: team.session,
      source: source.local ? 'local' : 'file',
      path: source.path,
      status: result.kind === 'added' ? 'added' : 'present',
      task: queueTask(result.record),
      tasks: result.records.map(queueTask),
    });
  } else {
    io.stdout(`${contextLine(team.project, team.session)}\n`);
    if (result.kind === 'added') io.stdout(`queued ${result.record.id} in ${source.path}\n`);
    else io.stdout(`${result.record.id} is already queued in ${source.path}\n`);
  }
  if (result.kind === 'added') {
    // exit: queue.added
    return 0;
  }
  // exit: queue.present
  return 0;
}

/** The listing: the same read `team next` would make, in file order, and no claim. */
function list(
  io: Io,
  out: Io,
  team: TeamFile,
  root: string,
  source: FileSource,
  args: { values: Record<string, string>; rest: string[] },
  json: boolean,
): number {
  if (args.rest.length > 1) return invocation(io, out, json, `unexpected "${args.rest[1]}"`, false);
  const flags = Object.keys(args.values);
  if (flags.length > 0) return invocation(io, out, json, `--${flags[0]} is not used by queue list`, false);
  const read = readFileSource(root, source);
  if (read.kind === 'missing') return readRefuse(io, json, 'the task file is not there');
  if (read.kind === 'outside') return readRefuse(io, json, 'tasks.path must stay inside the checkout');
  if (read.kind === 'not-a-list') return readRefuse(io, json, 'the queue file is not a list');
  if (read.records.length === 0 && read.refusals.length > 0) {
    return readRefuse(io, json, read.refusals.map(refusalLine).join('; '), 'fix the named record or remove it from the queue');
  }
  // A refusal beside a listed record is a note to a person; under `--json` the document on
  // stdout is the whole answer, and stderr stays empty.
  if (!json) for (const refusal of read.refusals) out.stderr(`team queue: ${refusalLine(refusal)}\n`);
  if (json) {
    writeJson(io, 'team.queue', {
      format: 1 as const,
      project: team.project,
      session: team.session,
      source: source.local ? 'local' : 'file',
      path: source.path,
      tasks: read.records.map(queueTask),
    });
  } else if (read.records.length === 0) {
    io.stdout(`${contextLine(team.project, team.session)}\n${pluralCount(0, 'task')}\n`);
  } else {
    io.stdout(`${contextLine(team.project, team.session)}\n${formatRecords(read.records)}${pluralCount(read.records.length, 'task')}\n`);
  }
  if (read.records.length === 0) {
    // exit: queue.none
    return 0;
  }
  // exit: queue.shown
  return 0;
}

/**
 * `ready`: a seat's own record that a finished, green commit awaits the installer. The seat is
 * the verified caller on the pane the state records for it — never an argument — and it must
 * hold the live lease of the task it names. The task must be in the team's queue. The install
 * is not implied by any of this: only an install event covers the slice.
 */
function ready(
  io: Io,
  out: Io,
  team: TeamFile,
  root: string,
  args: { values: Record<string, string>; rest: string[] },
  json: boolean,
  sources: QueueSources,
): number {
  const parsed = sliceArgs('ready', args);
  if (parsed.kind === 'refused') return invocation(io, out, json, parsed.message, parsed.usage);
  const { caller, shown } = judgeCallerOf(io, team.session);
  const result = readySlice(team, root, {
    caller,
    described: describeCaller(shown),
    task: parsed.task,
    commit: parsed.commit,
    version: parsed.version,
    now: sources.now?.() ?? Date.now(),
    env: io.env,
  });
  if (!result.ok) return sliceRefuse(io, json, result.refusal);
  const event = result.event;
  if (json) {
    writeJson(io, 'team.green-slice', {
      format: 1 as const,
      project: team.project,
      session: team.session,
      action: 'ready',
      status: result.status,
      event,
    });
  } else {
    io.stdout(`${contextLine(team.project, team.session)}\n`);
    if (result.status === 'recorded') io.stdout(`ready ${event.task} at ${event.commit} (${event.version}) for ${event.seat}\n`);
    else io.stdout(`${event.task} at ${event.commit} (${event.version}) is already recorded ready for ${event.seat}\n`);
  }
  // exit: queue.ready
  return 0;
}

/**
 * `install`: the installer's explicit acknowledgment that a commit is installed. The owner
 * records it, or the one seat the file designates with an approved `installer:`, on its
 * recorded pane. Running the verb is the acknowledgment: no merge, clock or version comparison
 * stands in for it, and `installedBy` is the verified caller, never an argument. It records an
 * acknowledgment only; it installs nothing itself.
 */
function install(
  io: Io,
  out: Io,
  team: TeamFile,
  root: string,
  args: { values: Record<string, string>; rest: string[] },
  json: boolean,
  home: string,
  sources: QueueSources,
): number {
  const parsed = sliceArgs('install', args);
  if (parsed.kind === 'refused') return invocation(io, out, json, parsed.message, parsed.usage);
  const { caller, shown } = judgeCallerOf(io, team.session);
  const result = installSlice(team, root, home, {
    caller,
    described: describeCaller(shown),
    task: parsed.task,
    commit: parsed.commit,
    version: parsed.version,
    now: sources.now?.() ?? Date.now(),
    env: io.env,
  });
  if (!result.ok) return sliceRefuse(io, json, result.refusal);
  const event = result.event;
  if (json) {
    writeJson(io, 'team.green-slice', {
      format: 1 as const,
      project: team.project,
      session: team.session,
      action: 'install',
      status: result.status,
      event,
    });
  } else {
    io.stdout(`${contextLine(team.project, team.session)}\n`);
    if (result.status === 'recorded') io.stdout(`installed ${event.task} at ${event.commit} (${event.version}) by ${event.installedBy}\n`);
    else io.stdout(`${event.task} at ${event.commit} (${event.version}) is already recorded installed by ${event.installedBy}\n`);
  }
  // exit: queue.install
  return 0;
}

/** The words both producer verbs read: the task, `--commit`, and the build version (the running
 *  one unless `--version` names another). A malformed word is the invocation's refusal, so the
 *  journal's recorders are never asked to explain an argument. The words are validated by the
 *  same reader the host boundary uses, so the CLI and a daemon door refuse alike. */
function sliceArgs(
  name: 'ready' | 'install',
  args: { values: Record<string, string>; rest: string[] },
): { kind: 'ok'; task: string; commit: string; version: string } | { kind: 'refused'; message: string; usage: boolean } {
  for (const flag of ['id', 'assignee', 'priority']) {
    if (args.values[flag] !== undefined) return { kind: 'refused', message: `--${flag} is not used by queue ${name}`, usage: false };
  }
  if (args.rest.length > 2) return { kind: 'refused', message: `unexpected "${args.rest[2]}"`, usage: false };
  const read = readSliceWords({
    task: args.rest[1],
    commit: args.values.commit,
    version: args.values.version,
    defaultVersion: version(),
  });
  if (!read.ok) return { kind: 'refused', message: read.message, usage: read.usage };
  return { kind: 'ok', ...read.words };
}

/** The caller rule the map's row names: the owner, or a declared seat of this team on the pane
 *  the state records for it. Another team's seat and a run the state cannot place are refused. */
function addCaller(team: TeamFile, root: string, io: Io): { kind: 'ok' } | { kind: 'refused'; message: string } {
  const { caller, shown } = judgeCallerOf(io, team.session);
  if (caller.kind === 'owner') return { kind: 'ok' };
  const named = caller.kind === 'seat' && team.seats.some((seat) => seat.name === caller.name) ? caller : null;
  if (!named) {
    return {
      kind: 'refused',
      message: `only the owner or a seat of this team adds to the queue; this call is ${describeCaller(shown)}`,
    };
  }
  const verdict = callerVerdict(named, named.name, standingOf(join(root, '.agents'), team.session, named));
  if (verdict.kind === 'no-pane') return { kind: 'refused', message: noPaneRefusal(verdict.name) };
  if (verdict.kind === 'another-pane') return { kind: 'refused', message: anotherPaneRefusal(verdict.name, verdict.recordedPane) };
  if (verdict.kind !== 'ok') {
    return {
      kind: 'refused',
      message: `only the owner or a seat of this team adds to the queue; this call is ${describeCaller(shown)}`,
    };
  }
  return { kind: 'ok' };
}

/** `--priority` as the file adapter reads it: a plain number becomes a number, so `team next`
 *  orders it numerically; any other one-line text stays text. */
function priorityOf(value: string | undefined): string | number | undefined | 'bad' {
  if (value === undefined) return undefined;
  if (value === '' || value.includes('\n') || value.includes('\r')) return 'bad';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function queueTask(record: TaskRecord): { id: string; title: string; assignee: string | null; priority?: string | number } {
  return {
    id: record.id,
    title: record.title,
    assignee: record.assignee ?? null,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
  };
}

function refusalLine(refusal: TaskRefusal): string {
  return `${refusal.id ?? `record ${refusal.index}`} is not a task: ${refusal.reason}`;
}

function invocation(io: Io, out: Io, json: boolean, message: string, usage: boolean): number {
  if (json) writeJsonError(io, 'queue.invocation', message, null);
  else out.stderr(`team queue: ${message}\n${usage ? USAGE : ''}`);
  // exit: queue.invocation
  return 2;
}

function fileRefuse(io: Io, json: boolean, message: string): number {
  if (json) writeJsonError(io, 'queue.file', message, null);
  else io.stderr(`team queue: ${message}\n`);
  // exit: queue.file
  return 1;
}

function sourceRefuse(io: Io, json: boolean, message: string): number {
  if (json) writeJsonError(io, 'queue.source', message, null);
  else io.stderr(`team queue: ${message}\n`);
  // exit: queue.source
  return 1;
}

function callerRefuse(io: Io, json: boolean, message: string): number {
  if (json) writeJsonError(io, 'queue.caller', message, 'the owner records this seat\'s pane and runs `team up`');
  else io.stderr(`team queue: ${message}\n`);
  // exit: queue.caller
  return 1;
}

function readRefuse(io: Io, json: boolean, message: string, repair: string | null = null): number {
  if (json) writeJsonError(io, 'queue.read', message, repair);
  else io.stderr(`team queue: ${message}\n`);
  // exit: queue.read
  return 1;
}

function leaseRefuse(io: Io, json: boolean, message: string): number {
  if (json) writeJsonError(io, 'queue.lease', message, '`team next` takes the lease of a task the seat starts');
  else io.stderr(`team queue: ${message}\n`);
  // exit: queue.lease
  return 1;
}

function installerRefuse(io: Io, json: boolean, message: string): number {
  if (json) writeJsonError(io, 'queue.installer', message, 'the owner records `installer:` in the team file and approves it');
  else io.stderr(`team queue: ${message}\n`);
  // exit: queue.installer
  return 1;
}

function recordRefuse(io: Io, json: boolean, message: string): number {
  if (json) writeJsonError(io, 'queue.record', message, 'fix the green-slice journal named above, then record again');
  else io.stderr(`team queue: ${message}\n`);
  // exit: queue.record
  return 1;
}

/** A producer event's refusal, written under the id the boundary reported: the event core names
 *  the refusal once, and the CLI only renders it, so a host door and the CLI report the same id. */
function sliceRefuse(io: Io, json: boolean, refusal: SliceRefusal): number {
  const { id, message } = refusal;
  if (id === 'queue.caller') return callerRefuse(io, json, message);
  if (id === 'queue.installer') return installerRefuse(io, json, message);
  if (id === 'queue.lease') return leaseRefuse(io, json, message);
  if (id === 'queue.read') return readRefuse(io, json, message);
  if (id === 'queue.record') return recordRefuse(io, json, message);
  return sourceRefuse(io, json, message);
}
