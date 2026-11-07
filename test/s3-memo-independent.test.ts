// Independent coverage for the S3 per-run memo and the single staging pass.
//
// The memo is per `runSend`: two runs in one process read the stores fresh, so a change to the
// agents folder, the teams file or the message key between them is seen by the second run. The
// walk stages the signed record once — the socket, typed and drop legs are handed the staged
// copy — so each send leaves one record file whose bytes are exactly the bytes `relay.stage`
// received, one `message.staged` event and the leg's own `leg.tried` steps.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as relay from '../packages/relay/index.js';
import { readEvents, type EventPayload } from '../src/bus/log.ts';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { registerAgent, updateAgent } from '../src/registry/agents.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readHistory } from '../src/send/history.ts';
import { readRecord, verifyRecord } from '../src/send/record.ts';
import type { TypedWakeHost } from '../src/send/typed-wake.ts';
import { messageKeyOf, messageKeyPath } from '../src/store/keys.ts';
import { dropDir, fake, filed, owner, world, type World } from './send-native-fixtures.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'codex', '0.157.0');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working.txt'), 'utf8');

let made: World | null = null;
const restores: (() => void)[] = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  made?.cleanup();
  made = null;
});

function declareEntity(at: World, entity = 'floor'): void {
  const path = join(at.dir, 'team.yaml');
  const lobby = resolveLobby(at.home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(at.home), lobby);
  writeText(path, `${text}entity: ${entity}\n`);
}

function writeText(path: string, text: string): void {
  writeFileSync(path, text);
}

