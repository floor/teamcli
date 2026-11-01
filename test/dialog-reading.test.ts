// The three answerable dialog kinds: their place in the stage order, the question text a profile
// places for them, and the one fresh reading `team answer` takes. A plan approval and a
// confirmation draw the same numbered yes/no row claude-code's permission rule matches, so each
// is read before `permission`; a login screen is read after it, and only ever as a detection.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DIALOG_KINDS, readDialog } from '../src/watch/dialog.ts';
import { classify, questionText, questionTextReading } from '../src/watch/screen.ts';
import { loadScreen } from '../src/watch/screen-file.ts';

const fixture = (path: string): string => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');

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

describe('a question block read to its end', () => {
  const data = loadScreen(
    profile(`  question:
    - any: ['^Question 1/1']
  question_text:
    question:
      after: '^Question [0-9]+/[0-9]+'
      until: '^[0-9]+\\. '
      rows: 2`),
  );

  test('a question the pane wraps is read whole, and two captures differing only in the wrapped row read differently', () => {
    const one = 'Question 1/1\nWhich name do you\nwant to use?\n1. alpha\n2. beta\n';
    const two = 'Question 1/1\nWhich name do you\nwant to reuse?\n1. alpha\n2. beta\n';
    expect(questionTextReading(data, one)).toEqual({ text: 'Which name do you want to use?', complete: true });
    expect(questionTextReading(data, two)).toEqual({ text: 'Which name do you want to reuse?', complete: true });
  });

  test('the row that ends the block is never part of the text', () => {
    expect(questionTextReading(data, 'Question 1/1\nWhich name?\n1. alpha\n'))
      .toEqual({ text: 'Which name?', complete: true });
  });

  test('a block still going when the supported rows run out reads cut, never part of the question', () => {
    const screen = 'Question 1/1\nWhich name do you\nwant to use\nfor the seat\n1. alpha\n';
    expect(questionTextReading(data, screen)).toEqual({ text: 'Which name do you want to use', complete: false });
    expect(readDialog(data, screen)).toEqual({ dialog: 'question', text: 'Which name do you want to use', complete: false });
  });

  test('a profile that names no end marker declares no end, so it never reports a cut', () => {
    const open = loadScreen(
      profile(`  question:
    - any: ['^Which name']
  question_text:
    question:
      after: '^Which name'
      rows: 1`),
    );
    expect(questionTextReading(open, 'Which name\nfirst row\nsecond row\n'))
      .toEqual({ text: 'first row', complete: true });
  });
});

// A `before` anchor sits at the block's last row and the walk climbs the pane to the end marker
// above it. The text keeps the pane's order — the row higher on the pane reads first — because the
// rows are what the agent drew, and joining them in walk order would reverse the question.
describe('a before anchor reads the rows above it in the pane’s order', () => {
  const data = loadScreen(
    profile(`  question:
    - any: ['^ANSWER$']
  question_text:
    question:
      before: '^ANSWER$'
      until: '^START$'
      rows: 2`),
  );

  test('two rows above the anchor read in the order the pane draws them', () => {
    expect(readDialog(data, 'START\nFirst question row\nSecond question row\nANSWER\n'))
      .toEqual({ dialog: 'question', text: 'First question row Second question row', complete: true });
    expect(readDialog(data, 'START\nChanged question row\nSecond question row\nANSWER\n'))
      .toEqual({ dialog: 'question', text: 'Changed question row Second question row', complete: true });
  });
});

