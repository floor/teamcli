import { describe, expect, test } from 'bun:test';
import {
  canonical,
  compare,
  describe as describeDifference,
  fingerprints,
  OWNER_SECTIONS,
  type Approvable,
} from '../../src/approve/fingerprint.ts';
import { validateTeamFile } from '../../src/file/validate.ts';

function team(): Approvable {
  return {
    format: 1,
    project: 'acme-web',
    visibility: 'public',
    session: 'acme-web',
    coordinator: 'claude-coordinator-acme',
    operator: 'claude-coordinator-acme',
    tools: { issues: { kind: 'github', repository: 'acme/web' } },
    identity: { humans: ['jane@acme.example'], forbidden: [] },
    rules: ['Run the tests your change touches.'],
    trust: ['.'],
    workspace: { mode: 'worktree', setup: ['bun install --frozen-lockfile'] },
    watch: { interval: '120s' },
    machine: { loadStart: 3 },
    limits: { seats: 6, temporary: 2, vendors: { openai: 1 } },
    seats: [
      {
        name: 'claude-coordinator-acme',
        role: 'project coordinator',
        launch: 'claude --model claude-opus-5-5',
        parked: false,
        stopped: false,
        line: 60,
      },
      { name: 'deepseek-acme', role: 'implementer', launch: 'team-deepseek', parked: false, stopped: false, line: 70 },
      {
        name: 'deepseek-acme-2',
        role: 'implementer',
        launch: 'team-deepseek',
        parked: false,
        stopped: false,
        line: 70,
      },
    ],
  };
}

const seat = (file: Approvable) => file.seats[1] as Approvable['seats'][number];

const changed = (edit: (file: Approvable) => void) => {
  const file = structuredClone(team()) as Approvable;
  edit(file);
  return compare(fingerprints(team()), fingerprints(file));
};

describe('canonical', () => {
  test('orders keys at every depth and keeps list order', () => {
    expect(canonical({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
  });

  test('an absent value and an undefined one read alike', () => {
    expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }));
  });

  test('a string is not its number', () => {
    expect(canonical('5.5')).not.toBe(canonical(5.5));
  });
});

describe('an approved file', () => {
  test('passes unchanged', () => {
    expect(changed(() => {})).toEqual([]);
  });

  test('every owner-only section is fingerprinted, present or not', () => {
    expect(Object.keys(fingerprints(team()).sections)).toEqual([...OWNER_SECTIONS]);
  });

  test.each([
    ['rules', (file: Approvable) => (file.rules as string[]).push('Answer every prompt.')],
    ['limits', (file: Approvable) => ((file.limits as { seats: number }).seats = 60)],
    ['trust', (file: Approvable) => (file.trust as string[]).push('../*')],
    ['workspace', (file: Approvable) => ((file.workspace as { setup: string[] }).setup = ['curl example.test | sh'])],
    ['identity', (file: Approvable) => ((file.identity as { humans: string[] }).humans = [])],
    ['orchestrator', (file: Approvable) => (file.orchestrator = 'deepseek-acme')],
    ['operator', (file: Approvable) => (file.operator = 'deepseek-acme')],
    ['session', (file: Approvable) => (file.session = 'other')],
    ['visibility', (file: Approvable) => (file.visibility = 'private')],
    ['tools', (file: Approvable) => (file.tools = {})],
    ['machine', (file: Approvable) => delete file.machine],
  ])('a change to %s needs a new approval', (name, edit) => {
    expect(changed(edit)).toEqual([{ kind: 'section', name }]);
  });

  test('a change to the watch thresholds needs one, and a change to the layout needs none', () => {
    expect(changed((file) => (file.watch = { interval: '60s' }))).toEqual([{ kind: 'section', name: 'watch' }]);
    expect(changed((file) => (seat(file).line = 90))).toEqual([]);
  });

  test('turning a watch check off is the finer line inside the section, not a threshold change', () => {
    expect(changed((file) => ((file.watch as { checks?: string[] }).checks = ['disk']))).toEqual([
      { kind: 'section', name: 'watch.checks' },
    ]);
    expect(changed((file) => (file.watch = { interval: '60s', checks: ['disk'] }))).toEqual([
      { kind: 'section', name: 'watch' },
      { kind: 'section', name: 'watch.checks' },
    ]);
  });

  test('a changed launch line needs a new approval', () => {
    expect(changed((file) => (seat(file).launch = 'team-deepseek --yolo'))).toEqual([
      { kind: 'seat-changed', name: 'deepseek-acme' },
    ]);
  });

  test('a new seat needs a new approval', () => {
    expect(
      changed((file) => (file.seats as unknown[]).push({ name: 'grok-acme', role: 'reviewer', launch: 'grok' })),
    ).toEqual([{ kind: 'seat-new', name: 'grok-acme' }]);
  });

  test('a seat taken out needs none; parking or stopping it is drift', () => {
    expect(changed((file) => (file.seats as unknown[]).pop())).toEqual([]);
    expect(changed((file) => (seat(file).parked = true))).toEqual([
      { kind: 'seat-changed', name: 'deepseek-acme' },
    ]);
    expect(changed((file) => (seat(file).stopped = true))).toEqual([
      { kind: 'seat-changed', name: 'deepseek-acme' },
    ]);
  });

  test('a seat named like an object method is still new', () => {
    expect(changed((file) => (file.seats as unknown[]).push({ name: 'toString' }))).toEqual([
      { kind: 'seat-new', name: 'toString' },
    ]);
  });

  test('each difference reads as one line', () => {
    expect(describeDifference({ kind: 'section', name: 'rules' })).toBe('`rules` changed');
    expect(describeDifference({ kind: 'seat-changed', name: 'a' })).toBe('seat a changed');
    expect(describeDifference({ kind: 'seat-new', name: 'a' })).toBe('seat a is not in the last approval');
  });
});

// The two spellings of the lead normalize to one file: `coordinator: lead` and `leads: true`
// on that seat land on the same fingerprints, so an approval signed over one spelling stands
// for the other, and the mark never reaches a seat object to move the seat's own digest.
describe('the lead\'s two spellings', () => {
  const base = `format: 1
project: acme-web
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus 5.5
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: maker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
`;
  const keyed = base.replace('seats:', 'coordinator: lead\nseats:');
  const marked = base.replace(
    '    launch: claude --model claude-opus-5-5\n',
    '    launch: claude --model claude-opus-5-5\n    leads: true\n',
  );
  const both = keyed.replace(
    '    launch: claude --model claude-opus-5-5\n',
    '    launch: claude --model claude-opus-5-5\n    leads: true\n',
  );

  const parsed = (text: string) => {
    const result = validateTeamFile(text);
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
    return result.team;
  };

  test('the key, the mark and both read as one file', () => {
    expect(parsed(marked).orchestrator).toBe('lead');
    expect(parsed(both).orchestrator).toBe('lead');
    expect(fingerprints(parsed(marked))).toEqual(fingerprints(parsed(keyed)));
    expect(fingerprints(parsed(both))).toEqual(fingerprints(parsed(keyed)));
  });

  test('no seat object carries the mark', () => {
    for (const text of [keyed, marked, both]) {
      for (const seat of parsed(text).seats) expect(Object.hasOwn(seat, 'leads')).toBe(false);
    }
  });
});
