// `team plan`: print the queue a claim would consider, in `team next`'s order — the same seat
// gate, the same read, the same ordering, against this clone's clock. It is a listing: it claims
// nothing and writes no lease, so a record another seat holds can still appear. A deadline the
// clock has passed reads `overdue` in the STATE column; the mark decides nothing — an overdue
// record is still takeable and is never dropped, blocked, reordered or released by lateness.
import { readArgs } from '../args.ts';
import { askBroker, DEADLINE, NOT_RUNNING, WRONG_ANSWER } from '../broker/client.ts';
import type { BrokerRequest } from '../broker/protocol.ts';
import { isNoRepository, withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import {
  contextLine,
  hasJsonFlag,
  pluralCount,
  renderTable,
  ttyStyle,
  writeJson,
  writeJsonError,
  type OutputSchemaTag,
} from '../output/index.ts';
import type { TaskAdapter, TaskRecord, TaskRefusal } from '../tasks/adapter.ts';
import { fileRegistry } from '../tasks/file.ts';
import { fileSourceOf, LOCAL_TASKS, readFileSource } from '../tasks/queue.ts';
import { order, takeable } from '../tasks/select.ts';
import { place } from './next.ts';

export const USAGE = `Usage: team plan [--json]

Prints the queue a claim would consider, in team next's order — priority first, then the
tasks.fallback tie-break — against this clone's clock. Reads the checkout, the team file, the
task file or the owner's broker; claims nothing and writes no lease. A deadline the clock has
passed reads overdue in the STATE column and decides nothing.

Exits 0 when the plan is shown, 1 when the caller, broker, or file is refused, 2 when the invocation can't be read or this folder is neither a checkout nor a team root.
`;

export type PlanSources = {
  home?: string;
  /** Injected the way `team next`'s sources are. The shipped registry is the file adapter alone. */
  registry?: Record<string, TaskAdapter>;
  now?: () => number;
  /** The broker client's deadline, injected the way the release check injects its timeout: a
   *  test shortens it instead of hanging. Production leaves it at the client's own. */
  deadlineMs?: number;
};

export type PlanState = 'open' | 'overdue';

export interface PlanTaskJson {
  step: number;
  state: PlanState;
  owner: string | null;
  id: string;
  title: string;
  priority?: string | number;
  milestone?: string;
  deadline?: string;
  description?: string;
}

export interface PlanJson {
  schema: OutputSchemaTag;
  format: 1;
  project: string;
  session: string;
  tasks: PlanTaskJson[];
}

export const plan: Command = (argv, io) => runPlan(argv, io);
export default plan;

/** The deadline rule `team plan` has always had: a deadline `Date.parse` can read and the clock
 *  has passed is overdue; the comparison is strictly before now, so the deadline itself is not. */
export function planState(record: TaskRecord, at: number): PlanState {
  if (record.deadline === undefined) return 'open';
  return Date.parse(record.deadline) < at ? 'overdue' : 'open';
}

function planTask(record: TaskRecord, step: number, at: number): PlanTaskJson {
  return {
    step,
    state: planState(record, at),
    owner: record.assignee ?? null,
    id: record.id,
    title: record.title,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    ...(record.milestone !== undefined ? { milestone: record.milestone } : {}),
    ...(record.deadline !== undefined ? { deadline: record.deadline } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
  };
}

export async function runPlan(argv: string[], io: Io, sources: PlanSources = {}): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, [], ['json']);
  // The raw argv, not the parser's flags: an unknown option before `--json`, or `--json=<value>`,
  // must still route the refusal through the `team.plan` error document on stdout.
  const json = hasJsonFlag(argv);
  if (args.error || args.rest.length) {
    const why = plainText(args.error ?? `unexpected "${args.rest[0]}"`);
    if (json) writeJsonError(io, 'plan.invocation', why, null);
    else out.stderr(`team plan: ${why}\n${USAGE}`);
    // exit: plan.invocation
    return 2;
  }
  // The folder is resolved the way every command resolves it: the checkout git names, or, in a
  // folder that is not a repository, the plain team root this folder holds (`.agents/team.yaml`
  // beside it). A folder that is neither is the no-repository refusal — `team plan` takes no
  // `--file`, so the shared sentence must not offer one — and any other unreadable file keeps its
  // own exit.
  const loaded = readTeamConfig(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const problem = loaded.errors[0];
    const message = problem?.message ?? 'the team file can\'t be read';
    if (problem !== undefined && isNoRepository(problem)) {
      const shown = withoutFileOffer(message);
      if (json) writeJsonError(io, 'plan.not-a-repo', shown, 'run team plan from inside a checkout, or from the folder that holds .agents/team.yaml');
      else out.stderr(`team plan: ${shown}\n`);
      // exit: plan.not-a-repo
      return 2;
    }
    return file(io, message, json);
  }
  // A team that declares no source reads its own local queue; a missing one is an empty queue,
  // not a refusal. The declared sources keep their own reads and refusals unchanged.
  const tasks = loaded.team.tasks ?? LOCAL_TASKS;
  if (tasks.source === 'linear') {
    return planFromBroker(io, loaded, tasks, sources, json);
  }
  const registry = sources.registry ?? fileRegistry;
  const adapter = registry[tasks.source];
  if (!adapter) return file(io, 'tasks.source must be file', json);
  const placed = place(loaded.team, loaded.root, io);
  if (placed.kind === 'refused') return callerRefuse(io, placed.message, json);
  const source = fileSourceOf(loaded.team);
  const read = source !== null && source.local
    ? readFileSource(loaded.root, source)
    : adapter.read({ root: loaded.root, path: tasks.path });
  if (read.kind === 'missing') return missing(io, json);
  if (read.kind === 'outside') return file(io, 'tasks.path must stay inside the checkout', json);
  if (read.kind === 'not-a-list') {
    if (json) writeJsonError(io, 'plan.shape', 'the task file is not a list', 'make the task file a YAML list');
    else out.stderr('team plan: the task file is not a list\n');
    return shape();
  }
  return show(io, read, placed.seat, tasks.pull ?? 'self', tasks.fallback ?? 'file', sources.now ?? Date.now, loaded.team, json);
}