// The pane draws the live dialog at its bottom; the transcript above it may quote an older
// question with the same header. The reader anchors on the live block — the anchor nearest the
// bottom whose block reaches the profile's end marker — so the copy above it never wins.
describe('the live dialog’s anchor, not a transcript copy above it', () => {
  test('operator-3’s probe: codex reads the live question, never the older block above it', () => {
    const current = fixture('codex/0.161.0/question.txt');
    // The three blank transcript rows above the live dialog hold an older header, question and
    // option; the live dialog and its own footer stay exactly as captured.
    const retained = current.replace('\n\n\n\n', '\nQuestion 1/1 (1 unanswered)\nOld question from the transcript?\n1. Previous choice\n');
    expect(readDialog('codex', current))
      .toEqual({ dialog: 'question', text: 'What should the new README line say?', complete: true });
    expect(readDialog('codex', retained))
      .toEqual({ dialog: 'question', text: 'What should the new README line say?', complete: true });
    // Changing only the live question changes the reading: the stale block never wins.
    expect(readDialog('codex', retained.replace('What should the new README line say?', 'Which live question changed?')))
      .toEqual({ dialog: 'question', text: 'Which live question changed?', complete: true });
  });

  // The live block is cut by the supported rows before it reaches its own option row. The copy a
  // transcript quoted above it is whole; a whole block above a cut live block never certifies the
  // current question, and the reading stays the live block's own visible text, cut.
  test('operator-3’s cut probe: a live block cut past the row cap reads cut, never the whole copy above it', () => {
    const clipped = [
      'Question 1/1 (1 unanswered)',
      'Old transcript question?',
      '1. old option',
      '',
      'Question 1/1 (1 unanswered)',
      'Current row one',
      'Current row two',
      'Current row three',
      'Current row four',
      'Current row five',
      'Current row six',
      'Current row seven',
      '› 1. new option',
      'esc to interrupt',
      '',
    ].join('\n');
    expect(readDialog('codex', clipped)).toEqual({
      dialog: 'question',
      text: 'Current row one Current row two Current row three Current row four Current row five Current row six',
      complete: false,
    });
  });

  type StaleScene = { cli: string; path: string; withStale: (captured: string) => string; live: string };
  const scenes: StaleScene[] = [
    {
      cli: 'cursor',
      path: 'cursor/2026.10.01/question.txt',
      live: 'Which name should be used for the file?',
      // The live question box stays where it is; a copy of the box, asking an older question,
      // fills the blank transcript rows above it.
      withStale: (captured) => captured.replace('\n\n\n ┌', [
        '',
        ' ┌─────────────────────────────────────────────────┐',
        ' │ Question 1 of 1                                 │',
        ' │ Old question from the transcript?               │',
        ' │                                                 │',
        ' │   › [ ] stale.txt                               │',
        ' └─────────────────────────────────────────────────┘',
        ' ┌',
      ].join('\n')),
    },
    {
      cli: 'claude-code',
      path: 'claude-code/2.1.302/question.txt',
      live: 'Which name do you want to use?',
      // A stale block with the same `☐` header and a numbered option, drawn just above the live
      // block's own [`☐ Name`] row.
      withStale: (captured) => captured.replace('\n ☐ Name \n', [
        '',
        ' ☐ Name ',
        '',
        'Old question from the transcript?',
        '',
        '❯ 1. previous',
        ' ☐ Name ',
        '',
      ].join('\n')),
    },
    {
      cli: 'gemini',
      path: 'gemini/0.64.0/question.txt',
      live: 'Which profile target should we validate first?',
      // A stale answer box with its own `Answer Questions` header and option, directly above the
      // live box's opening rule.
      withStale: (captured) => captured.replace('\n╭───────────────────────────────────────────────────╮\n│ Answer Questions', [
        '',
        '╭───────────────────────────────────────────────────╮',
        '│ Answer Questions                                  │',
        '│                                                   │',
        '│ Old question from the transcript?                 │',
        '│                                                   │',
        '│ ● 1.  stale                                       │',
        '╰───────────────────────────────────────────────────╯',
        '╭───────────────────────────────────────────────────╮',
        '│ Answer Questions',
      ].join('\n')),
    },
    {
      cli: 'grok',
      path: 'grok/1.0.52/question.txt',
      live: 'Which name do you choose?',
      // A stale framed question above the live frame's own first row: the frame row `┃` is the
      // anchor, and the copy carries its own option row.
      withStale: (captured) => captured.replace('\n  ┃\n  ┃  Which name do you choose?', [
        '',
        '  ┃',
        '  ┃  Old question from the transcript?',
        '  ┃',
        '  ┃  1 (○) stale  Use the stale one.',
        '  ┃',
        '  ┃  Which name do you choose?',
      ].join('\n')),
    },
    {
      cli: 'antigravity',
      path: 'antigravity/1.4.2/question.txt',
      live: 'Do you prefer alpha or beta?',
      // An older `Question 1/1:` row with its own option, just above the live inline row.
      withStale: (captured) => captured.replace('\nQuestion 1/1: Do you prefer alpha or beta?', [
        '',
        'Question 1/1: Old question from the transcript?',
        '',
        '> 1. old',
        'Question 1/1: Do you prefer alpha or beta?',
      ].join('\n')),
    },
  ];

  for (const scene of scenes) {
    test(`${scene.cli}: the live block nearer the bottom wins`, () => {
      const captured = fixture(scene.path);
      expect(readDialog(scene.cli, captured))
        .toEqual({ dialog: 'question', text: scene.live, complete: true });
      expect(readDialog(scene.cli, scene.withStale(captured)))
        .toEqual({ dialog: 'question', text: scene.live, complete: true });
    });
  }
});

