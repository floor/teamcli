import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { devModeCallerGate, devModeExpiryNote, logDevMode, logDevModeState, resolveDevMode } from '../dev_mode.ts';
import { TEAM_FILE, findRoot, loadTeamFile } from '../file/load.ts';
import { validateTeamFile } from '../file/validate.ts';
import { entityGrantAdmits, readEntityCreateGrants } from '../grant.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import { profileFor } from '../profiles/index.ts';
import { noteTeam } from '../registry/teams.ts';
import { LOCK_FILE, LOG_FILE, STATE_FILE, writeAtomic } from '../state.ts';
import { approvalStanding, LEGACY_LINE, type Standing } from '../store/store.ts';
import { version } from '../version.ts';
import { realSources as doctorSources, type DoctorSources } from './doctor.ts';

// What git must never pick up: the file and the runtime files beside it — the broker's start
// files included: the lock, its takeover claim (a killed claim-holder can leave it), and the
// private temp an atomic create keeps only while it runs.
export const EXCLUDED = [TEAM_FILE, `.agents/${STATE_FILE}`, `.agents/${LOG_FILE}*`, `.agents/${LOCK_FILE}`, '.agents/seat-locks', '.agents/messages/', '.agents/leases/', '.agents/hooks/', '.agents/seat-state/', '.agents/broker.sock', '.agents/broker.sock.lock', '.agents/broker.sock.lock.takeover', '.agents/broker.sock.lock.*.new'];

export const PRIVACY = `The team file is private to this clone: it is listed in .git/info/exclude, never in .gitignore,
so git doesn't see it and a fresh clone doesn't carry it. A collaborator writes their own, or
receives one and approves it themselves.`;

function git(root: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** The five shipped CLIs, in the order `init` tries them for the skeleton's seat (README's
 *  table of the CLIs with launch profiles). */
const PICKED_CLIS = ['claude-code', 'codex', 'cursor', 'antigravity', 'grok'] as const;

/** The vendor and model the skeleton names for each picked CLI: the vendor's own name, no lab
 *  assumed for the lead's role. */
const PICKED_SEATS: Record<(typeof PICKED_CLIS)[number], { vendor: string; model: string }> = {
  'claude-code': { vendor: 'anthropic', model: 'Claude Opus' },
  codex: { vendor: 'openai', model: 'GPT Sol' },
  cursor: { vendor: 'meridian', model: 'Meridian' },
  antigravity: { vendor: 'google', model: 'Gemini' },
  grok: { vendor: 'xai', model: 'Grok' },
};

/**
 * The first shipped CLI this machine is signed in to, in the fixed order above. A login check
 * that can't tell (`null`) is not a yes: it neither selects that CLI nor ends the walk, so a
 * later signed-in CLI is still reached. `claude-code` when every check is false or unknown.
 */
export function firstLoggedInCli(sources: Pick<DoctorSources, 'loggedIn'>): string {
  for (const cli of PICKED_CLIS) {
    const profile = profileFor(cli);
    if (profile && sources.loggedIn(profile) === true) return cli;
  }
  return 'claude-code';
}

/** One skeleton line: the value padded so its comment begins where the file's other comments do. */
function padded(text: string, comment: string): string {
  return `${text}${' '.repeat(Math.max(1, 30 - text.length))}${comment}`;
}

