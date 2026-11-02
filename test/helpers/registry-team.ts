// Registry scenes for the writers (phase 3): a fixture's team moved into the registry of the
// scene's own temp home, and the `registry` source for the scene only. Nothing here reads or
// writes the real ~/.config/team: every call names the temp home it was given.
import { mkdirSync, readFileSync, renameSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { importTeamFile } from '../../src/file/team-import.ts';
import { readStoredTeamConfig, teamConfigDir, type StoredTeamConfig } from '../../src/registry/team-config-store.ts';
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

/**
 * Makes the scene's registry record folder unreadable without chmod and without touching a real
 * path: the fixture's own folder is moved aside, and a mode-000 folder takes its place. The held
 * record stays readable through `heldRecord`; `restore` puts the original folder back.
 *
 * Measured on this host with Bun 1.4.2, inside the mode-000 folder: `existsSync` of an entry is
 * false, `readFileSync` throws `EACCES: permission denied`, the empty folder removes with
 * `rmdirSync`, and the fixture base still cleans up with `rmSync(..., { recursive: true })`.
 */
export function unreadableRegistryFolder(home: string): {
  path: string;
  heldRecord: (id: string) => string;
  restore: () => void;
} {
  const path = teamConfigDir(home);
  const held = `${path}.held`;
  renameSync(path, held);
  mkdirSync(path, { mode: 0o000 });
  return {
    path,
    heldRecord: (id) => readFileSync(join(held, `${id}.json`), 'utf8'),
    restore: () => {
      rmdirSync(path);
      renameSync(held, path);
    },
  };
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

export { realRegistryTouched } from './real-registry.ts';
