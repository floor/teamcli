// The seat-health watchdog, driven with a fake screen, a fake presence clock, a fake
// process list and a fake restart. Nothing here opens a pane or starts a CLI.
import { describe, expect, test } from 'bun:test';
import { withResume } from '../src/profiles/profile.ts';
import { WATCHDOG_AFTER_MS, screenDigest } from '../src/seat-health/proof.ts';
import { noteRestartFinished, restartLandedText, runWatchdogSlice, watchdogPass, watchdogState, type WatchdogSeat } from '../src/seat-health/pass.ts';
import { readRestartReady, restartArgs } from '../src/seat-health/restart.ts';

const MINUTE = 60_000;

function crew(over: Partial<WatchdogSeat> = {}): WatchdogSeat {
  return {
    seat: 'crew',
    cli: 'claude-code',
    reconciled: 'working',
    hostStatus: 'working',
    plain: 'thinking',
    screenKind: 'working',
    presenceAt: '2026-11-04T08:00:00.000Z',
    processes: [
      { pid: 1, argv0: 'zsh', shell: true, cli: false },
      { pid: 2, argv0: 'claude', shell: false, cli: true },
    ],
    session: { kind: 'bound' },
    resume: '--resume abc123',
    ...over,
  };
}

function effectsAt(seat: WatchdogSeat, at: number, state = watchdogState()) {
  return { state, effects: watchdogPass(state, [seat], at) };
}

