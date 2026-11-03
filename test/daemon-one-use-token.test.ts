// The one-use token claim, shared by the daemon's chores and restore children: the claim is a
// rename, so of two children started with one nonce exactly one passes and the other refuses.
// The restore child's own scenes live beside its spawner; these pin the chores child (which
// serves until its input ends, so "ran" is a live child that answers `ready` and exits 0 when
// its input ends) and the claim helper itself. The last scenes cover the sweep that removes the
// claimed copies a process left when it died between the claim and the unlink. No scene asks the
// machine whether a pid exists: every scene that plants a claimed copy injects its own answer,
// and `pidAlive` is exercised only with an injected `kill`.
import { afterEach, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineConfigDir, restoreInheritPath } from '../src/daemon/paths.ts';
import { claimOneUseToken, pidAlive, type KillProbe, type LivenessProbe } from '../src/daemon/one-use-token.ts';
import { readChoresInherit, writeChoresInherit } from '../src/daemon/chores/token.ts';
import { acceptRestoreDoor, restoreDoorText, restoreRequestProblem, writeRestoreDoor } from '../src/daemon/restore/token.ts';
import type { ChoresChildConfig } from '../src/daemon/chores/protocol.ts';

/** Timed scenes run under /private/tmp where a bun child starts quickly. */
const BASE = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();

const ENTRY = fileURLToPath(new URL('../src/daemon/chores/entry.ts', import.meta.url));

const bases: string[] = [];
const live: ChildProcess[] = [];

/** A liveness answer from the scene: only the pids named are alive. */
function aliveOnly(...pids: number[]): LivenessProbe {
  return (pid) => pids.includes(pid);
}

/** A liveness answer from the scene: every pid is gone. */
const noneAlive: LivenessProbe = () => false;

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
      const nonce = writeChoresInherit(configOf(home, root), { isAlive: noneAlive });
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
    const nonce = writeChoresInherit(configOf(home, root), { isAlive: noneAlive });
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

