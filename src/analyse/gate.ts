// Project analysis gate (`src/analyse/gate.ts`): verifies before any target content read,
// directory listing or `git` call that an owner-signed analyser is named in the
// owner's configuration (`projects.yaml`, `entities.yaml`, or `settings.yaml`) with non-empty
// signed read roots covering `<path>`, that the caller is the owner at a terminal or the named
// analyser seat, and that a `scope: public` analyser is refused on a non-public project (unless
// a signed public visibility fact is present) before any project byte is read. No `analyse`
// capability word or grant verb exists.

import type { KeyObject } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { callerOf, callerStanding, isOwner, standingOf, walkCaller, type Caller } from '../caller.ts';
import { CONFIG_DOMAIN } from '../config/record.ts';
import { entitiesPath } from '../entities.ts';
import type { Io } from '../io.ts';
import { readAgents } from '../registry/agents.ts';
import { projectsFile } from '../registry/projects.ts';
import { findTeams, teamIdOf } from '../registry/teams.ts';
import { seatAgent } from '../send/resolve.ts';
import { machineSettingsPath } from '../settings/declared.ts';
import { keyOf, keyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { parseYaml, toValue, type YamlValue } from '../yaml.ts';

export type AnalyserScope = 'full' | 'public';

export type AnalyserIdentity = {
  principal: string;
  authorized_by: 'owner';
  scope: AnalyserScope;
};

export type AnalysisSourceKind = 'teamcli' | 'tool' | 'tracker' | 'lab';
export type AnalysisSourceLevel = 'default' | 'machine' | 'entity' | 'project';

export type AnalysisSource = {
  name: string;
  kind: AnalysisSourceKind;
  level: AnalysisSourceLevel;
};

export const DEFAULT_ANALYSIS_SOURCE: AnalysisSource = {
  name: 'teamcli.static',
  kind: 'teamcli',
  level: 'default',
};

export type AnalyseGateSources = {
  home?: string;
  caller?: Caller;
  /** Optional pre-read visibility from registry/test harness (never reads target files). */
  visibility?: (targetPath: string) => 'public' | 'private' | 'not known';
};

export type AnalyseGateVerdict =
  | {
      ok: true;
      analyser: AnalyserIdentity;
      source: AnalysisSource;
      /** The canonical signed root that governed selection, checked again by the reader. */
      scopeRoot?: string;
      /** The target identity used to select that analyser; an alias may not retarget the read. */
      canonicalTarget?: string;
      visibilityHint?: 'public' | 'private';
    }
  | {
      ok: false;
      code: 'analyse.unauthorised' | 'analyse.scope';
      why: string;
    };

export type SignedAnalyserEntry = {
  value: YamlValue;
  setter: 'owner';
  date: string;
  target: string;
  generation: number;
  signature: string;
};

type ParsedAnalyserConfig = {
  analyser: AnalyserIdentity;
  roots: string[];
  visibility?: 'public' | 'private';
  source?: AnalysisSource;
};

function isRecord(value: unknown): value is Record<string, YamlValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expandHome(rawPath: string, home: string): string {
  if (rawPath === '~') return home;
  if (rawPath.startsWith('~/')) return join(home, rawPath.slice(2));
  return resolve(home, rawPath);
}

/** Resolve existing ancestors even when the leaf is absent. This preserves signed scope and
 *  public-only refusals for missing targets; the reader still refuses an absent target before
 *  listing or reading anything. Errors other than absence cannot supply a policy identity. */
function canonicalPolicyPath(path: string): string {
  const suffix: string[] = [];
  let ancestor = path;
  for (;;) {
    try {
      return resolve(realpathSync(ancestor), ...suffix);
    } catch (error) {
      const parent = dirname(ancestor);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

/** Most-specific signed root by canonical identity, never by an alias's lexical length. */
function bestMatchingRoot(targetAbs: string, roots: readonly string[], home: string): string | null {
  let best: string | null = null;
  for (const rootPath of roots) {
    const resolvedRoot = canonicalPolicyPath(expandHome(rootPath, home));
    const rel = relative(resolvedRoot, targetAbs);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      if (best === null || resolvedRoot.length > best.length) best = resolvedRoot;
    }
  }
  return best;
}

function isValidAnalyserPrincipal(principal: string): boolean {
  if (principal === 'owner') return true;
  const atIndex = principal.indexOf('@');
  if (atIndex <= 0) return false;
  if (principal.indexOf('@', atIndex + 1) !== -1) return false;
  const seat = principal.slice(0, atIndex).trim();
  const team = principal.slice(atIndex + 1).trim();
  return seat !== '' && team !== '';
}

function parseSourceNode(
  raw: YamlValue | undefined,
  level: AnalysisSourceLevel,
): AnalysisSource | undefined {
  if (typeof raw === 'string' && raw.trim() !== '') {
    const name = raw.trim();
    const kind: AnalysisSourceKind = name.startsWith('teamcli')
      ? 'teamcli'
      : name.startsWith('tracker')
        ? 'tracker'
        : name.startsWith('lab')
          ? 'lab'
          : 'tool';
    return { name, kind, level };
  }
  if (!isRecord(raw)) return undefined;
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : 'teamcli.static';
  const rawKind = typeof raw.kind === 'string' ? raw.kind.trim() : 'teamcli';
  const kind: AnalysisSourceKind =
    rawKind === 'teamcli' || rawKind === 'tool' || rawKind === 'tracker' || rawKind === 'lab'
      ? rawKind
      : 'teamcli';
  return { name, kind, level };
}

/**
 * Construct an owner-signed setting entry under `CONFIG_DOMAIN` for `analyser`, `roots`, or `visibility`.
 */
export function signAnalyserSetting(
  home: string,
  level: 'entity' | 'project' | 'machine',
  target: string,
  value: YamlValue,
  opts: { key?: string; signingKey?: KeyObject; date?: string; generation?: number } = {},
): SignedAnalyserEntry {
  const signingKey = opts.signingKey ?? keyOf(home);
  const settingKey = opts.key ?? 'analyser';
  const date = opts.date ?? '2026-11-05T00:00:00Z';
  const generation = opts.generation ?? 1;
  const payload: Json = {
    key: settingKey,
    value: (value ?? null) as Json,
    level,
    target,
    setter: 'owner',
    date,
    generation,
  };
  const signature = signDomain(CONFIG_DOMAIN, payload, signingKey);
  return {
    value,
    setter: 'owner',
    date,
    target,
    generation,
    signature,
  };
}

/**
 * Verify an owner-signed setting entry under `CONFIG_DOMAIN`.
 * Refuses any unsigned string, unsigned map, missing field, wrong target, or invalid signature.
 */
function verifySignedSetting(
  home: string,
  settingKey: string,
  level: 'entity' | 'project' | 'machine',
  target: string,
  entry: YamlValue,
): { ok: true; value: YamlValue } | { ok: false; why: string } {
  if (!isRecord(entry) || typeof entry.signature !== 'string' || entry.signature.trim() === '') {
    return {
      ok: false,
      why: `${settingKey} setting for ${level} "${target}" is not signed by the owner`,
    };
  }
  if (
    entry.setter !== 'owner' ||
    typeof entry.target !== 'string' ||
    entry.target !== target ||
    typeof entry.date !== 'string' ||
    !Number.isFinite(Date.parse(entry.date)) ||
    typeof entry.generation !== 'number' ||
    !Number.isInteger(entry.generation) ||
    entry.generation < 1 ||
    entry.value === undefined ||
    entry.value === null
  ) {
    return {
      ok: false,
      why: `${settingKey} setting for ${level} "${target}" is missing required owner-signed fields`,
    };
  }
  const state = keyState(home);
  if (state.kind !== 'key') {
    return {
      ok: false,
      why: `owner signing key is not available (${state.kind}) to verify ${settingKey} setting`,
    };
  }
  const payload: Json = {
    key: settingKey,
    value: (entry.value ?? null) as Json,
    level,
    target: entry.target,
    setter: entry.setter,
    date: entry.date,
    generation: entry.generation,
  };
  if (!verifyDomain(CONFIG_DOMAIN, payload, entry.signature, state.key)) {
    return {
      ok: false,
      why: `${settingKey} setting signature for ${level} "${target}" is invalid`,
    };
  }
  return { ok: true, value: entry.value ?? null };
}

function parseAnalyserValue(
  raw: YamlValue | undefined,
  defaultRoots: string[],
  level: AnalysisSourceLevel,
  levelVisibility?: 'public' | 'private',
  levelSource?: AnalysisSource,
): ParsedAnalyserConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    const principal = raw.trim();
    if (!principal || !isValidAnalyserPrincipal(principal)) return null;
    return {
      analyser: { principal, authorized_by: 'owner', scope: 'full' },
      roots: [...defaultRoots],
      ...(levelVisibility !== undefined ? { visibility: levelVisibility } : {}),
      ...(levelSource !== undefined ? { source: levelSource } : {}),
    };
  }
  if (!isRecord(raw)) return null;
  const rawPrincipal = raw.principal ?? raw.seat ?? raw.agent ?? raw.name;
  if (typeof rawPrincipal !== 'string' || rawPrincipal.trim() === '') return null;
  const principal = rawPrincipal.trim();
  if (!isValidAnalyserPrincipal(principal)) return null;
  const rawScope = typeof raw.scope === 'string' ? raw.scope.trim() : 'full';
  if (rawScope !== 'full' && rawScope !== 'public') return null;
  const roots: string[] = [];
  if (Array.isArray(raw.roots)) {
    for (const item of raw.roots) {
      if (typeof item === 'string' && item.trim() !== '') roots.push(item.trim());
    }
  } else {
    roots.push(...defaultRoots);
  }
  const vis =
    raw.visibility === 'public' || raw.public === true
      ? 'public'
      : raw.visibility === 'private' || raw.public === false
        ? 'private'
        : levelVisibility;
  const src = parseSourceNode(raw.source, level) ?? levelSource;
  return {
    analyser: { principal, authorized_by: 'owner', scope: rawScope },
    roots,
    ...(vis !== undefined ? { visibility: vis } : {}),
    ...(src !== undefined ? { source: src } : {}),
  };
}

function readYamlMap(path: string): Record<string, YamlValue> | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  try {
    const val = toValue(parseYaml(text));
    return isRecord(val) ? val : null;
  } catch {
    return null;
  }
}

