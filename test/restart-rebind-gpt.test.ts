// Independent binding scenes: the endpoint read is injected and explicitly suspended while a
// second writer changes the records. All folders and records are synthetic; no runtime or pane
// is opened. Refusal preserves the second writer's complete bytes, including provenance.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindCodexSeatThread } from '../src/launch/codex-thread-binding.ts';
import { codexEndpointSocket } from '../src/launch/codex-endpoint.ts';
import { getAgent, recordAgentSession, registerAgent, updateAgent } from '../src/registry/agents.ts';
import { recordedSeatSession } from '../src/registry/resume.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, STATE_FILE, updateState, type SeatState } from '../src/state.ts';
import type { CodexLoadedThreadsRead } from '../src/daemon/presence/codex-source.ts';

const SESSION = 'fixture';
const SEAT = { name: 'worker', cli: 'codex' };
const HANDLE = 'seat_0123456789ab';
const BINDING = 'prs_0123456789ab';
const OLD = 'conversation-old';
const LOADED = 'conversation-loaded';
const NEXT = 'conversation-next';
const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });

function world(named?: string, recorded: string | null = OLD) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rb-')));
  made.push(base);
  const root = join(base, 'r');
  const dir = join(root, '.agents');
  const home = join(base, 'h');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  const endpoint = codexEndpointSocket(dir, SESSION, SEAT.name, BINDING);
  if (endpoint === null) throw new Error('the fixture folder cannot name a managed endpoint');
  const state: SeatState = {
    id: HANDLE, stage: 'ready', pane: 'fixture-pane', workspace: 'fixture-workspace',
    presence_binding: BINDING,
    codex_endpoint: { url: endpoint.url, binding: BINDING, pid: 987654321, started_at: '2026-11-01T09:00:00.000Z' },
    ...(named === undefined ? {} : { agent_session: named }),
  };
  updateState(dir, file => { file.sessions[SESSION] = { ...emptySession(), seats: { [SEAT.name]: state } }; });
  const agent = registerAgent(home, {
    name: 'fixture worker', cli: SEAT.cli, lab: 'Example',
    signing: { model: 'Example', version: '1', role: 'implementer' },
    launch: 'codex', launcher: null, mcp: [], skills: [], lifecycle: 'running',
    seat_handle: HANDLE, by: 'synthetic fixture',
    reach: { team: teamIdOf(root), seat: SEAT.name, session: SESSION, pane: 'fixture-pane', address: null, agent_session: recorded },
  });
  const input = { home, root, dir, session: SESSION, seat: SEAT, state };
  const files = () => ({
    state: readFileSync(join(dir, STATE_FILE), 'utf8'),
    registry: readFileSync(join(home, '.config', 'team', 'agents', agent.id + '.yaml'), 'utf8'),
  });
  const current = () => readState(dir).sessions[SESSION]!.seats[SEAT.name]!;
  const consumer = () => recordedSeatSession({ home, root, herdrSession: SESSION, seat: SEAT, state: current() });
  return { ...input, input, agent, files, current, consumer, endpoint };
}
type World = ReturnType<typeof world>;

async function race(w: World, ids: string[], change: () => void) {
  let reached!: () => void;
  let release!: (value: CodexLoadedThreadsRead) => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const suspended = new Promise<CodexLoadedThreadsRead>(resolve => { release = resolve; });
  let reads = 0;
  const running = bindCodexSeatThread({ ...w.input, read: async url => {
    reads += 1;
    expect(url).toBe(w.endpoint.url);
    reached();
    return suspended;
  } });
  await started;
  try {
    change();
    const afterWriter = w.files();
    release({ kind: 'read', ids });
    return { result: await running, afterWriter, reads };
  } finally { release({ kind: 'unavailable', why: 'fixture cleanup' }); }
}

