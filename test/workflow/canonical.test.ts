import { describe, expect, test } from 'bun:test';
import {
  canonicalEffectPayload,
  canonicalJson,
  canonicalRequestPayload,
  definitionDigest,
  definitionId,
  nextActivation,
  occurrenceId,
  payloadDigest,
} from '../../src/workflow/canonical.ts';
import type { Workflow } from '../../src/workflow/types.ts';

describe('canonicalJson', () => {
  test('sorts keys recursively and emits no whitespace', () => {
    const value = { b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } };
    expect(canonicalJson(value)).toBe('{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}');
  });

  test('preserves array order and drops undefined object members', () => {
    expect(canonicalJson({ a: [3, 1, 2], b: 1, c: undefined })).toBe('{"a":[3,1,2],"b":1}');
  });

  test('a non-JSON value is refused rather than coerced', () => {
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });
});

describe('identities', () => {
  test('nextActivation is the one allocator, by one', () => {
    expect(nextActivation(1)).toBe(2);
    expect(nextActivation(2)).toBe(3);
  });

  test('an occurrence id is run/activation/effect', () => {
    expect(occurrenceId('run-1', 2, 'tag')).toBe('run-1/2/tag');
  });

  test('the request payload is exactly move/target/artifact/evidence, key order irrelevant', () => {
    const first = {
      move: { operation: { name: 'release-tag' } } as const,
      target: 'v0.5.4',
      artifact: { kind: 'ref', value: 'sha' } as const,
      evidence: ['ev-1'],
    };
    const second = {
      evidence: ['ev-1'],
      artifact: { kind: 'ref', value: 'sha' } as const,
      target: 'v0.5.4',
      move: { operation: { name: 'release-tag' } } as const,
    };
    expect(canonicalRequestPayload(first)).toBe(canonicalRequestPayload(second));
    expect(canonicalRequestPayload(first)).toBe(
      '{"artifact":{"kind":"ref","value":"sha"},"evidence":["ev-1"],"move":{"operation":{"name":"release-tag"}},"target":"v0.5.4"}',
    );
  });

  test('the effect payload is effect/operation/target/artifact', () => {
    expect(canonicalEffectPayload('tag', 'release-tag', 'v0.5.4', { kind: 'none' })).toBe(
      '{"artifact":{"kind":"none"},"effect":"tag","operation":"release-tag","target":"v0.5.4"}',
    );
  });

  test('the digest is a sha256 pin over the canonical bytes', () => {
    const digest = payloadDigest('{"a":1}');
    expect(digest).toStartWith('sha256:');
    expect(digest).toHaveLength('sha256:'.length + 64);
    expect(payloadDigest('{"a":1}')).toBe(digest);
    expect(payloadDigest('{"a":2}')).not.toBe(digest);
  });
});

describe('definition pinning', () => {
  test('CRLF normalizes to LF', () => {
    expect(definitionDigest('a\r\nb\r\n')).toBe(definitionDigest('a\nb\n'));
    expect(definitionDigest('a\nb\n')).not.toBe(definitionDigest('a\nb'));
  });

  test('the definition id carries the workflow name, schema version and digest', () => {
    const workflow = { name: 'release' } as Workflow;
    const id = definitionId(workflow, 'workflow: release\n');
    expect(id).toEqual({ workflow: 'release', schemaVersion: 1, digest: definitionDigest('workflow: release\n') });
  });
});
