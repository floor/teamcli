// Independent verification of feat/seat-health-watchdog (d1187e4d4):
// 1. A still screen across two full wait intervals with no live child and no dialog restarts
//    once through `team restart <seat> --json`, and a second pass after the restart fails (or
//    completes) tells the lead instead of restarting again.
// 2. A live child or a recognized dialog (trust, permission, login, and hold dialogs) never
//    restarts and tells the lead once per window.
// 3. `seat.dialog.answer` policy enforces tightening only across entity -> project -> team -> seat
//    (a lower level may drop a scope, never add one without a fresh owner proof; login is never),
//    and the watchdog still restarts on none of those screens even when scopes are configured.
// 4. The chores child (`serveChoresChild`) starts the restart and returns while the restart is
//    still running, so the heartbeat loop does not wait on it.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { serveChoresChild } from '../src/daemon/chores/child.ts';
import { readChildMessage, type ChoresChildConfig, type ChoresChildMessage } from '../src/daemon/chores/protocol.ts';
import { loadDialogAnswer, trustInside } from '../src/policy/dialog-answer.ts';
import { resolvePolicy } from '../src/policy/resolve.ts';
import { dialogAnswerProblem, getPolicySpec, parseDialogAnswer, type Policy } from '../src/policy/types.ts';
import { observeRoute, processRows, type SeatHealthHost } from '../src/seat-health/live.ts';
import {
  noteRestartFinished,
  restartLandedText,
  runWatchdogSlice,
  stillMsOf,
  watchdogPass,
  watchdogState,
  type WatchdogSeat,
} from '../src/seat-health/pass.ts';
import {
  DIALOG_HOLD,
  DIALOG_LEAD,
  WATCHDOG_AFTER_MS,
  isDialogKind,
  liveChild,
  proofNow,
  screenDigest,
} from '../src/seat-health/proof.ts';
import { readRestartReady, restartArgs, type RestartReady } from '../src/seat-health/restart.ts';

const MINUTE = 60_000;
const T0_ISO = '2026-11-04T09:00:00.000Z';
const T0_MS = Date.parse(T0_ISO);

function makeSeat(overrides: Partial<WatchdogSeat> = {}): WatchdogSeat {
  return {
    seat: 'worker-1',
    cli: 'claude-code',
    reconciled: 'working',
    hostStatus: 'working',
    plain: 'Analyzing repository state...',
    screenKind: 'working',
    presenceAt: T0_ISO,
    processes: [
      { pid: 100, argv0: 'zsh', shell: true, cli: false },
      { pid: 101, argv0: 'claude', shell: false, cli: true },
    ],
    session: { kind: 'bound' },
    resume: 'claude --resume sess-001',
    ...overrides,
  };
}

function waitUntil(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for condition'));
      }
    }, 10);
  });
}

