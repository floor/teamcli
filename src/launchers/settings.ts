// Settings-object combination for declarative launchers: recursive JSON-literal validation,
// a non-mutating layered merge, and the `--settings` words a launcher fixes or a caller passes.
// Pure: nothing here reads a file, the process environment or a credential store. A settings
// value that looks like credential material is refused, never echoed; a malformed or
// file-valued word is reported, never read. See the launchers design note and the unified
// proposal (private lab briefs).
import type { JsonValue } from './types.ts';

/** Keys a settings object may never carry, at any depth: assigning them would reach the
 *  prototype chain. An own data property of that name (which JSON.parse does create) is
 *  refused by name, so the merge below never has to touch one. */
export const UNSAFE_SETTINGS_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

const CREDENTIAL_WORD = /(?:token|secret|password|passwd|api[-_]?key|credential)/i;
const CREDENTIAL_PREFIX = /^(?:sk-|gh[pousr]_|xox[abpr]-)/;
/** A credential-shaped token anywhere a word can start (a value, or prose quoting one). */
const CREDENTIAL_TOKEN = /(?:^|[\s"'`])(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abpr]-[A-Za-z0-9-]{8,})/;

export function looksLikeCredentialValue(word: string): boolean {
  return CREDENTIAL_PREFIX.test(word);
}

/** A free string that embeds a secret-shaped word *and* material: conservative — a value
 *  that carries a credential token, or a `<word>=<material>` pair where the word names a
 *  credential and the material is not a reference or placeholder. */
export function stringHoldsSecret(value: string): boolean {
  if (CREDENTIAL_TOKEN.test(value)) return true;
  const pair = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(value.trim());
  if (pair !== null && CREDENTIAL_WORD.test(pair[1] ?? '') && (pair[2] ?? '').length >= 8) {
    return !/^\{.*\}$/.test((pair[2] ?? '').trim());
  }
  return false;
}

export type SettingsIssue = { code: string; path: string; message: string };

/** Settings objects are shallow by nature; this bound is far beyond any documented harness
 *  key and keeps the walk finite on hostile explicit input. A cycle in the input graph is
 *  refused by path, so a self-referencing object can never recurse the walk. */
export const MAX_SETTINGS_DEPTH = 32;

export function isPlainMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isJsonMap(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keyPath(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`;
}

function valueKind(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'symbol') return 'a symbol';
  if (typeof value === 'bigint') return 'a bigint';
  if (typeof value === 'number') return 'a non-finite number';
  return 'a non-JSON value';
}

/** Walks one value into a fresh JSON literal, reporting every path that is not one. A
 *  container already on the current path is a cycle, and nesting past MAX_SETTINGS_DEPTH is
 *  unbounded shape: both are refused as structured issues, never by recursing forever. */
function walk(
  value: unknown,
  path: string,
  issues: SettingsIssue[],
  active: Set<object>,
  depth: number,
): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    issues.push({
      code: 'E_HARNESS_SETTINGS_VALUE',
      path,
      message: `${path} is a non-finite number; settings values are JSON literals (null, boolean, finite number, string, array or plain object)`,
    });
    return undefined;
  }
  if (typeof value === 'string') {
    if (stringHoldsSecret(value)) {
      issues.push({
        code: 'E_SECRET_LITERAL',
        path,
        message: `${path} holds a credential-shaped string; settings hold no secret material (the value is not echoed)`,
      });
      return undefined;
    }
    return value;
  }
  if (Array.isArray(value) || isPlainMap(value)) {
    if (active.has(value)) {
      issues.push({
        code: 'E_HARNESS_SETTINGS_VALUE',
        path,
        message: `${path} is cyclic; settings values are finite JSON literals (null, boolean, finite number, string, array or plain object)`,
      });
      return undefined;
    }
    if (depth >= MAX_SETTINGS_DEPTH) {
      issues.push({
        code: 'E_HARNESS_SETTINGS_VALUE',
        path,
        message: `${path} is nested deeper than ${MAX_SETTINGS_DEPTH} levels; settings values are finite JSON literals (null, boolean, finite number, string, array or plain object)`,
      });
      return undefined;
    }
    active.add(value);
    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      value.forEach((item, index) => {
        const walked = walk(item, `${path}[${index}]`, issues, active, depth + 1);
        if (walked !== undefined) out.push(walked);
      });
      active.delete(value);
      return out;
    }
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      const at = keyPath(path, key);
      if (UNSAFE_SETTINGS_KEYS.includes(key)) {
        issues.push({
          code: 'E_SETTINGS_KEY_UNSAFE',
          path: at,
          message: `${at} uses the reserved key "${key}"; __proto__, constructor and prototype are refused at every depth`,
        });
        continue;
      }
      const walked = walk(value[key], at, issues, active, depth + 1);
      if (walked !== undefined) out[key] = walked;
    }
    active.delete(value);
    return out;
  }
  issues.push({
    code: 'E_HARNESS_SETTINGS_VALUE',
    path,
    message: `${path} is ${valueKind(value)}; settings values are JSON literals (null, boolean, finite number, string, array or plain object)`,
  });
  return undefined;
}

export type SettingsRead = { value: Record<string, JsonValue> | null; issues: SettingsIssue[] };

/** Reads one settings object (a definition's `harness_settings`, the resolver's defaults, or
 *  a parsed inline `--settings` object) into a fresh JSON literal, or reports why not. */
export function readSettingsObject(value: unknown, path: string): SettingsRead {
  const issues: SettingsIssue[] = [];
  if (!isPlainMap(value)) {
    issues.push({
      code: 'E_HARNESS_SETTINGS',
      path,
      message: `${path} is a map of the harness's settings keys to JSON literals`,
    });
    return { value: null, issues };
  }
  const walked = walk(value, path, issues, new Set<object>(), 0);
  if (issues.length > 0) return { value: null, issues };
  return { value: walked as Record<string, JsonValue>, issues };
}

function cloneValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isJsonMap(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_SETTINGS_KEYS.includes(key)) continue;
      out[key] = cloneValue(item);
    }
    return out;
  }
  return value;
}

function overlay(
  target: Record<string, JsonValue>,
  over: Readonly<Record<string, JsonValue>>,
  prefix: string,
  onOverride: ((path: string) => void) | undefined,
): void {
  for (const [key, value] of Object.entries(over)) {
    if (UNSAFE_SETTINGS_KEYS.includes(key)) continue;
    const at = keyPath(prefix, key);
    const has = Object.hasOwn(target, key);
    const existing = has ? target[key] : undefined;
    if (existing !== undefined && isJsonMap(existing) && isJsonMap(value)) {
      overlay(existing, value, at, onOverride);
      continue;
    }
    if (has) onOverride?.(at);
    target[key] = cloneValue(value);
  }
}

/** Recursive merge for plain objects; arrays, scalars and null replace wholesale (null is a
 *  value, not a deletion). Inputs are never mutated and the output aliases neither: every
 *  object and array is copied. Every key override calls `onOverride` with its path. */
export function mergeSettingsObject(
  base: Readonly<Record<string, JsonValue>>,
  over: Readonly<Record<string, JsonValue>>,
  onOverride?: (path: string) => void,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(base)) {
    if (UNSAFE_SETTINGS_KEYS.includes(key)) continue;
    out[key] = cloneValue(value);
  }
  overlay(out, over, '', onOverride);
  return out;
}

export type SettingsSpan =
  | { kind: 'inline'; object: Record<string, JsonValue>; start: number; end: number }
  | { kind: 'file'; word: string; start: number; end: number }
  | { kind: 'error'; code: string; message: string; start: number; end: number };

export type ClassifiedWord = { word: string; cls: string };

const SETTINGS_FLAG = '--settings';
const SETTINGS_EQUALS = '--settings=';

/**
 * Reads the settings-class words of one argv list (already classified). Each span covers the
 * flag word and, for the two-word form, its value. A fixed launcher word whose value does not
 * start with `{` is file-valued and stays in argv; a caller word in that shape is refused
 * (merge never reads a file). Inline values must parse to a plain JSON object whose contents
 * pass the settings rules. Messages name key paths, never values.
 */
export function settingsSpans(entries: readonly ClassifiedWord[], source: 'fixed' | 'caller'): SettingsSpan[] {
  const spans: SettingsSpan[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    if (entry === undefined || entry.cls !== 'settings') {
      index += 1;
      continue;
    }
    let raw: string | undefined;
    const start = index;
    let end = index;
    if (entry.word === SETTINGS_FLAG) {
      const next = entries[index + 1];
      if (next === undefined || next.cls !== 'settings') {
        spans.push({ kind: 'error', code: 'E_SETTINGS_JSON', message: 'a --settings flag carries no value', start, end });
        index += 1;
        continue;
      }
      raw = next.word;
      end = index + 1;
      index += 2;
    } else if (entry.word.startsWith(SETTINGS_EQUALS)) {
      raw = entry.word.slice(SETTINGS_EQUALS.length);
      index += 1;
    } else {
      // A settings-class word that is not a --settings flag: classifyArgs only reaches this
      // for a carried value, which the two-word form above consumed.
      index += 1;
      continue;
    }
    if (raw === undefined || raw === '') {
      spans.push({ kind: 'error', code: 'E_SETTINGS_JSON', message: 'a --settings flag carries no value', start, end });
      continue;
    }
    if (!raw.trim().startsWith('{')) {
      if (source === 'caller') {
        spans.push({
          kind: 'error',
          code: 'E_SETTINGS_FILE',
          message: 'a caller --settings value names a settings file; merge folds inline JSON objects only and never reads a file',
          start,
          end,
        });
      } else {
        spans.push({ kind: 'file', word: raw, start, end });
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      spans.push({
        kind: 'error',
        code: 'E_SETTINGS_JSON',
        message: 'a --settings word carries malformed inline JSON',
        start,
        end,
      });
      continue;
    }
    if (!isPlainMap(parsed)) {
      spans.push({
        kind: 'error',
        code: 'E_SETTINGS_JSON',
        message: 'an inline --settings value is not a JSON object',
        start,
        end,
      });
      continue;
    }
    const read = readSettingsObject(parsed, '--settings');
    if (read.value === null) {
      const first = read.issues[0];
      spans.push({
        kind: 'error',
        code: first?.code ?? 'E_SETTINGS_JSON',
        message: first?.message ?? 'the inline --settings object is invalid',
        start,
        end,
      });
      continue;
    }
    spans.push({ kind: 'inline', object: read.value, start, end });
  }
  return spans;
}
