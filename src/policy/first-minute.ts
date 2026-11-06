// The first-minute policies. `pretrust` decides whether a start folder is written into a CLI
// trust record this build has already captured. The write never types a key, and it never
// answers a folder dialog: that switch stays with the owner.
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { TeamFile } from '../file/types.ts';
import { loadAndResolvePolicyChain } from './sources.ts';

/** CLIs whose trust record this build has captured. Any other CLI is a guess, and a guess is
 *  never written. */
export const CAPTURED_TRUST_CLIS = ['grok', 'cursor', 'claude-code', 'codex'] as const;

export type PretrustMode = 'off' | 'project';

/** Why a captured trust write is refused, or `ok` when the policy allows one. `off` is the
 *  policy. `guessed` is a CLI whose record was never captured. */
export function pretrustDecision(cli: string, mode: PretrustMode): 'off' | 'guessed' | 'ok' {
  if (mode === 'off') return 'off';
  if (!(CAPTURED_TRUST_CLIS as readonly string[]).includes(cli)) return 'guessed';
  return 'ok';
}

/** The `pretrust` word in force. An unreadable chain is `off`: a chain that cannot be read
 *  does not write a trust record. */
export function pretrustModeOf(input: {
  home: string;
  entity: string | null;
  teamRoot: string;
  team: TeamFile;
  now: Date;
}): PretrustMode {
  const resolved = loadAndResolvePolicyChain(
    { home: input.home, entity: input.entity, teamRoot: input.teamRoot, team: input.team },
    { now: input.now, upToLevel: 'team' },
  );
  if (!resolved.ok) return 'off';
  return resolved.policies.pretrust?.value === 'off' ? 'off' : 'project';
}

/** Whether `folder` is the project root or a real path inside it. Home, a parent of the root,
 *  and any path that walks through a symbolic link are outside. */
export function pathInsideRoot(folder: string, root: string, home: string): boolean {
  let realFolder: string;
  let realRoot: string;
  let realHome: string;
  try {
    realFolder = realpathSync(folder);
    realRoot = realpathSync(root);
    realHome = realpathSync(home);
  } catch {
    return false;
  }
  if (realFolder === realHome) return false;
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (realFolder !== realRoot && !realFolder.startsWith(prefix)) return false;
  let current = resolve(folder);
  const stop = resolve(root);
  while (current === stop || current.startsWith(stop.endsWith(sep) ? stop : stop + sep)) {
    try {
      if (lstatSync(current).isSymbolicLink()) return false;
    } catch {
      return false;
    }
    if (current === stop) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}
