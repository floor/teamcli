// The presence vocabulary is literal: four state words, four source words, four canonical events
// and one mapping. These tests pin the bytes, the refusal of anything this build cannot mean, and
// the reader-side rules that keep a state from expiring by elapsed time. No file outside the
// temporary folder is written, and nothing here reads a screen, a pane or a CLI home.
import { describe, expect, test } from 'bun:test';
import { basename, dirname, join } from 'node:path';
import {
  PRESENCE_EVENTS, PRESENCE_FORMAT, PRESENCE_FUTURE_SKEW_MS, PRESENCE_SOURCES, PRESENCE_STATE_OF,
  PRESENCE_STATES, PRESENCE_WRITER_SOURCES, isPresenceBinding, isPresenceEvent, isPresenceTime,
  mintPresenceBinding, presenceFutureBeyond, presenceId, presenceLive, presenceNewer,
  presenceRecordOf, readPresenceLogLine, readPresenceReading, readPresenceRecord, readPresenceStatus,
  type PresenceLogLine, type PresenceReading,
} from '../src/daemon/presence/contract.ts';
import {
  isPresenceSeatName, presencePaths, presenceSessionDir, presenceSessionFolder, presenceStatusPath,
} from '../src/daemon/presence/spool.ts';
import { cliHookStatePath } from '../src/launch/cli-hook.ts';

const SESSION = 'teamcli';
const SEAT = 'builder-4';
const BINDING = 'prs_0123456789ab';
const OTHER = 'prs_fedcba987654';
const T0 = '2026-10-01T10:00:00.000Z';

function record(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, id: `${T0}-00000001`, ts: T0, session: SESSION, seat: SEAT,
    binding: BINDING, source: 'runtime-hook', event: 'turn-start', ...extra,
  };
}

function line(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...record(), seq: 1, observedAt: T0, state: 'working', applied: true, ...extra };
}

function reading(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...line(), since: T0, ...extra };
}

describe('presence vocabulary', () => {
  test('the four state words, four source words and four events are exactly these bytes', () => {
    expect([...PRESENCE_STATES]).toEqual(['working', 'idle', 'waiting-for-a-person', 'gone']);
    expect([...PRESENCE_SOURCES]).toEqual(['runtime-hook', 'runtime-event', 'daemon-launch', 'terminal-host']);
    expect([...PRESENCE_WRITER_SOURCES]).toEqual(['runtime-hook', 'runtime-event', 'daemon-launch']);
    expect([...PRESENCE_EVENTS]).toEqual(['turn-start', 'turn-end', 'human-wait', 'session-end']);
  });

  test('each event maps to one state and the format is 1', () => {
    expect(PRESENCE_STATE_OF).toEqual({
      'turn-start': 'working', 'turn-end': 'idle', 'human-wait': 'waiting-for-a-person', 'session-end': 'gone',
    });
    expect(PRESENCE_FORMAT).toBe(1);
  });

  test('terminal-host is a label a reader may apply, never a source a writer may stage', () => {
    expect(presenceRecordOf({
      ts: T0, session: SESSION, seat: SEAT, binding: BINDING,
      // @ts-expect-error terminal-host is not a writer source.
      source: 'terminal-host', event: 'turn-end',
    })).toBeNull();
    expect(readPresenceRecord(JSON.stringify(record({ source: 'terminal-host' }))).kind).toBe('bad');
  });
});

