// The launchers TeamCLI ships: one per vendor CLI, configured by the seat's role and effort.
import { describe, expect, test } from 'bun:test';
import { isShippedLauncher, shippedClaudeSettings, shippedEnv, shippedLauncher, shippedLauncherIsReadOnly, shippedLauncherNames } from '../src/launchers/shipped.ts';
import { discover, resolveLaunch } from '../src/launchers/resolve.ts';

test('grok-build ships, and an unknown name does not', () => {
  expect(shippedLauncherNames()).toContain('grok-build');
  expect(isShippedLauncher('grok-build')).toBe(true);
  expect(isShippedLauncher('made-up')).toBe(false);
  expect(isShippedLauncher(undefined)).toBe(false);
  expect(isShippedLauncher('toString')).toBe(false);
  expect(shippedLauncher('made-up', {})).toBeNull();
});

test('a builder seat gets the always-approve line with the model named', () => {
  const made = shippedLauncher('grok-build', { role: 'builder' });
  expect(made?.argv).toEqual(['grok', '--trust', '--model', 'grok-4.7', '--no-subagents', '--always-approve']);
});

test('a reviewer seat gets the read-only line: no always-approve, writes, edits, git and bun denied', () => {
  const argv = shippedLauncher('grok-build', { role: 'reviewer' })?.argv ?? [];
  expect(argv).not.toContain('--always-approve');
  expect(argv.join(' ')).toContain('--permission-mode dontAsk');
  for (const rule of ['Write', 'Edit', 'Bash(git *)', 'Bash(bun *)']) {
    const at = argv.indexOf(rule);
    expect(at, rule).toBeGreaterThan(0);
    expect(argv.at(at - 1), rule).toBe('--deny');
  }
  expect(argv[argv.indexOf('Read') - 1]).toBe('--allow');
});

test('the seat\'s effort rides the line when it has one', () => {
  expect((shippedLauncher('grok-build', { role: 'builder', effort: 'high' })?.argv ?? []).slice(-2)).toEqual(['--effort', 'high']);
  expect(shippedLauncher('grok-build', { role: 'builder' })?.argv).not.toContain('--effort');
});

