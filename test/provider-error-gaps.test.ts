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
