import { describe, expect, test } from 'bun:test';
import { checkWorkflow, type CheckResult } from '../src/workflow/check.ts';
import {
  provisionalResolvers,
  type OperationDescriptor,
  type WorkflowResolvers,
} from '../src/workflow/registry.ts';
import { parseWorkflow } from '../src/workflow/schema.ts';
import type { Finding } from '../src/workflow/types.ts';

function check(text: string, resolvers: WorkflowResolvers = provisionalResolvers()): CheckResult {
  const parsed = parseWorkflow(text);
  if (!('workflow' in parsed)) throw new Error(`fixture did not parse: ${JSON.stringify(parsed)}`);
  return checkWorkflow(parsed.workflow, resolvers);
}

/** The assertion shape: level, code and line, in the order the checker returns them. */
function shape(findings: Finding[]): Array<[string, string, number]> {
  return findings.map((finding) => [finding.level, finding.code, finding.line]);
}

const VALID = `workflow: solo
version: 1
initial: only
states:
  only: {}
transitions: []
`;

const LOCAL: OperationDescriptor = {
  kernelOperation: 'notes',
  capabilities: ['write'],
  scopes: [],
  confirmationClass: 'none',
  reach: 'local',
  provisional: false,
};

const PUBLISH: OperationDescriptor = {
  kernelOperation: 'publish',
  capabilities: ['deploy'],
  scopes: [],
  account: 'deploy-bot',
  confirmationClass: 'owner',
  reach: 'outside-machine',
  provisional: false,
};

/** Real (non-provisional) descriptors behind the resolver seam, plus one team role. */
function realResolvers(): WorkflowResolvers {
  const table: Record<string, OperationDescriptor> = { notes: LOCAL, publish: PUBLISH };
  return { ...provisionalResolvers(['operator']), operations: { descriptor: (name) => table[name] } };
}

/** A provisional descriptor that does declare an account, to prove declared fields are checked. */
function provisionalWithAccount(): WorkflowResolvers {
  const scoped: OperationDescriptor = {
    kernelOperation: 'scoped',
    capabilities: ['write'],
    scopes: [],
    account: 'deploy-bot',
    confirmationClass: 'owner',
    reach: 'local',
    provisional: true,
  };
  const table: Record<string, OperationDescriptor> = { scoped };
  return { ...provisionalResolvers(), operations: { descriptor: (name) => table[name] } };
}

describe('checkWorkflow — clean graphs', () => {
  test('a minimal graph has no findings and passes', () => {
    expect(check(VALID)).toEqual({ ok: true, findings: [] });
  });

  test('uses: round is valid in slice 0', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a:
    uses: round
transitions: []
`;
    expect(check(text)).toEqual({ ok: true, findings: [] });
  });

  test('uses: a declared library entry is valid', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a:
    uses: helper
transitions: []
library:
  helper:
    mechanics: [step]
    settings: []
`;
    expect(check(text)).toEqual({ ok: true, findings: [] });
  });
});

describe('checkWorkflow — graph references', () => {
  test('initial names no declared state, reported at the root line', () => {
    const text = `workflow: solo
version: 1
initial: nowhere
states:
  only: {}
transitions: []
`;
    const result = check(text);
    expect(shape(result.findings)).toEqual([
      ['refusal', 'graph.state', 1],
      ['note', 'graph.orphan', 5],
    ]);
    expect(result.ok).toBe(false);
  });

  test('an on trigger enters no declared state', () => {
    const text = `workflow: solo
version: 1
on:
  release.ready: nowhere
states:
  only: {}
transitions: []
`;
    expect(shape(check(text).findings)).toEqual([
      ['refusal', 'graph.state', 4],
      ['note', 'graph.orphan', 6],
    ]);
  });

  test('a transition names an undeclared state', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions:
  - { from: a, to: ghost, on: accepted, role: lead }
`;
    expect(shape(check(text).findings)).toEqual([['refusal', 'graph.transition', 7]]);
  });

  test('two transitions from one state on one signal are ambiguous', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
  b: {}
transitions:
  - { from: a, to: b, on: accepted, role: lead }
  - { from: a, to: b, on: accepted, role: lead }
`;
    expect(shape(check(text).findings)).toEqual([['refusal', 'graph.ambiguous', 9]]);
  });

  test('an unreachable state is a note and never fails the check', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
  b: {}
transitions: []
`;
    const result = check(text);
    expect(shape(result.findings)).toEqual([['note', 'graph.orphan', 6]]);
    expect(result.ok).toBe(true);
  });

  test('a hook names no declared effect', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a:
    on-enter: [ghost]
transitions: []
`;
    expect(shape(check(text).findings)).toEqual([['refusal', 'graph.hook', 6]]);
  });

  test('uses names neither a library entry nor round', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a:
    uses: missing
transitions: []
`;
    expect(shape(check(text).findings)).toEqual([['refusal', 'graph.uses', 6]]);
  });

  test('error names no declared state, reported at the root line', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
error: nowhere
`;
    expect(shape(check(text).findings)).toEqual([['refusal', 'graph.error-path', 1]]);
  });
});

