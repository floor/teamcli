// One machine daemon per home, held by the kernel. Starts racing in separate processes after a
// crash (a dead holder's lock file and a socket nobody listens on) leave exactly one daemon
// serving, and a daemon killed outright frees the lock for the next start at once. Real child
// processes in a scratch home; no live daemon, service manager or herdr.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonHealth } from '../src/daemon/health.ts';
import { daemonLockPath, daemonSocketPath, machineConfigDir } from '../src/daemon/paths.ts';

const CHILD = join(import.meta.dir, 'helpers', 'daemon-start-child.ts');
const bases: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function scratch(): { base: string; home: string; barrier: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-single-')));
  bases.push(base);
  const home = join(base, 'home');
  mkdirSync(machineConfigDir(home), { recursive: true, mode: 0o700 });
  return { base, home, barrier: join(base, 'go') };
}

type Outcome = { kind: string; pid: number };

function startChild(home: string, barrier: string): { child: ChildProcess; outcome: Promise<Outcome> } {
  const child = spawn(process.execPath, [CHILD, home, barrier], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, HOME: home },
  });
  children.push(child);
  const outcome = new Promise<Outcome>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const line = out.split('\n')[0];
      if (out.includes('\n') && line !== undefined) resolve(JSON.parse(line) as Outcome);
    });
    child.once('exit', (code) => reject(new Error(`child exited ${String(code)} before answering`)));
  });
  return { child, outcome };
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

/** What a daemon killed without a clean stop leaves: a lock naming a pid that is gone, and a
 *  socket file nobody listens on. */
async function crashLeftovers(home: string): Promise<void> {
  writeFileSync(daemonLockPath(home), '999999\n');
  const staging = join(machineConfigDir(home), 'stale.sock');
  const stale = createServer();
  await new Promise<void>((done, fail) => {
    stale.once('error', fail);
    stale.listen(staging, () => done());
  });
  renameSync(staging, daemonSocketPath(home));
  await new Promise<void>((done, fail) => stale.close((error) => (error ? fail(error) : done())));
}

describe('one machine daemon per home', () => {
  test('starts racing after a crash leave exactly one daemon serving', async () => {
    const { home, barrier } = scratch();
    await crashLeftovers(home);
    const racers = Array.from({ length: 5 }, () => startChild(home, barrier));
    // Every child is loaded and waiting before the barrier opens.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    writeFileSync(barrier, '');
    const outcomes = await Promise.all(racers.map((one) => one.outcome));
    const serving = outcomes.filter((one) => one.kind === 'serving');
    expect(serving).toHaveLength(1);
    for (const other of outcomes.filter((one) => one.kind !== 'serving')) {
      expect(['already-running', 'locked', 'bind-failed']).toContain(other.kind);
    }
    const health = await daemonHealth(home);
    expect(health.state).toBe('running');
    expect(health.pid).toBe(serving[0]!.pid);
    for (const one of racers) one.child.stdin!.end();
    await Promise.all(racers.map((one) => exited(one.child)));
  }, 30_000);

  test('a lock file naming a dead pid is not taken while another process holds its flock', async () => {
    const { home, barrier } = scratch();
    // The window the old by-name lock lost: a holder that has the lock and whose file still
    // names a pid that is gone. Reading the pid as dead and unlinking the file let a second
    // start take it.
    const lockPath = daemonLockPath(home);
    const holder = spawn(process.execPath, [join(import.meta.dir, 'helpers', 'flock-holder-child.ts'), lockPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    children.push(holder);
    await new Promise<void>((resolve, reject) => {
      holder.stdout!.once('data', (chunk: Buffer) => (chunk.toString('utf8').startsWith('held') ? resolve() : reject(new Error('the holder found the lock busy'))));
    });
    writeFileSync(lockPath, '999999\n');
    writeFileSync(barrier, '');
    const blocked = startChild(home, barrier);
    expect((await blocked.outcome).kind).not.toBe('serving');
    await exited(blocked.child);
    // The holder gone, the same file is free to the next start.
    holder.stdin!.end();
    await exited(holder);
    const next = startChild(home, barrier);
    expect((await next.outcome).kind).toBe('serving');
    next.child.stdin!.end();
    await exited(next.child);
  }, 30_000);

  test('a daemon killed outright frees the lock for the next start', async () => {
    const { home, barrier } = scratch();
    writeFileSync(barrier, '');
    const first = startChild(home, barrier);
    expect((await first.outcome).kind).toBe('serving');
    first.child.kill('SIGKILL');
    await exited(first.child);
    const second = startChild(home, barrier);
    const next = await second.outcome;
    expect(next.kind).toBe('serving');
    const health = await daemonHealth(home);
    expect(health.pid).toBe(next.pid);
    second.child.stdin!.end();
    await exited(second.child);
  }, 30_000);
});
