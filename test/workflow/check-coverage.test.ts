// Independent coverage for the whole-graph workflow checker (src/workflow/check.ts, PR #610).
// Authored from the reviewed contract — wf0-spec-slices-0-1.md §1 (state, wait, transition and
// effect rules; the reference rules; the findings families and the exit rule) and the Zeus ruling
// of 2026-10-21 (U5 bare guard names, U6 a note per provisional operation use, U7 roles, U13 the
// tag sketch's act-as effect with no capability) — against the merged shared module
// (src/workflow/{types,registry,schema}.ts at main). The checker's public shape and code names
// were read from check.ts at PR #610's head 09ace713 so the assertions name the actual codes;
// every fixture and case below is written here, and no builder test or fixture was read or
// copied. Each fixture is parsed with parseWorkflow first, because the command boundary runs
// parse -> check and a structural finding never reaches the checker.
import { describe, expect, test } from 'bun:test';
import { checkWorkflow, type CheckResult } from '../../src/workflow/check.ts';
import {
  parseWorkflow,
  provisionalResolvers,
  type Finding,
  type OperationDescriptor,
  type WorkflowResolvers,
} from '../../src/workflow/index.ts';

// The roles the team file would supply at the tag, plus the round's own terms. `builder` is a
// team role here; `operator` is deliberately not, so an unknown name stays unknown.
const ROLES = provisionalResolvers(['builder']);

function checked(text: string, resolvers: WorkflowResolvers = ROLES): CheckResult {
  const parsed = parseWorkflow(text);
  if (!('workflow' in parsed)) {
    const why = 'findings' in parsed ? parsed.findings : parsed.invalid;
    throw new Error(`fixture did not parse: ${JSON.stringify(why)}`);
  }
  return checkWorkflow(parsed.workflow, resolvers);
}

function refusals(result: CheckResult): Finding[] {
  return result.findings.filter((finding) => finding.level === 'refusal');
}

function notes(result: CheckResult): Finding[] {
  return result.findings.filter((finding) => finding.level === 'note');
}

/** `level code@line`, the whole finding identity a caller can act on. */
function pairs(findings: Finding[]): string[] {
  return findings.map((finding) => `${finding.level} ${finding.code}@${finding.line}`);
}

function maxLine(text: string): number {
  return text.trimEnd().split('\n').length;
}

const ACCEPTED = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
  live: {}
transitions:
  - { from: draft, to: live, on: gate-passed, role: integrator }
`;

const TRIGGER_ONLY = `workflow: coverage-check
version: 1
on:
  release.ready: draft
states:
  draft: {}
transitions: []
`;

const TEAM_ROLE = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
transitions:
  - { from: draft, to: draft, on: gate-passed, role: builder }
`;

const ALL_ROLES = `workflow: coverage-check
version: 1
initial: draft
states:
  draft:
    on-enter: [stamp]
    wait: { for: approval, role: integrator }
  live:
    on-leave: [record]
transitions:
  - { from: draft, to: live, on: gate-passed, role: lead }
effects:
  stamp: { run: changelog-stamp, capability: write, role: owner }
  record: { run: release-notes, capability: write, role: builder }
`;

const INITIAL_GHOST = `workflow: coverage-check
version: 1
initial: ghost
states:
  draft: {}
transitions: []
`;

const ON_GHOST = `workflow: coverage-check
version: 1
on:
  release.ready: ghost
states:
  draft: {}
transitions: []
`;

const ERROR_GHOST = `workflow: coverage-check
version: 1
initial: draft
error: ghost
states:
  draft: {}
transitions: []
`;

const FROM_GHOST = `workflow: coverage-check
version: 1
initial: live
states:
  live: {}
transitions:
  - { from: ghost, to: live, on: gate-passed, role: owner }
`;

const TO_GHOST = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
transitions:
  - { from: draft, to: ghost, on: gate-passed, role: owner }
`;

const BOTH_GHOST = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
transitions:
  - { from: ghost, to: phantom, on: gate-passed, role: owner }
`;

const AMBIGUOUS = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
  live: {}
  parked: {}
transitions:
  - { from: draft, to: live, on: gate-passed, role: owner }
  - { from: draft, to: parked, on: gate-passed, guard: ci-green-on-head, role: lead }
