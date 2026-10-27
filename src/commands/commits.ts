// `team commits check <ref>`: today's commit half of `team check`, under its own name. The body
// half lives in `commands/pr.ts`, and the old spelling lives on as the `team check` alias
// (`commands/check.ts`), which reaches this file's `runCommits` so both spellings run one code
// path. Read only: it reads a repository, a file and a body, and writes nothing.
import { GitError } from '../check/git.ts';
import { loadConfig, place, type LoadConfig } from '../check/load.ts';
import {
  commitStatus,
  formatReport,
  reportDifferences,
  runCheck,
} from '../check/run.ts';
import { LINK_NOT_FOLLOWED, NOT_A_REPO } from '../file/load.ts';
import type { Problem } from '../file/types.ts';
import type { Command, Io } from '../io.ts';
import { hasJsonFlag, refuse, whoOfDifference, writeJson } from '../output/index.ts';
import { bodyRefused, bodyText } from './pr.ts';

export const USAGE = `Usage: team commits check <ref> [--since <ref>] [--file <path>] [--json]

  <ref>            a range when it holds "..", passed to git as given
                   (origin/main..HEAD); otherwise that one commit
  --since <ref>    skip this commit and everything reachable from it, for this
                   run; overrides identity.since
  --file <path>    a team file, instead of the registry record (team config)
  --json           the report as a document, and a refusal as the error document

Exits 0 when every commit passes, 1 when one is refused, 2 when the check
can't run.
`;

interface Arguments {
  ref: string;
  since?: string;
  file?: string;
}

const VALUE_OPTIONS = ['since', 'file'] as const;
const FLAG_OPTIONS = ['json'] as const;

function parse(argv: string[]): Arguments | string {
  const values: Partial<Record<(typeof VALUE_OPTIONS)[number], string>> = {};
  const flags = new Set<(typeof FLAG_OPTIONS)[number]>();
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (!argument.startsWith('--')) {
      rest.push(argument);
      continue;
    }
    const [name, inline] = argument.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const flag = FLAG_OPTIONS.find((known) => known === name);
    if (flag) {
      if (inline !== undefined) return `unknown option ${argument}`;
      flags.add(flag);
      continue;
    }
    const option = VALUE_OPTIONS.find((known) => known === name);
    if (!option) return `unknown option ${argument}`;
    const value = inline ?? argv[++index];
    if (value === undefined || value === '') return `--${option} needs a value`;
    values[option] = value;
  }
  const args = { values, rest };
  const sub = args.rest[0];
  if (sub !== 'check') return sub === undefined ? 'a subcommand is required: check' : `unknown subcommand ${JSON.stringify(sub)}`;
  const ref = args.rest[1];
  if (ref === undefined) return 'a <ref> is required';
  if (args.rest.length > 2) return 'one <ref> at most';
  return { ref, ...args.values };
}

/** What a run needs after the arguments are read. `pr` is the path as typed, not its text: the
 *  read happens inside `runCommits`, after the file is loaded, so the old spelling of
 *  `team check --pr` refuses in the order it always has, and its one refusal site lives in
 *  `commands/pr.ts` (`pr.body`). */
export type CommitsRun = {
  ref: string;
  since?: string;
  file?: string;
  pr?: string;
  json?: boolean;
};

/** The row of a load failure `loadConfig` reports. The four the command documents, told apart
 *  by the message the loader and the store write. */
