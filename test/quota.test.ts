import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { quotaFor, quotaPatterns } from '../src/profiles/profile.ts';
import { figuresOf } from '../src/profiles/quota.ts';
import { readScreen, statusRow } from '../src/watch/screen.ts';
import { YamlError } from '../src/yaml.ts';

const statusLine = `  GPT-5.6-Terra medium · Context 98% left · weekly 39% left`;

describe('quota patterns', () => {
  test('codex reads a full weekly line off its status line, and a cut capture is not a figure', () => {
    const patterns = quotaFor('codex');
    expect(patterns).toHaveLength(1);
    expect(figuresOf(patterns, statusRow('codex', statusLine))).toEqual([
      { account: 'openai', window: 'weekly', left: 39, used: 61, resets: null },
    ]);
    const cut = readFileSync(new URL('./fixtures/codex/0.157.0/exit-typed.txt', import.meta.url), 'utf8');
    expect(cut).toContain('weekly 1…');
    expect(figuresOf(patterns, statusRow('codex', cut))).toEqual([]);
    expect(readScreen('codex', cut).kind).toBe('unsent');
  });

  test('the other shipped CLIs have no quota pattern', () => {
    expect(quotaFor('claude-code')).toEqual([]);
    expect(quotaFor('cursor')).toEqual([]);
    expect(quotaFor('antigravity')).toEqual([]);
    expect(quotaFor('gemini')).toEqual([]);
  });

  test('used and a reset duration, and a figure over 100 is absent', () => {
    const patterns = quotaPatterns(`
- account: anthropic
  match: '\\bL: ([0-9]+)% \\(([0-9hm]+)\\)'
  used: '{1}%'
  resets: '{2}'
  window: session
`);
    expect(figuresOf(patterns, 'L: 13% (44m) · W: 20%')).toEqual([
      { account: 'anthropic', window: 'session', left: 87, used: 13, resets: '44m' },
    ]);
    expect(figuresOf(patterns, 'L: 101% (1m)')).toEqual([]);
  });

  test('a pattern needs exactly one of left and used', () => {
    const both = `
- account: openai
  match: '\\bweekly ([0-9]+)% left\\b'
  left: '{1}%'
  used: '{1}%'
  window: weekly
`;
    const neither = `
- account: openai
  match: '\\bweekly ([0-9]+)% left\\b'
  window: weekly
`;
    expect(() => quotaPatterns(both)).toThrow(YamlError);
    expect(() => quotaPatterns(neither)).toThrow(YamlError);
  });
});

// A seat cannot write its own quota by printing or typing a line that only looks like one: that
// line is not the composer's status row. Whoever owns the pane can still draw a whole composer,
// which is why a fresh check reading stays first and a wrong figure can only refuse or report.
describe('quota patterns read only the status line', () => {
  const patterns = quotaFor('codex');
  const captured = readFileSync(new URL('./fixtures/codex/0.157.0/exit-typed.txt', import.meta.url), 'utf8');

  test('a quota line printed into the transcript is not a figure', () => {
    // The seat prints it just above the box, inside the lines the old read looked at.
    const spoofed = captured.replace('\n› /exit\n\n', '\n• weekly 90% left\n\n› /exit\n\n');
    expect(spoofed).toContain('• weekly 90% left');
    expect(figuresOf(patterns, statusRow('codex', spoofed))).toEqual([]);
  });

  test('a quota line typed into the input box is not a figure', () => {
    const spoofed = captured.replace('\n› /exit\n', '\n› weekly 90% left\n› /exit\n');
    expect(spoofed).toContain('› weekly 90% left');
    expect(figuresOf(patterns, statusRow('codex', spoofed))).toEqual([]);
  });

  test('the status line itself still reads', () => {
    const full = captured.replace('weekly 1…', 'weekly 39% left');
    expect(figuresOf(patterns, statusRow('codex', full))).toEqual([
      { account: 'openai', window: 'weekly', left: 39, used: 61, resets: null },
    ]);
  });

  test('a composer mode with no status line reads no figures at all', () => {
    expect(statusRow('claude-code', statusLine)).toBeNull();
    expect(statusRow('no-such-cli', statusLine)).toBeNull();
    expect(figuresOf(patterns, statusRow('claude-code', statusLine))).toEqual([]);
  });
});

// Round 2: the figure must come off the composer's own row, not off the last line that happens to
// match the pattern anywhere in the window. Two spaces of indent is what Codex gives an agent
// message's continuation lines, so a seat can print a line that matches `status_line` exactly.
describe('quota reads only the composer\'s own status row', () => {
  const patterns = quotaFor('codex');
  const FAKE = '  GPT-5.6-Terra medium · Context 98% left · weekly 90% left';

  function withFake(name: string): string {
    const lines = readFileSync(new URL(`./fixtures/codex/0.157.0/${name}.txt`, import.meta.url), 'utf8').split('\n');
    lines.splice(lines.length - 8, 0, FAKE);
    return lines.join('\n');
  }

  test.each([
    ['permission', 'permission'],
    ['trust', 'trust'],
    ['startup', 'vendor notice'],
    ['exit', 'unknown'],
  ] as const)('a status-shaped fake in the %s capture reads nothing', (name, kind) => {
    const spoofed = withFake(name);
    // The fake does not change the shape: these are a dialog, a vendor notice and a shell, none
    // of which is a composer screen.
    expect(readScreen('codex', spoofed).kind).toBe(kind);
    expect(figuresOf(patterns, statusRow('codex', spoofed))).toEqual([]);
  });

  test('a fake below the real status line is not the composer\'s row either', () => {
    // The real full line, the fake printed below it, and the pane's text below that: the old
    // read took the last matching line anywhere in the window, so it read the fake. Nothing
    // below the fake is the composer's row, so nothing reads.
    const spoofed = `• Working (2m 10s • esc to interrupt)\n\n  GPT-5.6-Terra medium · Context 98% left · weekly 39% left\n${FAKE}\n  (the seat keeps printing)\n`;
    expect(statusRow('codex', spoofed)).toBeNull();
    expect(figuresOf(patterns, statusRow('codex', spoofed))).toEqual([]);
  });

  test('the real full line still reads 39', () => {
    const real = `• Working (2m 10s • esc to interrupt)\n\n  GPT-5.6-Terra medium · Context 98% left · weekly 39% left\n`;
    expect(figuresOf(patterns, statusRow('codex', real))).toEqual([
      { account: 'openai', window: 'weekly', left: 39, used: 61, resets: null },
    ]);
  });
});
