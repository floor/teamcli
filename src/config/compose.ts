// The read-only composition: what a seat's five settings are today, and where each value comes
// from. It reads the live team file — the 0.5.0 record of a seat — and, when a caller passes
// them, the signed settings records one level at a time, nearest first. An
// unset key is reported unset, never guessed: the profile chooses the effort at launch, the
// seat's name stands for the nickname, and the team file's own order stands under a seat that
// writes none.
//
// A signed record is the governed word and stands beside the file entry of the same key, ahead
// of it at the same level and ahead of every level above it: a seat record beats the seat's
// file entry, a team record beats the file's team order. Two seat-level words cannot both
// stand, and the record is the one the write verbs maintain.
//
// The composition writes nothing and decides nothing. `team settings` and `team seat` print these
// rows; a change is a separate, guarded write.

import type { DeliveryLeg } from '../settings/inherit.ts';
import { DELIVERY_ORDER } from '../settings/inherit.ts';
import type { Seat } from '../file/types.ts';
import { CONFIG_KEYS, CONFIG_REGISTRY, type ConfigKey, type ConfigLevel, type ConfigValue } from './registry.ts';

/**
 * Where a row's value comes from: a signed record at one of the four levels, the seat's entry in
 * the team file, the file's team-level order, the registry's release default, or nowhere — the
 * key is unset and the layer below (the profile, the launcher, the seat's name) decides.
 */
export type ConfigOrigin =
  | 'entity record'
  | 'project record'
  | 'team record'
  | 'seat record'
  | 'team file'
  | 'team default'
  | 'default'
  | 'none';

/** One key's winning signed record: the level it was set at, its value, and the file it was
 *  read from. */
export type ConfigRecordValue = {
  level: ConfigLevel;
  value: ConfigValue;
  sourceFile?: string;
};

/** The signed records that win their key, nearest first, as the chain resolver returns them. */
export type ConfigRecordValues = Partial<Record<ConfigKey, ConfigRecordValue>>;

export type ConfigRow = {
  key: ConfigKey;
  /** The value in force, or null when no layer this composition reads sets one. */
  value: ConfigValue | null;
  origin: ConfigOrigin;
  /** The file a signed record was read from, when one wins the key. */
  sourceFile?: string;
  /** How a change to this key would apply, from the registry. */
  applies: 'restart-resume' | 'at-once';
};

/** The seat fields the composition reads. A built `Seat` satisfies it; a test may pass the six. */
export type ConfigSeatInput = Pick<
  Seat,
  'model' | 'modelFrom' | 'effort' | 'nickname' | 'human' | 'deliveryOrder'
>;

/**
 * The model the team file decides, or null when it decides none. An empty value decides
 * nothing, and a model the launcher chooses is the launcher's word, not the file's: both read
 * unset, so the layer below is named as the one deciding, never the file.
 */
function fileModel(seat: ConfigSeatInput): string | null {
  if (seat.model === undefined || seat.model === '') return null;
  if (seat.modelFrom === 'launcher') return null;
  return seat.model;
}

/** A value copied so a caller holding a row never changes what the next read says. */
function copyValue(value: ConfigValue): ConfigValue {
  return Array.isArray(value) ? [...value] : value;
}

function recordOrigin(level: ConfigLevel): ConfigOrigin {
  switch (level) {
    case 'entity': return 'entity record';
    case 'project': return 'project record';
    case 'team': return 'team record';
    case 'seat': return 'seat record';
  }
}

function rowOf(key: ConfigKey, value: ConfigValue | null, origin: ConfigOrigin, record?: ConfigRecordValue): ConfigRow {
  const row: ConfigRow = { key, value, origin, applies: CONFIG_REGISTRY[key].applies };
  if (record?.sourceFile !== undefined) row.sourceFile = record.sourceFile;
  return row;
}

/** The nearest signed record for the key, then the seat's own file entry, then the levels the
 *  caller folds in below it. */
function fileOrRecord(
  key: ConfigKey,
  fileValue: ConfigValue | null,
  record: ConfigRecordValue | undefined,
): ConfigRow {
  if (record?.level === 'seat') return rowOf(key, copyValue(record.value), 'seat record', record);
  if (fileValue !== null) return rowOf(key, copyValue(fileValue), 'team file');
  if (record !== undefined) return rowOf(key, copyValue(record.value), recordOrigin(record.level), record);
  return rowOf(key, null, 'none');
}

/**
 * One seat's five settings, from its team-file entry, the file's team-level order, and the
 * signed records that win each key. The order resolves the way a send resolves it: the seat's
 * own word wins, then the file's team order, then the release default — the seat's own word may
 * tighten that order, never loosen it, which the write guard enforces before the word is
 * recorded.
 */
export function composeSeatConfig(
  seat: ConfigSeatInput,
  teamDeliveryOrder: readonly DeliveryLeg[] | null,
  records: ConfigRecordValues = {},
): ConfigRow[] {
  // Every order is copied: the seat's word, the team's and the release default stay the
  // sources' own arrays, and one caller holding a row never changes what the next read says.
  const rows: Record<ConfigKey, ConfigRow> = {
    model: fileOrRecord('model', fileModel(seat), records.model),
    effort: fileOrRecord('effort', seat.effort ?? null, records.effort),
    nickname: fileOrRecord('nickname', seat.nickname ?? null, records.nickname),
    delivery_order: (() => {
      const record = records.delivery_order;
      if (record?.level === 'seat') return rowOf('delivery_order', copyValue(record.value), 'seat record', record);
      if (seat.deliveryOrder !== undefined) return rowOf('delivery_order', [...seat.deliveryOrder], 'team file');
      if (record !== undefined) return rowOf('delivery_order', copyValue(record.value), recordOrigin(record.level), record);
      if (teamDeliveryOrder !== null) return rowOf('delivery_order', [...teamDeliveryOrder], 'team default');
      return rowOf('delivery_order', [...DELIVERY_ORDER.fallback], 'default');
    })(),
    human: fileOrRecord('human', seat.human === true ? true : null, records.human),
  };
  // `human` has a release default; a key no record and no file word reaches reads it, not unset.
  if (rows.human.origin === 'none') rows.human = rowOf('human', false, 'default');
  return CONFIG_KEYS.map((key) => rows[key]);
}
