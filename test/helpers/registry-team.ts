// Registry scenes for the writers (phase 3): a fixture's team moved into the registry of the
// scene's own temp home, and the `registry` source for the scene only. Nothing here reads or
// writes the real ~/.config/team: every call names the temp home it was given.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { importTeamFile } from '../../src/file/team-import.ts';
import { readStoredTeamConfig, type StoredTeamConfig } from '../../src/registry/team-config-store.ts';
import { teamIdOf } from '../../src/registry/teams.ts';

/** Moves the checkout's team file into `home`'s registry, as `team migrate` does. */
export function intoRegistry(root: string, home: string): void {
  if (home === homedir() || !home.includes('/')) throw new Error(`a registry scene needs a temp home, not ${home}`);
  const moved = importTeamFile({ cwd: root, home, mode: 'migrate', now: new Date('2026-10-25T12:00:00.000Z') });
  if (!moved.ok) throw new Error(JSON.stringify(moved.errors));
}

/** The team's record in `home`'s registry, or null. */
export function storedTeam(root: string, home: string): StoredTeamConfig | null {
  return readStoredTeamConfig(home, teamIdOf(root));
}

/** Runs `body` under `team-config.source: registry`, then puts the suite's source back. */
export async function underRegistry<T>(body: () => Promise<T> | T): Promise<T> {
  const previous = process.env.TEAM_CONFIG_SOURCE;
  process.env.TEAM_CONFIG_SOURCE = 'registry';
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.TEAM_CONFIG_SOURCE;
    else process.env.TEAM_CONFIG_SOURCE = previous;
  }
}

const REAL_REGISTRY = join(homedir(), '.config', 'team', 'team-config');

/** Every entry of the real registry folder with its size and modification time, or null when
 *  the folder is absent. */
function registryFingerprint(): string | null {
  if (!existsSync(REAL_REGISTRY)) return null;
  return readdirSync(REAL_REGISTRY)
    .sort()
    .map((name) => {
      const stat = statSync(join(REAL_REGISTRY, name));
      return `${name}:${String(stat.size)}:${String(stat.mtimeMs)}`;
    })
    .join('\n');
}

/** The real registry as this test process found it. An owner's machine may already hold one. */
const REAL_REGISTRY_AT_START = registryFingerprint();

/** The real machine's registry folder: a scene that created it, or added, removed or wrote any
 *  record in it, is a broken scene. A registry the machine already held is not a touch. */
export function realRegistryTouched(): boolean {
  return registryFingerprint() !== REAL_REGISTRY_AT_START;
}
