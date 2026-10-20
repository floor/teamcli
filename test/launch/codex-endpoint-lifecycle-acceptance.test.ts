// Independent acceptance for the managed Codex endpoint at 6d7bcb8ec, read from the contract:
//
// - the endpoint socket is `<state>/run/<session>/<seat>/<binding>.sock`, and the URL is exactly
//   `unix://` over it;
// - a socket is only ever removed through the record that names it; a binding-named socket no
//   record accounts for stays where it is and is reported in the launch notes, and a record-named
//   predecessor socket is removed while a stranger stays;
// - every stop and every reuse proves the recorded process first: a live process at the pid is
//   not enough — its command line must carry this record's exact `app-server --listen <url>`,
//   and its own start instant must sit in the window in which the record was written, so a pid
//   the OS reused is never signalled;
// - an unprovable predecessor is preserved and reported, never signalled; a predecessor whose
//   own path this one takes over makes the launch unmanaged;
// - a start that never produced its socket, or whose seat binding moved while it started, is
//   cleaned up by the call that started it and records nothing;
// - the seat stop clears the record only after a proven stop, and only for the record it stopped.
//
// Nothing here spawns a process: every spawn, signal, drop and socket check is injected, and the
// only real filesystem is the temporary state folder. The removal scenes at the end exercise the
// command's ordering with the same injected endpoint stop.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import { realSources as downSources, type DownLaunch } from '../../src/commands/down.ts';
import type { CodexEndpointRecord } from '../../src/daemon/presence/endpoint-record.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { seatIsStopped } from '../../src/file/lines.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import {
  codexEndpointSocket,
  ensureCodexEndpoint,
  stopRecordedCodexEndpoint,
  stopSeatCodexEndpoint,
  type CodexEndpointDeps,
} from '../../src/launch/codex-endpoint.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from '../helpers.ts';

const SESSION = 'acme';
const SEAT = 'worker';
const BINDING = 'prs_aaaaaaaaaaaa';
const OTHER = 'prs_bbbbbbbbbbbb';
const THIRD = 'prs_cccccccccccc';
const STARTED_AT = '2026-10-20T07:59:00.000Z';
const NOW = new Date('2026-10-20T08:00:00.000Z');

// The endpoint path has a 100-byte contract limit, so the state folder has to be short: macOS's
// own temporary folder is far too deep for a run/<session>/<seat>/<binding>.sock path. Linux's
// `/tmp` is already short; the macOS short temp is `/private/tmp`.
const SHORT_TMP = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function stateDir(): string {
  const dir = realpathSync(mkdtempSync(join(SHORT_TMP, 'b7ep-')));
  dirs.push(dir);
  return dir;
}

function socketOf(dir: string, binding = BINDING): string {
  return join(dir, 'run', SESSION, SEAT, `${binding}.sock`);
}

function recordOf(dir: string, binding = BINDING, pid = 500): CodexEndpointRecord {
  return { url: `unix://${socketOf(dir, binding)}`, binding, pid, started_at: STARTED_AT };
}

function seed(dir: string, input: { binding?: string; record?: CodexEndpointRecord } = {}): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = {
      stage: 'ready',
      presence_binding: input.binding ?? BINDING,
      ...(input.record === undefined ? {} : { codex_endpoint: input.record }),
    };
  });
}

function seat(dir: string) {
  return readState(dir).sessions[SESSION]?.seats[SEAT];
}

type Proc = { command: string; start: number };

/** A process that is provably the record's server: the exact command line and a start inside
 *  the record's window (the record is written after the process starts). */
function proven(url: string, over: Partial<Proc> = {}): Proc {
  return { command: `codex app-server --listen ${url}`, start: Date.parse(STARTED_AT) - 1_000, ...over };
}

type World = {
  dir: string;
  sockets: Set<string>;
  calls: string[];
  procs: Map<number, Proc>;
  deps: CodexEndpointDeps;
};

