// The `codex-daemon` policy reader (`on | off`, default `on`, at `entity`, `project`, `team`, or
// `seat`): resolves the effective value from the four-level signed policy chain (`entity ->
// project -> team -> seat`) using `readPolicyChain` and `resolvePolicyChain`.
//
// Tightening rule (`244a5e634`):
//   - `off` is a valid opt-out at every level (`lower === 'off' || higher === 'on'`), so a lower
//     level may switch off a daemon that higher levels left on, while a level that turned the
//     daemon `off` cannot be reopened to `on` at a lower level.
//   - Missing context or any unreadable, unverified, or invalid signed policy source in the chain
//     fails closed (`ok: false`, effective `value: 'off'`), so neither launch nor `codex queue`
//     assumes a daemon is permitted when context or a signed policy record is missing or broken.
import { join } from 'node:path';
import { declaredRoots } from '../entities.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { findAgent } from '../registry/agents.ts';
import { get as getProject, ofTeam as projectOfTeam, projectIdOf } from '../registry/projects.ts';
import { teamIdOf } from '../registry/teams.ts';
import { readState } from '../state.ts';
import {
  resolvePolicyChain,
  type EffectivePolicy,
  type PolicyLoadRefusal,
  type ResolvePolicyOptions,
} from './resolve.ts';
import { readPolicyChain } from './sources.ts';
import type { PolicyLevel } from './types.ts';

export const CODEX_DAEMON_POLICY_NAME = 'codex-daemon' as const;

export type CodexDaemonValue = 'on' | 'off';

export type CodexDaemonContext = {
  home?: string;
  root?: string | null;
  /** Optional explicit path to the team file when different from `<root>/.agents/team.yaml`. */
  teamFile?: string | null;
  team?: TeamFile | null;
  entity?: string | null;
  projectId?: string | null;
  seat?: string | Seat | null;
  agentId?: string | null;
  session?: string | null;
  now?: Date;
  upToLevel?: PolicyLevel;
};

export type CodexDaemonResolution =
  | {
      ok: true;
      value: CodexDaemonValue;
      level: PolicyLevel | 'default';
      effective: EffectivePolicy<CodexDaemonValue>;
      refusals: PolicyLoadRefusal[];
    }
  | {
      ok: false;
      /** Fail-closed value when required context is missing or any policy source in the chain is unreadable or invalid. */
      value: 'off';
      why: string;
      refusals: PolicyLoadRefusal[];
    };

function resolveProjectId(home: string, root: string | null, team: TeamFile): string | null {
  if (root) {
    try {
      const fromRegistry = projectOfTeam(home, teamIdOf(root));
      if (fromRegistry?.id) return fromRegistry.id;
    } catch {
      // Fall back to team file project fields when registry is unreadable or ambiguous.
    }
  }
  if (team.inProject) {
    try {
      return projectIdOf(team.inProject);
    } catch {
      return null;
    }
  }
  try {
    return projectIdOf(team.project);
  } catch {
    return null;
  }
}

function entityFromDeclaredRoots(home: string, root: string | null): string | null {
  if (!root) return null;
  for (const [candidateEntity, roots] of declaredRoots(home)) {
    if (roots.some((r) => root === r || root.startsWith(r.endsWith('/') ? r : `${r}/`))) {
      return candidateEntity;
    }
  }
  return null;
}

function findAgentIdForSeat(
  home: string,
  root: string | null,
  seatName: string | null,
  session: string | null,
): string | null {
  if (!seatName || !root) return null;
  let seatHandle: string | null = null;
  if (session) {
    try {
      seatHandle = readState(join(root, '.agents')).sessions[session]?.seats[seatName]?.id ?? null;
    } catch {
      seatHandle = null;
    }
  }
  return (
    findAgent(home, {
      team: teamIdOf(root),
      seat: seatName,
      seatHandle,
    })?.id ?? null
  );
}

