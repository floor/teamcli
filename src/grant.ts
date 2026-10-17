import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { approvedFingerprints, notInForce } from './approve/approval.ts';
import { compare, describe, fingerprints } from './approve/fingerprint.ts';
import { anotherPaneRefusal, callerAncestors, callerOf, callerVerdict, describeCaller, noPaneRefusal, standingOf } from './caller.ts';
import { ORDINARY_SECTIONS } from './delegate.ts';
import { loadTeamFile } from './file/load.ts';
import type { GrantScope, LoadResult } from './file/types.ts';
import type { Io } from './io.ts';
import { logLine } from './log.ts';
import { approvalStanding, type Standing } from './store/store.ts';
import { parseYaml, toValue } from './yaml.ts';

/** Known entity roots when a create-grant record names an entity and omits `paths`. */
export const ENTITY_PATHS: Readonly<Record<string, readonly string[]>> = {
  radiooooo: ['~/Code/radiooooo', '~/Documents/radio'],
};

/**
 * A standing create-grant outside any team file (`~/.config/team/grants/`), naming the agent
 * it is for, the path(s)/entity it covers, and its expiry timestamp.
 */
export type EntityCreateGrant = {
  entity: string | null;
  agent: string;
  session: string | null;
  paths: string[];
  expires: string;
  /** Process names one of a caller's parent processes may carry for it to be admitted outside herdr; empty when the record names none. */
  runners: string[];
};

