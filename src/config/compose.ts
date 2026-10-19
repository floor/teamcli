// The read-only composition: what a seat's five settings are today, and where each value comes
// from. It reads the live team file — the 0.5.0 record of a seat — and nothing else: no signed
// settings source exists yet, and where a wider surface writes is a decision this release has not
// taken. An unset key is reported unset, never guessed: the profile chooses the effort at launch,
// the seat's name stands for the nickname, and the team file's own order stands under a seat that
// writes none.
//
// The composition writes nothing and decides nothing. `team settings` and `team seat` print these
// rows; a change is a separate, guarded write.

import type { DeliveryLeg } from '../settings/inherit.ts';
import { DELIVERY_ORDER } from '../settings/inherit.ts';
import type { Seat } from '../file/types.ts';
import { CONFIG_KEYS, CONFIG_REGISTRY, type ConfigKey, type ConfigValue } from './registry.ts';

/**
 * Where a row's value comes from: the seat's entry in the team file, the file's team-level order,
 * the registry's release default, or nowhere — the key is unset and the layer below (the profile,
 * the launcher, the seat's name) decides.
 */
export type ConfigOrigin = 'team file' | 'team default' | 'default' | 'none';

export type ConfigRow = {
  key: ConfigKey;
  /** The value in force, or null when no layer this composition reads sets one. */
  value: ConfigValue | null;
  origin: ConfigOrigin;
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

/**
 * One seat's five settings, from its team-file entry and the file's team-level order. The order
 * resolves the way a send resolves it: the seat's own word wins, then the file's team order, then
 * the release default — the seat's own word may tighten that order, never loosen it, which the
 * write guard enforces before the word is recorded.
 */
export function composeSeatConfig(
  seat: ConfigSeatInput,
  teamDeliveryOrder: readonly DeliveryLeg[] | null,
): ConfigRow[] {
  // Every order is copied: the seat's word, the team's and the release default stay the
  // sources' own arrays, and one caller holding a row never changes what the next read says.
  const model = fileModel(seat);
  const rows: Record<ConfigKey, ConfigRow> = {
    model: model !== null
      ? { key: 'model', value: model, origin: 'team file', applies: CONFIG_REGISTRY.model.applies }
      : { key: 'model', value: null, origin: 'none', applies: CONFIG_REGISTRY.model.applies },
    effort: seat.effort !== undefined
      ? { key: 'effort', value: seat.effort, origin: 'team file', applies: CONFIG_REGISTRY.effort.applies }
      : { key: 'effort', value: null, origin: 'none', applies: CONFIG_REGISTRY.effort.applies },
    nickname: seat.nickname !== undefined
      ? { key: 'nickname', value: seat.nickname, origin: 'team file', applies: CONFIG_REGISTRY.nickname.applies }
      : { key: 'nickname', value: null, origin: 'none', applies: CONFIG_REGISTRY.nickname.applies },
    delivery_order: seat.deliveryOrder !== undefined
      ? { key: 'delivery_order', value: [...seat.deliveryOrder], origin: 'team file', applies: CONFIG_REGISTRY.delivery_order.applies }
      : teamDeliveryOrder !== null
        ? { key: 'delivery_order', value: [...teamDeliveryOrder], origin: 'team default', applies: CONFIG_REGISTRY.delivery_order.applies }
        : { key: 'delivery_order', value: [...DELIVERY_ORDER.fallback], origin: 'default', applies: CONFIG_REGISTRY.delivery_order.applies },
    human: seat.human === true
      ? { key: 'human', value: true, origin: 'team file', applies: CONFIG_REGISTRY.human.applies }
      : { key: 'human', value: false, origin: 'default', applies: CONFIG_REGISTRY.human.applies },
  };
  return CONFIG_KEYS.map((key) => rows[key]);
}
