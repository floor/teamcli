// The profile's `question_answer` records: the key a profile presses to dismiss a dialog of one
// of the three answerable kinds, per version. A record answers with a dismissing key alone — the
// closed set has no key that picks a menu option — and no two records for one kind may claim the
// same printed version, because the lookup would have to pick one by order.
import { describe, expect, test } from 'bun:test';
import { profileFor } from '../src/profiles/profile.ts';
import { questionAnswerFor, questionAnswers, type QuestionAnswerRecord } from '../src/profiles/question-answer.ts';
import { parseYaml } from '../src/yaml.ts';

function recordsOf(text: string): QuestionAnswerRecord[] {
  const root = parseYaml(text);
  if (root.kind !== 'map') throw new Error('the fixture is not a map');
  return questionAnswers(root.entries.find((entry) => entry.key === 'question_answer'));
}

const RANGE = `question_answer:
  - kind: question
    key: escape
    from: '2.1.289'
    to: '2.1.302'
  - kind: plan approval
    key: ctrl+c
    from: '2.1.302'
    to: '2.1.302'
`;

describe('the question-answer records a profile lists', () => {
  test('a range and an exact record both parse', () => {
    expect(recordsOf(RANGE)).toEqual([
      { kind: 'question', key: 'escape', from: '2.1.289', to: '2.1.302' },
      { kind: 'plan approval', key: 'ctrl+c', from: '2.1.302', to: '2.1.302' },
    ]);
  });

  test('a profile with no records answers nothing', () => {
    expect(questionAnswers(undefined)).toEqual([]);
    expect(profileFor('muse')?.questionAnswers).toEqual([]);
  });

  test('the shipped profiles carry the dismiss keys their captures recorded', () => {
    const claude = profileFor('claude-code');
    if (!claude) throw new Error('no claude-code profile');
    expect(questionAnswerFor(claude.questionAnswers, 'question', '2.1.289')?.key).toBe('escape');
    expect(questionAnswerFor(claude.questionAnswers, 'question', '2.1.302')?.key).toBe('escape');
    expect(questionAnswerFor(claude.questionAnswers, 'plan approval', '2.1.289')?.key).toBe('escape');
    // The held frame was captured but never dismissed: no key is claimed, so the answer layer
    // refuses it rather than pressing a key the run did not record.
    expect(questionAnswerFor(claude.questionAnswers, 'confirmation', '2.1.302')).toBeNull();

    const cursor = profileFor('cursor');
    if (!cursor) throw new Error('no cursor profile');
    expect(questionAnswerFor(cursor.questionAnswers, 'question', '2026.10.16')?.key).toBe('escape');
    expect(questionAnswerFor(cursor.questionAnswers, 'confirmation', '2026.10.01')?.key).toBe('escape');

    const gemini = profileFor('gemini');
    if (!gemini) throw new Error('no gemini profile');
    expect(questionAnswerFor(gemini.questionAnswers, 'question', '0.64.0')?.key).toBe('escape');

    const antigravity = profileFor('antigravity');
    if (!antigravity) throw new Error('no antigravity profile');
    expect(questionAnswerFor(antigravity.questionAnswers, 'question', '1.4.2')?.key).toBe('escape');
    // The unsent-comments dialog was closed from, not dismissed with a key.
    expect(questionAnswerFor(antigravity.questionAnswers, 'confirmation', '1.2.16')).toBeNull();

    // Grok's capture README records no dismissal key.
    expect(profileFor('grok')?.questionAnswers).toEqual([]);
  });

  test('the lookup takes the record that names the kind and the version printed', () => {
    const records = recordsOf(RANGE);
    expect(questionAnswerFor(records, 'question', '2.1.290')?.key).toBe('escape');
    expect(questionAnswerFor(records, 'question', '2.1.289')?.key).toBe('escape');
    expect(questionAnswerFor(records, 'question', '2.1.302')?.key).toBe('escape');
    expect(questionAnswerFor(records, 'plan approval', '2.1.302')?.key).toBe('ctrl+c');
  });

  test('no record, another kind, and a version outside the range read null', () => {
    const records = recordsOf(RANGE);
    expect(questionAnswerFor(records, 'confirmation', '2.1.290')).toBeNull();
    expect(questionAnswerFor(records, 'question', '2.1.303')).toBeNull();
    expect(questionAnswerFor(records, 'question', '2.1.288')).toBeNull();
    expect(questionAnswerFor(records, 'plan approval', '2.1.303')).toBeNull();
  });

  test('an exact record matches the printed text byte for byte; a range takes whole versions alone', () => {
    const exact = recordsOf(`question_answer:
  - kind: question
    key: escape
    from: '2.1.289 (Claude Code)'
    to: '2.1.289 (Claude Code)'
`);
    expect(questionAnswerFor(exact, 'question', '2.1.289 (Claude Code)')).not.toBeNull();
    expect(questionAnswerFor(exact, 'question', '2.1.289')).toBeNull();
    const range = recordsOf(RANGE);
    expect(questionAnswerFor(range, 'question', '2.1.290 (Claude Code)')).toBeNull();
  });
});

