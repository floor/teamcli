// The reminder sender's second identity: a process the daemon started. The proof is the process
// table — the record names the daemon, and the sender's parent is that process — never a word
// the sender could write. These scenes cross a real process boundary: a worker under a record
// naming this process stands, and a process that worker started is refused, because only the
// record's own process can make a sender its child.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { daemonLockPath } from '../src/daemon/paths.ts';
import { writeDaemonState, type DaemonState } from '../src/daemon/state.ts';

const AT = new Date('2026-11-02T18:00:00.000Z');
const WORKER = join(import.meta.dir, 'authority-child-worker.ts');

const homes: string[] = [];
afterEach(() => {
  for (const base of homes.splice(0)) rmSync(base, { recursive: true, force: true });
});

function machineHome(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reminder-child-')));
  homes.push(base);
  return join(base, 'home');
}

/** The daemon's state record, naming the process the caller chose. */
function daemonRecord(home: string, pid: number): void {
  const state: DaemonState = {
    format: 1,
    pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    since: '2026-11-02T17:00:00.000Z',
    startedBy: 'test',
    version: 'test',
    heartbeatAt: AT.toISOString(),
    socket: join(home, '.config', 'team', 'daemon.sock'),
    features: { broker: 'absent' },
    stuck: [],
    roots: [{ root: '/work/acme', team: 'acme', send: 'serving', bus: 'serving', why: null }],
  };
  writeDaemonState(home, state);
  mkdirSync(dirname(daemonLockPath(home)), { recursive: true });
  writeFileSync(daemonLockPath(home), `${String(pid)}\n`);
}

type Verdict = { pid: number; ppid: number; ok: boolean; why: string | null };

function runWorker(home: string, mode: 'verify' | 'spawn'): { mine: Verdict; child?: { mine: Verdict } } {
  const run = spawnSync(process.execPath, [WORKER, home, AT.toISOString(), mode], { encoding: 'utf8', timeout: 30_000 });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) throw new Error(`the worker exited with ${String(run.status)}: ${run.stderr}`);
  return JSON.parse(run.stdout) as { mine: Verdict; child?: { mine: Verdict } };
}

describe('a process the daemon started', () => {
  test('a worker under the record\'s own process stands, and its roots are the record\'s', () => {
    const home = machineHome();
    daemonRecord(home, process.pid);
    const ran = runWorker(home, 'verify');
    expect(ran.mine.ok).toBe(true);
    expect(ran.mine.why).toBeNull();
    // The proof that was read: this worker's parent is the process the record names.
    expect(ran.mine.ppid).toBe(process.pid);
    expect(ran.mine.pid).not.toBe(process.pid);
  }, 30_000);

  test('a process that worker started is refused: only the daemon can make a sender its child', () => {
    const home = machineHome();
    daemonRecord(home, process.pid);
    const ran = runWorker(home, 'spawn');
    expect(ran.mine.ok).toBe(true);
    const grandchild = ran.child?.mine;
    if (grandchild === undefined) throw new Error('the worker reported no child verdict');
    expect(grandchild.ok).toBe(false);
    expect(grandchild.why).toContain(`names process ${String(process.pid)}`);
    // It names the boundary it failed at: the parent it does have, not the daemon.
    expect(grandchild.why).toContain(`whose parent is ${String(ran.mine.pid)}`);
  }, 30_000);
});
