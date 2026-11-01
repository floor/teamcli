// The endpoint-thread binding a restarted managed Codex seat needs, against a real Unix-socket
// WebSocket app-server (the fake is `test/helpers/fake-codex-thread-endpoint.ts`; the transport,
// the codec, the readers and the state/registry writes are the production modules).
//
// Scenes:
// 1. The reader asks for the endpoint's loaded threads and answers the ids it holds.
// 2. An empty list is a reading, not a failure.
// 3. A list with more pages is refused: a caller cannot prove it saw every thread.
// 4. A refusal from the endpoint is unavailable, with the endpoint's own words.
// 5. A list whose entries are not strings is unavailable.
// 6. An endpoint that is not an explicit unix socket path is refused before any dial.
// 7. A socket that is not there is unavailable (ENOENT).
// 8. One loaded thread is bound to the seat state and the agent record, and the delivery class
//    reads between-turns: the point of the bind.
// 9. Several loaded threads prove nothing; the records are left as they were and the answer says
//    how many it saw.
// 10. A state that names a thread its endpoint does not hold is not rebound.
// 11. A state that names a thread the endpoint holds repairs a record that lost it.
// 12. A record whose handle is another incarnation's is refused before the state is written.
// 13. An endpoint recorded inside another seat's run folder is not read or bound.
// 14. An endpoint two seats both record is refused as ambiguous.
// 15. A seat that relaunches while its named thread is read keeps the successor's records.
// 16. A seat that relaunches while its unnamed thread is read keeps the successor's agreement.
// 17. A record whose conversation another writer replaced during the read is not overwritten.
// 18. An endpoint replaced under the same incarnation during the read is refused.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLoadedCodexThreads, type CodexLoadedThreadsRead } from '../src/daemon/presence/codex-source.ts';
import { codexEndpointSocket } from '../src/launch/codex-endpoint.ts';
import { seatDeliveryClass } from '../src/launch/delivery-class.ts';
import { bindCodexSeatThread } from '../src/launch/codex-thread-binding.ts';
import { findAgent, recordAgentSession, registerAgent } from '../src/registry/agents.ts';
import { recordedSeatSession } from '../src/registry/resume.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState, type SeatState } from '../src/state.ts';
import { startFakeThreadEndpoint, type FakeThreadEndpoint } from './helpers/fake-codex-thread-endpoint.ts';

const THREAD = '01a1945b-5982-7751-9476-6a2ef1c45d6d';
const OTHER_THREAD = '01a1945b-1111-7222-8333-444455556666';
const OLD_THREAD = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const BINDING = 'prs_0123456789ab';

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function world(): {
  base: string;
  root: string;
  home: string;
  dir: string;
  socketPath: string;
} {
  // The host's own temp directory, never a fixed one, with short relative names (`s` for the
  // state folder, `tk` and `w` for the fixture's session and seat) so the owned endpoint path this
  // build computes (`<dir>/run/<session>/<seat>/<binding>.sock`) stays inside the socket path
  // limit under the longer temp parents as well.
  const base = mkdtempSync(join(tmpdir(), 'tc-'));
  const root = join(base, 'root');
  const home = join(base, 'home');
  const dir = join(base, 's');
  mkdirSync(root, { recursive: true });
  mkdirSync(dir, { recursive: true });
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return { base, root, home, dir, socketPath: join(base, 'run', 'codex.sock') };
}

/** The endpoint path this build's managed launch gives the scene's seat under the binding. */
function ownedSocket(
  w: ReturnType<typeof world>,
  seat = 'w',
  binding = BINDING,
): { url: string; path: string } {
  const socket = codexEndpointSocket(w.dir, 'tk', seat, binding);
  if (socket === null) throw new Error('the fixture state folder is too long for an owned endpoint path');
  return socket;
}

async function endpoint(
  socketPath: string,
  answer: Parameters<typeof startFakeThreadEndpoint>[1]['answer'],
): Promise<FakeThreadEndpoint> {
  const started = await startFakeThreadEndpoint(socketPath, { answer });
  cleanups.push(() => started.close());
  return started;
}

