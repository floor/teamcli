import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Screen } from '../src/watch/screen.ts';
import { classify, classifyComposer, readScreen, screenData } from '../src/watch/screen.ts';
import { DialectError, compilePattern } from '../src/watch/dialect.ts';
import { classifyLines, statusRowOf } from '../src/watch/screen-core.ts';
import { loadScreen } from '../src/watch/screen-file.ts';
import { YamlError } from '../src/yaml.ts';

// The classifier claude-code had on main, copied here so the table proves the new
// path agrees with it. The production file no longer has this code.
function mainClaude(lines: string[]): Screen['kind'] {
  const question = (line: string) =>
    /Do you trust (?:this|the) folder\?/i.test(line) || /one you trust\?/i.test(line);
  const choice = (line: string) => /^\s*[❯›>]?\s*1\.\s+Yes\b/.test(line);
  if (lines.some(question) && lines.some(choice)) return 'trust';
  const text = lines.join('\n');
  if (/Do you want to (proceed|make this edit|create|allow)|\bEsc to cancel\b.*\bTab to amend\b|^\s*❯?\s*[0-9]\. (Yes|No)\b/m.test(text)) {
    return 'permission';
  }
  if (/Enter to select|↑\/↓ to navigate|Enter to confirm|Esc to cancel/.test(text)) return 'question';
  if (/\besc to interrupt\b/.test(text) || /^[^\S\n]*[✢✳✶✻✼✽][^\n]*…\s*\(\s*\d/m.test(text)) return 'working';
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[❯›>]/.test(lines[i] as string)) { at = i; break; }
  }
  if (at < 0) return 'unknown';
  const typed = (lines[at] as string).replace(/^\s*[❯›>]/, '').trim();
  for (let i = at + 1; i < lines.length && !/^\s*[─━]{8,}/.test(lines[i] as string); i++) {
    if ((lines[i] as string).trim()) return 'unsent';
  }
  return typed === '' || typed.startsWith('Try "') ? 'idle' : 'unsent';
}

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const fixtures: [string, string][] = [
  ['idle', `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`],
  ['suggestion', `${RULE}\n❯ Try "fix the failing test"\n${RULE}\n${STATUS}\n`],
  ['unsent', `${RULE}\n❯ Brief: take the next task from the queue\n${RULE}\n${STATUS}\n`],
  ['permission', `Bash command\n\n  chmod +x run.sh\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\nEsc to cancel · Tab to amend\n`],
  ['trust', `Do you trust this folder?\n❯ 1. Yes, proceed\n  2. No, exit\n\nEnter to confirm · Esc to cancel`],
  ['live trust', ['Accessing workspace:', 'Quick safety check: Is this a project you created or one you trust?', 'Claude Code will be able to read, edit, and execute files here.', '❯ 1. Yes, I trust this folder', '  2. No, exit'].join('\n')],
  ['quoted trust', `The note says to trust this folder before you start.\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`],
  ['quoted permission', `The last answer asks: Do you want to proceed?\n1. Yes, if the tests pass\n2. No\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`],
  ['question', `Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`],
  ['second line', `${RULE}\n❯ \n  and a second line\n${RULE}\n${STATUS}\n`],
  ['empty box', `${RULE}\n❯ \n\n${RULE}\n${STATUS}\n`],
  ['no prompt', 'Welcome back!\n\nUpdate available: run claude update\n'],
  ['spinner', `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`],
  ['interrupt', `${RULE}\n❯ \n${RULE}\n  main · Opus 5.5 · esc to interrupt\n`],
  ['finished', `✻ Churned for 51s · done 9:51 PM\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`],
  ['typed list', `${RULE}\n❯ 1. fix the bug\n${RULE}\n${STATUS}\n`],
  ['lowercase choice', `Do you trust this folder?\n❯ 1. yes, proceed\n  2. No\n`],
  ['lowercase question', `do you trust the folder?\n❯ 1. Yes\n`],
];

