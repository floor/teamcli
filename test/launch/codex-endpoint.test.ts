// The managed Codex endpoint's process lifecycle, with every measurement injected: no scene
// here starts, signals or reads another process, and no CLI home is touched. The rules pinned
// are the ones a launch depends on — a record is written under the seat's current binding, a
// server this call started is stopped when its record cannot land, a reused pid is never
// signalled, and only the endpoint's own socket under the seat's own run folder is ever removed.
// A socket no record names is left where it is, and said.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { presenceSessionFolder } from '../../src/daemon/presence/spool.ts';
import {
  codexEndpointSocket,
  ensureCodexEndpoint,
  stopRecordedCodexEndpoint,
  stopSeatCodexEndpoint,
  type CodexEndpointDeps,
} from '../../src/launch/codex-endpoint.ts';
import type { CodexEndpointRecord } from '../../src/daemon/presence/endpoint-record.ts';

const SESSION = 'teamcli';
const SEAT = 'builder-4';
const BINDING = 'prs_0123456789ab';
const OTHER = 'prs_fedcba987654';
const T0 = '2026-10-01T10:00:00.000Z';
const T0_MS = Date.parse(T0);

// A unix socket path has a hard OS limit, so scenes live under the shortest temp folder this
// machine offers: macOS's per-user `T` folder is too deep for the endpoint this build names.
const SHORT_TMP = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();

function scratch(): string {
  return mkdtempSync(join(SHORT_TMP, 'te-'));
}

function rootOf(dir: string): string {
  const folder = presenceSessionFolder(SESSION);
  if (folder === null) throw new Error('the scene names no session folder');
  return join(dir, 'run', folder, SEAT);
}

/** A state that records the seat's current binding, as a managed launch reads it. */
function seed(dir: string, binding: string = BINDING): void {
  updateState(dir, (state) => {
    (state.sessions[SESSION] ??= emptySession()).seats[SEAT] = { stage: 'launched', presence_binding: binding };
  });
}

function seedRecord(dir: string, record: CodexEndpointRecord): void {
  updateState(dir, (state) => {
    (state.sessions[SESSION] ??= emptySession()).seats[SEAT] = { stage: 'launched', presence_binding: BINDING, codex_endpoint: record };
  });
}

function recordedAt(dir: string): CodexEndpointRecord | undefined {
  return readState(dir).sessions[SESSION]?.seats[SEAT]?.codex_endpoint;
}

/** A record for a seat's own socket under this scene's folder. */
function ownedRecord(dir: string, extra: Partial<CodexEndpointRecord> = {}): CodexEndpointRecord {
  const socketPath = join(rootOf(dir), `${BINDING}.sock`);
  return { url: `unix://${socketPath}`, binding: BINDING, pid: 700, started_at: T0, ...extra };
}