function extractSignedRoots(
  home: string,
  level: 'machine' | 'entity' | 'project',
  target: string,
  record: Record<string, YamlValue>,
): { ok: true; roots: string[] } | { ok: false; why: string } {
  const rawRoots =
    record.roots !== undefined
      ? record.roots
      : isRecord(record.settings)
        ? record.settings.roots
        : undefined;
  if (rawRoots === undefined) return { ok: true, roots: [] };
  if (!isRecord(rawRoots)) {
    // Unsigned roots array on the record is never trusted for analyser read scope.
    return { ok: true, roots: [] };
  }
  const verified = verifySignedSetting(home, 'roots', level, target, rawRoots);
  if (!verified.ok) return verified;
  const roots: string[] = [];
  if (Array.isArray(verified.value)) {
    for (const item of verified.value) {
      if (typeof item === 'string' && item.trim() !== '') roots.push(item.trim());
    }
  }
  return { ok: true, roots };
}

function extractSignedVisibility(
  home: string,
  level: 'machine' | 'entity' | 'project',
  target: string,
  record: Record<string, YamlValue>,
): { ok: true; visibility: 'public' | 'private' | undefined } | { ok: false; why: string } {
  const settingsMap = isRecord(record.settings) ? record.settings : undefined;
  const rawVis = record.visibility ?? settingsMap?.visibility;
  if (rawVis !== undefined) {
    if (!isRecord(rawVis)) {
      // Unsigned visibility scalar is never trusted as a signed public fact.
      return { ok: true, visibility: undefined };
    }
    const verified = verifySignedSetting(home, 'visibility', level, target, rawVis);
    if (!verified.ok) return verified;
    if (verified.value === 'public') return { ok: true, visibility: 'public' };
    if (verified.value === 'private') return { ok: true, visibility: 'private' };
    return { ok: true, visibility: undefined };
  }
  const rawPublic = record.public ?? settingsMap?.public;
  if (rawPublic !== undefined) {
    if (!isRecord(rawPublic)) {
      return { ok: true, visibility: undefined };
    }
    const verified = verifySignedSetting(home, 'public', level, target, rawPublic);
    if (!verified.ok) return verified;
    if (verified.value === true || verified.value === 'public') return { ok: true, visibility: 'public' };
    if (verified.value === false || verified.value === 'private') return { ok: true, visibility: 'private' };
  }
  return { ok: true, visibility: undefined };
}