/**
 * The broker source: the same gate and the same read `team next` asks — one request line and one
 * answer line — and no claim of any kind on either side. Every failure is a refusal.
 */
async function planFromBroker(
  io: Io,
  loaded: { team: TeamFile; root: string },
  tasks: Extract<NonNullable<TeamFile['tasks']>, { source: 'linear' }>,
  sources: PlanSources,
  json: boolean,
): Promise<number> {
  const placed = place(loaded.team, loaded.root, io);
  if (placed.kind === 'refused') return callerRefuse(io, placed.message, json);
  const request: BrokerRequest = { op: 'read', seat: placed.seat, pane: placed.pane };
  const options = sources.deadlineMs === undefined ? {} : { deadlineMs: sources.deadlineMs };
  const outcome = await askBroker(loaded.root, request, options);
  if (outcome.kind === 'unavailable') return broker(io, NOT_RUNNING, json);
  if (outcome.kind === 'wrong') return broker(io, WRONG_ANSWER, json);
  if (outcome.kind === 'deadline') return broker(io, DEADLINE, json);
  if (outcome.kind === 'refused') {
    if (outcome.at === 'caller') return callerRefuse(io, outcome.message, json);
    return readFail(io, outcome.message, json);
  }
  // This build's broker answers records for a linear source; any other read kind is an answer
  // the seat fails safe on, exactly like an unparseable line.
  if (outcome.read.kind !== 'records') return broker(io, WRONG_ANSWER, json);
  // A notice about the read is for a person reading the table; a `--json` run's stderr stays
  // empty, the document on stdout being the whole answer.
  if (outcome.notice !== undefined && !json) io.stderr(`team plan: ${outcome.notice}\n`);
  return show(io, outcome.read, placed.seat, tasks.pull ?? 'self', tasks.fallback ?? 'file', sources.now ?? Date.now, loaded.team, json);
}

