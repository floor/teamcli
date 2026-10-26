// Retiring a team file once the registry holds the team (`team migrate`): the file is moved to the
// system Trash, where the owner can still take it back, or — when no Trash can be reached — renamed
// beside itself to `.agents/team.yaml.migrated`. It is never deleted outright.

import { existsSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Set to any non-empty value to skip the system Trash and always rename (the test suite does). */
export const NO_SYSTEM_TRASH_ENV = 'TEAM_NO_SYSTEM_TRASH';

export type Retired = { how: 'trash' | 'renamed'; to: string };

/** The command that moves one path to the system Trash on this platform, or null. */
function trashCommand(platform: NodeJS.Platform): [string, string[]] | null {
  if (platform === 'darwin' && existsSync('/usr/bin/trash')) return ['/usr/bin/trash', []];
  if (platform === 'linux') return ['gio', ['trash']];
  return null;
}

/** Moves `path` to the Trash, or renames it to `<path>.migrated` (then `.migrated.2`, ...). */
export function retireTeamFile(
  path: string,
  options: { env?: Record<string, string | undefined>; platform?: NodeJS.Platform } = {},
): Retired {
  const env = options.env ?? process.env;
  const command = env[NO_SYSTEM_TRASH_ENV] ? null : trashCommand(options.platform ?? process.platform);
  if (command !== null) {
    const ran = spawnSync(command[0], [...command[1], path], { stdio: 'ignore', timeout: 15_000 });
    if (ran.status === 0 && !existsSync(path)) return { how: 'trash', to: 'the Trash' };
  }
  let to = `${path}.migrated`;
  for (let n = 2; existsSync(to); n += 1) to = `${path}.migrated.${n}`;
  renameSync(path, to);
  return { how: 'renamed', to };
}