/**
 * Resolves `codex-daemon` (`on | off`, default `on`) across `entity -> project -> team -> seat`
 * using shared `readPolicyChain` and `resolvePolicyChain`.
 *
 * Requires resolved `home` and `root` or `team` context; fails closed (`{ ok: false, value: 'off', ... }`)
 * when required context is missing or when any signed policy source in the chain cannot be read,
 * verified, or ordered.
 */
export function resolveCodexDaemonPolicy(context: CodexDaemonContext = {}): CodexDaemonResolution {
  const home = typeof context.home === 'string' && context.home.trim() !== '' ? context.home.trim() : null;
  const root = typeof context.root === 'string' && context.root.trim() !== '' ? context.root.trim() : null;
  const now = context.now ?? new Date();

  if (home === null || (root === null && !context.team)) {
    return {
      ok: false,
      value: 'off',
      why: 'missing team root or home context for codex-daemon policy resolution',
      refusals: [],
    };
  }

  let team: TeamFile | null = context.team ?? null;
  if (team === null && root !== null) {
    try {
      const loaded = readTeamConfig(root, {
        home,
        checkOnly: true,
        ...(context.teamFile ? { file: context.teamFile } : {}),
      });
      if (!loaded.ok) {
        return {
          ok: false,
          value: 'off',
          why: loaded.errors.map((e) => e.message).join('; ') || 'team config could not be read',
          refusals: [],
        };
      }
      team = loaded.team;
    } catch (error) {
      return {
        ok: false,
        value: 'off',
        why: error instanceof Error ? error.message : String(error),
        refusals: [],
      };
    }
  }
  if (team === null) {
    return {
      ok: false,
      value: 'off',
      why: 'missing team context for codex-daemon policy resolution',
      refusals: [],
    };
  }

  const projectId =
    context.projectId !== undefined ? context.projectId : resolveProjectId(home, root, team);

  let entity = context.entity !== undefined ? context.entity : (team.entity ?? null);
  if (entity === null && projectId) {
    try {
      entity = getProject(home, projectId)?.entity ?? null;
    } catch {
      entity = null;
    }
  }
  if (entity === null) {
    entity = entityFromDeclaredRoots(home, root);
  }

  const seatName =
    typeof context.seat === 'string' ? context.seat : (context.seat?.name ?? null);
  const seatObj: Seat | null =
    typeof context.seat === 'object' && context.seat !== null
      ? context.seat
      : (seatName ? (team.seats.find((s) => s.name === seatName) ?? null) : null);
  const session = context.session ?? team.session ?? null;
  const agentId =
    context.agentId !== undefined
      ? context.agentId
      : findAgentIdForSeat(home, root, seatName, session);

  const upToLevel: PolicyLevel =
    context.upToLevel ?? (seatName !== null || agentId !== null || seatObj !== null ? 'seat' : 'team');
  const options: ResolvePolicyOptions = { now, upToLevel };

  const sources = readPolicyChain({
    home,
    entity,
    projectId,
    teamRoot: root,
    team,
    agentId,
    seat: seatObj,
  });

  const chain = resolvePolicyChain(sources, options);
  if (!chain.ok) {
    return {
      ok: false,
      value: 'off',
      why: chain.refusals.map((r) => r.message).join('; '),
      refusals: chain.refusals,
    };
  }

  const effective = chain.policies[CODEX_DAEMON_POLICY_NAME] as EffectivePolicy<CodexDaemonValue> | undefined;
  if (!effective) {
    return {
      ok: false,
      value: 'off',
      why: 'codex-daemon policy is missing from the resolved policy catalogue',
      refusals: [],
    };
  }

  return {
    ok: true,
    value: effective.value === 'off' ? 'off' : 'on',
    level: effective.level,
    effective,
    refusals: [],
  };
}

/**
 * Convenience fail-closed reader returning the effective `codex-daemon` setting (`'on' | 'off'`).
 * Missing context or any unreadable/invalid signed policy source in the chain fails closed to `'off'`.
 */
export function codexDaemonForSeat(context: CodexDaemonContext = {}): CodexDaemonValue {
  const resolved = resolveCodexDaemonPolicy(context);
  return resolved.ok ? resolved.value : 'off';
}