for (const named of [false, true]) {
  for (const later of [null, NEXT]) {
    test('a later registry conversation is preserved: named=' + named + ', clear=' + (later === null), async () => {
      const w = world(named ? OLD : undefined);
      const got = await race(w, [named ? OLD : LOADED], () => { recordAgentSession(w.home, w.agent.id, later); });
      expect(got.reads).toBe(1);
      expect(got.result.kind).toBe('unbound');
      expect(w.files()).toEqual(got.afterWriter);
      expect(getAgent(w.home, w.agent.id)?.reach.agent_session ?? null).toBe(later);
      expect(w.current().agent_session).toBe(named ? OLD : undefined);
      expect(w.consumer().kind).not.toBe('bound');
    });
  }

  test('a concurrent writer agreeing with the selected thread remains compatible: named=' + named, async () => {
    const chosen = named ? OLD : LOADED;
    const w = world(named ? OLD : undefined);
    const got = await race(w, [chosen], () => { recordAgentSession(w.home, w.agent.id, chosen); });
    expect(got.result).toEqual({ kind: 'bound', id: chosen });
    expect(w.current().agent_session).toBe(chosen);
    expect(getAgent(w.home, w.agent.id)?.reach.agent_session).toBe(chosen);
    const read = w.consumer();
    expect(read.kind).toBe('bound');
    if (read.kind === 'bound') expect(read.recorded.sessionId).toBe(chosen);
  });

  test('an initially empty registry conversation can still be repaired: named=' + named, async () => {
    const w = world(named ? LOADED : undefined, null);
    const result = await bindCodexSeatThread({ ...w.input, read: async () => ({ kind: 'read', ids: [LOADED, LOADED] }) });
    expect(result).toEqual({ kind: 'bound', id: LOADED });
    expect(w.current().agent_session).toBe(LOADED);
    expect(getAgent(w.home, w.agent.id)?.reach.agent_session).toBe(LOADED);
    expect(w.consumer().kind).toBe('bound');
  });
}

for (const change of ['handle', 'incarnation', 'endpoint', 'conversation'] as const) {
  test('a later seat-state ' + change + ' is preserved whole', async () => {
    const w = world();
    const got = await race(w, [LOADED], () => {
      updateState(w.dir, file => {
        const seat = file.sessions[SESSION]!.seats[SEAT.name]!;
        if (change === 'handle') seat.id = 'seat_fedcba987654';
        if (change === 'incarnation') seat.presence_binding = 'prs_fedcba987654';
        if (change === 'endpoint') seat.codex_endpoint = { ...seat.codex_endpoint!, url: 'unix:///fixture/changed.sock' };
        if (change === 'conversation') seat.agent_session = NEXT;
      });
    });
    expect(got.result.kind).toBe('unbound');
    expect(w.files()).toEqual(got.afterWriter);
  });
}

for (const fault of ['foreign endpoint', 'shared endpoint', 'wrong session', 'wrong cli', 'wrong handle', 'orphan'] as const) {
  test('binding refuses before endpoint access: ' + fault, async () => {
    const w = world();
    if (fault === 'foreign endpoint') w.state.codex_endpoint = { ...w.state.codex_endpoint!, url: 'unix:///fixture/foreign.sock' };
    if (fault === 'shared endpoint') updateState(w.dir, file => {
      file.sessions.other = { ...emptySession(), seats: { sibling: { ...w.state, id: 'seat_fedcba987654' } } };
    });
    if (fault === 'wrong session') updateAgent(w.home, w.agent.id, { reach: { session: 'other' } });
    if (fault === 'wrong cli') updateAgent(w.home, w.agent.id, { cli: 'claude-code' });
    if (fault === 'wrong handle') updateAgent(w.home, w.agent.id, { seat_handle: 'seat_fedcba987654' });
    if (fault === 'orphan') updateAgent(w.home, w.agent.id, { orphaned_at: '2026-11-01T09:00:00.000Z' });
    const before = w.files();
    let reads = 0;
    const result = await bindCodexSeatThread({ ...w.input, read: async () => { reads += 1; return { kind: 'read', ids: [LOADED] }; } });
    expect(result.kind).toBe('unbound');
    expect(reads).toBe(0);
    expect(w.files()).toEqual(before);
  });
}

for (const ids of [[], [LOADED, NEXT]]) {
  test('an unnamed endpoint with ' + ids.length + ' distinct threads proves no binding', async () => {
    const w = world();
    const before = w.files();
    const result = await bindCodexSeatThread({ ...w.input, read: async () => ({ kind: 'read', ids }) });
    expect(result.kind).toBe('unbound');
    expect(w.files()).toEqual(before);
  });
}

test('a named state keeps its own thread among multiple loaded threads', async () => {
  const w = world(OLD, null);
  expect(await bindCodexSeatThread({ ...w.input, read: async () => ({ kind: 'read', ids: [NEXT, OLD] }) }))
    .toEqual({ kind: 'bound', id: OLD });
  expect(w.current().agent_session).toBe(OLD);
  expect(getAgent(w.home, w.agent.id)?.reach.agent_session).toBe(OLD);
  expect(w.consumer().kind).toBe('bound');
});

test('an endpoint that does not hold the named thread leaves both records intact', async () => {
  const w = world(OLD);
  const before = w.files();
  expect((await bindCodexSeatThread({ ...w.input, read: async () => ({ kind: 'read', ids: [LOADED] }) })).kind).toBe('unbound');
  expect(w.files()).toEqual(before);
});
