import { describe, expect, test } from 'bun:test';
import { observeLabel } from '../src/labels/observe.ts';
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