function extractLevelAnalyser(
  home: string,
  level: 'machine' | 'entity' | 'project',
  target: string,
  record: Record<string, YamlValue>,
): { ok: true; config: ParsedAnalyserConfig | null; source?: AnalysisSource } | { ok: false; why: string } {
  const levelSource = parseSourceNode(record.analysis_source ?? record.source, level);

  let rawAnalyser: YamlValue | undefined = record.analyser;
  if (rawAnalyser === undefined && isRecord(record.settings) && record.settings.analyser !== undefined) {
    rawAnalyser = record.settings.analyser;
  }
  if (rawAnalyser === undefined) {
    return {
      ok: true,
      config: null,
      ...(levelSource !== undefined ? { source: levelSource } : {}),
    };
  }

  // Guard 1: only an owner-signed analyser setting may admit; unsigned strings or maps are refused.
  const verifiedAnalyser = verifySignedSetting(home, 'analyser', level, target, rawAnalyser);
  if (!verifiedAnalyser.ok) return verifiedAnalyser;

  const signedRoots = extractSignedRoots(home, level, target, record);
  if (!signedRoots.ok) return signedRoots;

  const signedVis = extractSignedVisibility(home, level, target, record);
  if (!signedVis.ok) return signedVis;

  const parsed = parseAnalyserValue(
    verifiedAnalyser.value,
    signedRoots.roots,
    level,
    signedVis.visibility,
    levelSource,
  );
  if (parsed === null) {
    return {
      ok: false,
      why: `analyser setting for ${level} "${target}" has an invalid value`,
    };
  }
  return {
    ok: true,
    config: parsed,
    ...(levelSource !== undefined ? { source: levelSource } : {}),
  };
}