/**
 * One pass of the read path — the takeable records, ordered — with no claim and no write. A
 * refusal in the read is named on stderr and is not a candidate. The plain table carries the
 * step, its state, the owner and the title; a held record still appears: it is in the queue a
 * claim would consider, and this command claims nothing.
 */
function show(
  io: Io,
  read: { records: readonly TaskRecord[]; refusals: readonly TaskRefusal[] },
  seat: string,
  pull: 'self' | 'any',
  fallback: 'file' | 'id',
  now: () => number,
  team: TeamFile,
  json: boolean,
): number {
  const at = now();
  const candidates = order(takeable(read.records, seat, pull, false), fallback);
  const named = read.refusals.map((refusal) => `${refusal.id ?? `record ${refusal.index}`} is not a task: ${refusal.reason}`);
  if (candidates.length === 0 && read.refusals.length > 0) {
    if (json) writeJsonError(io, 'plan.shape', named.join('; '), 'fix the named record or remove it from the task file');
    else for (const line of named) io.stderr(`team plan: ${line}\n`);
    return shape();
  }
  // A read refusal beside a candidate is a note to a person reading the table: under `--json`
  // the document on stdout is the whole answer, and stderr stays empty.
  if (!json) for (const line of named) io.stderr(`team plan: ${line}\n`);
  if (json) {
    writeJson(io, 'team.plan', {
      format: 1 as const,
      project: team.project,
      session: team.session,
      tasks: candidates.map((record, index) => planTask(record, index + 1, at)),
    });
  }
  const out = cleanedIo(io);
  const context = contextLine(team.project, team.session);
  if (candidates.length === 0) {
    if (!json) io.stdout(`${context}\n${pluralCount(0, 'task')}\n`);
    // exit: plan.none
    return 0;
  }
  if (!json) {
    const style = ttyStyle(io, { json: false });
    const lines = [
      context,
      ...renderTable({
        headers: ['STEP', 'STATE', 'OWNER', 'TITLE'],
        rows: candidates.map((record, index) => [String(index + 1), planState(record, at), record.assignee ?? '-', record.title]),
        style,
      }),
      pluralCount(candidates.length, 'task'),
    ];
    // Through `io`, not the cleaned view: the style above is this io's TTY style, and the
    // cleaned view would strip the very bold the table was rendered with.
    io.stdout(`${lines.join('\n')}\n`);
  }
  // exit: plan.shown
  return 0;
}

function file(io: Io, message: string, json: boolean): number {
  if (json) writeJsonError(io, 'plan.file', message, null);
  else io.stderr(`team plan: ${message}\n`);
  // exit: plan.file
  return 1;
}

function missing(io: Io, json: boolean): number {
  if (json) writeJsonError(io, 'plan.missing', 'the task file is not there', null);
  else io.stderr('team plan: the task file is not there\n');
  // exit: plan.missing
  return 1;
}

function shape(): number {
  // exit: plan.shape
  return 1;
}

function callerRefuse(io: Io, message: string, json: boolean): number {
  if (json) writeJsonError(io, 'plan.caller', message, 'the owner records this seat\'s pane and runs `team up`');
  else io.stderr(`team plan: ${message}\n`);
  // exit: plan.caller
  return 1;
}

function broker(io: Io, message: string, json: boolean): number {
  if (json) writeJsonError(io, 'plan.broker', message, 'the owner starts the broker with `team broker`');
  else io.stderr(`team plan: ${message}\n`);
  // exit: plan.broker
  return 1;
}

function readFail(io: Io, message: string, json: boolean): number {
  if (json) writeJsonError(io, 'plan.read', message, null);
  else io.stderr(`team plan: ${message}\n`);
  // exit: plan.read
  return 1;
}
