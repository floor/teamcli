// Two commands share this name through 0.3.3 (design note §2.3, §3). An invocation made only of
// the team check's own options (`--session`, `--file`, `--repair`) — or of nothing at all — is the team check
// (`runTeamCheck`): is anything wrong with this team that someone should act on. Anything else —
// a `<ref>`, `--pr`, `--since`, any other word or option — is the old spelling of `team commits
// check` and `team pr check`: one notice line per half on stderr, then the shared run
// (`runCommits`), so the old name and the new ones run one code path and print one report.
// A refused invocation keeps the bytes it always had — its own message over the old usage — and
// takes no notice: an error already says what to fix.
import { homedir } from 'node:os';
import { loadConfig, type LoadConfig } from '../check/load.ts';
import { realCheckSources, runTeamCheck, type CheckSources } from '../check/team.ts';
import type { Io } from '../io.ts';
import { hasJsonFlag, writeJsonError } from '../output/index.ts';
import { runCommits, type CommitsRun } from './commits.ts';

export { loadConfig };
export type { LoadConfig };

export const USAGE = `Usage: team check [--session <name>] [--file <path>] [--repair] [--json]

  --session <name>  the session to read; the file's own when absent
  --file <path>     a team file, instead of the registry record (team config)
  --repair          the owner's repair, one write: drop the state's leftovers (a
                    record for a seat the file no longer declares, a session with
                    no seat of the team in it), re-record a seat an agent
                    registered under dev mode, and set herdr's drifted sidebar
                    lines back from the file
  --json            the report as one JSON document on stdout

Exits 0 when nothing needs acting on, 1 when something does, 2 when the check
can't run.

The old spelling, still read through 0.3.3 — a <ref>, --pr or --since
anywhere in the line makes the call this one:

Usage: team check <ref> [--pr <file>] [--since <ref>] [--file <path>]

  <ref>            a range when it holds "..", passed to git as given
                   (origin/main..HEAD); otherwise that one commit
  --pr <file>      also check a pull request's body ("-" reads standard input)
  --since <ref>    skip this commit and everything reachable from it, for this
                   run; overrides identity.since
  --file <path>    a team file, instead of the registry record (team config)

Exits 0 when every commit passes, 1 when one is refused, 2 when the check
can't run.
`;

// The block an old spelling's refused invocation prints: the usage it has always printed, byte for
// byte, so a script that read the old refusal reads the same bytes.
const OLD_USAGE = `Usage: team check <ref> [--pr <file>] [--since <ref>] [--file <path>]

  <ref>            a range when it holds "..", passed to git as given
                   (origin/main..HEAD); otherwise that one commit
  --pr <file>      also check a pull request's body ("-" reads standard input)
  --since <ref>    skip this commit and everything reachable from it, for this
                   run; overrides identity.since
  --file <path>    a team file, instead of the registry record (team config)

Exits 0 when every commit passes, 1 when one is refused, 2 when the check
can't run.
`;

// Every option either spelling names: the contract reads this list, and FLAG_OPTIONS beside it
// for the switch that takes no value. Each spelling's parse reads its own subset, hand-written
// here because the old spelling's refusals keep their exact bytes.
const VALUE_OPTIONS = ['pr', 'since', 'session', 'file'] as const;
// The team check's own switches: taken with no value, and only by the team check — the old
// spelling meets `--repair` with its unknown-option refusal.
const FLAG_OPTIONS = ['repair', 'json'] as const;
type Option = (typeof VALUE_OPTIONS)[number];
type FlagOption = (typeof FLAG_OPTIONS)[number];
const OLD_OPTIONS: readonly Option[] = ['pr', 'since', 'file'];
const NEW_OPTIONS: readonly Option[] = ['session', 'file'];

interface Parsed {
  values: Partial<Record<Option, string>>;
  flags: Set<FlagOption>;
  positional: string[];
}

function parse(argv: string[], options: readonly Option[], flags: readonly FlagOption[]): Parsed | string {
  const values: Partial<Record<Option, string>> = {};
  const taken = new Set<FlagOption>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const [name, inline] = argument.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const flag = flags.find((known) => known === name);
    if (flag) {
      if (inline !== undefined) return `--${flag} takes no value`;
      taken.add(flag);
      continue;
    }
    const option = options.find((known) => known === name);
    if (!option) return `unknown option ${argument}`;
    const value = inline ?? argv[++index];
    if (value === undefined || value === '') return `--${option} needs a value`;
    values[option] = value;
  }
  return { values, flags: taken, positional };
}