`;

const NOT_AMBIGUOUS = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
  live: {}
transitions:
  - { from: draft, to: live, on: gate-passed, role: owner }
  - { from: live, to: draft, on: pr-merged, role: owner }
`;

const BAD_ON_ENTER = `workflow: coverage-check
version: 1
initial: draft
states:
  draft:
    on-enter: [ghost]
transitions: []
`;

const BAD_ON_LEAVE = `workflow: coverage-check
version: 1
initial: draft
states:
  draft:
    on-leave: [ghost]
transitions: []
`;

const USES_ROUND = `workflow: coverage-check
version: 1
initial: draft
states:
  draft:
    uses: round
transitions: []
`;

const USES_LIBRARY = `workflow: coverage-check
version: 1
initial: draft
states:
  draft:
    uses: evening
transitions: []
library:
  evening:
    mechanics: [set-goals]
    settings: [evening-slot]
`;

const USES_GHOST = `workflow: coverage-check
version: 1
initial: draft
states:
  draft:
    uses: ghost
transitions: []
`;

const WAIT_APPROVAL = `workflow: coverage-check
version: 1
initial: draft
states:
  draft:
    wait: { for: approval, role: owner }
transitions: []
`;

const WAIT_APPROVAL_UNKNOWN = `workflow: coverage-check
version: 1
initial: draft
states:
  draft:
    wait: { for: approval, role: operator }
transitions: []
`;

const WAIT_TIME = `workflow: coverage-check
version: 1
initial: draft
states:
  draft:
    wait: { for: time, at: settle-window }
transitions: []
`;

const GUARD_KNOWN = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
  live: {}
transitions:
  - { from: draft, to: live, on: gate-passed, guard: ci-green-on-head, role: owner }
`;

const GUARD_UNKNOWN = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
  live: {}
transitions:
  - { from: draft, to: live, on: gate-passed, guard: sha-clean, role: owner }
`;

const EFFECT_ROLE_UNKNOWN = `workflow: coverage-check
version: 1
initial: draft
states:
  draft:
    on-enter: [stamp]
transitions: []
effects:
  stamp: { run: changelog-stamp, capability: write, role: operator }
`;

const UNKNOWN_OPERATION = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
transitions: []
effects:
  publish: { run: ghost-op, capability: write, role: owner }
`;

const PROVISIONAL_OPERATION = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
transitions: []
effects:
  stamp: { run: changelog-stamp, capability: write, role: owner }
`;

const OUTSIDE_ON_LOCAL = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
transitions: []
effects:
  verify: { run: merge-verify, capability: review, role: integrator, reach: outside-machine }
`;

const LOCAL_ON_OUTSIDE = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
transitions: []
effects:
  tag: { run: release-tag, capability: gate, role: owner }
`;

const OUTSIDE_MATCH = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
transitions: []
effects:
  tag: { run: release-tag, capability: gate, role: owner, reach: outside-machine }
`;

const CAPABILITY_CONTRADICTION = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
transitions: []
effects:
  stamp: { run: changelog-stamp, capability: merge, role: owner }
`;

const CAPABILITY_EMPTY_PROVISIONAL = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
transitions: []
effects:
  tag: { run: release-tag, capability: merge, role: owner, reach: outside-machine }
`;

const U13_TAG = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
transitions: []
effects:
  tag: { run: release-tag, act-as: owner, role: owner, reach: outside-machine }
`;

const ORPHAN = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
  parked: {}
transitions: []
`;

const ORDERED = `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
  live: {}
  parked: {}
transitions:
  - { from: draft, to: live, on: gate-passed, role: ghost-role }
  - { from: draft, to: parked, on: gate-passed, role: ghost-role }