function world(input: {
  dir?: string;
  bind?: string;
  record?: (dir: string) => CodexEndpointRecord | undefined;
  procs?: (dir: string) => [number, Proc][];
  sockets?: (dir: string) => string[];
  deps?: Partial<CodexEndpointDeps>;
} = {}): World {
  const dir = input.dir ?? stateDir();
  seed(dir, { binding: input.bind ?? BINDING, record: input.record?.(dir) });
  const sockets = new Set(input.sockets?.(dir) ?? []);
  const calls: string[] = [];
  const procs = new Map(input.procs?.(dir) ?? []);
  const deps: CodexEndpointDeps = {
    spawn({ url }) {
      calls.push(`spawn ${url}`);
      sockets.add(url.slice('unix://'.length));
      return { pid: 501 };
    },
    alive: (pid) => procs.has(pid),
    commandOf: (pid) => procs.get(pid)?.command ?? null,
    startOf: (pid) => procs.get(pid)?.start ?? null,
    terminate: (pid) => {
      calls.push(`terminate ${pid}`);
      procs.delete(pid);
    },
    isPlainDir: () => true,
    isSocket: (path) => sockets.has(path),
    drop: (path) => {
      calls.push(`drop ${path}`);
      sockets.delete(path);
    },
    sleep: async () => {},
    now: () => NOW,
    waitMs: 0,
    ...input.deps,
  };
  // The stranger note comes from a real directory read, so the scenes that seed sockets put
  // actual files at those paths; only the `isSocket` answer is injected.
  for (const path of sockets) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }
  return { dir, sockets, calls, procs, deps };
}

async function ensure(w: World, deps: CodexEndpointDeps = w.deps) {
  return ensureCodexEndpoint({ dir: w.dir, session: SESSION, seat: SEAT, deps });
}

describe('the endpoint path and the recorded start', () => {
  test('the socket is <state>/run/<session>/<seat>/<binding>.sock', () => {
    const dir = '/state';
    expect(codexEndpointSocket(dir, SESSION, SEAT, BINDING)).toEqual({
      url: `unix://${join(dir, 'run', 'acme', 'worker', `${BINDING}.sock`)}`,
      path: join(dir, 'run', 'acme', 'worker', `${BINDING}.sock`),
    });
    // The session is the presence tree's own encoding, so a name cannot escape its folder.
    expect(codexEndpointSocket(dir, 'a b', SEAT, BINDING)?.path).toBe(join(dir, 'run', 'a%20b', 'worker', `${BINDING}.sock`));
    // Nothing this build cannot bind to names a socket: a bad binding, a seat that is not a path
    // segment, an empty session, and a path over the 100-byte limit.
    expect(codexEndpointSocket(dir, SESSION, SEAT, 'prs_nothex')).toBeNull();
    expect(codexEndpointSocket(dir, SESSION, 'bad/name', BINDING)).toBeNull();
    expect(codexEndpointSocket(dir, '', SEAT, BINDING)).toBeNull();
    expect(codexEndpointSocket(`/${'x'.repeat(90)}`, SESSION, SEAT, BINDING)).toBeNull();
  });

  test('a start binds that path, records the pid under it, and says it started', async () => {
    const w = world();
    const url = `unix://${socketOf(w.dir)}`;
    expect(await ensure(w)).toEqual({ kind: 'up', url, started: true });
    expect(w.calls).toEqual([`spawn ${url}`]);
    expect(w.sockets.has(socketOf(w.dir))).toBe(true);
    expect(seat(w.dir)?.codex_endpoint).toEqual({ url, binding: BINDING, pid: 501, started_at: NOW.toISOString() });
  });

  test('an unreadable state or no valid binding starts nothing', async () => {
    const unreadable = stateDir();
    writeFileSync(join(unreadable, 'team.state.json'), '{not json');
    const calls: string[] = [];
    const deps = { spawn: () => { calls.push('spawn'); return { pid: 9 }; } };
    const read = await ensureCodexEndpoint({ dir: unreadable, session: SESSION, seat: SEAT, deps });
    expect(read.kind).toBe('unmanaged');
    expect(read.kind === 'unmanaged' ? read.why : '').toContain('state is unreadable');
    expect(calls).toEqual([]);

    const w = world({ bind: '' });
    const none = await ensure(w);
    expect(none.kind).toBe('unmanaged');
    expect(none.kind === 'unmanaged' ? none.why : '').toContain('no valid presence binding');
    expect(w.calls).toEqual([]);
  });
});

