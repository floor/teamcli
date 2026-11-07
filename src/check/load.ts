// The check family's file loader, in one place: `team commits check`, `team pr check` and the
// `team check` alias all read the file's rules through `loadConfig`, and all place a problem the
// same way (`place`). Moved out of `commands/check.ts` when the command split in two, so the alias
// and the two commands share one definition instead of three.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromTeamFile, type CheckConfig } from './config.ts';
import { readPolicyFile } from './policy.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Problem } from '../file/types.ts';
import { findStore, mergeLedger, readLedger, storePath } from '../store/store.ts';

export type LoadConfig = (
  cwd: string,
  file?: string,
) => { ok: true; config: CheckConfig; warnings: Problem[] } | { ok: false; errors: Problem[]; path?: string };

/** The file's rules, with the ledger of this machine's store when the owner has approved a file here. */
export function loadConfig(cwd: string, file?: string, home: string = homedir(), options: { ledger?: boolean } = {}): ReturnType<LoadConfig> {
  const policy = file === undefined ? null : readPolicyFile(cwd, file);
  const team = policy === null ? readTeamConfig(cwd, { file, home, checkOnly: true }) : null;
  const loaded = policy ?? (team?.ok ? {
    ok: true as const, root: team.root, project: team.team.project,
    config: fromTeamFile(team.team), warnings: team.warnings,
  } : team!);
  if (!loaded.ok) return loaded;
  // Repository scripts previously read only the declared signers, never this machine's store.
  if (options.ledger === false) return { ok: true, config: loaded.config, warnings: loaded.warnings };
  const store = findStore(loaded.root, home) ?? storePath(loaded.project, loaded.root, home);
  const ledgerFile = join(store, 'ledger.json');
  try {
    const ledger = readLedger(store);
    return { ok: true, config: { ...loaded.config, ledger: mergeLedger(ledger, loaded.config.ledger) }, warnings: loaded.warnings };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [{ line: 0, message: `can't read ${ledgerFile}: ${detail}` }] };
  }
}

export function place(problem: Problem, path?: string): string {
  const where = [path, problem.line > 0 ? `line ${problem.line}` : ''].filter(Boolean).join(', ');
  return `${where ? `${where}: ` : ''}${problem.message}`;
}
