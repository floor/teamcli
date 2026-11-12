// The model-drift policy (review finding 3, 2026-11-12): what a send does when its recipient runs
// another model than its signed record. `rule` (the default) needs the entity's model rule to name
// the seat and allow the observed lab; `deliver` lets every drift through; `hold` refuses all.
import { expect, test } from 'bun:test';
import { driftRefusal } from '../src/send/model-drift.ts';
import { parseModelRule } from '../src/policy/model-rule.ts';

const seat = { name: 'worker', role: 'builder' };
const claude = { model: 'Claude Opus', version: '5.5' };
const ruleOf = (text: string) => ({ kind: 'rule' as const, rule: text, entries: parseModelRule(text) ?? [] });

test('rule: no rule, or a rule that does not name the seat, is no permission', () => {
  expect(driftRefusal('rule', seat, claude, { kind: 'none' })).toContain('no entity model rule');
  expect(driftRefusal('rule', seat, claude, ruleOf('reviewer=anthropic'))).toContain('names no entry for this seat');
});

test('rule: a rule that names the seat and allows the lab lets the drift through; one that refuses it does not', () => {
  expect(driftRefusal('rule', seat, claude, ruleOf('builder=anthropic'))).toBeNull();
  expect(driftRefusal('rule', seat, claude, ruleOf('worker=anthropic+xai'))).toBeNull();
  expect(driftRefusal('rule', seat, claude, ruleOf('builder=deepseek'))).toContain('does not allow');
  expect(driftRefusal('rule', seat, claude, ruleOf('*=!anthropic'))).toContain('does not allow');
});

test('deliver lets any drift through, hold refuses every one', () => {
  expect(driftRefusal('deliver', seat, claude, { kind: 'none' })).toBeNull();
  expect(driftRefusal('hold', seat, claude, { kind: 'none' })).toContain('holds every drift');
});