describe('identity before reuse or signal', () => {
  test('a proven server on the same binding and socket is reused, with no call', async () => {
    const w = world({
      record: (dir) => recordOf(dir),
      procs: (dir) => [[500, proven(`unix://${socketOf(dir)}`)]],
      sockets: (dir) => [socketOf(dir)],
    });
    expect(await ensure(w)).toEqual({ kind: 'up', url: `unix://${socketOf(w.dir)}`, started: false });
    expect(w.calls).toEqual([]);
  });

  test('a pid the OS reused is never signalled: its start is after the record', async () => {
    const w = world({
      record: (dir) => recordOf(dir),
      procs: (dir) => [[500, proven(`unix://${socketOf(dir)}`, { start: Date.parse(STARTED_AT) + 60_000 })]],
      sockets: (dir) => [socketOf(dir)],
    });
    const read = await ensure(w);
    expect(read.kind).toBe('unmanaged');
    expect(read.kind === 'unmanaged' ? read.why : '').toContain('cannot be proven and stopped');
    expect(w.calls).toEqual([]);
    expect(w.sockets.has(socketOf(w.dir))).toBe(true);
    expect(seat(w.dir)?.codex_endpoint).toEqual(recordOf(w.dir));
  });

  test('a command line for another endpoint is never signalled', async () => {
    const w = world({
      record: (dir) => recordOf(dir),
      procs: () => [[500, proven('unix:///somewhere/else.sock')]],
      sockets: (dir) => [socketOf(dir)],
    });
    const read = await ensure(w);
    expect(read.kind).toBe('unmanaged');
    expect(w.calls).toEqual([]);
    expect(seat(w.dir)?.codex_endpoint).toEqual(recordOf(w.dir));
  });
});

describe('predecessors and strangers under the seat folder', () => {
  test('a proven predecessor is stopped, its record-named socket dropped, then the successor starts', async () => {
    const w = world({
      record: (dir) => recordOf(dir, OTHER),
      procs: (dir) => [[500, proven(`unix://${socketOf(dir, OTHER)}`)]],
      sockets: (dir) => [socketOf(dir, OTHER)],
    });
    const url = `unix://${socketOf(w.dir)}`;
    expect(await ensure(w)).toEqual({ kind: 'up', url, started: true });
    expect(w.calls).toEqual([`terminate 500`, `drop ${socketOf(w.dir, OTHER)}`, `spawn ${url}`]);
    expect(w.sockets.has(socketOf(w.dir, OTHER))).toBe(false);
    expect(w.sockets.has(socketOf(w.dir))).toBe(true);
    expect(seat(w.dir)?.codex_endpoint).toMatchObject({ binding: BINDING, pid: 501 });
  });

  test('an unprovable predecessor on another path is left alone and said', async () => {
    const w = world({
      record: (dir) => recordOf(dir, OTHER),
      procs: () => [[500, proven('unix:///other.sock')]],
      sockets: (dir) => [socketOf(dir, OTHER)],
    });
    const url = `unix://${socketOf(w.dir)}`;
    const read = await ensure(w);
    expect(read).toMatchObject({ kind: 'up', url, started: true });
    expect(read.kind === 'up' ? read.notes : undefined).toEqual([
      'the previous endpoint was left alone: the recorded process cannot be proven to serve this endpoint; it was not signalled',
    ]);
    expect(w.calls).toEqual([`spawn ${url}`]);
    expect(w.sockets.has(socketOf(w.dir, OTHER))).toBe(true);
  });

  test('a stranger socket no record names stays and is reported', async () => {
    const w = world({
      sockets: (dir) => [socketOf(dir, OTHER), join(dir, 'run', SESSION, SEAT, 'not-a-binding.sock')],
    });
    const read = await ensure(w);
    expect(read.kind).toBe('up');
    expect(read.kind === 'up' ? read.notes : undefined).toEqual([
      `an endpoint socket no record names was left in place: ${OTHER}.sock; nothing proves its process has gone`,
    ]);
    expect(w.calls).toEqual([`spawn unix://${socketOf(w.dir)}`]);
    expect(w.sockets.has(socketOf(w.dir, OTHER))).toBe(true);
  });

  test('a predecessor record socket goes while a stranger stays', async () => {
    const w = world({
      record: (dir) => recordOf(dir, OTHER),
      procs: (dir) => [[500, proven(`unix://${socketOf(dir, OTHER)}`)]],
      sockets: (dir) => [socketOf(dir, OTHER), socketOf(dir, THIRD)],
    });
    const read = await ensure(w);
    expect(read.kind).toBe('up');
    expect(read.kind === 'up' ? read.notes : undefined).toEqual([
      `an endpoint socket no record names was left in place: ${THIRD}.sock; nothing proves its process has gone`,
    ]);
    expect(w.calls).toEqual([`terminate 500`, `drop ${socketOf(w.dir, OTHER)}`, `spawn unix://${socketOf(w.dir)}`]);
    expect(w.sockets.has(socketOf(w.dir, OTHER))).toBe(false);
    expect(w.sockets.has(socketOf(w.dir, THIRD))).toBe(true);
  });
});

