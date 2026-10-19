// The dev-mode scope, in one place. Kernel amendment 02 (§2.7, catalogue `dev-mode`): the
// `dev-mode` policy, set at entity, project or team and never at a seat, lifts the "who may run
// it" gate of the `DEV_MODE_OPERATIONS` commands — up, down, remove of an ordinary seat,
// register, add, restart, init and reload — while it is `on` for the caller's level. It lifts
// only that gate: the placement, CLI, record and scope checks stay.
//
// The owner's urgent widening (OD-20261019-49) adds a second, narrower admission: while dev mode
// is `on`, a placed seat that is the team's orchestrator — the file's resolved lead, whether it
// was spelled by `coordinator:` or by `leads: true` — may run the owner-only authority edits —
// grant, delegate, revoke, policy set/unset, `check --repair`, `remove --abandon`, `down
// --abandon`, `broker` and `tempo` — and each admitted run prints the same `dev mode continues`
// warning and writes the same audit line (the command, the caller, and dev mode's source). Every
// team's own lead is admitted on its own team's commands, and the main orchestrator on the main
// team's. The role alone is never the proof: the caller must be placed on its recorded pane in
// the team's session. Swap guards, load guards, the public-action refusals and every other owner
// gate are untouched; with dev mode `off` every one of these gates refuses exactly as before.
//
// The environment variable `TEAMCLI_DEV_MODE=1` stays for compatibility and is honoured only
// while no `dev-mode` value is set anywhere in the chain (`devModeGoverned` false): the
// migration trigger. Once a value governs, the variable is ignored entirely — once a command
// says so in the log — and the effective policy alone decides. An expired declaration still
// counts as a declaration here (`resolvePolicyChain`'s `devModeGoverned`, read as exported), so
// an expiry reverts the gate to `off` and the variable stays ignored; the first command refused
// after it names the expiry in its refusal (and every command logs it once), so a gate that
// went quiet says when and at which level.
//
// Every use under `on` warns on stderr and writes the audit log line beside it — the one sink
// every command logs through (`logLine`) — with the caller, the command and the level that set
// the policy. A dry run prints the warning and decides nothing, so it writes no line.
import type { TeamFile } from './file/types.ts';
import type { Io } from './io.ts';
import { logLine } from './log.ts';
import { callerOf, callerVerdict, logTag, standingOf, walkCaller, type Caller } from './caller.ts';
import { loadTeamFile } from './file/load.ts';
import { dirname } from 'node:path';
import {
  DEV_MODE_OPERATIONS,
  loadAndResolvePolicyChain,
  type DevModeOperation,
  type PolicyLevel,
  type PolicyLoadRefusal,
} from './policy/index.ts';
import { byName, ofTeam, projectIdOf } from './registry/projects.ts';
import { teamIdOf } from './registry/teams.ts';

/** The commands whose caller gate dev mode lifts: the interface's one list (`policy/types.ts`). */
export const DEV_MODE_COMMANDS = DEV_MODE_OPERATIONS;

export type DevModeCommand = DevModeOperation;

/** Where a command stands: the caller's team, and the policy chain the caller's place reads. */
export type DevModeContext = {
  /** The home the signed policy sources live under. Absent: no chain is read, the variable alone applies. */
  home?: string;
  /** The entity whose policy source the chain reads; a team's own `entity` stands in when absent. */
  entity?: string | null;
  team?: TeamFile | null;
  root?: string | null;
  now?: Date;
};

function chainFor(context: DevModeContext & { home: string }): ReturnType<typeof loadAndResolvePolicyChain> {
  const team = context.team ?? null;
  const root = context.root ?? null;
  return loadAndResolvePolicyChain(
    {
      home: context.home,
      ...(context.entity !== undefined ? { entity: context.entity } : {}),
      projectId: projectIdOfTeam(context.home, team, root),
      teamRoot: root,
      team,
    },
    { ...(context.now ? { now: context.now } : {}), upToLevel: 'team' },
  );
}

/** An expired `dev-mode` declaration: what the gate fell back to `off` from, and where. */
export type DevModeExpiry = { at: string; level: PolicyLevel };