describe('seat-health watchdog', () => {
  test('a still working seat restarts once at 15 minutes, and not at 14', () => {
    const state = watchdogState();
    const seat = crew();
    expect(watchdogPass(state, [seat], 0)).toEqual([]);
    expect(watchdogPass(state, [seat], 14 * MINUTE)).toEqual([]);
    const started = watchdogPass(state, [seat], WATCHDOG_AFTER_MS);
    expect(started).toEqual([{ kind: 'restart', seat: 'crew', args: restartArgs('crew') }]);
    expect(restartArgs('crew')).toEqual(['restart', 'crew', '--json']);
  });

  test('the four CLIs that resume do, and Cursor, Muse and Gemini do not', () => {
    const forms = [
      ['claude-code', 'claude', '--resume sess1'],
      ['codex', 'codex', 'resume sess1'],
      ['antigravity', 'agy', '--conversation=sess1'],
      ['grok', 'grok', '-r sess1'],
    ] as const;
    for (const [cli, command, form] of forms) {
      const resume = withResume(cli, command, 'sess1');
      expect(resume).toContain(form);
      const state = watchdogState();
      watchdogPass(state, [crew({ cli, resume })], 0);
      const started = watchdogPass(state, [crew({ cli, resume })], WATCHDOG_AFTER_MS);
      expect(started[0]).toEqual({ kind: 'restart', seat: 'crew', args: restartArgs('crew') });
    }
    for (const cli of ['cursor', 'muse', 'gemini']) {
      expect(withResume(cli, cli, 'sess1')).toBeNull();
      const state = watchdogState();
      watchdogPass(state, [crew({ cli, resume: null })], 0);
      const told = watchdogPass(state, [crew({ cli, resume: null })], WATCHDOG_AFTER_MS);
      expect(told).toEqual([{ kind: 'lead', text: 'crew: this CLI has no resume form' }]);
    }
  });

  test('a silent child for 15 minutes tells the lead and does not open the restart window', () => {
    const child = crew({
      processes: [
        { pid: 1, argv0: 'zsh', shell: true, cli: false },
        { pid: 2, argv0: 'claude', shell: false, cli: true },
        { pid: 3, argv0: 'bun', shell: false, cli: false },
      ],
    });
    const state = watchdogState();
    expect(watchdogPass(state, [child], 0)).toEqual([]);
    expect(watchdogPass(state, [child], WATCHDOG_AFTER_MS)).toEqual([
      { kind: 'lead', text: 'crew: a live child is still running' },
    ]);
    expect(watchdogPass(state, [child], WATCHDOG_AFTER_MS + MINUTE)).toEqual([]);
    // The child leaving starts the stall clock again. The window never opened.
    const quiet = crew();
    expect(watchdogPass(state, [quiet], WATCHDOG_AFTER_MS + MINUTE)).toEqual([]);
    const started = watchdogPass(state, [quiet], WATCHDOG_AFTER_MS + MINUTE + WATCHDOG_AFTER_MS);
    expect(started).toEqual([{ kind: 'restart', seat: 'crew', args: restartArgs('crew') }]);
  });

  test('the host word working with a reconciled idle is not a stall', () => {
    const state = watchdogState();
    const seat = crew({ reconciled: 'idle', hostStatus: 'working' });
    watchdogPass(state, [seat], 0);
    expect(watchdogPass(state, [seat], WATCHDOG_AFTER_MS)).toEqual([]);
  });

  test('a spinner or a turn-end resets the clock', () => {
    const state = watchdogState();
    watchdogPass(state, [crew()], 0);
    expect(watchdogPass(state, [crew({ plain: 'thinking.' })], WATCHDOG_AFTER_MS)).toEqual([]);
    expect(watchdogPass(state, [crew({ plain: 'thinking.' })], WATCHDOG_AFTER_MS + 14 * MINUTE)).toEqual([]);
    const turned = watchdogState();
    watchdogPass(turned, [crew()], 0);
    expect(watchdogPass(turned, [crew({ presenceAt: '2026-11-04T08:15:00.000Z' })], WATCHDOG_AFTER_MS)).toEqual([]);
  });

  test('a colour repaint is the same plain screen', () => {
    expect(screenDigest('\x1b[32mthinking\x1b[0m')).toBe(screenDigest('thinking'));
    const state = watchdogState();
    watchdogPass(state, [crew()], 0);
    expect(watchdogPass(state, [crew({ plain: '\x1b[32mthinking\x1b[0m' })], WATCHDOG_AFTER_MS)[0]?.kind).toBe('restart');
  });

  test('permission, trust and login tell the lead the class and do not restart', () => {
    for (const kind of ['permission', 'trust', 'login'] as const) {
      const told = watchdogPass(watchdogState(), [crew({
        screenKind: kind,
        hostStatus: 'working',
        plain: 'allow rm -rf /tmp/job',
      })], 0);
      expect(told).toEqual([{ kind: 'lead', text: `crew: the screen is ${kind}` }]);
      expect(told[0]).toEqual({ kind: 'lead', text: `crew: the screen is ${kind}` });
      expect(JSON.stringify(told)).not.toContain('rm -rf');
    }
  });

  test('a question or an exit question does not restart and does not message', () => {
    for (const kind of ['question', 'exit question']) {
      expect(watchdogPass(watchdogState(), [crew({ screenKind: kind })], WATCHDOG_AFTER_MS)).toEqual([]);
    }
  });

  test('a refused or missing session record does not launch', () => {
    for (const session of [
      { kind: 'none' as const, why: 'the seat state names no agent session' },
      { kind: 'refused' as const, why: 'the records disagree' },
    ]) {
      const state = watchdogState();
      watchdogPass(state, [crew({ session })], 0);
      expect(watchdogPass(state, [crew({ session })], WATCHDOG_AFTER_MS)).toEqual([
        { kind: 'lead', text: `crew: ${session.why}` },
      ]);
    }
  });

  test('a second stall in the window tells the lead, and an idle observation opens a new one', () => {
    const state = watchdogState();
    watchdogPass(state, [crew()], 0);
    expect(watchdogPass(state, [crew()], WATCHDOG_AFTER_MS)[0]?.kind).toBe('restart');
    noteRestartFinished(state, 'crew');
    expect(watchdogPass(state, [crew()], WATCHDOG_AFTER_MS * 2)).toEqual([
      { kind: 'lead', text: 'crew: a second stall in the restart window' },
    ]);
    expect(watchdogPass(state, [crew({ reconciled: 'idle' })], WATCHDOG_AFTER_MS * 2)).toEqual([]);
    const again = crew();
    watchdogPass(state, [again], WATCHDOG_AFTER_MS * 2);
    expect(watchdogPass(state, [again], WATCHDOG_AFTER_MS * 3)).toEqual([
      { kind: 'restart', seat: 'crew', args: restartArgs('crew') },
    ]);
  });

  test('the ready result says whether a handover file was already there', async () => {
    const leads: string[] = [];
    const args: (readonly string[])[] = [];
    let finish: (ready: { kind: 'ready'; handover?: string; handoverAsked?: string }) => void = () => {};
    const state = watchdogState();
    watchdogPass(state, [crew()], 0);
    const pending = runWatchdogSlice(state, {
      seats: [crew()],
      now: WATCHDOG_AFTER_MS,
      restart(_seat, argv) {
        args.push(argv);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      lead(text) {
        leads.push(text);
      },
    });
    await pending;
    expect(args).toEqual([restartArgs('crew')]);
    expect(leads).toEqual([]);
    finish({ kind: 'ready', handover: '/recorded/handover.md' });
    await Promise.resolve();
    expect(leads).toEqual([
      restartLandedText('crew', WATCHDOG_AFTER_MS, { kind: 'ready', handover: '/recorded/handover.md' }),
    ]);
    expect(leads[0]).toContain('a handover file was already there');
    expect(leads[0]).not.toContain('handover.md');
    expect(leads[0]).toContain('the recorded conversation was resumed');
  });

  test('a checkpoint on record with no file says the checkpoint may be stale', () => {
    const text = restartLandedText('crew', WATCHDOG_AFTER_MS, { kind: 'ready', handoverAsked: '/recorded/missing.md' });
    expect(text).toContain('the checkpoint may be stale');
    expect(text).not.toContain('missing.md');
    const neither = restartLandedText('crew', WATCHDOG_AFTER_MS, { kind: 'ready' });
    expect(neither).toContain('no handover file was there');
  });

  test('the ready document is the restart command\'s json', () => {
    const doc = readRestartReady(JSON.stringify({
      schema: { name: 'team.restart', version: 1 },
      status: 'ready',
      handoverAsked: '/recorded/missing.md',
    }));
    expect(doc).toEqual({ kind: 'ready', handoverAsked: '/recorded/missing.md' });
    expect(readRestartReady('not json')).toBeNull();
  });

  test('an unreadable pane or a process list the host cannot give is not proof', () => {
    const state = watchdogState();
    watchdogPass(state, [crew()], 0);
    expect(watchdogPass(state, [crew({ plain: null, screenKind: null })], WATCHDOG_AFTER_MS)).toEqual([]);
    const listed = watchdogState();
    watchdogPass(listed, [crew()], 0);
    expect(watchdogPass(listed, [crew({ processes: null })], WATCHDOG_AFTER_MS)).toEqual([]);
  });
});