// A blank row inside a question box is part of the block: the pane wraps with its width, and a
// paragraph below the blank belongs to the question. Only the profile's end marker proves the
// block ended, so the walk passes blanks inside it and reads on to the marker.
describe('an interior blank row is inside the block, not its end', () => {
  type Scene = {
    cli: string;
    path: string;
    withParagraphs: (captured: string, second: string) => string;
    text: (second: string) => string;
  };
  const scenes: Scene[] = [
    {
      cli: 'codex',
      path: 'codex/0.161.0/question.txt',
      text: (second) => `What should the new README line say? Use the first package. Use the ${second} package.`,
      withParagraphs: (captured, second) => captured.replace(
        '  What should the new README line say?\n',
        `  What should the new README line say?\n  Use the first package.\n\n  Use the ${second} package.\n`,
      ),
    },
    {
      cli: 'cursor',
      path: 'cursor/2026.10.01/question.txt',
      text: (second) => `Which name should be used for the file? Use the first package. Use the ${second} package.`,
      withParagraphs: (captured, second) => captured.replace(
        '│ 1. Which name should be used for the file?      │',
        [
          '│ 1. Which name should be used for the file?      │',
          ' │ Use the first package.                          │',
          ' │                                                 │',
          ` │ Use the ${second} package.                       │`,
        ].join('\n'),
      ),
    },
    {
      cli: 'claude-code',
      path: 'claude-code/2.1.302/question.txt',
      text: (second) => `Which name do you want to use? Use the first package. Use the ${second} package.`,
      withParagraphs: (captured, second) => captured.replace(
        'Which name do you want to use?\n',
        `Which name do you want to use?\nUse the first package.\n\nUse the ${second} package.\n`,
      ),
    },
    {
      cli: 'gemini',
      path: 'gemini/0.64.0/question.txt',
      text: (second) => `Which profile target should we validate first? Use the first package. Use the ${second} package.`,
      withParagraphs: (captured, second) => captured.replace(
        '│ Which profile target should we validate first?    │',
        [
          '│ Which profile target should we validate first?    │',
          '│ Use the first package.                            │',
          '│                                                   │',
          `│ Use the ${second} package.                        │`,
        ].join('\n'),
      ),
    },
    {
      cli: 'grok',
      path: 'grok/1.0.52/question.txt',
      text: (second) => `Which name do you choose? Use the first package. Use the ${second} package.`,
      withParagraphs: (captured, second) => captured.replace(
        '  ┃  Which name do you choose?\n',
        `  ┃  Which name do you choose?\n  ┃  Use the first package.\n  ┃\n  ┃  Use the ${second} package.\n`,
      ),
    },
    {
      cli: 'antigravity',
      path: 'antigravity/1.4.2/question.txt',
      text: (second) => `Do you prefer alpha or beta? Use the first package. Use the ${second} package.`,
      withParagraphs: (captured, second) => captured.replace(
        'Question 1/1: Do you prefer alpha or beta?\n',
        `Question 1/1: Do you prefer alpha or beta?\nUse the first package.\n\nUse the ${second} package.\n`,
      ),
    },
  ];

  for (const scene of scenes) {
    test(`${scene.cli}: the paragraph after the interior blank row is read`, () => {
      const captured = fixture(scene.path);
      const first = readDialog(scene.cli, scene.withParagraphs(captured, 'first'));
      const other = readDialog(scene.cli, scene.withParagraphs(captured, 'other'));
      expect(first).toEqual({ dialog: 'question', text: scene.text('first'), complete: true });
      expect(other).toEqual({ dialog: 'question', text: scene.text('other'), complete: true });
      expect(other).not.toEqual(first);
    });
  }

  test('a block whose end marker is not on the screen reads incomplete, never complete', () => {
    const data = loadScreen(
      profile(`  question:
    - any: ['^Question 1/1']
  question_text:
    question:
      after: '^Question [0-9]+/[0-9]+'
      until: '^[0-9]+\\. '
      rows: 2`),
    );
    expect(questionTextReading(data, 'Question 1/1\nWhich name?\n'))
      .toEqual({ text: 'Which name?', complete: false });
  });
});