describe('independent adversarial checks: one-use token, malformed nonces, unreadable claims, and multi-root refusal', () => {
  test('an unreadable token file (mode 0000, as from another uid) is refused on read and still unlinked so it cannot be retried', () => {
    const { base } = scratch();
    const path = join(base, 'unreadable-token.json');
    writeFileSync(path, '{"version":1}\n', { mode: 0o600 });
    chmodSync(path, 0o000);
    // Skip the permission assertion only if running as root in a container where 0000 is still readable.
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      expect(claimOneUseToken(path)).toEqual({
        kind: 'refused',
        why: 'the claimed token cannot be read',
      });
      // Both the original token and `.claim.<pid>` are gone after the failed read.
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(base).filter((name) => name.startsWith('unreadable-token.json'))).toEqual([]);
      expect(claimOneUseToken(path)).toEqual({
        kind: 'refused',
        why: 'no one-use token names this child',
      });
    } else {
      chmodSync(path, 0o600);
    }
  });

  test('malformed nonces and cross-channel nonces (chores vs restore) are refused without consuming valid tokens', () => {
    const { root, home } = scratch();
    const daemonPid = 9_876;
    const service = { job: () => ({ pid: daemonPid, program: process.execPath }) };
    const choresNonce = writeChoresInherit(configOf(home, root));
    const { nonce: restoreNonce, secret: restoreSecret } = writeRestoreDoor({
      version: 1,
      home,
      root,
      daemonPid,
    });

    const malformed = [
      '',
      'not-a-nonce',
      '../daemon.state.json',
      '../../etc/passwd',
      'A'.repeat(32),
      'a'.repeat(31),
      'a'.repeat(33),
      'g'.repeat(32),
      `${'a'.repeat(32)}\n`,
      `${'a'.repeat(16)}/../${'b'.repeat(12)}`,
    ];
    for (const bad of malformed) {
      expect(readChoresInherit(home, bad), bad).toEqual({
        kind: 'refused',
        why: 'the token name is not one this daemon writes',
      });
      expect(
        acceptRestoreDoor({
          home,
          nonce: bad,
          text: restoreDoorText(bad, restoreSecret),
          parentPid: daemonPid,
          service,
        }),
        bad,
      ).toEqual({
        kind: 'refused',
        why: 'the token name is not one this daemon writes',
      });
    }

    // Cross-channel: a chores nonce cannot be claimed by restore, and a restore nonce cannot be claimed by chores.
    expect(
      acceptRestoreDoor({
        home,
        nonce: choresNonce,
        text: restoreDoorText(choresNonce, restoreSecret),
        parentPid: daemonPid,
        service,
      }),
    ).toEqual({
      kind: 'refused',
      why: 'no one-use token names this child',
    });
    expect(readChoresInherit(home, restoreNonce)).toEqual({
      kind: 'refused',
      why: 'no one-use token names this child',
    });

    // Both valid tokens are still unconsumed and succeed once on their own channel, then refuse on replay.
    expect(readChoresInherit(home, choresNonce).kind).toBe('ok');
    expect(readChoresInherit(home, choresNonce)).toEqual({
      kind: 'refused',
      why: 'no one-use token names this child',
    });
    expect(
      acceptRestoreDoor({
        home,
        nonce: restoreNonce,
        text: restoreDoorText(restoreNonce, restoreSecret),
        parentPid: daemonPid,
        service,
      }),
    ).toEqual({
      kind: 'ok',
      request: { version: 1, home, root },
    });
    expect(
      acceptRestoreDoor({
        home,
        nonce: restoreNonce,
        text: restoreDoorText(restoreNonce, restoreSecret),
        parentPid: daemonPid,
        service,
      }),
    ).toEqual({
      kind: 'refused',
      why: 'no one-use token names this child',
    });
  });

  test('a restore token naming a second root (array or chores routes list) or malformed fields is refused and consumed', () => {
    const { base, root, home } = scratch();
    const daemonPid = 9_876;
    const service = { job: () => ({ pid: daemonPid, program: process.execPath }) };
    const secret = 'f'.repeat(64);
    const secondRoot = join(base, 'repo-two');
    mkdirSync(secondRoot, { recursive: true });
    mkdirSync(machineConfigDir(home), { recursive: true, mode: 0o700 });

    const cases: Array<{ nonce: string; payload: unknown; why: string }> = [
      { nonce: '1'.repeat(32), payload: null, why: 'the token carries no request' },
      { nonce: '2'.repeat(32), payload: [{ version: 1, home, root }, { version: 1, home, root: secondRoot }], why: 'the token carries no request' },
      { nonce: '3'.repeat(32), payload: { version: 1, home, root: [root, secondRoot] }, why: 'the token names no root' },
      { nonce: '4'.repeat(32), payload: { version: 1, home, routes: [{ root }, { root: secondRoot }] }, why: 'the token names no root' },
      { nonce: '5'.repeat(32), payload: { version: 1, home: '', root }, why: 'the token names no home' },
      { nonce: '6'.repeat(32), payload: { version: 1, home, root: '' }, why: 'the token names no root' },
      { nonce: '7'.repeat(32), payload: { version: 1, home, root, teamFile: '' }, why: 'the token names a malformed team file' },
      { nonce: '8'.repeat(32), payload: { version: 1, home, root, teamFile: [join(root, '.agents/team.yaml')] }, why: 'the token names a malformed team file' },
    ];

    for (const { nonce, payload, why } of cases) {
      expect(restoreRequestProblem(payload), nonce).toBe(why);
      const file = restoreInheritPath(home, nonce);
      writeFileSync(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      expect(
        acceptRestoreDoor({
          home,
          nonce,
          text: restoreDoorText(nonce, secret),
          parentPid: daemonPid,
          service,
        }),
        nonce,
      ).toEqual({ kind: 'refused', why });
      // Consumed even when invalid.
      expect(existsSync(file), nonce).toBe(false);
    }
    expect(readdirSync(machineConfigDir(home)).filter((name) => name.startsWith('restore.inherit.'))).toEqual([]);
  });
});