function callerMatchesPrincipal(caller: Caller, principal: string, home: string): boolean {
  if (isOwner(caller)) return true;
  if (caller.kind !== 'seat') return false;
  if (principal === 'owner') return false;
  const atIndex = principal.indexOf('@');
  if (atIndex <= 0) return false;
  const seatName = principal.slice(0, atIndex);
  const teamOrSession = principal.slice(atIndex + 1);
  if (seatName === '' || teamOrSession === '' || teamOrSession.includes('@')) return false;

  let recordedPane: string | undefined;
  const teams = findTeams(home, teamOrSession);
  // The principal's `@team` is the session the caller must stand in, and the state that may
  // vouch its pane is that session's state in the root of the one team the key names. Two
  // records named for one key (a project name two teams share) leave the root ambiguous, and a
  // team whose own session carries another name is another session's record: in either case no
  // state speaks for the named session, so a pane recorded in another session can never satisfy
  // it.
  const [team] = teams;
  if (teams.length === 1 && team !== undefined && team.session === teamOrSession) {
    recordedPane = standingOf(join(team.root, '.agents'), teamOrSession, caller).recordedPane;
    if (recordedPane === undefined) {
      const agent = seatAgent(
        home,
        [team.id ?? teamIdOf(team.root), teamIdOf(team.root), team.project, team.session],
        seatName,
      );
      if (agent !== null && agent.lifecycle === 'running' && agent.reach.session === teamOrSession && agent.reach.pane !== null && agent.reach.pane !== '') {
        recordedPane = agent.reach.pane;
      }
    }
  }
  if (recordedPane === undefined) {
    for (const agent of readAgents(home)) {
      if (agent.lifecycle !== 'running') continue;
      // Only a record of this seat in the named session lends a pane; a record whose team key
      // matches while its session is another one is another session's seat placement.
      if (agent.reach.session === teamOrSession && agent.reach.seat === seatName) {
        if (agent.reach.pane !== null && agent.reach.pane !== '') {
          recordedPane = agent.reach.pane;
        }
        break;
      }
    }
  }
  return callerStanding(caller, seatName, { session: teamOrSession, recordedPane });
}

