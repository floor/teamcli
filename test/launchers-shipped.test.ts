// The launchers TeamCLI ships: one per vendor CLI, configured by the seat's role and effort.
import { expect, test } from 'bun:test';
import { isShippedLauncher, shippedLauncher, shippedLauncherNames } from '../src/launchers/shipped.ts';
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
  expect(made?.argv).toEqual(['grok', '--model', 'grok-4.7', '--no-subagents', '--always-approve']);
});

test('a reviewer seat gets the read-only line: no always-approve, writes, edits, git and bun denied', () => {
  const argv = shippedLauncher('grok-build', { role: 'reviewer' })?.argv ?? [];
  expect(argv).not.toContain('--always-approve');
  expect(argv.join(' ')).toContain('--permission-mode dontAsk');
  for (const rule of ['Write', 'Edit', 'Bash(git *)', 'Bash(bun *)']) {
    const at = argv.indexOf(rule);
    expect(at, rule).toBeGreaterThan(0);
    expect(argv[at - 1], rule).toBe('--deny');
  }
  expect(argv[argv.indexOf('Read') - 1]).toBe('--allow');
});

test('the seat\'s effort rides the line when it has one', () => {
  expect(shippedLauncher('grok-build', { role: 'builder', effort: 'high' })?.argv.slice(-2)).toEqual(['--effort', 'high']);
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
  if (resolved.ok) expect(resolved.argv.slice(0, 3)).toEqual(['grok', '--model', 'grok-4.7']);
});
