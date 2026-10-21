// Each place that types into a seat refuses a provider error and a rate limit the way it refuses
// a question. One test per guard.
import { describe, expect, test } from 'bun:test';
import { stateOf, typeExit, type ExitIo } from '../src/commands/down.ts';
import { deliverRules, type Delivery, type Refusal } from '../src/launch/deliver.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { downPlan } from '../src/launch/plan.ts';
import { CLASSIFICATIONS, classificationOf, progressWriter, recordText } from '../src/launch/progress.ts';
import { guardReading } from '../src/profiles/overrides.ts';
import { readScreen } from '../src/watch/screen.ts';
import { claudeBox } from './helpers.ts';

const lost = `API Error: Connection lost mid-response. The response above may be incomplete.\n${claudeBox('')}`;
const limit = `API Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at 11:00\n${claudeBox('')}`;
const screens = [lost, limit];

describe('nothing is typed into a provider error or a rate limit', () => {
  test('delivery refuses at the first read, before any wait', async () => {
    for (const screen of screens) {
      let naps = 0;
      const calls: string[] = [];
      const refusals: Refusal[] = [];
      let clock = 0;
      const io: Delivery = {
        screen: () => screen,
        status: () => 'done',
        report: (why) => { refusals.push(why); },
        file: () => true,
        type(text) { calls.push(text); return true; },
        enter() { calls.push('Enter'); return true; },
        foreground: () => ['claude'],
        now: () => clock,
        sleep: async (ms) => { naps += 1; clock += ms; },
      };
      expect(await deliverRules('claude-code', 'Rules.', 30, io)).toBe(false);
      expect(calls).toEqual([]);
      expect(naps).toBe(0);
      expect(refusals.at(-1)?.kind).toBe(readScreen('claude-code', screen).kind);
    }
  });

  test('a screen that becomes a provider error or a rate limit after Enter gets no further key', async () => {
    for (const next of screens) {
      let raw = claudeBox('');
      const calls: string[] = [];
      const refusals: Refusal[] = [];
      let clock = 0;
      const io: Delivery = {
        screen: () => raw,
        status: () => 'idle',
        report: (why) => { refusals.push(why); },
        file: () => true,
        type(text) { calls.push(text); raw = claudeBox(text); return true; },
        enter() { calls.push('Enter'); raw = next; return true; },
        foreground: () => ['claude'],
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
      };
      expect(await deliverRules('claude-code', 'Rules.', 5, io)).toBe(false);
      expect(calls).toEqual(['Rules.', 'Enter']);
      expect(refusals.at(-1)?.stop).toBe('ack');
      expect(refusals.at(-1)?.kind).toBe(readScreen('claude-code', next).kind);
    }
  });

  test('down reads the seat as blocked and plans no typing', () => {
    for (const screen of screens) {
      const reading = readScreen('claude-code', screen);
      expect(stateOf('done', reading)).toBe('blocked');
      expect(stateOf('idle', reading)).toBe('blocked');
      const plan = downPlan({
        session: 'test-session',
        seats: [{ name: 'deepseek-acme', cli: 'claude-code', pane: 'w1:p1', workspace: 'w1', state: stateOf('done', reading) }],
        keep: [],
        extra: 0,
        watchPid: null,
      });
      expect(plan.some((step) => step.do?.do === 'type')).toBe(false);
      expect(plan.some((step) => step.kind === 'skip' && step.text.includes('deepseek-acme'))).toBe(true);
    }
  });

  test('an exit whose screen becomes a provider error or a rate limit is not confirmed', async () => {
    for (const next of screens) {
      let raw = claudeBox('');
      const keys: string[] = [];
      const io: ExitIo = {
        typeText() { keys.push('text'); raw = next; return true; },
        sendKey(key) { keys.push(key); return true; },
        pressEnter() { keys.push('Enter'); return true; },
        screen: () => raw,
        status: () => 'done',
        foreground: () => ['claude'],
        now: () => 0,
        sleep: async () => {},
      };
      const result = await typeExit(io, 'claude-code', '/exit');
      expect(keys).toEqual(['text']);
      expect(result).toEqual({ left: `its exit was not confirmed; the screen was reading ${readScreen('claude-code', next).kind} before the Enter; left running` });
    }
  });

  test('a launch that finds one stops and types nothing', async () => {
    for (const kind of ['provider error', 'rate limit'] as const) {
      const typed: string[] = [];
      const out: string[] = [];
      const records = progressWriter({ stdout: (text) => out.push(text), stderr: () => {}, isTTY: false });
      const host: Host = {
        startServer: () => true,
        sessionUp: () => true,
        createWorkspace: () => ({ pane: 'alpha-pane', workspace: 'alpha-ws' }),
        paneRun: () => true,
        typeLine: () => { typed.push('line'); return true; },
        deliverRules: async () => { typed.push('rules'); return true; },
        renameAgent: () => true,
        closeWorkspace: () => true,
        stopSession: () => true,
        kill: () => true,
        agentPanes: () => ['alpha-pane'],
        classify: () => kind,
        sleep: async () => { typed.push('sleep'); },
        now: () => 0,
        allow: () => null,
        record: () => {},
        running: () => {},
        drop: () => {},
        say: () => {},
        log: () => {},
        progress: (seat, state) => records.progress(seat, state),
        final: (seat, record) => records.final(seat, record),
        detail: (line) => records.detail(line),
        cliVersion: () => null,
      };
      await executePlan([
        { kind: 'run', argv: [], do: { do: 'create', seat: 'alpha', label: 'alpha', cwd: '.', repairLine: 'repair' } },
        { kind: 'run', argv: [], do: { do: 'launch', seat: 'alpha', label: 'alpha', command: 'claude' } },
        {
          kind: 'wait',
          text: 'until alpha shows its idle prompt',
          do: { do: 'idle', seat: 'alpha', label: 'alpha', cli: 'claude-code', seconds: 5, command: 'claude', pane: 'alpha-pane', repairLine: 'repair' },
        },
      ], 'acme', host);
      expect(typed).toEqual([]);
      expect(out.join('')).toContain(`alpha: left out: ${kind}`);
    }
  });

  test('the record names the kind, as it names a question', () => {
    for (const kind of ['provider error', 'rate limit'] as const) {
      expect(classificationOf(kind)).toBe(kind);
      expect(CLASSIFICATIONS).toContain(kind);
      expect(recordText('alpha', { kind: 'waiting for owner', classification: kind })).toBe(`alpha: waiting for owner (${kind})`);
    }
    expect(classificationOf('question')).toBe('question');
  });

  test('an override cannot read a shipped provider error or rate limit as idle', () => {
    expect(guardReading({ kind: 'provider error' }, { kind: 'idle' }).kind).toBe('provider error');
    expect(guardReading({ kind: 'rate limit', reset: { kind: 'at', value: '11:00' } }, { kind: 'idle' })).toEqual({ kind: 'rate limit', reset: { kind: 'at', value: '11:00' } });
    expect(guardReading({ kind: 'rate limit', reset: { kind: 'at', value: '11:00' } }, { kind: 'question' }).kind).toBe('rate limit');
    expect(guardReading({ kind: 'question' }, { kind: 'idle' }).kind).toBe('question');
  });
});