/**
 * Checks that an owner-signed analyser is named in the owner's configuration (`projects.yaml`,
 * `entities.yaml`, or `settings.yaml`) with non-empty signed read scope covering `targetPath`,
 * that `io`'s caller is the owner at a terminal or the named analyser seat on its recorded pane,
 * and that a `scope: public` analyser is refused on a non-public project before any byte of
 * `targetPath` is read.
 */
export function mayAnalyseProject(
  io: Pick<Io, 'cwd' | 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
  targetPath: string,
  sources: AnalyseGateSources = {},
): AnalyseGateVerdict {
  const home = sources.home ?? io.env.HOME ?? homedir();
  const targetAbs = resolve(io.cwd, targetPath || '.');
  let canonicalTarget: string | undefined;
  let unresolvedIdentity = false;

  const matchState: {
    resolvedConfig: ParsedAnalyserConfig | null;
    resolvedSource: AnalysisSource;
    bestRootLen: number | null;
    resolvedRoot: string | null;
    tiedPrincipals: [string, string] | null;
    outOfScopePrincipal: string | null;
  } = {
    resolvedConfig: null,
    resolvedSource: DEFAULT_ANALYSIS_SOURCE,
    bestRootLen: null,
    resolvedRoot: null,
    tiedPrincipals: null,
    outOfScopePrincipal: null,
  };

  const considerExtracted = (extracted: {
    config: ParsedAnalyserConfig | null;
    source?: AnalysisSource;
  }): void => {
    if (extracted.config === null) return;
    let matchingRoot: string | null;
    try {
      canonicalTarget ??= canonicalPolicyPath(targetAbs);
      matchingRoot = bestMatchingRoot(canonicalTarget, extracted.config.roots, home);
    } catch {
      unresolvedIdentity = true;
      return;
    }
    if (matchingRoot === null) {
      matchState.outOfScopePrincipal = extracted.config.analyser.principal;
      return;
    }
    const entryBestLen = matchingRoot.length;
    if (matchState.bestRootLen === null || entryBestLen > matchState.bestRootLen) {
      matchState.bestRootLen = entryBestLen;
      matchState.resolvedConfig = extracted.config;
      matchState.resolvedRoot = matchingRoot;
      if (extracted.config.source !== undefined) matchState.resolvedSource = extracted.config.source;
      else if (extracted.source !== undefined) matchState.resolvedSource = extracted.source;
      matchState.tiedPrincipals = null;
    } else if (entryBestLen === matchState.bestRootLen && matchState.resolvedConfig !== null) {
      if (extracted.config.analyser.principal === matchState.resolvedConfig.analyser.principal) {
        matchState.resolvedConfig = extracted.config;
        matchState.resolvedRoot = matchingRoot;
        if (extracted.config.source !== undefined) matchState.resolvedSource = extracted.config.source;
        else if (extracted.source !== undefined) matchState.resolvedSource = extracted.source;
      } else {
        matchState.tiedPrincipals = [
          matchState.resolvedConfig.analyser.principal,
          extracted.config.analyser.principal,
        ];
      }
    }
  };

  // 1. Machine settings (`~/.config/team/settings.yaml`)
  const machineDoc = readYamlMap(machineSettingsPath(home));
  if (machineDoc !== null) {
    const extracted = extractLevelAnalyser(home, 'machine', 'machine', machineDoc);
    if (!extracted.ok) return { ok: false, code: 'analyse.unauthorised', why: extracted.why };
    if (extracted.source !== undefined) matchState.resolvedSource = extracted.source;
    considerExtracted(extracted);
  }

  // 2. Entity settings (`~/.config/team/entities.yaml`)
  const entitiesDoc = readYamlMap(entitiesPath(home));
  if (entitiesDoc !== null) {
    const entitiesMap =
      Object.keys(entitiesDoc).length === 1 && isRecord(entitiesDoc.entities)
        ? entitiesDoc.entities
        : entitiesDoc;
    for (const [entityName, rawEntity] of Object.entries(entitiesMap)) {
      if (!isRecord(rawEntity)) continue;
      const extracted = extractLevelAnalyser(home, 'entity', entityName, rawEntity);
      if (!extracted.ok) return { ok: false, code: 'analyse.unauthorised', why: extracted.why };
      considerExtracted(extracted);
    }
  }

  // 3. Project settings (`~/.config/team/projects.yaml`)
  const projectsDoc = readYamlMap(projectsFile(home));
  if (projectsDoc !== null) {
    const projectsMap = isRecord(projectsDoc.projects) ? projectsDoc.projects : projectsDoc;
    for (const [projectId, rawProject] of Object.entries(projectsMap)) {
      if (!isRecord(rawProject)) continue;
      const extracted = extractLevelAnalyser(home, 'project', projectId, rawProject);
      if (!extracted.ok) return { ok: false, code: 'analyse.unauthorised', why: extracted.why };
      considerExtracted(extracted);
    }
  }

  if (unresolvedIdentity) {
    return {
      ok: false,
      code: 'analyse.unauthorised',
      why: 'the target or a signed analyser root cannot be resolved safely',
    };
  }

  if (matchState.tiedPrincipals !== null) {
    return {
      ok: false,
      code: 'analyse.unauthorised',
      why: `target path matches equally specific read roots for different analysers ("${matchState.tiedPrincipals[0]}" and "${matchState.tiedPrincipals[1]}"); tie admits nobody`,
    };
  }

  if (matchState.resolvedConfig === null) {
    if (matchState.outOfScopePrincipal !== null) {
      return {
        ok: false,
        code: 'analyse.unauthorised',
        why: `target path is outside the read scope of named analyser "${matchState.outOfScopePrincipal}"`,
      };
    }
    return {
      ok: false,
      code: 'analyse.unauthorised',
      why: 'no analyser is named for this project; set an owner-signed analyser in entities.yaml or projects.yaml before running team analyse',
    };
  }

  const finalConfig: ParsedAnalyserConfig = matchState.resolvedConfig;
  const resolvedSource = matchState.resolvedSource;
  const { analyser } = finalConfig;
  // Selection and containment use the same identities. Carry both to the reader so a later
  // alias retarget cannot substitute another directory, even inside the broad signed root.
  const scopeRoot = matchState.resolvedRoot;
  if (scopeRoot === null || canonicalTarget === undefined) {
    return {
      ok: false,
      code: 'analyse.unauthorised',
      why: `target path is outside the read scope of named analyser "${analyser.principal}"`,
    };
  }
  const atIndex = analyser.principal.indexOf('@');
  const sessionHint = atIndex >= 0 ? analyser.principal.slice(atIndex + 1) : undefined;
  const hasInjectedCaller = sources.caller !== undefined || io.caller !== undefined;
  let caller: Caller = sources.caller ?? io.caller ?? walkCaller(io);
  if (caller.kind === 'unplaced' && !hasInjectedCaller && sessionHint !== undefined) {
    caller = callerOf(io, sessionHint);
  }

  if (!callerMatchesPrincipal(caller, analyser.principal, home)) {
    const who = caller.kind === 'seat' ? `seat "${caller.name}"` : caller.kind;
    return {
      ok: false,
      code: 'analyse.unauthorised',
      why: `caller (${who}) is not the named analyser "${analyser.principal}"`,
    };
  }

  const visibility = sources.visibility ? sources.visibility(targetAbs) : finalConfig.visibility;
  if (analyser.scope === 'public' && visibility !== 'public') {
    return {
      ok: false,
      code: 'analyse.scope',
      why: `analyser "${analyser.principal}" has scope: public and may only analyse public projects`,
    };
  }

  return {
    ok: true,
    analyser,
    source: resolvedSource,
    scopeRoot,
    canonicalTarget,
    ...(visibility === 'public' || visibility === 'private' ? { visibilityHint: visibility } : {}),
  };
}
