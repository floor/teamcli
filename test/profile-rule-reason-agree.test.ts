// `reason` labels a rate-limit match — a sentence carried into blocked status and the watch's
// report — and it never makes a rule match by itself. A rule built of `reason` alone has no
// primitive, so it would fall through every check and pass every screen; the schema refuses it,
// and the loader must refuse it too, in the same places. These scenes were red at f9b82b517,
// where the loader loaded the rule and reported a rate limit on any screen.
import { describe, expect, test } from 'bun:test';
import { loadScreen } from '../src/watch/screen-file.ts';

const profile = (screen: string): string => `
format: 1
cli: sample
screen:
${screen}
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`;

describe('a rate-limit reason labels a match, and is not one', () => {
  test('a rule of only reason is refused, as the schema refuses it', () => {
    expect(() =>
      loadScreen(profile(`  rate_limit:
    - reason: 'needs a choice'`)),
    ).toThrow('"reason" is not a primitive: a rule of only "reason" would match every screen');
  });

  test('the map form refuses the same rule', () => {
    expect(() =>
      loadScreen(profile(`  rate_limit:
    reason: 'switch the model'
    rules:
      - reason: 'needs a choice'`)),
    ).toThrow('"reason" is not a primitive');
  });

  test('a reason beside a primitive loads, on the rule and on the stage', () => {
    const data = loadScreen(
      profile(`  rate_limit:
    reason: 'switch the model'
    rules:
      - any: ['^Usage limit reached']
        reason: 'needs a choice'`),
    );
    expect(data.rate_limit?.reason).toBe('switch the model');
    expect(data.rate_limit?.rules[0]?.reason).toBe('needs a choice');
    expect(data.rate_limit?.rules[0]?.any).toBeDefined();
  });

  test('a reason on another stage is refused, in the loader and the schema alike', () => {
    for (const stage of ['trust', 'permission', 'provider_error', 'working']) {
      expect(() =>
        loadScreen(profile(`  ${stage}:
    - any: ['^Do you trust']
      reason: 'needs a choice'`)),
      ).toThrow('unknown key "reason"');
    }
  });

  // A rule matches on a primitive: `any`, `all`, `footer`, `below_last_rule`, `none_after`,
  // `only_after`, `block`, or `without_rule: true`. Every other key narrows a match one of
  // those already makes, so a rule built of them alone passes every screen. The schema's
  // `$defs.rule` anyOf names the same set; these scenes hold the loader to it.
  test('a rule of narrowing keys alone is refused, with or without reason', () => {
    const rule = (stage: string, lines: string[]): string => profile(`  ${stage}:\n    - ${lines.join('\n      ')}`);
    const inert: [string, string[]][] = [
      ['on_footer', ['on_footer: true']],
      ['live', ['live: false']],
      ['at_composer', ['at_composer: false']],
      ['without_rule', ['without_rule: false']],
    ];
    for (const [name, lines] of inert) {
      expect(() => loadScreen(rule('trust', lines)), `${name} alone must be refused`).toThrow('a rule needs a matching primitive');
    }
    const reasoned: [string, string[]][] = [
      ['reason and live', ["reason: 'needs a choice'", 'live: false']],
      ['reason and at_composer', ["reason: 'needs a choice'", 'at_composer: false']],
      ['reason and on_footer', ["reason: 'needs a choice'", 'on_footer: true']],
      ['reason and without_rule', ["reason: 'needs a choice'", 'without_rule: false']],
    ];
    for (const [name, lines] of reasoned) {
      expect(() => loadScreen(rule('rate_limit', lines)), `${name} alone must be refused`).toThrow('a rule needs a matching primitive');
    }
  });

  test('without_rule: true matches on its own, and a reason may ride it', () => {
    const trust = loadScreen(profile(`  trust:
    - without_rule: true`));
    expect(trust.trust?.rules[0]?.withoutRule).toBe(true);
    const rate = loadScreen(profile(`  rate_limit:
    - without_rule: true
      reason: 'needs a choice'`));
    expect(rate.rate_limit?.rules[0]?.withoutRule).toBe(true);
    expect(rate.rate_limit?.rules[0]?.reason).toBe('needs a choice');
  });
});
