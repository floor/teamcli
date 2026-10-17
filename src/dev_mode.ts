// The dev-mode scope, in one place. Kernel amendment 02 (§2.7, catalogue `dev-mode`): the
// `dev-mode` policy, set at entity, project or team and never at a seat, lifts the "who may run
// it" gate of the eight everyday operations — up, down, remove of an ordinary seat, register,
// add, restart, init and reload — while it is `on` for the caller's level. It lifts only that
// gate: the placement, CLI, record and scope checks stay, and it never reaches `grant`,
// `delegate`, `revoke`, `approve`, `create`, `agree`, `leads` or the machine-wide stop, nor the
// owner's `--abandon` of a seat, nor a delegate's file-editing `add`. `broker` and `tempo` stay
// owner-only in every mode.
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

/** The project a team belongs to, read the way `team check`'s policy pass reads it. */
function projectIdOfTeam(home: string, team: TeamFile | null, root: string | null): string | null {
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
