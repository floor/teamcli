// Independent capture replay through the shipped profiles, screen reader and periodic pass.
// No reader override, terminal pane or human dialog. The before-anchor probe loads synthetic profile data.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { profileFor } from '../src/profiles/profile.ts';
import { versionMatches } from '../src/profiles/trust-answer.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { EVENT_THRESHOLDS } from '../src/policy/events.ts';
import { emptySession } from '../src/state.ts';
import { newMemory, pass, type Memory } from '../src/watch/pass.ts';
import { readScreen } from '../src/watch/screen.ts';
import { readDialog } from '../src/watch/dialog.ts';
import { loadScreen } from '../src/watch/screen-file.ts';

type Kind = 'question' | 'plan approval' | 'confirmation';
type AnswerRecord = { kind: Kind; key: string; from: string; to: string };
const answerPath = new URL('../src/profiles/question-answer.ts', import.meta.url);
// The parent lacks this module entirely. Absence is an unavailable capability, so positive
// capture cases fail there without replacing either the shipped reader or its profile data.
const answerApi = existsSync(answerPath)
  ? await import(answerPath.href) as { questionAnswerFor(records: readonly AnswerRecord[], kind: string, printed: string): AnswerRecord | null }
  : null;
function keyFor(cli: string, kind: string, printed: string): string | null {
  const profile = profileFor(cli) as (ReturnType<typeof profileFor> & { questionAnswers?: readonly AnswerRecord[] });
  return answerApi?.questionAnswerFor(profile?.questionAnswers ?? [], kind, printed)?.key ?? null;
}
function capture(path: string): string {
  return readFileSync(new URL('./fixtures/' + path, import.meta.url), 'utf8');
}
type Case = { cli: string; printed: string; path: string; kind: Kind; key: string | null };
// The older Claude, Cursor and Antigravity folders save no version print; their READMEs
// explain why a measured dismissal alone supplies no answer record. Classification still applies.
const cases: Case[] = [
  ...['plan-approval.txt', 'plan-approval-ansi.txt'].map(name => ({ cli: 'codex', printed: 'codex-cli 0.161.0', path: 'codex/0.161.0/' + name, kind: 'plan approval' as const, key: 'escape' })),
  ...['question.txt', 'question-ansi.txt'].map(name => ({ cli: 'codex', printed: 'codex-cli 0.161.0', path: 'codex/0.161.0/' + name, kind: 'question' as const, key: 'escape' })),
  ...['permission-plan-wide-plain.txt', 'permission-plan-wide-ansi.txt'].map(name => ({ cli: 'claude-code', printed: '2.1.289 (Claude Code)', path: 'claude-code/2.1.289/' + name, kind: 'plan approval' as const, key: null })),
  ...['question-plain.txt', 'question-ansi.txt', 'question-wide-plain.txt', 'question-wide-ansi.txt'].map(name => ({ cli: 'claude-code', printed: '2.1.289 (Claude Code)', path: 'claude-code/2.1.289/' + name, kind: 'question' as const, key: null })),
  { cli: 'claude-code', printed: '2.1.299 (Claude Code)', path: 'claude-code/2.1.299/question.txt', kind: 'question', key: 'escape' },
  { cli: 'claude-code', printed: '2.1.302 (Claude Code)', path: 'claude-code/2.1.302/question.txt', kind: 'question', key: 'escape' },
  { cli: 'cursor', printed: '2026.10.01-14929f9', path: 'cursor/2026.10.01/question.txt', kind: 'question', key: null },
  { cli: 'cursor', printed: '2026.10.01-14929f9', path: 'cursor/2026.10.01/permission-plan.txt', kind: 'confirmation', key: null },
  { cli: 'cursor', printed: '2026.10.14-0f9edde', path: 'cursor/2026.10.14/question.txt', kind: 'question', key: 'escape' },
  { cli: 'cursor', printed: '2026.10.16-e3cb207', path: 'cursor/2026.10.16/question.txt', kind: 'question', key: 'escape' },
  { cli: 'antigravity', printed: '1.2.16', path: 'antigravity/1.2.16/question-54.txt', kind: 'question', key: null },
  // This capture records the dialog but no measured dismiss key; classification grants none.
  { cli: 'antigravity', printed: '1.2.16', path: 'antigravity/1.2.16/question-unsent-54.txt', kind: 'confirmation', key: null },
  ...['1.3.5', '1.4.0', '1.4.1', '1.4.2'].map(version => ({ cli: 'antigravity', printed: version, path: 'antigravity/' + version + '/question.txt', kind: 'question' as const, key: 'escape' })),
  { cli: 'gemini', printed: '0.64.0', path: 'gemini/0.64.0/question.txt', kind: 'question', key: 'escape' },
  { cli: 'grok', printed: '1.0.52', path: 'grok/1.0.52/question.txt', kind: 'question', key: null },
];

