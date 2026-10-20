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
    expect(quotaFor('cursor')).toEqual([]);
    expect(quotaFor('antigravity')).toEqual([]);
    expect(quotaFor('gemini')).toEqual([]);
  });

  test('Claude subscription status labels carry used percentages and resets', () => {
    // Constructed configurable status line; this is not a capture of a default CLI setting.
    const line = '  L: 13% (44m) · W: 20% (114h4m)';
    const pane = '────────────\n❯ \n────────────\n' + line + '\n';
    expect(figuresOf(quotaFor('claude-code'), statusRow('claude-code', pane))).toEqual([
      { account: 'anthropic', window: 'session', left: 87, used: 13, resets: '44m' },
      { account: 'anthropic', window: 'weekly', left: 80, used: 20, resets: '114h4m' },
    ]);
    expect(figuresOf(quotaFor('claude-code'), statusRow('claude-code', pane.replace(line, '  Context 80% left')))).toEqual([]);
    expect(figuresOf(quotaFor('claude-code'), statusRow('claude-code', line + '\n────────────\n❯ \n────────────\n'))).toEqual([]);
  });

  test('grok reads the weekly figure off its footer row', () => {
    // From a run (grok 1.0.60, a chat session): the row under the composer's closing rule read
    // `Weekly limit left: 0% · ` at the pane's right edge. The fixture pane is the shipped
    // 1.0.50 idle capture with that one row added under the rule, as the session paints it.
    const patterns = quotaFor('grok');
    expect(patterns).toHaveLength(1);
    const idle = readFileSync(new URL('./fixtures/grok/1.0.50/idle.txt', import.meta.url), 'utf8');
    const session = `${idle}\n  Weekly limit left: 0% ·   Grok Build  1.0.60 [stable]\n`;
    expect(statusRow('grok', session)).toBe('  Weekly limit left: 0% ·   Grok Build  1.0.60 [stable]');
    expect(figuresOf(patterns, statusRow('grok', session))).toEqual([
      { account: 'xai', window: 'weekly', left: 0, used: 100, resets: null },
    ]);
    // The welcome screen the 1.0.50 capture holds, with no footer row, reads nothing.
    expect(statusRow('grok', idle)).toBeNull();
    expect(figuresOf(patterns, statusRow('grok', idle))).toEqual([]);
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

  test('the captured chrome row under the status line keeps the figure readable', () => {
    // 0.161.0's plain launch draws `← for agents · ? for shortcuts` under the status row
    // (idle-hint.txt, working.txt); the row above it is still the composer's.
    const screen = `• Working (2m 10s • esc to interrupt)\n\n${statusLine}\n  ← for agents · ? for shortcuts\n`;
    expect(statusRow('codex', screen)).toBe(statusLine);
    expect(figuresOf(patterns, statusRow('codex', screen))).toEqual([
      { account: 'openai', window: 'weekly', left: 39, used: 61, resets: null },
    ]);
  });

  test('the warning form of the chrome row keeps the figure readable', () => {
    // The same hint carries the account's warning: `? for shortcuts … ⚠ N warning · f2 to view`,
    // the `⚠ N warning · f2 to view` tail the 0.157.0 captures draw on the status row. Any
    // count reads, one warning or several.
    for (const count of [1, 3]) {
      const screen = `• Working (2m 10s • esc to interrupt)\n\n${statusLine}\n  ? for shortcuts … ⚠ ${count} warnings · f2 to view\n`;
      expect(statusRow('codex', screen)).toBe(statusLine);
      expect(figuresOf(patterns, statusRow('codex', screen))).toEqual([
        { account: 'openai', window: 'weekly', left: 39, used: 61, resets: null },
      ]);
    }
  });

  test('the chrome row keeps its prefix when a warning rides along', () => {
    // The plain row draws `← for agents · ? for shortcuts`; the warning form may keep the prefix
    // beside the warning, and a pattern that demanded the bare form would leave that frame
    // unknown — and the seat out of `up`.
    const screen = `• Working (2m 10s • esc to interrupt)\n\n${statusLine}\n  ← for agents · ? for shortcuts … ⚠ 1 warning · f2 to view\n`;
    expect(statusRow('codex', screen)).toBe(statusLine);
    expect(figuresOf(patterns, statusRow('codex', screen))).toEqual([
      { account: 'openai', window: 'weekly', left: 39, used: 61, resets: null },
    ]);
  });

  test('the wide no-chrome row carries its figure, warning tail and all', () => {
    // Floor supplied this sanitized 8-line frame from a vlist build on a wide pane: the
    // account's warning is right-aligned on the status row itself and no chrome row sits under
    // it. Read before the fix: null — the row's place expects an ellipsis row below, and the
    // alignment gap before the warning is no ellipsis.
    const captured = readFileSync(new URL('./fixtures/codex/0.161.0/idle-wide-warning.txt', import.meta.url), 'utf8');
    const row = captured.trimEnd().split('\n').at(-1) ?? '';
    expect(row.endsWith('⚠ 1 warning · f2 to view')).toBe(true);
    expect(statusRow('codex', captured)).toBe(row);
    expect(figuresOf(patterns, statusRow('codex', captured))).toEqual([
      { account: 'openai', window: 'weekly', left: 94, used: 6, resets: null },
    ]);
    // The row as the report drew it, with ASCII dots in place of the alignment gap: the gap is
    // the pane's, the tail's words are the row's own.
    const dotted = captured.replace(/(% left) +⚠/, '$1 ... ⚠');
    expect(dotted).not.toBe(captured);
    expect(statusRow('codex', dotted)).toBe(dotted.trimEnd().split('\n').at(-1) ?? '');
    expect(figuresOf(patterns, statusRow('codex', dotted))).toEqual([
      { account: 'openai', window: 'weekly', left: 94, used: 6, resets: null },
    ]);
  });

  test('a warning tail does not open the row to text under it', () => {
    // The tail joins the row only as the pane's last line, or with the captured chrome under
    // it. Arbitrary text under the row is still not chrome, so the row is still not read.
    const base = '• Working (2m 10s • esc to interrupt)\n\n  GPT-6.1-Sol ultra · Context 100% left · weekly 94% left';
    const tail = '      ⚠ 1 warning · f2 to view';
    const printed = `${base}${tail}\n  (the seat keeps printing)\n`;
    expect(statusRow('codex', printed)).toBeNull();
    expect(figuresOf(patterns, statusRow('codex', printed))).toEqual([]);
    const chrome = `${base}${tail}\n  ← for agents · ? for shortcuts\n`;
    expect(statusRow('codex', chrome)).toBe(`${base.split('\n').at(-1) ?? ''}${tail}`);
    expect(figuresOf(patterns, statusRow('codex', chrome))).toEqual([
      { account: 'openai', window: 'weekly', left: 94, used: 6, resets: null },
    ]);
  });

  test('a line the seat prints under the status row is not chrome, so nothing reads', () => {
    // The one trailing row must be the captured chrome: status-then-one may not accept arbitrary
    // text under a status-shaped line, or a seat could print a status row and a line below it and
    // feed the watch its own figure.
    const screen = `• Working (2m 10s • esc to interrupt)\n\n${statusLine}\n  (the seat keeps printing)\n`;
    expect(statusRow('codex', screen)).toBeNull();
    expect(figuresOf(patterns, statusRow('codex', screen))).toEqual([]);
  });

  test('a grok quota line typed into the box, or printed above the rule, is not the row', () => {
    const patterns = quotaFor('grok');
    const idle = readFileSync(new URL('./fixtures/grok/1.0.50/idle.txt', import.meta.url), 'utf8');
    const session = `${idle}\n  Weekly limit left: 0% ·\n`;
    // Typed into the box: the row under the rule is still the only row the grammar reads, and
    // the box's own text never carries the figure.
    const typed = session.replace('│ ❯', '│ ❯ Weekly limit left: 0%');
    expect(statusRow('grok', typed)).toBe('  Weekly limit left: 0% ·');
    // A quota-shaped line in the transcript, above the box's opening rule, is not the row.
    const printed = `  Weekly limit left: 90%\n${session}`;
    expect(figuresOf(patterns, statusRow('grok', printed))).toEqual([
      { account: 'xai', window: 'weekly', left: 0, used: 100, resets: null },
    ]);
    // A pane with no rule-shaped row at all is no composer: no row, no figure.
    expect(statusRow('grok', '  Weekly limit left: 0%\n')).toBeNull();
  });

  test('the real full line still reads 39', () => {
    const real = `• Working (2m 10s • esc to interrupt)\n\n  GPT-5.6-Terra medium · Context 98% left · weekly 39% left\n`;
    expect(figuresOf(patterns, statusRow('codex', real))).toEqual([
      { account: 'openai', window: 'weekly', left: 39, used: 61, resets: null },
    ]);
  });
});
