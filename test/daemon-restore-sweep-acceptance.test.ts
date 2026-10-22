// Gap 4C at the daemon boundary: the restore sweep is scheduled once per
// canonical route after serving is wired, logs its owner summary, is drained by close, and
// never starts for a route that is not a canonical accepted route. The runner is injected here,
// so these scenes prove the schedule and the drain, never a real launch.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonLogPath, daemonSocketPath } from '../src/daemon/paths.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { restoreSummaryOf } from '../src/launch/execute.ts';
import type { RestoreSweepResult } from '../src/launch/restore-sweep.ts';

const TEAM = `format: 1
project: acme
coordinator: clerk
operator: op-1
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: clerk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: worker
    name: op-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

const bases: string[] = [];

function scratch(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-restore-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return { root, home };
}

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the restore sweep');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const quiet: RestoreSweepResult = { kind: 'no-recorded-session' };

describe('the daemon restores its routes at start', () => {
  test('one pass per canonical route, and a repaired route logs its owner line', async () => {
    const { root, home } = scratch();
    const link = join(root, '..', 'repo-link');
    symlinkSync(root, link);
    const calls: string[] = [];
    const started = await startMachineDaemon({
      home,
      roots: [root, link],
      startedBy: 'test',
      version: '0.5.4-test',
      heartbeatMs: 10_000,
      restoreSweep: (one) => {
        calls.push(one);
        return Promise.resolve(one === root
          ? { kind: 'ran', summary: restoreSummaryOf([{ seat: 'op-1', outcome: 'repaired' }]), failed: false }
          : quiet);
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      await waitFor(() => existsSync(daemonLogPath(home)) && readFileSync(daemonLogPath(home), 'utf8').includes('restore '));
      // The duplicate spelling is the same canonical route, so one pass ran, once.
      expect(calls).toEqual([root]);
      const log = readFileSync(daemonLogPath(home), 'utf8');
      expect(log).toContain(`restore ${root}: 1 seat repaired, 0 skipped (working), 0 refused`);
    } finally {
      await started.daemon.close();
    }
  });

  test('a route whose session records nothing logs nothing and still counts as swept', async () => {
    const { root, home } = scratch();
    const calls: string[] = [];
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'test',
      version: '0.5.4-test',
      heartbeatMs: 10_000,
      restoreSweep: (one) => {
        calls.push(one);
        return Promise.resolve(quiet);
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      await waitFor(() => calls.length === 1);
      expect(readFileSync(daemonLogPath(home), 'utf8').includes('restore ')).toBe(false);
    } finally {
      await started.daemon.close();
    }
  });

  test('restoreSweep: false schedules no pass', async () => {
    const { root, home } = scratch();
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'test',
      version: '0.5.4-test',
      heartbeatMs: 10_000,
      restoreSweep: false,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      // A beat of the event loop is enough to prove nothing was scheduled.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const logged = existsSync(daemonLogPath(home)) ? readFileSync(daemonLogPath(home), 'utf8') : '';
      expect(logged.includes('restore ')).toBe(false);
    } finally {
      await started.daemon.close();
    }
  });

  test('close drains a pass in flight and starts no further route', async () => {
    const first = scratch();
    const second = scratch();
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = await startMachineDaemon({
      home: first.home,
      roots: [first.root, second.root],
      startedBy: 'test',
      version: '0.5.4-test',
      heartbeatMs: 10_000,
      restoreSweep: async (root) => {
        calls.push(root);
        if (root === first.root) await gate;
        return quiet;
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    await waitFor(() => calls.length === 1);
    let closed = false;
    const closing = started.daemon.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The daemon owns nothing until the pass in flight finishes.
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    // The closing flag stopped the loop before the second route.
    expect(calls).toEqual([first.root]);
    expect(existsSync(daemonSocketPath(first.home))).toBe(false);
  });
});
