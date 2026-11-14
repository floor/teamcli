// Starts the owner helper of a machine whose accounts share one owner, through the system's
// privilege rule, with one spend on its input (src/client/owner-spend.ts). Exactly the program the
// rule names and nothing after it, with no prompt: a machine whose rule is missing refuses rather
// than asking for a password. This module holds nothing else, and nothing in a real run replaces
// it; the test suite's preload stands in for it (test/preload/team-config-source.ts).
import { spawnSync } from 'node:child_process';
import { OWNER_HELPER_LAUNCHER, OWNER_HELPER_SUDO, OWNER_HELPER_USER } from './owner-spend.ts';

export function execOwnerHelper(stdin: string): { status: number | null; stdout: string } {
  const run = spawnSync(OWNER_HELPER_SUDO, ['-n', '-u', OWNER_HELPER_USER, '--', OWNER_HELPER_LAUNCHER], {
    input: stdin,
    encoding: 'utf8',
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  return { status: run.status, stdout: typeof run.stdout === 'string' ? run.stdout : '' };
}
