import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { approvedFingerprints, notInForce } from './approve/approval.ts';
import { compare, describe, fingerprints } from './approve/fingerprint.ts';
import { anotherPaneRefusal, callerOf, callerVerdict, describeCaller, noPaneRefusal, standingOf, type Caller } from './caller.ts';
import { ORDINARY_SECTIONS } from './delegate.ts';
import { devModeFileApproval, type DevModeRun } from './dev_mode.ts';
import { declaredRoots } from './entities.ts';
import { readTeamConfig } from './file/team-config.ts';
import type { GrantScope, LoadResult } from './file/types.ts';
import type { Io } from './io.ts';
import { logLine } from './log.ts';
import { isAgentId, readAgents, type Agent } from './registry/agents.ts';
import { readParsed } from './state.ts';
import { approvalStanding, type Standing } from './store/store.ts';
import { parseYaml, toValue } from './yaml.ts';

/** The registry identity a create-grant names: one agent by its immutable id, or one team by its id. */
export type CreateGrantGrantee =
  | { kind: 'agent'; id: string }
  | { kind: 'team'; id: string };

/**
 * A standing create-grant outside any team file (`~/.config/team/grants/`), naming its holder by
 * a registry identity, the path(s)/entity it covers, and its expiry timestamp.
 */
export type EntityCreateGrant = {
  entity: string | null;
  /** The registry identity the record names; admission matches the caller's registry record only. */
  grantee: CreateGrantGrantee;
  paths: string[];
  expires: string;
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
      // A record replaced under this reader can parse as a torn prefix on the first read: the
      // retry reads the settled file once more, so a transient failure never drops a grant.
      const parsed = readParsed(full, (text) => (entry.endsWith('.json') ? JSON.parse(text) : toValue(parseYaml(text))));
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
 * A record names its holder by a registry identity only — `agent:` an agent id (`agt_` …) or
 * `team:` a team id ({@link createGrantGrantee}); a record spelling a name, a seat, a pane, a
 * session or a runner grants nothing and is skipped. A record covers the paths it names itself,
 * or — when it names an entity and omits them — the roots that entity declares under
 * `~/.config/team/entities.yaml`. A record that names an entity with declared roots may narrow
 * them, never widen them: a path outside them is refused ({@link createGrantPathProblem}), and a
 * record left covering nothing is skipped as an empty one is.
 */
export function readEntityCreateGrants(home: string = homedir()): EntityCreateGrant[] {
  const out: EntityCreateGrant[] = [];
  const rootsByName = declaredRoots(home);
  for (const { record } of readGrantRecords(home)) {
    const named = createGrantGrantee(record);
    if (!named.ok) continue;
    const entity = typeof record.entity === 'string' && record.entity.trim() !== '' ? record.entity.trim() : null;
    let paths: string[] = [];
    if (Array.isArray(record.paths) && record.paths.every((item) => typeof item === 'string' && item.trim() !== '')) {
      paths = (record.paths as string[]).map((item) => item.trim());
    } else if (typeof record.path === 'string' && record.path.trim() !== '') {
      paths = [record.path.trim()];
    } else if (entity !== null) {
      paths = [...(rootsByName.get(entity) ?? [])];
    }
    if (entity !== null) {
      const declared = rootsByName.get(entity);
      if (declared !== undefined) {
        paths = paths.filter((path) => createGrantPathProblem(path, declared, home, entity) === null);
      }
    }
    if (paths.length === 0) continue;
    const rawExpires = record.expires ?? record.expiry ?? record.expires_at ?? record.expiresAt;
    if (typeof rawExpires !== 'string' || rawExpires.trim() === '') continue;
    const expires = rawExpires.trim();
    if (!Number.isFinite(Date.parse(expires))) continue;
    out.push({ entity, grantee: named.grantee, paths, expires });
  }
  return out;
}

/** A team id: twelve lowercase hex digits, the registry's own spelling. */
const TEAM_ID_PATTERN = /^[0-9a-f]{12}$/;

/** The rule every create-grant record obeys, stated once for the reasons below. */
const REGISTRY_IDENTITY_RULE =
  'a create-grant names its holder by registry agent id (`agt_` …) or its team by registry team id, never by a name, a seat, a pane, a session or a runner';

/**
 * The registry identity a record names, or the reason it names none
 * ({@link EntityCreateGrant}). Exactly one grantee is read: `agent:` a registry agent id, or
 * `team:` a registry team id. Any older spelling — `seat:`, `pane:`, `session:`, a
 * `runner`/`runners` entry, or an `agent:` that is a name — is not an identity: the record
 * grants nothing, and `why` says which spelling it used and what the rule is.
 */
export function createGrantGrantee(
  record: Record<string, unknown>,
): { ok: true; grantee: CreateGrantGrantee } | { ok: false; why: string } {
  const spelled = (value: unknown): string => (typeof value === 'string' && value.trim() !== '' ? ` "${value.trim()}"` : '');
  for (const field of ['seat', 'pane', 'session'] as const) {
    if (record[field] === undefined) continue;
    const kind = field === 'session' ? 'a session' : `a ${field}`;
    return { ok: false, why: `the record names ${kind}${spelled(record[field])} in \`${field}\`: ${REGISTRY_IDENTITY_RULE}` };
  }
  for (const field of ['runner', 'runners'] as const) {
    if (record[field] === undefined) continue;
    return { ok: false, why: `the record names a runner process in \`${field}\`: ${REGISTRY_IDENTITY_RULE}` };
  }
  if (record.agent !== undefined && record.team !== undefined) {
    return { ok: false, why: `the record names both \`agent\` and \`team\`: ${REGISTRY_IDENTITY_RULE}` };
  }
  if (record.agent !== undefined) {
    if (typeof record.agent !== 'string' || !isAgentId(record.agent.trim())) {
      return { ok: false, why: `the record names${spelled(record.agent)} in \`agent\`, which is not a registry agent id: ${REGISTRY_IDENTITY_RULE}` };
    }
    return { ok: true, grantee: { kind: 'agent', id: record.agent.trim() } };
  }
  if (record.team !== undefined) {
    if (typeof record.team !== 'string' || !TEAM_ID_PATTERN.test(record.team.trim())) {
      return { ok: false, why: `the record names${spelled(record.team)} in \`team\`, which is not a registry team id: ${REGISTRY_IDENTITY_RULE}` };
    }
    return { ok: true, grantee: { kind: 'team', id: record.team.trim() } };
  }
  return { ok: false, why: `the record names no holder: ${REGISTRY_IDENTITY_RULE}` };
}

/**
 * The registry record of the seat this caller is placed as: the running agent whose reach names
 * the session, pane and seat the walk placed it in, most recently updated when more than one
 * does. The caller is placed in each record's session, as `delegate.ts`'s `findEntry` places
 * it, because a pane id only means something inside the session that lists it — a caller of the
 * same name and pane in another session is not that seat. A caller herdr does not place as a
 * named seat (the owner, an agentless pane, an unplaced process) has no registry record, and no
 * grant admits it.
 */
function callerRegistryAgent(
  home: string,
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
): Agent | null {
  const placed = new Map<string, Caller>();
  let found: Agent | null = null;
  for (const agent of readAgents(home)) {
    if (agent.lifecycle !== 'running') continue;
    let caller = placed.get(agent.reach.session);
    if (caller === undefined) {
      caller = callerOf(io, agent.reach.session);
      placed.set(agent.reach.session, caller);
    }
    if (caller.kind !== 'seat') continue;
    if (caller.session !== agent.reach.session) continue;
    if (caller.pane !== agent.reach.pane) continue;
    if (caller.name !== agent.reach.seat) continue;
    if (!found || agent.provenance.updated_at >= found.provenance.updated_at) found = agent;
  }
  return found;
}

/** Whether the caller's own registry record is the agent the grant names, or belongs to the team it names. */
function grantMatchesCaller(
  grant: EntityCreateGrant,
  home: string,
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
): boolean {
  const agent = callerRegistryAgent(home, io);
  if (agent === null) return false;
  return grant.grantee.kind === 'agent'
    ? grant.grantee.id === agent.id
    : grant.grantee.id === agent.reach.team;
}

function hasDotTraversal(raw: string): boolean {
  return raw.split(/[\\/]/).some((segment) => segment === '.' || segment === '..');
}

/** Whether `child` is `parent` or lies under it, compared by resolved spelling. Shared with the
 *  readers that ask whether a declared root holds a place (`init`'s entity, before any team
 *  file exists). */
export function isSameOrInside(parent: string, child: string): boolean {
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

/**
 * Why a create-grant path is refused, or null when it is admitted. A record that names an
 * entity with declared roots may cover those roots and paths under them, never a path beside
 * them: this is the sentence the reader drops a path with. The comparison is lexical and
 * expands a leading `~` against `home`; the symlink-free walk still runs when a command asks
 * whether a caller is admitted (`pathUnderGranted`).
 */
export function createGrantPathProblem(
  path: string,
  roots: readonly string[],
  home: string,
  entity: string,
): string | null {
  if (path.trim() === '') return 'the path is empty';
  if (!path.startsWith('/') && !path.startsWith('~/')) {
    return `the path "${path}" is neither absolute nor under ~, so ${entity}'s declared roots cannot cover it`;
  }
  if (UNSAFE_PATH_CHARS.test(path) || hasDotTraversal(path)) {
    return `the path "${path}" has a . or .. segment or a pattern character, which ${entity}'s declared roots never cover`;
  }
  const homeResolved = resolve(home);
  const expanded = resolve(path.replace(/^~(?=$|\/)/, homeResolved));
  for (const root of roots) {
    if (!root.startsWith('/') && !root.startsWith('~/')) continue;
    if (UNSAFE_PATH_CHARS.test(root) || hasDotTraversal(root)) continue;
    if (isSameOrInside(resolve(root.replace(/^~(?=$|\/)/, homeResolved)), expanded)) return null;
  }
  return `the path "${path}" is outside ${entity}'s declared roots`;
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
 * team at `root`. Checks the caller's own registry record against the grant's registry identity
 * ({@link grantMatchesCaller}), non-expiry against `now`, and symlink-free containment of both
 * `root` and `cwd` under a granted path.
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
    if (!grantMatchesCaller(grant, home, io)) continue;
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
  | { kind: 'passed'; grant: { session: string; seat: string; scope: GrantScope[] }; devApproval?: string }
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
 *
 * A caller that has resolved dev mode passes `dev`: then a file no verified approval stands
 * for passes this gate for every act but `approve`, and the verdict carries `devApproval`,
 * the warning line the caller prints and logs. Everything after the approval — the grant's
 * presence, the caller's placement, the scope — still refuses.
 */
export function grantGate(input: {
  act: GrantScope;
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources' | 'cwd'>;
  /** Approval store home. Absent: the owner's home, the same default the store uses. */
  home?: string;
  /** The run's dev-mode resolution; when on, the live file counts as approved for non-approve acts. */
  dev?: DevModeRun;
  sources?: GrantSources;
}): GrantVerdict {
  const { act, io, home } = input;
  const sources = input.sources ?? {};
  const refuse = (id: string, text: string): GrantVerdict => ({ kind: 'refused', id: `grant.${id}`, text });

  const loaded = sources.load ? sources.load(io.cwd) : readTeamConfig(io.cwd, { home });
  if (!loaded.ok) {
    return refuse('file', loaded.errors[0]?.message ?? 'the team file can\'t be read');
  }

  const standing = sources.standing ? sources.standing(loaded.root) : approvalStanding(loaded.root, home);
  let devApproval: string | null = null;
  if (standing.kind !== 'verified') {
    const text = `a grant needs a verified approval: ${notInForce(standing)}`;
    // `approve` writes the verified record and reads its fingerprints, so it never runs on a
    // file only dev mode stands behind.
    devApproval = act === 'approve' || input.dev === undefined ? null : devModeFileApproval(input.dev, text, loaded.path);
    if (devApproval === null) return refuse('approval', text);
  }

  const grant = loaded.team.grant;
  if (act === 'approve') {
    // Unreachable: `approve` never folds, so the approval check above already returned. It is
    // spelled again here because the record read needs the narrowed standing.
    if (standing.kind !== 'verified') {
      return refuse('approval', `a grant needs a verified approval: ${notInForce(standing)}`);
    }
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
  return { kind: 'passed', grant, ...(devApproval === null ? {} : { devApproval }) };
}

