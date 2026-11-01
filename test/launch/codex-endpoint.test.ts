// The managed Codex endpoint's process lifecycle, with every measurement injected: no scene
// here starts, signals or reads another process, and no CLI home is touched. The rules pinned
// are the ones a launch depends on — a record is written under the seat's current binding, a
// server this call started is stopped when its record cannot land, a reused pid is never
// signalled, and only the endpoint's own socket under the seat's own run folder is ever removed.
// A socket no record names is left where it is, and said. A missing socket is no proof its
// server is gone, and a record that is present but unreadable is unproven, never absent.
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { shortSocketBase } from '../helpers.ts';
import { emptySession, LOCK_FILE, readState, updateState } from '../../src/state.ts';
import { presenceSessionFolder } from '../../src/daemon/presence/spool.ts';
import {
  codexEndpointSocket,
  endpointSocketOf,
  ensureCodexEndpoint,
  isSocketFile,
  launchCodexEndpoint,
  seatOfManagedEndpoint,
  seatRecordsCodexEndpoint,
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

// A unix socket path has a hard OS limit, so scenes live under the short socket base with a
// short prefix; the scenes that bind a socket measure their endpoint against the limit.
const SHORT_TMP = shortSocketBase();

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

/** A state folder over 100 bytes on its own, so its seat's socket cannot live under it. */
function deepScratch(): string {
  let deep = scratch();
  while (deep.length < 120) deep = join(deep, 'nested-folder-name');
  mkdirSync(deep, { recursive: true });
  return deep;
}

/** A scene's own runtime folder: nothing here touches the machine's real one. */
function runtimeRootOf(base: string): string {
  return join(base, 'rt');
}

function stemOf(socketPath: string): string {
  return basename(socketPath, '.sock');
}

/** The strict owner record a launch writes beside a runtime socket, as a different process would
 *  find it: a plain file this user owns, 0600, small. */
function writeOwnerRecordOf(socketPath: string, record: { dir: string; binding: string; pid: number; at: string }): string {
  const path = join(dirname(socketPath), `${stemOf(socketPath)}.owner.json`);
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
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
      expect(Buffer.byteLength(socket.path)).toBeLessThanOrEqual(100);
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

  test('a state folder over the limit moves its socket to the short runtime folder, within the limit', () => {
    const deep = deepScratch();
    const base = scratch();
    try {
      const runtimeRoot = runtimeRootOf(base);
      const socket = endpointSocketOf(deep, SESSION, SEAT, BINDING, runtimeRoot);
      expect(socket.kind).toBe('ok');
      if (socket.kind !== 'ok') return;
      expect(socket.runtime).toBe(true);
      expect(socket.path).toBe(join(runtimeRoot, `${stemOf(socket.path)}.sock`));
      expect(stemOf(socket.path)).toMatch(/^[0-9a-f]{32}$/);
      expect(Buffer.byteLength(socket.path)).toBeLessThanOrEqual(100);
      // The name hashes the binding too: another incarnation is another file, never this one.
      const other = endpointSocketOf(deep, SESSION, SEAT, OTHER, runtimeRoot);
      expect(other.kind).toBe('ok');
      if (other.kind === 'ok') expect(other.path).not.toBe(socket.path);
      // The same seat, session, binding and folder always name the same file.
      expect(endpointSocketOf(deep, SESSION, SEAT, BINDING, runtimeRoot)).toEqual(socket);
    } finally {
      rmSync(deep, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('refuses when neither the state folder nor the runtime folder can hold the path', () => {
    const deep = deepScratch();
    try {
      const tooLong = join(deep, 'runtime', 'x'.repeat(40));
      const socket = endpointSocketOf(deep, SESSION, SEAT, BINDING, tooLong);
      expect(socket.kind).toBe('none');
      if (socket.kind === 'none') {
        expect(socket.why).toContain('bytes');
        expect(socket.why).toContain('100');
      }
      expect(codexEndpointSocket(deep, SESSION, SEAT, BINDING, tooLong)).toBeNull();
    } finally {
      rmSync(deep, { recursive: true, force: true });
    }
  });
});

describe('the endpoint socket the app-server makes', () => {
  test('a link to a private socket counts; a link to a shared folder or a plain file does not', async () => {
    const base = mkdtempSync(join(shortSocketBase(), 'cx-sock-'));
    const hidden = join(base, 'daemon');
    mkdirSync(hidden, { mode: 0o700 });
    const real = join(hidden, 's.sock');
    const server = createServer();
    await new Promise<void>((done) => server.listen(real, done));
    try {
      const link = join(base, 'a.sock');
      symlinkSync(real, link);
      expect(isSocketFile(real)).toBe(true);
      expect(isSocketFile(link)).toBe(true);
      chmodSync(hidden, 0o755);
      expect(isSocketFile(link)).toBe(false);
      chmodSync(hidden, 0o700);
      writeFileSync(join(hidden, 'plain'), '');
      const plainLink = join(base, 'b.sock');
      symlinkSync(join(hidden, 'plain'), plainLink);
      expect(isSocketFile(plainLink)).toBe(false);
      expect(isSocketFile(join(base, 'missing.sock'))).toBe(false);
    } finally {
      server.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('the launch side mints the binding a Codex seat has no settings file to carry', () => {
  test('a seat with no binding gets a fresh one, and its endpoint starts under it', async () => {
    const dir = scratch();
    try {
      updateState(dir, (state) => {
        (state.sessions[SESSION] ??= emptySession()).seats[SEAT] = { stage: 'launched' };
      });
      let spawned = 0;
      let listening = false;
      const answer = await launchCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          spawn: () => { spawned++; listening = true; return { pid: 9020 }; },
          alive: () => true,
          isPlainDir: () => true,
          isSocket: () => listening,
          sleep: async () => {},
        },
      });
      const binding = readState(dir).sessions[SESSION]?.seats[SEAT]?.presence_binding;
      expect(typeof binding).toBe('string');
      expect(answer.kind).toBe('up');
      expect(spawned).toBe(1);
      if (answer.kind === 'up') expect(answer.url).toContain(`${binding as string}.sock`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a binding write that fails fails the managed launch instead of reusing the predecessor endpoint', async () => {
    const dir = scratch();
    try {
      // A prior incarnation whose endpoint is still provably up under the old binding: exactly
      // the state the reuse branch would attach to if the failed mint went unnoticed.
      const prior = ownedRecord(dir);
      seedRecord(dir, prior);
      // A live holder of the state lock, this test's own pid, makes the mint's write wait out
      // its lock and time out. The deps below never start, read or signal a process.
      writeFileSync(join(dir, LOCK_FILE), `${process.pid}\n`);
      let spawned = 0;
      let hookReads = 0;
      let signals = 0;
      const answer = await launchCodexEndpoint({
        dir, session: SESSION, seat: SEAT, pane: 'pane-a',
        deps: {
          alive: () => true,
          commandOf: () => `codex app-server --listen ${prior.url}`,
          startOf: () => T0_MS + 500,
          isSocket: () => true,
          isPlainDir: () => true,
          herdrEnv: () => { hookReads++; return { HERDR_PANE_ID: 'pane-a' }; },
          spawn: () => { spawned++; return { pid: 9002 }; },
          terminate: () => { signals++; },
        },
      });
      expect(answer.kind).toBe('unmanaged');
      if (answer.kind === 'unmanaged') {
        expect(answer.why).toContain('fresh presence binding could not be recorded');
      }
      // Nothing was reused, started, hooked or signalled, and the predecessor's record stands.
      expect(spawned).toBe(0);
      expect(hookReads).toBe(0);
      expect(signals).toBe(0);
      expect(recordedAt(dir)).toEqual(prior);
      expect(readState(dir).sessions[SESSION]?.seats[SEAT]?.presence_binding).toBe(BINDING);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
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
        config: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('starts the server with the seat\'s config and the herdr hook environment of its pane', async () => {
    // With the TUI attached by --remote, Codex loads config and runs hooks in the app-server:
    // the seat's -c pairs and herdr's pane environment must reach that process.
    const dir = scratch();
    try {
      seed(dir);
      const socketPath = join(rootOf(dir), `${BINDING}.sock`);
      let listening = false;
      const spawned: { config?: string[]; env?: Record<string, string> }[] = [];
      const asked: string[] = [];
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT, pane: 'pane1', config: ['-c', 'sandbox_mode="danger-full-access"'],
        deps: {
          spawn: (input) => { spawned.push({ config: input.config, env: input.env }); listening = true; return { pid: 9031 }; },
          herdrEnv: (session, pane) => { asked.push(`${session} ${pane}`); return { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/h/herdr.sock', HERDR_PANE_ID: pane }; },
          isPlainDir: () => true,
          isSocket: (path) => listening && path === socketPath,
          sleep: async () => {},
          now: () => new Date('2026-10-01T10:00:05.000Z'),
        },
      });
      expect(answer).toEqual({ kind: 'up', url: `unix://${socketPath}`, started: true });
      expect(asked).toEqual([`${SESSION} pane1`]);
      expect(spawned).toEqual([{
        config: ['-c', 'sandbox_mode="danger-full-access"'],
        env: { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/h/herdr.sock', HERDR_PANE_ID: 'pane1' },
      }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a pane herdr cannot name a socket for still starts the server, and says so', async () => {
    const dir = scratch();
    try {
      seed(dir);
      const socketPath = join(rootOf(dir), `${BINDING}.sock`);
      let listening = false;
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT, pane: 'pane1',
        deps: {
          spawn: (input) => { expect(input.env).toBeUndefined(); listening = true; return { pid: 9032 }; },
          herdrEnv: () => null,
          isPlainDir: () => true,
          isSocket: (path) => listening && path === socketPath,
          sleep: async () => {},
        },
      });
      expect(answer).toMatchObject({ kind: 'up', started: true, notes: [expect.stringContaining('turn hooks cannot report this seat')] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reuses the recorded server only while the full ownership proof and start config hold', async () => {
    const dir = scratch();
    try {
      const config = ['-c', 'mcp_servers.team_inbox.command="team"'];
      const prior = ownedRecord(dir, { config });
      seedRecord(dir, prior);
      let spawned = 0;
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT, config,
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

  test('a recorded endpoint started without the team inbox pairs is stopped, and the fresh spawn carries them', async () => {
    const dir = scratch();
    try {
      // The recorded server is this launch's to replace: its config lacks the inbox server the
      // seat's line installs, and an attached TUI loads the app-server's config, not its own.
      const prior = ownedRecord(dir, { config: ['-c', 'sandbox_mode="workspace-write"'] });
      seedRecord(dir, prior);
      const config = ['-c', 'sandbox_mode="workspace-write"', '-c', 'mcp_servers.team_inbox.command="team"'];
      const spawned: (string[] | undefined)[] = [];
      let terminated = 0;
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT, config,
        deps: {
          spawn: (input) => { spawned.push(input.config); return { pid: 9050 }; },
          alive: () => true,
          commandOf: () => `codex app-server --listen ${prior.url}`,
          startOf: () => T0_MS + 500,
          terminate: () => { terminated++; },
          isPlainDir: () => true,
          isSocket: () => true,
          drop: () => {},
          sleep: async () => {},
          now: () => new Date('2026-10-01T10:00:05.000Z'),
        },
      });
      expect(terminated).toBe(1);
      expect(answer).toEqual({ kind: 'up', url: prior.url, started: true });
      expect(spawned).toEqual([config]);
      expect(recordedAt(dir)).toEqual({
        url: prior.url,
        binding: BINDING,
        pid: 9050,
        started_at: '2026-10-01T10:00:05.000Z',
        config,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a record that names no start config is never reused: it is stopped, not attached to', async () => {
    const dir = scratch();
    try {
      // A record an older build wrote names no configuration, so nothing proves the live server
      // would run this launch's line; it is stopped under the same proof and replaced.
      const prior = ownedRecord(dir);
      seedRecord(dir, prior);
      let spawned = 0;
      let terminated = 0;
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          spawn: () => { spawned++; return { pid: 9051 }; },
          alive: () => true,
          commandOf: () => `codex app-server --listen ${prior.url}`,
          startOf: () => T0_MS + 500,
          terminate: () => { terminated++; },
          isPlainDir: () => true,
          isSocket: () => true,
          drop: () => {},
          sleep: async () => {},
          now: () => new Date('2026-10-01T10:00:05.000Z'),
        },
      });
      expect(terminated).toBe(1);
      expect(spawned).toBe(1);
      expect(answer).toEqual({ kind: 'up', url: prior.url, started: true });
      expect(recordedAt(dir)?.config).toEqual([]);
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

describe('a deep state folder', () => {
  test('still gets a managed endpoint, in the short runtime folder, owner-only', async () => {
    const dir = deepScratch();
    const base = scratch();
    const runtimeRoot = runtimeRootOf(base);
    try {
      seed(dir);
      const expected = endpointSocketOf(dir, SESSION, SEAT, BINDING, runtimeRoot);
      if (expected.kind !== 'ok') throw new Error('the scene expected a runtime socket');
      let listening = false;
      const spawned: string[] = [];
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          runtimeRoot,
          spawn: (input) => {
            spawned.push(input.url);
            // The server creates its socket where it was told to listen; the OS's own default
            // mode is what the launch has to narrow from.
            writeFileSync(expected.path, '');
            chmodSync(expected.path, 0o644);
            listening = true;
            return { pid: 9010 };
          },
          isPlainDir: () => true,
          isSocket: (path) => listening && path === expected.path,
          alive: () => false,
          sleep: async () => {},
          now: () => new Date('2026-10-01T10:00:05.000Z'),
        },
      });
      expect(answer).toEqual({ kind: 'up', url: `unix://${expected.path}`, started: true });
      expect(spawned).toEqual([`unix://${expected.path}`]);
      expect(Buffer.byteLength(expected.path)).toBeLessThanOrEqual(100);
      expect(recordedAt(dir)).toEqual({
        url: `unix://${expected.path}`,
        binding: BINDING,
        pid: 9010,
        started_at: '2026-10-01T10:00:05.000Z',
        config: [],
      });
      // The folder and everything the launch writes into it are this user's alone.
      expect(statSync(runtimeRoot).mode & 0o777).toBe(0o700);
      expect(statSync(expected.path).mode & 0o777).toBe(0o600);
      const ownerPath = join(runtimeRoot, `${stemOf(expected.path)}.owner.json`);
      expect(statSync(ownerPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(ownerPath, 'utf8'))).toEqual({
        dir,
        binding: BINDING,
        pid: 9010,
        at: '2026-10-01T10:00:05.000Z',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('clears the runtime sockets whose recorded process has gone, and only those', async () => {
    const dir = deepScratch();
    const base = scratch();
    const runtimeRoot = runtimeRootOf(base);
    try {
      seed(dir);
      mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
      chmodSync(runtimeRoot, 0o700);
      const dead = join(runtimeRoot, `${'a'.repeat(32)}.sock`);
      const live = join(runtimeRoot, `${'b'.repeat(32)}.sock`);
      const unnamed = join(runtimeRoot, `${'d'.repeat(32)}.sock`);
      writeFileSync(dead, '');
      writeFileSync(live, '');
      writeFileSync(unnamed, '');
      // Two sockets a launch named, one whose server is alive; an owner record whose socket is
      // already gone; and a socket no owner record names.
      const deadOwner = writeOwnerRecordOf(dead, { dir, binding: BINDING, pid: 9101, at: T0 });
      const liveOwner = writeOwnerRecordOf(live, { dir, binding: BINDING, pid: 9102, at: T0 });
      const orphan = join(runtimeRoot, `${'c'.repeat(32)}.owner.json`);
      writeFileSync(orphan, `${JSON.stringify({ dir, binding: BINDING, pid: 9103, at: T0 })}\n`, { mode: 0o600 });
      chmodSync(orphan, 0o600);

      const expected = endpointSocketOf(dir, SESSION, SEAT, BINDING, runtimeRoot);
      if (expected.kind !== 'ok') throw new Error('the scene expected a runtime socket');
      const sockets = new Set([dead, live, unnamed]);
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          runtimeRoot,
          spawn: () => {
            sockets.add(expected.path);
            writeFileSync(expected.path, '');
            return { pid: 9104 };
          },
          isPlainDir: () => true,
          isSocket: (path) => sockets.has(path),
          alive: (pid) => pid === 9102,
          sleep: async () => {},
          now: () => new Date('2026-10-01T10:00:05.000Z'),
        },
      });
      expect(answer.kind).toBe('up');
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(deadOwner)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(liveOwner)).toBe(true);
      expect(existsSync(orphan)).toBe(false);
      // Nothing proves the unnamed socket's process has gone, so it is left exactly where it is.
      expect(existsSync(unnamed)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('the seat is found from the runtime socket through its owner record', () => {
    const dir = deepScratch();
    const base = scratch();
    const runtimeRoot = runtimeRootOf(base);
    try {
      mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
      chmodSync(runtimeRoot, 0o700);
      const expected = endpointSocketOf(dir, SESSION, SEAT, BINDING, runtimeRoot);
      if (expected.kind !== 'ok') throw new Error('the scene expected a runtime socket');
      const record: CodexEndpointRecord = {
        url: `unix://${expected.path}`, binding: BINDING, pid: 700, started_at: T0, config: [],
      };
      seedRecord(dir, record);
      writeOwnerRecordOf(expected.path, { dir, binding: BINDING, pid: 700, at: T0 });
      const proof = {
        alive: () => true,
        commandOf: () => `codex app-server --listen ${record.url}`,
        startOf: () => T0_MS,
        runtimeRoot,
      };
      expect(seatOfManagedEndpoint(700, proof)).toEqual({ dir, session: SESSION, seat: SEAT });
      // The owner record names the process the launch recorded: another pid is another server.
      expect(seatOfManagedEndpoint(701, proof)).toBeNull();
      // The record and the process proof still decide, exactly as for a socket under the state.
      expect(seatOfManagedEndpoint(700, { ...proof, startOf: () => T0_MS + 3_600_000 })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('a runtime endpoint’s stop removes its socket and the owner record beside it', () => {
    const dir = deepScratch();
    const base = scratch();
    const runtimeRoot = runtimeRootOf(base);
    try {
      mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
      chmodSync(runtimeRoot, 0o700);
      const expected = endpointSocketOf(dir, SESSION, SEAT, BINDING, runtimeRoot);
      if (expected.kind !== 'ok') throw new Error('the scene expected a runtime socket');
      writeFileSync(expected.path, '');
      const ownerPath = writeOwnerRecordOf(expected.path, { dir, binding: BINDING, pid: 700, at: T0 });
      seedRecord(dir, {
        url: `unix://${expected.path}`, binding: BINDING, pid: 700, started_at: T0, config: [],
      });
      const stopped = stopSeatCodexEndpoint(
        { dir, session: SESSION, seat: SEAT },
        { runtimeRoot, alive: () => false, isPlainDir: () => true, isSocket: () => true },
      );
      expect(stopped).toEqual({ stopped: true });
      expect(existsSync(expected.path)).toBe(false);
      expect(existsSync(ownerPath)).toBe(false);
      expect(recordedAt(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('the launch remembers why its managed endpoint fell back', () => {
  test('a launch with no server records why; a later launch that starts one clears it', async () => {
    const dir = scratch();
    try {
      seed(dir);
      const one = () => readState(dir).sessions[SESSION]?.seats[SEAT];
      const fell = await launchCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: { spawn: () => null, now: () => new Date('2026-10-01T10:00:05.000Z') },
      });
      expect(fell).toEqual({ kind: 'unmanaged', why: 'the Codex app-server did not start' });
      expect(one()?.codex_endpoint_unmanaged).toEqual({
        why: 'the Codex app-server did not start',
        at: '2026-10-01T10:00:05.000Z',
      });

      let listening = false;
      const up = await launchCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          spawn: () => { listening = true; return { pid: 9020 }; },
          isPlainDir: () => true,
          isSocket: () => listening,
          sleep: async () => {},
          now: () => new Date('2026-10-01T10:00:06.000Z'),
        },
      });
      expect(up.kind).toBe('up');
      expect(one()?.codex_endpoint_unmanaged).toBeUndefined();
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
      `unix://${join(SHORT_TMP, 'elsewhere.sock')}`,
      `unix://${join(rootOf('/tmp'), 'other.sock')}`,
    ]) {
      const dir = scratch();
      try {
        seed(dir);
        const record: CodexEndpointRecord = { url, binding: BINDING, pid: 700, started_at: T0 };
        const answer = stopRecordedCodexEndpoint({ dir, session: SESSION, seat: SEAT, record }, {
          alive: () => true,
          commandOf: () => `codex app-server --listen unix://${join(SHORT_TMP, 'elsewhere.sock')}`,
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

  test('a missing socket is no proof the server is gone: a proven live pid is stopped by pid', () => {
    const one = scene();
    try {
      const terminated: number[] = [];
      const dropped: string[] = [];
      const answer = one.stop({
        alive: () => true,
        commandOf: () => `codex app-server --listen ${one.record.url}`,
        startOf: () => T0_MS,
        isPlainDir: () => true,
        isSocket: () => false,
        terminate: (pid) => { terminated.push(pid); },
        drop: (path) => { dropped.push(path); },
      });
      expect(answer).toEqual({ stopped: true });
      expect(terminated).toEqual([700]);
      expect(dropped).toEqual([]);
    } finally {
      rmSync(one.dir, { recursive: true, force: true });
    }
  });

  test('a missing socket leaves a live pid it cannot prove untouched, and says so', () => {
    const one = scene();
    try {
      let signalled = 0;
      const answer = one.stop({
        alive: () => true,
        commandOf: () => 'codex app-server --listen elsewhere',
        startOf: () => T0_MS,
        isPlainDir: () => true,
        isSocket: () => false,
        terminate: () => { signalled++; },
        drop: () => { throw new Error('removed a socket that was not there'); },
      });
      expect(answer).toEqual({
        stopped: false,
        why: 'the recorded process cannot be proven to serve this endpoint; it was not signalled',
      });
      expect(signalled).toBe(0);
    } finally {
      rmSync(one.dir, { recursive: true, force: true });
    }
  });

  test('a missing socket and a dead pid have nothing to stop', () => {
    const one = scene();
    try {
      const answer = one.stop({
        alive: () => false,
        isPlainDir: () => true,
        isSocket: () => false,
        terminate: () => { throw new Error('signalled a dead process'); },
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
      let proofRead = false;
      const foreign = stopSeatCodexEndpoint({ dir, session: SESSION, seat: SEAT, expectedUrl: 'unix:///tmp/another-launch.sock' }, {
        alive: () => { proofRead = true; return true; },
      });
      expect(foreign.stopped).toBe(false);
      expect(foreign.why).toContain('not the one this launch started');
      expect(proofRead).toBe(false);
      expect(recordedAt(dir)).toEqual(prior);
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

  test('a present record it cannot read is unproven, not absent: the stop says why and keeps it', () => {
    const dir = scratch();
    try {
      const socketPath = join(rootOf(dir), `${BINDING}.sock`);
      // Values a launch that died mid-write, or a hand-edited state, could leave behind: each is
      // present, and none names a process this build could have recorded.
      const broken = [
        { url: `unix://${socketPath}`, binding: BINDING },
        { url: `unix://${socketPath}`, binding: BINDING, pid: '700', started_at: T0 },
        { url: `unix://${socketPath}`, binding: BINDING, pid: 700 },
      ];
      for (const value of broken) {
        seedRecord(dir, value as unknown as CodexEndpointRecord);
        const answer = stopSeatCodexEndpoint({ dir, session: SESSION, seat: SEAT }, {
          alive: () => { throw new Error('read a pid the record does not name'); },
          terminate: () => { throw new Error('signalled a process it could not read'); },
        });
        expect(answer).toEqual({
          stopped: false,
          why: 'the seat’s endpoint record cannot be read; the process it names cannot be proved, so it was not stopped',
        });
        expect(recordedAt(dir)).toEqual(value as unknown as CodexEndpointRecord);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('whether a seat records an endpoint of its own', () => {
  test('true for every record a stop must account for, readable or not', () => {
    const dir = scratch();
    try {
      seed(dir);
      expect(seatRecordsCodexEndpoint({ dir, session: SESSION, seat: SEAT })).toBe(false);
      seedRecord(dir, ownedRecord(dir));
      expect(seatRecordsCodexEndpoint({ dir, session: SESSION, seat: SEAT })).toBe(true);
      // A record for another binding is not this seat's current endpoint, as the stop reads it.
      seedRecord(dir, ownedRecord(dir, { binding: OTHER, url: `unix://${join(rootOf(dir), `${OTHER}.sock`)}` }));
      expect(seatRecordsCodexEndpoint({ dir, session: SESSION, seat: SEAT })).toBe(false);
      // A present record this build cannot read is unproven, not absent: the stop is attempted
      // and says why, rather than the record passing as if the seat had none.
      seedRecord(dir, {
        url: `unix://${join(rootOf(dir), `${BINDING}.sock`)}`,
        binding: BINDING,
      } as unknown as CodexEndpointRecord);
      expect(seatRecordsCodexEndpoint({ dir, session: SESSION, seat: SEAT })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a state that cannot be read answers true, so the stop itself says why', () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, 'team.state.json'), 'not a state\n');
      expect(seatRecordsCodexEndpoint({ dir, session: SESSION, seat: SEAT })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the seat a managed endpoint serves', () => {
  // With the TUI attached by --remote, a seat's tools run under its app-server: the walk up from
  // the seat's own `team` call meets that process, which places it only on the full proof.
  function scene(extra: Partial<CodexEndpointRecord> = {}, pane: string | undefined = 'pane2') {
    const dir = scratch();
    const record = ownedRecord(dir, extra);
    updateState(dir, (state) => {
      (state.sessions[SESSION] ??= emptySession()).seats[SEAT] = {
        stage: 'launched', presence_binding: BINDING, codex_endpoint: record, ...(pane === undefined ? {} : { pane }),
      };
    });
    return { dir, record };
  }
  const proof = (command: string) => ({
    alive: () => true,
    commandOf: () => command,
    startOf: () => T0_MS,
  });

  test('its own recorded app-server places the seat, at its recorded pane', () => {
    const { dir, record } = scene();
    try {
      const command = `codex app-server --listen ${record.url} -c sandbox_mode="danger-full-access"`;
      expect(seatOfManagedEndpoint(700, proof(command))).toEqual({ dir, session: SESSION, seat: SEAT, pane: 'pane2' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('another pid, a reused pid, another binding, or a stranger\'s socket places nobody', () => {
    const { dir, record } = scene();
    try {
      const command = `codex app-server --listen ${record.url}`;
      expect(seatOfManagedEndpoint(701, proof(command))).toBeNull();
      expect(seatOfManagedEndpoint(700, { ...proof(command), startOf: () => T0_MS + 3_600_000 })).toBeNull();
      expect(seatOfManagedEndpoint(700, proof(command.replace(BINDING, OTHER)))).toBeNull();
      expect(seatOfManagedEndpoint(700, proof('codex app-server --listen unix:///tmp/elsewhere/x.sock'))).toBeNull();
      expect(seatOfManagedEndpoint(700, { ...proof(command), commandOf: () => null })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