/** A state record for one managed Codex seat, exactly as a launch writes it: a stage, a live
 *  pane, a presence incarnation and the endpoint recorded under it. */
function seatRecord(binding: string, socketPath: string): SeatState {
  return {
    id: 'seat_0123456789ab',
    stage: 'ready',
    pane: 'pane-new',
    presence_binding: binding,
    codex_endpoint: {
      url: `unix://${socketPath}`,
      binding,
      pid: 4242,
      started_at: '2026-11-01T00:00:00.000Z',
      config: [],
    },
  };
}

function registerWorker(
  home: string,
  root: string,
  opts: { agentSession?: string; seatHandle?: string } = {},
): string {
  return registerAgent(home, {
    name: 'w',
    signing: { model: 'GPT Sol', version: '6.1', role: 'implementer' },
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6.1-sol',
    reach: {
      team: teamIdOf(root),
      seat: 'w',
      session: 'tk',
      pane: 'pane-new',
      address: null,
      ...(opts.agentSession === undefined ? {} : { agent_session: opts.agentSession }),
    },
    seat_handle: opts.seatHandle ?? 'seat_0123456789ab',
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team restart',
  }).id;
}

function writeState(dir: string, seat: SeatState): void {
  updateState(dir, (state) => {
    const session = (state.sessions.tk ??= emptySession());
    session.seats.w = seat;
  });
}

/** The binding call every scene makes, with the endpoint read replaced only where the scene
 *  injects one. */
function bind(
  w: ReturnType<typeof world>,
  state: SeatState,
  read: (endpoint: string) => Promise<CodexLoadedThreadsRead> = (url) => readLoadedCodexThreads({ endpoint: url }),
) {
  return bindCodexSeatThread({
    home: w.home,
    root: w.root,
    dir: w.dir,
    session: 'tk',
    seat: { name: 'w', cli: 'codex' },
    state,
    read,
  });
}

/** The class a send prints for the scene's seat, read from the records as they stand now. */
function deliveryOf(w: ReturnType<typeof world>) {
  return seatDeliveryClass({
    home: w.home,
    dir: w.dir,
    root: w.root,
    session: 'tk',
    seat: 'w',
    declared: { cli: 'codex', launch: 'codex -m gpt-6.1-sol' },
    state: readState(w.dir).sessions.tk?.seats.w,
  });
}

describe('readLoadedCodexThreads', () => {
  test('asks initialize, initialized and thread/loaded/list, and answers the loaded ids', async () => {
    const w = world();
    const server = await endpoint(w.socketPath, { ids: [THREAD] });

    const read = await readLoadedCodexThreads({ endpoint: `unix://${w.socketPath}` });

    expect(read).toEqual({ kind: 'read', ids: [THREAD] });
    expect(server.requests).toEqual(['initialize', 'initialized', 'thread/loaded/list']);
  });

  test('an empty list is a reading, not a failure', async () => {
    const w = world();
    await endpoint(w.socketPath, { ids: [] });

    expect(await readLoadedCodexThreads({ endpoint: `unix://${w.socketPath}` }))
      .toEqual({ kind: 'read', ids: [] });
  });

  test('a list with another page is refused rather than half read', async () => {
    const w = world();
    await endpoint(w.socketPath, { ids: [THREAD], nextCursor: 'cursor-2' });

    const read = await readLoadedCodexThreads({ endpoint: `unix://${w.socketPath}` });
    expect(read.kind).toBe('unavailable');
    expect(read.kind === 'unavailable' ? read.why : '').toContain('more threads than one page');
  });

  test('a refusal from the endpoint is unavailable, with the endpoint\'s own words', async () => {
    const w = world();
    await endpoint(w.socketPath, { error: { code: -32601, message: 'method not found' } });

    const read = await readLoadedCodexThreads({ endpoint: `unix://${w.socketPath}` });
    expect(read.kind).toBe('unavailable');
    expect(read.kind === 'unavailable' ? read.why : '').toContain('method not found');
  });

  test('a list whose entries are not thread ids is unavailable', async () => {
    const w = world();
    await endpoint(w.socketPath, { result: { data: [THREAD, 7], nextCursor: null } });

    const read = await readLoadedCodexThreads({ endpoint: `unix://${w.socketPath}` });
    expect(read.kind).toBe('unavailable');
    expect(read.kind === 'unavailable' ? read.why : '').toContain('without a list of thread ids');
  });

  test('an endpoint that is not an explicit unix socket path is refused before any dial', async () => {
    const read = await readLoadedCodexThreads({ endpoint: 'http://127.0.0.1:1234' });
    expect(read.kind).toBe('unavailable');
    expect(read.kind === 'unavailable' ? read.why : '').toContain('unix:///');
  });

  test('a socket that is not there is unavailable (ENOENT)', async () => {
    const w = world();
    const read = await readLoadedCodexThreads({ endpoint: `unix://${w.socketPath}` });
    expect(read.kind).toBe('unavailable');
    expect(read.kind === 'unavailable' ? read.why : '').toContain('ENOENT');
  });
});

