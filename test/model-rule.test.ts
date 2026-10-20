// Policies rules 10 and 11: the model-rule grammar, its catalogue row, and swap-wait-seconds.
import { describe, expect, test } from 'bun:test';
import {
  formatModelRule,
  modelRuleAllows,
  modelRuleEntryFor,
  modelRuleProblem,
  parseModelRule,
  POLICY_CATALOGUE,
  resolvePolicy,
  type Policy,
} from '../src/policy/index.ts';

describe('model-rule grammar', () => {
  test('parses the owner example and round-trips canonically', () => {
    const raw = 'orchestrator=anthropic; architect=anthropic; *=!anthropic';
    const entries = parseModelRule(raw);
    expect(entries).toEqual([
      { subject: 'orchestrator', allow: true, labs: ['anthropic'] },
      { subject: 'architect', allow: true, labs: ['anthropic'] },
      { subject: '*', allow: false, labs: ['anthropic'] },
    ]);
    expect(formatModelRule(entries!)).toBe(raw);
  });

  test('a blank value is no rule and does not parse as one', () => {
    expect(parseModelRule('')).toBeNull();
    expect(parseModelRule('   ')).toBeNull();
    expect(parseModelRule(undefined)).toBeNull();
    expect(parseModelRule(['a=b'])).toBeNull();
  });

  test('lab words are compared in lowercase and + joins a list', () => {
    const entries = parseModelRule('builder=ANTHROPIC+DeepSeek')!;
    expect(entries).toEqual([{ subject: 'builder', allow: true, labs: ['anthropic', 'deepseek'] }]);
    expect(modelRuleAllows(entries, { name: 'builder', vendor: 'anthropic' })).toBe(true);
    expect(modelRuleAllows(entries, { name: 'builder', vendor: 'moonshot' })).toBe(false);
  });

  test('a seat name beats a role, and a role beats *', () => {
    const entries = parseModelRule('*=!anthropic; builder=openai; seat-3=anthropic')!;
    expect(modelRuleEntryFor(entries, { name: 'seat-3', role: 'builder' })).toEqual(entries[2]!);
    expect(modelRuleEntryFor(entries, { name: 'seat-4', role: 'builder' })).toEqual(entries[1]!);
    expect(modelRuleEntryFor(entries, { name: 'seat-5', role: 'operator' })).toEqual(entries[0]!);
    expect(modelRuleAllows(entries, { name: 'seat-5', role: 'operator', vendor: 'anthropic' })).toBe(false);
    expect(modelRuleAllows(entries, { name: 'seat-5', role: 'operator', vendor: 'openai' })).toBe(true);
  });

  test('a seat no entry names is allowed', () => {
    const entries = parseModelRule('orchestrator=anthropic')!;
    expect(modelRuleAllows(entries, { name: 'builder-1', role: 'builder', vendor: 'deepseek' })).toBe(true);
  });

  test('a negated entry refuses only the labs it names', () => {
    const entries = parseModelRule('*=!anthropic+!openai')!;
    expect(modelRuleAllows(entries, { name: 'x', vendor: 'anthropic' })).toBe(false);
    expect(modelRuleAllows(entries, { name: 'x', vendor: 'openai' })).toBe(false);
    expect(modelRuleAllows(entries, { name: 'x', vendor: 'google' })).toBe(true);
  });

  test('malformed values are refused with an entry-naming reason', () => {
    const cases: Array<[unknown, RegExp]> = [
      ['', /unset it instead/],
      ['no-equals', /must read/],
      ['a/b=c', /names the subject/],
      ['a=', /empty lab word/],
      ['a=b;', /empty entry/],
      ['*=anthropic+!openai', /mixes allowed and refused/],
      ['*=!anthropic+!anthropic', /names the lab "anthropic" twice/],
      ['*=!', /not a vendor word/],
      ['a=b; a=c', /names "a" twice/],
      [['a=b'], /not a list|one line/],
    ];
    for (const [raw, reason] of cases) {
      expect(modelRuleProblem(raw)).toMatch(reason);
      expect(parseModelRule(raw)).toBeNull();
    }
    expect(modelRuleProblem('a=b; c=!d+!e')).toBeNull();
  });
});

