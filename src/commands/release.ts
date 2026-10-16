import { readArgs } from '../args.ts';
import { loadTeamFile } from '../file/load.ts';
import { SEMVER_PATTERN, packageProblem } from '../release/grammar.ts';
import { runChecks, type Outcome, type ReleaseResult } from '../release/checks.ts';
import { realFetch, type Fetch } from '../release/http.ts';
import { keychainReader, realSecurityRun, type KeyReader } from '../release/keychain.ts';
import type { Command, Io } from '../io.ts';

export const USAGE = `Usage: team release check <package@version> [--json] [--file <path>]

  <package@version>   a package of the file's releases, and its SemVer version
  --json              print the result as one JSON object
  --file <path>       the team file, instead of the main checkout's .agents/team.yaml

Checks the public npm and GitHub records of one release: the exact version and
its checksums (with provenance when the file declares trusted publishing), the
tag, the release, and the changelog entry. Warns when npm's next dist-tag points
at a version older than latest, naming the npm command that catches it up and
running nothing itself. With the file's linear pair, the
Linear milestone and a qualifying status update (one read-only request, its key
read from the Keychain and sent in one header, nowhere else); with the activity
pair, the release marker in the public activity file.

Exits 0 when every check passes, 1 when one is missing, 2 when one is unknown,
64 on a bad invocation or an invalid team file.
`;

// The rows, in the output's fixed order; a check is present exactly when the file configures it.
const ORDER = ['npm', 'tag', 'github', 'changelog', 'linear', 'activity'] as const;

const release: Command = (argv, io) => runRelease(argv, io, realFetch);
export default release;

/** Whether `--json` appears among the arguments somewhere other than as the value of `--file`.
 *  An option's value is taken as given, whatever it looks like — the one reading under which
 *  `--file --json` names a file and never switches the output shape. */
function jsonRequested(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === '--file') index += 1;
    else if (argument === '--json') return true;
  }
  return false;
}

export async function runRelease(argv: string[], io: Io, fetcher: Fetch, keyReader?: KeyReader): Promise<number> {
  // All arguments are read before deciding how to report: `--json` decides the shape of even an
  // argument error, wherever it appears — including after an unknown option, which readArgs
  // reports before ever reaching the flag. `--json` as the value of `--file` is a path, not the
  // flag, so it does not select the JSON output.
  const json = jsonRequested(argv);
  const args = readArgs(argv, ['file'], ['json']);
  const sub = args.rest[0];
  const fail = (code: 'usage' | 'configuration', message: string): number => {
    if (json) io.stdout(`${JSON.stringify({ error: { code, message } })}\n`);
    else io.stderr(`team release: ${message}\n`);
    // exit: release.configuration
    // exit: release.usage
    return 64;
  };

  // The arguments are validated first, without reading the team file: an invalid argument is a
  // usage error even when the file is invalid.
  if (args.error) return fail('usage', args.error);
  if (sub !== 'check') return fail('usage', sub === undefined ? 'a subcommand is required: check' : `unknown subcommand ${JSON.stringify(sub)}`);
  const target = args.rest[1];
  if (target === undefined) return fail('usage', 'a <package@version> is required');
  if (args.rest.length > 2) return fail('usage', `unexpected ${JSON.stringify(args.rest[2])}`);
  const at = target.lastIndexOf('@');
  const name = at > 0 ? target.slice(0, at) : '';
  const version = at > 0 ? target.slice(at + 1) : '';
  if (name === '' || version === '') return fail('usage', `${JSON.stringify(target)} is not <package>@<version>`);
  const named = packageProblem(name);
  if (named !== null) return fail('usage', `the package ${JSON.stringify(name)} ${named}`);
  if (!SEMVER_PATTERN.test(version)) return fail('usage', `the version ${JSON.stringify(version)} is not a Semantic Versioning 2.0.0 version`);

  // Only with valid arguments is the file read; an invalid file is the configuration error. The
  // load and the path resolution are shared with `team commits check --file` (loadTeamFile); the argument
  // parsers are separate, and a table test holds the two to the same classification. Nothing else
  // is read from the repository.
  const loaded = loadTeamFile(io.cwd, { file: args.values.file, checkOnly: true });
  if (!loaded.ok) {
    const first = loaded.errors[0] as { line: number; message: string };
    const where = [loaded.path, first.line > 0 ? `line ${first.line}` : ''].filter(Boolean).join(', ');
    return fail('configuration', `${where === '' ? '' : `${where}: `}${first.message}`);
  }
  // And only with a valid file is the package looked up: undeclared is the configuration-dependent
  // usage error.
  const decl = loaded.team.releases.find((entry) => entry.package === name);
  if (!decl) return fail('usage', `${name} is not declared in the team file's releases`);

  // The Keychain reader is wired here but invoked only by the Linear check, only after every
  // non-secret prerequisite is known, at most once.
  const result = await runChecks(decl, version, fetcher, {
    keyReader: keyReader ?? keychainReader(process.platform, io.stdinIsTTY, realSecurityRun),
  });
  if (json) {
    io.stdout(jsonResult(name, version, result));
  } else {
    io.stdout(table(result));
  }
  const statuses = present(result).map((check) => (result[check] as Outcome).status);
  // exit: release.passed
  if (statuses.every((status) => status === 'pass')) return 0;
  // exit: release.missing
  // exit: release.unknown
  return statuses.includes('unknown') ? 2 : 1;
}

/** The checks the run reports, in the fixed order: the four, plus the configured optional rows. */
function present(result: ReleaseResult): (keyof ReleaseResult)[] {
  return ORDER.filter((check) => result[check] !== undefined);
}

// One JSON object and nothing else: the three keys in order, each check on one line, and the
// one warning as a fourth key when the run has one.
function jsonResult(name: string, version: string, result: ReleaseResult): string {
  const lines = present(result).map((check) => {
    const { status, detail } = result[check] as Outcome;
    return `    ${JSON.stringify(check)}: { "status": ${JSON.stringify(status)}, "detail": ${JSON.stringify(detail)} }`;
  });
  const warning = result.warning === undefined ? '' : `,\n  "warning": ${JSON.stringify(result.warning)}`;
  return `{\n  "package": ${JSON.stringify(name)},\n  "version": ${JSON.stringify(version)},\n  "checks": {\n${lines.join(',\n')}\n  }${warning}\n}\n`;
}

function table(result: ReleaseResult): string {
  const rows: string[][] = [
    ['check', 'status', 'detail'],
    ...present(result).map((check) => {
      const outcome = result[check] as Outcome;
      return [check, outcome.status, outcome.detail];
    }),
  ];
  const first = Math.max(...rows.map((row) => (row[0] as string).length));
  const second = Math.max(...rows.map((row) => (row[1] as string).length));
  const warning = result.warning === undefined ? '' : `warn  ${result.warning}\n`;
  return `${rows.map((row) => `${(row[0] as string).padEnd(first)}  ${(row[1] as string).padEnd(second)}  ${row[2]}`).join('\n')}\n${warning}`;
}
