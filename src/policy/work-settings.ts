// How a team works, resolved from the signed policy chain (entity -> project -> team) with the
// team file and the seat on top: where a seat works (`workspace-mode`), how changes land
// (`landing-mode`), where memory lives (`vault-root`), and whether the entity has its own
// orchestrator (`entity-orchestrator`). These are advised settings: they shape the work and the
// rules a seat reads, they never lift a gate or grant a power. A chain that cannot be read or
// verified gives the release defaults, which are today's behaviour.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Mode, TeamFile } from '../file/types.ts';
import { parseYaml, type YamlNode } from '../yaml.ts';
import { resolvePolicyChain, type PolicyChainResult, type ResolvePolicyOptions } from './resolve.ts';
import type { PolicyChainSources } from './resolve.ts';
import type { PolicyLevel } from './types.ts';

export type LandingMode = 'pr-per-change' | 'batch' | 'direct';
export type EntityOrchestrator = 'auto' | 'dedicated' | 'off';
export type SettingFrom = PolicyLevel | 'default' | 'team-file' | 'seat';

export type WorkSettings = {
  workspaceMode: { value: Mode; from: SettingFrom };
  landingMode: { value: LandingMode; from: SettingFrom };
  vaultRoot: { value: string | null; from: SettingFrom };
  entityOrchestrator: { value: EntityOrchestrator; from: SettingFrom };
  /** Why the chain could not be used, when it could not: the values are then the defaults. */
  unreadable?: string;
};

function effective<V>(chain: PolicyChainResult, name: string, fallback: V): { value: V; from: SettingFrom } {
  if (!chain.ok) return { value: fallback, from: 'default' };
  const p = chain.policies[name];
  if (p === undefined) return { value: fallback, from: 'default' };
  return { value: p.value as V, from: p.level };
}

/** Expands a leading `~/` against the home. */
export function expandVaultRoot(value: string, home: string = homedir()): string {
  return value.startsWith('~/') ? join(home, value.slice(2)) : value;
}

/**
 * Resolves the work settings. Precedence for the workspace mode, nearest first: the seat's own
 * `mode`, the team file's `workspace.mode`, the chain's `workspace-mode` (team, then project, then
 * entity), the release default `worktree`. The other settings come from the chain alone.
 */
export function resolveWorkSettings(
  sources: PolicyChainSources,
  declared: { teamMode?: Mode | null; seatMode?: Mode | null } = {},
  options: ResolvePolicyOptions & { home?: string } = {},
): WorkSettings {
  const chain = resolvePolicyChain(sources, { ...options, upToLevel: options.upToLevel ?? 'team' });
  const fromChain = effective<Mode>(chain, 'workspace-mode', 'worktree');
  const workspaceMode = declared.seatMode
    ? { value: declared.seatMode, from: 'seat' as const }
    : declared.teamMode
      ? { value: declared.teamMode, from: 'team-file' as const }
      : fromChain;
  const vault = effective<string>(chain, 'vault-root', '');
  return {
    workspaceMode,
    landingMode: effective<LandingMode>(chain, 'landing-mode', 'batch'),
    vaultRoot: vault.value === '' ? { value: null, from: vault.from } : { value: expandVaultRoot(vault.value, options.home), from: vault.from },
    entityOrchestrator: effective<EntityOrchestrator>(chain, 'entity-orchestrator', 'auto'),
    ...(chain.ok ? {} : { unreadable: chain.refusals.map((r) => r.message).join('; ') }),
  };
}

/** Where a project's memory lives in the vault: `<vault>/projects/<project>/memory`. */
export function memoryFolder(vaultRoot: string, project: string): string {
  return join(vaultRoot, 'projects', project, 'memory');
}

/** Whether the team file's text writes `workspace.mode` itself (a team-level override). */
export function fileDeclaresWorkspaceMode(text: string): boolean {
  let root: YamlNode;
  try {
    root = parseYaml(text);
  } catch {
    return false;
  }
  if (root.kind !== 'map') return false;
  const ws = root.entries.find((e) => e.key === 'workspace')?.value;
  return ws !== undefined && ws.kind === 'map' && ws.entries.some((e) => e.key === 'mode');
}

/** The rule line a seat reads for the landing mode. Review is kept in every mode. */
export function landingRule(mode: LandingMode): string {
  if (mode === 'pr-per-change') return 'Landing: one pull request per change, each reviewed before it merges.';
  if (mode === 'batch') return 'Landing: group related reviewed commits into one pull request per batch; never open a pull request per small change.';
  return 'Landing: once a change is reviewed, land it directly on the integration branch your brief names; no pull request per change.';
}

/** The rule line a seat reads for memory when a vault root is set. */
export function vaultRule(vaultRoot: string, project: string): string {
  return `Memory: keep notes and memory in the docs vault at ${memoryFolder(vaultRoot, project)}, not in your CLI's own session memory.`;
}

export type { TeamFile };