for (const scene of cases) {
  test('the capture has its own kind and measured dismiss key: ' + scene.path, () => {
    expect(readScreen(scene.cli, capture(scene.path)).kind).toBe(scene.kind);
    expect(keyFor(scene.cli, scene.kind, scene.printed)).toBe(scene.key);
    const oneCharacterOff = scene.printed.slice(0, -1) + 'X';
    expect(keyFor(scene.cli, scene.kind, oneCharacterOff)).toBeNull();
    const numericCharacterOff = scene.printed.replace(/(\d+\.\d+\.)(\d+)/, (_match, prefix: string, patch: string) =>
      prefix + patch.slice(0, -1) + (patch.endsWith('9') ? '8' : '9'));
    expect(numericCharacterOff).not.toBe(scene.printed);
    expect(keyFor(scene.cli, scene.kind, numericCharacterOff)).toBeNull();
  });
}

for (const scene of [cases[0]!, cases[4]!, cases[12]!]) {
  test('a decorated printed version is not normalized to a bare version: ' + scene.cli, () => {
    const bare = scene.printed.match(/\d+(?:\.\d+)+/)![0];
    expect(keyFor(scene.cli, scene.kind, bare)).toBeNull();
    expect(keyFor(scene.cli, scene.kind, ' ' + scene.printed)).toBeNull();
    expect(keyFor(scene.cli, scene.kind, scene.printed + ' ')).toBeNull();
  });
}

test('an uncaptured numeric version does not gain an Antigravity question key', () => {
  expect(keyFor('antigravity', 'question', '1.2.17')).toBeNull();
});

test('a trust capture without a measured approval key or printed version grants no answer', () => {
  // The original Codex capture notes record Escape, and no --version print at 0.157.0.
  // A visible trust layout alone cannot supply an answered key or invent that print.
  const records = profileFor('codex')!.answers;
  expect(records).toEqual([]);
  for (const printed of ['codex-cli 0.157.0', '0.157.0', 'codex-cli 0.157.X']) {
    expect(records.find(record => versionMatches(record, printed))).toBeUndefined();
  }
  // These trust layouts were also left with Escape, without a measured approval key.
  for (const [cli, printed] of [['cursor', '2026.10.01-14929f9'], ['antigravity', '1.2.16']] as const) {
    expect(profileFor(cli)!.answers.find(record => versionMatches(record, printed))).toBeUndefined();
  }
});

const AT = Date.parse('2026-11-01T15:00:00Z');
const WINDOW = 300_000;
function teamFor(cli: string) {
  const loaded = validateTeamFile(`format: 1
project: dialog-scenes
session: dialog-scenes
operator: lead
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    leads: true
    cli: ${cli}
    vendor: Example
    model: Example
    version: "1"
    launch: fixture
  - role: worker
    name: waiter
    cli: ${cli}
    vendor: Example
    model: Example
    version: "1"
    launch: fixture
`);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return loaded.team;
}
function cycle(cli: string, text: string, memory: Memory, now: number) {
  const team = teamFor(cli);
  const state = emptySession();
  state.seats.waiter = { stage: 'ready', pane: 'fixture-dialog', workspace: 'fixture-dialog-workspace', last_active: new Date(AT).toISOString() };
  return pass({
    team, state, memory, now, watch: team.watch, approval: [], queueDepths: { worker: 5 },
    live: { running: true,
      agents: [{ name: 'waiter', agent: cli === 'claude-code' ? 'claude' : cli, pane: 'fixture-dialog', workspace: 'fixture-dialog-workspace', status: 'idle', cwd: null }],
      workspaces: [{ id: 'fixture-dialog-workspace', label: 'waiter' }], screens: { 'fixture-dialog': text },
    },
    machine: { loadPerCore: 0.1, memoryFree: 75, diskFree: 100e9, swapTotal: 0, swapFree: 0, swapUsed: 0 },
  });
}
function escalations(result: ReturnType<typeof cycle>) {
  return result.reports.filter(report => report.key === 'prompt-escalated:waiter');
}
const representative: Record<Kind, Case> = {
  question: cases[2]!, 'plan approval': cases[0]!, confirmation: cases[13]!,
};
test('the released prompt-escalation window is five minutes', () => {
  expect(EVENT_THRESHOLDS.prompt_escalation_seconds * 1000).toBe(WINDOW);
});
for (const kind of ['question', 'plan approval', 'confirmation'] as const) {
  const scene = representative[kind];
  test('the real periodic pass escalates a captured ' + kind + ' at its window, once', () => {
    const text = capture(scene.path);
    const memory = newMemory();
    expect(escalations(cycle(scene.cli, text, memory, AT))).toEqual([]);
    expect(escalations(cycle(scene.cli, text, memory, AT + WINDOW - 1))).toEqual([]);
    const due = cycle(scene.cli, text, memory, AT + WINDOW);
    expect(escalations(due)).toHaveLength(1);
    expect(escalations(due)[0]!.text).toContain(kind + ' prompt');
    expect(escalations(due)[0]!.to).toBe('owner');
    expect(due.work).toEqual([]);
    expect(due.ring).toBeNull();
    expect(escalations(cycle(scene.cli, text, memory, AT + WINDOW * 2))).toEqual([]);
  });
}