describe('a start that does not finish', () => {
  test('a server that never creates its socket is terminated, its socket dropped, and nothing recorded', async () => {
    let spawned = 0;
    const w = world({
      deps: {
        spawn: () => {
          spawned += 1;
          return { pid: 700 };
        },
      },
    });
    const read = await ensure(w);
    expect(spawned).toBe(1);
    expect(read.kind).toBe('unmanaged');
    expect(read.kind === 'unmanaged' ? read.why : '').toContain('did not create its socket in time');
    expect(w.calls).toEqual([`terminate 700`, `drop ${socketOf(w.dir)}`]);
    expect(seat(w.dir)?.codex_endpoint).toBeUndefined();
  });

  test('a binding that moves during the start takes the started server with it', async () => {
    let w!: World;
    const dir = stateDir();
    w = world({
      dir,
      deps: {
        spawn: (input) => {
          w.sockets.add(input.url.slice('unix://'.length));
          updateState(dir, (state) => {
            state.sessions[SESSION]!.seats[SEAT]!.presence_binding = OTHER;
          });
          return { pid: 701 };
        },
      },
    });
    const read = await ensure(w);
    expect(read.kind).toBe('unmanaged');
    expect(read.kind === 'unmanaged' ? read.why : '').toContain('binding changed while the endpoint started');
    expect(w.calls).toEqual([`terminate 701`, `drop ${socketOf(dir)}`]);
    expect(seat(w.dir)?.presence_binding).toBe(OTHER);
    expect(seat(w.dir)?.codex_endpoint).toBeUndefined();
  });
});

type StopHarness = { calls: string[]; procs: Map<number, Proc>; sockets: Set<string>; deps: CodexEndpointDeps };

function stopHarness(
  input: { procs?: [number, Proc][]; sockets?: string[] } = {},
  over: Partial<CodexEndpointDeps> = {},
): StopHarness {
  const calls: string[] = [];
  const procs = new Map(input.procs ?? []);
  const sockets = new Set(input.sockets ?? []);
  const deps: CodexEndpointDeps = {
    alive: (pid) => procs.has(pid),
    commandOf: (pid) => procs.get(pid)?.command ?? null,
    startOf: (pid) => procs.get(pid)?.start ?? null,
    terminate: (pid) => {
      calls.push(`terminate ${pid}`);
      procs.delete(pid);
    },
    isPlainDir: () => true,
    isSocket: (path) => sockets.has(path),
    drop: (path) => {
      calls.push(`drop ${path}`);
      sockets.delete(path);
    },
    ...over,
  };
  return { calls, procs, sockets, deps };
}

