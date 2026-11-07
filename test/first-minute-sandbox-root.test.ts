import { describe, expect, test } from 'bun:test';
import { checkSandbox } from '../src/launchers/sandbox.ts';
import { presetMayStaff, sandboxRootFor } from '../src/launchers/sandbox-root.ts';

describe('sandbox root follows the folder', () => {
  test('shared mode passes the project root and worktree mode passes the worktree', () => {
    expect(sandboxRootFor({ mode: 'shared', projectRoot: '/repo' })).toEqual({ ok: true, root: '/repo' });
    expect(sandboxRootFor({
      mode: 'worktree',
      projectRoot: '/repo',
      worktree: '/repo/.worktrees/seat',
    })).toEqual({ ok: true, root: '/repo/.worktrees/seat' });
    expect(sandboxRootFor({ mode: 'worktree', projectRoot: '/repo' }).ok).toBe(false);
  });

  test('team check refuses a writable folder the sandbox does not include', () => {
    const refused = checkSandbox({
      cwd: '/repo',
      teamRoot: '/repo',
      harness: 'grok',
      folders: ['/repo', '/elsewhere'],
      sandboxRoot: '/repo',
    });
    expect(refused.some((one) => one.code === 'E_SANDBOX_OUTSIDE_ROOT' && one.message.includes('/elsewhere'))).toBe(true);

    const passed = checkSandbox({
      cwd: '/repo',
      teamRoot: '/repo',
      harness: 'grok',
      folders: ['/repo'],
      sandboxRoot: '/repo',
    });
    expect(passed.some((one) => one.severity === 'error')).toBe(false);
  });

  test('the preset staffs a signed-in CLI only when the sandbox contains the folder', () => {
    expect(presetMayStaff({ cli: 'codex', loggedIn: true, sandboxRoot: '/repo', folder: '/repo' })).toBe(true);
    expect(presetMayStaff({ cli: 'grok', loggedIn: true, sandboxRoot: '/repo', folder: '/other' })).toBe(false);
    expect(presetMayStaff({ cli: 'cursor', loggedIn: false, sandboxRoot: '/repo', folder: '/repo' })).toBe(false);
    expect(presetMayStaff({ cli: 'gemini', loggedIn: true, sandboxRoot: '/repo', folder: '/repo' })).toBe(false);
  });
});