// All three kinds are available in Codex/Cursor captures. Same-kind and kind-change clocks
// use one seat and one shipped CLI per scene; only the pane's actual capture changes.
const codexQuestion = capture('codex/0.161.0/question.txt');
const codexPlan = capture('codex/0.161.0/plan-approval.txt');
for (const [before, after] of [[codexQuestion, codexPlan], [codexPlan, codexQuestion]] as const) {
  test('changing the captured Codex prompt kind starts a new full escalation window: ' + readScreen('codex', before).kind, () => {
    const memory = newMemory();
    expect(escalations(cycle('codex', before, memory, AT))).toEqual([]);
    expect(escalations(cycle('codex', before, memory, AT + WINDOW - 1))).toEqual([]);
    expect(escalations(cycle('codex', after, memory, AT + WINDOW - 1))).toEqual([]);
    expect(escalations(cycle('codex', after, memory, AT + WINDOW * 2 - 2))).toEqual([]);
    expect(escalations(cycle('codex', after, memory, AT + WINDOW * 2 - 1))).toHaveLength(1);
  });
}
for (const [beforePath, afterPath] of [
  ['cursor/2026.10.01/question.txt', 'cursor/2026.10.01/permission-plan.txt'],
  ['cursor/2026.10.01/permission-plan.txt', 'cursor/2026.10.01/question.txt'],
] as const) {
  test('a Cursor kind change resets its clock: ' + beforePath, () => {
    const memory = newMemory();
    cycle('cursor', capture(beforePath), memory, AT);
    cycle('cursor', capture(afterPath), memory, AT + WINDOW - 1);
    expect(escalations(cycle('cursor', capture(afterPath), memory, AT + WINDOW * 2 - 2))).toEqual([]);
    expect(escalations(cycle('cursor', capture(afterPath), memory, AT + WINDOW * 2 - 1))).toHaveLength(1);
  });
}

const protectedCaptures = [
  ['codex', 'codex-cli 0.161.0', 'codex/0.161.0/permission.txt'],
  ['codex', 'codex-cli 0.157.0', 'codex/0.157.0/permission.txt'],
  ['claude-code', '2.1.289 (Claude Code)', 'claude-code/2.1.289/permission-create-plain.txt'],
  ['claude-code', '2.1.289 (Claude Code)', 'claude-code/2.1.289/permission-read-wide-ansi.txt'],
  ['claude-code', '2.1.302 (Claude Code)', 'claude-code/2.1.302/permission.txt'],
  ['cursor', '2026.10.14-0f9edde', 'cursor/2026.10.14/permission.txt'],
  ['cursor', '2026.10.16-e3cb207', 'cursor/2026.10.16/permission.txt'],
  ['antigravity', '1.2.16', 'antigravity/1.2.16/permission-command-54.txt'],
  ['antigravity', '1.2.16', 'antigravity/1.2.16/permission-write-54.txt'],
  ['antigravity', '1.2.16', 'antigravity/1.2.16/permission-edit-54.txt'],
  ['antigravity', '1.4.2', 'antigravity/1.4.2/permission.txt'],
  ['gemini', '0.64.0', 'gemini/0.64.0/permission.txt'],
  ['grok', '1.0.52', 'grok/1.0.52/permission.txt'],
] as const;
for (const [cli, printed, path] of protectedCaptures) {
  test('a captured permission or command approval grants no automatic answer: ' + path, () => {
    const text = capture(path);
    const reading = readScreen(cli, text);
    // Grok draws the same question widget for a choice and a command approval. Its profile
    // has no measured answer key, so that capture still grants no automatic dismissal.
    expect(reading.kind).toBe(cli === 'grok' ? 'question' : 'permission');
    expect(keyFor(cli, reading.kind, printed)).toBeNull();
    const memory = newMemory();
    cycle(cli, text, memory, AT);
    const later = cycle(cli, text, memory, AT + WINDOW * 2);
    expect(later.work).toEqual([]);
    expect(later.ring).toBeNull();
  });
}