`;

/**
 * Resolvers with real (non-provisional) operation descriptors, so the annotation rules run
 * against declared authority fields instead of the provisional catalogue's open ones.
 */
function realResolvers(options: { account?: string } = {}): WorkflowResolvers {
  const publish: OperationDescriptor = {
    kernelOperation: 'publish',
    capabilities: ['deploy'],
    scopes: [],
    confirmationClass: 'owner',
    reach: 'outside-machine',
    provisional: false,
    ...(options.account === undefined ? {} : { account: options.account }),
  };
  const stamp: OperationDescriptor = {
    kernelOperation: 'stamp',
    capabilities: ['write'],
    scopes: [],
    confirmationClass: 'none',
    reach: 'local',
    provisional: false,
  };
  return {
    roles: { resolve: (name) => (name === 'owner' ? 'owner' : undefined) },
    operations: {
      descriptor: (name) => (name === 'publish' ? publish : name === 'stamp' ? stamp : undefined),
    },
    guards: { guard: () => undefined },
    eventKinds: { has: () => true },
  };
}

function realEffect(effect: string): string {
  return `workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
transitions: []
effects:
  ${effect}
`;
}

describe('a definition whose names all resolve', () => {
  test('checks clean with no findings at all', () => {
    expect(checked(ACCEPTED)).toEqual({ ok: true, findings: [] });
  });

  test('a trigger-only definition is as valid as an initial-only one', () => {
    expect(checked(TRIGGER_ONLY)).toEqual({ ok: true, findings: [] });
  });

  test('a team role from the seat strings resolves; the same name refuses without it', () => {
    expect(checked(TEAM_ROLE).findings).toEqual([]);
    const withheld = checked(TEAM_ROLE, provisionalResolvers());
    expect(pairs(withheld.findings)).toEqual(['refusal ref.role@7']);
    expect(withheld.ok).toBe(false);
  });

  test('the round terms, a team role, a known guard and provisional operations only note', () => {
    const result = checked(ALL_ROLES);
    expect(refusals(result)).toEqual([]);
    expect(result.ok).toBe(true);
    // One note per provisional operation use (U6), at the effect's line.
    expect(pairs(result.findings)).toEqual(['note ref.operation@13', 'note ref.operation@14']);
  });
});

describe('entry references', () => {
  test('an initial state that is not declared is refused at the definition line', () => {
    const result = checked(INITIAL_GHOST);
    expect(pairs(refusals(result))).toEqual(['refusal graph.state@1']);
    expect(result.ok).toBe(false);
    // The declared state nothing enters is a note, never a second refusal.
    expect(pairs(notes(result))).toEqual(['note graph.orphan@5']);
  });

  test('an on trigger entering an undeclared state is refused at its own line', () => {
    const result = checked(ON_GHOST);
    expect(pairs(refusals(result))).toEqual(['refusal graph.state@4']);
    expect(pairs(notes(result))).toEqual(['note graph.orphan@6']);
  });

  test('an error path naming an undeclared state is its own refusal', () => {
    const result = checked(ERROR_GHOST);
    expect(pairs(refusals(result))).toEqual(['refusal graph.error-path@1']);
    expect(result.ok).toBe(false);
  });
});

describe('transitions', () => {
  test('an undeclared from state is refused', () => {
    expect(pairs(refusals(checked(FROM_GHOST)))).toEqual(['refusal graph.transition@7']);
  });

  test('an undeclared to state is refused', () => {
    expect(pairs(refusals(checked(TO_GHOST)))).toEqual(['refusal graph.transition@7']);
  });

  test('both endpoints undeclared give one refusal each', () => {
    const result = checked(BOTH_GHOST);
    expect(pairs(refusals(result))).toEqual([
      'refusal graph.transition@7',
      'refusal graph.transition@7',
    ]);
  });

  test('a second transition from the same state on the same signal is ambiguous', () => {
    const result = checked(AMBIGUOUS);
    expect(pairs(refusals(result))).toEqual(['refusal graph.ambiguous@10']);
    expect(result.ok).toBe(false);
  });

  test('the same state on another signal, or another state on the same signal, is not ambiguous', () => {
    expect(checked(NOT_AMBIGUOUS)).toEqual({ ok: true, findings: [] });
  });
});

describe('hooks', () => {
  const hooks: { what: string; text: string }[] = [
    { what: 'an on-enter effect that is not declared', text: BAD_ON_ENTER },
    { what: 'an on-leave effect that is not declared', text: BAD_ON_LEAVE },
  ];
  test.each(hooks)('$what is refused at the hook line', ({ text }) => {
    const result = checked(text);
    expect(pairs(refusals(result))).toEqual(['refusal graph.hook@6']);
    expect(result.ok).toBe(false);
  });
});

describe('uses', () => {
  const uses: { what: string; text: string; expected: string[] }[] = [
    { what: 'the reserved round name', text: USES_ROUND, expected: [] },
    { what: 'a declared library entry', text: USES_LIBRARY, expected: [] },
    { what: 'an undeclared name', text: USES_GHOST, expected: ['refusal graph.uses@6'] },
  ];
  test.each(uses)('$what is $expected', ({ text, expected }) => {
    expect(pairs(refusals(checked(text)))).toEqual(expected);
  });
});

describe('waits', () => {
  const waits: { what: string; text: string; expected: string[] }[] = [
    { what: 'an approval wait on a known role', text: WAIT_APPROVAL, expected: [] },
    {
      what: 'an approval wait on an unknown role',
      text: WAIT_APPROVAL_UNKNOWN,
      expected: ['refusal ref.role@6'],
    },
    // The checker resolves names, never settings: a time wait's setting is the runner's business.
    { what: 'a time wait naming a setting', text: WAIT_TIME, expected: [] },
  ];
  test.each(waits)('$what is $expected', ({ text, expected }) => {
    expect(pairs(refusals(checked(text)))).toEqual(expected);
  });
});

describe('guards and operations', () => {
  test('a guard from the closed catalogue resolves', () => {
    expect(checked(GUARD_KNOWN)).toEqual({ ok: true, findings: [] });
  });

  test('a guard that is not in the catalogue is refused at its line', () => {
    expect(pairs(refusals(checked(GUARD_UNKNOWN)))).toEqual(['refusal ref.guard@8']);
  });

  test('an effect role that does not resolve is refused', () => {
    const result = checked(EFFECT_ROLE_UNKNOWN);
    expect(pairs(refusals(result))).toEqual(['refusal ref.role@9']);
    expect(result.ok).toBe(false);
  });

  test('an operation absent from the registry is refused, not noted', () => {
    const result = checked(UNKNOWN_OPERATION);
    expect(pairs(refusals(result))).toEqual(['refusal ref.operation@8']);
    expect(notes(result)).toEqual([]);
  });

  test('a provisional operation is a note per use and never fails the check', () => {
    const result = checked(PROVISIONAL_OPERATION);
    expect(pairs(result.findings)).toEqual(['note ref.operation@8']);
    expect(result.ok).toBe(true);
  });
});

describe('annotation reach', () => {
  test('an outside-machine label on a local operation is a contradiction', () => {
    const result = checked(OUTSIDE_ON_LOCAL);
    expect(pairs(refusals(result))).toEqual(['refusal annotation.reach@8']);
    expect(result.ok).toBe(false);
  });

  test('a local label on an operation that reaches outside is a contradiction', () => {
    const result = checked(LOCAL_ON_OUTSIDE);
    expect(pairs(refusals(result))).toEqual(['refusal annotation.reach@8']);
    expect(pairs(notes(result))).toEqual(['note annotation.capability@8', 'note ref.operation@8']);
  });

  test('a matching outside-machine label is accepted, with the open capability only noted', () => {
    const result = checked(OUTSIDE_MATCH);
    expect(refusals(result)).toEqual([]);
    expect(pairs(notes(result))).toEqual(['note annotation.capability@8', 'note ref.operation@8']);
    expect(result.ok).toBe(true);
  });
});

describe('annotation capability', () => {
  test('a capability the operation does not declare is refused', () => {
    const result = checked(CAPABILITY_CONTRADICTION);
    expect(pairs(refusals(result))).toEqual(['refusal annotation.capability@8']);
    expect(pairs(notes(result))).toEqual(['note ref.operation@8']);
  });

  test("a provisional operation's empty capability list leaves the asserted word unresolved", () => {
    const result = checked(CAPABILITY_EMPTY_PROVISIONAL);
    expect(refusals(result)).toEqual([]);
    expect(pairs(notes(result))).toEqual(['note annotation.capability@8', 'note ref.operation@8']);
    expect(result.ok).toBe(true);
  });
});

describe('annotation act-as', () => {
  test('the tag sketch: act-as without a capability is a note, never a refusal (U13)', () => {
    const result = checked(U13_TAG);
    expect(refusals(result)).toEqual([]);
    expect(pairs(result.findings)).toEqual([
      'note annotation.act-as@8',
      'note annotation.capability-pending@8',
      'note ref.operation@8',
    ]);
    expect(result.ok).toBe(true);
  });

  test('a real descriptor bound to the named account accepts the effect', () => {
    const result = checked(
      realEffect(
        'publish: { run: publish, capability: deploy, role: owner, act-as: release-bot, reach: outside-machine }',
      ),
      realResolvers({ account: 'release-bot' }),
    );
    expect(result).toEqual({ ok: true, findings: [] });
  });

  test('acting as another account than the one the descriptor names is refused', () => {
    const result = checked(
      realEffect(
        'publish: { run: publish, capability: deploy, role: owner, act-as: other-bot, reach: outside-machine }',
      ),
      realResolvers({ account: 'release-bot' }),
    );
    expect(pairs(refusals(result))).toEqual(['refusal annotation.act-as@8']);
  });

  test('a real descriptor with no account refuses act-as instead of noting it', () => {
    const result = checked(
      realEffect(
        'publish: { run: publish, capability: deploy, role: owner, act-as: release-bot, reach: outside-machine }',
      ),
      realResolvers(),
    );
    expect(pairs(refusals(result))).toEqual(['refusal annotation.act-as@8']);
  });
});

describe('annotation checks against real descriptors', () => {
  test('a capability outside the real descriptor is refused', () => {
    const result = checked(
      realEffect('publish: { run: publish, capability: merge, role: owner, reach: outside-machine }'),
      realResolvers(),
    );
    expect(pairs(refusals(result))).toEqual(['refusal annotation.capability@8']);
  });

  test('a local label on a real outside-machine operation is refused', () => {
    const result = checked(
      realEffect('publish: { run: publish, capability: deploy, role: owner }'),
      realResolvers(),
    );
    expect(pairs(refusals(result))).toEqual(['refusal annotation.reach@8']);
  });

  test('an outside-machine label on a real local operation is refused', () => {
    const result = checked(
      realEffect('stamp: { run: stamp, capability: write, role: owner, reach: outside-machine }'),
      realResolvers(),
    );
    expect(pairs(refusals(result))).toEqual(['refusal annotation.reach@8']);
  });
});

describe('the findings contract', () => {
  test('findings are sorted by line then code, whatever order the rules found them in', () => {
    const result = checked(ORDERED);
    expect(pairs(result.findings)).toEqual([
      'refusal ref.role@9',
      'refusal graph.ambiguous@10',
      'refusal ref.role@10',
    ]);
    expect(result.ok).toBe(false);
  });

  test('the same definition and resolvers give the same result on a second call', () => {
    expect(checked(ORDERED)).toEqual(checked(ORDERED));
    expect(checked(ACCEPTED)).toEqual(checked(ACCEPTED));
  });

  test('a note-only result keeps ok true', () => {
    const result = checked(ORPHAN);
    expect(pairs(result.findings)).toEqual(['note graph.orphan@6']);
    expect(result.ok).toBe(true);
  });

  test('every finding names a line inside the file and carries a message', () => {
    for (const text of [INITIAL_GHOST, ON_GHOST, AMBIGUOUS, U13_TAG, ORDERED]) {
      for (const finding of checked(text).findings) {
        expect(finding.line).toBeGreaterThanOrEqual(1);
        expect(finding.line).toBeLessThanOrEqual(maxLine(text));
        expect(finding.message.length).toBeGreaterThan(0);
        expect(finding.code).toMatch(/^(schema|graph|ref|vocab|annotation)\./);
      }
    }
  });

  test('the parse arm keeps structural refusals out of the checker', () => {
    const parsed = parseWorkflow(`workflow: coverage-check
version: 1
initial: draft
states:
  draft: {}
transitions: []
verdict: pass
`);
    expect('findings' in parsed).toBe(true);
    if ('findings' in parsed) {
      expect(parsed.findings.map((finding) => finding.code)).toContain('schema.key');
      expect(parsed.findings.every((finding) => finding.level === 'refusal')).toBe(true);
    }
  });
});