describe('the record a runtime writes', () => {
  test('a complete record is accepted with its id derived from the event instant', () => {
    const made = presenceRecordOf({
      ts: T0, session: SESSION, seat: SEAT, binding: BINDING, source: 'runtime-hook',
      event: 'turn-start', raw: 'UserPromptSubmit',
    });
    expect(made).not.toBeNull();
    expect(made!.id).toMatch(/^2026-10-01T10:00:00\.000Z-[0-9a-f]{8}$/);
    expect(made!.v).toBe(1);
    expect(readPresenceRecord(JSON.stringify(made))).toEqual({ kind: 'ok', record: made! });
  });

  test('a supplied id is kept, so a replay has the same bytes', () => {
    const id = `${T0}-deadbeef`;
    const made = presenceRecordOf({
      ts: T0, session: SESSION, seat: SEAT, binding: BINDING, source: 'runtime-event',
      event: 'turn-end', id,
    });
    expect(made!.id).toBe(id);
  });

  test('an id that does not embed the record time is refused, so the id cannot lie', () => {
    const other = '2026-10-01T10:00:09.000Z-deadbeef';
    expect(presenceRecordOf({
      ts: T0, session: SESSION, seat: SEAT, binding: BINDING, source: 'runtime-hook',
      event: 'turn-start', id: other,
    })).toBeNull();
    expect(readPresenceRecord(JSON.stringify(record({ id: other }))).kind).toBe('bad');
    expect('why' in readPresenceLogLine(JSON.stringify(line({ id: other })))).toBe(true);
  });

  test('a binding is prs_ and twelve lowercase hex, minted fresh', () => {
    expect(isPresenceBinding(BINDING)).toBe(true);
    expect(isPresenceBinding('prs_0123456789AB')).toBe(false);
    expect(isPresenceBinding('prs_0123456789a')).toBe(false);
    expect(isPresenceBinding('0123456789ab')).toBe(false);
    const minted = mintPresenceBinding();
    expect(isPresenceBinding(minted)).toBe(true);
    expect(minted).not.toBe(mintPresenceBinding());
  });

  test('a record with a field the contract does not allow is refused whole', () => {
    for (const extra of [
      { v: 2 },
      { id: 'nope' },
      { ts: '2026-10-01 10:00:00' },
      { ts: T0.replace('Z', '+00:00') },
      { session: '' },
      { seat: '' },
      { binding: 'prs_xxxxxxxxxxxx' },
      { source: 'screen' },
      { event: 'thinking' },
      { raw: '' },
      { raw: 'x'.repeat(81) },
    ]) {
      expect(readPresenceRecord(JSON.stringify(record(extra))).kind).toBe('bad');
    }
    expect(readPresenceRecord('not json').kind).toBe('bad');
    expect(readPresenceRecord('[]').kind).toBe('bad');
  });

  test('the event time is UTC with a trailing Z and at most milliseconds', () => {
    expect(isPresenceTime(T0)).toBe(true);
    expect(isPresenceTime('2026-10-01T10:00:00Z')).toBe(true);
    expect(isPresenceTime('2026-10-01T10:00:00.12Z')).toBe(true);
    expect(isPresenceTime('2026-10-01T10:00:00.1234Z')).toBe(false);
    expect(isPresenceTime('2026-10-01T10:00:00+00:00')).toBe(false);
    expect(isPresenceTime('2026-02-30T10:00:00.000Z')).toBe(false);
    expect(isPresenceTime('2025-02-29T10:00:00.000Z')).toBe(false);
    expect(isPresenceTime('2024-02-29T10:00:00.000Z')).toBe(true);
    expect(isPresenceTime('2026-10-01T24:00:00.000Z')).toBe(false);
    expect(isPresenceTime(undefined)).toBe(false);
  });

  test('an event too far ahead of the daemon clock is refused; a near-future one is not', () => {
    const now = new Date('2026-10-01T10:00:00.000Z');
    const near = new Date(now.getTime() + PRESENCE_FUTURE_SKEW_MS - 1).toISOString();
    const far = new Date(now.getTime() + PRESENCE_FUTURE_SKEW_MS + 1).toISOString();
    expect(presenceFutureBeyond(near, now)).toBe(false);
    expect(presenceFutureBeyond(far, now)).toBe(true);
    expect(presenceFutureBeyond('garbage', now)).toBe(true);
    // A past event is never refused for its age.
    expect(presenceFutureBeyond('2020-01-01T00:00:00.000Z', now)).toBe(false);
  });

  test('presenceId pins the nonce bytes and refuses a non-UTC instant', () => {
    expect(presenceId(T0, '0a0b0c0d')).toBe(`${T0}-0a0b0c0d`);
    expect(presenceId(T0, '0A0B0C0D')).toBeNull();
    expect(presenceId(T0, 'abc')).toBeNull();
    expect(presenceId('yesterday', '0a0b0c0d')).toBeNull();
  });
});

describe('ordering', () => {
  test('milliseconds order numerically, not lexically', () => {
    const whole = { ts: '2026-10-01T10:00:00Z', id: 'a' };
    const half = { ts: '2026-10-01T10:00:00.500Z', id: 'a' };
    expect(presenceNewer(half, whole)).toBe(true);
    expect(presenceNewer(whole, half)).toBe(false);
  });

  test('the same instant is ordered by id and equality is not newer', () => {
    const a = { ts: T0, id: `${T0}-00000001` };
    const b = { ts: T0, id: `${T0}-00000002` };
    expect(presenceNewer(b, a)).toBe(true);
    expect(presenceNewer(a, b)).toBe(false);
    expect(presenceNewer(a, { ...a })).toBe(false);
  });
});