describe('the recorded stop', () => {
  test('a record for another folder is never touched', () => {
    const dir = stateDir();
    const elsewhere: CodexEndpointRecord = { ...recordOf(dir), url: 'unix:///elsewhere/prs_aaaaaaaaaaaa.sock' };
    const stop = stopHarness();
    const read = stopRecordedCodexEndpoint({ dir, session: SESSION, seat: SEAT, record: elsewhere }, stop.deps);
    expect(read.stopped).toBe(false);
    expect(read.why).toContain('does not name this seat');
    expect(stop.calls).toEqual([]);
  });

  test('a folder that is not a plain directory is refused', () => {
    const dir = stateDir();
    const stop = stopHarness({ sockets: [socketOf(dir)] }, { isPlainDir: () => false });
    const read = stopRecordedCodexEndpoint({ dir, session: SESSION, seat: SEAT, record: recordOf(dir) }, stop.deps);
    expect(read.stopped).toBe(false);
    expect(read.why).toContain('not a plain directory');
    expect(stop.calls).toEqual([]);
  });

  test('no socket file at the record path means nothing to do, and nothing is signalled', () => {
    const dir = stateDir();
    const stop = stopHarness({ procs: [[500, proven(`unix://${socketOf(dir)}`)]] });
    const read = stopRecordedCodexEndpoint({ dir, session: SESSION, seat: SEAT, record: recordOf(dir) }, stop.deps);
    expect(read).toEqual({ stopped: true });
    expect(stop.calls).toEqual([]);
  });

  test('an unproven live process is preserved', () => {
    const dir = stateDir();
    const stop = stopHarness({
      procs: [[500, proven(`unix://${socketOf(dir)}`, { start: Date.parse(STARTED_AT) + 60_000 })]],
      sockets: [socketOf(dir)],
    });
    const read = stopRecordedCodexEndpoint({ dir, session: SESSION, seat: SEAT, record: recordOf(dir) }, stop.deps);
    expect(read.stopped).toBe(false);
    expect(read.why).toContain('cannot be proven');
    expect(stop.calls).toEqual([]);
    expect(stop.sockets.has(socketOf(dir))).toBe(true);
  });

  test('a proven process is signalled and exactly its socket unlinked', () => {
    const dir = stateDir();
    const stop = stopHarness({
      procs: [[500, proven(`unix://${socketOf(dir)}`)]],
      sockets: [socketOf(dir), socketOf(dir, OTHER)],
    });
    const read = stopRecordedCodexEndpoint({ dir, session: SESSION, seat: SEAT, record: recordOf(dir) }, stop.deps);
    expect(read).toEqual({ stopped: true });
    expect(stop.calls).toEqual([`terminate 500`, `drop ${socketOf(dir)}`]);
    expect(stop.sockets.has(socketOf(dir))).toBe(false);
    expect(stop.sockets.has(socketOf(dir, OTHER))).toBe(true);
  });

  test('a dead process leaves only its socket removal', () => {
    const dir = stateDir();
    const stop = stopHarness({ sockets: [socketOf(dir)] });
    const read = stopRecordedCodexEndpoint({ dir, session: SESSION, seat: SEAT, record: recordOf(dir) }, stop.deps);
    expect(read).toEqual({ stopped: true });
    expect(stop.calls).toEqual([`drop ${socketOf(dir)}`]);
  });
});