for (const cli of ['codex', 'claude-code', 'gemini']) {
  test('login wording never grants an automatic answer or work nudge: ' + cli, () => {
    // Constructed refusal control, not represented as a capture or an affirmative reading.
    const text = 'Sign in to continue\nChoose a login method\n1. Sign in with your account\n2. Use an API key\n';
    const reading = readScreen(cli, text);
    expect(['question', 'plan approval', 'confirmation']).not.toContain(reading.kind);
    expect(keyFor(cli, reading.kind, 'unknown version')).toBeNull();
    const memory = newMemory();
    cycle(cli, text, memory, AT);
    expect(cycle(cli, text, memory, AT + WINDOW * 2).work).toEqual([]);
  });
}


test('reader delta: a capped current block wins over an older whole question', () => {
  const rows = Array.from({ length: 7 }, (_, index) => 'Current visible row ' + (index + 1));
  const screen = ['Question 1/1 (1 unanswered)', 'Earlier transcript question?', '1. earlier option', '',
    'Question 1/1 (1 unanswered)', ...rows, '› 1. current option', 'esc to interrupt', ''].join('\n');
  expect(readDialog('codex', screen)).toEqual({ dialog: 'question', text: rows.slice(0, 6).join(' '), complete: false });
  // A changed live row must change the incomplete reading rather than reuse transcript text.
  expect(readDialog('codex', screen.replace('Current visible row 3', 'Changed visible row three'))).toEqual({
    dialog: 'question', text: rows.slice(0, 6).map(row => row === rows[2] ? 'Changed visible row three' : row).join(' '), complete: false,
  });
});

test('reader delta: a before anchor preserves the visible question row order', () => {
  // No shipped profile uses before; synthetic data exercises the real reader's supported shape.
  const data = loadScreen(`format: 1
cli: sample
screen:
  question:
    - any: ['^ANSWER$']
  question_text:
    question:
      before: '^ANSWER$'
      until: '^START$'
      rows: 2
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`);
  expect(readDialog(data, 'START\nFirst visible question row\nSecond visible question row\nANSWER\n')).toEqual({
    dialog: 'question', text: 'First visible question row Second visible question row', complete: true,
  });
  expect(readDialog(data, 'START\nChanged first row\nSecond visible question row\nANSWER\n')).toEqual({
    dialog: 'question', text: 'Changed first row Second visible question row', complete: true,
  });
});


for (const changed of [false, true]) {
  test('window delta: Codex current window cut, changed=' + changed, () => {
    const header = 'Question 1/1 (1 unanswered)';
    const current = changed ? 'Changed current partial question?' : 'Current partial question under review?';
    const old = [header, 'Previous question already answered?', '1. previous choice', '', header, current];
    // Both screens retain the actual question stage's footer; only the live option row is cut.
    const whole = [...old, '› 1. current choice', 'esc to interrupt', ''].join('\n');
    expect(readDialog('codex', whole)).toEqual({ dialog: 'question', text: current, complete: true });
    const cut = [...old, 'esc to interrupt', ''].join('\n');
    expect(readDialog('codex', cut)).toEqual({ dialog: 'question', text: current + ' esc to interrupt', complete: false });
  });
  test('window delta: captured Grok frame opens the current window cut, changed=' + changed, () => {
    const current = changed ? 'Changed current choice question?' : 'Which name do you choose?';
    const captured = capture('grok/1.0.52/question.txt').replace('Which name do you choose?', current);
    const marker = '\n  ┃\n  ┃  ' + current;
    expect(captured).toContain(marker);
    const withOld = captured.replace(marker, ['','  ┃','  ┃  Previous question already answered?',
      '  ┃  1 (○) previous  Previously chosen answer.', '  ┃', '  ┃  ' + current].join('\n'));
    expect(readDialog('grok', withOld)).toEqual({ dialog: 'question', text: current, complete: true });
    const cut = withOld.split('\n').filter(row => !row.includes('1 (○) alpha') && !row.includes('z (○) Type your answer')).join('\n');
    expect(readDialog('grok', cut)).toEqual({ dialog: 'question', text: current, complete: false });
  });
  test('window delta: a chrome-only question widget has no dialog text, changed=' + changed, () => {
    const chrome = ['Waiting on answers' + (changed ? ' for another item' : ''), '  ┃',
      '  ┃ ↑/↓ navigate · y copy' + (changed ? '       ' : ' ') + 'Enter:submit', 'Tab:next answer', ''].join('\n');
    expect(readScreen('grok', chrome).kind).toBe('question');
    expect(readDialog('grok', chrome)).toEqual({ dialog: null });
  });
}
