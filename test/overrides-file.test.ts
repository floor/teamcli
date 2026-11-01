import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quotaFor } from '../src/profiles/profile.ts';
import { mergeScreen, overridesPath, parseOverrides, quotaWith } from '../src/profiles/overrides.ts';
import { storePath } from '../src/store/store.ts';
import { screenData } from '../src/watch/screen.ts';

const ADDED = `format: 1
profiles:
  claude-code:
    screen:
      permission:
        - any: ['Owner dialog']
    quota:
      - account: anthropic
        match: '\\bL: ([0-9]+)% \\(([0-9hm]+)\\)'
        used: '{1}%'
        resets: '{2}'
        window: session
`;

describe('the override file', () => {
  test('lives beside the approval, in the store for this root', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'team-overrides-')));
    try {
      const root = join(home, 'project');
      expect(overridesPath('acme', root, home)).toBe(join(storePath('acme', root, home), 'overrides.yaml'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('adds dialog patterns and quota patterns to a named profile', () => {
    const parsed = parseOverrides(ADDED);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.profiles.map((profile) => profile.cli)).toEqual(['claude-code']);
    const profile = parsed.profiles[0];
    expect(profile?.screen.permission?.rules).toHaveLength(1);
    expect(profile?.quota.map((pattern) => pattern.account)).toEqual(['anthropic']);
    expect(profile?.quota.map((pattern) => pattern.window)).toEqual(['session']);
    expect(profile?.quota.map((pattern) => pattern.side)).toEqual(['used']);
  });

  test('keeps every shipped rule and every shipped quota pattern', () => {
    const parsed = parseOverrides(ADDED.replace('claude-code', 'codex'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const base = screenData('codex');
    const added = parsed.profiles[0];
    if (!base || !added) throw new Error('codex');
    const merged = mergeScreen(base, added);
    expect(merged.composer).toBe(base.composer);
    expect(merged.chrome).toBe(base.chrome);
    expect(merged.permission?.rules.length).toBe((base.permission?.rules.length ?? 0) + 1);
    expect(merged.permission?.rules.slice(0, base.permission?.rules.length)).toEqual(base.permission?.rules);
    const quota = quotaWith('codex', parsed.profiles);
    expect(quota.slice(0, quotaFor('codex').length)).toEqual([...quotaFor('codex')]);
    expect(quota.length).toBe(quotaFor('codex').length + 1);
  });

  test.each([
    ['a composer', '      composer:\n        mode: status-last\n', 'unknown key "composer"'],
    ['chrome', '      chrome: ["^x$"]\n', 'unknown key "chrome"'],
    ['a working stage', '      working:\n        - any: ["x"]\n', 'unknown key "working"'],
    ['a fold', '      fold: "hidden"\n', 'unknown key "fold"'],
    ['footers', '      footers: ["^x$"]\n', 'unknown key "footers"'],
    ['a code module', '      code: "screens.ts"\n', 'unknown key "code"'],
    ['a launch line', '    binary: claude\n', 'unknown key "binary"'],
    ['screen_module on profile', '    screen_module: "hatch.ts"\n', 'unknown key "screen_module"'],
    ['screen_module in screen', '      screen_module: "hatch.ts"\n', 'unknown key "screen_module"'],
  ])('refuses %s, with the line', (_name, body, message) => {
    const text = body.startsWith('    binary') || body.startsWith('    screen_module')
      ? `format: 1\nprofiles:\n  claude-code:\n${body}`
      : `format: 1\nprofiles:\n  claude-code:\n    screen:\n${body}      permission:\n        - any: ['x']\n`;
    const parsed = parseOverrides(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors[0]?.message).toBe(message);
    expect(parsed.errors[0]?.line).toBeGreaterThan(0);
  });

  test('refuses a case flag on a stage and on a pattern', () => {
    const stage = parseOverrides(`format: 1
profiles:
  claude-code:
    screen:
      permission:
        ignore_case: true
        rules:
          - any: ['x']
`);
    expect(stage.ok).toBe(false);
    if (!stage.ok) expect(stage.errors[0]?.message).toBe('an override adds a non-empty list of patterns');

    const pattern = parseOverrides(`format: 1
profiles:
  claude-code:
    screen:
      permission:
        - any:
            - match: 'x'
              ignore_case: true
`);
    expect(pattern.ok).toBe(false);
    if (!pattern.ok) expect(pattern.errors[0]?.message).toBe('unknown key "ignore_case"');
  });

  test('refuses a rule of narrowing keys alone, as a shipped profile refuses it', () => {
    // `live`, `at_composer`, `on_footer` and `without_rule: false` narrow a match a primitive
    // already makes; a rule built of them alone would pass every screen. The schema refuses
    // it, and the loader refuses the override that carries it, with the file's line.
    const parsed = parseOverrides(`format: 1
profiles:
  claude-code:
    screen:
      permission:
        - live: false
`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors[0]?.message).toBe('a rule needs a matching primitive: "any", "all", "footer", "below_last_rule", "none_after", "only_after", "block", or "without_rule: true"');
    expect(parsed.errors[0]?.line).toBe(6);
  });

  test('refuses a profile this version does not ship', () => {
    const parsed = parseOverrides(`format: 1
profiles:
  constructor:
    screen:
      question:
        - any: ['x']
`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]?.message).toBe('unknown profile "constructor"');
  });
});
