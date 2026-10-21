import { describe, expect, test } from 'bun:test';
import { parseWorkflow } from '../../src/workflow/schema.ts';
import type { Finding } from '../../src/workflow/types.ts';

const VALID = `workflow: release
version: 1
initial: prep
on:
  release.ready: prep
inputs: [version, target]
states:
  prep:
    on-enter: [stamp-changelog]
    on-leave: [record]
  reviewed:
    wait: { for: approval, role: owner }
transitions:
  - { from: prep, to: reviewed, on: gate-passed, role: integrator }
effects:
  stamp-changelog: { run: changelog-stamp, capability: write, role: operator }
  record: { run: release-notes, capability: write, role: operator }
  tag: { run: release-tag, act-as: owner, role: operator, reach: outside-machine }
library:
  evening-morning:
    mechanics: [set-goals, review-and-adapt]
    settings: [evening-slot]
`;

function findingsOf(text: string): Finding[] {
  const result = parseWorkflow(text);
  if (!('findings' in result)) throw new Error('expected a findings arm');
  return result.findings;
}

function codesOf(text: string): string[] {
  return findingsOf(text).map((finding) => finding.code);
}

describe('parseWorkflow — the accepted form', () => {
  test('parses a definition and pins it by content digest', () => {
    const result = parseWorkflow(VALID);
    if (!('workflow' in result)) throw new Error(`expected a parse, got ${JSON.stringify(result)}`);
    const { workflow, definition } = result;
    expect(workflow.name).toBe('release');
    expect(workflow.version).toBe(1);
    expect(workflow.initial).toBe('prep');
    expect(workflow.on).toEqual([{ kind: 'release.ready', state: 'prep', line: 5 }]);
    expect(workflow.inputs).toEqual(['version', 'target']);
    expect(Object.keys(workflow.states)).toEqual(['prep', 'reviewed']);
    expect(workflow.states.prep?.onEnter.map((effect) => effect.name)).toEqual(['stamp-changelog']);
    expect(workflow.states.reviewed?.wait).toEqual({
      line: 12,
      for: 'approval',
      role: { name: 'owner', line: 12 },
    });
    expect(workflow.transitions).toHaveLength(1);
    expect(workflow.transitions[0]).toMatchObject({ from: 'prep', to: 'reviewed', on: 'gate-passed' });
    expect(workflow.effects.tag?.actAs?.value).toBe('owner');
    expect(workflow.effects.tag?.capability).toBeUndefined();
    expect(workflow.effects.tag?.reach?.value).toBe('outside-machine');
    expect(workflow.library['evening-morning']).toEqual({
      line: 20,
      name: 'evening-morning',
      mechanics: ['set-goals', 'review-and-adapt'],
      settings: ['evening-slot'],
    });
    expect(definition.workflow).toBe('release');
    expect(definition.schemaVersion).toBe(1);
    expect(definition.digest).toStartWith('sha256:');
    const again = parseWorkflow(VALID);
    if (!('definition' in again)) throw new Error('expected a second parse');
    expect(again.definition.digest).toBe(definition.digest);
  });

  test('a one-state graph may have an empty transitions list', () => {
    const result = parseWorkflow('workflow: solo\nversion: 1\ninitial: only\nstates:\n  only: {}\ntransitions: []\n');
    if (!('workflow' in result)) throw new Error(`expected a parse, got ${JSON.stringify(result)}`);
    expect(result.workflow.transitions).toEqual([]);
  });

  test('a time wait needs only its at setting', () => {
    const result = parseWorkflow(
      'workflow: timed\nversion: 1\ninitial: night\nstates:\n  night:\n    wait: { for: time, at: morning-slot }\ntransitions: []\n',
    );
    if (!('workflow' in result)) throw new Error(`expected a parse, got ${JSON.stringify(result)}`);
    expect(result.workflow.states.night?.wait).toEqual({
      line: 6,
      for: 'time',
      at: { name: 'morning-slot', line: 6 },
    });
  });
});

describe('parseWorkflow — parser refusals are their own arm', () => {
  test('a YAML syntax error returns invalid, not findings', () => {
    const result = parseWorkflow('workflow: broken\nversion: [1,\n');
    expect('invalid' in result).toBe(true);
    if (!('invalid' in result)) return;
    expect(result.invalid.name).toBe('YamlError');
    expect(typeof result.invalid.line).toBe('number');
  });

  test('a top level that is not a mapping returns invalid', () => {
    const result = parseWorkflow('- one\n- two\n');
    expect('invalid' in result).toBe(true);
  });
});