describe('model-rule as a policy', () => {
  test('the catalogue row is enforced at entity level only, defaulting to no rule', () => {
    const spec = POLICY_CATALOGUE['model-rule'];
    expect(spec.kind).toBe('enforced');
    expect(spec.levels).toEqual(['entity']);
    expect(spec.defaultValue).toBe('');
    expect(spec.gateLifting).toBe(false);
    expect(spec.parseValue('  builder = Openai  ')).toBe('builder=openai');
    expect(spec.parseValue('')).toBeNull();
  });

  test('a team-level declaration is refused at load, naming the allowed level', () => {
    const result = resolvePolicy('model-rule', [
      { name: 'model-rule', value: '*=anthropic', level: 'team', setter: 'owner', date: '2026-10-19T00:00:00Z', kind: 'enforced' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals[0]!.message).toContain('may not be set at level team');
  });

  test('an entity declaration is the value in force, canonicalized', () => {
    const result = resolvePolicy('model-rule', [
      { name: 'model-rule', value: 'A=Anthropic+deepseek', level: 'entity', setter: 'owner', date: '2026-10-19T00:00:00Z', kind: 'enforced' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective.value).toBe('A=anthropic+deepseek');
    expect(result.effective.level).toBe('entity');
  });

  test('an unparseable stored value is refused at load with its reason', () => {
    const result = resolvePolicy('model-rule', [
      { name: 'model-rule', value: '*=anthropic+!openai', level: 'entity', setter: 'owner', date: '2026-10-19T00:00:00Z', kind: 'enforced' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals[0]!.message).toMatch(/mixes allowed and refused/);
  });
});

describe('swap-wait-seconds', () => {
  test('ships at 30 minutes and reads a shorter word as the tighter one', () => {
    const spec = POLICY_CATALOGUE['swap-wait-seconds'];
    expect(spec.kind).toBe('enforced');
    expect(spec.levels).toEqual(['entity', 'project', 'team', 'seat']);
    expect(spec.defaultValue).toBe(1800);
    expect(spec.isWithin(600, 1800)).toBe(true);
    expect(spec.isWithin(1800, 1800)).toBe(true);
    expect(spec.isWithin(1801, 1800)).toBe(false);
    expect(spec.parseValue('600s')).toBe(600);
    expect(spec.parseValue('0')).toBeNull();
    expect(spec.parseValue('-5')).toBeNull();
  });

  test('the chain tightens: a team may shorten it and may not lengthen it', () => {
    const entity: Policy = {
      name: 'swap-wait-seconds', value: 1800, level: 'entity', setter: 'owner', date: '2026-10-19T00:00:00Z', kind: 'enforced',
    };
    const shortened = resolvePolicy<number>('swap-wait-seconds', [
      entity,
      { name: 'swap-wait-seconds', value: 600, level: 'team', setter: 'owner', date: '2026-10-19T01:00:00Z', kind: 'enforced' },
    ]);
    expect(shortened.ok).toBe(true);
    if (!shortened.ok) return;
    expect(shortened.effective.value).toBe(600);
    expect(shortened.effective.level).toBe('team');

    const lengthened = resolvePolicy<number>('swap-wait-seconds', [
      entity,
      { name: 'swap-wait-seconds', value: 3600, level: 'team', setter: 'owner', date: '2026-10-19T01:00:00Z', kind: 'enforced' },
    ]);
    expect(lengthened.ok).toBe(false);
    if (lengthened.ok) return;
    expect(lengthened.refusals[0]!.kind).toBe('loosening');
    expect(lengthened.refusals[0]!.message).toContain('level team');
  });

  test('with no declaration it resolves to 1800 at the default level', () => {
    const result = resolvePolicy<number>('swap-wait-seconds', []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective.value).toBe(1800);
    expect(result.effective.level).toBe('default');
  });
});
