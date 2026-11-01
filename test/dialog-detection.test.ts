// The three dialog kinds every shipped CLI can hold a seat at, read from its own captured
// screens: a question the agent asked, the agent's plan waiting to execute, and a confirmation
// the CLI or the agent raises before acting. Each capture is the pane's own text; the text a
// profile places is the dialog's question, and a screen no profile reads stays no dialog.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { readDialog } from '../src/watch/dialog.ts';
import { questionText, readScreen, screenData } from '../src/watch/screen.ts';

const fixture = (path: string): string => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');

const kindOf = (cli: string, path: string): string => readScreen(cli, fixture(path)).kind;

describe('each CLI’s captured dialogs are their own state', () => {
  test('claude-code: a plan approval and a held message are not permission screens', () => {
    expect(kindOf('claude-code', 'claude-code/2.1.289/permission-plan-wide-plain.txt')).toBe('plan approval');
    expect(kindOf('claude-code', 'claude-code/2.1.289/permission-plan-wide-ansi.txt')).toBe('plan approval');
    expect(kindOf('claude-code', 'claude-code/2.1.302/held.txt')).toBe('confirmation');
    expect(kindOf('claude-code', 'claude-code/2.1.302/question.txt')).toBe('question');
  });

  test('cursor: the mode-switch confirmation and the question box', () => {
    expect(kindOf('cursor', 'cursor/2026.10.01/permission-plan.txt')).toBe('confirmation');
    expect(kindOf('cursor', 'cursor/2026.10.16/question.txt')).toBe('question');
  });

  test('gemini, grok and antigravity: questions and the unsent-comments confirmation', () => {
    expect(kindOf('gemini', 'gemini/0.64.0/question.txt')).toBe('question');
    expect(kindOf('grok', 'grok/1.0.52/question.txt')).toBe('question');
    expect(kindOf('antigravity', 'antigravity/1.4.2/question.txt')).toBe('question');
    expect(kindOf('antigravity', 'antigravity/1.2.16/question-54.txt')).toBe('question');
    expect(kindOf('antigravity', 'antigravity/1.2.16/question-unsent-54.txt')).toBe('confirmation');
  });
});

describe('the question a captured dialog shows', () => {
  test('claude-code reads the sentence above its first choice', () => {
    const screen = fixture('claude-code/2.1.302/question.txt');
    expect(questionText('claude-code', screen)).toBe('Which name do you want to use?');
    expect(questionText('claude-code', fixture('claude-code/2.1.289/question-plain.txt')))
      .toBe('Which filename should I use for the file?');
    expect(questionText('claude-code', screen)).not.toContain('❯');
  });

  test('claude-code’s plan approval is the sentence the agent waits on', () => {
    expect(questionText('claude-code', fixture('claude-code/2.1.289/permission-plan-wide-plain.txt')))
      .toBe('Claude has written up a plan and is ready to execute. Would you like to proceed?');
  });

  test('claude-code’s held message reads its own headline', () => {
    expect(questionText('claude-code', fixture('claude-code/2.1.302/held.txt')))
      .toBe('Held message from another session');
  });

  test('gemini reads the question inside its answer box', () => {
    expect(questionText('gemini', fixture('gemini/0.64.0/question.txt')))
      .toBe('Which profile target should we validate first?');
  });

  test('cursor reads the current question its box is showing', () => {
    expect(questionText('cursor', fixture('cursor/2026.10.16/question.txt'))).toBe('Which option do you want?');
    expect(questionText('cursor', fixture('cursor/2026.10.01/permission-plan.txt'))).toBe('Switch to Plan mode?');
  });

  test('grok reads the question inside its answer frame, whole when the pane wraps it', () => {
    expect(questionText('grok', fixture('grok/1.0.52/question.txt'))).toBe('Which name do you choose?');
    expect(questionText('grok', fixture('grok/1.0.52/permission.txt')))
      .toBe('Approve writing synthetic-note.txt with only the word synthetic?');
  });

  test('antigravity reads the Question row and the unsent-comments sentence', () => {
    expect(questionText('antigravity', fixture('antigravity/1.4.2/question.txt')))
      .toBe('Do you prefer alpha or beta?');
    expect(questionText('antigravity', fixture('antigravity/1.2.16/question-54.txt')))
      .toBe('Which file name would you like to use?');
    expect(questionText('antigravity', fixture('antigravity/1.2.16/question-unsent-54.txt')))
      .toBe('You have unsent comments. Ready to send?');
  });

  test('a dialog with no placed text on an older capture reads null, never a guess', () => {
    expect(questionText('claude-code', fixture('claude-code/2.1.289/question-ansi.txt'))).not.toBeNull();
    expect(questionText('antigravity', fixture('antigravity/1.3.5/question.txt'))).not.toBeNull();
  });

  test('every shipped profile that places a question names the row that ends its block', () => {
    // A question wraps with the pane's width; a spec with no end marker cannot tell a cut from
    // the dialog's own rows below, so it would answer on part of the question.
    const names = ['claude-code', 'codex', 'cursor', 'gemini', 'grok', 'antigravity', 'muse', 'jules'];
    const open: string[] = [];
    for (const name of names) {
      const spec = screenData(name)?.questionText?.question ?? null;
      if (spec !== null && !spec.until) open.push(name);
    }
    expect(open).toEqual([]);
  });
});

