// Load HOME-sensitive modules only in a child whose HOME this suite creates itself.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
const CHILD = 'TEAM_INDEPENDENT_HOME_CHILD';
const NONCE = 'TEAM_INDEPENDENT_HOME_NONCE';
const BASE = 'TEAM_INDEPENDENT_HOME_BASE';
const PARENT = 'TEAM_INDEPENDENT_HOME_PARENT';
let activeSuite: string | undefined;

/** Replaces a fixed external path check with proof of the suite's own startup HOME. */
export function assertIndependentHome(): void {
  const home = process.env.HOME;
  const base = process.env[BASE];
  const nonce = process.env[NONCE];
  expect(typeof activeSuite).toBe('string'); expect(process.env[CHILD]).toBe(activeSuite);
  expect(typeof home).toBe('string'); expect(typeof base).toBe('string');
  expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
  if (!activeSuite || !home || !base || !nonce) throw new Error('the suite must create its own child HOME');
  const expected = join(realpathSync(base), nonce);
  expect(home).toBe(expected); expect(realpathSync(home)).toBe(expected);
  expect(homedir()).toBe(expected);
  const stat = lstatSync(home);
  expect(stat.isDirectory()).toBe(true); expect(stat.isSymbolicLink()).toBe(false);
  expect(stat.mode & 0o777).toBe(0o700);
  if (process.getuid) expect(stat.uid).toBe(process.getuid());
  expect(Number(process.env[PARENT])).not.toBe(process.pid);
}

export async function independentHomeSuite(suite: string, loadCases: () => Promise<unknown>): Promise<void> {
  if (process.env[CHILD] === suite) {
    activeSuite = suite;
    await loadCases();
    return;
  }
  test('independent cases create their own HOME before child startup', async () => {
    const parentHome = process.env.HOME;
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ind-home-')));
    const nonce = randomUUID();
    const home = join(base, nonce);
    try {
      const oldMask = process.umask(0);
      try { mkdirSync(home, { mode: 0o700 }); } finally { process.umask(oldMask); }
      expect(readdirSync(home)).toEqual([]); expect(home).not.toBe(parentHome);
      const child = Bun.spawn([process.execPath, 'test', suite], {
        cwd: new URL('..', import.meta.url).pathname,
        env: { ...process.env, HOME: home, [CHILD]: suite, [BASE]: base, [NONCE]: nonce, [PARENT]: String(process.pid) },
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(child.pid).not.toBe(process.pid);
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      process.stdout.write(out); process.stderr.write(err);
      expect(code).toBe(0); expect(process.env.HOME).toBe(parentHome);
      expect(lstatSync(home).isSymbolicLink()).toBe(false);
    } finally { execFileSync('trash', [base]); }
  }, 120_000);
}