describe('feat/seat-health-watchdog independent verification', () => {
  test('1. a still screen for two full wait intervals with no live child and no dialog restarts once, and a second pass after restart fails tells the lead instead of restarting again', async () => {
    const state = watchdogState();
    const restarts: Array<{ seat: string; args: readonly string[] }> = [];
    const leadMessages: string[] = [];
    let resolveRestart: (outcome: RestartReady | { kind: 'failed' }) => void = () => {};

    const seat = makeSeat();

    // Pass at t = 0 and t = 14m: clock starts and accumulates, no effect yet
    await runWatchdogSlice(state, {
      seats: [seat],
      now: 0,
      restart: async (s, args) => {
        restarts.push({ seat: s, args });
        return { kind: 'failed' };
      },
      lead: (text) => leadMessages.push(text),
    });
    expect(restarts).toEqual([]);
    expect(leadMessages).toEqual([]);

    await runWatchdogSlice(state, {
      seats: [seat],
      now: 14 * MINUTE,
      restart: async (s, args) => {
        restarts.push({ seat: s, args });
        return { kind: 'failed' };
      },
      lead: (text) => leadMessages.push(text),
    });
    expect(restarts).toEqual([]);
    expect(leadMessages).toEqual([]);

    // First full wait interval (t = WATCHDOG_AFTER_MS = 15m): starts one `team restart <seat> --json`
    await runWatchdogSlice(state, {
      seats: [seat],
      now: WATCHDOG_AFTER_MS,
      restart: (s, args) => {
        restarts.push({ seat: s, args });
        return new Promise((resolve) => {
          resolveRestart = resolve;
        });
      },
      lead: (text) => leadMessages.push(text),
    });
    expect(restarts).toEqual([{ seat: 'worker-1', args: ['restart', 'worker-1', '--json'] }]);
    expect(stillMsOf(state, 'worker-1')).toBe(WATCHDOG_AFTER_MS);
    expect(leadMessages).toEqual([]);

    // While the first restart is still in flight (t = 16m), another pass neither restarts nor tells the lead
    expect(watchdogPass(state, [seat], WATCHDOG_AFTER_MS + MINUTE)).toEqual([]);

    // Now the restart fails: lead is notified that the restart did not become ready
    resolveRestart({ kind: 'failed' });
    await Promise.resolve();
    await Promise.resolve();
    expect(leadMessages).toEqual(['worker-1: the restart did not become ready']);

    // Second full wait interval (t = 2 * WATCHDOG_AFTER_MS = 30m) with screen still unchanged:
    // tells the lead once instead of restarting again
    await runWatchdogSlice(state, {
      seats: [seat],
      now: WATCHDOG_AFTER_MS * 2,
      restart: async (s, args) => {
        restarts.push({ seat: s, args });
        return { kind: 'failed' };
      },
      lead: (text) => leadMessages.push(text),
    });
    expect(restarts).toHaveLength(1);
    expect(leadMessages).toEqual([
      'worker-1: the restart did not become ready',
      'worker-1: a second stall in the restart window',
    ]);

    // Subsequent passes in the same window (t = 45m) neither restart nor spam the lead
    expect(watchdogPass(state, [seat], WATCHDOG_AFTER_MS * 3)).toEqual([]);

    // Once the seat is observed idle, the restart window resets; a subsequent full wait restarts once again
    expect(watchdogPass(state, [makeSeat({ reconciled: 'idle' })], WATCHDOG_AFTER_MS * 3 + MINUTE)).toEqual([]);
    const tReset = WATCHDOG_AFTER_MS * 4;
    expect(watchdogPass(state, [seat], tReset)).toEqual([]);
    expect(watchdogPass(state, [seat], tReset + WATCHDOG_AFTER_MS)).toEqual([
      { kind: 'restart', seat: 'worker-1', args: restartArgs('worker-1') },
    ]);
    noteRestartFinished(state, 'worker-1');

    // Also verify ready JSON parsing and handover message variants without leaking file paths
    expect(
      readRestartReady(
        'noise before\n{"schema":{"name":"team.restart","version":1},"status":"ready","handover":"/secret/path/h.md"}\n',
      ),
    ).toEqual({ kind: 'ready', handover: '/secret/path/h.md' });
    expect(
      readRestartReady(
        '{"schema":{"name":"team.restart","version":1},"status":"ready","handover_asked":"/secret/path/missing.md"}',
      ),
    ).toEqual({ kind: 'ready', handoverAsked: '/secret/path/missing.md' });
    expect(readRestartReady('{"schema":{"name":"team.restart","version":1},"status":"failed"}')).toBeNull();

    const landedWithFile = restartLandedText('worker-1', WATCHDOG_AFTER_MS, {
      kind: 'ready',
      handover: '/secret/path/h.md',
    });
    expect(landedWithFile).toBe(
      'worker-1: restarted after 15 minutes with the screen unchanged; the recorded conversation was resumed; a handover file was already there',
    );
    expect(landedWithFile).not.toContain('/secret/path');
  });

  test('2. a live child or a recognized dialog never restarts and tells the lead once per window', async () => {
    // (a) Live child process under the pane
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-ind-child-'));
    try {
      const host: SeatHealthHost = {
        agents: async () => [{ name: 'worker-1', pane: 'pane-1', status: 'working' }],
        text: async () => 'Running long test suite...',
        processes: async () => ({
          process_info: {
            shell_pid: 100,
            foreground_processes: [
              { pid: 100, argv0: '/bin/zsh' },
              { pid: 101, argv0: '/usr/local/bin/claude' },
              { pid: 102, argv0: '/opt/homebrew/bin/bun' },
            ],
          },
        }),
      };
      const observed = await observeRoute(
        {
          home: dir,
          root: dir,
          session: 'demo',
          seats: [{ name: 'worker-1', cli: 'claude-code', launch: 'claude' }],
        },
        host,
      );
      expect(observed).toHaveLength(1);
      expect(observed[0]!.processes).not.toBeNull();
      expect(liveChild(observed[0]!.processes!)).toBe(true);
      expect(proofNow(observed[0]!)).toEqual({ holds: false, why: 'child' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const childSeat = makeSeat({
      processes: processRows(
        {
          process_info: {
            shell_pid: 100,
            foreground_processes: [
              { pid: 100, argv0: 'zsh' },
              { pid: 101, argv0: 'claude' },
              { pid: 102, argv0: 'cargo' },
            ],
          },
        },
        ['claude'],
      ),
    });
    const childState = watchdogState();
    expect(watchdogPass(childState, [childSeat], 0)).toEqual([]);
    expect(watchdogPass(childState, [childSeat], 14 * MINUTE)).toEqual([]);
    // At 15m: tells the lead once, never restarts
    expect(watchdogPass(childState, [childSeat], WATCHDOG_AFTER_MS)).toEqual([
      { kind: 'lead', text: 'worker-1: a live child is still running' },
    ]);
    // At 30m and 45m: still never restarts and does not repeat the live-child message in the same window
    expect(watchdogPass(childState, [childSeat], WATCHDOG_AFTER_MS * 2)).toEqual([]);
    expect(watchdogPass(childState, [childSeat], WATCHDOG_AFTER_MS * 3)).toEqual([]);

    // When the child exits at 46m, the stillness clock starts fresh from 46m (no immediate restart)
    const noChildSeat = makeSeat();
    const tChildExit = WATCHDOG_AFTER_MS * 3 + MINUTE;
    expect(watchdogPass(childState, [noChildSeat], tChildExit)).toEqual([]);
    expect(watchdogPass(childState, [noChildSeat], tChildExit + 14 * MINUTE)).toEqual([]);
    expect(watchdogPass(childState, [noChildSeat], tChildExit + WATCHDOG_AFTER_MS)).toEqual([
      { kind: 'restart', seat: 'worker-1', args: ['restart', 'worker-1', '--json'] },
    ]);

    // (b) Recognized lead dialogs: trust, permission, login (account/login screen)
    for (const dialogKind of DIALOG_LEAD) {
      const dState = watchdogState();
      const dSeat = makeSeat({
        screenKind: dialogKind,
        plain: ` sensitive prompt for ${dialogKind}: /private/token `,
      });
      expect(isDialogKind(dialogKind)).toBe(true);
      expect(proofNow(dSeat)).toEqual({ holds: false, why: 'dialog' });

      // Immediate notice at t = 0, without leaking screen content
      const first = watchdogPass(dState, [dSeat], 0);
      expect(first).toEqual([{ kind: 'lead', text: `worker-1: the screen is ${dialogKind}` }]);
      expect(JSON.stringify(first)).not.toContain('/private/token');

      // Across 15m and 30m: never restarts and never repeats the same dialog notice
      expect(watchdogPass(dState, [dSeat], WATCHDOG_AFTER_MS)).toEqual([]);
      expect(watchdogPass(dState, [dSeat], WATCHDOG_AFTER_MS * 2)).toEqual([]);
    }

    // (c) Recognized hold dialogs: question, exit question, plan approval, confirmation, vendor notice, rate limit, guard
    for (const holdKind of DIALOG_HOLD) {
      const hState = watchdogState();
      const hSeat = makeSeat({ screenKind: holdKind });
      expect(isDialogKind(holdKind)).toBe(true);
      expect(proofNow(hSeat)).toEqual({ holds: false, why: 'dialog' });
      expect(watchdogPass(hState, [hSeat], 0)).toEqual([]);
      expect(watchdogPass(hState, [hSeat], WATCHDOG_AFTER_MS)).toEqual([]);
      expect(watchdogPass(hState, [hSeat], WATCHDOG_AFTER_MS * 2)).toEqual([]);
    }
  });

  test('3. dialog-answer policy enforces tightening only, login is never, loosening requires a fresh owner proof, and the watchdog still restarts on none of those screens', () => {
    const now = new Date(T0_ISO);
    const freshProof = new Date(T0_MS - 2_000).toISOString();
    const staleProof = new Date(T0_MS - 60_000).toISOString();
    const futureProof = new Date(T0_MS + 5_000).toISOString();
    const roots = ['/work/alpha', '/work/beta'];

    // `trustInside` path boundary checks
    expect(trustInside('/work/alpha', roots)).toBe(true);
    expect(trustInside('/work/alpha/sub/dir', roots)).toBe(true);
    expect(trustInside('/work/alpha-other', roots)).toBe(false);
    expect(trustInside('/work/alpha/../other', roots)).toBe(false);

    // Release default is empty (`trust: [], permission: [], login: 'never'`)
    expect(loadDialogAnswer({ now, roots, levels: {} })).toEqual({
      ok: true,
      answer: { trust: [], permission: [], login: 'never' },
    });

    // `login` set to anything (including `login:never`, `login:always`, `account:login`) or unknown permission is refused
    for (const bad of [['login:never'], ['login:always'], ['account:login'], ['permission:rm-rf'], ['trust:']]) {
      expect(parseDialogAnswer(bad)).toBeNull();
      expect(dialogAnswerProblem(bad)).toContain('login is never');
      const res = loadDialogAnswer({ now, roots, levels: { entity: { value: bad } } });
      expect(res.ok).toBe(false);
    }

    // Progressive tightening across all 4 levels (entity -> project -> team -> seat) succeeds
    const tightenedChain = loadDialogAnswer({
      now,
      roots,
      levels: {
        entity: {
          value: [
            'trust:/work/alpha',
            'trust:/work/beta',
            'permission:rerun-failed',
            'permission:deploy',
          ],
        },
        project: {
          value: ['trust:/work/alpha', 'permission:rerun-failed', 'permission:deploy'],
        },
        team: {
          value: ['trust:/work/alpha', 'permission:rerun-failed'],
        },
        seat: {
          value: ['permission:rerun-failed'],
        },
      },
    });
    expect(tightenedChain).toEqual({
      ok: true,
      answer: { trust: [], permission: ['rerun-failed'], login: 'never' },
    });

    // Loosening at any lower level without a proof is refused
    const loosenedProject = loadDialogAnswer({
      now,
      roots,
      levels: {
        entity: { value: ['trust:/work/alpha'] },
        project: { value: ['trust:/work/alpha', 'trust:/work/beta'] },
      },
    });
    expect(loosenedProject.ok).toBe(false);

    const loosenedSeat = loadDialogAnswer({
      now,
      roots,
      levels: {
        entity: { value: ['trust:/work/alpha'] },
        seat: { value: ['trust:/work/alpha', 'permission:deploy'] },
      },
    });
    expect(loosenedSeat.ok).toBe(false);

    // Loosening with a stale or future owner proof is refused
    expect(
      loadDialogAnswer({
        now,
        roots,
        levels: {
          entity: { value: ['trust:/work/alpha'] },
          team: { value: ['trust:/work/alpha', 'permission:deploy'], proofAt: staleProof },
        },
      }).ok,
    ).toBe(false);
    expect(
      loadDialogAnswer({
        now,
        roots,
        levels: {
          entity: { value: ['trust:/work/alpha'] },
          team: { value: ['trust:/work/alpha', 'permission:deploy'], proofAt: futureProof },
        },
      }).ok,
    ).toBe(false);

    // Loosening with a fresh owner proof is admitted, and a lower level below it can still tighten
    const loosenedWithFreshProof = loadDialogAnswer({
      now,
      roots,
      levels: {
        entity: { value: ['trust:/work/alpha'] },
        team: {
          value: ['trust:/work/alpha', 'trust:/work/beta', 'permission:deploy'],
          proofAt: freshProof,
        },
        seat: {
          value: ['trust:/work/beta', 'permission:deploy'],
        },
      },
    });
    expect(loosenedWithFreshProof).toEqual({
      ok: true,
      answer: {
        trust: ['/work/beta'],
        permission: ['deploy'],
        login: 'never',
      },
    });

    // Watchdog policies (`seat-health.watchdog.after` and `seat-health.watchdog.auto-restart`) also tighten only
    const afterDecl = (level: 'entity' | 'team', value: number): Policy<number> => ({
      name: 'seat-health.watchdog.after',
      value,
      level,
      setter: 'owner',
      date: T0_ISO,
      expiry: null,
      kind: 'enforced',
    });
    expect(resolvePolicy('seat-health.watchdog.after', [afterDecl('entity', 900), afterDecl('team', 1200)]).ok).toBe(
      true,
    );
    expect(resolvePolicy('seat-health.watchdog.after', [afterDecl('entity', 900), afterDecl('team', 600)]).ok).toBe(
      false,
    );

    const autoDecl = (level: 'entity' | 'team', value: number): Policy<number> => ({
      name: 'seat-health.watchdog.auto-restart',
      value,
      level,
      setter: 'owner',
      date: T0_ISO,
      expiry: null,
      kind: 'enforced',
    });
    expect(
      resolvePolicy('seat-health.watchdog.auto-restart', [autoDecl('entity', 1), autoDecl('team', 0)]).ok,
    ).toBe(true);
    expect(
      resolvePolicy('seat-health.watchdog.auto-restart', [autoDecl('entity', 0), autoDecl('team', 1)]).ok,
    ).toBe(false);
    expect(getPolicySpec('seat-health.watchdog.auto-restart')?.parseValue(2)).toBeNull();

    // Even with `seat.dialog.answer` scopes configured, the watchdog never restarts on trust, permission, or login screens
    for (const kind of ['trust', 'permission', 'login'] as const) {
      const state = watchdogState();
      const seat = makeSeat({ screenKind: kind });
      expect(watchdogPass(state, [seat], 0)).toEqual([{ kind: 'lead', text: `worker-1: the screen is ${kind}` }]);
      expect(watchdogPass(state, [seat], WATCHDOG_AFTER_MS)).toEqual([]);
      expect(watchdogPass(state, [seat], WATCHDOG_AFTER_MS * 2)).toEqual([]);
    }
  });

  test('4. the chores child starts the restart and returns while the restart is still running, so the daemon loop does not wait on it', async () => {
    let clock = T0_MS;
    let finishRestart: (outcome: RestartReady | { kind: 'failed' }) => void = () => {};
    let restartFinished = false;
    const restarts: Array<{ seat: string; args: readonly string[] }> = [];
    const leadNotes: string[] = [];

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const frames: ChoresChildMessage[] = [];
    let buf = '';
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      buf += chunk;
      let idx = buf.indexOf('\n');
      while (idx !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\n');
        if (line.trim() === '') continue;
        const msg = readChildMessage(JSON.parse(line) as Record<string, unknown>);
        if (msg !== null) frames.push(msg);
      }
    });

    const config: ChoresChildConfig = {
      version: 1,
      home: '/tmp/watchdog-ind-home',
      beatMs: 25,
      sliceMs: 2_000,
      since: T0_ISO,
      routes: [{ root: '/work/demo', team: 'demo', session: 'demo' }],
    };

    const childPromise = serveChoresChild({
      config,
      stdin,
      stdout,
      now: () => new Date(clock),
      pass: async () => [],
      watchdog: {
        seats: async () => [makeSeat({ plain: '\x1b[33mAnalyzing repository state...\x1b[0m' })],
        restart(_route, seat, args) {
          restarts.push({ seat, args });
          return new Promise((resolve) => {
            finishRestart = (outcome) => {
              restartFinished = true;
              resolve(outcome);
            };
          });
        },
        lead(_route, text) {
          leadNotes.push(text);
        },
      },
    });

    // verify SGR colour-only differences produce identical digest
    expect(screenDigest('\x1b[33mAnalyzing repository state...\x1b[0m')).toBe(
      screenDigest('Analyzing repository state...'),
    );

    const sendTick = (atMs: number) => {
      stdin.write(`${JSON.stringify({ type: 'tick', id: `tick-${atMs}`, at: new Date(atMs).toISOString() })}\n`);
    };

    await waitUntil(() => frames.some((f) => f.type === 'heartbeat'));
    sendTick(clock);
    await waitUntil(() => frames.filter((f) => f.type === 'heartbeat').length >= 2);

    // Advance 15 minutes and trigger the restart slice
    clock += WATCHDOG_AFTER_MS;
    sendTick(clock);
    await waitUntil(() => restarts.length === 1);

    // While the restart promise is still unresolved (`restartFinished === false`),
    // the chores child has already returned from the slice and continues emitting heartbeats!
    const beatsAtStart = frames.filter((f) => f.type === 'heartbeat').length;
    await waitUntil(() => frames.filter((f) => f.type === 'heartbeat').length >= beatsAtStart + 2);
    expect(restartFinished).toBe(false);
    expect(restarts).toEqual([{ seat: 'worker-1', args: ['restart', 'worker-1', '--json'] }]);
    expect(leadNotes).toEqual([]);

    // Another tick while the restart is still running does not launch a second restart
    clock += MINUTE;
    sendTick(clock);
    const beatsAfterExtraTick = frames.filter((f) => f.type === 'heartbeat').length;
    await waitUntil(() => frames.filter((f) => f.type === 'heartbeat').length >= beatsAfterExtraTick + 1);
    expect(restarts).toHaveLength(1);

    // Resolve the restart and confirm the lead receives the completion message asynchronously
    finishRestart({ kind: 'ready', handover: '/work/demo/.agents/handover.md' });
    await waitUntil(() => leadNotes.length === 1);
    expect(leadNotes[0]).toContain('worker-1: restarted after 15 minutes with the screen unchanged');
    expect(leadNotes[0]).toContain('a handover file was already there');
    expect(leadNotes[0]).not.toContain('handover.md');

    stdin.write(`${JSON.stringify({ type: 'stop', why: 'done' })}\n`);
    expect(await childPromise).toBe(0);
  });
});
