// The settings registry of OD-20261018-17/-18 at its approved 0.5.3 minimum: the five keys the
// decision names for a seat — `model`, `effort`, `nickname`, `delivery_order`, `human` — and
// nothing the decision leaves open. The keys a level above a seat may set, bulk changes and the
// team file's retirement are not decided here and are not in this table; the table says what a
// setting is, where it may be set, what limits it, and how a change applies.
//
// One table is read by every side of the family: `team config` above a seat, `team settings` for
// one seat, the composition `team seat` and the read view, and the write guard. A key is added
// here once, never as a command of its own. The runtime keys (`model`, `effort`) take a restart
// that resumes the conversation on a live seat, and the next turn when the seat is headless; the
// routing and identity keys (`nickname`, `delivery_order`, `human`) apply at once, because the
// record the next send or the next admission reads is the one that changes.

import { DELIVERY_ORDER, type DeliveryLeg } from '../settings/inherit.ts';

/** The levels a setting may be set at. The approved minimum sets the seat's own settings; the
 *  table keeps the vocabulary of `src/policy/types.ts` so a wider surface later needs no new
 *  level names. */
export const CONFIG_LEVELS = ['entity', 'project', 'team', 'seat'] as const;
export type ConfigLevel = (typeof CONFIG_LEVELS)[number];

/** The approved minimum, in the order a read shows them. */
export const CONFIG_KEYS = ['model', 'effort', 'nickname', 'delivery_order', 'human'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** A setting's value: the words a launch takes, a delivery order's legs, or a boolean. */
export type ConfigValue = string | boolean | readonly DeliveryLeg[];

/**
 * How a change reaches the running seat. A runtime key is read at launch, so it applies to the
 * next launch — on a live seat, a restart that resumes the conversation; headless, the next turn.
 * An identity or routing key is read by the next send or admission, so it applies at once.
 */
export type ApplyKind = 'restart-resume' | 'at-once';

export type ConfigSpec = {
  key: ConfigKey;
  /** The levels that may set this key. The approved minimum is the seat's own settings. */
  levels: readonly ConfigLevel[];
  type: 'model' | 'effort' | 'nickname' | 'order' | 'boolean';
  /**
   * The catalogue policy that limits this key, when the catalogue ships one. The guard reads the
   * policy through the catalogue at check time, so a policy that lands later (the model policy the
   * 0.5.3 work adds) governs from the moment it is in `POLICY_CATALOGUE`, without a change here.
   */
  governedBy?: string;
  /**
   * The value an unset key carries, when the registry has one. Undefined means no value of this
   * layer decides: the profile or the launcher chooses the effort and the model at launch, and the
   * seat's name stands for the nickname. A read reports those as unset, never as a guessed value.
   */
  fallback?: ConfigValue;
  applies: ApplyKind;
};

export const CONFIG_REGISTRY: Readonly<Record<ConfigKey, ConfigSpec>> = {
  model: {
    key: 'model',
    levels: ['seat'],
    type: 'model',
    governedBy: 'allowed-models',
    applies: 'restart-resume',
  },
  effort: {
    key: 'effort',
    levels: ['seat'],
    type: 'effort',
    applies: 'restart-resume',
  },
  nickname: {
    key: 'nickname',
    levels: ['seat'],
    type: 'nickname',
    applies: 'at-once',
  },
  delivery_order: {
    key: 'delivery_order',
    levels: ['seat'],
    type: 'order',
    governedBy: 'delivery-order',
    fallback: DELIVERY_ORDER.fallback,
    applies: 'at-once',
  },
  human: {
    key: 'human',
    levels: ['seat'],
    type: 'boolean',
    fallback: false,
    applies: 'at-once',
  },
};

/** The spec for a key, or null for a word this registry does not hold. A caller that takes a key
 *  from a command line asks first; a caller that holds a `ConfigKey` reads the table directly. */
export function getConfigSpec(key: string): ConfigSpec | null {
  return (CONFIG_REGISTRY as Readonly<Record<string, ConfigSpec>>)[key] ?? null;
}

/** The keys a level may set, in the read order. */
export function configKeysAt(level: ConfigLevel): ConfigKey[] {
  return CONFIG_KEYS.filter((key) => CONFIG_REGISTRY[key].levels.includes(level));
}