/** What the chain says about dev mode for one command, before any gate is asked. */
export type DevModeRun = {
  /** The caller gate is lifted: the effective policy is `on`, or the variable is in effect before any policy. */
  on: boolean;
  /** What turned it on: the policy level that set `on`, or the variable before any policy governs. */
  by: 'env' | PolicyLevel | null;
  /** A `dev-mode` value is set anywhere in the chain, so `TEAMCLI_DEV_MODE` is ignored. */
  governed: boolean;
  /** The variable is set to `1` and the governing policy is `off`: the ignoring to log once. */
  ignored: boolean;
  /** The nearest declaration the expiry left with no effective value: an expired `dev-mode`
   *  is what makes the gate quiet, so the first refusal after it says so, and each command
   *  logs it once. */
  expired: DevModeExpiry | null;
  /** Policy sources that cannot be read, verified or ordered: dev mode is not applied on them. */
  refusals: PolicyLoadRefusal[];
};

/** The project a team belongs to, read the way `team check`'s policy pass reads it. The
 *  seat-numbering setting reads it through this one copy. */
export function projectIdOfTeam(home: string, team: TeamFile | null, root: string | null): string | null {
  if (team === null) return null;
  try {
    if (root !== null) {
      const byTeam = ofTeam(home, teamIdOf(root));
      if (byTeam) return byTeam.id ?? null;
    }
    if (team.inProject) return byName(home, team.inProject)?.id ?? projectIdOf(team.inProject);
    return projectIdOf(team.project);
  } catch {
    return null;
  }
}

function variableOnly(envSet: boolean): DevModeRun {
  return { on: envSet, by: envSet ? 'env' : null, governed: false, ignored: false, expired: null, refusals: [] };
}

/** The nearest expired `dev-mode` declaration — the level `resolvePolicy` would have taken had
 *  it not expired (team over project over entity; dev mode is never a seat's). */
function nearestExpiry(expired: readonly { name: string; level: PolicyLevel; expiry?: string | null }[]): DevModeExpiry | null {
  const gone = expired.filter((decl) => decl.name === 'dev-mode' && typeof decl.expiry === 'string');
  for (const level of ['team', 'project', 'entity'] as const) {
    const decl = gone.find((candidate) => candidate.level === level);
    if (decl !== undefined && typeof decl.expiry === 'string') return { at: decl.expiry, level };
  }
  return null;
}

/**
 * Resolves dev mode for one command from the caller's place.
 *
 * - No `home`: no policy source can be read, so the variable alone applies (today's behaviour).
 * - A chain that will not load: nothing is applied — the policy cannot be trusted, and the
 *   variable is not consulted, since a governing value may be among what could not be read.
 * - `devModeGoverned`: the variable is ignored; `on` iff the effective `dev-mode` is `on`.
 * - Otherwise: the variable, set to exactly `1`, keeps its pre-policy behaviour.
 */
export function resolveDevMode(command: DevModeCommand, io: Pick<Io, 'env'>, context: DevModeContext = {}): DevModeRun {
  const envSet = io.env.TEAMCLI_DEV_MODE === '1';
  if (context.home === undefined) return variableOnly(envSet);
  const chain = chainFor({ ...context, home: context.home });
  if (!chain.ok) {
    // Nothing is lifted on a policy the tool could not read or order (amendment §2.5): the
    // default does not silently stand in its place, and the run says why in its log.
    return { on: false, by: null, governed: chain.devModeGoverned, ignored: false, expired: null, refusals: chain.refusals };
  }
  if (chain.devModeGoverned) {
    const effective = chain.policies['dev-mode'];
    const on = DEV_MODE_OPERATIONS.includes(command) && effective !== undefined && effective.value === 'on';
    const level = on && effective !== undefined && effective.level !== 'default' ? effective.level : null;
    // The default standing while a declaration exists: the expiry is what left the gate off.
    // An explicit value at any level — even `off` — did the refusing, and is not this clause.
    const expired = effective === undefined || effective.level === 'default' ? nearestExpiry(chain.expired) : null;
    return { on, by: level, governed: true, ignored: envSet && !on, expired, refusals: [] };
  }
  return variableOnly(envSet && DEV_MODE_OPERATIONS.includes(command));
}

/**
 * Dev mode's state at the caller's place, without the operation list: `on` here means dev mode
 * itself is on (the effective policy is `on`, or the variable is in effect before any policy),
 * which is what the owner-gate admission reads. The operation list is a separate question, asked
 * by `resolveDevMode`; nothing here widens it.
 */