describe('one fresh dialog reading', () => {  const data = loadScreen(
    profile(`  question:
    - any: ['^Which name']
  question_text:
    question:
      after: '^Which name'
      strip: ['^> ']`),
  );

  test('a dialog kind and its text', () => {
    expect(readDialog(data, 'Which name do you want to use?\n> synthetic-note.txt\n')).toEqual({ dialog: 'question', text: 'synthetic-note.txt', complete: true });
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

describe('the lowest anchored block is live, however its walk stopped', () => {
  // Operator-3's probe at 805604e8a: a whole question quoted above, and the live question below
  // it cut at the window's edge. The whole block above certified the old text as complete while
  // a block with text stood below it, and changing only the live question changed nothing. The
  // lowest block with any text is the live one however its walk stopped — marker, row cap or
  // window — and its own end is its completeness, so a window cut reads complete: false.
  const header = 'Question 1/1 (1 unanswered)';
  const old = `${header}\nOld transcript question?\n1. old option\n\n`;
  const live = (question: string): string => `${header}\n${question}\nesc to interrupt\n`;

  test('the live window-cut block is the reading, not the whole block quoted above it', () => {
    expect(readDialog('codex', old + live('Current partial question?')))
      .toEqual({ dialog: 'question', text: 'Current partial question? esc to interrupt', complete: false });
  });

  test('changing only the live question changes the reading', () => {
    expect(readDialog('codex', old + live('Changed partial question?')))
      .toEqual({ dialog: 'question', text: 'Changed partial question? esc to interrupt', complete: false });
  });

  test('a pane whose only dialog text is its working chrome is not a question', () => {
    expect(readDialog('codex', live('Current partial question?'))).toEqual({ dialog: null });
  });
});

describe('a frame-anchored question is read by its content, not its anchor row', () => {
  // Operator-3's fixture-derived probe at 98dc7b9dc: every supported Grok question anchor is a
  // bare `┃` frame row, so testing the anchor row discarded every genuine Grok window-cut
  // question. With a stale whole block above and the live option rows removed, the reader
  // returned "Old transcript question?" complete:true for the live question and for its changed
  // twin. The walk now ends at the widget's own chrome rows, and a widget that shows only chrome
  // is no reading at all.
  const captured = fixture('grok/1.0.52/question.txt');
  const withStale = (screen: string): string => screen.replace('\n  ┃\n  ┃  Which name do you choose?', [
    '',
    '  ┃',
    '  ┃  Old transcript question?',
    '  ┃  1 (○) stale  Use the stale one.',
    '  ┃',
    '  ┃  Which name do you choose?',
  ].join('\n'));
  const withoutLiveOptions = (screen: string): string =>
    screen.split('\n').filter((line) => !line.includes('1 (○) alpha') && !line.includes('z (○) Type your answer')).join('\n');
  const both = withStale(captured);
  const cut = withoutLiveOptions(both);

  test('a stale whole block above the live one does not change the live reading', () => {
    expect(readDialog('grok', both)).toEqual({ dialog: 'question', text: 'Which name do you choose?', complete: true });
  });

  test('the live question whose options are not on screen is the reading, complete:false', () => {
    expect(readDialog('grok', cut)).toEqual({ dialog: 'question', text: 'Which name do you choose?', complete: false });
  });

  test('changing only the current question in that window changes the reading', () => {
    expect(readDialog('grok', cut.replace('Which name do you choose?', 'Which current question changed?')))
      .toEqual({ dialog: 'question', text: 'Which current question changed?', complete: false });
  });

  test('a widget that shows only its own chrome is not a question', () => {
    expect(readDialog('grok', 'Waiting on answers\n  ┃\n  ┃ ↑/↓ navigate · y copy Enter:submit\nTab:next answer\n'))
      .toEqual({ dialog: null });
  });
});