describe('parseWorkflow — structural refusals', () => {
  test('an unknown key at any level is refused', () => {
    expect(codesOf(VALID + 'extra: 1\n')).toContain('schema.key');
    const state = VALID.replace('    on-enter: [stamp-changelog]', '    on-enter: [stamp-changelog]\n    when: never');
    expect(codesOf(state)).toContain('schema.key');
    const transition = VALID.replace('role: integrator }', 'role: integrator, then: never }');
    expect(codesOf(transition)).toContain('schema.key');
  });

  test('version is the integer 1 only', () => {
    expect(codesOf(VALID.replace('version: 1', 'version: 2'))).toContain('schema.version');
    expect(codesOf(VALID.replace('version: 1', 'version: "1"'))).toContain('schema.version');
  });

  test('one of initial and on is required, and states and transitions always are', () => {
    const noEntry = VALID.replace('initial: prep\n', '').replace('on:\n  release.ready: prep\n', '');
    expect(codesOf(noEntry)).toContain('schema.required');
    expect(codesOf(VALID.replace(/states:\n(?:.*\n)*?transitions:/, 'transitions:'))).toContain(
      'schema.required',
    );
    expect(codesOf(VALID.replace(/transitions:\n(?:.*\n)*?effects:/, 'effects:'))).toContain(
      'schema.required',
    );
  });

  test('inputs must be a sequence', () => {
    expect(codesOf(VALID.replace('inputs: [version, target]', 'inputs:\n  version: true'))).toContain(
      'schema.type',
    );
    expect(codesOf(VALID.replace('inputs: [version, target]', 'inputs: [version, version]'))).toContain(
      'schema.name',
    );
  });

  test('the identifier rule applies to declared names', () => {
    expect(codesOf(VALID.replace('workflow: release', 'workflow: Release'))).toContain('schema.name');
    expect(codesOf(VALID.replace('  prep:\n', '  Prep:\n'))).toContain('schema.name');
    expect(codesOf(VALID.replace('stamp-changelog: {', 'stamp_changelog: {'))).toContain('schema.name');
  });
});

describe('parseWorkflow — the two vocabularies', () => {
  test('a bus kind is not a transition signal', () => {
    const codes = codesOf(VALID.replace('on: gate-passed', 'on: release.ready'));
    expect(codes).toContain('vocab.bus-kind');
    expect(codes).not.toContain('vocab.signal');
  });

  test('an unknown word in a transition is refused as a signal', () => {
    expect(codesOf(VALID.replace('on: gate-passed', 'on: tests-green'))).toContain('vocab.signal');
  });

  test('an unknown event kind on the top-level on is refused', () => {
    expect(codesOf(VALID.replace('  release.ready: prep', '  release.published: prep'))).toContain(
      'ref.event-kind',
    );
  });
});

describe('parseWorkflow — waits, annotations and hooks', () => {
  test('the wait combinations are exact', () => {
    expect(codesOf(VALID.replace('{ for: approval, role: owner }', '{ for: approval }'))).toContain(
      'graph.wait',
    );
    expect(
      codesOf(VALID.replace('{ for: approval, role: owner }', '{ for: approval, role: owner, at: slot }')),
    ).toContain('graph.wait');
    expect(codesOf(VALID.replace('{ for: approval, role: owner }', '{ for: time }'))).toContain(
      'graph.wait',
    );
    expect(codesOf(VALID.replace('{ for: approval, role: owner }', '{ for: time, at: slot, role: owner }'))).toContain(
      'graph.wait',
    );
  });

  test('a capability is required, except on an act-as effect', () => {
    expect(codesOf(VALID.replace('capability: write, ', ''))).toContain('annotation.capability');
    expect(codesOf(VALID.replace('capability: write', 'capability: own'))).toContain(
      'annotation.capability',
    );
  });

  test('reach is the one outside-machine word', () => {
    expect(codesOf(VALID.replace('reach: outside-machine', 'reach: local'))).toContain(
      'annotation.reach',
    );
  });

  test('a hook naming an undeclared effect is the checker\'s business, not the parser\'s', () => {
    const result = parseWorkflow(VALID.replace('on-enter: [stamp-changelog]', 'on-enter: [missing-effect]'));
    expect('workflow' in result).toBe(true);
  });
});
