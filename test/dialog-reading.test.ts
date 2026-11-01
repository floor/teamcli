// The three answerable dialog kinds: their place in the stage order, the question text a profile
// places for them, and the one fresh reading `team answer` takes. A plan approval and a
// confirmation draw the same numbered yes/no row claude-code's permission rule matches, so each
// is read before `permission`; a login screen is read after it, and only ever as a detection.
import { describe, expect, test } from 'bun:test';
import { DIALOG_KINDS, readDialog } from '../src/watch/dialog.ts';
import { classify, questionText } from '../src/watch/screen.ts';
import { loadScreen } from '../src/watch/screen-file.ts';

const profile = (screen: string): string => `
format: 1
cli: sample
screen:
${screen}
  composer:
    mode: box-to-rule
    prompt: '^>'
    rule: '^-{8}'
    placeholders:
      - equals: ''
`;

describe('the dialog kinds in the stage order', () => {
  const ORDERED = profile(`  trust:
    - any: ['^Do you trust this folder\\?$']
  plan_approval:
    - any: ['^Ready to execute\\?$']
  confirmation:
    - any: ['^Unsent comments']
  permission:
    - any: ['^\\s*❯ 1\\. Yes$']
  login:
    - any: ['^Sign in to continue$']`);

  test('the three kinds are the closed answerable list', () => {
    expect([...DIALOG_KINDS]).toEqual(['question', 'plan approval', 'confirmation']);
  });

  test('a plan approval wins over the numbered choice the permission rule also matches', () => {
    const data = loadScreen(ORDERED);
    expect(classify(data, ['Ready to execute?', '❯ 1. Yes']).kind).toBe('plan approval');
    expect(classify(data, ['Something else?', '❯ 1. Yes']).kind).toBe('permission');
  });

  test('a confirmation wins over the same choice', () => {
    const data = loadScreen(ORDERED);
    expect(classify(data, ['Unsent comments', '❯ 1. Yes']).kind).toBe('confirmation');
  });

  test('a trust question still comes first: a trust answer acts on that dialog alone', () => {
    const data = loadScreen(ORDERED);
    expect(classify(data, ['Do you trust this folder?', 'Ready to execute?', '❯ 1. Yes']).kind).toBe('trust');
  });

  test('a login screen is read after permission, so a shipped permission pattern keeps its reading', () => {
    const both = loadScreen(profile(`  permission:
    - any: ['^Sign in']
  login:
    - any: ['^Sign in to continue$']`));
    expect(classify(both, ['Sign in to continue']).kind).toBe('permission');
    const login = loadScreen(profile(`  login:
    - any: ['^Sign in to continue$']`));
    expect(classify(login, ['Sign in to continue']).kind).toBe('login');
  });
});

describe('the question text a profile places', () => {
  const data = loadScreen(
    profile(`  question:
    - any: ['^Which name']
  plan_approval:
    - any: ['^Ready to execute\\?$']
  confirmation:
    - any: ['^Unsent comments']
  question_text:
    any:
      after: '^Which name'
      rows: 2
    question:
      after: '^Which name'
      rows: 2
      strip: ['^> ']
    plan_approval:
      inline: '^Ready to execute\\?$'`),
  );

  test('rows below the anchor are joined, and a blank row ends the walk', () => {
    expect(questionText(data, 'Which name do you want to use?\nsynthetic-note.txt\n')).toBe('synthetic-note.txt');
    expect(questionText(data, 'Which name do you want to use?\nsynthetic-note.txt\n\nnot this one\n')).toBe('synthetic-note.txt');
  });

  test('a kind entry beats any, and its strips apply to the taken rows', () => {
    expect(questionText(data, 'Which name do you want to use?\n> synthetic-note.txt\n')).toBe('synthetic-note.txt');
  });

  test('an inline spec takes the matched row itself', () => {
    expect(questionText(data, 'Ready to execute?\n')).toBe('Ready to execute?');
  });

  test('a kind is read with any when it has no entry of its own', () => {
    const fallback = loadScreen(
      profile(`  confirmation:
    - any: ['^Unsent comments']
  question_text:
    any:
      after: '^Unsent comments'
      rows: 1`),
    );
    expect(questionText(fallback, 'Unsent comments\n> synthetic-note.txt\n')).toBe('> synthetic-note.txt');
  });

  test('null when the anchor is not on the screen, or when the strips empty every row', () => {
    expect(questionText(data, 'nothing here\n')).toBeNull();
    const stripped = loadScreen(
      profile(`  question:
    - any: ['^Which name']
  question_text:
    question:
      after: '^Which name'
      strip: ['^.*$']`),
    );
    expect(questionText(stripped, 'Which name\nsynthetic-note.txt\n')).toBeNull();
  });

  test('null for a kind no question text belongs to', () => {
    expect(questionText(data, 'Just a screen\n❯ \n')).toBeNull();
  });

  test('the reader takes the same window the classifier reads', () => {
    const lines = ['Which name do you want to use?', 'synthetic-note.txt', ...Array.from({ length: 40 }, (_, at) => `row ${at}`)];
    expect(questionText(data, lines.join('\n'))).toBeNull();
  });
});

describe('one fresh dialog reading', () => {
  const data = loadScreen(
    profile(`  question:
    - any: ['^Which name']
  question_text:
    question:
      after: '^Which name'
      strip: ['^> ']`),
  );

  test('a dialog kind and its text', () => {
    expect(readDialog(data, 'Which name do you want to use?\n> synthetic-note.txt\n')).toEqual({ dialog: 'question', text: 'synthetic-note.txt' });
  });

  test('no dialog is no reading', () => {
    expect(readDialog(data, 'Just a screen\n> \n')).toEqual({ dialog: null });
  });

  test('an answerable kind whose text cannot be read is refused, never half read', () => {
    const unplaced = loadScreen(profile(`  question:
    - any: ['^Which name']`));
    expect(readDialog(unplaced, 'Which name do you want to use?\n')).toEqual({ dialog: null });
    expect(readDialog(data, 'Which name do you want to use?\n')).toEqual({ dialog: null });
  });

  test('a CLI with no shipped screen has no reading', () => {
    expect(readDialog('no-such-cli', 'Which name\n')).toEqual({ dialog: null });
  });
});
