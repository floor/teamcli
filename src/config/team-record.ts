// The team's record as `team config get|set|unset` addresses it: a dotted path into the parsed
// team (`watch.unread_after`, `seats.lead.model`, `seats.0.cli`), and the YAML text written back.
// A segment under a list picks the item whose `name` is that segment, or the item at that index.
//
// Values are written back as block YAML in the subset src/yaml.ts reads; a written text is always
// parsed again and validated by the team-file validator before it is stored, so nothing here has
// to be trusted to be right — only to be readable. Comments do not survive a `set` or `unset`
// (the record is regenerated); `team config edit` edits the text itself and keeps them.

import { parseYaml, toValue, type YamlValue } from '../yaml.ts';

export type RecordPath = string[];

export function parsePath(raw: string): RecordPath | string {
  if (raw === '' || raw.startsWith('.') || raw.endsWith('.') || raw.includes('..')) return `"${raw}" is not a path: write dotted keys, like watch.unread_after or seats.lead.model`;
  return raw.split('.');
}

type Container = { [key: string]: YamlValue } | YamlValue[];

function isMap(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

/** The index a segment names in a list: the item named so, else a decimal index. */
function indexIn(list: YamlValue[], segment: string): number {
  const named = list.findIndex((item) => isMap(item) && item.name === segment);
  if (named >= 0) return named;
  if (/^(0|[1-9][0-9]*)$/.test(segment)) {
    const at = Number(segment);
    return at < list.length ? at : -1;
  }
  return -1;
}

export function getAt(root: YamlValue, path: RecordPath): { found: true; value: YamlValue } | { found: false } {
  let at: YamlValue = root;
  for (const segment of path) {
    if (Array.isArray(at)) {
      const i = indexIn(at, segment);
      if (i < 0) return { found: false };
      at = at[i] as YamlValue;
    } else if (isMap(at) && Object.prototype.hasOwnProperty.call(at, segment)) {
      at = at[segment] as YamlValue;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: at };
}

/** Sets (or, with `value` undefined, removes) the value at `path` in a copy of `root`. Missing
 *  maps on the way are made; a list item must exist. Returns a reason when the path cannot be. */
export function withValue(root: YamlValue, path: RecordPath, value: YamlValue | undefined): { ok: true; root: YamlValue; changed: boolean } | { ok: false; why: string } {
  const copy = structuredClone(root) as YamlValue;
  if (!isMap(copy)) return { ok: false, why: 'the record is not a map' };
  let at: Container = copy;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i] as string;
    const where = path.slice(0, i + 1).join('.');
    if (Array.isArray(at)) {
      const n = indexIn(at, segment);
      if (n < 0) return { ok: false, why: `${path.slice(0, i).join('.')} has no item named "${segment}"` };
      const next = at[n];
      if (next === null || typeof next !== 'object') return { ok: false, why: `${where} is a value, not a section` };
      at = next as Container;
    } else {
      let next = at[segment];
      if (next === undefined) {
        if (value === undefined) return { ok: true, root: copy, changed: false };
        next = {};
        at[segment] = next;
      }
      if (next === null || typeof next !== 'object') return { ok: false, why: `${where} is a value, not a section` };
      at = next as Container;
    }
  }
  const last = path[path.length - 1] as string;
  if (Array.isArray(at)) {
    const n = indexIn(at, last);
    if (n < 0) return value === undefined ? { ok: true, root: copy, changed: false } : { ok: false, why: `${path.slice(0, -1).join('.')} has no item named "${last}"` };
    if (value === undefined) at.splice(n, 1);
    else at[n] = value;
    return { ok: true, root: copy, changed: true };
  }
  if (value === undefined) {
    if (!Object.prototype.hasOwnProperty.call(at, last)) return { ok: true, root: copy, changed: false };
    delete at[last];
    return { ok: true, root: copy, changed: true };
  }
  const before = at[last];
  at[last] = value;
  return { ok: true, root: copy, changed: JSON.stringify(before) !== JSON.stringify(value) };
}

/** A value typed on the command line, read as a YAML scalar or one-line flow value. */
export function parseValue(raw: string): YamlValue {
  try {
    const parsed = toValue(parseYaml(`value: ${raw}\n`));
    if (isMap(parsed) && 'value' in parsed) return parsed.value as YamlValue;
  } catch {
    // Not YAML: the text itself.
  }
  return raw;
}

const PLAIN = /^[A-Za-z_./@~][A-Za-z0-9_./@~+-]*( [A-Za-z0-9_./@~+-]+)*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;

function scalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value !== 'string') return String(value);
  return PLAIN.test(value) && !RESERVED.test(value) ? value : JSON.stringify(value);
}

function key(name: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) ? name : JSON.stringify(name);
}

function emptyOrScalar(value: YamlValue): string | null {
  if (Array.isArray(value)) return value.length === 0 ? '[]' : null;
  if (isMap(value)) return Object.keys(value).length === 0 ? '{}' : null;
  return scalar(value);
}

function emit(value: YamlValue, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      const inline = emptyOrScalar(item);
      if (inline !== null) {
        out.push(`${pad}- ${inline}`);
      } else if (isMap(item)) {
        const lines: string[] = [];
        emit(item, indent + 2, lines);
        out.push(`${pad}- ${(lines[0] as string).slice(indent + 2)}`, ...lines.slice(1));
      } else {
        out.push(`${pad}-`);
        emit(item, indent + 2, out);
      }
    }
    return;
  }
  if (isMap(value)) {
    for (const [name, item] of Object.entries(value)) {
      const inline = emptyOrScalar(item);
      if (inline !== null) {
        out.push(`${pad}${key(name)}: ${inline}`);
      } else {
        out.push(`${pad}${key(name)}:`);
        emit(item, Array.isArray(item) ? indent + 2 : indent + 2, out);
      }
    }
    return;
  }
  out.push(`${pad}${scalar(value)}`);
}

/** The record as block YAML text. */
export function recordText(value: YamlValue): string {
  const out: string[] = [];
  emit(value, 0, out);
  return `${out.join('\n')}\n`;
}

/** A value as `team config get` prints it: a scalar plain, a section as YAML. */
export function shownValue(value: YamlValue): string {
  const inline = emptyOrScalar(value);
  if (inline !== null) return typeof value === 'string' ? `${value}\n` : `${inline}\n`;
  return recordText(value);
}
