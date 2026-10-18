// Part C: the settings are policies of the closed enforced vocabulary (Kernel amendment 02).
// Each setting spec names its catalogue policy in canonical kebab-case while the snake_case
// spelling every team file and registry record is written in stays a load-time alias. The
// catalogue owns each setting's values, their order and the release default; the settings'
// inheritance loop reads them, and an expired word is unset at its level.
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_STATE_THRESHOLDS,
  DELIVERY_LEGS,
  DELIVERY_ORDER,
  SEATS_CROSS_TEAMS,
  STATE_THRESHOLDS,
  type NumberDeclaration,
} from '../src/settings/inherit.ts';
import { resolveNumberSetting } from '../src/settings/resolve.ts';
import { getPolicySpec, normalizePolicyName } from '../src/policy/index.ts';

/** Every release setting part C folds in, with the spelling the files were written in. */
const SETTINGS = [
  { what: 'seats cross teams', key: SEATS_CROSS_TEAMS.name, policy: 'seats-cross-teams', fallback: 'off' },
  { what: 'trace window', key: STATE_THRESHOLDS.trace_window_seconds.name, policy: 'state-trace-window-seconds', fallback: 120 },
  { what: 'blind window', key: STATE_THRESHOLDS.blind_after_seconds.name, policy: 'state-blind-after-seconds', fallback: 300 },
  { what: 'hook window', key: STATE_THRESHOLDS.hook_working_seconds.name, policy: 'state-hook-working-seconds', fallback: 120 },
  { what: 'idle lead', key: STATE_THRESHOLDS.idle_lead_seconds.name, policy: 'liveness-idle-lead-seconds', fallback: 300 },
  { what: 'idle owner', key: STATE_THRESHOLDS.idle_owner_seconds.name, policy: 'liveness-idle-owner-seconds', fallback: 900 },
  { what: 'delivery order', key: DELIVERY_ORDER.name, policy: 'delivery-order', fallback: DELIVERY_ORDER.fallback },
] as const;

/** The catalogue policy a spec names, once the fold has put it there. */
function policyOf(spec: object): string | undefined {
  return (spec as { policy?: string }).policy;
}

/** A declaration carrying an expiry the current declaration type does not name yet. */
function withExpiry(declaration: NumberDeclaration, expiry: string): NumberDeclaration {
  return { ...declaration, expiry } as unknown as NumberDeclaration;
}

describe('the settings are catalogue policies', () => {
  test('each spec names its canonical policy, and the old snake_case key is its alias', () => {
    for (const setting of SETTINGS) {
      expect(policyOf(policySpec(setting.key))).toBe(setting.policy);
      expect(normalizePolicyName(setting.policy)).toBe(setting.policy); // canonical kebab-case
      expect(getPolicySpec(setting.policy)).not.toBeNull(); // a policy of the closed vocabulary
      expect(normalizePolicyName(setting.key)).toBe(setting.policy); // the file's spelling is an alias
    }
  });

  test('every release default is the catalogue default', () => {
    for (const setting of SETTINGS) {
      expect(getPolicySpec(setting.policy)?.defaultValue).toEqual(setting.fallback);
    }
  });

  test('the delivery order ships mcp-inbox, then drop, then typed', () => {
    // The literal the release ships. The catalogue default and the setting's fallback are both
    // this value, so comparing them to each other would pin nothing.
    expect(DELIVERY_ORDER.fallback).toEqual(['mcp-inbox', 'drop', 'typed']);
  });

  test('the delivery legs are the full vocabulary, wider than the default order', () => {
    expect(DELIVERY_LEGS).toEqual(['native', 'mcp-inbox', 'typed', 'drop']);
    for (const leg of DELIVERY_ORDER.fallback) expect(DELIVERY_LEGS).toContain(leg);
  });

  test('the five liveness windows are all in scope', () => {
    expect(DEFAULT_STATE_THRESHOLDS).toEqual({
      idle_lead_seconds: 300,
      idle_owner_seconds: 900,
      blind_after_seconds: 300,
      trace_window_seconds: 120,
      hook_working_seconds: 120,
    });
    expect(Object.keys(STATE_THRESHOLDS).sort()).toEqual([
      'blind_after_seconds',
      'hook_working_seconds',
      'idle_lead_seconds',
      'idle_owner_seconds',
      'trace_window_seconds',
    ]);
  });
});

/** The setting spec behind a report key, for the `policy` pin above. */
function policySpec(key: string): object {
  for (const spec of [SEATS_CROSS_TEAMS, DELIVERY_ORDER, ...Object.values(STATE_THRESHOLDS)]) {
    if (spec.name === key) return spec;
  }
  throw new Error(`no setting spec named ${key}`);
}

describe('the catalogue the settings read their values through', () => {
  test('an expired word counts as unset at its level (ruling 5)', () => {
    const expired = withExpiry({ level: 'team', value: 60 }, '2020-01-01T00:00:00.000Z');
    const resolution = resolveNumberSetting(STATE_THRESHOLDS.hook_working_seconds, [expired]);
    expect(resolution.value).toBe(120);
    expect(resolution.source).toBeNull();
    expect(resolution.refused).toEqual([]);
  });

  test('a live word still sets the window', () => {
    const live = withExpiry({ level: 'team', value: 60 }, '2999-01-01T00:00:00.000Z');
    expect(resolveNumberSetting(STATE_THRESHOLDS.hook_working_seconds, [live]).value).toBe(60);
  });

  test('an expiry this build cannot read is set aside, as the policy resolver sets it aside', () => {
    const broken = withExpiry({ level: 'team', value: 60 }, 'not-a-date');
    const resolution = resolveNumberSetting(STATE_THRESHOLDS.hook_working_seconds, [broken]);
    expect(resolution.value).toBe(120);
    expect(resolution.source).toBeNull();
    expect(resolution.refused).toEqual([{ level: 'team', value: 60, expiry: 'not-a-date', inherited: 120 }]);
  });
});
