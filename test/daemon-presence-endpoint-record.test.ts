// The recorded Codex endpoint has one strict, pure door, and these tests pin its bytes: the
// record is usable only while its binding equals the seat's current presence binding, its URL is
// an absolute `unix:///…` endpoint, and its pid and start instant are ones a managed launch could
// have written. A caller that reports what it found is told absent from invalid; nothing here
// reads a process, a socket or a CLI home — the reader is pure, and so are these scenes.
import { describe, expect, test } from 'bun:test';
import {
  codexEndpointPath,
  inspectRecordedCodexEndpoint,
  readCodexEndpointRecord,
  readRecordedCodexEndpoint,
  type CodexEndpointRecord,
} from '../src/daemon/presence/endpoint-record.ts';

const BINDING = 'prs_0123456789ab';
const OTHER = 'prs_fedcba987654';
const T0 = '2026-10-01T10:00:00.000Z';
const URL = 'unix:///private/tmp/team/presence/teamcli/seat/builder-4/app.sock';

function record(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { url: URL, binding: BINDING, pid: 4242, started_at: T0, ...extra };
}

function ok(value: unknown, binding: unknown = BINDING): CodexEndpointRecord {
  const read = inspectRecordedCodexEndpoint(value, binding);
  expect(read.kind).toBe('ok');
  if (read.kind !== 'ok') throw new Error('expected a usable record');
  return read.record;
}

describe('the endpoint record reader', () => {
  test('reads a record exactly as a managed launch writes it', () => {
    const one = ok(record());
    expect(one).toEqual({ url: URL, binding: BINDING, pid: 4242, started_at: T0 });
    expect(codexEndpointPath(one)).toBe('/private/tmp/team/presence/teamcli/seat/builder-4/app.sock');
  });

  test('tells an absent record from an invalid one', () => {
    expect(inspectRecordedCodexEndpoint(undefined, BINDING)).toEqual({ kind: 'absent' });
    expect(inspectRecordedCodexEndpoint(null, BINDING)).toEqual({ kind: 'absent' });
    // An absent record on a seat with no valid binding is still absent: nothing was written.
    expect(inspectRecordedCodexEndpoint(undefined, undefined)).toEqual({ kind: 'absent' });

    const invalid = inspectRecordedCodexEndpoint('not a record', BINDING);
    expect(invalid.kind).toBe('invalid');
    if (invalid.kind !== 'invalid') throw new Error('expected a refusal');
    expect(invalid.why).toBe('the endpoint record is not an object');
    // An array is an object; it is still not a record.
    expect(inspectRecordedCodexEndpoint([record()], BINDING).kind).toBe('invalid');
  });

  test('refuses every URL that is not an absolute unix endpoint', () => {
    for (const url of [
      'http://127.0.0.1:4242',
      'ws://127.0.0.1:4242',
      'unix://relative/app.sock',
      'unix://',
      '/private/tmp/app.sock',
      'unix:///private/tmp/a\u0000b.sock',
      'unix:///private/tmp/a\nb.sock',
    ]) {
      const read = inspectRecordedCodexEndpoint(record({ url }), BINDING);
      expect(read.kind).toBe('invalid');
      if (read.kind !== 'invalid') throw new Error('expected a refusal');
      expect(read.why).toBe('the endpoint record’s URL is not an absolute unix endpoint');
    }
  });

  test('refuses a pid or start instant a launch could not have written', () => {
    for (const extra of [
      { pid: 0 },
      { pid: -1 },
      { pid: 4.5 },
      { pid: '4242' },
      { pid: Number.MAX_SAFE_INTEGER + 2 },
      { started_at: '' },
      { started_at: 'not a time' },
      // The contract's own spelling is required; a value with no zone or no calendar day is out.
      { started_at: '2026-10-01T10:00:00' },
      { started_at: '2026-02-30T00:00:00.000Z' },
      { binding: 'binding' },
      { binding: OTHER.toUpperCase() },
    ]) {
      expect(inspectRecordedCodexEndpoint(record(extra), BINDING).kind).toBe('invalid');
    }
  });

  test('the current binding must equal the record’s, and both must be valid', () => {
    // A record for another binding is a predecessor incarnation: unknown to a consumer.
    expect(readRecordedCodexEndpoint(record(), OTHER)).toBeNull();
    expect(inspectRecordedCodexEndpoint(record(), OTHER)).toEqual({
      kind: 'invalid',
      why: 'the endpoint record names another presence binding',
    });
    // A seat with no valid current binding has no usable endpoint, whatever it records.
    expect(readRecordedCodexEndpoint(record(), undefined)).toBeNull();
    expect(inspectRecordedCodexEndpoint(record(), 'not a binding')).toEqual({
      kind: 'invalid',
      why: 'the seat records no valid current presence binding',
    });
    expect(readRecordedCodexEndpoint(record(), BINDING)).toEqual(ok(record(), BINDING));
  });

  test('the launch’s shape reader does not judge which binding is current', () => {
    // The launch reads a predecessor by shape only; it still refuses a record no launch wrote.
    expect(readCodexEndpointRecord(record({ binding: OTHER }))?.binding).toBe(OTHER);
    expect(readCodexEndpointRecord(record({ binding: 'nope' }))).toBeNull();
    expect(readCodexEndpointRecord(undefined)).toBeNull();
  });
});
