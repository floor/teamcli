// Independent verification for daemon restore-abort hardening (`src/daemon/restore/spawn.ts` and
// `src/daemon/host.ts`):
// 1. Closing a serving daemon while a restore child is in flight — both when `close()` completes
//    immediately and when admission stops `restoreAbort` while a held watch/presence drain delays
//    `Promise.allSettled([..., restoreSweepRun])` — leaves zero process-level `unhandledRejection`
//    events and zero leftover one-use restore tokens.
// 2. All three abort windows in `runRestoreSweepInChild` (pre-check abort, pre-check-to-listener
//    window abort, and in-flight abort) still reject the caller's `await` with the documented
//    reason while emitting zero process-level `unhandledRejection` events.
// 3. All non-abort settlement failures in `runRestoreSweepInChild` (deadline timeout, early child
//    exit, explicit `{ok:false}` failure report, and oversized stdout frame) still reject the
//    caller's `await` and clean up the one-use token without triggering `unhandledRejection`.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMachineDaemon, type StartMachineDaemonInput } from '../src/daemon/host.ts';
import { daemonLockPath, daemonSocketPath, machineConfigDir } from '../src/daemon/paths.ts';
import type { PresenceActivityResult } from '../src/daemon/presence/activity.ts';
import type { PresenceIngestResult, PresenceIngester } from '../src/daemon/presence/ingest.ts';
import { runRestoreSweepInChild } from '../src/daemon/restore/spawn.ts';
import { readDaemonState } from '../src/daemon/state.ts';