describe('claude-code through the screen core', () => {
  test('a shell prompt after Claude has exited is unknown', () => {
    const text = readFileSync(new URL('./fixtures/claude-code/shell-prompt.txt', import.meta.url), 'utf8');
    const lines = text.split('\n').map((line) => line.trimEnd()).slice(-20);
    expect(mainClaude(lines)).toBe('idle');
    expect(readScreen('claude-code', text).kind).toBe('unknown');
  });

  test.each(['rule-above.txt', 'leftover-box.txt', 'output-under-rule.txt'])('%s is not a box', (name) => {
    const text = readFileSync(new URL(`./fixtures/claude-code/${name}`, import.meta.url), 'utf8');
    expect(readScreen('claude-code', text).kind).toBe('unknown');
  });

  test.each([
    'shell-git-log.txt',
    'shell-right-prompt.txt',
    'shell-shortcuts.txt',
    'shell-shortcuts-indented.txt',
    'shell-status-only.txt',
    'shell-bypass-only.txt',
  ])('%s reads unknown', (name) => {
    const text = readFileSync(new URL(`./fixtures/claude-code/${name}`, import.meta.url), 'utf8');
    expect(readScreen('claude-code', text).kind).toBe('unknown');
  });

  test('the three constructed shell prompt fixtures still read unknown with a footer pattern added under them', () => {
    for (const name of ['shell-prompt.txt', 'rule-above.txt', 'output-under-rule.txt']) {
      const text = readFileSync(new URL(`./fixtures/claude-code/${name}`, import.meta.url), 'utf8');
      for (const footer of ['? for shortcuts', '  main · Opus 5.5', '  bypass permissions']) {
        const screen = `${text.trimEnd()}\n${footer}\n`;
        expect(readScreen('claude-code', screen).kind).toBe('unknown');
      }
    }
  });

  test('shell output embedding a shortcuts footer or in uppercase reads unknown', () => {
    const prompt = '~/acme % ls\nREADME.md\nsrc\n❯ \n';
    const vim = `${prompt}${RULE}\npress ? for shortcuts in vim\n`;
    expect(readScreen('claude-code', vim).kind).toBe('unknown');

    const upper = `${prompt}${RULE}\n? FOR SHORTCUTS\n`;
    expect(readScreen('claude-code', upper).kind).toBe('unknown');
  });

  test('failure directions: person typing shortcuts, real box followed by nothing, two-row footer', () => {
    const prompt = '~/acme % ls\nREADME.md\nsrc\n❯ \n';
    // A person typing ? for shortcuts on its own line has no leading indentation and reads unknown
    const unindented = `${prompt}${RULE}\n? for shortcuts\n`;
    expect(readScreen('claude-code', unindented).kind).toBe('unknown');

    // A real box followed by nothing reads idle
    const realBoxFollowedByNothing = `${RULE}\n❯ \n${RULE}\n`;
    expect(readScreen('claude-code', realBoxFollowedByNothing).kind).toBe('idle');

    // A real box whose footer has two rows reads idle
    const twoRowFooter = `${RULE}\n❯ \n${RULE}\n  main · Opus 5.5\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n`;
    expect(readScreen('claude-code', twoRowFooter).kind).toBe('idle');

    // A scrolled-out box with a two-row footer reads idle
    const scrolledTwoRow = `❯ \n${RULE}\n  main · Opus 5.5\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n`;
    expect(readScreen('claude-code', scrolledTwoRow).kind).toBe('idle');

    // A scrolled-out box with one valid footer row and one foreign line reads unknown
    const scrolledOneValidOneForeign = `❯ \n${RULE}\n  main · Opus 5.5\nshell output\n`;
    expect(readScreen('claude-code', scrolledOneValidOneForeign).kind).toBe('unknown');

    // A scrolled-out box with only the status row reads unknown
    const scrolledStatusOnly = `❯ \n${RULE}\n  main · Opus 5.5\n`;
    expect(readScreen('claude-code', scrolledStatusOnly).kind).toBe('unknown');

    // A scrolled-out box with only the mode row reads unknown
    const scrolledBypassOnly = `❯ \n${RULE}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n`;
    expect(readScreen('claude-code', scrolledBypassOnly).kind).toBe('unknown');

    // A scrolled-out box with footer rows in reversed order reads unknown
    const scrolledReversed = `❯ \n${RULE}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n  main · Opus 5.5\n`;
    expect(readScreen('claude-code', scrolledReversed).kind).toBe('unknown');
  });

  test('both rows typed by hand under a rule below a shell prompt reproduce the frame', () => {
    const prompt = '~/acme % ls\nREADME.md\nsrc\n❯ \n';
    const handTypedFrame = `${prompt}${RULE}\n  main · Opus 5.5\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n`;
    // The frame alone, scrolled out of its opening rule, is not enough any more: the rows
    // above the prompt row — the shell prompt and its output — are rows the frame does not
    // explain, so the read fails closed rather than take the box for an empty idle one.
    // The residual this closes required a person to type the whole multi-row frame by hand.
    expect(readScreen('claude-code', handTypedFrame).kind).toBe('unknown');
  });

  test('a real box with a custom status line stays idle with the footer frame', () => {
    // Custom status line containing custom branch, directory, Opus model, and custom tokens
    const customStatus = `❯ \n${RULE}\n  custom-branch · my-repo · Opus 5.5 · tokens: 12k\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n`;
    expect(readScreen('claude-code', customStatus).kind).toBe('idle');
  });

  test('a real box in a narrow pane where the status row is cut with … stays idle with the footer frame', () => {
    // Narrow pane status row truncated with ellipsis, as captured in live sessions
    const narrowStatus = `❯ \n${RULE}\n  no-git · …/acme · Opus 5.5 · S: - · L: …\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n`;
    expect(readScreen('claude-code', narrowStatus).kind).toBe('idle');
  });

  test('every fixture matches the classifier main had', () => {
    for (const [name, text] of fixtures) {
      if (name === 'quoted permission') continue;
      const lines = text.split('\n').map((line) => line.trimEnd()).slice(-20);
      const before = mainClaude(lines);
      const after = readScreen('claude-code', text).kind;
      const named = classify('claude-code', text.split('\n')).kind;
      expect(`${name}: ${after}`).toBe(`${name}: ${before}`);
      expect(`${name}: ${named}`).toBe(`${name}: ${before}`);
    }
  });

  test('prose that mentions Esc to cancel above an empty box is idle', () => {
    const text = `The docs say Esc to cancel.\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
    expect(readScreen('claude-code', text).kind).toBe('idle');
  });

  test('prose quoting a dialog above the box stays prose: the box is idle', () => {
    // Constructed (fixtures/claude-code/README.md). The quote is the dialog's own words:
    // the classifier main had read this screen as a permission, and the box below the
    // quote is what the pane is.
    const text = readFileSync(new URL('./fixtures/claude-code/quoted-dialog.txt', import.meta.url), 'utf8');
    const lines = text.split('\n').map((line) => line.trimEnd()).slice(-20);
    expect(mainClaude(lines)).toBe('permission');
    expect(readScreen('claude-code', text).kind).toBe('idle');
    expect(classify('claude-code', text.split('\n')).kind).toBe('idle');
  });

  test('a transcript of 1. Yes / 2. No above a bare prompt is unknown', () => {
    // No rule above the prompt and no status footer under it, so it is not Claude's box.
    const text = `1. Yes\n2. No\n❯ \n`;
    expect(readScreen('claude-code', text).kind).toBe('unknown');
  });

  test('typed text with no closing rule is unknown', () => {
    expect(readScreen('claude-code', '❯ ship the fix\n').kind).toBe('unknown');
  });

  test('a box whose rule above has scrolled out stays idle when the status footer remains', () => {
    const text = `❯ \n${RULE}\n${STATUS}\n`;
    expect(readScreen('claude-code', text).kind).toBe('idle');
  });

  test('a box whose top rule has scrolled out reads unknown with only the shortcuts row', () => {
    const text = readFileSync(new URL('./fixtures/claude-code/scrolled-shortcuts.txt', import.meta.url), 'utf8');
    expect(readScreen('claude-code', text).kind).toBe('unknown');
  });

  test('a question dialog with a status line under it and no rule stays a question', () => {
    const text = `Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n  main · Opus 5.5\n`;
    const lines = text.split('\n').map((line) => line.trimEnd()).slice(-20);
    expect(mainClaude(lines)).toBe('question');
    expect(readScreen('claude-code', text).kind).toBe('question');
  });

  test('a quoted permission question above an empty box is the one difference', () => {
    const text = fixtures.find(([name]) => name === 'quoted permission')?.[1] ?? '';
    const lines = text.split('\n').map((line) => line.trimEnd()).slice(-20);
    expect(mainClaude(lines)).toBe('permission');
    expect(readScreen('claude-code', text).kind).toBe('idle');
  });

  test('an empty box stays idle for the composer while a turn is still on screen', () => {
    const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
    expect(classify('claude-code', busy.split('\n')).kind).toBe('working');
    expect(classifyComposer('claude-code', busy.split('\n')).kind).toBe('idle');
  });

  test('an unnumbered trust dialog reads trust', () => {
    const text = readFileSync(new URL('./fixtures/claude-code/trust-unnumbered.txt', import.meta.url), 'utf8');
    expect(readScreen('claude-code', text).kind).toBe('trust');
  });

  test('prose saying "Yes, I trust this folder" above an idle box is idle', () => {
    const text = `Yes, I trust this folder\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
    expect(readScreen('claude-code', text).kind).toBe('idle');
    const prose = `The assistant wrote: Yes, I trust this folder\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
    expect(readScreen('claude-code', prose).kind).toBe('idle');
  });

  test('a numbered trust dialog still reads trust', () => {
    const text = `Do you trust this folder?\n❯ 1. Yes, proceed\n  2. No, exit\n\nEnter to confirm · Esc to cancel\n`;
    expect(readScreen('claude-code', text).kind).toBe('trust');
    const live = [
      'Accessing workspace:',
      'Quick safety check: Is this a project you created or one you trust?',
      'Claude Code will be able to read, edit, and execute files here.',
      '❯ 1. Yes, I trust this folder',
      '  2. No, exit',
    ].join('\n');
    expect(readScreen('claude-code', live).kind).toBe('trust');
  });

  test('the trust question reads in every case, and its choice stays as drawn', () => {
    for (const question of ['Do you trust this folder?', 'DO YOU TRUST THIS FOLDER?', 'Do YoU tRuSt ThE fOlDeR?', 'One you trust?', 'ONE YOU TRUST?']) {
      expect(readScreen('claude-code', `${question}\n❯ 1. Yes\n`).kind).toBe('trust');
    }
    // Only the question carries the flag: "1. yes" is not the drawn choice.
    expect(readScreen('claude-code', 'Do you trust this folder?\n❯ 1. yes\n').kind).not.toBe('trust');
  });

  test('the trust question folds ASCII case only, as its hand-spelled classes did', () => {
    // The flag replaced the letter classes, not the fold they had: the engine's Unicode
    // case folding would let `ſ` (U+017F) match the `s` of "trust", which the classes
    // never did. Every ASCII case still reads as itself.
    const question = (text: string) => readScreen('claude-code', `${text}\n❯ 1. Yes\n`).kind;
    for (const ascii of ['Do you trust this folder?', 'DO YOU TRUST THIS FOLDER?', 'Do YoU tRuSt ThE fOlDeR?', 'One you trust?', 'ONE YOU TRUST?']) {
      expect(question(ascii)).toBe('trust');
    }
    for (const longS of ['Do you truſt this folder?', 'Do you truſt the folder?', 'One you truſt?']) {
      expect(question(longS)).not.toBe('trust');
    }
  });

  test('permission and question fixtures still read as before', () => {
    const permission = `Bash command\n\n  chmod +x run.sh\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently\n\nEsc to cancel · Tab to amend\n`;
    expect(readScreen('claude-code', permission).kind).toBe('permission');
    const question = `Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`;
    expect(readScreen('claude-code', question).kind).toBe('question');
  });
});

// Claude Code's screens as herdr reads them styled (`--format ansi`): a greyed suggestion is
// faint, typed text carries no styling, and the trust dialog keeps the safety floor. The
// fixtures and their provenance are in fixtures/claude-code/2.1.289/README.md.
describe('claude-code reads the input line\'s styling', () => {
  const styled = (name: string): string => readFileSync(new URL(`./fixtures/claude-code/2.1.289/${name}`, import.meta.url), 'utf8');

  test('a greyed suggestion the list does not name is idle', () => {
    expect(readScreen('claude-code', styled('idle-suggestion-other-ansi.txt')).kind).toBe('idle');
  });

  test('the captured "Try" suggestion is idle styled and plain', () => {
    expect(readScreen('claude-code', styled('idle-suggestion-ansi.txt')).kind).toBe('idle');
    expect(readScreen('claude-code', styled('idle-suggestion-plain.txt')).kind).toBe('idle');
  });

  test('typed text is unsent, styled read or plain', () => {
    expect(readScreen('claude-code', styled('unsent-typed-ansi.txt')).kind).toBe('unsent');
  });

  test('text that opens faint and continues normal is unsent', () => {
    expect(readScreen('claude-code', styled('unsent-faint-first-ansi.txt')).kind).toBe('unsent');
  });

  test('typed text in a colour, however grey it renders, is unsent', () => {
    // Faint is the only placeholder style (see sgrDim's table); a colour is text.
    const screen = (style: string) => `${RULE}\n❯ \x1b[${style}mFix the\x1b[0m\n${RULE}\n${STATUS}\n`;
    for (const style of ['38;2;0;0;0', '38;2;153;153;153', '90']) {
      expect(readScreen('claude-code', screen(style)).kind).toBe('unsent');
    }
  });

  test('a faint "Try" with typed characters after it is unsent', () => {
    // A line with any styling is decided by the styling alone: the list would have called
    // this idle by its prefix, and idle is the reading the nudge types into.
    const text = `${RULE}\n❯ \x1b[2mTry "x"\x1b[0m y\n${RULE}\n${STATUS}\n`;
    expect(readScreen('claude-code', text).kind).toBe('unsent');
  });

  test('a plain source falls back to the list: "Try" stays idle, the rest stays unsent', () => {
    expect(readScreen('claude-code', styled('idle-suggestion-plain.txt')).kind).toBe('idle');
    expect(readScreen('claude-code', styled('idle-suggestion-other-plain.txt')).kind).toBe('unsent');
  });

  test('a styled read the fold has not reached, CRLF and all, reads the same', () => {
    const crlf = styled('idle-suggestion-other-ansi.txt').replace(/\n/g, '\r\n');
    expect(readScreen('claude-code', crlf).kind).toBe('idle');
  });

  test('a slash command being typed is unsent', () => {
    expect(readScreen('claude-code', styled('unsent-slash-ansi.txt')).kind).toBe('unsent');
  });

  test('a paste placeholder chip is unsent', () => {
    // The chip — [Pasted text #2 +7 lines] — renders unstyled, real content rather than a
    // greyed suggestion, so the styling gate passes it to the list, which names no such entry.
    expect(readScreen('claude-code', styled('unsent-paste-ansi.txt')).kind).toBe('unsent');
  });

  test('text typed while a turn runs is never idle: the screen works, the composer unsent', () => {
    // The running screen styles the prompt itself (38;2;153;153;153) — grey, but only faint
    // is a placeholder, and the typed text past the reset carries nothing.
    const lines = styled('unsent-typing-while-running-ansi.txt').split('\n');
    expect(classify('claude-code', lines).kind).toBe('working');
    expect(classifyComposer('claude-code', lines).kind).toBe('unsent');
  });

  test('bash mode reads unknown: its prompt is "!", not the composer\'s', () => {
    // `!` swaps the prompt glyph, so the composer finds no input line at all. Unknown is
    // never idle and never typed into; whether "!" belongs in the prompt set stays open.
    const kind = readScreen('claude-code', styled('bash-mode-ansi.txt')).kind;
    expect(kind).not.toBe('idle');
    expect(kind).toBe('unknown');
  });

  test('the styled trust dialog reads trust', () => {
    // 2.1.289 draws this dialog's choices without numbers (`❯ No, exit` / `Yes, I trust this
    // folder`), matching the unnumbered trust pattern together with its footer.
    expect(readScreen('claude-code', styled('trust-ansi.txt')).kind).toBe('trust');
  });
});

// The classifiers codex, cursor and antigravity had on main, copied here so the
// table proves the new path agrees with them. The production files are gone.
function mainCodex(lines: string[]): Screen['kind'] {
  if (lines.some((line) => /\bmodel:\s+loading\b/.test(line))) return 'unknown';
  const composer = codexBox(lines);
  if (composer === 'permission' || composer === 'trust' || composer === 'question') return composer;
  if (lines.some((line) => /esc to interrupt/.test(line))) return 'working';
  return composer;
}

function codexBox(lines: string[]): Screen['kind'] {
  const text = lines.join('\n');
  const last = lines.filter((line) => line.trim()).at(-1)?.trim() ?? '';
  if (last === 'Press enter to confirm or esc to cancel'
    && /^\s*Would you like to run the following command\?\s*$/m.test(text)
    && /^\s*›?\s*1\. Yes, proceed \(y\)\s*$/m.test(text)
    && /^\s*›?\s*2\. No, and tell Codex what to do differently \(esc\)\s*$/m.test(text)) return 'permission';
  if (last === 'enter continue · esc quit' && /Trust this folder\?/.test(text)
    && /^\s*›?\s*1\. Trust and continue\s*$/m.test(text)) return 'trust';
  if (last === 'enter continue · esc skip' && /Update available ·/.test(text)
    && /^\s*›?\s*1\. Update now\b/m.test(text)) return 'question';
  const footer = lines.findLastIndex((line) => /^\s+GPT-\d[\w.-]*\s+[^·]*·/.test(line));
  if (footer < 0 || lines.slice(footer + 1).some((line) => line.trim())) return 'unknown';
  let prompt = footer - 1;
  while (prompt >= 0 && !/^\s*›(?:\s|$)/.test(lines[prompt] as string)) prompt--;
  if (prompt < 0) return 'unknown';
  const typed = (lines[prompt] as string).replace(/^\s*›/, '').trim();
  if (lines.slice(prompt + 1, footer).some((line) => line.trim())) return 'unsent';
  return typed === '' || typed === 'Ask Codex to do anything' ? 'idle' : 'unsent';
}

function mainCursor(lines: string[]): Screen['kind'] {
  const composer = cursorBox(lines);
  if (composer === 'trust') return composer;
  if (lines.some((line) => /ctrl\+c to stop/.test(line) || /^\s*[\u2800-\u28FF]+\s+(Working|Thinking)\b/.test(line))) return 'working';
  return composer;
}

function cursorBox(lines: string[]): Screen['kind'] {
  if (cursorTrust(lines)) return 'trust';
  if (lines.some((line) => /To resume this session:/.test(line))) return 'unknown';
  const footer = lines.findLastIndex((line) => /^\s+Grok\s+\d/.test(line));
  if (footer < 0) return cursorSlash(lines);
  const trailing = lines.slice(footer + 1).filter((line) => line.trim());
  if (trailing.length > 1 || trailing.some((line) => /^\s*→/.test(line))) return 'unknown';
  let prompt = footer - 1;
  while (prompt >= 0 && !/^\s*→/.test(lines[prompt] ?? '')) prompt--;
  if (prompt < 0) return 'unknown';
  const typed = (lines[prompt] ?? '').replace(/^\s*→/, '').replace(/\s*ctrl\+c to stop\s*$/, '').trim();
  if (lines.slice(prompt + 1, footer).some((line) => line.trim())) return 'unsent';
  return typed === '' || typed === 'Plan, search, build anything' || typed === 'Add a follow-up' ? 'idle' : 'unsent';
}

function cursorTrust(lines: string[]): boolean {
  const text = lines.join('\n');
  if (!/Do you trust the contents of this/.test(text) || !/directory\?/.test(text)) return false;
  if (!/\[a\] Trust this workspace/.test(text) || !/\[q\] Quit/.test(text)) return false;
  const nav = lines.findLastIndex((line) => /Use arrow keys to navigate, Enter to/.test(line));
  if (nav < 0) return false;
  return !lines.slice(nav + 1).some((line) => /^\s*→/.test(line) || /^\s+Grok\s+\d/.test(line));
}

function cursorSlash(lines: string[]): Screen['kind'] {
  const typed = lines.findIndex((line) => /^\s*→\s+\S/.test(line) && !/\sExit\s*$/.test(line));
  const menu = lines.some((line) => /^\s*→?\s*\/\S+\s+Exit\s*$/.test(line));
  return typed >= 0 && menu ? 'unsent' : 'unknown';
}

function mainAntigravity(lines: string[]): Screen['kind'] {
  const composer = agyBox(lines);
  if (composer === 'trust' || composer === 'permission') return composer;
  if (lines.some((line) => /\bGenerating\.\.\./.test(line))) return 'working';
  return composer;
}

function agyBox(lines: string[]): Screen['kind'] {
  const text = lines.join('\n');
  const hasTrustQuestion = /Do you trust the contents of this project\?/i.test(text);
  const hasTrustChoice = />\s*Yes, I trust this folder/i.test(text);
  const hasConfirmFooter = lines.some((line) => /enter Confirm/i.test(line));
  if (hasTrustQuestion && hasTrustChoice && hasConfirmFooter) {
    const lastRule = lines.findLastIndex((line) => /^\s*[─━]{8,}\s*$/.test(line));
    const confirmIdx = lines.findLastIndex((line) => /enter Confirm/i.test(line));
    if (confirmIdx > lastRule) return 'trust';
  }
  const hasPermissionReq = /Requesting permission for:/i.test(text);
  const hasPermissionChoice = lines.some((line) => /^\s*>\s*[0-9]\.\s+Yes\b/i.test(line));
  const hasPermissionNav = lines.some((line) => /↑\/↓ Navigate/i.test(line));
  if (hasPermissionReq && hasPermissionChoice && hasPermissionNav) {
    const lastRule = lines.findLastIndex((line) => /^\s*[─━]{8,}\s*$/.test(line));
    const navIdx = lines.findLastIndex((line) => /↑\/↓ Navigate/i.test(line));
    if (navIdx > lastRule) return 'permission';
  }
  let bottomBorder = -1;
  let topBorder = -1;
  let prompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (/^\s*[─━]{8,}\s*$/.test(line)) {
      if (bottomBorder === -1) bottomBorder = i;
      else if (topBorder === -1 && prompt !== -1) { topBorder = i; break; }
    } else if (bottomBorder !== -1 && prompt === -1 && /^\s*>\s*/.test(line)) prompt = i;
  }
  if (topBorder < 0 || bottomBorder < 0 || prompt <= topBorder || prompt >= bottomBorder) return 'unknown';
  const belowBottom = lines.slice(bottomBorder + 1);
  const validFooter = belowBottom.some((line) => /(\? for shortcuts|Gemini\s+\d|esc to cancel|>\s*\/exit\s+Exit)/i.test(line));
  if (!validFooter) return 'unknown';
  const typed = (lines[prompt] as string).replace(/^\s*>\s*/, '').trim();
  if (lines.slice(prompt + 1, bottomBorder).some((line) => line.trim() !== '')) return 'unsent';
  return typed === '' ? 'idle' : 'unsent';
}

function windowOf(text: string): string[] {
  return text.split('\n').map((line) => line.trimEnd()).slice(-20);
}

const captured: [string, string, (lines: string[]) => Screen['kind']][] = [
  ['codex', '0.157.0', mainCodex],
  ['cursor', '2026.10.01', mainCursor],
  ['antigravity', '1.2.16', mainAntigravity],
];

describe('codex, cursor and antigravity through the screen core', () => {
  test('typed text ending in ctrl+c to stop is a running turn, and unsent in the composer', () => {
    // Constructed, not a capture, drawn at the capture's own columns: the prompt sits at
    // the pane's second column, as unsent.txt draws it, under the blank frame row every
    // capture keeps against the input row. The suffix on the prompt is the running turn.
    // The composer strips it, and the words typed under it are unsent.
    const text = '\n  → ship the fix   ctrl+c to stop\n  Grok 4.7 256K High\n';
    expect(classifyComposer('cursor', text.split('\n')).kind).toBe('unsent');
    expect(classify('cursor', text.split('\n')).kind).toBe('working');
  });

  test('an empty follow-up box with a background-task row is idle', () => {
    for (const name of ['task-idle.txt', 'tasks-idle.txt']) {
      const text = readFileSync(new URL(`./fixtures/cursor/2026.10.01/${name}`, import.meta.url), 'utf8');
      expect(readScreen('cursor', text).kind, name).toBe('idle');
      expect(classify('cursor', text.split('\n')).kind, name).toBe('idle');
      const typed = text.replace('  → Add a follow-up', '  → hello');
      expect(readScreen('cursor', typed).kind, `${name} typed`).toBe('unsent');
    }
  });

  test('a quoted ctrl+c to stop above an idle box is idle', () => {
    const idle = readFileSync(new URL('./fixtures/cursor/2026.10.01/idle.txt', import.meta.url), 'utf8');
    const text = `  the transcript quoted ctrl+c to stop\n${idle}`;
    expect(classify('cursor', text.split('\n')).kind).toBe('idle');
    expect(readScreen('cursor', text).kind).toBe('idle');
  });

  test('a running turn whose spinner has scrolled out is still working', () => {
    const text = readFileSync(new URL('./fixtures/cursor/2026.10.01/working-no-spinner.txt', import.meta.url), 'utf8');
    expect(classify('cursor', text.split('\n')).kind).toBe('working');
    expect(readScreen('cursor', text).kind).toBe('working');
  });

  test('every captured screen matches the classifier main had', () => {
    for (const [cli, version, read] of captured) {
      const dir = fileURLToPath(new URL(`./fixtures/${cli}/${version}/`, import.meta.url));
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.txt')) continue;
        // Constructed, not captured (see the fixtures README), and the one screen a fix is
        // meant to read differently: main's classifier called the dialog below `unsent`, and
        // two input paths pressed Enter on that reading. Its own test follows the loop.
        if (name === 'permission-pinned.txt') continue;
        // Transcribed, not captured (see the fixtures README), and a screen this fix is meant
        // to read differently: the frozen classifier below knew the spinner verbs Working and
        // Thinking only, so this frame's Reading spinner fell through to the composer and the
        // queue read idle, which `down` and `remove` typed into. Its own test follows in
        // test/launch/cursor.test.ts.
        if (name === 'follow-up-queue-one.txt') continue;
        // Captured dialogs main had no rule for, so they fell through to unknown. The profile
        // now names them. Their own test follows the loop.
        if (name === 'permission-plan.txt' || name === 'question.txt') continue;
        // Captured under other models. Main's status row matched Grok only, so each of these
        // read unknown. The profile now reads the row by its shape. Their own test is in
        // test/launch/cursor.test.ts.
        if (name === 'composer-idle.txt' || name === 'composer-unsent.txt'
          || name === 'gemini-flash-idle.txt' || name === 'gemini-flash-unsent.txt'
          || name === 'gpt-sol-idle.txt' || name === 'gpt-sol-unsent.txt') continue;
        // Captured 2026-10-05, and the screens this fix is meant to read differently: the CLI
        // draws the box between two border rows, which main's classifier knew as no frame, so
        // each of these read unknown. The profile now reads the bordered frame beside the
        // blank one. Their own tests are in test/launch/cursor.test.ts.
        if (name.startsWith('bordered-')) continue;
        // Captured 2026-10-12. Main's classifier treats the background-task row
        // (`  1 task` / `  2 tasks`) between the empty placeholder and the status
        // row as unsent text. The box holds only the placeholder. Its own test
        // follows the loop.
        if (name === 'task-idle.txt' || name === 'tasks-idle.txt') continue;
        // Captured 2026-10-04, and the four screens the antigravity profile's round-2 rules are
        // meant to read differently: main had no rule for the file-creation, file-edit, question
        // or unsent-comments dialogs and read each unknown. Their own test follows the loop.
        if (name === 'permission-write-54.txt' || name === 'permission-edit-54.txt'
          || name === 'question-54.txt' || name === 'question-unsent-54.txt') continue;
        // Captured at startup, and the one reading this slice changes: main read the update
        // screen as a question, and the profile now names it a vendor notice. Its own test
        // follows the loop.
        if (cli === 'codex' && name === 'startup.txt') continue;
        const text = readFileSync(new URL(`./fixtures/${cli}/${version}/${name}`, import.meta.url), 'utf8');
        const before = read(windowOf(text));
        const after = readScreen(cli, text).kind;
        const named = classify(cli, text.split('\n')).kind;
        expect(`${cli} ${name}: ${after}`).toBe(`${cli} ${name}: ${before}`);
        expect(`${cli} ${name}: ${named}`).toBe(`${cli} ${name}: ${before}`);
      }
    }
  });

  test('a permission dialog whose rule is out of the window stays permission', () => {
    const text = readFileSync(new URL('./fixtures/antigravity/1.2.16/permission-cut.txt', import.meta.url), 'utf8');
    expect(mainAntigravity(windowOf(text))).toBe('permission');
    expect(readScreen('antigravity', text).kind).toBe('permission');
    expect(classify('antigravity', text.split('\n')).kind).toBe('permission');
  });

  test('the four captured dialogs main read unknown: file-creation, file-edit, question, unsent comments', () => {
    // origin/main's shipped reader calls each of these unknown (verified with a detached build
    // of it over every fixture; the sweep is in the round-2 result). The frozen mainAntigravity
    // is not the oracle here: it has no safety floor, and it reads permission-write-54.txt's
    // numbered options as an unsent box — the shipped main applies the floor and says unknown.
    const kinds: [string, Screen['kind']][] = [
      ['permission-write-54.txt', 'permission'],
      ['permission-edit-54.txt', 'permission'],
      ['question-54.txt', 'question'],
      ['question-unsent-54.txt', 'question'],
    ];
    for (const [name, kind] of kinds) {
      const text = readFileSync(new URL(`./fixtures/antigravity/1.2.16/${name}`, import.meta.url), 'utf8');
      expect(readScreen('antigravity', text).kind).toBe(kind);
      expect(classify('antigravity', text.split('\n')).kind).toBe(kind);
      expect(classifyComposer('antigravity', text.split('\n')).kind).toBe('unknown');
    }
  });

  test('the constructed fixture differs on purpose: a permission dialog above the pinned status line', () => {
    const text = readFileSync(new URL('./fixtures/codex/0.157.0/permission-pinned.txt', import.meta.url), 'utf8');
    // Main missed the dialog twice over: its lower-case footer phrase, and the choice line read
    // as the composer's input. The new reading is the dialog, and never idle or unsent.
    expect(mainCodex(windowOf(text))).toBe('unsent');
    expect(readScreen('codex', text).kind).toBe('permission');
    expect(classify('codex', text.split('\n')).kind).toBe('permission');
  });

  test('a plan-mode approval and a question box are those screens, which main called unknown', () => {
    const permission = readFileSync(new URL('./fixtures/cursor/2026.10.01/permission-plan.txt', import.meta.url), 'utf8');
    const question = readFileSync(new URL('./fixtures/cursor/2026.10.01/question.txt', import.meta.url), 'utf8');
    expect(mainCursor(windowOf(permission))).toBe('unknown');
    expect(readScreen('cursor', permission).kind).toBe('permission');
    expect(classify('cursor', permission.split('\n')).kind).toBe('permission');
    expect(mainCursor(windowOf(question))).toBe('unknown');
    expect(readScreen('cursor', question).kind).toBe('question');
    expect(classify('cursor', question.split('\n')).kind).toBe('question');
  });

  test('the one difference: cursor reads a resume line before a trust dialog', () => {
    const trust = readFileSync(new URL('./fixtures/cursor/2026.10.01/trust.txt', import.meta.url), 'utf8');
    const both = `${trust}\nTo resume this session:\n`;
    expect(mainCursor(windowOf(both))).toBe('trust');
    expect(readScreen('cursor', both).kind).toBe('unknown');
  });

  test('the one re-read: the Codex update screen is a vendor notice, not a question', () => {
    const text = readFileSync(new URL('./fixtures/codex/0.157.0/startup.txt', import.meta.url), 'utf8');
    // Main read the same option line and footer as a question. The profile now carries it as
    // the vendor's own notice: still left unanswered, and never typed into.
    expect(mainCodex(windowOf(text))).toBe('question');
    expect(readScreen('codex', text).kind).toBe('vendor notice');
    expect(classify('codex', text.split('\n')).kind).toBe('vendor notice');
  });

  test('the update words without their option row and footer are ordinary output', () => {
    // The notice is read whole: its own line and option row, under the footer it was captured
    // with. The same words in ordinary output — an answer quoting the screen, a release note —
    // are not the notice, and read exactly as main read them.
    const words = '  Update available · 0.157.0 → 0.160.0\n';
    const screens = [
      // Ordinary output: no option row, no footer.
      `${words}  Release notes: https://example.com\n\nDone. Nothing to update here.\n`,
      // The option row without the captured footer.
      `${words}\n› 1. Update now\n  2. Skip\n`,
      // The footer without the option row.
      `${words}\n  1. Skip\n\nenter continue · esc skip\n`,
    ];
    for (const screen of screens) {
      expect(`${mainCodex(windowOf(screen))}`).toBe('unknown');
      expect(readScreen('codex', screen).kind).toBe('unknown');
      expect(classify('codex', screen.split('\n')).kind).toBe('unknown');
    }
  });
});

describe('antigravity dialog words outside the dialog', () => {
  // The round-2 profile rules anchor each dialog to its own structure as the captures draw it
  // (the question line and its option rows below the dialog's rule, or the unsent-comments
  // wording with no rule and no bare input row after it). The same words elsewhere are never
  // the dialog: quoted in a transcript above the box, or typed into the box by a person. Every
  // screen here reads the same on origin/main, verified against a detached build of it.
  const agyIdle = readFileSync(new URL('./fixtures/antigravity/1.2.16/idle.txt', import.meta.url), 'utf8').replace(/\n$/, '');
  const AGY_RULE = '─'.repeat(53);
  const AGY_FOOTER = '                              Gemini 3.8 Flash · high';
  // agy's composer as unsent.txt draws it: the first typed row at the prompt, continuation
  // rows at the content column, the closing rule, the model footer.
  const agyBoxWith = (rows: string[]): string =>
    [AGY_RULE, `> ${rows[0]}`, ...rows.slice(1).map((row) => `  ${row}`), AGY_RULE, AGY_FOOTER].join('\n');
  const kinds = (text: string): string => {
    const lines = text.split('\n');
    return `${classify('antigravity', lines).kind}/${classifyComposer('antigravity', lines).kind}`;
  };

  test('a quoted permission or question dialog above an idle box stays idle', () => {
    const quoted = [
      'Allow creation of this file?\n> 1. Yes, allow creation\n  2. No, deny creation\n  ↑/↓ Navigate · tab Amend · f full diff',
      'Accept this file edit?\n> 1. Yes, accept this change\n  2. No, reject this change\n  ↑/↓ Navigate · tab Amend · f full diff',
      'Question 1/1: Which file name would you like to use?\n> 1. notes.txt\n  2. memo.txt\n  3. Write-in...\n  ↑/↓ Navigate · enter Select · esc Skip',
      'You have unsent comments. Ready to send?\n  y send and exit · n exit without sending · esc cancel',
    ];
    for (const words of quoted) {
      const text = `${words}\n${agyIdle}`;
      expect(kinds(text)).toBe('idle/idle');
      expect(readScreen('antigravity', text).kind).toBe('idle');
    }
  });

  test('a dialog phrase alone, quoted above an idle box, stays idle', () => {
    for (const words of [
      'The CLI asked: Allow creation of this file?',
      'It showed: Accept this file edit?',
      'It showed Question 1/1: which name to pick',
      'It said: You have unsent comments. Ready to send?',
    ]) {
      expect(kinds(`${words}\n${agyIdle}`)).toBe('idle/idle');
    }
  });

  test('the unsent-comments words with no rule but a bare input row after are not the dialog', () => {
    // The none_after guard is load-bearing: without it this scrolled transcript would match.
    const text = 'You have unsent comments. Ready to send?\n  y send and exit · n exit without sending · esc cancel\n>\n';
    expect(kinds(text)).toBe('unknown/unknown');
    expect(readScreen('antigravity', text).kind).not.toBe('question');
  });

  test('a dialog question line typed into the box is unsent, never the dialog', () => {
    for (const typed of [
      'Allow creation of this file?',
      'Accept this file edit?',
      'Question 1/1: notes.txt or memo.txt?',
      'You have unsent comments. Ready to send?',
    ]) {
      expect(kinds(agyBoxWith([typed]))).toBe('unsent/unsent');
    }
  });

  test('a whole dialog typed into the box is never the dialog', () => {
    // The core's choice-line floor reads the typed option rows as a numbered choice, so these
    // read unknown rather than unsent — origin/main reads them the same; the profile rules
    // never fire, which is what this test pins.
    const dialogs = [
      ['Allow creation of this file?', '> 1. Yes, allow creation', '2. No, deny creation', '↑/↓ Navigate · tab Amend · f full diff'],
      ['Question 1/1: notes or memo?', '> 1. notes.txt', '2. memo.txt', '3. Write-in...', '↑/↓ Navigate · enter Select · esc Skip'],
    ];
    for (const rows of dialogs) {
      const text = agyBoxWith(rows);
      expect(classify('antigravity', text.split('\n')).kind).toBe('unknown');
      expect(classify('antigravity', text.split('\n')).kind).not.toBe('permission');
      expect(classify('antigravity', text.split('\n')).kind).not.toBe('question');
    }
  });
});

describe('the pattern dialect', () => {
  test('shorthand classes match JavaScript, and the nested shapes are refused', () => {
    const ours = compilePattern('^\\s$');
    const native = /^\s$/u;
    let mismatches = 0;
    for (let cp = 0; cp <= 0xffff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (ours.test(ch) !== native.test(ch)) mismatches++;
    }
    expect(mismatches).toBe(0);
    const gap = compilePattern('^[^\\S\\n]$');
    const nativeGap = /^[^\S\n]$/;
    for (const cp of [0x09, 0x0a, 0x20, 0x41]) expect(gap.test(String.fromCodePoint(cp))).toBe(nativeGap.test(String.fromCodePoint(cp)));
    expect(() => compilePattern('(a+)+')).toThrow(DialectError);
    expect(() => compilePattern('(.+)*')).toThrow(DialectError);
    expect(() => compilePattern('(\\.?[0-9]+)*')).toThrow(DialectError);
    expect(() => compilePattern('(?=a)')).toThrow(DialectError);
    expect(() => compilePattern('\\u0041')).toThrow(DialectError);
    expect(() => compilePattern('a'.repeat(201))).toThrow(DialectError);
    expect(compilePattern('([0-9]+(?:\\.[0-9]+)*)').test('1.2.3')).toBe(true);
    expect(compilePattern('(a|aa)*').test('aaaa')).toBe(true);
  });

  test('an astral code point is the character it says, not five hex digits', () => {
    // U+1F600 is one code point above U+FFFF. A four-digit "\u" escape cannot spell it:
    // the digits spill into a following character — the pattern a corruption, and a range
    // whose ends fall off. The compiled source must use the "\u{…}" form for these.
    const face = compilePattern('^😀$');
    expect(face.test('😀')).toBe(true);
    expect(face.test('ὠ0')).toBe(false);
    expect(face.test('ὠ')).toBe(false);
    const range = compilePattern('^[😀-🙏]$');
    for (const drawn of ['😀', '🙏']) expect(range.test(drawn)).toBe(true);
    for (const other of ['🦄', 'ὠ', 'a', '😀😀']) expect(range.test(other)).toBe(false);
    const mixed = compilePattern('^[😀0-9]$');
    expect(mixed.test('😀')).toBe(true);
    expect(mixed.test('7')).toBe(true);
    expect(mixed.test('x')).toBe(false);
  });

  test('a positive class mixing a complement shorthand with members is refused', () => {
    // `[\D0-9]` is everything, but its rewrite reads as `[\s\S]` — a match-all nobody wrote.
    // The positive class refuses the mix; the negated forms stay: `[^\S\n]` is the
    // whitespace set without a newline, and a shorthand alone is its own negated class.
    expect(() => compilePattern('[\\D0-9]')).toThrow('a class cannot mix a complement shorthand with other members');
    expect(() => compilePattern('[\\W0-9]')).toThrow(DialectError);
    const alone = compilePattern('^[\\D]$');
    expect(alone.test('a')).toBe(true);
    expect(alone.test('4')).toBe(false);
    expect(compilePattern('^[^\\S\\n]$').test('\t')).toBe(true);
    // A profile that writes the mix is refused when it loads, with the reason.
    const text = `
format: 1
cli: sample
screen:
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
  working:
    - any: ['^[\\D0-9]+$']
`;
    expect(() => loadScreen(text)).toThrow(YamlError);
  });

  test('a read that passes the time bound is unknown', () => {
    const data = loadScreen(`
format: 1
cli: sample
screen:
  trust:
    - all: ['alpha', 'beta']
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`);
    const lines = ['alpha', 'beta'];
    expect(classifyLines(data, lines).kind).toBe('trust');
    let calls = 0;
    const clock = { budgetMs: 100, now: () => (calls++ < 2 ? 0 : 1_000) };
    expect(classifyLines(data, lines, clock).kind).toBe('unknown');
  });

  test('chrome that would hide a numbered choice is refused', () => {
    const text = `
format: 1
cli: sample
screen:
  chrome: ['^.*$']
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`;
    expect(() => loadScreen(text)).toThrow(YamlError);
  });

  test('the chrome guard follows the shape a dialog draws its choices in', () => {
    // A dialog draws the choice the cursor is on with its mark and the others indented
    // without one (screen-core's choiceLine and twoLine; the fake seat draws the same
    // shape and the profiles' rules name the labels). Chrome must match none of the drawn
    // lines: the safety floor reads the first two numbered ones.
    const snippet = (line: string) => `
format: 1
cli: sample
screen:
  chrome: ['${line}']
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`;
    const drawn: string[] = [];
    for (const mark of ['❯ ', '› ', '> ', '  ']) {
      for (const number of [1, 2]) {
        for (const tail of ['', ' Yes', ' No']) drawn.push(`${mark}${number}.${tail}`);
      }
    }
    for (const line of drawn) {
      const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(() => loadScreen(snippet(`^${escaped}$`))).toThrow(YamlError);
    }
    // Chrome that names no drawn line stays: the antigravity profile's menu line is chrome.
    expect(loadScreen(snippet('^\\s*↑/↓ Navigate.*$')).chrome).toHaveLength(1);
  });

  test('the chrome guard covers the long label a choice line runs on with', () => {
    // A choice's label runs past its Yes or No: the trust dialog draws "Yes, I trust this
    // folder" and "No, exit", the permission dialog "No, and tell Claude what to do
    // differently" (the escape hint included on some CLIs), codex names its own two lines.
    // A chrome pattern for any of them hides a real choice from the floor, so it is refused
    // at load like the short labels are.
    const snippet = (line: string) => `
format: 1
cli: sample
screen:
  chrome: ['${line}']
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`;
    const tails = [
      ' Yes, I trust this folder',
      ' No, exit',
      ' No, and tell Claude what to do differently',
      ' No, and tell Claude what to do differently (esc)',
      ' Yes, proceed (y)',
      ' No, and tell Codex what to do differently (esc)',
    ];
    const drawn: string[] = [];
    for (const mark of ['❯ ', '› ', '> ', '  ']) {
      for (const number of [1, 2]) {
        for (const tail of tails) drawn.push(`${mark}${number}.${tail}`);
      }
    }
    for (const line of drawn) {
      const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(() => loadScreen(snippet(`^${escaped}$`))).toThrow(YamlError);
    }
    // The long second choice the screen tests draw, as the pattern that missed the guard.
    expect(() => loadScreen(snippet('^  2\\. No, and tell Claude what to do differently$'))).toThrow(YamlError);
  });

  test('a composer may name its suggestions\' style, and only dim', () => {
    const text = `
format: 1
cli: sample
screen:
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholder_style: dim
    placeholders:
      - equals: ''
`;
    expect(loadScreen(text).composer.placeholderStyle).toBe('dim');
    expect(() => loadScreen(text.replace('placeholder_style: dim', 'placeholder_style: bold'))).toThrow(YamlError);
  });

  test('a box-to-rule composer recognizes footers declared in the profile', () => {
    const data = loadScreen(`
format: 1
cli: sample
screen:
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    footers:
      - 'status'
    placeholders:
      - equals: ''
`);
    const lines = ['> ', '--------', 'status'];
    expect(classifyLines(data, lines).kind).toBe('idle');
  });

  test('a dialog pattern may opt into ignore_case beside itself', () => {
    // The claude-code trust question spells both cases out letter class by letter class.
    // A dialog pattern may instead carry the flag beside it: the pattern's own
    // `ignore_case` is read with the stage's, so one screen can be matched in any case
    // while the choice line next to it stays as case-sensitive as it is drawn.
    const text = `
format: 1
cli: sample
screen:
  trust:
    - all:
        - match: '^do you trust (?:this|the) folder\\?$'
          ignore_case: true
        - '^1\\. yes$'
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`;
    const data = loadScreen(text);
    expect(classifyLines(data, ['DO YOU TRUST THIS FOLDER?', '1. yes']).kind).toBe('trust');
    expect(classifyLines(data, ['Do YoU tRuSt ThE fOlDeR?', '1. yes']).kind).toBe('trust');
    // The pattern next to it carries no flag: the choice is read as it is drawn.
    expect(classifyLines(data, ['DO YOU TRUST THIS FOLDER?', '1. YES']).kind).not.toBe('trust');
    // Without the flag the same pattern is as case-sensitive as every other.
    const plain = loadScreen(text.replace('          ignore_case: true\n', ''));
    expect(classifyLines(plain, ['DO YOU TRUST THIS FOLDER?', '1. yes']).kind).not.toBe('trust');
    expect(classifyLines(plain, ['do you trust this folder?', '1. yes']).kind).toBe('trust');
    // The entry's flag is the whole entry's: its exceptions are read on the same lines
    // the match is, so an exception written in one case still excepts them all.
    const excepted = loadScreen(`
format: 1
cli: sample
screen:
  trust:
    - all:
        - match: '^do you trust (?:this|the) folder\\?$'
          ignore_case: true
          except: ['^do you trust this folder\\?$']
        - '^1\\. yes$'
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`);
    expect(classifyLines(excepted, ['DO YOU TRUST THIS FOLDER?', '1. yes']).kind).not.toBe('trust');
    expect(classifyLines(excepted, ['Do YoU tRuSt ThE fOlDeR?', '1. yes']).kind).toBe('trust');
  });

  test('a composer pattern cannot ignore case, and the load says so', () => {
    // The flag belongs beside a dialog pattern. A composer's own patterns — its prompt,
    // its rule, its footers, its status line, its suffix — take a plain string, and the
    // dialog shape with its flag is refused in words that name the key.
    const snippet = (composer: string) => `
format: 1
cli: sample
screen:
  composer:
${composer}
    placeholders:
      - equals: ''
`;
    const refuse = (composer: string, key: string) =>
      expect(() => loadScreen(snippet(composer))).toThrow(`"${key}" cannot ignore case: only a dialog pattern may`);
    refuse(`    mode: box-to-rule
    prompt:
      match: '^>'
      ignore_case: true
    rule: '^-{8}'`, 'prompt');
    refuse(`    mode: box-to-rule
    prompt: '^>'
    rule:
      match: '^-{8}'
      ignore_case: true`, 'rule');
    refuse(`    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    footers:
      - match: '^status$'
        ignore_case: true`, 'footers');
    refuse(`    mode: status-last
    status_line:
      match: '^status$'
      ignore_case: true
    prompt: '^>'`, 'status_line');
    refuse(`    mode: status-then-one
    status_line: '^status$'
    prompt: '^>'
    strip_suffix:
      match: '\\(esc\\)$'
      ignore_case: true
    fallback:
      - all: ['^done$']
        kind: idle`, 'strip_suffix');
    // The composer's fallback rules are dialog patterns: the flag is theirs to carry.
    expect(() => loadScreen(snippet(`    mode: status-then-one
    status_line: '^status$'
    prompt: '^>'
    fallback:
      - all:
          - match: '^done\\.$'
            ignore_case: true
        kind: idle`))).not.toThrow();
  });

  test('a status line may be a list, read as the union of its patterns', () => {
    // Where one pattern per family would not fit the dialect's length cap, `status_line`
    // takes a non-empty list instead: a line is a candidate when it matches any entry,
    // and an empty list names no row at all and is refused in words.
    const text = (statusLine: string) => `
format: 1
cli: sample
screen:
  composer:
    mode: status-last
    status_line: ${statusLine}
    prompt: '^>'
    placeholders:
      - equals: ''
`;
    const data = loadScreen(text(`['^alpha$', '^beta$']`));
    if (data.composer.mode !== 'status-last') throw new Error('composer mode changed');
    expect(data.composer.statusLine).toHaveLength(2);
    expect(classifyLines(data, ['', '> ', 'alpha']).kind).toBe('idle');
    expect(classifyLines(data, ['', '> ', 'beta']).kind).toBe('idle');
    expect(classifyLines(data, ['', '> ', 'gamma']).kind).toBe('unknown');
    expect(() => loadScreen(text('[]'))).toThrow('"status_line" must be a string or a non-empty list of strings');
  });

  test('a status row may pin its place above a workspace line; exempt rows keep their grammar-only reading', () => {
    // `status_below` names the line directly under the row — the workspace line — which must
    // then be the pane's last non-blank one, and the row must sit within the distance the
    // captures show of the input row. A grammar line anywhere else is ordinary text: here it
    // opens no fallback and reads unknown. `except` keeps a row's old grammar-only reading.
    const text = (below: string) => `
format: 1
cli: sample
screen:
  composer:
    mode: status-then-one
    status_line: '^(?:STATUS|EXEMPT)$'
    status_below: ${below}
    prompt: '^>'
    placeholders:
      - equals: ''
    fallback: []
`;
    const data = loadScreen(text(`'^work$'`));
    if (data.composer.mode !== 'status-then-one') throw new Error('composer mode changed');
    expect(data.composer.statusBelow).toBeDefined();
    expect(classifyLines(data, ['', '> ', 'STATUS', 'work']).kind).toBe('idle');
    // No workspace line under it: the line is not the row, and a grammar line that is not the
    // row is ordinary text, so the fallback stays closed and the screen reads unknown.
    expect(classifyLines(data, ['', '> ', 'STATUS']).kind).toBe('unknown');
    // A blank line between the row and the workspace line: the workspace line is not directly
    // below the row, so the line is not the row and the screen reads unknown.
    expect(classifyLines(data, ['', '> ', 'STATUS', '', 'work']).kind).toBe('unknown');
    // A non-blank line under the workspace line means the workspace line is not the pane's last.
    expect(classifyLines(data, ['', '> ', 'STATUS', 'work', 'more']).kind).toBe('unknown');
    // The row must reach the input row within the captured distance: five blank rows between
    // them hold, six do not.
    expect(classifyLines(data, ['', '> ', '', '', '', '', 'STATUS', 'work']).kind).toBe('idle');
    expect(classifyLines(data, ['', '> ', '', '', '', '', '', 'STATUS', 'work']).kind).toBe('unknown');
    // A row the profile exempts is read by its grammar alone, wherever it is — the reading it
    // had before the field existed.
    const exempt = loadScreen(text(`{ line: '^work$', except: '^EXEMPT' }`));
    expect(classifyLines(exempt, ['', '> ', 'EXEMPT']).kind).toBe('idle');
    expect(classifyLines(exempt, ['', '> ', 'EXEMPT', 'work']).kind).toBe('idle');
    expect(classifyLines(exempt, ['', '> ', 'STATUS']).kind).toBe('unknown');
    // The map takes `line` and `except`, nothing else.
    expect(() => loadScreen(text(`{ line: '^work$', wat: '^x$' }`))).toThrow('unknown key "wat"');
  });

  test('ignore_case folds ASCII letters only, as the hand-spelled classes did', () => {
    // The flag is the fold the classes had: every ASCII letter matches in either case,
    // and none of the engine's wider Unicode folding. The fold lives in the pattern's own
    // text — each letter becomes its two-letter class — so the same source means the same
    // thing under either engine, and the compiled pattern carries the plain "u" flag.
    const trust = compilePattern('(?:Do you trust (?:this|the) folder\\?|One you trust\\?)', true);
    expect(trust.flags).toBe('u');
    for (const ascii of ['Do you trust this folder?', 'DO YOU TRUST THIS FOLDER?', 'Do YoU tRuSt ThE fOlDeR?', 'One you trust?', 'ONE YOU TRUST?']) {
      expect(trust.test(ascii)).toBe(true);
    }
    for (const longS of ['Do you truſt this folder?', 'Do you truſt the folder?', 'One you truſt?']) {
      expect(trust.test(longS)).toBe(false);
    }
    // K (U+212A, the Kelvin sign) folds to k in Unicode; ı (U+0131) and İ (U+0130) sit
    // beside i. Each reads as itself, wherever the pattern has its letter.
    const kick = compilePattern('kick', true);
    expect(kick.test('KiCk')).toBe(true);
    expect(kick.test('Kick')).toBe(false);
    const win = compilePattern('win', true);
    expect(win.test('WIN')).toBe(true);
    expect(win.test('wın')).toBe(false);
    expect(win.test('wİn')).toBe(false);
  });
});

describe('a shell prompt against the other composers', () => {
  const shell = (mark: string) => `~/acme % ls\nREADME.md\nsrc\n${mark} \n`;

  test('codex, cursor and antigravity do not read a bare shell prompt as idle', () => {
    for (const cli of ['codex', 'cursor', 'antigravity'] as const) {
      expect(readScreen(cli, shell('❯')).kind).toBe('unknown');
      expect(readScreen(cli, shell('›')).kind).toBe('unknown');
      expect(readScreen(cli, shell('→')).kind).toBe('unknown');
      expect(readScreen(cli, shell('>')).kind).toBe('unknown');
    }
  });
});

describe('a rule read as one block of rows', () => {
  // The block vocabulary, from the profile that carries it (claude-code's exit_question): a row
  // the dialog draws — '' is one blank row of its spacing, the only way to write one — the
  // `list` run it fills with its own text, and `one_of` for the alternatives a form's tail can
  // take, an empty one for a form that draws no row there. The loader is what refuses a file,
  // so the vocabulary's bounds are pinned here, in the loader's own words.
  const profile = (rule: string): string => `
format: 1
cli: sample
screen:
  exit_question:
${rule}
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`;
  const block = (steps: string): string => `    - block:
${steps}`;

  test('a block compiles to the rows, the run and the alternatives it names', () => {
    const data = loadScreen(
      profile(block(`        - 'Background work is running'
        - ''
        - list: true
        - one_of:
            - ['2. Stay']
            - ['2. Move to background and exit', '3. Stay']
            - []`)),
    );
    expect(data.exit_question?.rules[0]?.block).toEqual([
      { row: 'Background work is running' },
      { blank: true },
      { list: true },
      { oneOf: [[{ row: '2. Stay' }], [{ row: '2. Move to background and exit' }, { row: '3. Stay' }], []] },
    ]);
  });

  test('the vocabulary is bounded, and the loader names what it refuses', () => {
    const refuses = (rule: string, message: string): void => {
      expect(() => loadScreen(profile(rule))).toThrow(message);
    };
    // A block spells every row it draws, the footer among them, so it stands alone: a second
    // primitive would be read on the screen the block has already rejected.
    refuses(`    - block:
        - 'a'
      all: ['b']`, '"block" is the rule\'s only key');
    refuses('    - block: true', '"block" must be a non-empty list of rows');
    refuses('    - block: []', '"block" must be a non-empty list of rows');
    // The block starts at the row it first draws — it is found from the bottom by that row.
    refuses(block(`        - ''
        - 'a'`), 'a block starts with the row it first draws');
    refuses(block(`        - list: true
        - 'a'`), 'a block starts with the row it first draws');
    // A step is a row, a blank, a list or a set of alternatives; nothing else is a step.
    refuses(block('        - 3'), 'a block row must be a string');
    refuses(block('        - [a, b]'), 'a block step must be a map');
    refuses(block('        - wat: true'), 'unknown key "wat"');
    // The run stands alone, is true, and the tail names at least one alternative — an empty
    // set of them is a block no screen can ever be.
    refuses(block(`        - list: false
        - 'a'`), '"list" must be true');
    refuses(block(`        - list: true
          one_of: []
        - 'a'`), '"list" stands alone');
    refuses(block('        - one_of: []'), '"one_of" must name at least one alternative');
    refuses(block(`        - one_of: '2. Stay'`), '"one_of" must name at least one alternative');
    refuses(block(`        - one_of:
            - '2. Stay'`), 'an alternative is a list of the rows it draws');
  });
});

describe('status-then-one status row trailing path matching', () => {
  const home = '/Users/dev';
  const liveDir = '/Users/dev/.config/team/lobby';
  const data = screenData('cursor');
  if (!data) throw new Error('missing cursor data');

  test('multiple trailing lines matching foreground_cwd with ~ expanded are recognized', () => {
    const lines = [
      '  Cursor Agent',
      '  v2026.10.01',
      '',
      '  → Plan, search, build anything',
      '',
      '  Grok 4.7 256K High                  Run Everything',
      '  ~/.config/team/',
      '  lobby',
    ];
    expect(classifyLines(data, lines, { cwd: liveDir, home }).kind).toBe('idle');
    expect(statusRowOf(data, lines, { cwd: liveDir, home })).toBe('  Grok 4.7 256K High                  Run Everything');

    // Without options or with null cwd, fails closed to unknown
    expect(classifyLines(data, lines).kind).toBe('unknown');
    expect(classifyLines(data, lines, { cwd: null, home }).kind).toBe('unknown');
    expect(statusRowOf(data, lines)).toBeNull();

    // With differing cwd, fails closed to unknown
    expect(classifyLines(data, lines, { cwd: '/Users/dev/other', home }).kind).toBe('unknown');
    expect(statusRowOf(data, lines, { cwd: '/Users/dev/other', home })).toBeNull();
  });

  test('single prompt row in trailing lines rejects status row (reviewer-claude probe)', () => {
    const lines = [
      '  Cursor Agent',
      '',
      '  → Plan, search, build anything',
      '',
      '  Grok 4.7 256K High                  Run Everything',
      '  → rm -rf build && deploy',
    ];
    // Must read unknown (never idle), both with and without cwd options
    expect(classifyLines(data, lines, { cwd: liveDir, home }).kind).toBe('unknown');
    expect(statusRowOf(data, lines, { cwd: liveDir, home })).toBeNull();
    expect(classifyLines(data, lines).kind).toBe('unknown');
    expect(statusRowOf(data, lines)).toBeNull();
  });

  test('prompt row in trailing lines rejects status row', () => {
    const lines = [
      '  Cursor Agent',
      '',
      '  → Plan, search, build anything',
      '',
      '  Grok 4.7 256K High                  Run Everything',
      '  ~/.config/team/',
      '  → malicious command',
    ];
    expect(classifyLines(data, lines, { cwd: liveDir, home }).kind).toBe('unknown');
    expect(statusRowOf(data, lines, { cwd: liveDir, home })).toBeNull();
  });
});