const UNSAFE_PATH_CHARS = /[*?[\]{}\x00-\x1f\x7f`]/;

/** The user-level directory holding entity create-grants (`~/.config/team/grants`). */
export function grantsDir(home: string = homedir()): string {
  return join(home, '.config', 'team', 'grants');
}

/**
 * Every record file in the owner's grants folder, with its stem: the read the create-grants and
 * the send-grants share. The folder and every parent up to `home` must be real directories, and
 * each file a plain one — a symbolic link anywhere is skipped rather than followed — and the
 * file must parse to a mapping. What each reader makes of the record's own fields is its own.
 */
export function readGrantRecords(home: string = homedir()): { stem: string; record: Record<string, unknown> }[] {
  const homeResolved = resolve(home);
  for (const dir of [homeResolved, join(homeResolved, '.config'), join(homeResolved, '.config', 'team'), grantsDir(homeResolved)]) {
    try {
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
    } catch {
      return [];
    }
  }
  const folder = grantsDir(homeResolved);
  let entries: string[];
  try {
    entries = readdirSync(folder).sort();
  } catch {
    return [];
  }
  const out: { stem: string; record: Record<string, unknown> }[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.') || !/\.(?:yaml|yml|json)$/.test(entry)) continue;
    const full = join(folder, entry);
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const text = readFileSync(full, 'utf8');
      const parsed = entry.endsWith('.json') ? JSON.parse(text) : toValue(parseYaml(text));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      out.push({ stem: entry.replace(/\.(?:yaml|yml|json)$/, ''), record: parsed as Record<string, unknown> });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Reads valid entity create-grant records from `~/.config/team/grants/`. Symbolic links and
 * malformed records are skipped; expiry and path containment are checked when a command asks.
 */
export function readEntityCreateGrants(home: string = homedir()): EntityCreateGrant[] {
  const out: EntityCreateGrant[] = [];
  for (const { stem, record } of readGrantRecords(home)) {
    const entity =
      typeof record.entity === 'string' && record.entity.trim() !== ''
        ? record.entity.trim()
        : ENTITY_PATHS[stem] !== undefined
          ? stem
          : null;
    const rawAgent =
      typeof record.agent === 'string'
        ? record.agent.trim()
        : typeof record.seat === 'string'
          ? record.seat.trim()
          : typeof record.pane === 'string'
            ? record.pane.trim()
            : '';
    if (!rawAgent) continue;
    let session =
      typeof record.session === 'string' && record.session.trim() !== '' ? record.session.trim() : null;
    let agent = rawAgent;
    if (session === null && rawAgent.includes('/')) {
      const slash = rawAgent.indexOf('/');
      session = rawAgent.slice(0, slash).trim();
      agent = rawAgent.slice(slash + 1).trim();
      if (!session || !agent) continue;
    }
    let paths: string[] = [];
    if (Array.isArray(record.paths) && record.paths.every((item) => typeof item === 'string' && item.trim() !== '')) {
      paths = (record.paths as string[]).map((item) => item.trim());
    } else if (typeof record.path === 'string' && record.path.trim() !== '') {
      paths = [record.path.trim()];
    } else if (entity !== null && ENTITY_PATHS[entity] !== undefined) {
      paths = [...ENTITY_PATHS[entity]!];
    }
    if (paths.length === 0) continue;
    const rawExpires = record.expires ?? record.expiry ?? record.expires_at ?? record.expiresAt;
    if (typeof rawExpires !== 'string' || rawExpires.trim() === '') continue;
    const expires = rawExpires.trim();
    if (!Number.isFinite(Date.parse(expires))) continue;
    out.push({ entity, agent, session, paths, expires, runners: runnersOf(record) });
  }
  return out;
}

/** The record's `runner` (one name) or `runners` (a list of names); anything else names none. */
function runnersOf(record: Record<string, unknown>): string[] {
  if (typeof record.runner === 'string' && record.runner.trim() !== '') return [record.runner.trim()];
  if (Array.isArray(record.runners) && record.runners.length > 0 && record.runners.every((item) => typeof item === 'string' && item.trim() !== '')) {
    return (record.runners as string[]).map((item) => item.trim());
  }
  return [];
}

function grantMatchesCaller(
  grant: EntityCreateGrant,
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
): boolean {
  const caller = grant.session !== null ? callerOf(io, grant.session) : callerOf(io);
  if (grant.session !== null && 'session' in caller && caller.session !== undefined && caller.session !== grant.session) {
    return false;
  }
  if (caller.kind === 'seat') {
    if (grant.session !== null && caller.session !== grant.session) return false;
    return caller.name === grant.agent || caller.pane === grant.agent;
  }
  if (caller.kind === 'pane') {
    return grant.session !== null && caller.session === grant.session && caller.pane === grant.agent;
  }
  // Outside herdr: the holder's own runner, named by a parent process. A caller under herdr, and
  // the owner at a terminal, are never matched this way.
  const outside = caller.kind === 'owner-no-tty' || (caller.kind === 'unplaced' && caller.reason !== 'it runs under herdr');
  if (!outside || grant.runners.length === 0) return false;
  const ancestors = callerAncestors(io);
  if (!ancestors || ancestors.some((process) => process.name === 'herdr')) return false;
  return ancestors.some((process) => grant.runners.includes(process.name));
}

function hasDotTraversal(raw: string): boolean {
  return raw.split(/[\\/]/).some((segment) => segment === '.' || segment === '..');
}

function isSameOrInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function normalizeUnderHome(path: string, homeResolved: string, realHome: string): string {
  if (homeResolved !== realHome && isSameOrInside(homeResolved, path)) {
    return realHome + path.slice(homeResolved.length);
  }
  return path;
}

function walkRealDirectories(fromDir: string, toDir: string): boolean {
  if (!isSameOrInside(fromDir, toDir)) return false;
  try {
    const baseStat = lstatSync(fromDir);
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) return false;
  } catch {
    return false;
  }
  const rel = toDir.slice(fromDir.length).split(sep).filter(Boolean);
  let current = fromDir;
  for (const segment of rel) {
    if (segment === '.' || segment === '..') return false;
    current = current === sep ? `${sep}${segment}` : `${current}${sep}${segment}`;
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function pathUnderGranted(grantedRaw: string, root: string, cwd: string, home: string): boolean {
  if (!grantedRaw || UNSAFE_PATH_CHARS.test(grantedRaw) || hasDotTraversal(grantedRaw)) return false;
  if (!grantedRaw.startsWith('/') && !grantedRaw.startsWith('~/')) return false;
  if (hasDotTraversal(root) || hasDotTraversal(cwd)) return false;

  const homeResolved = resolve(home);
  let realHome: string;
  try {
    const homeStat = lstatSync(homeResolved);
    if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) return false;
    realHome = realpathSync(homeResolved);
  } catch {
    return false;
  }

  const expandedGrant = normalizeUnderHome(
    resolve(grantedRaw.replace(/^~(?=$|\/)/, homeResolved)),
    homeResolved,
    realHome,
  );
  const configTeam = join(realHome, '.config', 'team');
  if (
    expandedGrant === sep ||
    expandedGrant === realHome ||
    isSameOrInside(expandedGrant, realHome) ||
    isSameOrInside(expandedGrant, configTeam) ||
    isSameOrInside(configTeam, expandedGrant)
  ) {
    return false;
  }

  const grantWalkStart = isSameOrInside(realHome, expandedGrant) ? realHome : expandedGrant;
  if (!walkRealDirectories(grantWalkStart, expandedGrant)) return false;

  let realGrant: string;
  try {
    realGrant = realpathSync(expandedGrant);
  } catch {
    return false;
  }
  if (realGrant !== expandedGrant) return false;

  for (const candidate of [root, cwd]) {
    const normalized = normalizeUnderHome(resolve(candidate), homeResolved, realHome);
    if (!walkRealDirectories(realGrant, normalized)) return false;
    let realCandidate: string;
    try {
      realCandidate = realpathSync(normalized);
    } catch {
      return false;
    }
    if (realCandidate !== normalized || !isSameOrInside(realGrant, realCandidate)) return false;
  }

  const normalizedRoot = normalizeUnderHome(resolve(root), homeResolved, realHome);
  for (const sub of [join(normalizedRoot, '.git'), join(normalizedRoot, '.agents'), join(normalizedRoot, '.agents', 'team.yaml')]) {
    try {
      if (lstatSync(sub).isSymbolicLink()) return false;
    } catch {
      // Missing is fine (`init` runs before `.agents/team.yaml` exists); only a link refuses.
    }
  }
  return true;
}

/**
 * Whether an active entity create-grant in `~/.config/team/grants/` admits this caller for a
 * team at `root`. Checks agent identity, non-expiry against `now`, and symlink-free containment
 * of both `root` and `cwd` under a granted path.
 */
export function entityGrantAdmits(
  root: string,
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources' | 'cwd'>,
  options: { home?: string; now?: Date; cwd?: string } = {},
): boolean {
  const home = options.home ?? homedir();
  const nowMs = (options.now ?? new Date()).getTime();
  const cwd = options.cwd ?? io.cwd;
  const grants = readEntityCreateGrants(home);
  if (grants.length === 0) return false;
  for (const grant of grants) {
    const expMs = Date.parse(grant.expires);
    if (!Number.isFinite(expMs) || nowMs >= expMs) continue;
    if (!grantMatchesCaller(grant, io)) continue;
    if (grant.paths.some((entry) => pathUnderGranted(entry, root, cwd, home))) return true;
  }
  return false;
}

/**
 * What `up`, `down`, `approve` and `reload` ask the grant, decided and not yet done. `passed` is the grant the
 * approval in force names. `refused` is the sentence, with no newline; `id` is the exit id
 * a command records when it refuses on this verdict.
 */
export type GrantVerdict =
  | { kind: 'passed'; grant: { session: string; seat: string; scope: GrantScope[] } }
  | { kind: 'refused'; id: string; text: string };

/**
 * The reads a test replaces. Each one left out is the real read: the default team file of
 * `io.cwd` (no `--file`), the approval standing and its stored copy. Placement is `io`,
 * asked about the grant's session, and the pane is the one the state records now.
 */
export type GrantSources = {
  load?: (cwd: string) => LoadResult;
  standing?: (root: string) => Standing;
};

/**
 * The audit line of a granted run, in the same shape as a delegated run's line. `up` and
 * `down` call it when the gate has passed and the run is about to have effects, and not
 * before: a dry run and a refusal write nothing. `approve` calls it in the same function as
 * the store write, after that write, and `detail` is the differences that approval sealed.
 * `reload` calls it in the close, once the re-read has passed and before the workspace is
 * closed, and `detail` names the seat and the difference.
 */
export function logGranted(dir: string, seat: string, act: GrantScope, now?: Date, detail?: string): void {
  logLine(dir, 'grant', 'grant', `${seat} ${act}${detail ? `: ${detail}` : ''}`, now);
}

/**
 * Whether this caller may perform `act` under the grant the live file names.
 * `up`, `down`, `approve` and `reload` call this. It reads the live default file and the approval again on this
 * call: no remembered copy, no `--file`, and no walk of other sessions the state holds.
 * It decides and stops. It does not print, write, or launch.
 *
 * The grant every act trusts is the live file's. A stored copy is not a gate for any act:
 * an edit of `grant` admits the seat the file names now, and a file that differs from the
 * last approval is not a refusal. `approve` still refuses every owner section outside
 * `ORDINARY_SECTIONS`, `grant` included — read from the record's own fingerprints, never
 * from a stored copy.
 */
export function grantGate(input: {
  act: GrantScope;
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources' | 'cwd'>;
  /** Approval store home. Absent: the owner's home, the same default the store uses. */
  home?: string;
  sources?: GrantSources;
}): GrantVerdict {
  const { act, io, home } = input;
  const sources = input.sources ?? {};
  const refuse = (id: string, text: string): GrantVerdict => ({ kind: 'refused', id: `grant.${id}`, text });

  const loaded = sources.load ? sources.load(io.cwd) : loadTeamFile(io.cwd, { home });
  if (!loaded.ok) {
    return refuse('file', loaded.errors[0]?.message ?? 'the team file can\'t be read');
  }

  const standing = sources.standing ? sources.standing(loaded.root) : approvalStanding(loaded.root, home);
  if (standing.kind !== 'verified') {
    return refuse('approval', `a grant needs a verified approval: ${notInForce(standing)}`);
  }

  const grant = loaded.team.grant;
  if (act === 'approve') {
    const differences = compare(approvedFingerprints(standing.record), fingerprints(loaded.team));
    const kept = differences.filter((difference) => difference.kind === 'section' && !ORDINARY_SECTIONS.includes(difference.name));
    if (kept.length > 0) {
      return refuse('not-ordinary', `this change needs the owner: ${kept.map(describe).join('; ')}`);
    }
  }

  if (grant === null) return refuse('omitted', 'the file grants nothing');

  // The placement `add` and `remove` use for a named seat: this session, this name, the pane
  // the state records for it now. The session is the grant's, not a session the caller picks
  // and not one `judgeCallerIn` would walk to.
  const caller = callerOf(io, grant.session);
  const verdict = callerVerdict(caller, grant.seat, standingOf(dirname(loaded.path), grant.session, caller));
  if (verdict.kind === 'no-pane') return refuse('no-pane', noPaneRefusal(verdict.name));
  if (verdict.kind === 'another-pane') return refuse('another-pane', anotherPaneRefusal(verdict.name, verdict.recordedPane));
  if (verdict.kind !== 'ok') {
    return refuse('caller', `only the seat the grant names runs this: this call is ${describeCaller(caller)}`);
  }
  if (!grant.scope.includes(act)) return refuse('scope', `the grant does not list \`${act}\``);
  return { kind: 'passed', grant };
}

