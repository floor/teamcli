// The session rule on the command line is the outer door; these scenes are the inner one. The
// state's sessions map is built without a prototype (`sessionMap`), so even a name that reached
// a read or a write some other way finds the team's own record or nothing — never the object
// every object inherits, and never a write that lands on the shared prototype. The raw readers
// that parse the state file themselves take an own key only.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptySession, readState, storedWatchRecord, updateState, STATE_FILE } from '../src/state.ts';

let dir: string;
const INHERITED = ['__proto__', 'constructor', 'prototype'] as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'state-session-keys-'));
});

afterEach(() => {
  delete (Object.prototype as { watch?: unknown }).watch;
  rmSync(dir, { recursive: true, force: true });
});

const written = (): unknown => JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'));

describe('the sessions map a read returns', () => {
  test('has no prototype, and a name it does not hold finds nothing', () => {
    const missing = readState(dir);
    expect(Object.getPrototypeOf(missing.sessions)).toBeNull();
    for (const name of INHERITED) expect(missing.sessions[name], name).toBeUndefined();

    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ format: 1, sessions: { acme: emptySession() } }));
    const state = readState(dir);
    expect(Object.getPrototypeOf(state.sessions)).toBeNull();
    expect(state.sessions.acme).toEqual({ seats: {}, worktrees: {} });
    for (const name of INHERITED) expect(state.sessions[name], name).toBeUndefined();
  });

  test('keeps a record the file holds under an inherited name as an ordinary own key', () => {
    // JSON.parse makes an own data property of the key, prototype untouched; the read door keeps
    // it own, so a lookup finds that record and never the inherited object.
    writeFileSync(join(dir, STATE_FILE), `{"format":1,"sessions":{"__proto__":{"seats":{"lead":{"stage":"ready"}}}}}`);
    const state = readState(dir);
    expect(Object.hasOwn(state.sessions, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(state.sessions)).toBeNull();
    expect(state.sessions['__proto__']?.seats.lead?.stage).toBe('ready');
  });
});

describe('a write through a session name the team does not hold', () => {
  test('creates an own record and cannot reach the shared prototype', () => {
    let inherited: unknown;
    try {
      updateState(dir, (state) => {
        // The watch's beat, verbatim: this is the write that landed on `Object.prototype` when
        // the map was a plain object.
        const record = (state.sessions['__proto__'] ??= emptySession());
        record.watch = { pid: 123, heartbeat: '2026-11-01T09:00:00.000Z', started_at: '2026-11-01T09:00:00.000Z' };
      });
    } finally {
      inherited = (Object.prototype as { watch?: unknown }).watch;
      delete (Object.prototype as { watch?: unknown }).watch;
    }
    expect(inherited).toBeUndefined();
    const raw = written() as { sessions: Record<string, unknown> };
    expect(Object.hasOwn(raw.sessions, '__proto__')).toBe(true);
    expect(raw.sessions['__proto__']).toEqual({
      seats: {},
      worktrees: {},
      watch: { pid: 123, heartbeat: '2026-11-01T09:00:00.000Z', started_at: '2026-11-01T09:00:00.000Z' },
    });
    // And the next read finds it as the team's own record.
    expect(readState(dir).sessions['__proto__']?.watch?.pid).toBe(123);
  });
});

describe('storedWatchRecord', () => {
  test('reads an own key only, never the inherited object', () => {
    Object.defineProperty(Object.prototype, 'watch', {
      value: { pid: 999, heartbeat: 'inherited', started_at: '2026-11-01T00:00:00.000Z' },
      configurable: true,
      writable: true,
    });
    try {
      writeFileSync(join(dir, STATE_FILE), JSON.stringify({ format: 1, sessions: {} }));
      for (const name of INHERITED) expect(storedWatchRecord(dir, name), name).toBeUndefined();

      writeFileSync(join(dir, STATE_FILE), JSON.stringify({
        format: 1,
        sessions: { acme: { watch: { pid: 7, heartbeat: 'beat' } } },
      }));
      expect(storedWatchRecord(dir, 'acme')).toEqual({ pid: 7, heartbeat: 'beat' });
    } finally {
      delete (Object.prototype as { watch?: unknown }).watch;
    }
  });
});