export function devModeState(io: Pick<Io, 'env'>, context: DevModeContext = {}): DevModeRun {
  const envSet = io.env.TEAMCLI_DEV_MODE === '1';
  if (context.home === undefined) return variableOnly(envSet);
  const chain = chainFor({ ...context, home: context.home });
  if (!chain.ok) {
    return { on: false, by: null, governed: chain.devModeGoverned, ignored: false, expired: null, refusals: chain.refusals };
  }
  if (chain.devModeGoverned) {
    const effective = chain.policies['dev-mode'];
    const on = effective !== undefined && effective.value === 'on';
    const level = on && effective !== undefined && effective.level !== 'default' ? effective.level : null;
    const expired = effective === undefined || effective.level === 'default' ? nearestExpiry(chain.expired) : null;
    return { on, by: level, governed: true, ignored: envSet && !on, expired, refusals: [] };
  }
  return variableOnly(envSet);
}

/** The role that admits an owner-only command under dev mode: the team's resolved lead — the
 *  file's `orchestrator`, whether it was spelled by `coordinator:` or by `leads: true`. That is
 *  the team lead of this file; every team's own lead is admitted on its own team's commands, and
 *  the main orchestrator on the main team's. Any other seat, the operator included, is no
 *  admission: the file names exactly one lead, and the registry silently mirrors it, so the
 *  approved file — not a possibly stale derived record — is what the gate reads. */
export type DevModeOwnerRole = 'orchestrator';

/** The role `name` holds in this team, or null. */
export function devModeOwnerRoleOf(name: string, team: TeamFile): DevModeOwnerRole | null {
  return name === team.orchestrator ? 'orchestrator' : null;
}

/** The result of asking whether dev mode admits this caller to an owner-only gate. */
export type DevModeOwnerLift = {
  lifted: boolean;
  /** The line to print when `lifted`: `warning: <refusal>; dev mode continues<level note>`. */
  warning: string | null;
  /** The caller the walk placed (a seat only when the lift was asked with a session). */
  caller: Caller;
  role: DevModeOwnerRole | null;
};

const NO_LIFT = (caller: Caller): DevModeOwnerLift => ({ lifted: false, warning: null, caller, role: null });

/**
 * Whether dev mode admits `caller` to one owner-only command. The caller must be a placed seat in
 * the team's own session, on the pane the state records for it; its name must be the team's
 * resolved lead; and dev mode must be `on` for the caller's place. The owner is not this path's to admit — the command's own `isOwner` answers first — and
 * a no-terminal or unplaced caller never is. An admitted run logs the same warning the folded
 * caller gate logs, with the command and the caller, and the command prints it to stderr.
 */