describe('the seat stop and its record', () => {
  test('a proven stop clears the record and keeps the binding', () => {
    const dir = stateDir();
    seed(dir, { record: recordOf(dir) });
    const stop = stopHarness({
      procs: [[500, proven(`unix://${socketOf(dir)}`)]],
      sockets: [socketOf(dir)],
    });
    expect(stopSeatCodexEndpoint({ dir, session: SESSION, seat: SEAT }, stop.deps)).toEqual({ stopped: true });
    expect(seat(dir)?.presence_binding).toBe(BINDING);
    expect(seat(dir)?.codex_endpoint).toBeUndefined();
    expect(stop.calls).toEqual([`terminate 500`, `drop ${socketOf(dir)}`]);
  });

  test('an unproven stop keeps the record visible', () => {
    const dir = stateDir();
    seed(dir, { record: recordOf(dir) });
    const stop = stopHarness({
      procs: [[500, { command: 'node app-server --listen whatever', start: Date.parse(STARTED_AT) }]],
      sockets: [socketOf(dir)],
    });
    const read = stopSeatCodexEndpoint({ dir, session: SESSION, seat: SEAT }, stop.deps);
    expect(read.stopped).toBe(false);
    expect(read.why).toContain('cannot be proven');
    expect(seat(dir)?.codex_endpoint).toEqual(recordOf(dir));
    expect(stop.calls).toEqual([]);
  });

  test('a record for another binding is not this seat’s endpoint', () => {
    const dir = stateDir();
    seed(dir, { record: recordOf(dir, OTHER) });
    const stop = stopHarness({ sockets: [socketOf(dir, OTHER)] });
    const read = stopSeatCodexEndpoint({ dir, session: SESSION, seat: SEAT }, stop.deps);
    expect(read.stopped).toBe(false);
    expect(read.why).toContain('records no endpoint for its current binding');
    expect(stop.calls).toEqual([]);
    expect(seat(dir)?.codex_endpoint).toEqual(recordOf(dir, OTHER));
  });
});

// ----- the removal lifecycle, with the stop injected -------------------------------------------

const REMOVE_FILE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const REMOVE_BINDING = 'prs_ab12cd34ef56';
const REMOVE_STARTED_AT = '2026-10-15T11:00:00Z';

type Place = { base: string; root: string; home: string; file: string; dir: string };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function place(workerExtra = ''): Place {
  const base = realpathSync(mkdtempSync(join(SHORT_TMP, 'b7rm-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  const file = join(root, '.agents', 'team.yaml');
  // The worker's stanza carries whatever extra the scene asks for (a human flag, say).
  const withWorker = REMOVE_FILE.replace(
    '    name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n',
    `    name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n${workerExtra}`,
  );
  writeFileSync(file, withWorker);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, new Date(REMOVE_STARTED_AT)), file: withWorker },
    loaded.team.seats,
    home,
  );
  return { base, root, home, file, dir: join(root, '.agents') };
}

function seedRemovalEndpoint(at: Place): void {
  updateState(at.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.worker = {
      stage: 'ready',
      pane: 'w1:p1',
      presence_binding: REMOVE_BINDING,
      codex_endpoint: {
        url: `unix://${join(at.dir, 'run', 'acme', 'worker', `${REMOVE_BINDING}.sock`)}`,
        binding: REMOVE_BINDING,
        pid: 4242,
        started_at: REMOVE_STARTED_AT,
      },
    };
  });
}

function removeSeat(at: Place) {
  return readState(at.dir).sessions.acme?.seats?.worker;
}

const agent = (name: string, status = 'idle'): HerdrAgent => ({
  name, agent: 'claude', pane: 'w1:p1', workspace: 'w1', status, cwd: null,
});

function removeLaunch(over: Partial<DownLaunch> = {}): DownLaunch {
  return {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => ['w1:p1'],
    closeWorkspace: () => true,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => new Date(REMOVE_STARTED_AT),
    ...over,
  };
}

function removeSources(
  at: Place,
  over: Partial<RemoveSources> = {},
  stop?: () => { stopped: boolean; why?: string },
): { sources: RemoveSources; calls: string[] } {
  const calls: string[] = [];
  const sources: RemoveSources = {
    ...downSources,
    home: at.home,
    sessionRunning: () => false,
    agents: () => [],
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    foregroundCwd: () => null,
    now: () => new Date(REMOVE_STARTED_AT),
    sleep: async () => {},
    ...(stop === undefined
      ? {}
      : {
          codexEndpoint: {
            stop: (seen) => {
              calls.push(`stop ${seen.session}/${seen.seat}`);
              return stop();
            },
          },
        }),
    ...over,
  };
  return { sources, calls };
}

