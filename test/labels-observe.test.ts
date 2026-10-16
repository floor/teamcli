import { describe, expect, test } from 'bun:test';
import { observeLabel } from '../src/labels/observe.ts';
import { labelSweep } from '../src/watch/label-tick.ts';
import { newMemory } from '../src/watch/pass.ts';
import { liveDisplayAgent } from '../src/watch/seat-label.ts';

const opus = { cli: 'claude-code', model: 'Claude Opus', version: '5.5', display: 'Opus 5.5' };

describe('the observed half of the label, Claude Code first', () => {
  test('the status line the CLI renders names the running pair', () => {
    expect(observeLabel(opus, 'Opus 5.5\n').line).toBe('Opus 5.5 default');
  });

  test('another pair than the file\'s is the observed one, and the file is not rewritten', () => {
    expect(observeLabel(opus, 'Sonnet 4.5\n').line).toBe('Claude Sonnet 4.5 default');
  });

  test('/effort shows as the CLI prints it', () => {
    expect(observeLabel(opus, 'Opus 5.5 with high effort\n').line).toBe('Opus 5.5 high');
  });

  test('the word once seen stays when the screen turns silent, and a later word replaces it', () => {
    const seen = observeLabel(opus, 'Opus 5.5 with xhigh effort\n');
    expect(seen.effort).toBe('xhigh');
    // The screen no longer carries the word: the caller hands back the one it saw.
    expect(observeLabel(opus, 'Opus 5.5\n', seen.effort).line).toBe('Opus 5.5 xhigh');
    expect(observeLabel(opus, 'Opus 5.5 with low effort\n', seen.effort).line).toBe('Opus 5.5 low');
  });

  test('the file\'s effort stands while the pane shows no word', () => {
    expect(observeLabel({ ...opus, effort: 'medium' }, 'Opus 5.5\n').line).toBe('Opus 5.5 medium');
  });

  test('a screen this version cannot read keeps the file\'s display, never the CLI\'s name', () => {
    expect(observeLabel(opus, 'hello there\n').line).toBe('Opus 5.5 default');
    expect(observeLabel(opus, undefined).line).toBe('Opus 5.5 default');
    expect(observeLabel({ ...opus, effort: 'low' }, '').line).toBe('Opus 5.5 low');
  });

  test('a model scrolled out of the last rows is not observed', () => {
    const scrolled = `Opus 5.5\n${'tick\n'.repeat(6)}`;
    expect(observeLabel(opus, scrolled).line).toBe('Opus 5.5 default');
  });

  test('the watch\'s liveDisplayAgent is this observation', () => {
    const screens = ['Opus 5.5\n', 'Sonnet 4.5\n', 'Opus 5.5 with high effort\n', undefined];
    for (const screen of screens) expect(liveDisplayAgent(opus, screen)).toEqual(observeLabel(opus, screen));
  });
});

describe('the sweep between passes', () => {
  const seat = { name: 'claude-coordinator-acme', ...opus };
  const agents = [{ name: 'claude-coordinator-acme', pane: 'w1:p1' }];

  function recorder() {
    const pushed: string[] = [];
    return { pushed, report: (pane: string, text: string) => { pushed.push(`${pane} ${text}`); return true; } };
  }

  test('a changed line is reported once, and the next tick with the same screen is silent', () => {
    const memory = newMemory();
    const { pushed, report } = recorder();
    const read = () => 'Sonnet 4.5\n';
    const first = labelSweep({ seats: [seat], agents, memory, read, report });
    expect(first.reported).toEqual([{ name: 'claude-coordinator-acme', pane: 'w1:p1', line: 'Claude Sonnet 4.5 default' }]);
    expect(first.failed).toEqual([]);
    expect(pushed).toEqual(['w1:p1 Claude Sonnet 4.5 default']);
    expect(memory.seatLabels['claude-coordinator-acme']?.line).toBe('Claude Sonnet 4.5 default');
    // The pass has since recorded the line, so the same screen reports nothing again.
    expect(labelSweep({ seats: [seat], agents, memory, read, report })).toEqual({ reported: [], failed: [] });
    expect(pushed.length).toBe(1);
  });

  test('the word once seen sticks through a silent screen, and a new one replaces it', () => {
    const memory = newMemory();
    const { pushed, report } = recorder();
    let screen = 'Opus 5.5 with xhigh effort\n';
    const sweep = () => labelSweep({ seats: [seat], agents, memory, read: () => screen, report });
    expect(sweep().reported[0]?.line).toBe('Opus 5.5 xhigh');
    screen = 'Opus 5.5\n';
    // The screen shows no word: the remembered one keeps the line, so nothing is reported.
    expect(sweep()).toEqual({ reported: [], failed: [] });
    screen = 'Opus 5.5 with low effort\n';
    expect(sweep().reported[0]?.line).toBe('Opus 5.5 low');
    expect(pushed).toEqual(['w1:p1 Opus 5.5 xhigh', 'w1:p1 Opus 5.5 low']);
  });

  test('a pane this tick cannot read falls back to the file, as the pass does', () => {
    const memory = newMemory();
    const { pushed, report } = recorder();
    let screen: string | null = 'Opus 5.5\n';
    const sweep = () => labelSweep({ seats: [seat], agents, memory, read: () => screen, report });
    expect(sweep().reported[0]?.line).toBe('Opus 5.5 default');
    // Herdr gave nothing this tick: the file's own line already stands, so nothing is reported.
    screen = null;
    expect(sweep()).toEqual({ reported: [], failed: [] });
    screen = 'Sonnet 4.5\n';
    expect(sweep().reported[0]?.line).toBe('Claude Sonnet 4.5 default');
    expect(pushed).toEqual(['w1:p1 Opus 5.5 default', 'w1:p1 Claude Sonnet 4.5 default']);
  });

  test('a refused report is failed, and the older line stands for the next tick to try again', () => {
    const memory = newMemory();
    const { pushed } = recorder();
    let allow = false;
    const refusing = (pane: string, text: string) => { pushed.push(`${pane} ${text}`); return allow; };
    const read = () => 'Sonnet 4.5\n';
    const first = labelSweep({ seats: [seat], agents, memory, read, report: refusing });
    expect(first.reported).toEqual([]);
    expect(first.failed).toEqual([{ name: 'claude-coordinator-acme', pane: 'w1:p1', line: 'Claude Sonnet 4.5 default' }]);
    expect(memory.seatLabels['claude-coordinator-acme']?.line).toBeUndefined();
    allow = true;
    expect(labelSweep({ seats: [seat], agents, memory, read, report: refusing }).reported[0]?.line).toBe('Claude Sonnet 4.5 default');
    expect(pushed).toEqual(['w1:p1 Claude Sonnet 4.5 default', 'w1:p1 Claude Sonnet 4.5 default']);
  });

  test('the sweep works on the seats the last whole read named, and no others', () => {
    const memory = newMemory();
    const { pushed, report } = recorder();
    const swept = labelSweep({
      seats: [seat],
      agents: [{ pane: 'w2:p1' }, { name: null, pane: 'w4:p1' }, { name: 'ghost-acme', pane: 'w3:p1' }, { name: 'claude-coordinator-acme', pane: 'w1:p1' }],
      memory,
      read: () => 'Sonnet 4.5\n',
      report,
    });
    expect(swept.reported).toEqual([{ name: 'claude-coordinator-acme', pane: 'w1:p1', line: 'Claude Sonnet 4.5 default' }]);
    expect(pushed).toEqual(['w1:p1 Claude Sonnet 4.5 default']);
  });
});