export function devModeOwnerLift(
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
  options: {
    command: string;
    /** The command's owner-only refusal sentence, before dev mode's clause is added. */
    refusal: string;
    home?: string;
    team: TeamFile;
    root: string;
    dir: string;
    now?: Date;
  },
): DevModeOwnerLift {
  const caller = callerOf(io, options.team.session);
  if (caller.kind !== 'seat') return NO_LIFT(caller);
  const state = devModeState(io, {
    ...(options.home !== undefined ? { home: options.home } : {}),
    team: options.team,
    root: options.root,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  if (!state.on) return NO_LIFT(caller);
  const role = devModeOwnerRoleOf(caller.name, options.team);
  if (role === null) return NO_LIFT(caller);
  const at = standingOf(options.dir, options.team.session, caller);
  if (callerVerdict(caller, caller.name, at).kind !== 'ok') return NO_LIFT(caller);
  const warning = `warning: ${options.refusal}; dev mode continues${devModeLevelNote(state)}`;
  logLine(options.dir, options.command, logTag(caller), `${warning}; admitted as ${role}`, options.now);
  return { lifted: true, warning, caller, role };
}

/**
 * The same admission for a command that has not loaded its team file yet: it loads the file the
 * command's own cwd names, and only for a caller the walk places under herdr or hands in as a
 * seat. A no-terminal caller, a pane and every other placement answer null without a read, so
 * the owner-only boundaries that refuse before any file is read keep that order exactly.
 */
export function devModeOwnerLiftAtCwd(
  io: Io,
  options: { command: string; refusal: string; home?: string; now?: Date },
): DevModeOwnerLift | null {
  const walked = walkCaller(io);
  if (walked.kind !== 'seat' && !(walked.kind === 'unplaced' && walked.reason === 'it runs under herdr')) return null;
  let loaded: ReturnType<typeof loadTeamFile>;
  try {
    loaded = loadTeamFile(io.cwd, { ...(options.home !== undefined ? { home: options.home } : {}) });
  } catch {
    return null;
  }
  if (!loaded.ok) return null;
  return devModeOwnerLift(io, {
    command: options.command,
    refusal: options.refusal,
    ...(options.home !== undefined ? { home: options.home } : {}),
    team: loaded.team,
    root: loaded.root,
    dir: dirname(loaded.path),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

/**
 * Whether dev mode is active at the caller's place, for the readings that fold their rows under
 * it (`team check`, `team status`): the effective `dev-mode` policy is `on` once a value
 * governs, and before any value the variable set to exactly `1`. A chain that cannot be read
 * reports inactive: a policy the tool could not verify does not quiet a single row.
 */
export function devModeActive(io: Pick<Io, 'env'>, context: DevModeContext = {}): boolean {
  const envSet = io.env.TEAMCLI_DEV_MODE === '1';
  if (context.home === undefined) return envSet;
  const chain = chainFor({ ...context, home: context.home });
  if (!chain.ok) return false;
  if (chain.devModeGoverned) return chain.policies['dev-mode']?.value === 'on';
  return envSet;
}

/**
 * The level a governing policy set dev mode at, for the warning that records an use: empty
 * while the variable is what set it (or while nothing governs), so pre-policy bytes stay exact.
 */
export function devModeLevelNote(run: DevModeRun): string {
  return run.by === 'env' || run.by === null ? '' : ` (dev-mode on at ${run.by} level)`;
}

/**
 * The clause a refusal carries after an expiry: the gate it used to lift is quiet, and the
 * refusal says when it went quiet and at which level — `; dev-mode expired at <t> for
 * <level>; it is off since`. Empty while no `dev-mode` declaration has expired.
 */
export function devModeExpiryNote(run: DevModeRun): string {
  return run.expired === null ? '' : `; dev-mode expired at ${run.expired.at} for ${run.expired.level}; it is off since`;
}

/**
 * The same expiry as a stderr line of its own: `note: dev-mode expired at <t> for <level>; it
 * is off since`. A refusal whose contract is a single word (`up`'s bare `deny`) keeps that word
 * exactly, and names the quieted gate on the line after it. Empty while no `dev-mode`
 * declaration has expired.
 */
export function devModeExpiryLine(run: DevModeRun): string {
  return run.expired === null ? '' : `note: dev-mode expired at ${run.expired.at} for ${run.expired.level}; it is off since`;
}

/**
 * The caller gate of `command`, folded: dev mode on answers the warning line the run prints —
 * the refusal's own words, then `; dev mode continues`, and, under a policy, the level that set
 * it — and null otherwise, leaving the gate to refuse. A command outside the list has no call to
 * make: its gates are not dev mode's to lift.
 */
export function devModeCallerGate(run: DevModeRun, refusal: string): string | null {
  if (!run.on) return null;
  return `warning: ${refusal}; dev mode continues${devModeLevelNote(run)}`;
}

/** Whether a run's record wears the dev mark: the variable's own runs always do (today's
 *  behaviour); a policy's run only when a gate was actually folded, so an owner's run under
 *  `on` is not said to have been admitted by an agent. */
export function devModeMark(run: DevModeRun, folded: boolean): boolean {
  return run.on && (run.by === 'env' || folded);
}

/** The audit line a folded gate writes: the warning itself, through the log's one sink. */
export function logDevMode(dir: string, command: DevModeCommand, caller: string, warning: string, now?: Date): void {
  logLine(dir, command, caller, warning, now);
}

/**
 * The configuration lines a command owes once: the variable ignored under a governing policy,
 * and every policy source the tool could not read or order. Nothing is written when there is
 * nothing to say. The caller writes these once per command, where the run's folder is known.
 */
export function logDevModeState(dir: string, command: DevModeCommand, caller: string, run: DevModeRun, now?: Date): void {
  if (run.ignored) {
    logLine(dir, command, caller, 'dev-mode: TEAMCLI_DEV_MODE=1 ignored because dev-mode policy is off', now);
  }
  if (run.expired !== null) {
    logLine(dir, command, caller, `dev-mode: expired at ${run.expired.at} for ${run.expired.level}; it is off since`, now);
  }
  for (const refusal of run.refusals) {
    logLine(dir, command, caller, `dev-mode: ${refusal.message}; dev mode is not applied`, now);
  }
}
