// Synthetic restore runner and daemon only: the existing startup retry window is accelerated
// through its test seams. No live CLI, service manager or terminal session is used.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { daemonLogPath } from '../src/daemon/paths.ts';
import type { RestoreSweepResult } from '../src/launch/restore-sweep.ts';
import { restoreSummaryOf } from '../src/launch/execute.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'restore-load-')));
  dirs.push(base);
  const root = join(base, 'root'); const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true }); mkdirSync(home);
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
  return { root, home };
}

// A test-only ceiling on a polling assertion, not a production restore threshold.
async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= end) throw new Error('synthetic restore did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const held: RestoreSweepResult = { kind: 'refused', exit: 1, retry: 'load', detail: 'the load is 3.4 per core, above 3' };

test('load-held restore waits, retries, then plans when the guard clears', async () => {
  const { root, home } = fixture(); let attempts = 0;
  const started = await startMachineDaemon({ home, roots: [root], version: 'test', startedBy: 'test', heartbeatMs: 10_000,
    // Test overrides of the existing startup retry cadence, kept short for this synthetic run.
    restoreRetryInitialDelayMs: 5, restoreRetryMaxDelayMs: 10, restoreRetryBudgetMs: 35,
    restoreSweep: async () => ++attempts < 3 ? held
      : { kind: 'ran', failed: false, summary: restoreSummaryOf([{ seat: 'worker', outcome: 'repaired' }]) },
  });
  expect(started.kind).toBe('serving'); if (started.kind !== 'serving') return;
  const log = () => existsSync(daemonLogPath(home)) ? readFileSync(daemonLogPath(home), 'utf8') : '';
  try {
    await waitFor(() => log().includes('1 seat repaired'));
    expect(attempts).toBe(3);
    expect(log()).toContain('waiting for load guard: the load is 3.4 per core, above 3');
    expect(log()).toContain('waiting 5ms for restore prerequisites');
    expect(log()).not.toContain('retry wait bound reached');
  } finally { await started.daemon.close(); }
});

test('load that never drops uses the existing bound and remains refused', async () => {
  const { root, home } = fixture(); let attempts = 0;
  const started = await startMachineDaemon({ home, roots: [root], version: 'test', startedBy: 'test', heartbeatMs: 10_000,
    restoreRetryInitialDelayMs: 5, restoreRetryMaxDelayMs: 10, restoreRetryBudgetMs: 25,
    restoreSweep: async () => { attempts++; return held; },
  });
  expect(started.kind).toBe('serving'); if (started.kind !== 'serving') return;
  const log = () => existsSync(daemonLogPath(home)) ? readFileSync(daemonLogPath(home), 'utf8') : '';
  try {
    await waitFor(() => log().includes('retry wait bound reached'));
    expect(attempts).toBe(4); // Initial + waits of 5, 10, 10 ms, exactly the injected budget.
    expect(log()).toContain('1 still load-held after 25ms');
    expect(log()).not.toContain('seat repaired');
    expect(held).toMatchObject({ kind: 'refused', exit: 1 });
  } finally { await started.daemon.close(); }
});

test('non-load refusals are not retried', async () => {
  const { root, home } = fixture(); let attempts = 0;
  const started = await startMachineDaemon({ home, roots: [root], version: 'test', startedBy: 'test', heartbeatMs: 10_000,
    restoreRetryInitialDelayMs: 5, restoreRetryMaxDelayMs: 10, restoreRetryBudgetMs: 25,
    restoreSweep: async () => { attempts++; return { kind: 'refused', exit: 1, detail: 'synthetic login refusal' }; },
  });
  expect(started.kind).toBe('serving'); if (started.kind !== 'serving') return;
  try {
    await waitFor(() => existsSync(daemonLogPath(home)) && readFileSync(daemonLogPath(home), 'utf8').includes('synthetic login refusal'));
    expect(attempts).toBe(1);
    expect(readFileSync(daemonLogPath(home), 'utf8')).not.toContain('restore: waiting');
  } finally { await started.daemon.close(); }
});

test('a partial batch deferred only by load retries the remaining restore', async () => {
  const { root, home } = fixture(); let attempts = 0;
  const started = await startMachineDaemon({ home, roots: [root], version: 'test', startedBy: 'test', heartbeatMs: 10_000,
    restoreRetryInitialDelayMs: 5, restoreRetryMaxDelayMs: 10, restoreRetryBudgetMs: 25,
    restoreSweep: async () => ++attempts === 1
      ? { kind: 'ran', failed: true, retry: 'load', detail: held.detail,
          summary: restoreSummaryOf([{ seat: 'worker', outcome: 'refused', reason: held.detail! }]) }
      : { kind: 'ran', failed: false, summary: restoreSummaryOf([{ seat: 'worker', outcome: 'repaired' }]) },
  });
  expect(started.kind).toBe('serving'); if (started.kind !== 'serving') return;
  try {
    await waitFor(() => existsSync(daemonLogPath(home)) && readFileSync(daemonLogPath(home), 'utf8').includes('1 seat repaired'));
    expect(attempts).toBe(2);
  } finally { await started.daemon.close(); }
});

test('a seat refused on a launch timeout gets exactly one more pass on the retry schedule', async () => {
  // 16 Nov reboot: "3 seats repaired, 0 skipped (working), 1 refused (tester-gemini: timeout)".
  const { root, home } = fixture(); let attempts = 0;
  const started = await startMachineDaemon({ home, roots: [root], version: 'test', startedBy: 'test', heartbeatMs: 10_000,
    restoreRetryInitialDelayMs: 5, restoreRetryMaxDelayMs: 10, restoreRetryBudgetMs: 60,
    restoreSweep: async () => {
      attempts++;
      return { kind: 'ran', failed: true, summary: restoreSummaryOf([{ seat: 'worker', outcome: 'refused', reason: 'timeout' }]) };
    },
  });
  expect(started.kind).toBe('serving'); if (started.kind !== 'serving') return;
  const log = () => existsSync(daemonLogPath(home)) ? readFileSync(daemonLogPath(home), 'utf8') : '';
  try {
    await waitFor(() => attempts >= 2);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(attempts).toBe(2);
    expect(log()).toContain('1 retrying a seat that timed out');
    expect(log()).not.toContain('restore: pending');
  } finally { await started.daemon.close(); }
});

test('a refusal that is not a timeout is not given the extra pass', async () => {
  const { root, home } = fixture(); let attempts = 0;
  const started = await startMachineDaemon({ home, roots: [root], version: 'test', startedBy: 'test', heartbeatMs: 10_000,
    restoreRetryInitialDelayMs: 5, restoreRetryMaxDelayMs: 10, restoreRetryBudgetMs: 60,
    restoreSweep: async () => {
      attempts++;
      return { kind: 'ran', failed: true, summary: restoreSummaryOf([{ seat: 'worker', outcome: 'refused', reason: 'the login prompt is up' }]) };
    },
  });
  expect(started.kind).toBe('serving'); if (started.kind !== 'serving') return;
  try {
    await waitFor(() => attempts >= 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(attempts).toBe(1);
  } finally { await started.daemon.close(); }
});