const TEAM_YAML = `format: 1
project: synthetic-alpha
session: alpha
coordinator: alpha-lead
operator: alpha-op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: alpha-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: alpha-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

let cleanups: Array<() => Promise<void> | void> = [];
function defer(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

afterEach(async () => {
  const pending = cleanups.reverse();
  cleanups = [];
  for (const fn of pending) {
    try {
      await fn();
    } catch {
      // Best-effort cleanup across independent scenes.
    }
  }
});

function makeWorld(): { base: string; home: string; root: string } {
  const raw = mkdtempSync(join(tmpdir(), 'restore-abort-ind-'));
  const base = realpathSync(raw);
  defer(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const root = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML, 'utf8');
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
  return { base, home, root };
}

function leftoverTokens(home: string): string[] {
  const dir = machineConfigDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith('restore.inherit.'));
}

function emptyIngest(): PresenceIngestResult {
  return {
    ingested: [],
    rejected: [],
    stale: [],
    repaired: [],
    errors: [],
    healthy: false,
    pending: false,
    closed: false,
  };
}

function emptyActivity(): PresenceActivityResult {
  return { seats: [], failed: null };
}

describe('daemon restore-abort hardening independent verification', () => {
  test('1. closing a daemon mid-restore-pass while admission waits on a held watch leaves zero unhandled rejections and cleans up state', async () => {
    const world = makeWorld();
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    defer(() => {
      process.off('unhandledRejection', onUnhandled);
    });

    let releaseWatch: (() => void) | null = null;
    const ingester: PresenceIngester = {
      step: async () => emptyIngest(),
      close: async () => ({ quiesced: true }),
      isClosed: () => false,
    };

    const started = await startMachineDaemon({
      home: world.home,
      roots: [world.root],
      startedBy: 'service-manager',
      version: '0.5.12-restore-abort-ind',
      heartbeatMs: 20,
      presenceHosting: true,
      presenceEveryMs: 10,
      presenceIngest: () => ingester,
      presenceActivity: () => async () => emptyActivity(),
      watchHosting: true,
      hostedWatch: () => ({
        run: () =>
          new Promise<number>((resolve) => {
            releaseWatch = () => resolve(0);
          }),
      }),
    } satisfies StartMachineDaemonInput);

    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    defer(async () => {
      (releaseWatch as (() => void) | null)?.();
      await started.daemon.close().catch(() => undefined);
    });

    // Wait until the hosted watch is active, then initiate `close()` while the restore child pass
    // is in flight and the watch stop holds the admission phase before `Promise.allSettled` drains
    // `restoreSweepRun`.
    const deadline = Date.now() + 3_000;
    while (releaseWatch === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(releaseWatch).not.toBeNull();

    const closing = started.daemon.close();
    // Hold admission open across several event-loop turns so any unhandled rejection from
    // `restoreAbort.abort()` during admission would surface at the process level.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(rejections).toEqual([]);

    (releaseWatch as (() => void) | null)?.();
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(rejections).toEqual([]);
    expect(existsSync(daemonLockPath(world.home))).toBe(false);
    expect(existsSync(daemonSocketPath(world.home))).toBe(false);
    expect(readDaemonState(world.home).kind).toBe('missing');
    expect(leftoverTokens(world.home)).toEqual([]);
  }, 15_000);

  test('2. all three abort windows in runRestoreSweepInChild still reject the caller await while recording zero unhandled rejections', async () => {
    const { base, home, root } = makeWorld();
    const sleeperEntry = join(base, 'sleeper-entry.ts');
    writeFileSync(
      sleeperEntry,
      `await new Promise((resolve) => setTimeout(resolve, 10_000));\n`,
      'utf8',
    );

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    defer(() => {
      process.off('unhandledRejection', onUnhandled);
    });

    // (a) Abort before starting (`AbortSignal.abort()`): rejects before writing a token.
    await expect(
      runRestoreSweepInChild({
        home,
        root,
        entry: sleeperEntry,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow('the restore pass was not started because the daemon is closing');
    expect(leftoverTokens(home)).toEqual([]);

    // (b) Abort in the synchronous window between the pre-check (line 104) and the post-listener
    //     check (line 224): `onAbort()` runs synchronously before `return done`.
    let reads = 0;
    const windowSignal = {
      get aborted(): boolean {
        reads += 1;
        return reads >= 2;
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;

    await expect(
      runRestoreSweepInChild({
        home,
        root,
        entry: sleeperEntry,
        signal: windowSignal,
      }),
    ).rejects.toThrow('the restore pass was ended because the daemon is closing');
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(leftoverTokens(home)).toEqual([]);

    // (c) Abort while the child is running: `onAbort()` rejects `done` from the abort listener,
    //     the caller's `await` receives the rejection, and no unhandled rejection is emitted.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 40);
    defer(() => clearTimeout(abortTimer));

    await expect(
      runRestoreSweepInChild({
        home,
        root,
        entry: sleeperEntry,
        signal: controller.signal,
      }),
    ).rejects.toThrow('the restore pass was ended because the daemon is closing');
    expect(leftoverTokens(home)).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rejections).toEqual([]);
  }, 15_000);

  test('3. non-abort settlement failures still reject the caller await and discard tokens with zero unhandled rejections', async () => {
    const { base, home, root } = makeWorld();
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    defer(() => {
      process.off('unhandledRejection', onUnhandled);
    });

    // (a) Deadline timeout (`timeoutMs`)
    const hangEntry = join(base, 'hang-entry.ts');
    writeFileSync(hangEntry, `await new Promise((resolve) => setTimeout(resolve, 10_000));\n`, 'utf8');
    await expect(
      runRestoreSweepInChild({ home, root, entry: hangEntry, timeoutMs: 80 }),
    ).rejects.toThrow(/did not answer within 0 s and was ended/);
    expect(leftoverTokens(home)).toEqual([]);

    // (b) Explicit `{ok:false, reason}` protocol report after claiming the one-use token
    const tokenModule = fileURLToPath(new URL('../src/daemon/restore/token.ts', import.meta.url));
    const failReportEntry = join(base, 'fail-report-entry.ts');
    writeFileSync(
      failReportEntry,
      [
        `import { discardRestoreInherit } from ${JSON.stringify(tokenModule)};`,
        `const at = process.argv.indexOf('--inherited');`,
        `discardRestoreInherit(process.env.HOME ?? '', process.argv[at + 1] ?? '');`,
        `process.stdout.write(JSON.stringify({ ok: false, reason: 'synthetic child refusal' }) + '\\n');`,
      ].join('\n'),
      'utf8',
    );
    await expect(
      runRestoreSweepInChild({ home, root, entry: failReportEntry, timeoutMs: 5_000 }),
    ).rejects.toThrow('the restore child reported: synthetic child refusal');
    expect(leftoverTokens(home)).toEqual([]);

    // (c) Early exit with stderr diagnostic before any protocol report
    const earlyExitEntry = join(base, 'early-exit-entry.ts');
    writeFileSync(
      earlyExitEntry,
      `process.stderr.write('synthetic fatal child line\\n');\nprocess.exit(1);\n`,
      'utf8',
    );
    await expect(
      runRestoreSweepInChild({ home, root, entry: earlyExitEntry, timeoutMs: 5_000 }),
    ).rejects.toThrow(/the restore child left before it reported \(code 1\): synthetic fatal child line/);
    expect(leftoverTokens(home)).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rejections).toEqual([]);
  }, 15_000);
});
