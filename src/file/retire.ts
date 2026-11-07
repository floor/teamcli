// Retiring a team file once the registry holds the team (`team migrate`): the file is moved to the
// system Trash, where the owner can still take it back, or — when no Trash can be reached — into
// the team's runtime trash, a dated folder `runtime/trash/<date>`. It is never deleted outright.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { parkInRuntimeTrash, runtimeTrashEmptyLine } from './runtime-trash.ts';

/** Set to any non-empty value to skip the system Trash and park in the runtime trash (the test suite does). */
export const NO_SYSTEM_TRASH_ENV = 'TEAM_NO_SYSTEM_TRASH';

export type Retired = { how: 'trash' | 'parked'; to: string; empty?: string };

/** The command that moves one path to the system Trash on this platform, or null. */
function trashCommand(platform: NodeJS.Platform): [string, string[]] | null {
  if (platform === 'darwin' && existsSync('/usr/bin/trash')) return ['/usr/bin/trash', []];
  if (platform === 'linux') return ['gio', ['trash']];
  return null;
}

/** Moves `path` to the Trash, or into the dated runtime trash when no Trash can be reached.
 *  `trashCommand: null` is the scene seam for a machine with no trash binary: nothing is spawned. */
export function retireTeamFile(
  path: string,
  options: {
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    home?: string;
    now?: Date;
    trashCommand?: [string, string[]] | null;
  } = {},
): Retired {
  const env = options.env ?? process.env;
  const command = options.trashCommand !== undefined
    ? options.trashCommand
    : (env[NO_SYSTEM_TRASH_ENV] ? null : trashCommand(options.platform ?? process.platform));
  if (command !== null) {
    const ran = spawnSync(command[0], [...command[1], path], { stdio: 'ignore', timeout: 15_000 });
    if (ran.status === 0 && !existsSync(path)) return { how: 'trash', to: 'the Trash' };
  }
  const parked = parkInRuntimeTrash(path, options.home ?? homedir(), options.now ?? new Date());
  return { how: 'parked', to: parked.to, empty: runtimeTrashEmptyLine(parked.dated) };
}
