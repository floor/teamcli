import { readFileSync } from 'node:fs';
import type { Seen, StoredReading } from '../src/budgets/readings.ts';
import type { Caller } from '../src/caller.ts';
import type { Io } from '../src/io.ts';
import { rulesText } from '../src/launch/rules.ts';
import { updateState } from '../src/state.ts';

/** The seven-rule message the Codex 0.160.0 and Cursor 2026.10.01 captures were typed with,
 *  as today's `rulesText` composes it: 17 lines and 1194 characters. Only the first own-rule
 *  line differs from what the captures hold — the lead's name, `orchestrator` now — while the
 *  file's own rules keep the spelling those fixtures keep (17 lines, 1193 characters in the
 *  two fixture READMEs). Its shape is what `team` composes for a seat; no real seat or person
 *  is in it. */
export const SAMPLE_RULES = rulesText(
  {
    orchestrator: 'coordinator',
    rules: [
      'Do not use tools or edit files.',
      'Do not change trust or configuration.',
      'Reply only RULES_RECEIVED, then wait.',
      'Keep every change on a branch; never commit to main.',
      'Open one pull request per change; the coordinator merges it.',
      'Never force-push a shared branch.',
      "Run the project's test command before you push.",
    ],
    signature: {
      commit: 'Agent: Sample Model · implementer',
      pullRequest: '**Agent:** Sample Model · implementer',
      commitPosition: 'trailer',
    },
    workspace: { mode: 'worktree', protected: ['.'], branch: '{kind}/{task}' },
  },
  'message',
);

export type TestIo = Io & { out: string; err: string };

/** The captured Claude Code 2.1.289 idle screen (`test/fixtures/claude-code/2.1.289/idle-suggestion-plain.txt`). */
export const CLAUDE_IDLE = readFileSync(
  new URL('./fixtures/claude-code/2.1.289/idle-suggestion-plain.txt', import.meta.url),
  'utf8',
);

const CLAUDE_COMPOSER_LINES = (() => {
  const lines = CLAUDE_IDLE.split('\n');
  const open = lines.findIndex((line) => line.startsWith('─'));
  if (open < 0) throw new Error('the claude-code idle capture has no opening rule');
  return [lines[open]!, lines[open + 1]!, lines[open + 2]!, ...lines.slice(open + 4)];
})();

/** A Claude Code pane with `text` in its composer: the composer slice of the captured 2.1.289
 *  idle screen, with `text` on its prompt row and continuation rows at the two-column indent the
 *  profile describes, for tests that type text and read the box back. */
export function claudeBox(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  const lines = CLAUDE_COMPOSER_LINES.slice();
  lines[1] = [`❯\u00a0${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
  return lines.join('\n');
}

export type AgyRuleShape = 'close-short' | 'close-long' | 'open-short';

/** The captured Antigravity idle frame with one of its two rules redrawn at another width: the
 *  closing rule one column shorter (52) or longer (54) than the opening, or the opening shortened
 *  instead. The captures draw the box's two rules at one width — 53 columns in idle.txt, 54 in
 *  folded-rules.txt — so a window whose rules differ is not that frame, and the read must fail
 *  closed on it. `text`, when given, sits in the box as the captured continuation rows draw it
 *  (the first line after the prompt, later lines at the content column). */
export function agyMismatchedFrame(shape: AgyRuleShape, text?: string): string {
  const lines = readFileSync(new URL('./fixtures/antigravity/1.2.16/idle.txt', import.meta.url), 'utf8').split('\n');
  const prompt = lines.indexOf('>');
  if (prompt < 0) throw new Error('the idle capture has no bare prompt');
  lines[prompt - 1] = shape === 'open-short' ? '─'.repeat(52) : '─'.repeat(53);
  lines[prompt + 1] = shape === 'close-short' ? '─'.repeat(52) : shape === 'close-long' ? '─'.repeat(54) : '─'.repeat(53);
  if (text !== undefined) {
    const [first = '', ...rest] = text.split('\n');
    lines[prompt] = [`> ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
  }
  return lines.join('\n');
}

/** Greedy word wrap at a content width: as many words as fit on one row, the rest on the next —
 *  how a pane breaks a line wider than its text column. The captured Cursor frame is this wrap of
 *  its sentence at the pane's content width. */
export function wordWrap(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const line of text.split('\n')) {
    let row = '';
    for (const word of line.split(' ')) {
      if (row === '') row = word;
      else if (row.length + 1 + word.length <= width) row += ` ${word}`;
      else { rows.push(row); row = word; }
    }
    rows.push(row);
  }
  return rows;
}

/** § 5's point on a reading in memory: the figure seven points higher, half an hour before the
 *  reading it belongs to moved — `93` where the figure is 100, so the point always stands
 *  distinct from the figure beside it. */
export function withWas(seen: Seen): Seen {
  const left = seen.left === 100 ? 93 : Math.min(100, seen.left + 7);
  return { ...seen, was: { left, at: seen.changedAt - 30 * 60_000 } };
}

/** The same point the way a state file holds it: the reading of § 5's shape, its `at` an ISO
 *  string, as `store` writes it. */
function storedWithWas(reading: StoredReading): StoredReading {
  const left = reading.left === 100 ? 93 : Math.min(100, reading.left + 7);
  return { ...reading, was: { left, at: new Date(Date.parse(reading.changedAt) - 30 * 60_000).toISOString() } };
}

/** § 5's state-file injector: every reading the state holds gains a valid point, through the
 *  state's own door. Returns how many records it touched, so a scenario whose output must not
 *  move can assert the injection actually happened rather than passing over an empty cache. */
export function injectWas(dir: string): number {
  let touched = 0;
  updateState(dir, (state) => {
    const budgets = state.budgets ?? {};
    for (const [key, reading] of Object.entries(budgets)) {
      budgets[key] = storedWithWas(reading);
      touched += 1;
    }
    state.budgets = budgets;
  });
  return touched;
}

export function testIo(cwd: string, caller?: Caller): TestIo {
  const io: TestIo = {
    out: '',
    err: '',
    stdout(text) { io.out += text; },
    stderr(text) { io.err += text; },
    cwd,
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    ...(caller ? { caller } : {}),
  };
  return io;
}

/** The environment for a git command run in a fixture repository: the identity a session
 *  exports is dropped, because git reads GIT_AUTHOR_* and GIT_COMMITTER_* before `-c user.*`
 *  and before the repository's own config — a session that exports them silently overrides
 *  every fixture's identity, and a commit the fixture meant to be signed or exempt is not. */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_COMMITTER_DATE',
    'EMAIL',
  ]) {
    delete env[name];
  }
  return env;
}
