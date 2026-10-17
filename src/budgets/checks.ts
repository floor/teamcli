// A `check` command is resolved and hashed at approval. The hash is of the named
// file only. team never reads what that file imports, and never logs its bytes.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { TeamFile } from '../file/types.ts';

export type ApprovedCheck = {
  command: string;
  path: string;
  hash: string;
};

/** The accounts `budgets` names a check for. Callers hand in the section in force (RFC 0003 § 5). */
export function checkCommands(budgets: TeamFile['budgets']): { account: string; command: string }[] {
  return Object.entries(budgets.accounts)
    .filter((entry): entry is [string, typeof entry[1] & { check: string }] => entry[1].check !== null)
    .map(([account, accountBudget]) => ({ account, command: accountBudget.check }));
}

/** The file a command names, and its sha256. Null when it cannot be resolved. */
export function resolveCheck(command: string, root: string, pathEnv: string): { path: string; hash: string } | null {
  const path = command.includes('/')
    ? (isAbsolute(command) ? command : resolve(root, command))
    : pathEnv.split(':').filter((dir) => dir && isAbsolute(dir)).map((dir) => join(dir, command)).find((file) => executable(file)) ?? '';
  if (!path || !executable(path)) return null;
  return { path, hash: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

export function resolveChecks(
  team: TeamFile,
  root: string,
  pathEnv: string,
): { ok: true; checks: Record<string, ApprovedCheck> } | { ok: false; account: string; command: string } {
  const checks: Record<string, ApprovedCheck> = {};
  for (const { account, command } of checkCommands(team.budgets)) {
    const found = resolveCheck(command, root, pathEnv);
    if (!found) return { ok: false, account, command };
    checks[account] = { command, path: found.path, hash: found.hash };
  }
  return { ok: true, checks };
}

export type CheckReading = { account: string; state: 'approved' | 'unknown' };

/**
 * Whether each account's check may be run. The stored absolute path is hashed
 * again; PATH is not consulted. A missing or changed file reads unknown.
 */
export function checkReadings(budgets: TeamFile['budgets'], approved: Record<string, ApprovedCheck> | undefined): CheckReading[] {
  return checkCommands(budgets).map(({ account }) => {
    const known = approved?.[account];
    if (!known || hashOf(known.path) !== known.hash) return { account, state: 'unknown' };
    return { account, state: 'approved' };
  });
}

/** Lines for a resolved command whose path or hash is not the one the approval recorded. */
export function checkDrift(approved: Record<string, ApprovedCheck> | undefined, current: Record<string, ApprovedCheck>): string[] {
  const lines: string[] = [];
  const previous = approved ?? {};
  for (const [account, check] of Object.entries(current)) {
    const known = previous[account];
    if (!known || known.command !== check.command || known.path !== check.path || known.hash !== check.hash) {
      lines.push(`the check for ${account} changed`);
    }
  }
  for (const account of Object.keys(previous)) {
    if (!current[account]) lines.push(`the check for ${account} changed`);
  }
  return lines;
}

function hashOf(file: string): string | null {
  try {
    if (!statSync(file).isFile()) return null;
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function executable(file: string): boolean {
  try {
    const stat = statSync(file);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
