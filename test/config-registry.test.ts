import { describe, expect, test } from 'bun:test';
import {
  CONFIG_KEYS,
  CONFIG_LEVELS,
  CONFIG_REGISTRY,
  configKeysAt,
  getConfigSpec,
} from '../src/config/registry.ts';
import { DELIVERY_ORDER } from '../src/settings/inherit.ts';

describe('the approved minimum', () => {
  test('is exactly the five seat keys, in the read order', () => {
    expect([...CONFIG_KEYS]).toEqual(['model', 'effort', 'nickname', 'delivery_order', 'human']);
    expect(Object.keys(CONFIG_REGISTRY).sort()).toEqual([...CONFIG_KEYS].sort());
  });

  test('every entry names its own key', () => {
    for (const key of CONFIG_KEYS) expect(CONFIG_REGISTRY[key].key).toBe(key);
  });

  test('every key is set at the seat and nowhere yet', () => {
    for (const key of CONFIG_KEYS) expect(CONFIG_REGISTRY[key].levels).toEqual(['seat']);
    expect(configKeysAt('seat')).toEqual([...CONFIG_KEYS]);
    for (const level of ['entity', 'project', 'team'] as const) expect(configKeysAt(level)).toEqual([]);
  });

  test('the level vocabulary matches the policy levels', () => {
    expect([...CONFIG_LEVELS]).toEqual(['entity', 'project', 'team', 'seat']);
  });
});

describe('what limits a key', () => {
  test('the model is governed by the model policy', () => {
    expect(CONFIG_REGISTRY.model.governedBy).toBe('allowed-models');
  });

  test('the delivery order is governed by the delivery-order policy', () => {
    expect(CONFIG_REGISTRY.delivery_order.governedBy).toBe('delivery-order');
  });

  test('effort, nickname and human name no policy', () => {
    expect(CONFIG_REGISTRY.effort.governedBy).toBeUndefined();
    expect(CONFIG_REGISTRY.nickname.governedBy).toBeUndefined();
    expect(CONFIG_REGISTRY.human.governedBy).toBeUndefined();
  });
  test('every key says what it accepts', () => {
    expect(CONFIG_REGISTRY.model.allowed).toBe("a model the seat's profile and the allowed-models policy accept");
    expect(CONFIG_REGISTRY.effort.allowed).toBe("one of the CLI profile's effort levels");
    expect(CONFIG_REGISTRY.nickname.allowed).toBe('unique in the team, never lead');
    expect(CONFIG_REGISTRY.delivery_order.allowed).toBe('delivery legs, tighten only');
    expect(CONFIG_REGISTRY.human.allowed).toBe('true or false');
  });
});

describe('defaults and application', () => {
  test('the delivery order falls back to the release order', () => {
    expect(CONFIG_REGISTRY.delivery_order.fallback).toEqual(DELIVERY_ORDER.fallback);
    expect(CONFIG_REGISTRY.delivery_order.fallback).toEqual(['mcp-inbox', 'drop', 'typed']);
  });

  test('human falls back to false, and effort, nickname and model have no fallback', () => {
    expect(CONFIG_REGISTRY.human.fallback).toBe(false);
    expect(CONFIG_REGISTRY.model.fallback).toBeUndefined();
    expect(CONFIG_REGISTRY.effort.fallback).toBeUndefined();
    expect(CONFIG_REGISTRY.nickname.fallback).toBeUndefined();
  });

  test('runtime keys wait for a restart that resumes; routing and identity apply at once', () => {
    expect(CONFIG_REGISTRY.model.applies).toBe('restart-resume');
    expect(CONFIG_REGISTRY.effort.applies).toBe('restart-resume');
    expect(CONFIG_REGISTRY.nickname.applies).toBe('at-once');
    expect(CONFIG_REGISTRY.delivery_order.applies).toBe('at-once');
    expect(CONFIG_REGISTRY.human.applies).toBe('at-once');
  });
});

describe('lookup', () => {
  test('a known key resolves to its entry', () => {
    expect(getConfigSpec('delivery_order')).toBe(CONFIG_REGISTRY.delivery_order);
  });

  test('a word outside the registry resolves to null', () => {
    expect(getConfigSpec('allowed-models')).toBeNull();
    expect(getConfigSpec('')).toBeNull();
    expect(getConfigSpec('Model')).toBeNull();
  });

  test('a prototype member name is not a setting', () => {
    // A command line can hand in any word; the table's prototype must not answer for it.
    for (const word of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(getConfigSpec(word)).toBeNull();
    }
  });
});
