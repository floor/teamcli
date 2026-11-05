// Project analysis gate (`src/analyse/gate.ts`): verifies before any `fs.statSync`,
// `fs.readFileSync`, or `git` call on `<path>` that an owner-signed analyser is named in the
// owner's configuration (`projects.yaml`, `entities.yaml`, or `settings.yaml`) with non-empty
// signed read roots covering `<path>`, that the caller is the owner at a terminal or the named
// analyser seat, and that a `scope: public` analyser is refused on a non-public project (unless
// a signed public visibility fact is present) before any project byte is read. No `analyse`
// capability word or grant verb exists.

import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { callerOf, isOwner, walkCaller, type Caller } from '../caller.ts';
import { CONFIG_DOMAIN } from '../config/record.ts';
import { entitiesPath } from '../entities.ts';
import type { Io } from '../io.ts';
import { projectsFile } from '../registry/projects.ts';
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

function pathWithinRoot(targetAbs: string, rootPath: string, home: string): boolean {
  const resolvedRoot = expandHome(rootPath, home);
  const rel = relative(resolvedRoot, targetAbs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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
    if (!principal) return null;
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

function callerMatchesPrincipal(caller: Caller, principal: string): boolean {
  if (isOwner(caller)) return true;
  if (caller.kind !== 'seat') return false;
  if (principal === 'owner') return false;
  if (typeof caller.session !== 'string' || caller.session.trim() === '') return false;
  const atIndex = principal.indexOf('@');
  if (atIndex >= 0) {
    const seatName = principal.slice(0, atIndex);
    const teamOrSession = principal.slice(atIndex + 1);
    if (seatName === '' || teamOrSession === '') return false;
    return caller.name === seatName && caller.session === teamOrSession;
  }
  return caller.name === principal;
}

/**
 * Checks that an owner-signed analyser is named in the owner's configuration (`projects.yaml`,
 * `entities.yaml`, or `settings.yaml`) with non-empty signed read scope covering `targetPath`,
 * that `io`'s caller is the owner at a terminal or the named analyser seat, and that a
 * `scope: public` analyser is refused on a non-public project before any byte of `targetPath` is read.
 */
export function mayAnalyseProject(
  io: Pick<Io, 'cwd' | 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
  targetPath: string,
  sources: AnalyseGateSources = {},
): AnalyseGateVerdict {
  const home = sources.home ?? io.env.HOME ?? homedir();
  const targetAbs = resolve(io.cwd, targetPath || '.');

  let resolvedConfig: ParsedAnalyserConfig | null = null;
  let resolvedSource: AnalysisSource = DEFAULT_ANALYSIS_SOURCE;
  let outOfScopePrincipal: string | null = null;

  // 1. Machine settings (`~/.config/team/settings.yaml`)
  const machineDoc = readYamlMap(machineSettingsPath(home));
  if (machineDoc !== null) {
    const extracted = extractLevelAnalyser(home, 'machine', 'machine', machineDoc);
    if (!extracted.ok) return { ok: false, code: 'analyse.unauthorised', why: extracted.why };
    if (extracted.source !== undefined) resolvedSource = extracted.source;
    if (extracted.config !== null) {
      const roots = extracted.config.roots;
      if (roots.length > 0 && roots.some((r) => pathWithinRoot(targetAbs, r, home))) {
        resolvedConfig = extracted.config;
        if (extracted.config.source !== undefined) resolvedSource = extracted.config.source;
      } else {
        outOfScopePrincipal = extracted.config.analyser.principal;
      }
    }
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
      if (extracted.config !== null) {
        const roots = extracted.config.roots;
        if (roots.length > 0 && roots.some((r) => pathWithinRoot(targetAbs, r, home))) {
          resolvedConfig = extracted.config;
          if (extracted.config.source !== undefined) resolvedSource = extracted.config.source;
          else if (extracted.source !== undefined) resolvedSource = extracted.source;
        } else {
          outOfScopePrincipal = extracted.config.analyser.principal;
        }
      }
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
      if (extracted.config !== null) {
        const roots = extracted.config.roots;
        if (roots.length > 0 && roots.some((r) => pathWithinRoot(targetAbs, r, home))) {
          resolvedConfig = extracted.config;
          if (extracted.config.source !== undefined) resolvedSource = extracted.config.source;
          else if (extracted.source !== undefined) resolvedSource = extracted.source;
        } else {
          outOfScopePrincipal = extracted.config.analyser.principal;
        }
      }
    }
  }

  if (resolvedConfig === null) {
    if (outOfScopePrincipal !== null) {
      return {
        ok: false,
        code: 'analyse.unauthorised',
        why: `target path is outside the read scope of named analyser "${outOfScopePrincipal}"`,
      };
    }
    return {
      ok: false,
      code: 'analyse.unauthorised',
      why: 'no analyser is named for this project; set an owner-signed analyser in entities.yaml or projects.yaml before running team analyse',
    };
  }

  const { analyser } = resolvedConfig;
  const atIndex = analyser.principal.indexOf('@');
  const sessionHint = atIndex >= 0 ? analyser.principal.slice(atIndex + 1) : undefined;
  let caller: Caller = sources.caller ?? io.caller ?? walkCaller(io);
  if (caller.kind === 'unplaced' && sources.caller === undefined && io.caller === undefined && sessionHint !== undefined) {
    caller = callerOf(io, sessionHint);
  }

  if (!callerMatchesPrincipal(caller, analyser.principal)) {
    const who = caller.kind === 'seat' ? `seat "${caller.name}"` : caller.kind;
    return {
      ok: false,
      code: 'analyse.unauthorised',
      why: `caller (${who}) is not the named analyser "${analyser.principal}"`,
    };
  }

  const visibility = sources.visibility ? sources.visibility(targetAbs) : resolvedConfig.visibility;
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
    ...(visibility === 'public' || visibility === 'private' ? { visibilityHint: visibility } : {}),
  };
}
