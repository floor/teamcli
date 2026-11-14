// The owner charter: one signed document written by `team setup`. It names the project roots,
// the vendors, and the routine operations the owner allows. A later command that sits inside it
// runs with no prompt. A seat that sits outside is refused. The owner is never refused, and
// re-signs only by running
// `team setup --edit`. Nothing in this file signs or reads a key.

import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { canonicalFolder, declaredProjectRoots } from '../entities.ts';

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

/** The charter's default roots, or why there are none to sign. */
export type DefaultRoots = { ok: true; roots: string[] } | { ok: false; why: string };

/** Folders under the home a projects root often is. Named to the owner as a suggestion only: a
 *  folder that happens to exist is never signed as a root on its own. */
const SUGGESTED_NAMES = ['Code', 'Projects', 'src', 'dev', 'Developer', 'repos', 'work', 'code'];

/**
 * The project roots `team setup` signs when the owner names none: the projects root each entity
 * names on this machine (`<entity>.root` in the owner's entities file, src/entities.ts). No folder
 * is guessed — a machine's layout is its own (one keeps an entity's repositories in `~/Code/<entity>`,
 * a server account in `~/repos`, a folder name need not be the repository's) — so a machine whose entities name no root, or one whose root does not read, is
 * refused with the command that sets one and the `--roots` that names them outright. Folders under
 * the home that often hold projects are named in the refusal as suggestions, never signed.
 */
export function defaultProjectRoots(home: string): DefaultRoots {
  const declared = declaredProjectRoots(home);
  if (declared.problems.length > 0) {
    return { ok: false, why: `${declared.problems.join('; ')}: set it again with \`team config set <entity>.root <folder>\`, or name the charter's roots with --roots <dirs>; nothing was written` };
  }
  if (declared.roots.length > 0) return signedRoots(declared.roots.map((one) => one.root), home);
  const found = SUGGESTED_NAMES.map((name) => join(home, name)).filter((path) => existsSync(path));
  const hint = found.length > 0 ? ` (folders found under the home: ${found.join(', ')})` : '';
  return {
    ok: false,
    why: `no entity names a projects root on this machine: set one with \`team config set <entity>.root <folder>\`, or name the charter's roots with --roots <dirs>${hint}; nothing was written`,
  };
}

/**
 * The roots a charter signs, as they are on disk: each one's real path (`canonicalFolder`), so a
 * link cannot widen the signed scope later, and each held to a folder's limits — never the
 * filesystem's root, the home or a folder above it, and never a folder that does not resolve. A
 * root inside another signed root adds nothing and is left out. Refused whole when one does not
 * pass: nothing is signed over a guess.
 */
export function signedRoots(roots: readonly string[], home: string): DefaultRoots {
  const real: string[] = [];
  for (const root of roots) {
    const resolved = canonicalFolder(root, home);
    if (!resolved.ok) return { ok: false, why: `${resolved.why}: a charter root must be a folder that exists, narrower than the home; nothing was written` };
    if (!real.includes(resolved.path)) real.push(resolved.path);
  }
  return { ok: true, roots: real.filter((root) => !real.some((other) => other !== root && pathInsideRoot(other, root))) };
}

/**
 * A signed root bound to what was signed: the root itself while it still resolves to itself, or
 * null when it now resolves elsewhere (a link retargeted since the signature) or does not resolve
 * at all. A root that is null covers nothing.
 */
export function boundRoot(root: string): string | null {
  try {
    const real = realpathSync(root);
    return real === normalize(root).replace(/(.)\/+$/, '$1') ? real : null;
  } catch {
    return null;
  }
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
