// The dry script reader: the accepted two-cycle document, the closed key sets, and the refusals
// that belong to the reader rather than to the runner (a missing setting or evidence ref is the
// runner's stop, never a script error).

import { describe, expect, test } from 'bun:test';
import { readScript } from '../../../src/workflow/dry/script.ts';

const SCRIPT = `format: 1
target: floor/teamcli
artifact: { kind: none }
settings:
  ready-at: '2026-10-21T12:00:00Z'
  rest-at: '2026-10-21T18:00:00Z'
inputs: {}
evidence:
  timer-1: { type: timer }
  timer-2: { type: timer }
  timer-3: { type: timer }
signals:
  - { signal: time-reached, at: '2026-10-21T18:00:00Z', request-id: req-1, expected-revision: 0, evidence: [timer-1] }
  - { signal: time-reached, at: '2026-10-22T06:00:00Z', request-id: req-2, expected-revision: 1, evidence: [timer-2] }
  - { signal: time-reached, at: '2026-10-22T18:00:00Z', request-id: req-3, expected-revision: 2, evidence: [timer-3] }
`;

function refusal(text: string): { code: string; why: string } {
  const result = readScript(text);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('the script was accepted');
  return result;
}

describe('dry script reader', () => {
  test('reads the accepted two-cycle script whole', () => {
    const result = readScript(SCRIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const script = result.script;
    expect(script.format).toBe(1);
    expect(script.target).toBe('floor/teamcli');
    expect(script.artifact).toEqual({ kind: 'none' });
    expect(script.settings).toEqual({
      'ready-at': '2026-10-21T12:00:00Z',
      'rest-at': '2026-10-21T18:00:00Z',
    });
    expect(script.inputs).toEqual({});
    expect(script.evidence).toEqual({
      'timer-1': { type: 'timer' },
      'timer-2': { type: 'timer' },
      'timer-3': { type: 'timer' },
    });
    expect(script.signals).toEqual([
      {
        signal: 'time-reached',
        at: '2026-10-21T18:00:00Z',
        requestId: 'req-1',
        expectedRevision: 0,
        evidence: ['timer-1'],
      },
      {
        signal: 'time-reached',
        at: '2026-10-22T06:00:00Z',
        requestId: 'req-2',
        expectedRevision: 1,
        evidence: ['timer-2'],
      },
      {
        signal: 'time-reached',
        at: '2026-10-22T18:00:00Z',
        requestId: 'req-3',
        expectedRevision: 2,
        evidence: ['timer-3'],
      },
    ]);
  });

  test('accepts an empty evidence block and an empty signal list', () => {
    const result = readScript(`format: 1
target: floor/teamcli
artifact: { kind: none }
settings: {}
inputs: {}
evidence: {}
signals: []
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.script.signals).toEqual([]);
  });

  test('reads a ref artifact and keeps nested fixture fields', () => {
    const result = readScript(`format: 1
target: floor/teamcli
artifact: { kind: ref, value: v0.5.4 }
settings: {}
inputs: { note: dry }
evidence:
  gate-1: { type: gate, target: floor/teamcli, nested: { detail: [a, b] } }
signals: []
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.script.artifact).toEqual({ kind: 'ref', value: 'v0.5.4' });
    expect(result.script.inputs).toEqual({ note: 'dry' });
    expect(result.script.evidence['gate-1']).toEqual({
      type: 'gate',
      target: 'floor/teamcli',
      nested: { detail: ['a', 'b'] },
    });
  });

  test('refuses an unknown key', () => {
    const problem = refusal(SCRIPT.replace('format: 1', 'format: 1\nrun: run-1'));
    expect(problem.code).toBe('workflow.script');
    expect(problem.why).toContain('unknown key "run"');
  });

  test('refuses a missing key', () => {
    const problem = refusal(SCRIPT.replace('inputs: {}\n', ''));
    expect(problem.code).toBe('workflow.script');
    expect(problem.why).toContain('missing "inputs"');
  });

  test('refuses a format other than 1', () => {
    const problem = refusal(SCRIPT.replace('format: 1', 'format: 2'));
    expect(problem.code).toBe('workflow.script');
    expect(problem.why).toContain('format must be the integer 1');
  });

  test('refuses an unknown signal name', () => {
    const problem = refusal(SCRIPT.replace('signal: time-reached', 'signal: release-done'));
    expect(problem.code).toBe('workflow.script');
    expect(problem.why).toContain('is not a transition signal');
  });

  test('refuses an unknown key on a signal entry', () => {
    const problem = refusal(SCRIPT.replace('request-id: req-1', 'request-id: req-1, role: lead'));
    expect(problem.code).toBe('workflow.script');
    expect(problem.why).toContain('unknown key "role"');
  });

  test('refuses a negative or fractional expected revision', () => {
    const negative = refusal(SCRIPT.replace('expected-revision: 0', 'expected-revision: -1'));
    expect(negative.code).toBe('workflow.script');
    expect(negative.why).toContain('must be an integer >= 0');
    const fractional = refusal(SCRIPT.replace('expected-revision: 0', 'expected-revision: 0.5'));
    expect(fractional.code).toBe('workflow.script');
    expect(fractional.why).toContain('must be an integer >= 0');
  });

  test('refuses an artifact kind outside none/ref/tree', () => {
    const problem = refusal(SCRIPT.replace('{ kind: none }', '{ kind: branch }'));
    expect(problem.code).toBe('workflow.script');
    expect(problem.why).toContain('must be "none", "ref" or "tree"');
  });

  test('refuses a settings value that is not a string', () => {
    const problem = refusal(SCRIPT.replace("'2026-10-21T12:00:00Z'", '12'));
    expect(problem.code).toBe('workflow.script');
    expect(problem.why).toContain('settings.ready-at must be a string');
  });

  test('refuses a duplicate key', () => {
    const problem = refusal(SCRIPT.replace('target: floor/teamcli', 'target: floor/teamcli\ntarget: floor/teamcli'));
    expect(problem.code).toBe('workflow.script');
    expect(problem.why).toContain('duplicate key "target"');
  });

  test('refuses an evidence fixture that is not a mapping', () => {
    const problem = refusal(SCRIPT.replace('timer-1: { type: timer }', 'timer-1: timer'));
    expect(problem.code).toBe('workflow.evidence');
    expect(problem.why).toContain('evidence.timer-1 must be a mapping');
  });
});
