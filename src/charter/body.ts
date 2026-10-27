// The owner charter: one signed document written by `team setup`. It names the project roots,
// the vendors, and the routine operations the owner allows. A later command that sits inside it
// runs with no prompt. One that sits outside is refused, and the owner re-signs only by running
// `team setup --edit`. Nothing in this file signs or reads a key.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

/** Routine operations the charter can admit. `grant` is included and still cannot carry the
 *  right to grant (`grant_right` is always false). */
export const CHARTER_OPERATIONS = [
  'init', 'import', 'up', 'down', 'add', 'send', 'bus', 'migrate', 'forget', 'approvals', 'remove', 'swap', 'config', 'grant',
] as const;
export type CharterOp = (typeof CHARTER_OPERATIONS)[number];

export type CharterLifetimes = {
  /** Pending owner-seat request. `null` means a request does not expire. */
  request: number | null;
  /** Standing approval rule. `null` means a rule does not expire. */
  rule: number | null;
  /** A grant's longest life, in milliseconds. `null` means a grant may have no end date. */
  grant: number | null;
  /** Unattended runtime notice. `null` means no timed pause. */
  unattended: number | null;
};

export type CharterBody = {
  format: 1;
  roots: string[];
  vendors: 'all' | string[];
  operations: CharterOp[];
  team_creation: boolean;
  grants: boolean;
  renewals: boolean;
  /** Always false. A charter that says true is rejected even when the signature verifies. */
  grant_right: false;
  expires_at: string | null;
  lifetimes: CharterLifetimes;
};

export type SignedCharter = {
  format: 1;
  body: CharterBody;
  signer: string;
  signature: string;
};

export function charterPath(home: string = homedir()): string {
  return join(home, '.config', 'team', 'charter.json');
}

/** Project directories under `home`. The ones that exist, or `~/Code` when none do. */
export function defaultProjectRoots(home: string): string[] {
  const names = ['Code', 'Projects', 'src', 'dev', 'Developer', 'repos', 'work', 'code'];
  const found = names.map((name) => join(home, name)).filter((path) => existsSync(path));
  return found.length > 0 ? found : [join(home, 'Code')];
}

const DEFAULT_LIFETIMES: CharterLifetimes = { request: null, rule: null, grant: null, unattended: null };

/** The charter `team setup` signs when the owner does not narrow it. */
export function defaultCharterBody(roots: readonly string[]): CharterBody {
  return {
    format: 1,
    roots: [...roots],
    vendors: 'all',
    operations: [...CHARTER_OPERATIONS],
    team_creation: true,
    grants: true,
    renewals: true,
    grant_right: false,
    expires_at: null,
    lifetimes: { ...DEFAULT_LIFETIMES },
  };
}

/** Bytes the signature covers. Key order is fixed, so two equal charters hash alike. */
export function canonicalCharter(body: CharterBody): string {
  const lifetimes = {
    request: body.lifetimes.request,
    rule: body.lifetimes.rule,
    grant: body.lifetimes.grant,
    unattended: body.lifetimes.unattended,
  };
  const canonical = {
    format: 1 as const,
    roots: [...body.roots],
    vendors: body.vendors === 'all' ? 'all' : [...body.vendors],
    operations: [...body.operations],
    team_creation: body.team_creation,
    grants: body.grants,
    renewals: body.renewals,
    grant_right: body.grant_right,
    expires_at: body.expires_at,
    lifetimes,
  };
  return JSON.stringify(canonical);
}

export function charterStatement(body: CharterBody): Buffer {
  return Buffer.from(`team-owner-charter-v1\n${canonicalCharter(body)}`, 'utf8');
}

export function charterHash(body: CharterBody): string {
  return createHash('sha256').update(charterStatement(body)).digest('hex');
}

/** `15m`, `30d`, `7d`, `never` / `none`. `undefined` when the word is not a duration. */
export function parseDuration(word: string): number | null | undefined {
  const text = word.trim().toLowerCase();
  if (text === 'never' || text === 'none') return null;
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(text);
  if (match === null) return undefined;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count < 0) return undefined;
  const unit = match[2];
  const scale = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return count * scale;
}

/** Whether `path` is `root` or a folder inside it. Compared as absolute paths. */
export function pathInsideRoot(root: string, path: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return path.startsWith(prefix);
}
