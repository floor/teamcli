// The check family's file loader, in one place: `team commits check`, `team pr check` and the
// `team check` alias all read the file's rules through `loadConfig`, and all place a problem the
// same way (`place`). Moved out of `commands/check.ts` when the command split in two, so the alias
// and the two commands share one definition instead of three.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromTeamFile, type CheckConfig } from './config.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Problem } from '../file/types.ts';
import { findStore, readLedger, storePath } from '../store/store.ts';

export type LoadConfig = (
  cwd: string,
  file?: string,
) => { ok: true; config: CheckConfig; warnings: Problem[] } | { ok: false; errors: Problem[]; path?: string };

/** The file's rules, with the ledger of this machine's store when the owner has approved a file here. */
export function loadConfig(cwd: string, file?: string, home: string = homedir()): ReturnType<LoadConfig> {
  const loaded = readTeamConfig(cwd, { file, home, checkOnly: true });
  if (!loaded.ok) return loaded;
  const store = findStore(loaded.root, home) ?? storePath(loaded.team.project, loaded.root, home);
  const ledgerFile = join(store, 'ledger.json');
  try {
    const ledger = readLedger(store);
    return { ok: true, config: fromTeamFile(loaded.team, ledger), warnings: loaded.warnings };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [{ line: 0, message: `can't read ${ledgerFile}: ${detail}` }] };
  }
}

export function place(problem: Problem, path?: string): string {
  const where = [path, problem.line > 0 ? `line ${problem.line}` : ''].filter(Boolean).join(', ');
  return `${where ? `${where}: ` : ''}${problem.message}`;
}