describe('the endpoint socket path', () => {
  test('is binding-scoped, under the seat’s own run folder', () => {
    const dir = scratch();
    try {
      const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING);
      expect(socket).not.toBeNull();
      if (socket === null) throw new Error('expected a socket');
      expect(socket.path).toBe(join(rootOf(dir), `${BINDING}.sock`));
      expect(socket.url).toBe(`unix://${socket.path}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a binding the contract does not allow', () => {
    const dir = scratch();
    try {
      expect(codexEndpointSocket(dir, SESSION, SEAT, 'binding')).toBeNull();
      expect(codexEndpointSocket(dir, SESSION, SEAT, OTHER.toUpperCase())).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a path this build would ask the OS to bind over its limit', () => {
    let deep = scratch();
    try {
      while (deep.length < 120) deep = join(deep, 'nested-folder-name');
      expect(codexEndpointSocket(deep, SESSION, SEAT, BINDING)).toBeNull();
    } finally {
      rmSync(deep, { recursive: true, force: true });
    }
  });
});

describe('ensuring the endpoint', () => {
  test('refuses without a valid recorded binding, and starts nothing', async () => {
    for (const binding of [undefined, 'nope'] as const) {
      const dir = scratch();
      try {
        updateState(dir, (state) => {
          (state.sessions[SESSION] ??= emptySession()).seats[SEAT] = {
            stage: 'launched',
            ...(binding === undefined ? {} : { presence_binding: binding }),
          };
        });
        let spawned = 0;
        const answer = await ensureCodexEndpoint({
          dir, session: SESSION, seat: SEAT,
          deps: { spawn: () => { spawned++; return { pid: 700 }; } },
        });
        expect(answer.kind).toBe('unmanaged');
        if (answer.kind === 'unmanaged') expect(answer.why).toBe('the seat records no valid presence binding');
        expect(spawned).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('starts a server on the binding’s socket and records it for that binding', async () => {
    const dir = scratch();
    try {
      seed(dir);
      const socketPath = join(rootOf(dir), `${BINDING}.sock`);
      let listening = false;
      const spawned: string[] = [];
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          spawn: (input) => { spawned.push(input.url); listening = true; return { pid: 9001 }; },
          isPlainDir: () => true,
          isSocket: (path) => listening && path === socketPath,
          sleep: async () => {},
          now: () => new Date('2026-10-01T10:00:05.000Z'),
        },
      });
      expect(answer).toEqual({ kind: 'up', url: `unix://${socketPath}`, started: true });
      expect(spawned).toEqual([`unix://${socketPath}`]);
      expect(recordedAt(dir)).toEqual({
        url: `unix://${socketPath}`,
        binding: BINDING,
        pid: 9001,
        started_at: '2026-10-01T10:00:05.000Z',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reuses the recorded server only while the full ownership proof holds', async () => {
    const dir = scratch();
    try {
      seedRecord(dir, ownedRecord(dir));
      const prior = ownedRecord(dir);
      let spawned = 0;
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          spawn: () => { spawned++; return { pid: 9002 }; },
          alive: () => true,
          commandOf: () => `codex app-server --listen ${prior.url}`,
          startOf: () => T0_MS + 500,
          isPlainDir: () => true,
          isSocket: () => true,
          sleep: async () => {},
          now: () => new Date('2026-10-01T10:00:05.000Z'),
        },
      });
      expect(answer).toEqual({ kind: 'up', url: prior.url, started: false });
      expect(spawned).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never reuses a pid that started after the record: that is a reused pid', async () => {
    const dir = scratch();
    try {
      const prior = ownedRecord(dir);
      seedRecord(dir, prior);
      let spawned = 0;
      let terminated = 0;
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          spawn: () => { spawned++; return { pid: 9003 }; },
          alive: () => true,
          commandOf: () => `codex app-server --listen ${prior.url}`,
          // The pid belongs to a process that started a minute after the record was written.
          startOf: () => T0_MS + 60_000,
          isPlainDir: () => true,
          isSocket: () => true,
          terminate: () => { terminated++; },
          sleep: async () => {},
        },
      });
      expect(answer.kind).toBe('unmanaged');
      if (answer.kind === 'unmanaged') expect(answer.why).toContain('cannot be proven');
      expect(spawned).toBe(0);
      expect(terminated).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a predecessor on another path that cannot be proven is left alone, and said', async () => {
    const dir = scratch();
    try {
      const prior: CodexEndpointRecord = {
        url: `unix://${join(rootOf(dir), `${OTHER}.sock`)}`,
        binding: OTHER,
        pid: 700,
        started_at: T0,
      };
      seedRecord(dir, prior);
      const socketPath = join(rootOf(dir), `${BINDING}.sock`);
      const dropped: string[] = [];
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          spawn: () => ({ pid: 9004 }),
          alive: () => true,
          commandOf: () => 'codex app-server --listen elsewhere',
          startOf: () => T0_MS,
          isPlainDir: () => true,
          isSocket: () => true,
          drop: (path) => { dropped.push(path); },
          sleep: async () => {},
          now: () => new Date('2026-10-01T10:00:05.000Z'),
        },
      });
      expect(answer.kind).toBe('up');
      if (answer.kind === 'up') {
        expect(answer.started).toBe(true);
        expect(answer.notes?.[0]).toContain('the previous endpoint was left alone');
      }
      expect(dropped).toEqual([]);
      expect(recordedAt(dir)?.url).toBe(`unix://${socketPath}`);
      expect(recordedAt(dir)?.pid).toBe(9004);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a socket no record names is never removed, and is said', async () => {
    const dir = scratch();
    try {
      seed(dir);
      const socketPath = join(rootOf(dir), `${BINDING}.sock`);
      const strangerPath = join(rootOf(dir), `${OTHER}.sock`);
      mkdirSync(rootOf(dir), { recursive: true });
      writeFileSync(strangerPath, '');
      let listening = false;
      const dropped: string[] = [];
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          spawn: () => { listening = true; return { pid: 9010 }; },
          isPlainDir: () => true,
          isSocket: (path) => (listening && path === socketPath) || path === strangerPath,
          drop: (path) => { dropped.push(path); },
          sleep: async () => {},
          now: () => new Date('2026-10-01T10:00:05.000Z'),
        },
      });
      expect(answer.kind).toBe('up');
      if (answer.kind === 'up') {
        expect(answer.notes?.some((note) => note.includes(`${OTHER}.sock`))).toBe(true);
        expect(answer.notes?.some((note) => note.includes('no record names'))).toBe(true);
      }
      expect(dropped).toEqual([]);
      expect(existsSync(strangerPath)).toBe(true);
      expect(recordedAt(dir)?.url).toBe(`unix://${socketPath}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('removes only the predecessor socket its record names, never a stranger', async () => {
    const dir = scratch();
    try {
      const priorPath = join(rootOf(dir), `${OTHER}.sock`);
      const stranger = 'prs_aaaabbbbcccc';
      const strangerPath = join(rootOf(dir), `${stranger}.sock`);
      seedRecord(dir, { url: `unix://${priorPath}`, binding: OTHER, pid: 700, started_at: T0 });
      mkdirSync(rootOf(dir), { recursive: true });
      writeFileSync(priorPath, '');
      writeFileSync(strangerPath, '');
      const socketPath = join(rootOf(dir), `${BINDING}.sock`);
      let listening = false;
      const dropped: string[] = [];
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          spawn: () => { listening = true; return { pid: 9011 }; },
          // The recorded pid is gone: exactly the proof that lets its own socket go.
          alive: () => false,
          isPlainDir: () => true,
          isSocket: (path) => path === priorPath || path === strangerPath
            || (listening && path === socketPath),
          drop: (path) => { dropped.push(path); },
          sleep: async () => {},
          now: () => new Date('2026-10-01T10:00:05.000Z'),
        },
      });
      expect(answer.kind).toBe('up');
      expect(dropped).toEqual([priorPath]);
      if (answer.kind === 'up') {
        expect(answer.notes?.some((note) => note.includes(`${stranger}.sock`))).toBe(true);
      }
      expect(existsSync(strangerPath)).toBe(true);
      expect(recordedAt(dir)?.binding).toBe(BINDING);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a server this call started is stopped when the binding moved before its record landed', async () => {
    const dir = scratch();
    try {
      seed(dir);
      const socketPath = join(rootOf(dir), `${BINDING}.sock`);
      const terminated: number[] = [];
      const dropped: string[] = [];
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          spawn: () => {
            // A successor launch rotates the binding while this socket comes up.
            updateState(dir, (state) => {
              (state.sessions[SESSION] ??= emptySession()).seats[SEAT] = { stage: 'launched', presence_binding: OTHER };
            });
            return { pid: 9005 };
          },
          isPlainDir: () => true,
          isSocket: (path) => path === socketPath,
          terminate: (pid) => { terminated.push(pid); },
          drop: (path) => { dropped.push(path); },
          sleep: async () => {},
        },
      });
      expect(answer.kind).toBe('unmanaged');
      if (answer.kind === 'unmanaged') expect(answer.why).toBe('the seat binding changed while the endpoint started');
      expect(terminated).toEqual([9005]);
      expect(dropped).toEqual([socketPath]);
      expect(recordedAt(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a server that never creates its socket is stopped, with nothing left on disk', async () => {
    const dir = scratch();
    try {
      seed(dir);
      const socketPath = join(rootOf(dir), `${BINDING}.sock`);
      const terminated: number[] = [];
      const dropped: string[] = [];
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          spawn: () => ({ pid: 9006 }),
          isPlainDir: () => true,
          isSocket: () => false,
          terminate: (pid) => { terminated.push(pid); },
          drop: (path) => { dropped.push(path); },
          sleep: async () => {},
          waitMs: 0,
        },
      });
      expect(answer.kind).toBe('unmanaged');
      if (answer.kind === 'unmanaged') expect(answer.why).toBe('the Codex app-server did not create its socket in time');
      expect(terminated).toEqual([9006]);
      expect(dropped).toEqual([socketPath]);
      expect(recordedAt(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('starts nothing when the endpoint folder is not a plain directory', async () => {
    const dir = scratch();
    try {
      seed(dir);
      let spawned = 0;
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: { spawn: () => { spawned++; return { pid: 9007 }; }, isPlainDir: () => false },
      });
      expect(answer.kind).toBe('unmanaged');
      if (answer.kind === 'unmanaged') expect(answer.why).toBe('the endpoint folder is not a plain directory');
      expect(spawned).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stopping a recorded endpoint', () => {
  function scene(extra: Partial<CodexEndpointRecord> = {}) {
    const dir = scratch();
    seed(dir);
    const record = ownedRecord(dir, extra);
    return {
      dir,
      record,
      socketPath: join(rootOf(dir), `${BINDING}.sock`),
      stop(deps: CodexEndpointDeps) {
        return stopRecordedCodexEndpoint({ dir, session: SESSION, seat: SEAT, record }, deps);
      },
    };
  }

  test('signals a proven owner, then removes exactly its socket', () => {
    const one = scene();
    try {
      const terminated: number[] = [];
      const dropped: string[] = [];
      const answer = one.stop({
        alive: () => true,
        commandOf: () => `codex app-server --listen ${one.record.url}`,
        startOf: () => T0_MS + 1_000,
        isPlainDir: () => true,
        isSocket: (path) => path === one.socketPath,
        terminate: (pid) => { terminated.push(pid); },
        drop: (path) => { dropped.push(path); },
      });
      expect(answer).toEqual({ stopped: true });
      expect(terminated).toEqual([700]);
      expect(dropped).toEqual([one.socketPath]);
    } finally {
      rmSync(one.dir, { recursive: true, force: true });
    }
  });

  test('never signals a live pid whose command line is not this endpoint', () => {
    for (const commandOf of [
      () => 'codex app-server --listen elsewhere',
      () => null,
    ]) {
      const one = scene();
      try {
        let signalled = 0;
        const answer = one.stop({
          alive: () => true,
          commandOf,
          startOf: () => T0_MS,
          isPlainDir: () => true,
          isSocket: () => true,
          terminate: () => { signalled++; },
          drop: () => {},
        });
        expect(answer.stopped).toBe(false);
        expect(answer.why).toBe('the recorded process cannot be proven to serve this endpoint; it was not signalled');
        expect(signalled).toBe(0);
      } finally {
        rmSync(one.dir, { recursive: true, force: true });
      }
    }
  });

  test('never signals a pid whose process started after the record', () => {
    const one = scene();
    try {
      let signalled = 0;
      const answer = one.stop({
        alive: () => true,
        commandOf: () => `codex app-server --listen ${one.record.url}`,
        startOf: () => T0_MS + 60_000,
        isPlainDir: () => true,
        isSocket: () => true,
        terminate: () => { signalled++; },
        drop: () => {},
      });
      expect(answer.stopped).toBe(false);
      expect(signalled).toBe(0);
    } finally {
      rmSync(one.dir, { recursive: true, force: true });
    }
  });

  test('refuses a record that points outside the seat’s own socket', () => {
    for (const url of [
      'unix:///private/tmp/elsewhere.sock',
      `unix://${join(rootOf('/tmp'), 'other.sock')}`,
    ]) {
      const dir = scratch();
      try {
        seed(dir);
        const record: CodexEndpointRecord = { url, binding: BINDING, pid: 700, started_at: T0 };
        const answer = stopRecordedCodexEndpoint({ dir, session: SESSION, seat: SEAT, record }, {
          alive: () => true,
          commandOf: () => 'codex app-server --listen unix:///private/tmp/elsewhere.sock',
          startOf: () => T0_MS,
          isPlainDir: () => true,
          isSocket: () => true,
          terminate: () => { throw new Error('signalled a process outside the seat’s own socket'); },
          drop: () => { throw new Error('removed a file outside the seat’s own socket'); },
        });
        expect(answer.stopped).toBe(false);
        expect(answer.why).toBe('the record does not name this seat’s own socket');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('refuses to touch anything when the endpoint folder is not a plain directory', () => {
    const one = scene();
    try {
      const answer = one.stop({
        alive: () => true,
        commandOf: () => `codex app-server --listen ${one.record.url}`,
        startOf: () => T0_MS,
        isPlainDir: () => false,
        isSocket: () => true,
        terminate: () => { throw new Error('signalled under a folder it did not verify'); },
        drop: () => { throw new Error('removed a file under a folder it did not verify'); },
      });
      expect(answer.stopped).toBe(false);
      expect(answer.why).toBe('the endpoint folder is not a plain directory; nothing was removed');
    } finally {
      rmSync(one.dir, { recursive: true, force: true });
    }
  });

  test('with no socket there is nothing to stop, and nothing else is touched', () => {
    const one = scene();
    try {
      const answer = one.stop({
        alive: () => true,
        commandOf: () => { throw new Error('read a process with no endpoint to stop'); },
        isPlainDir: () => true,
        isSocket: () => false,
        terminate: () => { throw new Error('signalled with no endpoint to stop'); },
        drop: () => { throw new Error('removed a file that was not there'); },
      });
      expect(answer).toEqual({ stopped: true });
    } finally {
      rmSync(one.dir, { recursive: true, force: true });
    }
  });

  test('a dead pid leaves only its socket to remove', () => {
    const one = scene();
    try {
      const terminated: number[] = [];
      const dropped: string[] = [];
      const answer = one.stop({
        alive: () => false,
        isPlainDir: () => true,
        isSocket: () => true,
        terminate: (pid) => { terminated.push(pid); },
        drop: (path) => { dropped.push(path); },
      });
      expect(answer).toEqual({ stopped: true });
      expect(terminated).toEqual([]);
      expect(dropped).toEqual([one.socketPath]);
    } finally {
      rmSync(one.dir, { recursive: true, force: true });
    }
  });
});

describe('stopping the endpoint recorded on a seat', () => {
  test('clears the record only after a proven stop', () => {
    const dir = scratch();
    try {
      const prior = ownedRecord(dir);
      seedRecord(dir, prior);
      const answer = stopSeatCodexEndpoint({ dir, session: SESSION, seat: SEAT }, {
        alive: () => true,
        commandOf: () => `codex app-server --listen ${prior.url}`,
        startOf: () => T0_MS,
        isPlainDir: () => true,
        isSocket: () => true,
        terminate: () => {},
        drop: () => {},
      });
      expect(answer).toEqual({ stopped: true });
      expect(recordedAt(dir)).toBeUndefined();
      // The binding the seat is running under is not this stop's to change.
      expect(readState(dir).sessions[SESSION]?.seats[SEAT]?.presence_binding).toBe(BINDING);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('leaves the record visible when the process cannot be proven', () => {
    const dir = scratch();
    try {
      const prior = ownedRecord(dir);
      seedRecord(dir, prior);
      const answer = stopSeatCodexEndpoint({ dir, session: SESSION, seat: SEAT }, {
        alive: () => true,
        commandOf: () => 'codex app-server --listen elsewhere',
        startOf: () => T0_MS,
        isPlainDir: () => true,
        isSocket: () => true,
        terminate: () => { throw new Error('signalled an unproven process'); },
        drop: () => {},
      });
      expect(answer.stopped).toBe(false);
      expect(recordedAt(dir)).toEqual(prior);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('says there is nothing to stop when the seat records no endpoint for its binding', () => {
    const dir = scratch();
    try {
      seed(dir);
      const answer = stopSeatCodexEndpoint({ dir, session: SESSION, seat: SEAT }, {});
      expect(answer).toEqual({ stopped: false, why: 'the seat records no endpoint for its current binding' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