describe('bindCodexSeatThread', () => {
  test('one loaded thread is bound to the state and the agent record, and the class reads between-turns', async () => {
    const w = world();
    const socket = ownedSocket(w);
    await endpoint(socket.path, { ids: [THREAD] });
    const agentId = registerWorker(w.home, w.root, { agentSession: OLD_THREAD });
    const state = seatRecord(BINDING, socket.path);
    writeState(w.dir, state);

    const bound = await bindCodexSeatThread({
      home: w.home,
      root: w.root,
      dir: w.dir,
      session: 'tk',
      seat: { name: 'w', cli: 'codex' },
      state,
      read: (endpointUrl) => readLoadedCodexThreads({ endpoint: endpointUrl }),
    });

    expect(bound).toEqual({ kind: 'bound', id: THREAD });
    const after = readState(w.dir).sessions.tk?.seats.w;
    expect(after?.agent_session).toBe(THREAD);
    const record = findAgent(w.home, { team: teamIdOf(w.root), seat: 'w' });
    expect(record?.id).toBe(agentId);
    expect(record?.reach.agent_session).toBe(THREAD);
    // The two records agree: the reader the native route and the class share binds the seat.
    expect(recordedSeatSession({
      home: w.home,
      root: w.root,
      herdrSession: 'tk',
      seat: { name: 'w', cli: 'codex' },
      state: after,
    }).kind).toBe('bound');
    const delivery = seatDeliveryClass({
      home: w.home,
      dir: w.dir,
      root: w.root,
      session: 'tk',
      seat: 'w',
      declared: { cli: 'codex', launch: 'codex -m gpt-6.1-sol' },
      state: after,
    });
    expect(delivery.class).toBe('between-turns');
    expect(delivery.words).toBe('woken through its runtime queue');
  });

  test('several loaded threads prove nothing; the records are left as they were', async () => {
    const w = world();
    const socket = ownedSocket(w);
    await endpoint(socket.path, { ids: [THREAD, OTHER_THREAD] });
    registerWorker(w.home, w.root, { agentSession: OLD_THREAD });
    const state = seatRecord(BINDING, socket.path);
    writeState(w.dir, state);

    const bound = await bindCodexSeatThread({
      home: w.home,
      root: w.root,
      dir: w.dir,
      session: 'tk',
      seat: { name: 'w', cli: 'codex' },
      state,
      read: (endpointUrl) => readLoadedCodexThreads({ endpoint: endpointUrl }),
    });

    expect(bound.kind).toBe('unbound');
    expect(bound.kind === 'unbound' ? bound.why : '').toContain('holds 2 threads');
    expect(readState(w.dir).sessions.tk?.seats.w?.agent_session).toBeUndefined();
    expect(findAgent(w.home, { team: teamIdOf(w.root), seat: 'w' })?.reach.agent_session).toBe(OLD_THREAD);
  });

  test('a state naming a thread its endpoint does not hold is not rebound', async () => {
    const w = world();
    const socket = ownedSocket(w);
    await endpoint(socket.path, { ids: [THREAD] });
    registerWorker(w.home, w.root, { agentSession: OLD_THREAD });
    const state = { ...seatRecord(BINDING, socket.path), agent_session: OLD_THREAD };
    writeState(w.dir, state);

    const bound = await bindCodexSeatThread({
      home: w.home,
      root: w.root,
      dir: w.dir,
      session: 'tk',
      seat: { name: 'w', cli: 'codex' },
      state,
      read: (endpointUrl) => readLoadedCodexThreads({ endpoint: endpointUrl }),
    });

    expect(bound.kind).toBe('unbound');
    expect(bound.kind === 'unbound' ? bound.why : '').toContain('does not hold');
    expect(readState(w.dir).sessions.tk?.seats.w?.agent_session).toBe(OLD_THREAD);
  });

  test('a state naming a thread the endpoint holds repairs a record that lost it', async () => {
    const w = world();
    const socket = ownedSocket(w);
    await endpoint(socket.path, { ids: [THREAD] });
    registerWorker(w.home, w.root);
    const state = { ...seatRecord(BINDING, socket.path), agent_session: THREAD };
    writeState(w.dir, state);
    expect(findAgent(w.home, { team: teamIdOf(w.root), seat: 'w' })?.reach.agent_session).toBeUndefined();

    const bound = await bindCodexSeatThread({
      home: w.home,
      root: w.root,
      dir: w.dir,
      session: 'tk',
      seat: { name: 'w', cli: 'codex' },
      state,
      read: (endpointUrl) => readLoadedCodexThreads({ endpoint: endpointUrl }),
    });

    expect(bound).toEqual({ kind: 'bound', id: THREAD });
    expect(findAgent(w.home, { team: teamIdOf(w.root), seat: 'w' })?.reach.agent_session).toBe(THREAD);
    expect(recordedSeatSession({
      home: w.home,
      root: w.root,
      herdrSession: 'tk',
      seat: { name: 'w', cli: 'codex' },
      state: readState(w.dir).sessions.tk?.seats.w,
    }).kind).toBe('bound');
  });

  test('a record whose handle is another incarnation\'s is refused before the state is written', async () => {
    const w = world();
    const socket = ownedSocket(w);
    await endpoint(socket.path, { ids: [THREAD] });
    registerWorker(w.home, w.root, { agentSession: OLD_THREAD, seatHandle: 'seat_999999999999' });
    const state = seatRecord(BINDING, socket.path);
    writeState(w.dir, state);

    const bound = await bind(w, state);

    // The seat name alone is not identity: the record's stable handle names another incarnation,
    // so it is refused and left as it was, and the state never gains the thread.
    expect(bound.kind).toBe('unbound');
    expect(bound.kind === 'unbound' ? bound.why : '').toContain('another agent for this seat');
    expect(readState(w.dir).sessions.tk?.seats.w?.agent_session).toBeUndefined();
    expect(findAgent(w.home, { team: teamIdOf(w.root), seat: 'w' })?.reach.agent_session).toBe(OLD_THREAD);
    expect(deliveryOf(w).class).toBe('pull-on-turn');
  });

  test('an endpoint recorded inside another seat\'s run folder is not read or bound', async () => {
    const w = world();
    const foreign = ownedSocket(w, 'o');
    await endpoint(foreign.path, { ids: [THREAD] });
    registerWorker(w.home, w.root, { agentSession: OLD_THREAD });
    const state = seatRecord(BINDING, foreign.path);
    writeState(w.dir, state);

    const bound = await bind(w, state);

    // The record is well-formed and its binding matches, but its URL is another seat's own
    // socket: nothing proves this seat's launch gave it, so the thread is not read.
    expect(bound.kind).toBe('unbound');
    expect(bound.kind === 'unbound' ? bound.why : '').toContain('not the one its launch owns');
    expect(readState(w.dir).sessions.tk?.seats.w?.agent_session).toBeUndefined();
    expect(findAgent(w.home, { team: teamIdOf(w.root), seat: 'w' })?.reach.agent_session).toBe(OLD_THREAD);
    expect(deliveryOf(w).class).toBe('pull-on-turn');
  });

  test('an endpoint two seats both record is refused as ambiguous', async () => {
    const w = world();
    const socket = ownedSocket(w);
    await endpoint(socket.path, { ids: [THREAD] });
    registerWorker(w.home, w.root, { agentSession: OLD_THREAD });
    const state = seatRecord(BINDING, socket.path);
    updateState(w.dir, (file) => {
      const session = (file.sessions.tk ??= emptySession());
      session.seats.w = state;
      // A second live seat records the very same endpoint.
      session.seats.o = { ...seatRecord(BINDING, socket.path), id: 'seat_111111111111', pane: 'pane-other' };
    });

    const bound = await bind(w, state);

    expect(bound.kind).toBe('unbound');
    expect(bound.kind === 'unbound' ? bound.why : '').toContain('another seat records the same Codex endpoint');
    expect(readState(w.dir).sessions.tk?.seats.w?.agent_session).toBeUndefined();
    expect(findAgent(w.home, { team: teamIdOf(w.root), seat: 'w' })?.reach.agent_session).toBe(OLD_THREAD);
    expect(deliveryOf(w).class).toBe('pull-on-turn');
  });

  // The named path has no state write of its own, so nothing but a fence can stop it from writing
  // the predecessor's thread over a successor's: the successor installs its incarnation, endpoint
  // and thread in both records while the predecessor's endpoint read is still in flight.
  test('a seat that relaunches while its named thread is read keeps the successor\'s records', async () => {
    const w = world();
    const socket = ownedSocket(w);
    const nextBinding = 'prs_999999999999';
    const nextSocket = ownedSocket(w, 'w', nextBinding);
    await endpoint(socket.path, { ids: [OLD_THREAD] });
    const agentId = registerWorker(w.home, w.root, { agentSession: OLD_THREAD });
    const state = { ...seatRecord(BINDING, socket.path), agent_session: OLD_THREAD };
    writeState(w.dir, state);

    const bound = await bind(w, state, async () => {
      updateState(w.dir, (file) => {
        const held = file.sessions.tk!.seats.w!;
        held.presence_binding = nextBinding;
        held.codex_endpoint = {
          url: nextSocket.url,
          binding: nextBinding,
          pid: 4343,
          started_at: '2026-11-01T00:00:01.000Z',
          config: [],
        };
        held.agent_session = THREAD;
      });
      recordAgentSession(w.home, agentId, THREAD);
      return { kind: 'read', ids: [OLD_THREAD] };
    });

    // The thread just read is the predecessor's: bound, it would leave the state naming the
    // successor's conversation and the registry naming the predecessor's.
    expect(bound.kind).toBe('unbound');
    expect(bound.kind === 'unbound' ? bound.why : '').toContain('relaunched');
    const after = readState(w.dir).sessions.tk?.seats.w;
    expect(after?.presence_binding).toBe(nextBinding);
    expect(after?.agent_session).toBe(THREAD);
    expect(findAgent(w.home, { team: teamIdOf(w.root), seat: 'w' })?.reach.agent_session).toBe(THREAD);
    expect(recordedSeatSession({
      home: w.home,
      root: w.root,
      herdrSession: 'tk',
      seat: { name: 'w', cli: 'codex' },
      state: after,
    }).kind).toBe('bound');
  });

  // The control the predecessor already had: an unnamed seat whose incarnation moves during the
  // read refuses too, and the successor's two records still agree afterwards.
  test('a seat that relaunches while its unnamed thread is read keeps the successor\'s agreement', async () => {
    const w = world();
    const socket = ownedSocket(w);
    const nextBinding = 'prs_999999999999';
    const nextSocket = ownedSocket(w, 'w', nextBinding);
    await endpoint(socket.path, { ids: [THREAD] });
    const agentId = registerWorker(w.home, w.root);
    const state = seatRecord(BINDING, socket.path);
    writeState(w.dir, state);

    const bound = await bind(w, state, async () => {
      updateState(w.dir, (file) => {
        const held = file.sessions.tk!.seats.w!;
        held.presence_binding = nextBinding;
        held.codex_endpoint = {
          url: nextSocket.url,
          binding: nextBinding,
          pid: 4343,
          started_at: '2026-11-01T00:00:01.000Z',
          config: [],
        };
        held.agent_session = OTHER_THREAD;
      });
      recordAgentSession(w.home, agentId, OTHER_THREAD);
      return { kind: 'read', ids: [THREAD] };
    });

    expect(bound.kind).toBe('unbound');
    expect(bound.kind === 'unbound' ? bound.why : '').toContain('relaunched');
    const after = readState(w.dir).sessions.tk?.seats.w;
    expect(after?.presence_binding).toBe(nextBinding);
    expect(after?.agent_session).toBe(OTHER_THREAD);
    expect(findAgent(w.home, { team: teamIdOf(w.root), seat: 'w' })?.reach.agent_session).toBe(OTHER_THREAD);
    expect(deliveryOf(w).class).toBe('between-turns');
  });

  // A record can be replaced without the state moving: another writer records a conversation on
  // the same record while the endpoint is read. That conversation is a later binding, and the
  // registry alone would end up naming it if this run wrote over it.
  test('a record whose conversation another writer replaced during the read is not overwritten', async () => {
    const w = world();
    const socket = ownedSocket(w);
    await endpoint(socket.path, { ids: [THREAD] });
    const agentId = registerWorker(w.home, w.root);
    const state = seatRecord(BINDING, socket.path);
    writeState(w.dir, state);

    const bound = await bind(w, state, async () => {
      recordAgentSession(w.home, agentId, OTHER_THREAD);
      return { kind: 'read', ids: [THREAD] };
    });

    expect(bound.kind).toBe('unbound');
    expect(bound.kind === 'unbound' ? bound.why : '').toContain('names another thread');
    expect(readState(w.dir).sessions.tk?.seats.w?.agent_session).toBeUndefined();
    expect(findAgent(w.home, { team: teamIdOf(w.root), seat: 'w' })?.reach.agent_session).toBe(OTHER_THREAD);
    expect(deliveryOf(w).class).toBe('pull-on-turn');
  });

  // The same incarnation can record a different endpoint — the same seat relaunched under the
  // binding this run read from. The thread just read belongs to the socket that was replaced, so
  // binding it would advertise a queue the recorded endpoint does not serve.
  test('an endpoint replaced under the same incarnation during the read is refused', async () => {
    const w = world();
    const socket = ownedSocket(w);
    const replaced = ownedSocket(w, 'w', 'prs_000000000000');
    await endpoint(socket.path, { ids: [THREAD] });
    registerWorker(w.home, w.root);
    const state = seatRecord(BINDING, socket.path);
    writeState(w.dir, state);

    const bound = await bind(w, state, async () => {
      updateState(w.dir, (file) => {
        const held = file.sessions.tk!.seats.w!;
        held.codex_endpoint = { ...held.codex_endpoint!, url: replaced.url };
      });
      return { kind: 'read', ids: [THREAD] };
    });

    expect(bound.kind).toBe('unbound');
    expect(bound.kind === 'unbound' ? bound.why : '').toContain('endpoint changed');
    const after = readState(w.dir).sessions.tk?.seats.w;
    expect(after?.agent_session).toBeUndefined();
    expect(after?.codex_endpoint?.url).toBe(replaced.url);
    expect(findAgent(w.home, { team: teamIdOf(w.root), seat: 'w' })?.reach.agent_session).toBeUndefined();
    expect(deliveryOf(w).class).toBe('pull-on-turn');
  });
});