// Which spelling the typed line is: the team check's when every argument is one of its own
// options or its switch, and the old spelling's for every other word or option.
function spelledForTheTeam(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (!argument.startsWith('--')) return false;
    const name = argument.slice(2).split('=', 1)[0] as string;
    const valued = name === 'session' || name === 'file';
    if (!valued && name !== 'repair' && name !== 'json') return false;
    // Only a valued option takes the next word; `--repair` and `--json` stand alone.
    if (valued && !argument.includes('=')) index += 1;
  }
  return true;
}

type Dispatched =
  | { kind: 'team'; args: { session?: string; file?: string; repair?: boolean; json?: boolean } }
  | { kind: 'commits'; args: CommitsRun }
  | { kind: 'refused'; text: string; usage: string };

function dispatch(argv: string[]): Dispatched {
  const forTheTeam = hasJsonFlag(argv) || spelledForTheTeam(argv);
  const parsed = parse(argv, forTheTeam ? NEW_OPTIONS : OLD_OPTIONS, forTheTeam ? FLAG_OPTIONS : []);
  if (typeof parsed === 'string') return { kind: 'refused', text: parsed, usage: forTheTeam ? USAGE : OLD_USAGE };
  if (forTheTeam) {
    if (parsed.positional.length > 0) {
      return { kind: 'refused', text: `unexpected "${parsed.positional[0]}"`, usage: USAGE };
    }
    return {
      kind: 'team',
      args: {
        ...(parsed.values.session !== undefined ? { session: parsed.values.session } : {}),
        ...(parsed.values.file !== undefined ? { file: parsed.values.file } : {}),
        ...(parsed.flags.has('repair') ? { repair: true } : {}),
        ...(parsed.flags.has('json') ? { json: true } : {}),
      },
    };
  }
  const [ref, ...rest] = parsed.positional;
  if (ref === undefined) return { kind: 'refused', text: 'a <ref> is required', usage: OLD_USAGE };
  if (rest.length > 0) return { kind: 'refused', text: 'one <ref> at most', usage: OLD_USAGE };
  return {
    kind: 'commits',
    args: {
      ref,
      ...(parsed.values.since !== undefined ? { since: parsed.values.since } : {}),
      ...(parsed.values.file !== undefined ? { file: parsed.values.file } : {}),
      ...(parsed.values.pr !== undefined ? { pr: parsed.values.pr } : {}),
    },
  };
}

export async function check(argv: string[], io: Io, load: LoadConfig = loadConfig, sources: CheckSources = realCheckSources): Promise<number> {
  const parsed = dispatch(argv);
  if (parsed.kind === 'refused') {
    if (hasJsonFlag(argv)) {
      writeJsonError(io, 'check.invocation', parsed.text, null);
    } else {
      // The bytes an old spelling's refusal always had; a team check refusal names its own usage.
      io.stderr(`team check: ${parsed.text}\n\n${parsed.usage}`);
    }
    // exit: check.invocation
    return 2;
  }
  if (parsed.kind === 'team') {
    // The declared limitation is printed by the report itself, after the context line, so the
    // text and JSON forms cannot drift apart; JSON carries it as `key_isolation`.
    // One daemon probe at this boundary: the report below is synchronous, so it takes the
    // snapshot. A scene that hands its own snapshot is not probed again, and a run with no
    // daemon source reads no socket and starts no server.
    if (sources.daemon === undefined && sources.daemonHealth !== undefined) {
      const daemon = await sources.daemonHealth(sources.home ?? homedir());
      return runTeamCheck(parsed.args, io, { ...sources, daemon });
    }
    return runTeamCheck(parsed.args, io, sources);
  }
  io.stderr('team check: `team check` is now `team commits check`, and is still read through 0.3.3\n');
  if (parsed.args.pr !== undefined) {
    io.stderr('team check: `team check --pr` is now `team pr check`, and is still read through 0.3.3\n');
  }
  return runCommits(io, load, parsed.args);
}

export default check;
