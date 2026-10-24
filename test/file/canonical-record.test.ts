import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANONICAL_RECORD_VERSION,
  CanonicalRecordError,
  canonicalRecord,
  canonicalRecordBytes,
  teamRecordOf,
} from '../../src/file/canonical-record.ts';
import { approvedRecordOf } from '../../src/store/store.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'canonical-record');

/** The same value with every object's keys in reverse order, recursively. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, reversed(v)]));
  }
  return value;
}

describe('canonical record (team-record-c14n-v1, frozen)', () => {
  test('the version tag is frozen', () => {
    expect(CANONICAL_RECORD_VERSION).toBe('team-record-c14n-v1');
  });

  test('reordered keys give identical bytes, at every depth', () => {
    const one = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } };
    const two = { a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(canonicalRecordBytes(one).equals(canonicalRecordBytes(two))).toBe(true);
    expect(canonicalRecord(one)).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden-input.json'), 'utf8'));
    expect(canonicalRecord(reversed(golden))).toBe(canonicalRecord(golden));
  });

  test('array order is meaning', () => {
    expect(canonicalRecord([1, 2])).not.toBe(canonicalRecord([2, 1]));
  });

  test('undefined members are omitted; null is kept and distinct', () => {
    expect(canonicalRecord({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalRecord({ a: null, b: 1 })).toBe('{"a":null,"b":1}');
    expect(() => canonicalRecord([1, undefined])).toThrow(CanonicalRecordError);
    expect(() => canonicalRecord(undefined)).toThrow(CanonicalRecordError);
  });

  test('numbers: shortest form, -0 is 0, non-finite refused', () => {
    expect(canonicalRecord([3.0, 0.5, -0, 1e21, -2])).toBe('[3,0.5,0,1e+21,-2]');
    for (const bad of [NaN, Infinity, -Infinity]) expect(() => canonicalRecord({ n: bad })).toThrow(CanonicalRecordError);
  });

  test('strings and keys are NFC; colliding keys and lone surrogates refused', () => {
    expect(canonicalRecord({ 'cafe\u0301': 'e\u0301' })).toBe(canonicalRecord({ 'caf\u00e9': '\u00e9' }));
    expect(() => canonicalRecord({ 'caf\u00e9': 1, 'cafe\u0301': 2 })).toThrow(CanonicalRecordError);
    expect(() => canonicalRecord({ s: '\uD800' })).toThrow(CanonicalRecordError);
    expect(canonicalRecord({ s: '\uD83D\uDE00' })).toBe('{"s":"😀"}');
  });

  test('keys sort by code point, not locale', () => {
    expect(canonicalRecord({ b: 1, B: 2, é: 3, '\u{1F600}': 4, '\uFFFF': 5 })).toBe('{"B":2,"b":1,"é":3,"\uFFFF":5,"\u{1F600}":4}');
  });

  test('only plain JSON values have a form', () => {
    expect(() => canonicalRecord({ d: new Date(0) })).toThrow(CanonicalRecordError);
    expect(() => canonicalRecord({ m: new Map() })).toThrow(CanonicalRecordError);
    expect(() => canonicalRecord({ n: 1n })).toThrow(CanonicalRecordError);
    expect(() => canonicalRecord({ f: () => 1 })).toThrow(CanonicalRecordError);
    expect(canonicalRecord(Object.assign(Object.create(null), { a: 1 }))).toBe('{"a":1}');
  });

  test('a team record drops only the seats\' source positions', () => {
    expect(teamRecordOf({ project: 'p', seats: [{ name: 'a', line: 3 }] })).toEqual({ project: 'p', seats: [{ name: 'a' }] });
  });

  test('golden fixture: the frozen bytes', () => {
    const input = JSON.parse(readFileSync(join(FIXTURES, 'golden-input.json'), 'utf8'));
    const golden = readFileSync(join(FIXTURES, 'golden.canonical'));
    expect(canonicalRecordBytes(teamRecordOf(input)).equals(golden)).toBe(true);
    expect(createHash('sha256').update(golden).digest('hex')).toBe(GOLDEN_SHA256);
  });

  test('a team file reordered and reformatted is the same record', () => {
    const text = readFileSync(join(import.meta.dir, '..', 'fixtures', 'example.yaml'), 'utf8');
    const lines = text.split('\n');
    // Move the `tools:` block below everything else and drop the comments' padding.
    const start = lines.findIndex((line) => line === 'tools:');
    const end = lines.findIndex((line, index) => index > start && line === '');
    const moved = [...lines.slice(0, start), ...lines.slice(end + 1), '', ...lines.slice(start, end), ''].join('\n');
    expect(moved).not.toBe(text);
    const record = approvedRecordOf(text);
    expect(record).not.toBeNull();
    expect(approvedRecordOf(moved)).toBe(record);
    expect(approvedRecordOf(text.replace('project: acme-web', 'project: acme-api'))).not.toBe(record);
    expect(record).toBe(readFileSync(join(FIXTURES, 'example.canonical.json'), 'utf8'));
  });
});

const GOLDEN_SHA256 = '45e20d48ca08c54aa85cc0dd42d4a06c36b9950bc29a5617357b21931f4b2eaa';
