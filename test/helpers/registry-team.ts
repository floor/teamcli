// Registry scenes for the writers (phase 3): a fixture's team moved into the registry of the
// scene's own temp home, and the `registry` source for the scene only. Nothing here reads or
// writes the real ~/.config/team: every call names the temp home it was given.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
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

/** The real machine's registry folder: a scene that wrote there is a broken scene. */
export function realRegistryTouched(): boolean {
  return existsSync(join(homedir(), '.config', 'team', 'team-config'));
}
