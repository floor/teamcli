import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { declaredRoots } from '../entities.ts';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner } from '../caller.ts';
import { devModeCallerGate, devModeExpiryNote, logDevMode, logDevModeState, resolveDevMode } from '../dev_mode.ts';
import { TEAM_FILE, findRoot } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { validateTeamFile } from '../file/validate.ts';
import { entityGrantAdmits, isSameOrInside, readEntityCreateGrants } from '../grant.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import { profileFor } from '../profiles/index.ts';
import { hasJsonFlag, pluralCount, refuse, writeJson } from '../output/index.ts';
import { noteTeam } from '../registry/teams.ts';
import { createAtomic, LOCK_FILE, LOG_FILE, STATE_FILE, writeAtomic } from '../state.ts';
import { approvalStanding, LEGACY_LINE, type Standing } from '../store/store.ts';
import { version } from '../version.ts';
import { realSources as doctorSources, type DoctorSources } from './doctor.ts';
import { systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { ruleRelaxed } from '../security/profile.ts';
import { admitTeamCreate, approveTeamCreate, createTeamCreateRequest, listApprovalModes, listTeamCreateRules, revokeTeamCreateRule, setApprovalMode } from '../client/team-create.ts';
import { assertionFile } from '../client-cli.ts';
import { teamTextTarget, writeTeamText } from '../file/team-text.ts';
import { readStoredTeamConfig, teamConfigRecordPath } from '../registry/team-config-store.ts';

// What git must never pick up: the file and the runtime files beside it — the start files of
// the services included: the socket and its lock, the lock's takeover claim (a killed
// claim-holder can leave it), and the private temps an atomic write keeps only while it runs —
// the team file's own and the state's included, which a killed process can leave behind.
export const EXCLUDED = [TEAM_FILE, `${TEAM_FILE}.*.tmp`, `.agents/${STATE_FILE}`, `.agents/${STATE_FILE}.*.tmp`, `.agents/${LOG_FILE}*`, `.agents/${LOCK_FILE}`, '.agents/seat-locks', '.agents/messages/', '.agents/send-drops/', '.agents/leases/', '.agents/hooks/', '.agents/seat-state/', '.agents/broker.sock', '.agents/broker.sock.lock', '.agents/broker.sock.lock.takeover', '.agents/broker.sock.lock.*.new', '.agents/bus.sock', '.agents/bus.sock.lock', '.agents/bus.sock.lock.takeover', '.agents/bus.sock.lock.*.new'];

export const PRIVACY = `The team file is private to this clone: it is listed in .git/info/exclude, never in .gitignore,
so git doesn't see it and a fresh clone doesn't carry it. A collaborator writes their own, or
receives one and uses it as their own.`;

/** A folder's real path where it can be read, its resolved spelling otherwise. */
function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The entity whose declared roots hold `place`, read from the owner's entities file: the root
 * itself or a folder containing it, so `roots: [~/Code]` declares every team under it. Both
 * spellings are compared — `~/…` expanded against `home`, and the real path on both sides,
 * so a root reached through a link still holds the place it names. The deepest matching root
 * wins, so a broader entity does not shadow a more specific one. This is the entity that
 * governs `init` from the place the run is in, exactly as it governs the commands that read a
 * team file there.
 */
function declaredEntity(home: string, place: string): string | null {
  const resolvedPlace = resolve(place);
  const realPlace = realOf(resolvedPlace);
  const homeResolved = resolve(home);
  let found: { name: string; depth: number } | null = null;
  for (const [name, roots] of declaredRoots(home)) {
    for (const root of roots) {
      if (!root.startsWith('/') && !root.startsWith('~/')) continue;
      const expanded = resolve(root.replace(/^~(?=$|\/)/, homeResolved));
      const holds =
        isSameOrInside(expanded, resolvedPlace) ||
        isSameOrInside(realOf(expanded), realPlace);
      if (!holds) continue;
      if (found === null || expanded.length > found.depth) found = { name, depth: expanded.length };
    }
  }
  return found === null ? null : found.name;
}

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
# The live file is what the commands read. Edit it, then run team up.
format: 1
project: ${project}
# visibility: public          # public | private: whether forbidden_public applies
# session: ${project}          # the herdr session; default <entity>-<project>, never "default"
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

export const USAGE = `Usage: team init [--restore] [--json]
       team init --request [--json]
       team init --execute <request-id> [--json]
       team init --approve-as-owner-seat <request-id> <oui|always|non> [--signer <name>] [--assertion <file>] [--json]
       team init --approvals [--json]
       team init --revoke-approval <rule-id> [--json]
       team init --approval-mode <none|always-rule|per-action> --scope <folder> [--signer <name>] [--assertion <file>] [--json]
       team init --approval-modes [--json]

Exits 0 when the team file is written or restored, 1 when init is refused, 2 when the invocation can't be read or this folder is not a git repository.
`;

// `home` is where the user-level store is looked for; tests hand in a temporary one.
// `readStanding` stands in for the store's one read, so a test can count it or swap the
// record after the gate. `sources` is the one machine read the skeleton needs: which CLI the
// owner is signed in to — tests and the docs runner hand in a stub, so no real login is probed.
export async function runInit(
  argv: string[],
  io: Io,
  home?: string,
  readStanding?: (root: string) => Standing,
  sources: Pick<DoctorSources, 'loggedIn'> & { now?: () => Date; registryHome?: string; ownerSeatStore?: OwnerSeatKeyStore } = doctorSources,
): Promise<number> {
  // A bad option stops the parser before `--json` is read when it comes first, and the
  // structured refusal is still the one the caller asked for.
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['execute', 'approve-as-owner-seat', 'signer', 'assertion', 'revoke-approval', 'approval-mode', 'scope'], ['restore', 'json', 'request', 'approvals', 'approval-modes']);
  const approving = args.values['approve-as-owner-seat'] !== undefined;
  if (args.error || (args.rest.length && !(approving && args.rest.length === 1))) {
    refuse(io, json, 'init', {
      id: 'init.invocation',
      message: args.error ?? `unexpected "${args.rest[0]}"`,
      repair: null,
      usage: USAGE,
    });
    // exit: init.invocation
    return 2;
  }
  // Owner-seat approval of a team creation (src/client/team-create.ts). Each of these forms runs
  // without the owner terminal: the authority is an owner signer's signature, never the caller.
  const actionHome = home ?? homedir();
  const store = sources.ownerSeatStore ?? systemOwnerSeatKeyStore();
  const now = sources.now?.() ?? new Date();
  const actionRefusal = (message: string) => refuse(io, json, 'init', { id: 'init.approval-refused', message, repair: null });
  const actionDone = (status: 'requested' | 'answered', summary: string, extra: Record<string, unknown>) => {
    if (json) writeJson(io, 'team.init', { format: 1 as const, dry_run: false, status, action_summary: summary, file: TEAM_FILE, restored: false, ...extra } as never);
    else io.stdout(`${summary}\n${Object.entries(extra).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}\n`);
  };
  let actionOutcome: 'done' | 'refused' | null = null;
  if (args.flags.has('request')) {
    const root = findRoot(io.cwd);
    if (root === null) actionRefusal('not inside a git repository');
    else if (existsSync(join(root, TEAM_FILE))) actionRefusal(`${TEAM_FILE} exists already`);
    else {
      const made = createTeamCreateRequest(actionHome, root, git(root, 'rev-parse', 'HEAD'), now);
      if (!made.ok) actionRefusal(made.why);
      else actionDone('requested', `team init: request recorded`, { request_id: made.record.request_id, text: made.text, ...(made.inbox !== null ? { inbox: made.inbox } : {}) });
      actionOutcome = made.ok ? 'done' : 'refused';
    }
    actionOutcome ??= 'refused';
  } else if (approving) {
    const assertion = assertionFile(args.values.assertion, io.cwd);
    const answered = approveTeamCreate(actionHome, args.values['approve-as-owner-seat']!, args.rest[0]!, store, now, {
      ...(args.values.signer !== undefined ? { signer: args.values.signer } : {}),
      ...(assertion !== undefined ? { assertion } : {}),
    });
    if (!answered.ok) actionRefusal(answered.why);
    else actionDone('answered', `team init: owner seat answered ${answered.choice}`, { request_id: args.values['approve-as-owner-seat']!, ...(answered.ruleId !== undefined ? { rule_id: answered.ruleId } : {}) });
    actionOutcome = answered.ok ? 'done' : 'refused';
  } else if (args.flags.has('approvals')) {
    const listed = listTeamCreateRules(actionHome, store, now);
    actionDone('answered', 'team init: team-create approval rules', { rules: listed.rules, ignored: listed.ignored });
    actionOutcome = 'done';
  } else if (args.values['approval-mode'] !== undefined) {
    // Signed once by an owner signer at setup; never by the requester at action time.
    const assertion = assertionFile(args.values.assertion, io.cwd);
    const scope = args.values.scope;
    const set = scope === undefined
      ? { ok: false as const, why: '--approval-mode needs --scope <folder>' }
      : setApprovalMode(actionHome, 'team-create', args.values['approval-mode'], resolve(io.cwd, scope), store, now, {
        ...(args.values.signer !== undefined ? { signer: args.values.signer } : {}),
        ...(assertion !== undefined ? { assertion } : {}),
      });
    if (!set.ok) actionRefusal(set.why);
    else actionDone('answered', `team init: approval mode for team-create is ${args.values['approval-mode']}`, { ...(set.modeId !== undefined ? { mode_id: set.modeId } : {}), revoked: set.revoked });
    actionOutcome = set.ok ? 'done' : 'refused';
  } else if (args.flags.has('approval-modes')) {
    const listed = listApprovalModes(actionHome, store, now);
    actionDone('answered', 'team init: approval modes', { modes: listed.modes, ignored: listed.ignored });
    actionOutcome = 'done';
  } else if (args.values['revoke-approval'] !== undefined) {
    const revoked = revokeTeamCreateRule(actionHome, args.values['revoke-approval']);
    if (!revoked.ok) actionRefusal(revoked.why);
    else actionDone('answered', 'team init: approval rule revoked', { rule_id: args.values['revoke-approval'] });
    actionOutcome = revoked.ok ? 'done' : 'refused';
  }
  let seatApproved = false;
  if (actionOutcome === null && args.values.execute !== undefined) {
    const root = findRoot(io.cwd);
    const admitted = root === null ? { ok: false as const, why: 'not inside a git repository' } : admitTeamCreate(actionHome, args.values.execute, root, store, now);
    if (!admitted.ok) {
      actionRefusal(admitted.why);
      actionOutcome = 'refused';
    } else seatApproved = true;
  }
  if (actionOutcome === 'done') {
    // exit: init.approval
    return 0;
  }
  if (actionOutcome === 'refused') {
    // exit: init.approval-refused
    return 1;
  }
  const caller = callerOf(io);
  let foundRoot: string | null | undefined;
  const rootOf = () => (foundRoot === undefined ? (foundRoot = findRoot(io.cwd)) : foundRoot);
  const createGranted = seatApproved || (
    !isOwner(caller) &&
    !args.flags.has('restore') &&
    readEntityCreateGrants(home).length > 0 &&
    (() => {
      const candidateRoot = rootOf();
      return candidateRoot !== null && entityGrantAdmits(candidateRoot, io, { home, now: sources.now?.(), cwd: io.cwd });
    })());
  // No create-grant admits a run with no terminal: the record matches the caller's own registry
  // record, and a caller outside herdr has none.
  const detached = detachedRefusal(caller);
  if (detached !== undefined && !createGranted) {
    refuse(io, json, 'init', { id: 'init.detached', message: detached, repair: null });
    // exit: init.detached
    return 1;
  }
  // Dev mode, from the caller's place: the entity's chain, read before the team file this run
  // writes exists. The entity is the one whose declared roots hold this place — or the team
  // file already standing there — because without it the chain holds no entity source at all,
  // and a `dev-mode` set at the entity would not govern. A `dev-mode` value anywhere in the
  // chain governs, and `TEAMCLI_DEV_MODE` is then ignored; before any such value, the variable
  // set to exactly `1` keeps its behaviour.
  const root = rootOf();
  const place = root ?? io.cwd;
  const standingFile = readTeamConfig(io.cwd, { ...(home !== undefined ? { home } : {}) });
  const dev = resolveDevMode('init', io, {
    ...(home !== undefined ? { home } : {}),
    entity: home !== undefined ? declaredEntity(home, place) : null,
    team: standingFile.ok ? standingFile.team : null,
    root: place,
    now: sources.now?.() ?? new Date(),
  });
  // The configuration lines the run owes once — the variable ignored under a governing policy,
  // an expiry, a source that could not be read — written before the gate, so a refusal keeps
  // them. A run outside any repository has no folder of its own; it is refused below and
  // writes nothing.
  const initDir = root === null ? null : dirname(join(root, TEAM_FILE));
  if (initDir !== null) logDevModeState(initDir, 'init', describeCaller(caller), dev, sources.now?.());
  // The who-may-run-it gate: dev mode says the owner line once, as a warning, and the run
  // continues — exactly as `up` does. Every other refusal stays a refusal. The warning is
  // logged where the run knows the folder it writes in.
  let devOwnerLine: string | null = null;
  // Collapsed notes: the warnings plain output writes to stderr ride on the document instead.
  const notes: string[] = [];
  if (!isOwner(caller) && !createGranted) {
    const ownerLine = `only the owner runs this, from a terminal outside herdr; this call is ${describeCaller(caller)}${devModeExpiryNote(dev)}`;
    const folded = devModeCallerGate(dev, ownerLine)
      ?? (ruleRelaxed(actionHome, 'gate.owner-terminal', store, { now, what: `init by ${describeCaller(caller)}` }) ? `owner terminal gate relaxed by the owner-signed security profile (rule gate.owner-terminal); this call is ${describeCaller(caller)}` : null);
    if (folded === null) {
      refuse(io, json, 'init', {
        id: 'init.not-owner',
        message: ownerLine,
        repair: 'the owner runs `team init` from a terminal outside herdr',
        rule: 'owner-only',
      });
      // exit: init.not-owner
      return 1;
    }
    devOwnerLine = folded;
    if (json) notes.push(devOwnerLine);
    else io.stderr(`team init: ${devOwnerLine}\n`);
  }
  if (!root) {
    refuse(io, json, 'init', { id: 'init.not-a-repo', message: 'not inside a git repository', repair: null });
    // exit: init.not-a-repo
    return 2;
  }
  const path = join(root, TEAM_FILE);
  if (devOwnerLine !== null) logDevMode(dirname(path), 'init', describeCaller(caller), devOwnerLine, sources.now?.());
  if (git(root, 'ls-files', '--error-unmatch', TEAM_FILE) !== null) {
    refuse(io, json, 'init', {
      id: 'init.tracked',
      message: `${TEAM_FILE} is tracked by git, and a team file is private`,
      repair: `git rm --cached ${TEAM_FILE}, then run team init again; history is not rewritten`,
      plain: `${TEAM_FILE} is tracked by git, and a team file is private. Untrack it, keeping the file:\n  git rm --cached ${TEAM_FILE}\nthen run team init again. History is not rewritten.`,
    });
    // exit: init.tracked
    return 1;
  }
  // Under `team-config.source: registry` the new team is the registry's record, and no file is
  // written; a team the registry already holds is the same refusal as a file that exists.
  const target = teamTextTarget(path, { ...(home !== undefined ? { home } : {}), create: true });
  const held = target.kind === 'registry'
    ? readStoredTeamConfig(target.home, target.id) !== null
    : existsSync(path);
  if (held) {
    if (target.kind === 'file') exclude(root);
    refuse(io, json, 'init', {
      id: 'init.exists',
      message: target.kind === 'registry'
        ? `the registry already holds this team (${teamConfigRecordPath(target.home, target.id)}); it is left as it is. Edit it with the team's commands, or replace it with team import.`
        : `${TEAM_FILE} exists already; it is left as it is. Its lines in .git/info/exclude were checked, and added where missing.`,
      repair: null,
    });
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
      refuse(io, json, 'init', {
        id: 'init.legacy',
        message: `nothing was restored: the record for this folder was ${LEGACY_LINE}.`,
        repair: null,
      });
      // exit: init.legacy
      return 1;
    }
    if (standing.kind === 'refused') {
      refuse(io, json, 'init', {
        id: 'init.refused',
        message: `nothing was restored: ${standing.why}.`,
        repair: null,
      });
      // exit: init.refused
      return 1;
    }
    const copy = standing.kind === 'verified' ? standing.record.file : null;
    if (copy === null) {
      refuse(io, json, 'init', {
        id: 'init.nothing',
        message: 'nothing to restore: no copy of a team file was stored for this folder on this machine',
        repair: 'team init writes a skeleton',
        plain: 'nothing to restore: no copy of a team file was stored for this folder on this machine. Run team init for a skeleton.',
      });
      // exit: init.nothing
      return 1;
    }
    // The stored copy is validated before anything is written: a copy that no longer validates
    // (a newer validator, a copy approved under rules since changed) is refused, never restored.
    const restoredCheck = validateTeamFile(copy);
    if (!restoredCheck.ok) {
      const first = restoredCheck.errors[0];
      refuse(io, json, 'init', {
        id: 'init.restore-invalid',
        message: `nothing was restored: the stored copy doesn't validate: ${first?.line ? `line ${first.line}: ` : ''}${first?.message ?? 'invalid'}`,
        repair: 'team init writes a skeleton',
      });
      // exit: init.restore-invalid
      return 1;
    }
    text = copy;
  } else {
    text = skeleton(basename(root), git(root, 'rev-parse', 'HEAD'), version(), root, firstLoggedInCli(sources));
    const check = validateTeamFile(text);
    if (!check.ok) {
      refuse(io, json, 'init', {
        id: 'init.skeleton',
        message: `the skeleton doesn't validate: ${check.errors[0]?.message}`,
        repair: null,
      });
      // exit: init.skeleton
      return 1;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const added = exclude(root);
  if (target.kind === 'registry') {
    // The text was validated above, the skeleton or the restored copy alike, so this write does
    // not refuse; a failure here is a bug, said as one.
    const wrote = writeTeamText(path, text, { home: target.home, command: 'init', create: true, ...(sources.now ? { now: sources.now } : {}) });
    if (!wrote.ok) throw new Error(`team init: the team doesn't validate: ${wrote.errors[0]?.message}`);
  } else {
    // The create, the atomic way: a temp in the same folder, hard-linked into place, so the file
    // appears whole — never as a prefix a killed process could leave behind — and an existing
    // file is refused (EEXIST) rather than clobbered.
    createAtomic(path, text);
  }
  const what = args.flags.has('restore') ? 'restored the copy this machine stored' : 'wrote a skeleton';
  const into = target.kind === 'registry' ? 'into the registry' : `as ${TEAM_FILE}`;
  logLine(dirname(path), 'init', describeCaller(caller), `${what} ${into}; excluded ${pluralCount(added.length, 'path')}`);
  // The registry is where the user-level state lives: the home the shipped command names, or the
  // one a test hands in. A caller that names neither leaves the machine's registry alone.
  const registryHome = sources.registryHome ?? home;
  if (registryHome !== undefined) {
    const written = readTeamConfig(root, { home: registryHome, checkOnly: true });
    if (written.ok) {
      const unrecorded = noteTeam(registryHome, root, written.team, 'defined', describeCaller(caller));
      if (unrecorded) {
        if (json) notes.push(unrecorded);
        else io.stderr(`team init: ${unrecorded}\n`);
      }
    }
  }
  const restored = args.flags.has('restore');
  // The existing closing line is the action summary; the privacy paragraph is plain-only prose
  // the document has no field for.
  const action_summary = restored
    ? `Restored ${TEAM_FILE} from the copy this machine stored.`
    : `Wrote ${TEAM_FILE}: a skeleton with one seat. Edit it, then run team up.`;
  if (json) {
    writeJson(io, 'team.init', {
      format: 1 as const,
      dry_run: false,
      status: restored ? 'restored' : 'wrote',
      action_summary,
      file: TEAM_FILE,
      restored,
      notes,
    });
  } else {
    io.stdout(`${action_summary}\n\n${PRIVACY}\n`);
  }
  // exit: init.wrote
  // exit: init.restored
  return 0;
}