describe('one fresh dialog reading on the captures', () => {
  test('each dialog kind reads back with its question', () => {
    expect(readDialog('claude-code', fixture('claude-code/2.1.302/question.txt')))
      .toEqual({ dialog: 'question', text: 'Which name do you want to use?', complete: true });
    expect(readDialog('claude-code', fixture('claude-code/2.1.289/permission-plan-wide-plain.txt')))
      .toEqual({ dialog: 'plan approval', text: 'Claude has written up a plan and is ready to execute. Would you like to proceed?', complete: true });
    expect(readDialog('cursor', fixture('cursor/2026.10.01/permission-plan.txt')))
      .toEqual({ dialog: 'confirmation', text: 'Switch to Plan mode?', complete: true });
  });

  test('a screen that is not a dialog is no reading, for every CLI the team runs', () => {
    const negatives: [string, string][] = [
      ['claude-code', 'claude-code/2.1.302/idle.txt'],
      ['claude-code', 'claude-code/2.1.302/working.txt'],
      ['claude-code', 'claude-code/2.1.302/permission.txt'],
      ['claude-code', 'claude-code/2.1.302/trust.txt'],
      ['claude-code', 'claude-code/2.1.302/exit.txt'],
      ['claude-code', 'claude-code/2.1.302/unsent.txt'],
      ['codex', 'codex/0.161.0/idle.txt'],
      ['codex', 'codex/0.161.0/working.txt'],
      ['codex', 'codex/0.161.0/permission.txt'],
      ['codex', 'codex/0.161.0/trust.txt'],
      ['codex', 'codex/0.161.0/exit.txt'],
      ['codex', 'codex/0.161.0/unsent.txt'],
      ['cursor', 'cursor/2026.10.16/idle.txt'],
      ['cursor', 'cursor/2026.10.16/working.txt'],
      ['cursor', 'cursor/2026.10.16/permission.txt'],
      ['cursor', 'cursor/2026.10.16/trust.txt'],
      ['cursor', 'cursor/2026.10.16/exit.txt'],
      ['cursor', 'cursor/2026.10.16/unsent.txt'],
      ['gemini', 'gemini/0.64.0/idle.txt'],
      ['gemini', 'gemini/0.64.0/working.txt'],
      ['gemini', 'gemini/0.64.0/permission.txt'],
      ['gemini', 'gemini/0.64.0/trust.txt'],
      ['gemini', 'gemini/0.64.0/exit.txt'],
      ['gemini', 'gemini/0.64.0/rate-limit.txt'],
      ['grok', 'grok/1.0.52/idle.txt'],
      ['grok', 'grok/1.0.52/working.txt'],
      ['grok', 'grok/1.0.52/exit.txt'],
      ['antigravity', 'antigravity/1.4.2/idle.txt'],
      ['antigravity', 'antigravity/1.4.2/working.txt'],
      ['antigravity', 'antigravity/1.4.2/permission.txt'],
      ['antigravity', 'antigravity/1.4.2/trust.txt'],
      ['antigravity', 'antigravity/1.4.2/exit.txt'],
      ['antigravity', 'antigravity/1.4.2/unsent.txt'],
      ['muse', 'muse/1.4.9/idle.txt'],
      ['muse', 'muse/1.4.9/working.txt'],
      ['muse', 'muse/1.4.9/permission.txt'],
      ['muse', 'muse/1.4.9/trust.txt'],
      ['muse', 'muse/1.4.9/unsent.txt'],
      ['jules', 'jules/0.1.42/idle.txt'],
      ['jules', 'jules/0.1.42/working.txt'],
      ['jules', 'jules/0.1.42/done.txt'],
    ];
    for (const [cli, path] of negatives) {
      expect(readDialog(cli, fixture(path))).toEqual({ dialog: null });
    }
  });

  test('a transcript quoting the held message above a live composer is not its dialog', () => {
    const quoted = [
      "⏺ the seat was told: don't send while 'Held message from another session' is up",
      '❯ Deny — drop it and tell the sender it was declined',
      '  Deliver this message to Claude',
      '',
      '─'.repeat(53),
      '❯ ',
      '─'.repeat(53),
      '  main · …/acme · Opus 5.5',
    ].join('\n');
    expect(readScreen('claude-code', quoted).kind).not.toBe('confirmation');
    expect(readDialog('claude-code', quoted)).toEqual({ dialog: null });
  });
});