test('a shipped launcher passes the library\'s own validation and resolves to its argv', () => {
  const made = shippedLauncher('grok-build', { role: 'reviewer' });
  const found = discover([{ level: 'machine', files: { 'grok-build.yaml': made } }]);
  expect(found.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
  const resolved = resolveLaunch({ launcher: 'grok-build' }, found, {
    teamRoot: '/work/team', teamHome: '/work/team', cwd: '/work/team/seat', parentEnv: {}, existingPaths: [], seatNames: ['argus'],
  });
  expect(resolved.ok).toBe(true);
  if (resolved.ok) expect(resolved.argv.slice(0, 4)).toEqual(['grok', '--trust', '--model', 'grok-4.7']);
});

test('only a read-only seat on a shipped launcher goes without the sandbox profile', () => {
  expect(shippedLauncherIsReadOnly('grok-build', 'reviewer')).toBe(true);
  expect(shippedLauncherIsReadOnly('grok-build', 'builder')).toBe(false);
  expect(shippedLauncherIsReadOnly('grok-build', undefined)).toBe(false);
  expect(shippedLauncherIsReadOnly('some-file-launcher', 'reviewer')).toBe(false);
  expect(shippedLauncherIsReadOnly(undefined, 'reviewer')).toBe(false);
});

test('the model follows the seat\'s version, 4.7 when it names none', () => {
  expect(shippedLauncher('grok-build', { role: 'builder', version: '4.6' })?.argv).toContain('grok-4.6');
  expect(shippedLauncher('grok-build', { role: 'builder' })?.argv).toContain('grok-4.7');
  expect(shippedLauncher('grok-build', { role: 'builder', version: '4.7; rm' })?.argv).toContain('grok-4.7');
});

test('claude-code builds the Anthropic model id from the seat and skips the CLI prompts', () => {
  expect(shippedLauncher('claude-code', { model: 'Claude Opus', version: '5.5' })?.argv)
    .toEqual(['claude', '--model', 'claude-opus-5-5', '--dangerously-skip-permissions']);
  const reviewer = shippedLauncher('claude-code', { model: 'Claude Haiku', version: '5.5', role: 'tester' })?.argv ?? [];
  expect(reviewer).not.toContain('--dangerously-skip-permissions');
  expect(reviewer.join(' ')).toContain('--permission-mode dontAsk');
  expect(reviewer[reviewer.indexOf('--disallowedTools') + 1]).toContain('Bash(git *)');
  expect(reviewer).not.toContain('--settings');
  const settings = shippedClaudeSettings('claude-code', 'tester') as { sandbox: { enabled: boolean; excludedCommands: string[] }; permissions: { deny: string[] } };
  expect(settings.sandbox.enabled).toBe(true);
  expect(settings.sandbox.excludedCommands).toContain('team');
  expect(settings.permissions.deny).toContain('Edit(**)');
  expect(shippedLauncher('claude-code', { model: 'DeepSeek Flash', version: '4.0', vendor: 'deepseek' })?.argv)
    .toEqual(['claude', '--dangerously-skip-permissions']);
  expect(shippedEnv('claude-code', { model: 'Claude Opus', version: '5.5', effort: 'high' })).toEqual(['CLAUDE_CODE_EFFORT_LEVEL=high']);
});

test('claude-code on a provider takes its words from the launch account, the key only as a lookup', () => {
  const account = { name: 'deepseek', provider: 'deepseek', endpoint: 'https://api.deepseek.com/anthropic', keychain: 'deepseek-api-key',
    defaultModel: 'deepseek-flash', effortDefault: 'high', autoCompactWindow: 786432 };
  const words = shippedEnv('claude-code', { vendor: 'deepseek', account });
  expect(words).toContain('ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic');
  expect(words).toContain('ANTHROPIC_MODEL=deepseek-flash');
  expect(words).toContain('CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash');
  expect(words).toContain('CLAUDE_CODE_EFFORT_LEVEL=high');
  expect(words).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432');
  const token = words.find((word) => word.startsWith('ANTHROPIC_AUTH_TOKEN='));
  expect(token?.startsWith('ANTHROPIC_AUTH_TOKEN="$(/usr/bin/security ')).toBe(true);
  expect(token?.slice('ANTHROPIC_AUTH_TOKEN="'.length, -1)).not.toContain('"');
  expect(shippedEnv('claude-code', { vendor: 'deepseek' })).toEqual([]);
  expect(shippedEnv('grok-build', { vendor: 'deepseek', account })).toEqual([]);
});

describe('the Codex and Antigravity launchers', () => {
  test('a Codex builder runs its model and effort with no approval and full access', () => {
    const line = shippedLauncher('codex', { role: 'builder', model: 'GPT Sol', version: '6.1', effort: 'high' })!.argv;
    expect(line).toEqual(['codex', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '-a', 'never', '-s', 'danger-full-access']);
  });

  test('a Codex reader runs the builder line (its sandbox stops team), and a plain GPT model has no family word', () => {
    const line = shippedLauncher('codex', { role: 'reviewer', model: 'GPT', version: '6' })!.argv;
    expect(line).toEqual(['codex', '-m', 'gpt-6', '-a', 'never', '-s', 'danger-full-access']);
  });

  test('an Antigravity seat names its Gemini model with its effort, high by default; a reader runs the same line', () => {
    expect(shippedLauncher('antigravity', { role: 'builder', model: 'Gemini Argon', version: '4' })!.argv)
      .toEqual(['agy', '--model', 'gemini-4-argon-high']);
    expect(shippedLauncher('antigravity', { role: 'reviewer', model: 'Gemini Flash', version: '3.8', effort: 'medium' })!.argv)
      .toEqual(['agy', '--model', 'gemini-3.8-flash-medium']);
  });

  test('both are shipped names', () => {
    expect(shippedLauncherNames()).toEqual(['antigravity', 'claude-code', 'codex', 'grok-build']);
  });
});

test('only the launchers that emit a read-only line count as read-only (review finding 5)', () => {
  expect(shippedLauncherIsReadOnly('grok-build', 'reviewer')).toBe(true);
  expect(shippedLauncherIsReadOnly('claude-code', 'tester')).toBe(true);
  expect(shippedLauncherIsReadOnly('codex', 'reviewer')).toBe(false);
  expect(shippedLauncherIsReadOnly('antigravity', 'tester')).toBe(false);
});
