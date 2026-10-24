// `team issues`: list the typed records of the one task source the team file names.
// The source is a file the owner committed. A broker source is read by `team next`, never from
// here: this command connects to no broker, holds no tracker credential, and has no seat gate —
// and it keeps holding none of those. A listing is not a claim and not the intake rule.
import { readArgs } from '../args.ts';
import { isNoRepository, withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
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
import type { TaskAdapter, TaskRecord } from '../tasks/adapter.ts';
import { fileRegistry } from '../tasks/file.ts';
import { fileSourceOf, LOCAL_TASKS, readFileSource } from '../tasks/queue.ts';

export const USAGE = `Usage: team issues [--json]

Lists the typed records in the one file the team file names, in file order. Reads the checkout,
the team file and the task file; writes nothing and creates no key. A listing is not a claim:
\`team plan\` prints the takeable queue and claims nothing, and a broker source is read by
\`team next\`, never from here.

Exits 0 when the issues are listed, 1 when the team file or issues file can't be read, 2 when the invocation can't be read or this folder is neither a checkout nor a team root.
`;

export type IssuesSources = {
  home?: string;
  /** Injected the way a watch's sources are. The shipped registry is the file adapter alone. */
  registry?: Record<string, TaskAdapter>;
};

/** The issue's state in the listing: `blocked` names a record a claim would not take — it has
 *  `blocked-by`, `repos` or `needs` — and `open` one `team plan` would show. */
export type IssueState = 'open' | 'blocked';

export interface IssueJson {
  id: string;
  title: string;
  state: IssueState;
  assignee: string | null;
  priority?: string | number;
  milestone?: string;
  deadline?: string;
  blocked_by?: string[];
  repos?: string[];
  needs?: string[];
  description?: string;
}

export interface IssuesJson {
  schema: OutputSchemaTag;
  format: 1;
  project: string;
  session: string;
  issues: IssueJson[];
}

export const issues: Command = (argv, io) => runIssues(argv, io);
export default issues;

export function issueState(record: TaskRecord): IssueState {
  if (record.blockedBy?.length) return 'blocked';
  if (record.repos?.length) return 'blocked';
  if (record.needs?.length) return 'blocked';
  return 'open';
}

function issueJson(record: TaskRecord): IssueJson {
  return {
    id: record.id,
    title: record.title,
    state: issueState(record),
    assignee: record.assignee ?? null,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    ...(record.milestone !== undefined ? { milestone: record.milestone } : {}),
    ...(record.deadline !== undefined ? { deadline: record.deadline } : {}),
    ...(record.blockedBy?.length ? { blocked_by: [...record.blockedBy] } : {}),
    ...(record.repos?.length ? { repos: [...record.repos] } : {}),
    ...(record.needs?.length ? { needs: [...record.needs] } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
  };
}

export async function runIssues(argv: string[], io: Io, sources: IssuesSources = {}): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, [], ['json']);
  // The raw argv, not the parser's flags: an unknown option before `--json`, or `--json=<value>`,
  // must still route the refusal through the `team.issues` error document on stdout.
  const json = hasJsonFlag(argv);
  if (args.error || args.rest.length) {
    const why = plainText(args.error ?? `unexpected "${args.rest[0]}"`);
    if (json) writeJsonError(io, 'issues.invocation', why, null);
    else out.stderr(`team issues: ${why}\n${USAGE}`);
    // exit: issues.invocation
    return 2;
  }
  // The folder is resolved the way every command resolves it: the checkout git names, or, in a
  // folder that is not a repository, the plain team root this folder holds (`.agents/team.yaml`
  // beside it). A folder that is neither is the no-repository refusal — `team issues` takes no
  // `--file`, so the shared sentence must not offer one — and any other unreadable file keeps its
  // own exit.
  const loaded = readTeamConfig(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const problem = loaded.errors[0];
    const message = problem?.message ?? 'the team file can\'t be read';
    if (problem !== undefined && isNoRepository(problem)) {
      const shown = withoutFileOffer(message);
      if (json) writeJsonError(io, 'issues.not-a-repo', shown, 'run team issues from inside a checkout, or from the folder that holds .agents/team.yaml');
      else out.stderr(`team issues: ${shown}\n`);
      // exit: issues.not-a-repo
      return 2;
    }
    return refuse(io, 'file', message, json);
  }
  // A team that declares no source reads its own local queue; a missing one is an empty queue,
  // not a refusal. The declared sources keep their own reads and refusals unchanged.
  const tasks = loaded.team.tasks ?? LOCAL_TASKS;
  if (tasks.source === 'linear') {
    // A broker source is not listed here: the read lives behind the socket, the seat gate and
    // the policy, which this command has none of. No socket connection is attempted.
    return refuse(
      io,
      'file',
      'team issues lists the file the owner committed; a broker source is read by team next',
      json,
      'run `team next` to read a broker source',
    );
  }
  const registry = sources.registry ?? fileRegistry;
  const adapter = registry[tasks.source];
  if (!adapter) return refuse(io, 'file', 'tasks.source must be file', json);
  const source = fileSourceOf(loaded.team);
  const read = source !== null && source.local
    ? readFileSource(loaded.root, source)
    : adapter.read({ root: loaded.root, path: tasks.path });
  if (read.kind === 'missing') {
    return refuse(io, 'missing', 'the task file is not there', json);
  }
  if (read.kind === 'outside') {
    return refuse(io, 'file', 'tasks.path must stay inside the checkout', json);
  }
  if (read.kind === 'not-a-list') {
    if (json) writeJsonError(io, 'issues.shape', 'the task file is not a list', 'make the task file a YAML list');
    else out.stderr('team issues: the task file is not a list\n');
    return shape();
  }
  const context = contextLine(loaded.team.project, loaded.team.session);
  const empty = read.records.length === 0 && read.refusals.length === 0;
  if (!json) {
    if (read.records.length > 0) {
      const style = ttyStyle(io, { json: false });
      const lines = [
        context,
        ...renderTable({
          headers: ['ID', 'STATE', 'ASSIGNEE', 'TITLE'],
          rows: read.records.map((record) => [record.id, issueState(record), record.assignee ?? '-', record.title]),
          style,
        }),
        pluralCount(read.records.length, 'issue'),
      ];
      // Through `io`, not the cleaned view: the style above is this io's TTY style, and the
      // cleaned view would strip the very bold the table was rendered with.
      io.stdout(`${lines.join('\n')}\n`);
    } else if (empty) {
      io.stdout(`${context}\n${pluralCount(0, 'issue')}\n`);
    }
  }
  if (read.refusals.length) {
    if (json) {
      const named = read.refusals.map((refusal) => `${refusal.id ?? `record ${refusal.index}`} is not a task: ${refusal.reason}`);
      writeJsonError(io, 'issues.shape', named.join('; '), 'fix the named record or remove it from the task file');
    } else {
      for (const refusal of read.refusals) {
        const who = refusal.id ?? `record ${refusal.index}`;
        out.stderr(`team issues: ${who} is not a task: ${refusal.reason}\n`);
      }
    }
    return shape();
  }
  if (json) {
    writeJson(io, 'team.issues', {
      format: 1 as const,
      project: loaded.team.project,
      session: loaded.team.session,
      issues: read.records.map(issueJson),
    });
  }
  if (empty) {
    // exit: issues.none
    return 0;
  }
  // exit: issues.shown
  return 0;
}

function shape(): number {
  // exit: issues.shape
  return 1;
}

function refuse(io: Io, kind: 'file' | 'missing', message: string, json: boolean, repair: string | null = null): number {
  if (json) {
    writeJsonError(io, kind === 'missing' ? 'issues.missing' : 'issues.file', message, repair);
  } else {
    io.stderr(`team issues: ${message}\n`);
  }
  if (kind === 'missing') {
    // exit: issues.missing
    return 1;
  }
  // exit: issues.file
  return 1;
}