describe('the log line and the projection', () => {
  test('a log line carries seq, observedAt and the state of its event', () => {
    const read = readPresenceLogLine(JSON.stringify(line()));
    expect('why' in read).toBe(false);
    expect((read as PresenceLogLine).seq).toBe(1);
  });

  test('a log line whose state is not its event mapping is refused', () => {
    const read = readPresenceLogLine(JSON.stringify(line({ state: 'idle' })));
    expect('why' in read).toBe(true);
  });

  test('seq is a positive integer and applied is a boolean', () => {
    for (const seq of [0, -1, 1.5, '1', null]) {
      expect('why' in readPresenceLogLine(JSON.stringify(line({ seq })))).toBe(true);
    }
    for (const applied of [undefined, 'true', 1, null]) {
      expect('why' in readPresenceLogLine(JSON.stringify(line({ applied })))).toBe(true);
    }
  });

  test('a projection is read with since equal to its event instant', () => {
    const read = readPresenceReading(JSON.stringify(reading({ event: 'turn-end', state: 'idle' })));
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.reading.since).toBe(T0);
  });

  test('a projection whose since is the ingest instant is refused, not half-read', () => {
    expect(readPresenceReading(JSON.stringify(reading({ since: '2026-10-01T10:00:09.000Z' }))).kind).toBe('bad');
    expect(readPresenceReading(JSON.stringify(reading({ since: undefined }))).kind).toBe('bad');
  });

  test('a projection with a state its event does not map to is refused', () => {
    expect(readPresenceReading(JSON.stringify(reading({ event: 'human-wait', state: 'working' }))).kind).toBe('bad');
  });
});

describe('the channel record', () => {
  test('a serving record is read whole', () => {
    const read = readPresenceStatus(JSON.stringify({
      v: 1, session: SESSION, state: 'serving', pid: process.pid,
      startedAt: T0, lastStepAt: T0, lastSuccessAt: T0, heartbeatAt: T0, error: null, stoppedAt: null,
    }));
    expect(read.kind).toBe('ok');
  });

  test('a channel word outside the contract, a bad pid or a bad instant is refused', () => {
    const good = {
      v: 1, session: SESSION, state: 'serving', pid: process.pid,
      startedAt: T0, lastStepAt: T0, lastSuccessAt: T0, heartbeatAt: T0, error: null, stoppedAt: null,
    };
    for (const extra of [
      { state: 'healthy' }, { pid: 0 }, { pid: 1.5 }, { startedAt: 'soon' },
      { lastSuccessAt: 'soon' }, { stoppedAt: 'soon' }, { error: '' }, { error: 'x'.repeat(501) },
    ]) {
      expect(readPresenceStatus(JSON.stringify({ ...good, ...extra })).kind).toBe('bad');
    }
  });
});

describe('liveness is qualified, never aged', () => {
  const base: PresenceReading = {
    v: 1, seq: 7, id: `${T0}-00000001`, state: 'idle', source: 'runtime-hook', event: 'turn-end',
    binding: BINDING, since: '2020-01-01T00:00:00.000Z', observedAt: '2020-01-01T00:00:00.100Z',
  };

  test('a reading from the current binding over a healthy channel is live however old it is', () => {
    expect(presenceLive(base, BINDING, true)).toBe(true);
  });

  test('a predecessor binding, no binding or an unhealthy channel is last-known, not a new state', () => {
    expect(presenceLive(base, OTHER, true)).toBe(false);
    expect(presenceLive(base, null, true)).toBe(false);
    expect(presenceLive(base, BINDING, false)).toBe(false);
  });
});

describe('presence paths', () => {
  test('the session folder is the seat-state encoding, byte for byte', () => {
    for (const name of [SESSION, 'a.b', 'x y', 'ü', '..', 'a/b', 'A_9-z']) {
      const folder = presenceSessionFolder(name);
      const hook = cliHookStatePath('/state', name, 'builder-4');
      expect(hook).not.toBeNull();
      expect(folder).toBe(basename(dirname(hook!)));
    }
  });

  test('an encoded name never reads as . or .. and cannot escape the tree', () => {
    expect(presenceSessionFolder('')).toBeNull();
    expect(presenceSessionFolder('.')).toBe('%2E');
    expect(presenceSessionFolder('..')).toBe('%2E%2E');
    expect(presenceSessionFolder('a/b')).toBe('a%2Fb');
    expect(presenceSessionFolder('ü')).toBe('%C3%BC');
    const stateDir = '/state';
    for (const name of ['.', '..', '../../etc', 'a b']) {
      const paths = presencePaths(stateDir, name, 'builder-4');
      expect(paths).not.toBeNull();
      expect(paths!.root.startsWith(join(stateDir, 'presence') + '/')).toBe(true);
    }
  });

  test('a seat name that is not one path segment is refused', () => {
    expect(isPresenceSeatName('builder-4')).toBe(true);
    expect(isPresenceSeatName('a/b')).toBe(false);
    expect(isPresenceSeatName('a b')).toBe(false);
    expect(isPresenceSeatName('x'.repeat(256))).toBe(false);
    expect(presencePaths('/state', SESSION, 'a/b')).toBeNull();
  });

  test('the status file sits beside the seat folders, not in one', () => {
    expect(presenceStatusPath('/state', SESSION)).toBe(join(presenceSessionDir('/state', SESSION)!, 'status.json'));
  });
});
