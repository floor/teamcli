// The published built-in workflow graph `work-item`: the one definition the daemon is meant to
// run live. The text is the spec's verbatim, so this scene pins what the file claims about it —
// the parser accepts it, the documented counts hold, and the digest is the text's own SHA-256.
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_DEFINITION_NAMES,
  WORK_ITEM_NAME,
  builtinDefinition,
} from '../src/workflow/index.ts';

const DOCUMENTED_DIGEST =
  'sha256:648bb634c552a5b72384c6c827bd6ddd4b92700534459cb44148a59cd240b844';

describe('the built-in work-item definition', () => {
  test('parses to the documented graph', () => {
    const builtin = builtinDefinition('work-item');
    expect(builtin).toBeDefined();
    if (builtin === undefined) return;
    const { workflow } = builtin;
    expect(builtin.name).toBe('work-item');
    expect(builtin.definition.workflow).toBe('work-item');
    expect(builtin.definition.schemaVersion).toBe(1);
    expect(builtin.definition.digest).toBe(DOCUMENTED_DIGEST);
    expect(workflow.initial).toBe('ready');
    expect(workflow.error).toBe('failed');
    expect(workflow.inputs).toEqual([
      'item-key',
      'title',
      'description',
      'repository',
      'base-branch',
      'role-sequence',
      'model',
      'assignee',
    ]);
    expect(Object.keys(workflow.states)).toEqual([
      'ready',
      'dispatching',
      'building',
      'building-pending',
      'testing',
      'testing-pending',
      'merging',
      'installing',
      'installing-pending',
      'installed',
      'done',
      'failed',
      'blocked-dispatching',
      'blocked-building',
      'blocked-testing',
      'blocked-merging',
      'blocked-installing',
    ]);
    expect(Object.keys(workflow.effects).sort()).toEqual([
      'dispatch-builder',
      'dispatch-integrator',
      'dispatch-tester',
    ]);
  });

  test('every transition names two declared states and a declared role', () => {
    const builtin = builtinDefinition('work-item');
    if (builtin === undefined) throw new Error('the built-in work-item graph is missing');
    const { workflow } = builtin;
    const states = new Set(Object.keys(workflow.states));
    expect(workflow.transitions.length).toBe(63);
    expect(workflow.transitions.filter((transition) => transition.on === 'lead-stop').length).toBe(15);
    for (const transition of workflow.transitions) {
      expect(states.has(transition.from)).toBe(true);
      expect(states.has(transition.to)).toBe(true);
      expect(['builder', 'daemon', 'integrator', 'lead', 'tester']).toContain(transition.role.name);
    }
  });

  test('a name that is not the published one is not a built-in', () => {
    expect(builtinDefinition('no-such-workflow')).toBeUndefined();
  });

  test('the graph is parsed once and reused', () => {
    const first = builtinDefinition(WORK_ITEM_NAME);
    expect(builtinDefinition(WORK_ITEM_NAME)).toBe(first);
    expect(BUILTIN_DEFINITION_NAMES).toEqual([WORK_ITEM_NAME]);
  });
});