function declareSocket(at: World): void {
  const path = cliHookSettingsPath(at.dir, 'acme', 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(path), { recursive: true });
  writeText(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeText(join(at.sockets, '222.sock'), '');
  const past = Date.now() - 60_000;
  // The socket's mtime is what the live-socket probe judges; the fixture file must look old.
  utimesSync(path, new Date(past), new Date(past));
}

function populateRegistries(at: World): { teamId: string } {
  const teamId = teamIdOf(at.root);
  const leadAgent = registerAgent(at.home, {
    name: 'lead',
    signing: { model: 'Test', version: '1', role: 'coordinator' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: {
      team: teamId,
      seat: 'lead',
      session: 'acme',
      pane: 'pane-lead',
      address: null,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  upsertTeam(at.home, teamId, {
    project: 'acme',
    root: at.root,
    session: 'acme',
    entity: 'floor',
    roster: [{ agent: leadAgent.id, seat: 'lead', role: 'coordinator', leads: true }],
  });
  upsertProject(at.home, 'acme', {
    name: 'acme',
    entity: 'floor',
    teams: [teamId],
    lead: teamId,
  });
  // The first signing needs a key on disk; create it outside the runs so the key scene can
  // delete it and prove run 2 mints its own.
  messageKeyOf(at.home);
  return { teamId };
}

/** A second team on the same machine: its root exists so `teamIdOf` reads a real path. */
function secondTeam(at: World, project: string): string {
  const root = join(dirname(at.root), project);
  mkdirSync(root, { recursive: true });
  return teamIdOf(root);
}

function mate(at: World, teamId: string, project: string, lifecycle: 'retired' | 'running'): string {
  const agent = registerAgent(at.home, {
    name: 'mate',
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: {
      team: teamId,
      seat: 'mate',
      session: project,
      pane: 'pane-mate',
      address: null,
    },
    mcp: [],
    skills: [],
    lifecycle,
    by: 'owner',
  });
  return agent.id;
}

function betaRecord(at: World, teamId: string, project: string, agentId: string): void {
  upsertTeam(at.home, teamId, {
    project,
    root: join(dirname(at.root), project),
    session: project,
    entity: 'floor',
    roster: [{ agent: agentId, seat: 'mate', role: 'implementer' }],
  });
}

type ListRow = {
  name: string;
  nickname: string | null;
  cli: string;
  role: string;
  project: string;
  stopped: boolean;
  reach: string;
};
type ListDoc = { project: string; session: string; summary: string; seats: ListRow[] };

async function listOnce(at: World): Promise<ListDoc> {
  const io = owner(at.root);
  const code = await runSend(['--list', '--json'], io, fake(at));
  expect(code, io.err).toBe(0);
  return JSON.parse(io.out) as ListDoc;
}

function idOf(text: string): string {
  const last = text.trimEnd().split('\n').at(-1) ?? '';
  const match = / \(id ([0-9a-f-]{36})\)$/.exec(last);
  if (match === null) throw new Error(`the closing line names no id: ${last}`);
  return match[1]!;
}

function stepsOf(at: World, id: string): EventPayload[] {
  const read = readEvents('acme', at.root, at.home);
  if (!read.ok) throw new Error(read.reason);
  return read.events
    .map((one) => one.payload)
    .filter((payload) => payload.record_id === id || payload.record_id.startsWith(`${id}:`));
}

function holding(text: string): string {
  return IDLE.replace('› Ask Codex to do anything', `› ${text}`);
}

/** A Codex pane that is idle, takes the typed line into its composer, and reports working after
 *  the enter — the order the typed wake polls. */
function typedPane(): { host: TypedWakeHost; typed: string[] } {
  const typed: string[] = [];
  let reads = 0;
  let enters = 0;
  const host: TypedWakeHost = {
    read: () => (enters > 0 ? WORKING : reads++ < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')),
    type: (_pane: string, text: string) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return { host, typed };
}

type StagedCall = { id?: string; record: string };

describe('S3: the memo never leaks across two runSend runs in one process', () => {
  test('an agent changed in the agents folder between runs is seen by the second run', async () => {
    made = world(null);
    declareEntity(made);
    populateRegistries(made);
    const betaId = secondTeam(made, 'beta');
    // The beta team and its roster line stand from the first run; only the agent's lifecycle
    // changes between the runs, so a stale read of the agents folder is the only way to miss it.
    const mateId = mate(made, betaId, 'beta', 'retired');
    betaRecord(made, betaId, 'beta', mateId);

    const first = await listOnce(made);
    expect(first.seats.some((row) => row.name === 'mate@beta')).toBe(false);

    updateAgent(made.home, mateId, { lifecycle: 'running' });

    const second = await listOnce(made);
    const row = second.seats.find((one) => one.name === 'mate@beta');
    expect(row).toMatchObject({
      cli: 'claude-code',
      role: 'implementer',
      project: 'beta',
      stopped: false,
      reach: 'socket',
    });
  });

  test('a team added to the teams file between runs is seen by the second run', async () => {
    made = world(null);
    declareEntity(made);
    populateRegistries(made);
    const betaId = secondTeam(made, 'beta');
    // The agent stands from the first run; the team record that carries its roster line arrives
    // only between the runs, so a stale read of the teams file is the only way to miss it.
    const mateId = mate(made, betaId, 'beta', 'running');

    const first = await listOnce(made);
    expect(first.seats.some((row) => row.name === 'mate@beta')).toBe(false);

    betaRecord(made, betaId, 'beta', mateId);

    const second = await listOnce(made);
    const row = second.seats.find((one) => one.name === 'mate@beta');
    expect(row).toMatchObject({ role: 'implementer', project: 'beta', stopped: false });
  });

  test('a message key replaced between runs is seen by the second run', async () => {
    made = world(null);
    declareEntity(made);
    declareSocket(made);
    populateRegistries(made);

    const ioOne = owner(made.root);
    expect(await runSend(['lead', 'before the key change'], ioOne, fake(made))).toBe(0);
    const idOne = idOf(ioOne.out);
    const keyBefore = messageKeyOf(made.home);
    const readOne = readRecord(join(dropDir(made.dir, 'lead'), idOne), idOne);
    expect(readOne.ok).toBe(true);
    if (!readOne.ok || readOne.record === null) throw new Error('expected the first signed record');
    expect(verifyRecord(readOne.record, keyBefore)).toBe(true);

    // The key file goes away between the runs: the second run must mint and use its own key.
    unlinkSync(messageKeyPath(made.home));

    const ioTwo = owner(made.root);
    expect(await runSend(['lead', 'after the key change'], ioTwo, fake(made))).toBe(0);
    expect(existsSync(messageKeyPath(made.home))).toBe(true);
    const keyAfter = messageKeyOf(made.home);
    const idTwo = idOf(ioTwo.out);
    const readTwo = readRecord(join(dropDir(made.dir, 'lead'), idTwo), idTwo);
    expect(readTwo.ok).toBe(true);
    if (!readTwo.ok || readTwo.record === null) throw new Error('expected the second signed record');
    expect(verifyRecord(readTwo.record, keyAfter)).toBe(true);
    expect(verifyRecord(readTwo.record, keyBefore)).toBe(false);
    expect(readTwo.record.payload.body).toBe(filed('after the key change'));
  });
});

describe('S3: the legs stage the signed record once, with the same bytes and event steps', () => {
  test('the socket leg is handed the staged copy, and the bytes on disk are the bytes it received', async () => {
    made = world(null);
    declareEntity(made);
    declareSocket(made);
    populateRegistries(made);
    const stageSpy = spyOn(relay, 'stage');
    restores.push(() => stageSpy.mockRestore());

    const io = owner(made.root);
    const code = await runSend(['lead', 'hello socket'], io, fake(made));
    expect(code, io.err).toBe(0);
    const id = idOf(io.out);

    expect(stageSpy).toHaveBeenCalledTimes(1);
    const staged = stageSpy.mock.calls[0]?.[1] as StagedCall;
    expect(staged.id).toBe(id);

    // The record is the only file at the seat that is not this send's own sidecar (the fallback
    // walk's markers are named `<id>.<kind>`): one record file, never a second staged copy.
    const seatDir = dropDir(made.dir, 'lead');
    const entries = readdirSync(seatDir).sort();
    expect(entries.filter((name) => name !== '.unread.json' && !name.startsWith(`${id}.`))).toEqual([id]);
    const path = join(seatDir, id);
    expect(readFileSync(path, 'utf8')).toBe(staged.record);

    const read = readRecord(path, id);
    expect(read.ok).toBe(true);
    if (!read.ok || read.record === null) throw new Error('expected the signed record');
    expect(read.record.payload.body).toBe(filed('hello socket'));
    expect(verifyRecord(read.record, messageKeyOf(made.home))).toBe(true);

    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.entries[0]).toMatchObject({ id, to: 'lead', via: 'socket' });

    expect(stepsOf(made, id).map((step) => [step.kind, step.record_id])).toEqual([
      ['message.staged', `${id}:staged`],
      ['leg.tried', `${id}:leg.tried:socket`],
    ]);
  });

  test('the typed wake leg is handed the staged copy, and the bytes on disk are the bytes it received', async () => {
    made = world(['typed']);
    declareEntity(made);
    populateRegistries(made);
    const pane = typedPane();
    const host = fake(made, {
      agents: () => [{ name: 'native', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const stageSpy = spyOn(relay, 'stage');
    restores.push(() => stageSpy.mockRestore());

    const io = owner(made.root);
    const code = await runSend(['native', 'hello typed'], io, host);
    expect(code, io.err).toBe(0);
    const id = idOf(io.out);

    expect(stageSpy).toHaveBeenCalledTimes(1);
    const staged = stageSpy.mock.calls[0]?.[1] as StagedCall;
    expect(staged.id).toBe(id);

    // One record file, never a second staged copy; the fallback walk's markers sit beside it
    // under `<id>.<kind>`.
    const seatDir = dropDir(made.dir, 'native');
    const entries = readdirSync(seatDir).sort();
    expect(entries.filter((name) => name !== '.unread.json' && !name.startsWith(`${id}.`))).toEqual([id]);
    const path = join(seatDir, id);
    expect(readFileSync(path, 'utf8')).toBe(staged.record);

    const read = readRecord(path, id);
    expect(read.ok).toBe(true);
    if (!read.ok || read.record === null) throw new Error('expected the signed record');
    expect(read.record.payload.body).toBe(filed('hello typed'));
    expect(verifyRecord(read.record, messageKeyOf(made.home))).toBe(true);

    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.entries[0]).toMatchObject({ id, to: 'native', via: 'typed' });

    expect(stepsOf(made, id).map((step) => [step.kind, step.record_id])).toEqual([
      ['message.staged', `${id}:staged`],
      ['leg.tried', `${id}:leg.tried:native`],
      ['leg.tried', `${id}:leg.tried:typed`],
    ]);
  });

  test('the drop leg is handed the staged copy, and the bytes on disk are the bytes it received', async () => {
    made = world(['drop']);
    declareEntity(made);
    populateRegistries(made);
    const stageSpy = spyOn(relay, 'stage');
    restores.push(() => stageSpy.mockRestore());

    const io = owner(made.root);
    const code = await runSend(['lead', 'hello drop'], io, fake(made));
    expect(code, io.err).toBe(0);
    const id = idOf(io.out);

    expect(stageSpy).toHaveBeenCalledTimes(1);
    const staged = stageSpy.mock.calls[0]?.[1] as StagedCall;
    expect(staged.id).toBe(id);

    // The record is the only file at the seat that is not this send's own sidecar (the fallback
    // walk's markers are named `<id>.<kind>`): one record file, never a second staged copy.
    const seatDir = dropDir(made.dir, 'lead');
    const entries = readdirSync(seatDir).sort();
    expect(entries.filter((name) => name !== '.unread.json' && !name.startsWith(`${id}.`))).toEqual([id]);
    const path = join(seatDir, id);
    expect(readFileSync(path, 'utf8')).toBe(staged.record);

    const read = readRecord(path, id);
    expect(read.ok).toBe(true);
    if (!read.ok || read.record === null) throw new Error('expected the signed record');
    expect(read.record.payload.body).toBe(filed('hello drop'));
    expect(verifyRecord(read.record, messageKeyOf(made.home))).toBe(true);

    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.entries[0]).toMatchObject({ id, to: 'lead', via: 'drop' });

    expect(stepsOf(made, id).map((step) => [step.kind, step.record_id])).toEqual([
      ['message.staged', `${id}:staged`],
      ['leg.tried', `${id}:leg.tried:drop`],
    ]);
  });
});
