import { describe, expect, test } from 'bun:test';
import {
  classifyReporterCompatibility as classify,
  type ExpectedReporterContext,
} from '../src/status/reporter-compatibility.ts';

const launch: ExpectedReporterContext = {
  seatId: 'example-agent', incarnation: 'example-incarnation',
  cli: 'example-cli', profile: 'example-profile', reporterVersion: 7,
};

describe('reporter compatibility candidate', () => {
  test('separates equal, older and newer drift from explicit protocol support', () => {
    expect(classify(launch, launch)).toEqual({
      classification: 'current', compatibility: 'compatible', reason: 'versions_equal',
      expectedVersion: 7, observedVersion: 7,
    });
    expect(classify(launch, { ...launch, reporterVersion: 6 })).toEqual({
      classification: 'obsolete', compatibility: 'unsupported', reason: 'reporter_older',
      expectedVersion: 7, observedVersion: 6,
    });
    expect(classify(launch, { ...launch, reporterVersion: 6 }, [6, 7])).toEqual({
      classification: 'obsolete', compatibility: 'compatible', reason: 'reporter_older',
      expectedVersion: 7, observedVersion: 6,
    });
    expect(classify(launch, { ...launch, reporterVersion: 8 }, [7, 8])).toEqual({
      classification: 'newer', compatibility: 'unsupported', reason: 'reporter_newer',
      expectedVersion: 7, observedVersion: 8,
    });
    expect(classify(launch, launch, []).compatibility).toBe('unsupported');
    expect(classify(launch, launch, [6]).classification).toBe('current');
    expect(classify(launch, launch, [6]).compatibility).toBe('unsupported');
  });

  test('treats an explicit set as exact rather than a numeric range', () => {
    expect(classify(launch, { ...launch, reporterVersion: 5 }, [3, 7]).compatibility).toBe('unsupported');
    expect(classify(launch, { ...launch, reporterVersion: 3 }, [3, 7]).compatibility).toBe('compatible');
    expect(classify(launch, launch, { min: 1, max: 7 }).reason).toBe('malformed_supported_versions');
    const contiguous = Array.from({ length: 7 }, (_, index) => index + 1);
    expect(classify(launch, { ...launch, reporterVersion: 4 }, contiguous).compatibility).toBe('compatible');
  });

  test('never infers protocol version or compatibility from CLI build versions', () => {
    const expected = { ...launch, cliVersion: '100.2.0+example' };
    expect(classify(expected, { ...launch, cliVersion: '0.1.0' }).compatibility).toBe('compatible');
    expect(classify(expected, { ...launch, cliVersion: '100.2.0+example', reporterVersion: 6 }).classification).toBe('obsolete');
    const { reporterVersion: _version, ...missing } = expected;
    expect(classify(expected, missing).reason).toBe('missing_version');
    expect(classify(expected, missing).compatibility).toBe('unproven');
    expect(classify(missing, expected).reason).toBe('malformed_expected');
  });

  test('missing observations, context and versions stay unknown/unproven', () => {
    for (const observed of [undefined, null]) {
      expect(classify(launch, observed)).toEqual({
        classification: 'unknown', compatibility: 'unproven', reason: 'missing_observation',
        expectedVersion: 7, observedVersion: null,
      });
    }
    for (const field of ['seatId', 'incarnation', 'cli', 'profile']) {
      const observed: Record<string, unknown> = { ...launch };
      delete observed[field];
      expect(classify(launch, observed).reason).toBe('missing_context');
      expect(classify(launch, observed).compatibility).toBe('unproven');
    }
    const { reporterVersion: _version, ...context } = launch;
    expect(classify(launch, context).reason).toBe('missing_version');
    expect(classify(launch, { ...context, reporterVersion: undefined }).classification).toBe('unknown');
    expect(classify(launch, {}).classification).toBe('unknown');
  });

  test('all launch context tokens must match before a current reporter can be returned', () => {
    for (const field of ['seatId', 'incarnation', 'cli', 'profile']) {
      expect(classify(launch, { ...launch, [field]: 'example-foreign' })).toEqual({
        classification: 'refused', compatibility: 'unproven', reason: 'context_mismatch',
        expectedVersion: null, observedVersion: null,
      });
    }
  });

  test('protocol versions are positive safe integers without coercion', () => {
    const invalid: unknown[] = [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '7', '', null, true, 7n, {}, []];
    for (const reporterVersion of invalid) {
      expect(classify({ ...launch, reporterVersion }, launch).reason).toBe('malformed_expected');
      expect(classify(launch, { ...launch, reporterVersion }).reason).toBe('malformed_observation');
      expect(classify(launch, launch, [reporterVersion]).reason).toBe('malformed_supported_versions');
    }
    expect(classify({ ...launch, reporterVersion: Number.MAX_SAFE_INTEGER }, {
      ...launch, reporterVersion: Number.MAX_SAFE_INTEGER,
    }).compatibility).toBe('compatible');
    expect(classify({ ...launch, reporterVersion: 1 }, { ...launch, reporterVersion: 1 }).classification).toBe('current');
  });

  test('valid tokens never collide with parser error sentinels and invalid tokens refuse', () => {
    for (const field of ['seatId', 'incarnation', 'cli', 'profile']) {
      const valid = { ...launch, [field]: 'bad' };
      expect(classify(valid, valid).compatibility).toBe('compatible');
      const boundary = { ...launch, [field]: 'x'.repeat(64) };
      expect(classify(boundary, boundary).classification).toBe('current');
      for (const value of ['', 'x'.repeat(65), 'example value', 'example\n', 'é', null, 1]) {
        expect(classify(launch, { ...launch, [field]: value }).reason).toBe('malformed_observation');
        expect(classify({ ...launch, [field]: value }, launch).reason).toBe('malformed_expected');
      }
    }
  });

  test('malformed build-version metadata refuses instead of supplying protocol facts', () => {
    for (const cliVersion of ['', 'x'.repeat(129), 'example\n', 'é', {}, 7, null]) {
      expect(classify({ ...launch, cliVersion }, launch).reason).toBe('malformed_expected');
      expect(classify(launch, { ...launch, cliVersion }).reason).toBe('malformed_observation');
    }
  });

  test('rejects unknown properties, symbols, inherited metadata and host object shapes', () => {
    const hidden = Object.defineProperty({ ...launch }, 'rawText', { value: 'example-private' });
    const symbol = { ...launch, [Symbol('example-private')]: 'example-private' };
    const inherited = Object.create(launch);
    for (const value of [false, 1, 'example', [], new Date(0), { ...launch, rawText: 'example-private' }, hidden, symbol, inherited]) {
      expect(classify(value, launch).reason).toBe('malformed_expected');
      expect(classify(launch, value).reason).toBe('malformed_observation');
    }
    const nullPrototype = Object.assign(Object.create(null), launch);
    expect(classify(nullPrototype, nullPrototype).classification).toBe('current');
  });

  test('refuses accessors without invoking them and contains proxy inspection exceptions', () => {
    let reads = 0;
    const accessor = Object.defineProperty({ ...launch }, 'seatId', {
      get() { reads++; throw new Error('example-private-error'); },
    });
    expect(classify(accessor, launch).reason).toBe('malformed_expected');
    expect(classify(launch, accessor).reason).toBe('malformed_observation');
    const changing = Object.defineProperty({ ...launch }, 'reporterVersion', {
      get() { reads++; return reads === 1 ? 7 : 8; },
    });
    expect(classify(launch, changing).classification).toBe('refused');
    expect(reads).toBe(0);
    const throwing = new Proxy({}, { ownKeys() { throw new Error('example-private-error'); } });
    expect(classify(throwing, launch).reason).toBe('malformed_metadata');
    expect(classify(launch, throwing).reason).toBe('malformed_metadata');
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(classify(launch, revocable.proxy).classification).toBe('refused');
    expect(JSON.stringify(classify(launch, throwing))).not.toContain('example-private-error');
  });

  test('validates dense bounded support sets and never reads support entry getters', () => {
    let reads = 0;
    const accessor = Object.defineProperty([7], '0', { get() { reads++; return 7; } });
    const extra = Object.assign([7], { extra: 'example' });
    const symbol = Object.assign([7], { [Symbol('example')]: 7 });
    const invalid: unknown[] = [null, {}, '7', new Set([7]), [7, 7], [undefined], new Array(1), extra, symbol, accessor, Array.from({ length: 65 }, (_, index) => index + 1)];
    for (const set of invalid) {
      expect(classify(launch, launch, set).reason).toBe('malformed_supported_versions');
    }
    expect(reads).toBe(0);
    const maximum = Array.from({ length: 64 }, (_, index) => index + 1);
    expect(classify(launch, launch, maximum).compatibility).toBe('compatible');
    const throwing = new Proxy([], { getOwnPropertyDescriptor() { throw new Error('example-private-error'); } });
    expect(classify(launch, launch, throwing).reason).toBe('malformed_metadata');
  });

  test('returns only closed enum and numeric facts and keeps results and inputs immutable', () => {
    const expected = Object.freeze({ ...launch, cliVersion: 'example-build-secret' });
    const observed = Object.freeze({ ...launch, reporterVersion: 6 });
    const supported = Object.freeze([6, 7]);
    const before = JSON.stringify({ expected, observed, supported });
    const result = classify(expected, observed, supported);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.set(result, 'classification', 'current')).toBe(false);
    expect(result.classification).toBe('obsolete');
    expect(JSON.stringify({ expected, observed, supported })).toBe(before);
    expect(Object.keys(result).sort()).toEqual([
      'classification', 'compatibility', 'expectedVersion', 'observedVersion', 'reason',
    ]);
    for (const output of [result, classify(expected, { ...observed, seatId: 'example-secret-identity' }), classify(expected, { ...observed, rawText: 'example-secret-payload' })]) {
      const serialized = JSON.stringify(output);
      for (const secret of ['example-secret', 'example-build-secret', 'example-agent', 'example-incarnation', 'example-cli', 'example-profile']) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toContain('dispatch');
      expect(serialized).not.toContain('authenticated');
      expect(Object.isFrozen(output)).toBe(true);
    }
  });
});