describe('what a record refuses', () => {
  const refused = (body: string): string => {
    try {
      recordsOf(body);
      return 'loaded';
    } catch (error) {
      return (error as Error).message;
    }
  };

  test('a key outside the closed set, including one that picks a menu option', () => {
    for (const key of ['enter', '1', 'ctrl+u']) {
      expect(refused(`question_answer:\n  - kind: question\n    key: '${key}'\n    from: '1.0'\n    to: '1.0'\n`)).toBe('"key" must be one of escape, ctrl+c');
    }
  });

  test('a kind outside the three answerable ones', () => {
    for (const kind of ['permission', 'trust', 'exit question', 'login']) {
      expect(refused(`question_answer:\n  - kind: ${kind}\n    key: escape\n    from: '1.0'\n    to: '1.0'\n`)).toBe('"kind" must be one of question, plan approval, confirmation');
    }
  });

  test('a missing field, and a field the record does not carry', () => {
    expect(refused(`question_answer:\n  - kind: question\n    key: escape\n    to: '1.0'\n`)).toBe('missing "from"');
    expect(refused(`question_answer:\n  - kind: question\n    key: escape\n    from: '1.0'\n    to: '1.0'\n    capture: claude-code/1.0/x.txt\n`)).toBe('unknown key "capture"');
  });

  test('an empty list, and a range whose ends do not parse', () => {
    expect(refused('question_answer: []\n')).toBe('"question_answer" must be a non-empty list');
    expect(refused(`question_answer:\n  - kind: question\n    key: escape\n    from: '2.1'\n    to: latest\n`)).toBe('"from" and "to" must both be whole versions, or the same text for one exact version');
  });

  test('a range that runs backwards', () => {
    expect(refused(`question_answer:\n  - kind: question\n    key: escape\n    from: '2.1.302'\n    to: '2.1.289'\n`)).toBe('"from" must not be after "to"');
  });

  test('two records for one kind may not claim the same version', () => {
    const overlap = 'is already answered on versions this record claims too';
    expect(refused(`question_answer:
  - kind: question
    key: escape
    from: '2.1.289'
    to: '2.1.302'
  - kind: question
    key: ctrl+c
    from: '2.1.300'
    to: '2.1.310'
`)).toBe(`"question" ${overlap}`);
    expect(refused(`question_answer:
  - kind: question
    key: escape
    from: '2.1.300'
    to: '2.1.300'
  - kind: question
    key: ctrl+c
    from: '2.1.300'
    to: '2.1.300'
`)).toBe(`"question" ${overlap}`);
  });

  test('the same versions may be answered for different kinds', () => {
    expect(recordsOf(`question_answer:
  - kind: question
    key: escape
    from: '2.1.300'
    to: '2.1.300'
  - kind: confirmation
    key: ctrl+c
    from: '2.1.300'
    to: '2.1.300'
`)).toHaveLength(2);
  });
});