describe('the claimed copies a process left when it died between claim and unlink', () => {
  const DEAD = 900_001;
  const LIVE = 900_002;

  test("a token write removes a dead pid's claimed copy and leaves every other shape alone", () => {
    const { base, root, home } = scratch();
    const dir = machineConfigDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stale = join(dir, `restore.inherit.${'a'.repeat(32)}.json.claim.${DEAD}`);
    writeFileSync(stale, '{"stale":true}\n');
    const live = join(dir, `restore.inherit.${'b'.repeat(32)}.json.claim.${LIVE}`);
    writeFileSync(live, '{"live":true}\n');
    const notAPid = join(dir, `restore.inherit.${'c'.repeat(32)}.json.claim.not-a-pid`);
    writeFileSync(notAPid, 'x\n');
    const unrelated = join(dir, 'daemon.state.json');
    writeFileSync(unrelated, '{}\n');
    const target = join(base, 'outside-target.txt');
    writeFileSync(target, 'target\n');
    const link = join(dir, `restore.inherit.${'d'.repeat(32)}.json.claim.${DEAD}`);
    symlinkSync(target, link);
    const neighbour = join(home, `restore.inherit.${'e'.repeat(32)}.json.claim.${DEAD}`);
    writeFileSync(neighbour, 'neighbour\n');
    // A folder carrying the exact claimed spelling: only a regular file is a claim.
    const folder = join(dir, `restore.inherit.${'9'.repeat(32)}.json.claim.${DEAD}`);
    mkdirSync(folder);

    writeRestoreDoor({ version: 1, home, root }, { isAlive: aliveOnly(LIVE) });

    // The dead process's claimed copy is the only thing the write removed.
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(notAPid)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    // A link is never followed, and the file outside the machine folder is untouched.
    expect(existsSync(target)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(neighbour)).toBe(true);
    expect(lstatSync(folder).isDirectory()).toBe(true);
    // The write's own token is there.
    expect(readdirSync(dir).some((name) => /^restore\.inherit\.[0-9a-f]{32}\.json$/.test(name))).toBe(true);
  });

  /** Plants one file under the machine folder and sweeps with every pid dead: the file stays
   *  unless its whole name is the spelling a claim produces. */
  function sweepOne(name: string): boolean {
    const { root, home } = scratch();
    const dir = machineConfigDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, name);
    writeFileSync(path, 'x\n');
    writeRestoreInherit({ version: 1, home, root }, { isAlive: noneAlive });
    return existsSync(path);
  }

  test('a file ending in a dead claim but headed by another name stays', () => {
    expect(sweepOne('foo.claim.99999')).toBe(true);
  });

  test('a file whose whole name is a claim tail stays', () => {
    expect(sweepOne('.claim.123')).toBe(true);
  });

  test('a claimed name whose pid has a leading zero stays: no claim writes that spelling', () => {
    expect(sweepOne(`restore.inherit.${'f'.repeat(32)}.json.claim.0900001`)).toBe(true);
  });

  test('a pid the machine refuses to signal is alive: its claimed copy stays', () => {
    const { root, home } = scratch();
    const dir = machineConfigDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const protectedPid = 900_003;
    const stale = join(dir, `restore.inherit.${'a'.repeat(32)}.json.claim.${protectedPid}`);
    writeFileSync(stale, '{}\n');
    const asked: Array<[number, number]> = [];
    const kill: KillProbe = (pid, signal) => {
      asked.push([pid, signal]);
      // The process exists; this uid is simply not allowed to signal it.
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    };
    writeRestoreInherit({ version: 1, home, root }, { isAlive: (pid) => pidAlive(pid, kill) });
    expect(existsSync(stale)).toBe(true);
    expect(asked).toEqual([[protectedPid, 0]]);
  });

  test('the chores token write sweeps the same way', () => {
    const { root, home } = scratch();
    const dir = machineConfigDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stale = join(dir, `chores.inherit.${'a'.repeat(32)}.json.claim.${DEAD}`);
    writeFileSync(stale, '{}\n');
    const live = join(dir, `chores.inherit.${'b'.repeat(32)}.json.claim.${LIVE}`);
    writeFileSync(live, '{}\n');
    writeChoresInherit(configOf(home, root), { isAlive: aliveOnly(LIVE) });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});

describe('pidAlive asks with signal 0 and only "no such process" means gone', () => {
  test('a pid that answers the probe is alive, and the probe asked with signal 0', () => {
    const asked: Array<[number, number]> = [];
    const kill: KillProbe = (pid, signal) => {
      asked.push([pid, signal]);
    };
    expect(pidAlive(4242, kill)).toBe(true);
    expect(asked).toEqual([[4242, 0]]);
  });

  test('ESRCH is the one dead answer', () => {
    const kill: KillProbe = () => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    };
    expect(pidAlive(4242, kill)).toBe(false);
  });

  test('every other error counts as alive: this uid cannot signal a process it has', () => {
    for (const code of ['EPERM', 'EINVAL', 'EACCES']) {
      const kill: KillProbe = () => {
        throw Object.assign(new Error(code), { code });
      };
      expect(pidAlive(4242, kill)).toBe(true);
    }
    const codeless: KillProbe = () => {
      throw new Error('no code');
    };
    expect(pidAlive(4242, codeless)).toBe(true);
  });
});