function loadProblemId(errors: Problem[]): 'commits.not-a-repo' | 'commits.file' | 'commits.file-invalid' | 'commits.ledger' {
  const first = errors[0]?.message ?? '';
  if (first === NOT_A_REPO || first === LINK_NOT_FOLLOWED) return 'commits.not-a-repo';
  if (first.startsWith('no team file')) return 'commits.file';
  if (/^can't read .*ledger\.json: /.test(first)) return 'commits.ledger';
  return 'commits.file-invalid';
}

/** The row of a `GitError`: git's own wording, written in `check/git.ts`. */
function gitProblemId(message: string): string {
  if (message === 'not in a git repository') return 'commits.outside';
  if (message.startsWith('since ') && message.includes('is not reachable')) return 'commits.since-unreachable';
  if (message.startsWith('since ') && message.includes("doesn't name a commit")) return 'commits.since-missing';
  if (message.endsWith('is not a ref')) return 'commits.not-a-ref';
  if (message.includes('holds no commit')) return 'commits.empty-range';
  if (message.includes("can't be resolved")) return 'commits.range';
  if (message.includes("doesn't name a commit")) return 'commits.no-commit';
  return 'commits.outside';
}

function gitRepair(id: string): string | null {
  return id === 'commits.outside' ? 'run team commits check from inside the git checkout' : null;
}

/** The commit half's one run, shared by `team commits check` and the `team check` alias. */
export async function runCommits(io: Io, load: LoadConfig, options: CommitsRun): Promise<number> {
  const json = options.json === true;
  const loaded = load(io.cwd, options.file);
  if (!loaded.ok) {
    if (json) {
      const id = loadProblemId(loaded.errors);
      refuse(io, true, 'commits check', {
        id,
        message: loaded.errors.map((problem) => place(problem, loaded.path)).join('; '),
        repair: null,
      });
    } else {
      for (const problem of loaded.errors) io.stderr(`team commits check: ${place(problem, loaded.path)}\n`);
    }
    // exit: commits.not-a-repo
    // exit: commits.file
    // exit: commits.file-invalid
    // exit: commits.ledger
    return 2;
  }

  let pullRequestBody: string | undefined;
  if (options.pr !== undefined) {
    try {
      pullRequestBody = bodyText(options.pr, io.cwd);
    } catch (error) {
      return bodyRefused(io, error);
    }
  }

  try {
    const report = runCheck(loaded.config, { cwd: io.cwd, ref: options.ref, since: options.since, pullRequestBody });
    if (json) {
      const refused = report.commits.filter((commit) => commit.findings.length > 0).length;
      const exempt = report.commits.filter((commit) => commit.exempt !== undefined).length;
      writeJson(io, 'team.commits', {
        format: 1 as const,
        ref: options.ref,
        since: report.since ?? null,
        commits: report.commits.map((commit) => ({
          hash: commit.hash,
          subject: commit.subject,
          status: commitStatus(commit),
          exempt: commit.exempt ?? null,
          findings: commit.findings.map((finding) => ({
            kind: finding.kind,
            message: finding.message,
            ...(finding.line !== undefined ? { line: finding.line } : {}),
            ...(finding.text !== undefined ? { text: finding.text } : {}),
          })),
        })),
        skipped: report.skipped,
        pull_request: report.pullRequest
          ? report.pullRequest.map((finding) => ({
              kind: finding.kind,
              message: finding.message,
              ...(finding.line !== undefined ? { line: finding.line } : {}),
              ...(finding.text !== undefined ? { text: finding.text } : {}),
            }))
          : null,
        differences: reportDifferences(report).map((diff) => ({
          what: diff.what,
          repair: diff.repair,
          who: whoOfDifference(diff),
        })),
        notes: loaded.warnings.map((warning) => place(warning)),
        summary: { commits: report.commits.length, refused, exempt, skipped: report.skipped, ok: report.ok },
        notice: null,
      });
    } else {
      io.stdout(formatReport(report));
    }
    // exit: commits.passed
    // exit: commits.refused
    return report.ok ? 0 : 1;
  } catch (error) {
    // exit: commits.threw
    if (!(error instanceof GitError)) throw error;
    if (json) {
      const id = gitProblemId(error.message);
      refuse(io, true, 'commits check', { id, message: error.message, repair: gitRepair(id) });
    } else {
      io.stderr(`team commits check: ${error.message}\n`);
    }
    // exit: commits.outside
    // exit: commits.no-commit
    // exit: commits.range
    // exit: commits.empty-range
    // exit: commits.since-missing
    // exit: commits.since-unreachable
    // exit: commits.not-a-ref
    return 2;
  }
}

export async function commits(argv: string[], io: Io, load: LoadConfig = loadConfig): Promise<number> {
  // Read from the raw argv before the parser runs: a bad option before `--json`, or a
  // malformed `--json=<value>`, still asks for the structured refusal. A `--json` that is the
  // value of `--file` or `--since` is that option's value — a path, not the flag.
  const json = hasJsonFlag(argv, VALUE_OPTIONS);
  const args = parse(argv);
  if (typeof args === 'string') {
    refuse(io, json, 'commits check', {
      id: 'commits.invocation',
      message: args,
      repair: null,
      usage: USAGE,
    });
    // exit: commits.invocation
    return 2;
  }
  return runCommits(io, load, { ...args, json });
}

const command: Command = (argv, io) => commits(argv, io);
export default command;