describe('checkWorkflow — roles and guards resolve through the seams', () => {
  test('a transition role is unknown', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions:
  - { from: a, to: a, on: accepted, role: nobody }
`;
    expect(shape(check(text).findings)).toEqual([['refusal', 'ref.role', 7]]);
  });

  test('an approval wait role is unknown', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a:
    wait: { for: approval, role: nobody }
transitions: []
`;
    expect(shape(check(text).findings)).toEqual([['refusal', 'ref.role', 6]]);
  });

  test('an effect role is unknown', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
effects:
  kick: { run: changelog-stamp, capability: write, role: nobody }
`;
    expect(shape(check(text).findings)).toEqual([
      ['note', 'ref.operation', 8],
      ['refusal', 'ref.role', 8],
    ]);
  });

  test('a guard is unknown to the catalogue', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
  b: {}
transitions:
  - { from: a, to: b, on: gate-passed, role: lead, guard: nope }
`;
    expect(shape(check(text).findings)).toEqual([['refusal', 'ref.guard', 8]]);
  });
});

describe('checkWorkflow — operations and annotations', () => {
  test('an unknown operation is refused', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
effects:
  kick: { run: no-such-op, capability: write, role: lead }
`;
    expect(shape(check(text).findings)).toEqual([['refusal', 'ref.operation', 8]]);
  });

  test('a provisional operation is a note and passes', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
effects:
  kick: { run: changelog-stamp, capability: write, role: lead }
`;
    const result = check(text);
    expect(shape(result.findings)).toEqual([['note', 'ref.operation', 8]]);
    expect(result.ok).toBe(true);
  });

  test('the tag sketch: provisional ref operation with act-as and no capability', () => {
    const text = `workflow: release
version: 1
initial: tagged
states:
  tagged: {}
transitions: []
effects:
  tag: { run: release-tag, act-as: deploy-bot, role: lead, reach: outside-machine }
`;
    const result = check(text);
    expect(shape(result.findings)).toEqual([
      ['note', 'annotation.act-as', 8],
      ['note', 'annotation.capability-pending', 8],
      ['note', 'ref.operation', 8],
    ]);
    expect(result.ok).toBe(true);
  });

  test('an undeclared capability on a provisional descriptor is a note', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
effects:
  kick: { run: release-tag, capability: write, role: lead, reach: outside-machine }
`;
    const result = check(text);
    expect(shape(result.findings)).toEqual([
      ['note', 'annotation.capability', 8],
      ['note', 'ref.operation', 8],
    ]);
    expect(result.ok).toBe(true);
  });

  test('a provisional descriptor with a declared account still refuses a mismatch', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
effects:
  kick: { run: scoped, capability: write, role: lead, act-as: other }
`;
    expect(shape(check(text, provisionalWithAccount()).findings)).toEqual([
      ['refusal', 'annotation.act-as', 8],
      ['note', 'ref.operation', 8],
    ]);
  });

  test('a provisional descriptor with a declared capability set still refuses a mismatch', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
effects:
  kick: { run: changelog-stamp, capability: review, role: lead }
`;
    expect(shape(check(text).findings)).toEqual([
      ['refusal', 'annotation.capability', 8],
      ['note', 'ref.operation', 8],
    ]);
  });

  test('a provisional local descriptor still refuses an outside-machine label', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
effects:
  kick: { run: changelog-stamp, capability: write, role: lead, reach: outside-machine }
`;
    expect(shape(check(text).findings)).toEqual([
      ['refusal', 'annotation.reach', 8],
      ['note', 'ref.operation', 8],
    ]);
  });

  test('a real descriptor with no account refuses act-as', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
effects:
  kick: { run: notes, capability: write, role: operator, act-as: owner }
`;
    expect(shape(check(text, realResolvers()).findings)).toEqual([
      ['refusal', 'annotation.act-as', 8],
    ]);
  });

  test('an outside-machine label on a local real descriptor is refused', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
effects:
  kick: { run: notes, capability: write, role: operator, reach: outside-machine }
`;
    expect(shape(check(text, realResolvers()).findings)).toEqual([
      ['refusal', 'annotation.reach', 8],
    ]);
  });

  test('an outside-machine operation without the label is refused as falsely local', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
effects:
  kick: { run: publish, capability: deploy, role: operator }
`;
    expect(shape(check(text, realResolvers()).findings)).toEqual([
      ['refusal', 'annotation.reach', 8],
    ]);
  });

  test('a matching publish effect passes with real descriptors', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
effects:
  kick: { run: publish, capability: deploy, role: operator, act-as: deploy-bot, reach: outside-machine }
`;
    expect(check(text, realResolvers())).toEqual({ ok: true, findings: [] });
  });

  test('a matching act-as name on a different account is refused', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
effects:
  kick: { run: publish, capability: deploy, role: operator, act-as: other-bot, reach: outside-machine }
`;
    expect(shape(check(text, realResolvers()).findings)).toEqual([
      ['refusal', 'annotation.act-as', 8],
    ]);
  });

  test('a real descriptor refuses a capability it does not declare', () => {
    const text = `workflow: solo
version: 1
initial: a
states:
  a: {}
transitions: []
effects:
  kick: { run: notes, capability: review, role: operator }
`;
    expect(shape(check(text, realResolvers()).findings)).toEqual([
      ['refusal', 'annotation.capability', 8],
    ]);
  });
});