describe('removal and the managed endpoint', () => {
  test('a human seat whose pane stays is refused, endpoint and record intact', async () => {
    const at = place('    human: true\n');
    seedRemovalEndpoint(at);
    const { sources, calls } = removeSources(
      at,
      { sessionRunning: () => true, agents: () => [agent('worker')] },
      () => ({ stopped: true }),
    );
    const io = testIo(at.root, { kind: 'owner' });
    expect(await runRemove(['worker'], io, sources)).toBe(1);
    expect(io.err).toContain('records a managed Codex endpoint');
    expect(calls).toEqual([]);
    expect(removeSeat(at)?.codex_endpoint).toBeDefined();
    expect(readFileSync(at.file, 'utf8')).toContain('name: worker');
  });

  test('a dead CLI’s endpoint is stopped before the file or the record changes', async () => {
    const at = place();
    seedRemovalEndpoint(at);
    let recordAtStop = false;
    let fileAtStop = false;
    const { sources, calls } = removeSources(at, {}, () => {
      recordAtStop = removeSeat(at)?.codex_endpoint !== undefined;
      fileAtStop = readFileSync(at.file, 'utf8').includes('name: worker');
      return { stopped: true };
    });
    const io = testIo(at.root, { kind: 'owner' });
    expect(await runRemove(['worker'], io, sources)).toBe(0);
    expect(calls).toEqual(['stop acme/worker']);
    expect(recordAtStop).toBe(true);
    expect(fileAtStop).toBe(true);
    expect(removeSeat(at)).toBeUndefined();
    expect(readFileSync(at.file, 'utf8')).not.toContain('name: worker');
  });

  test('a stop that cannot prove its process fails the removal and keeps the record', async () => {
    const at = place();
    seedRemovalEndpoint(at);
    const { sources, calls } = removeSources(at, {}, () => ({
      stopped: false,
      why: 'the recorded process cannot be proven to serve this endpoint; it was not signalled',
    }));
    const io = testIo(at.root, { kind: 'owner' });
    expect(await runRemove(['worker'], io, sources)).toBe(1);
    expect(io.err).toContain('cannot be proven');
    expect(io.err).toContain('left as it is');
    expect(calls).toHaveLength(1);
    expect(removeSeat(at)?.codex_endpoint).toMatchObject({ pid: 4242 });
    expect(readFileSync(at.file, 'utf8')).toContain('name: worker');
  });

  test('a running CLI exits first, and the endpoint stops after it', async () => {
    const at = place();
    seedRemovalEndpoint(at);
    let typed = '';
    let shelled = false;
    const { sources, calls } = removeSources(
      at,
      {
        sessionRunning: () => true,
        agents: () => [agent('worker')],
        screenText: () => (typed === '' ? CLAUDE_IDLE : claudeBox(typed)),
        foreground: () => (shelled ? ['zsh'] : ['claude']),
        launch: removeLaunch({
          typeText: (_session, _pane, text) => {
            typed = text;
            return true;
          },
          pressEnter: () => {
            shelled = true;
            return true;
          },
        }),
      },
      () => {
        expect(shelled).toBe(true);
        return { stopped: true };
      },
    );
    const io = testIo(at.root, { kind: 'owner' });
    expect(await runRemove(['worker'], io, sources)).toBe(0);
    expect(calls).toEqual(['stop acme/worker']);
    expect(removeSeat(at)).toBeUndefined();
  });

  test('--keep takes the same stop path', async () => {
    const at = place();
    seedRemovalEndpoint(at);
    const { sources, calls } = removeSources(at, {}, () => ({ stopped: true }));
    const io = testIo(at.root, { kind: 'owner' });
    expect(await runRemove(['worker', '--keep'], io, sources)).toBe(0);
    expect(calls).toEqual(['stop acme/worker']);
    expect(removeSeat(at)).toBeUndefined();
    expect(seatIsStopped(readFileSync(at.file, 'utf8'), 'worker')).toBe(true);
  });

  test('the refusal carries the contract id under --json', async () => {
    const at = place();
    seedRemovalEndpoint(at);
    const { sources } = removeSources(at, {}, () => ({ stopped: false, why: 'not this process' }));
    const io = testIo(at.root, { kind: 'owner' });
    expect(await runRemove(['worker', '--json'], io, sources)).toBe(1);
    expect(JSON.parse(io.out).error.id).toBe('remove.endpoint');
    expect(removeSeat(at)?.codex_endpoint).toBeDefined();
  });
});
