import type { Caller } from '../caller.ts';
import { logLine } from '../log.ts';
import { registeredRootOf, teamIdOf } from '../registry/teams.ts';
import { parseYaml, toValue, type YamlValue } from '../yaml.ts';
import { join } from 'node:path';
import { CLIS } from '../clis.ts';
import { DURATION, PERCENT, SIZE, parseMeasure } from './sections/units.ts';

/** Reporting supplied by the command after its existing gates admitted the write. It grants
 * nothing and is deliberately outside the team definition and its signed canonical form. */
export type RecordWriteAudit = {
  caller: Caller;
  rule: string;
  /** A verified client door must keep its own identity rather than borrow the owner label. */
  client?: string;
};

type Value = YamlValue | undefined;
type Change = { path: string[]; old: Value; next: Value };

function map(value: Value): value is Record<string, YamlValue> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function changes(old: Value, next: Value, path: string[] = []): Change[] {
  if (JSON.stringify(old) === JSON.stringify(next)) return [];
  if ((map(old) || old === undefined) && (map(next) || next === undefined)) {
    const keys = new Set([...Object.keys(old ?? {}), ...Object.keys(next ?? {})]);
    if (keys.size === 0) return [{ path, old, next }];
    const own = (value: Record<string, YamlValue> | undefined, key: string): Value =>
      value !== undefined && Object.hasOwn(value, key) ? value[key] : undefined;
    return [...keys].flatMap((key) => changes(own(old, key), own(next, key), [...path, key]));
  }
  // Seat names, unlike positions, remain stable when a seat is removed from the middle.
  if (path.length === 1 && path[0] === 'seats' && (Array.isArray(old) || old === undefined) && (Array.isArray(next) || next === undefined)) {
    const named = (values: YamlValue[] | undefined): Map<string, YamlValue> | null => {
      const result = new Map<string, YamlValue>();
      for (const value of values ?? []) {
        if (!map(value) || typeof value.name !== 'string' || result.has(value.name)) return null;
        result.set(value.name, value);
      }
      return result;
    };
    const before = named(old);
    const after = named(next);
    if (before !== null && after !== null) {
      const result = [...new Set([...before.keys(), ...after.keys()])].flatMap((name) => changes(before.get(name), after.get(name), [...path, name]));
      if (JSON.stringify([...before.keys()]) !== JSON.stringify([...after.keys()])) {
        result.push({ path: [...path, '$order'], old: old, next });
      }
      return result;
    }
  }
  // Unknown containers stay redacted as a whole, never serialized into the audit log.
  return [{ path, old, next }];
}

/** Only schema-defined flags, finite words and measurements are public here (the seats, watch
 * and machine sections in src/file/sections, and src/clis.ts). Free text,
 * including models, launch recipes, rules, paths and all unknown keys, may carry a secret.
 * Even a boolean or number under an unknown key is secret. New fields fail closed. */
function publicValue(path: string[], value: Value): boolean {
  if (value === undefined) return true;
  // These path lengths follow the sections' schema: section.key or seats.name.key.
  if (path.length === 3 && path[0] === 'seats') {
    if (['stopped', 'human', 'assistant', 'leads'].includes(path[2]!)) return typeof value === 'boolean';
    if (path[2] === 'cli') return typeof value === 'string' && CLIS.includes(value);
  }
  if (path.length !== 2) return false;
  const key = path[1]!;
  const measure = (units: Record<string, number>): boolean => typeof value === 'string' && Number.isFinite(parseMeasure(value, units));
  if (path[0] === 'watch') {
    if (key === 'child_late_limit') return typeof value === 'number' && Number.isFinite(value);
    if (['interval', 'idle_first', 'idle_owner', 'blind_after', 'idle_repeat', 'team_idle', 'nudge_wait', 'unsent_after', 'unread_after', 'lead_unread_after', 'stuck_after', 'watch_start_limit'].includes(key)) return measure(DURATION);
  }
  if (path[0] === 'machine') {
    if (['load_start', 'load_max'].includes(key)) return typeof value === 'number' && Number.isFinite(value);
    if (['memory_start', 'memory_min'].includes(key)) return measure(PERCENT);
    if (['disk_min', 'swap_free_min', 'swap_growth_max'].includes(key)) return measure(SIZE);
    if (key === 'swap_growth_window') return measure(DURATION);
  }
  return false;
}

/** The existing team log and logLine writer are the only sink. Called after a successful write;
 * reporting failures cannot turn that write into a refusal or change its admission. */
export function auditRecordWrite(input: {
  root: string;
  home: string;
  command: string;
  before: string;
  after: string;
  audit: RecordWriteAudit;
  now: Date;
}): void {
  const { caller } = input.audit;
  let actor = input.audit.client === undefined ? caller.kind : `client:${input.audit.client}`;
  try {
    if (input.audit.client === undefined && caller.kind === 'seat') {
      const placed = registeredRootOf(input.home, caller.name, caller.session);
      actor = `seat:${caller.name} team:${placed.ok ? teamIdOf(placed.root) : 'unresolved'}`;
    }
    const before = toValue(parseYaml(input.before));
    const after = toValue(parseYaml(input.after));
    const diff = changes(before, after);
    if (diff.length === 0 && input.before !== input.after) diff.push({ path: ['$text'], old: input.before, next: input.after });
    for (const change of diff) {
      const entry = {
        team: teamIdOf(input.root),
        rule: input.audit.rule,
        key: change.path.join('.') || '$record',
        path: change.path,
        ...(publicValue(change.path, change.old) && publicValue(change.path, change.next)
          ? { old: change.old === undefined ? { absent: true } : change.old, new: change.next === undefined ? { absent: true } : change.next }
          : { changed: true }),
      };
      logLine(join(input.root, '.agents'), input.command, actor, `record-write ${JSON.stringify(entry)}`, input.now);
    }
  } catch {
    // The log writer owns its own failure diagnostic. A malformed prior definition must never
    // leak its parser's message (which could quote a secret) or change a successful edit.
    logLine(join(input.root, '.agents'), input.command, actor, `record-write ${JSON.stringify({ team: teamIdOf(input.root), rule: input.audit.rule, key: '$record', changed: true })}`, input.now);
  }
}
