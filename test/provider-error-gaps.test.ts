// The provider-error and rate-limit sentences, placed above idle boxes the repository
// already has. The sentences are the ones a Claude Code seat printed. No live pane.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { stripSgr } from '../src/ansi.ts';
import { readScreen } from '../src/watch/screen.ts';
import { claudeBox } from './helpers.ts';

const LOST = 'API Error: Connection lost mid-response. The response above may be incomplete.';
const LIMIT = 'API Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at 11:00';

function fixture(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** The sentence has to sit in the pane's last 20 lines, or the read never sees it. */
function inWindow(screen: string, sentence: string): boolean {
  return screen
    .split('\n')
    .map((line) => line.trimEnd())
    .slice(-20)
    .some((line) => stripSgr(line).includes(sentence));
}

function expectIdle(cli: string, screen: string, sentence: string): void {
  expect(inWindow(screen, sentence)).toBe(true);
  expect(readScreen(cli, screen)).toEqual({ kind: 'idle' });
}

describe('provider errors on other CLIs', () => {
  test('a codex idle box keeps the Claude sentences above it and stays idle', () => {
    // The capture is longer than the window. The blank the capture leaves above the
    // prompt is still inside the window, and the prompt row itself stays put.
    const idle = fixture('./fixtures/codex/0.161.0/idle.txt');
    const lines = idle.split('\n');
    const prompt = lines.findIndex((line) => line.startsWith('› '));
    if (prompt < 2 || lines[prompt - 2] !== '') throw new Error('the codex idle box has no blank above its prompt');
    for (const sentence of [LOST, LIMIT]) {
      const next = lines.slice();
      next[prompt - 2] = sentence;
      expectIdle('codex', next.join('\n'), sentence);
    }
  });

  test('a cursor idle box keeps the Claude sentences above it and stays idle', () => {
    const idle = fixture('./fixtures/cursor/2026.10.01/idle.txt');
    for (const sentence of [LOST, LIMIT]) expectIdle('cursor', `${sentence}\n${idle}`, sentence);
  });

  test('a grok idle box keeps the Claude sentences above it and stays idle', () => {
    const idle = fixture('./fixtures/grok/1.0.50/idle-ansi.txt');
    const lines = idle.split('\n');
    const box = lines.findIndex((line) => stripSgr(line).includes('╭'));
    if (box < 0) throw new Error('the grok idle box was not found');
    for (const sentence of [LOST, LIMIT]) {
      const next = [...lines.slice(0, box), sentence, ...lines.slice(box)].join('\n');
      expectIdle('grok', next, sentence);
    }
  });

  test('an antigravity idle box keeps the Claude sentences above it and stays idle', () => {
    const idle = fixture('./fixtures/antigravity/1.2.16/idle.txt');
    for (const sentence of [LOST, LIMIT]) expectIdle('antigravity', `${sentence}\n${idle}`, sentence);
  });
});

describe('a reset time the classifier cannot read', () => {
  // The stage matches "Your limit will reset at" with no trailing space. A 429 line that
  // names no time is a rate limit, and so is one whose time has wrapped onto the next row.
  // The time on that next row is not read, so the reset is null.
  const phrase = 'API Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at';

  test('nothing after the reset phrase is a rate limit with no time, trailing space included', () => {
    expect(readScreen('claude-code', `${phrase}\n${claudeBox('')}`)).toEqual({ kind: 'rate limit', reset: null });
    expect(readScreen('claude-code', `${phrase} \n${claudeBox('')}`)).toEqual({ kind: 'rate limit', reset: null });
  });

  test('a reset time wrapped onto the next line is a rate limit and the time is not read', () => {
    const cut = `${phrase}\n11:00\n${claudeBox('')}`;
    expect(inWindow(cut, '11:00')).toBe(true);
    expect(readScreen('claude-code', cut)).toEqual({ kind: 'rate limit', reset: null });
  });

  test('a transcript that only mentions the reset phrase stays idle', () => {
    const screen = `The note says Your limit will reset at dawn, and the prompt is back.\n${claudeBox('')}`;
    expect(inWindow(screen, 'Your limit will reset at')).toBe(true);
    expect(screen.includes('API Error: Request rejected (429)')).toBe(false);
    expect(screen.includes('Usage limit reached')).toBe(false);
    expect(readScreen('claude-code', screen)).toEqual({ kind: 'idle' });
  });
});

describe('both sentences in one window', () => {
  // Provider error is the earlier stage, so it wins whichever sentence is above the
  // other, and the reset time on the 429 line is not reported.
  test('connection lost above the 429 line is a provider error', () => {
    expect(readScreen('claude-code', `${LOST}\n${LIMIT}\n${claudeBox('')}`)).toEqual({ kind: 'provider error' });
  });

  test('connection lost below the 429 line is still a provider error', () => {
    expect(readScreen('claude-code', `${LIMIT}\n${LOST}\n${claudeBox('')}`)).toEqual({ kind: 'provider error' });
  });
});