export function skeleton(project: string, head: string | null, teamVersion = version(), root?: string, cli = 'claude-code'): string {
  const rootPath = root ?? `/path/to/${project}`;
  const picked = PICKED_SEATS[cli as (typeof PICKED_CLIS)[number]] ?? PICKED_SEATS['claude-code'];
  const launch = profileFor(cli)?.binary ?? 'claude';
  return `# yaml-language-server: $schema=https://raw.githubusercontent.com/floor/teamcli/v${teamVersion}/schema/team.schema.json
# The team of ${project}. Private to this clone: see .git/info/exclude.
# The live file is what the commands read. Edit it, then run the seats.
format: 1
project: ${project}
# visibility: public          # public | private: whether forbidden_public applies
# session: ${project}          # the herdr session; never "default"
${padded('operator: orchestrator', '# the seat the watch reports to')}

# identity:
#   signature:
#     template: "Agent: {display} · {role}"
#     commits:
#       position: trailer     # last-line | trailer | anywhere
#       exempt: [merge]
#     pull_requests:
#       position: last-line
#       template: "**Agent:** {display} · {role}"
#   humans: []                # commit authors who don't sign
${head ? `#   since: ${head}   # check reads no commit reachable from this one\n` : ''}#   forbidden: []            # added to the defaults
#   forbidden_public: []

# rules:                      # added to every seat's rules at launch
#   - Run the tests your change touches.

trust:
  - ~/.config/team/lobby
  - ${rootPath}
workspace:
  mode: shared                # worktree | shared
  # path: ../worktrees/{repo}/{task}
  # base: main

seats:
  - role: orchestrator
    name: orchestrator
${padded(`    cli: ${cli}`, '# the first shipped CLI this machine is signed in to: claude-code | codex | cursor | antigravity | grok; any CLI in any role')}
    vendor: ${picked.vendor}
${padded(`    model: ${picked.model}`, "# the model's name without its version")}
${padded('    version: "0"', '# the release number alone, quoted')}
${padded(`    launch: ${launch}`, '# the command and its model options; no approval flags')}
${padded('    leads: true', '# the seat that leads: dispatches work')}
`;
}

// Adds the lines git must exclude, once each, to the common directory's info/exclude.
export function exclude(root: string): string[] {
  const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  // exit: init.git-silent
  if (!common) throw new Error('git doesn\'t answer for this folder');
  const path = join(common, 'info', 'exclude');
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const present = new Set(current.split('\n').map((line) => line.trim()));
  const missing = EXCLUDED.filter((line) => !present.has(line));
  if (missing.length) {
    writeAtomic(path, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  }
  return missing;
}

export const init: Command = (argv, io) => runInit(argv, io, undefined, undefined, { ...doctorSources, registryHome: homedir() });
export default init;

export const USAGE = 'Usage: team init [--restore]\n';

// `home` is where the user-level store is looked for; tests hand in a temporary one.
// `readStanding` stands in for the store's one read, so a test can count it or swap the
// record after the gate. `sources` is the one machine read the skeleton needs: which CLI the
// owner is signed in to — tests and the docs runner hand in a stub, so no real login is probed.
export async function runInit(
  argv: string[],
  io: Io,
  home?: string,
  readStanding?: (root: string) => Standing,
  sources: Pick<DoctorSources, 'loggedIn'> & { now?: () => Date; registryHome?: string } = doctorSources,
): Promise<number> {
  const args = readArgs(argv, [], ['restore']);
  if (args.error || args.rest.length) {
    io.stderr(`team init: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: init.invocation
    return 2;
  }
  const caller = callerOf(io);
  let foundRoot: string | null | undefined;
  const rootOf = () => (foundRoot === undefined ? (foundRoot = findRoot(io.cwd)) : foundRoot);
  const createGranted =
    !isOwner(caller) &&
    !args.flags.has('restore') &&
    readEntityCreateGrants(home).length > 0 &&
    (() => {
      const candidateRoot = rootOf();
      return candidateRoot !== null && entityGrantAdmits(candidateRoot, io, { home, now: sources.now?.(), cwd: io.cwd });
    })();
  // A detached run is refused unless a create-grant admits it: the grant holder's own runner
  // outside herdr is the one detached caller the grant may name.
  const detached = detachedRefusal(caller);
  if (detached !== undefined && !createGranted) {
    io.stderr(`team init: ${detached}\n`);
    // exit: init.detached
    return 1;
  }
  // Dev mode, from the caller's place: the entity's chain, read before the team file this run
  // writes exists. A `dev-mode` value anywhere in it governs, and `TEAMCLI_DEV_MODE` is then
  // ignored; before any such value, the variable set to exactly `1` keeps its behaviour.
  const dev = resolveDevMode('init', io, {
    ...(home !== undefined ? { home } : {}),
    now: sources.now?.() ?? new Date(),
  });
  // The who-may-run-it gate: dev mode says the owner line once, as a warning, and the run
  // continues — exactly as `up` does. Every other refusal stays a refusal. The warning is
  // logged where the run knows the folder it writes in.
  let devOwnerLine: string | null = null;
  if (!isOwner(caller) && !createGranted) {
    const ownerLine = `only the owner runs init, from a terminal outside herdr; this call is ${describeCaller(caller)}${devModeExpiryNote(dev)}`;
    const folded = devModeCallerGate(dev, ownerLine);
    if (folded === null) {
      io.stderr(`team init: ${ownerLine}\n`);
      // exit: init.not-owner
      return 1;
    }
    devOwnerLine = folded;
    io.stderr(`team init: ${devOwnerLine}\n`);
  }
  const root = rootOf();
  if (!root) {
    io.stderr('team init: not inside a git repository\n');
    // exit: init.not-a-repo
    return 2;
  }
  const path = join(root, TEAM_FILE);
  if (devOwnerLine !== null) logDevMode(dirname(path), 'init', describeCaller(caller), devOwnerLine, sources.now?.());
  logDevModeState(dirname(path), 'init', describeCaller(caller), dev, sources.now?.());
  if (git(root, 'ls-files', '--error-unmatch', TEAM_FILE) !== null) {
    io.stderr(`team init: ${TEAM_FILE} is tracked by git, and a team file is private. Untrack it, keeping the file:\n  git rm --cached ${TEAM_FILE}\nthen run team init again. History is not rewritten.\n`);
    // exit: init.tracked
    return 1;
  }
  if (existsSync(path)) {
    exclude(root);
    io.stderr(`team init: ${TEAM_FILE} exists already; it is left as it is. Its lines in .git/info/exclude were checked, and added where missing.\n`);
    // exit: init.exists
    return 1;
  }

  let text: string;
  if (args.flags.has('restore')) {
    // Only a verified record carries a copy worth restoring: a legacy or refused
    // one is said in its own words, never restored from.
    const standing = readStanding
      ? readStanding(root)
      : home === undefined
        ? approvalStanding(root)
        : approvalStanding(root, home);
    if (standing.kind === 'legacy') {
      io.stderr(`team init: nothing was restored: the record for this folder was ${LEGACY_LINE}.\n`);
      // exit: init.legacy
      return 1;
    }
    if (standing.kind === 'refused') {
      io.stderr(`team init: nothing was restored: ${standing.why}.\n`);
      // exit: init.refused
      return 1;
    }
    const copy = standing.kind === 'verified' ? standing.record.file : null;
    if (copy === null) {
      io.stderr('team init: nothing to restore: no team file was approved for this folder on this machine. Run team init for a skeleton.\n');
      // exit: init.nothing
      return 1;
    }
    text = copy;
  } else {
    text = skeleton(basename(root), git(root, 'rev-parse', 'HEAD'), version(), root, firstLoggedInCli(sources));
    const check = validateTeamFile(text);
    // exit: init.skeleton
    if (!check.ok) throw new Error(`the skeleton doesn't validate: ${check.errors[0]?.message}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const added = exclude(root);
  writeFileSync(path, text, { flag: 'wx' });
  const what = args.flags.has('restore') ? 'restored the approved copy' : 'wrote a skeleton';
  logLine(dirname(path), 'init', describeCaller(caller), `${what} as ${TEAM_FILE}; excluded ${added.length} path(s)`);
  // The registry is where the user-level state lives: the home the shipped command names, or the
  // one a test hands in. A caller that names neither leaves the machine's registry alone.
  const registryHome = sources.registryHome ?? home;
  if (registryHome !== undefined) {
    const written = loadTeamFile(root, { home: registryHome, checkOnly: true });
    if (written.ok) {
      const unrecorded = noteTeam(registryHome, root, written.team, 'defined', describeCaller(caller));
      if (unrecorded) io.stderr(`team init: ${unrecorded}\n`);
    }
  }
  io.stdout(args.flags.has('restore')
    ? `Restored ${TEAM_FILE} from the copy you last approved on this machine.\n\n${PRIVACY}\n`
    : `Wrote ${TEAM_FILE}: a skeleton with one seat. Edit it, then run the seats.\n\n${PRIVACY}\n`);
  // exit: init.wrote
  // exit: init.restored
  return 0;
}
