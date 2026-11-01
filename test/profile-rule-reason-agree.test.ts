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
});
