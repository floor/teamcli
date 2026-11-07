// The first-minute policies. `pretrust` decides whether a start folder is written into a CLI
// trust record this build has already captured. `first-run-admission` opens once, only when
// every durable record is absent, and writes one create-grant for the lead. Neither path types
// a key, answers a folder dialog, or edits a record with `team config`.
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createStateFile, ensureStateDirectory, stateFileStat } from '../file-write.ts';
import { charterPath } from '../charter/body.ts';
import type { TeamFile } from '../file/types.ts';
import { grantsDir } from '../grant.ts';
import { keyOf } from '../store/keys.ts';
import { loadAndResolvePolicyChain } from './sources.ts';

/** CLIs whose trust record this build has captured. Any other CLI is a guess, and a guess is
 *  never written. */
export const CAPTURED_TRUST_CLIS = ['grok', 'cursor', 'claude-code', 'codex'] as const;

export type PretrustMode = 'off' | 'project';

export type AdmissionMode = 'off' | 'empty-account';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEAM_ID = /^[0-9a-f]{12}$/;

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

/** The owner record this door writes. Its presence means the one pass has already run. */
export function ownerRecordPath(home: string): string {
  return join(home, '.config', 'team', 'owner.json');
}

/** The `first-run-admission` word in force. An unreadable chain is `off`. */
export function admissionModeOf(input: {
  home: string;
  entity: string | null;
  teamRoot: string;
  team: TeamFile;
  now: Date;
}): AdmissionMode {
  const resolved = loadAndResolvePolicyChain(
    { home: input.home, entity: input.entity, teamRoot: input.teamRoot, team: input.team },
    { now: input.now, upToLevel: 'team' },
  );
  if (!resolved.ok) return 'off';
  return resolved.policies['first-run-admission']?.value === 'off' ? 'off' : 'empty-account';
}

type AccountState = 'empty' | 'owner' | 'record';
function entryPresent(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** `owner` once this door has written the owner record. `record` when any other durable
 *  record is already there: the registries, the charter, a key, a signer, or a grant. */
function accountState(home: string): AccountState {
  if (entryPresent(ownerRecordPath(home))) return 'owner';
  const present = [
    join(home, '.config', 'team', 'teams.yaml'),
    join(home, '.config', 'team', 'projects.yaml'),
    join(home, '.config', 'team', 'entities.yaml'),
    charterPath(home),
    join(home, '.config', 'team', 'signers'),
    join(home, '.config', 'team-key', 'key.json'),
    join(home, '.config', 'team-key', 'messages.json'),
    grantsDir(home),
  ];
  return present.some((path) => entryPresent(path)) ? 'record' : 'empty';
}

export type AdmissionResult =
  | { ok: true; expires: string }
  | { ok: false; reason: 'off' | 'non-empty' | 'second-pass' };

/** One empty-account pass. Writes the owner record with assurance `none`, mints the approval
 *  key, and writes one create-grant for `teamId` scoped to `root` that expires 24 hours later.
 *  A second call finds the owner record and admits nothing. The grant carries no folder-dialog
 *  switch. */
export function firstRunAdmission(input: {
  home: string;
  mode: AdmissionMode;
  now: Date;
  teamId: string;
  root: string;
}): AdmissionResult {
  if (input.mode === 'off') return { ok: false, reason: 'off' };
  const state = accountState(input.home);
  if (state === 'owner') return { ok: false, reason: 'second-pass' };
  if (state === 'record') return { ok: false, reason: 'non-empty' };
  if (!TEAM_ID.test(input.teamId) || !isAbsolute(input.root)) {
    throw new Error('a create-grant names a team id and an absolute root');
  }
  const expires = new Date(input.now.getTime() + DAY_MS).toISOString();
  const ownerDir = join(input.home, '.config', 'team');
  const owner = ownerRecordPath(input.home);
  const folder = grantsDir(input.home);
  const grant = join(folder, 'lead.json');
  ensureStateDirectory(ownerDir, input.home);
  ensureStateDirectory(folder, input.home);
  // Check both destinations before minting any owner record or key.
  if (stateFileStat(owner, input.home) !== null) return { ok: false, reason: 'second-pass' };
  if (stateFileStat(grant, input.home) !== null) return { ok: false, reason: 'non-empty' };
  createStateFile(owner, `${JSON.stringify({ assurance: 'none', at: input.now.toISOString() }, null, 2)}\n`, input.home);
  keyOf(input.home);
  createStateFile(grant, `${JSON.stringify({ team: input.teamId, paths: [input.root], expires }, null, 2)}\n`, input.home);
  return { ok: true, expires };
}
