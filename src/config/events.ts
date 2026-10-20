// `config.changed`: one event per signed settings record written. The event
// carries the key, the level, and the value before and after in words — a value, never a secret,
// because a setting that looked like a credential is refused before it is stored. The record id
// names the signed generation, so the same write raised twice is one event, across sessions.
//
// A write raises its events after the record is replaced. A crash in between leaves a signed
// generation with no event; the bus's reconcile pass finds it and appends one marked
// `reconciled: "true"`, knowing the new value but not the old.

import { appendEvent, type EventAppendInput, type EventAppendResult } from '../bus/log.ts';
import type { ConfigKey, ConfigLevel, ConfigValue } from './registry.ts';

export type ConfigChange = {
  /** When the change ran: the signed record's own date for a set; for an unset, the command's
   *  clock, because the removed record's date says when the value was written, not taken away. */
  ts: string;
  session: string;
  level: ConfigLevel;
  target: string;
  key: ConfigKey;
  /** The value before the change, or null when there was none (a first set) or it is unknown
   *  (a reconciled event). */
  old: ConfigValue | null;
  /** The value after the change, or null for an unset. */
  value: ConfigValue | null;
  generation: number;
  /** Who the event is from: the owner, or the lead's seat when a lead wrote within its team. */
  from: string;
  /** The seat the setting belongs to, when the level is `seat`. */
  seat?: string;
  /** The event's subject: the seat a seat-level change concerns, or the record's target. */
  subject?: string;
  /** Set on an event the reconcile pass appended after finding a signed record without one. */
  reconciled?: boolean;
};

/** A value in the event's words: an order as its legs, a boolean as itself. */
export function sayConfigEventValue(value: ConfigValue): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  return value.join(',');
}

/** The record id of one signed change: the level, target, key and signed generation. */
export function configChangedRecordId(change: Pick<ConfigChange, 'level' | 'target' | 'key' | 'generation' | 'value'>): string {
  const base = `config:${change.level}:${change.target}:${change.key}:${change.generation}`;
  return change.value === null ? `${base}:unset` : base;
}

/** Appends one `config.changed` event, deduplicated by its record id. */
export function appendConfigChanged(
  project: string,
  root: string,
  home: string,
  change: ConfigChange,
): EventAppendResult {
  const input: EventAppendInput = {
    ts: change.ts,
    kind: 'config.changed',
    session: change.session,
    record_id: configChangedRecordId(change),
    from: change.from,
    subject: change.subject ?? change.target,
    config_key: change.key,
    config_level: change.level,
    ...(change.seat !== undefined ? { seat: change.seat } : {}),
    ...(change.old !== null ? { config_old: sayConfigEventValue(change.old) } : {}),
    ...(change.value !== null ? { config_new: sayConfigEventValue(change.value) } : {}),
    ...(change.reconciled ? { reconciled: 'true' } : {}),
  };
  return appendEvent(project, root, home, input, { deduplicate: true });
}
