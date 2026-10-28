// Codex's startup daemon dialog ('Background server has incompatible feature settings') is a
// not-started screen the codex profile recognises: `team down` closes that pane without typing,
// and no option (never 2, which restarts the shared background server) is ever chosen.
import { describe, expect, test } from 'bun:test';
import { profileFor } from '../../src/profiles/index.ts';
import { isNotStartedScreen } from '../../src/profiles/profile.ts';
import { readScreen } from '../../src/watch/screen.ts';
import { downPlan } from '../../src/launch/plan.ts';

const DIALOG = [
  '',
  '  Background server has incompatible feature settings',
  '',
  '  The running background server was started with different feature settings.',
  '',
  '› 1. Run without daemon this time',
  '  2. Restart with these settings',
  '  3. Cancel',
  '',
  '  Press enter to confirm or esc to cancel',
].join('\n');

describe('codex daemon dialog', () => {
  test('the profile reads it as not started; other screens are not', () => {
    const codex = profileFor('codex');
    expect(isNotStartedScreen(codex, DIALOG)).toBe(true);
    expect(isNotStartedScreen(codex, '› Explain this codebase\n')).toBe(false);
    expect(isNotStartedScreen(codex, 'Background server has incompatible feature settings\n')).toBe(false);
    expect(isNotStartedScreen(profileFor('claude-code'), DIALOG)).toBe(false);
  });

  test('the screen reader alone still calls it unknown (the override is down\'s, never an answer)', () => {
    expect(readScreen('codex', DIALOG).kind).toBe('unknown');
  });

  test('down closes the pane as exited and types nothing into it', () => {
    const steps = downPlan({ session: 's', seats: [{ name: 'w', cli: 'codex', pane: 'p1', workspace: 'ws1', state: 'exited' }], extra: 0, watchPid: null, keep: [] });
    const text = JSON.stringify(steps);
    expect(text).toContain('ws1');
    expect(text).not.toContain('does not recognise');
    expect(steps.some((step) => (step as { kind: string }).kind === 'type' || (step as { kind: string }).kind === 'key')).toBe(false);
  });
});
