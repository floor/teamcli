// The one-use token claim, shared by the daemon's chores and restore children: the claim is a
// rename, so of two children started with one nonce exactly one passes and the other refuses.
// The restore child's own scenes live beside its spawner; these pin the chores child (which
// serves until its input ends, so "ran" is a live child that answers `ready` and exits 0 when
// its input ends) and the claim helper itself. The last scene is the other side of the same
// rule: a machine folder this uid cannot claim in starts nothing.
import { afterEach, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineConfigDir } from '../src/daemon/paths.ts';
import { claimOneUseToken } from '../src/daemon/one-use-token.ts';
import { writeChoresInherit } from '../src/daemon/chores/token.ts';
import type { ChoresChildConfig } from '../src/daemon/chores/protocol.ts';

/** Timed scenes run under /private/tmp where a bun child starts quickly. */
const BASE = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();

const ENTRY = fileURLToPath(new URL('../src/daemon/chores/entry.ts', import.meta.url));

const bases: string[] = [];
const live: ChildProcess[] = [];

function scratch(): { base: string; root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(BASE, 'team-one-use-token-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home);
  return { base, root, home };
}

/** A token the chores child accepts. The beat is an hour out, so this child only says `ready`,
 *  one heartbeat, and serves its input; no chore pass runs in the scene. */
function configOf(home: string, root: string): ChoresChildConfig {
  return {
    version: 1,
    home,
    beatMs: 3_600_000,
    sliceMs: 1_000,
    since: new Date().toISOString(),
    routes: [{ root, team: 'one-use-token', session: 'sweep' }],
  };
}

type Started = {
  proc: ChildProcess;
  done: Promise<{ status: number | null; stdout: string; stderr: string }>;
  endInput: () => void;
  reading: () => { stdout: string; stderr: string };
};

/** Starts the child without waiting, so two can be started with one token at once. */
function startChild(home: string, nonce: string, cwd: string): Started {
  const proc = spawn(process.execPath, [ENTRY, '--inherited', nonce], {
    cwd,
    env: { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  live.push(proc);
  let stdout = '';
  let stderr = '';
  proc.stdout!.setEncoding('utf8');
  proc.stderr!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    stdout += chunk;
  });
  proc.stderr!.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    proc.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return {
    proc,
    done,
    endInput: () => proc.stdin!.end(),
    reading: () => ({ stdout, stderr }),
  };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the child');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(() => {
  for (const proc of live.splice(0)) {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

describe('one nonce starts one child', () => {
  test('two children started with one token at once: exactly one serves', async () => {
    const { root, home } = scratch();
    for (let round = 0; round < 4; round += 1) {
      const nonce = writeChoresInherit(configOf(home, root));
      const first = startChild(home, nonce, root);
      const second = startChild(home, nonce, root);
      // The claim is the file system's rename, which admits one mover, so one child refuses
      // promptly while the other serves its input.
      const settledFirst = await Promise.race([
        first.done.then((one) => ({ child: first, other: second, one })),
        second.done.then((one) => ({ child: second, other: first, one })),
      ]);
      const winner = settledFirst.other;
      expect(settledFirst.one.status).toBe(2);
      expect(settledFirst.one.stdout).toBe('');
      expect(settledFirst.one.stderr).toContain('no one-use token names this child');
      // The other child claimed the token and is serving, not waiting to refuse.
      expect(winner.proc.exitCode).toBeNull();
      await until(() => winner.reading().stdout.includes('"type":"ready"'));
      expect(winner.reading().stdout).toContain('"type":"heartbeat"');
      // Ending its input is the host's own stop: the child leaves cleanly.
      winner.endInput();
      const left = await winner.done;
      expect(left.status).toBe(0);
      expect(left.stdout).toContain('"type":"stopped"');
    }
  }, 60_000);

  test('a machine folder this child cannot claim in refuses the token', () => {
    const { root, home } = scratch();
    const nonce = writeChoresInherit(configOf(home, root));
    const dir = machineConfigDir(home);
    // Traversal and reading stay possible for this uid; only the claim (a rename in the folder)
    // is not. The child must refuse rather than serve.
    chmodSync(dir, 0o500);
    try {
      const ran = spawnSync(process.execPath, [ENTRY, '--inherited', nonce], {
        cwd: root,
        env: { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });
      expect(ran.status).toBe(2);
      expect(ran.stdout).toBe('');
      expect(ran.stderr).toContain('no one-use token names this child');
    } finally {
      chmodSync(dir, 0o700);
    }
  }, 20_000);

  test('the claim returns the token text and takes the name out of circulation', () => {
    const { base } = scratch();
    const path = join(base, 'token.json');
    writeFileSync(path, '{"a":1}\n', { mode: 0o600 });
    expect(claimOneUseToken(path)).toEqual({ kind: 'ok', text: '{"a":1}\n' });
    expect(existsSync(path)).toBe(false);
    expect(claimOneUseToken(path)).toEqual({ kind: 'refused', why: 'no one-use token names this child' });
    // Neither the token nor a claimed copy is left behind.
    expect(readdirSync(base).filter((name) => name.startsWith('token.json'))).toEqual([]);
  });
});
