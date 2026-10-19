import { describe, expect, test } from 'bun:test';
import { checkConfigValue } from '../src/config/guard.ts';
import type { ConfigValue } from '../src/config/registry.ts';
import { resolvePolicyChain } from '../src/policy/index.ts';

/** An empty chain: every catalogue policy at its release default. */
const OPEN = resolvePolicyChain({});

/** One team declaration of the delivery order, tightening it to two legs. */
const TIGHT = resolvePolicyChain({
  team: {
    ok: true,
    level: 'team',
    target: 'acme',
    policies: [{
      name: 'delivery-order',
      value: ['mcp-inbox', 'typed'],
      level: 'team',
      setter: 'owner',
      date: '2026-10-01T00:00:00Z',
      kind: 'enforced',
    }],
  },
});

/** A chain with an unreadable source: nothing about it can be trusted. */
const BROKEN = resolvePolicyChain({
  team: { ok: false, level: 'team', why: 'the team policy file does not verify' },
});

function why(check: ReturnType<typeof checkConfigValue>): string {
  if (check.ok) throw new Error('expected a refusal');
  return check.refusals[0]!.why;
}

describe('a key no policy governs', () => {
  test('is admitted while the chain resolves', () => {
    expect(checkConfigValue('effort', 'high', OPEN)).toEqual({ ok: true });
    expect(checkConfigValue('nickname', 'Atlas', OPEN)).toEqual({ ok: true });
    expect(checkConfigValue('human', true, OPEN)).toEqual({ ok: true });
  });

  test('is admitted even when the chain does not resolve, because no limit was expected', () => {
    expect(checkConfigValue('effort', 'high', BROKEN)).toEqual({ ok: true });
    expect(checkConfigValue('nickname', 'Atlas', BROKEN)).toEqual({ ok: true });
  });

  test('the model is unconstrained until the model policy ships, and the answer says so', () => {
    // `ok` alone would read as an enforced pass; the classification names the policy that will
    // govern the key once the catalogue ships it, on a resolved chain and a broken one alike.
    expect(checkConfigValue('model', 'claude-opus-5-5', OPEN)).toEqual({
      ok: true,
      status: 'unconstrained',
      policy: 'allowed-models',
    });
    expect(checkConfigValue('model', 'claude-opus-5-5', BROKEN)).toEqual({
      ok: true,
      status: 'unconstrained',
      policy: 'allowed-models',
    });
  });
});

describe('the delivery order under its policy', () => {
  test('the release order is admitted', () => {
    expect(checkConfigValue('delivery_order', ['mcp-inbox', 'drop', 'typed'], OPEN)).toEqual({ ok: true });
  });

  test('dropping or reordering a leg is within the order in force', () => {
    expect(checkConfigValue('delivery_order', ['mcp-inbox', 'typed'], OPEN)).toEqual({ ok: true });
    expect(checkConfigValue('delivery_order', ['typed', 'mcp-inbox'], OPEN)).toEqual({ ok: true });
  });

  test('naming the native leg is the one addition the policy admits', () => {
    expect(checkConfigValue('delivery_order', ['native', 'mcp-inbox', 'typed'], OPEN)).toEqual({ ok: true });
  });

  test('a leg the order in force does not have is refused, naming the policy and its level', () => {
    expect(why(checkConfigValue('delivery_order', ['mcp-inbox', 'drop', 'typed'], TIGHT))).toBe(
      'the value "mcp-inbox, drop, typed" loosens policy "delivery-order" in force at level team ("mcp-inbox, typed")',
    );
  });

  test('the same word at the tightened level is admitted', () => {
    expect(checkConfigValue('delivery_order', ['mcp-inbox', 'typed'], TIGHT)).toEqual({ ok: true });
  });

  test('an empty order is not a word the policy knows', () => {
    expect(why(checkConfigValue('delivery_order', [], OPEN))).toBe(
      'the value is not one policy "delivery-order" admits',
    );
  });

  test('a duplicate leg is not a word the policy knows', () => {
    expect(why(checkConfigValue('delivery_order', ['mcp-inbox', 'mcp-inbox'], OPEN))).toBe(
      'the value is not one policy "delivery-order" admits',
    );
  });

  test('a leg this release does not carry is refused with the policy\'s own reason', () => {
    const unavailable = ['socket-accepted'] as unknown as ConfigValue;
    expect(why(checkConfigValue('delivery_order', unavailable, OPEN))).toBe(
      'the value is not one policy "delivery-order" admits: socket-accepted is not available in this release',
    );
  });
});

describe('a chain that does not resolve', () => {
  test('refuses a governed key rather than reading no limit into it', () => {
    const check = checkConfigValue('delivery_order', ['mcp-inbox', 'typed'], BROKEN);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusals).toHaveLength(1);
    expect(check.refusals[0]!.key).toBe('delivery_order');
    expect(check.refusals[0]!.policy).toBe('delivery-order');
    expect(check.refusals[0]!.why).toBe(
      'the policy chain cannot be read or verified (team: policy source cannot be read or verified (the team policy file does not verify)); the value is not admitted',
    );
  });
});

describe('a resolved chain that lacks the governing policy', () => {
  test('refuses, because a missing limit is an inconsistency, not permission', () => {
    const check = checkConfigValue('delivery_order', ['mcp-inbox'], {
      ok: true,
      policies: {},
      expired: [],
      devModeGoverned: false,
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusals[0]!.why).toBe(
      'the policy chain did not resolve "delivery-order"; the value is not admitted',
    );
  });
});
