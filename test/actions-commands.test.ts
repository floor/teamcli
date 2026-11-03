// The Actions allowlist is a policy, not a seat. The release default is Floor's three commands.
// A caller may set a subset. The guard allows exactly those and refuses every other Actions command.
import { expect, test } from 'bun:test';
import { refusedByGuard } from '../src/launch/command-guard.ts';
import { ACTIONS_COMMANDS_DEFAULT, getPolicySpec, type ActionsCommand } from '../src/policy/types.ts';

const spec = getPolicySpec('actions-commands');

test('the policy defaults to the three commands and a caller may only narrow them', () => {
  expect(spec).not.toBeNull();
  expect(spec?.defaultValue).toEqual(['rerun-failed', 'deploy', 'ci-pr-head']);
  expect(spec?.levels).toEqual(['entity', 'project', 'team', 'seat']);
  expect(spec?.parseValue('rerun-failed, deploy')).toEqual(['rerun-failed', 'deploy']);
  expect(spec?.parseValue(['ci-pr-head'])).toEqual(['ci-pr-head']);
  expect(spec?.parseValue('')).toEqual([]);
  expect(spec?.parseValue('rerun-failed, publish')).toBeNull();
  expect(spec?.parseValue('deploy, deploy')).toBeNull();
  expect(spec?.isWithin(['rerun-failed'], ACTIONS_COMMANDS_DEFAULT)).toBe(true);
  expect(spec?.isWithin([], ['rerun-failed'])).toBe(true);
  expect(spec?.isWithin(ACTIONS_COMMANDS_DEFAULT, ['deploy'])).toBe(false);
});

const none: readonly ActionsCommand[] = [];

test('the default allowlist permits the three commands and nothing else on Actions', () => {
  expect(refusedByGuard('gh run rerun --failed')).toBeNull();
  expect(refusedByGuard('gh run rerun --failed 12345')).toBeNull();
  expect(refusedByGuard('gh -R floor/teamcli run rerun --failed')).toBeNull();
  expect(refusedByGuard('gh workflow run deploy.yml')).toBeNull();
  expect(refusedByGuard('gh workflow run deploy.yml -f target=site')).toBeNull();
  expect(refusedByGuard('gh workflow run ci.yml --ref abc123')).toBeNull();
  expect(refusedByGuard('gh workflow run ci --ref=abc123')).toBeNull();
  expect(refusedByGuard('gh pr view 1')).toBeNull();
  expect(refusedByGuard('gh api user')).toBeNull();

  expect(refusedByGuard('gh run rerun 12345')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh run list')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh run cancel 12345')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh workflow run release.yml')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh workflow run ci.yml')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh workflow enable ci.yml')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh api repos/floor/teamcli/actions/runs/1')?.rule).toBe('github-actions');
  expect(refusedByGuard('gh run list')?.guidance).toBe(
    'refused in team seats: the actions-commands policy does not allow that Actions command',
  );
});

test('a caller that drops a command removes only that command', () => {
  const rerun: readonly ActionsCommand[] = ['rerun-failed'];
  expect(refusedByGuard('gh run rerun --failed', rerun)).toBeNull();
  expect(refusedByGuard('gh workflow run deploy.yml', rerun)?.rule).toBe('github-actions');
  expect(refusedByGuard('gh workflow run ci.yml --ref abc', rerun)?.rule).toBe('github-actions');
  expect(refusedByGuard('gh run rerun --failed', none)?.rule).toBe('github-actions');
  expect(refusedByGuard('gh workflow run deploy.yml', none)?.rule).toBe('github-actions');
  expect(refusedByGuard('gh pr view 1', none)).toBeNull();
});
