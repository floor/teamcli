// `team pr check <file>`: the body half of today's `team check --pr`, under its own name — the
// file's forbidden patterns and the signature its `pullRequests` rule writes, and nothing else.
// It needs no repository: the body and the team file are the only things read, so a project
// without git can check a request to merge. The `team check` alias reaches this file's `bodyText`
// and `bodyRefused` for its own `--pr` half, so both spellings read a body one way and refuse one
// way (`pr.body`). Read only: nothing here writes, and no git call is made.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { loadConfig, place, type LoadConfig } from '../check/load.ts';
import { bodyDifferences, checkBody, formatBodyReport } from '../check/run.ts';
import { LINK_NOT_FOLLOWED, NOT_A_REPO } from '../file/load.ts';
import type { Problem } from '../file/types.ts';
import type { Command, Io } from '../io.ts';
import { hasJsonFlag, refuse, whoOfDifference, writeJson } from '../output/index.ts';

export const USAGE = `Usage: team pr check <file> [--file <path>] [--json]

  <file>           the pull request's body ("-" reads standard input)
  --file <path>    a team file, instead of the registry record (team config)
  --json           the report as a document, and a refusal as the error document

Checks one pull request body and nothing else. Needs no repository.

Exits 0 when the body passes, 1 when it is refused, 2 when the check
can't run.
`;

/** The body's text: the file as given, relative to the caller's folder, or standard input for
 *  "-". Throws what `readFileSync` throws; `bodyRefused` is what turns that into an exit. */
export function bodyText(file: string, cwd: string): string {
  return readFileSync(file === '-' ? 0 : resolve(cwd, file), 'utf8');
}

/** The one refusal for a body that cannot be read, shared by `team pr check` and the `team check`
 *  alias's `--pr` half: one site, one id (`pr.body`). */
export function bodyRefused(io: Io, error: unknown, json = false): number {
  const message = `can't read the pull request body: ${(error as Error).message}`;
  if (json) {
    refuse(io, true, 'pr check', { id: 'pr.body', message, repair: null });
  } else {
    io.stderr(`team pr check: ${message}\n`);
  }
  // exit: pr.body
  return 2;
}

/** The row of a load failure `loadConfig` reports. The four the command documents, told apart
 *  by the message the loader and the store write. */
function loadProblemId(errors: Problem[]): 'pr.not-a-repo' | 'pr.file' | 'pr.file-invalid' | 'pr.ledger' {
  const first = errors[0]?.message ?? '';
  if (first === NOT_A_REPO || first === LINK_NOT_FOLLOWED) return 'pr.not-a-repo';
  if (first.startsWith('no team file')) return 'pr.file';
  if (/^can't read .*ledger\.json: /.test(first)) return 'pr.ledger';
  return 'pr.file-invalid';
}

export async function pr(argv: string[], io: Io, load: LoadConfig = loadConfig): Promise<number> {
  const args = readArgs(argv, ['file'], ['json']);
  // Read from the raw argv before the parser runs: a bad option before `--json`, or a
  // malformed `--json=<value>`, still asks for the structured refusal. A `--json` that is the
  // value of `--file` is that option's value — a path, not the flag.
  const json = hasJsonFlag(argv, ['file']);
  const sub = args.rest[0];
  const fail = (message: string): number => {
    refuse(io, json, 'pr check', { id: 'pr.invocation', message, repair: null, usage: USAGE });
    // exit: pr.invocation
    return 2;
  };
  if (args.error) return fail(args.error);
  if (sub !== 'check') return fail(sub === undefined ? 'a subcommand is required: check' : `unknown subcommand ${JSON.stringify(sub)}`);
  const file = args.rest[1];
  if (file === undefined) return fail('a <file> is required');
  if (args.rest.length > 2) return fail('one <file> at most');

  const loaded = load(io.cwd, args.values.file);
  if (!loaded.ok) {
    if (json) {
      refuse(io, true, 'pr check', {
        id: loadProblemId(loaded.errors),
        message: loaded.errors.map((problem) => place(problem, loaded.path)).join('; '),
        repair: null,
      });
    } else {
      for (const problem of loaded.errors) io.stderr(`team pr check: ${place(problem, loaded.path)}\n`);
    }
    // exit: pr.not-a-repo
    // exit: pr.file
    // exit: pr.file-invalid
    // exit: pr.ledger
    return 2;
  }

  let body: string;
  try {
    body = bodyText(file, io.cwd);
  } catch (error) {
    return bodyRefused(io, error, json);
  }

  const findings = checkBody(loaded.config, body);
  if (json) {
    const differences = bodyDifferences(findings);
    writeJson(io, 'team.pr', {
      format: 1 as const,
      differences: differences.map((difference) => ({
        what: difference.what,
        repair: difference.repair,
        who: whoOfDifference(difference),
      })),
      notes: loaded.warnings.map((warning) => place(warning)),
      summary: {
        differences: differences.length,
        owner_differences: differences.filter((difference) => whoOfDifference(difference) === 'the owner').length,
      },
      notice: null,
    });
  } else {
    io.stdout(formatBodyReport(findings));
  }
  // exit: pr.passed
  // exit: pr.refused
  return findings.length === 0 ? 0 : 1;
}

const command: Command = (argv, io) => pr(argv, io);
export default command;
