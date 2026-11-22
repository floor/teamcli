// The daemon's heartbeat runs a route's queued self-restarts (src/daemon/host.ts selfRestartBeat):
// a route with no request starts no pass, and one with a request gets a pass through the runner.
// A synthetic runner only; no terminal host, child process or service manager is used.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { daemonLogPath } from '../src/daemon/paths.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('a queued request gets a self-restart pass on the beat; none starts without one', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'daemon-self-restart-')));
  dirs.push(base);
  const root = join(base, 'root');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
session: acme
coordinator: worker
operator: worker
workspace:
  mode: shared
seats:
  - name: worker
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`);
  const calls: string[] = [];
  const started = await startMachineDaemon({
    home, roots: [root], version: 'test', startedBy: 'test', heartbeatMs: 20,
    restoreSweep: async () => ({ kind: 'no-recorded-session' }),
    selfRestart: async (at) => { calls.push(at); return ['worker: restarted itself with its conversation conv-worker']; },
  });
  expect(started.kind).toBe('serving');
  if (started.kind !== 'serving') return;
  const log = (): string => existsSync(daemonLogPath(home)) ? readFileSync(daemonLogPath(home), 'utf8') : '';
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(calls).toEqual([]);
    mkdirSync(join(root, '.agents', 'self-restart', 'acme'), { recursive: true });
    writeFileSync(join(root, '.agents', 'self-restart', 'acme', 'worker.json'), '{}');
    const end = Date.now() + 3000;
    while (!log().includes('self-restart ') && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toBe(root);
    expect(log()).toContain('worker: restarted itself with its conversation conv-worker');
  } finally {
    await started.daemon.close();
  }
});
