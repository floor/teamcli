import { describe, expect, test } from 'bun:test';
import { DECISION_CODES, DECISION_KINDS } from '../../src/workflow/codes.ts';

describe('the one decision table', () => {
  test('the four kinds, in order', () => {
    expect(DECISION_KINDS).toEqual(['step', 'duplicate', 'held', 'refused']);
  });

  test('the frozen code set, one spelling each', () => {
    const codes: string[] = Object.values(DECISION_CODES);
    const expected: string[] = [
      'core.request-conflict',
      'core.revision-stale',
      'core.ledger-head-conflict',
      'core.occurrence-payload-conflict',
      'core.guard-unknown',
      'core.guard-refused',
      'core.evidence-ambiguous',
      'core.evidence-non-authoritative',
      'core.wait-not-reached',
      'core.wait-pending',
      'core.entry-effect-failed',
      'core.run-mismatch',
      'core.definition-mismatch',
      'evidence.missing',
      'evidence.corrupt',
      'evidence.unknown',
      'settings.missing',
      'workflow.uses-deferred',
    ];
    expect([...codes].sort()).toEqual([...expected].sort());
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('the envelope identity checks have their exact keys and codes', () => {
    expect(DECISION_CODES.runMismatch).toBe('core.run-mismatch');
    expect(DECISION_CODES.definitionMismatch).toBe('core.definition-mismatch');
  });

  test('missing supplied evidence has exactly one spelling', () => {
    expect(DECISION_CODES.evidenceMissing).toBe('evidence.missing');
    expect(Object.values(DECISION_CODES)).not.toContain('core.evidence-missing');
  });

  test('the ambiguity code is the frozen core.evidence-ambiguous', () => {
    expect(DECISION_CODES.evidenceAmbiguous).toBe('core.evidence-ambiguous');
  });
});
