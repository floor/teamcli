// S3: per-run memoising and no duplicate staging across the send legs.
//
// Each send leg (`socket`, `typed`, `drop`) receives the record `stageOnce` already wrote and
// never stages it a second time, while still writing the same signed record, history entry and
// event log steps (`message.staged`, `leg.tried`). Within one `runSend`, `readAgents`,
// `readTeams`, `readProjects`, `messageKeyState` and `findRoot` (`git rev-parse`) are memoised in
// memory for that run alone and discarded when the run ends.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import * as relay from '../packages/relay/index.js';
import { readEvents, type EventPayload } from '../src/bus/log.ts';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readHistory } from '../src/send/history.ts';
import { readRecord, verifyRecord } from '../src/send/record.ts';
import * as steps from '../src/send/steps.ts';
import type { TypedWakeHost } from '../src/send/typed-wake.ts';
import { messageKeyOf, messageKeyPath } from '../src/store/keys.ts';
import { NOW, dropDir, fake, filed, owner, world, type World } from './send-native-fixtures.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'codex', '0.157.0');
const IDLE = fs.readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = fs.readFileSync(join(FIXTURES, 'working.txt'), 'utf8');

function holding(text: string): string {
  return IDLE.replace('› Ask Codex to do anything', `› ${text}`);
}

function wakeFake(
  screen: (read: number, enters: number, typed: readonly string[]) => string | null,
): { host: TypedWakeHost; typed: string[]; enters: number } {
  const typed: string[] = [];
  const state = { enters: 0, reads: 0 };
  const host: TypedWakeHost = {
    read: () => screen(state.reads++, state.enters, typed),
    type: (_pane: string, text: string) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      state.enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    get enters() {
      return state.enters;
    },
  };
}

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
  fs.mkdirSync(lobby, { recursive: true });
  const text = fs.readFileSync(path, 'utf8').replace(lobbyDir(at.home), lobby);
  fs.writeFileSync(path, `${text}entity: ${entity}\n`);
}

function declareSocket(at: World): void {
  const path = cliHookSettingsPath(at.dir, 'acme', 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  fs.writeFileSync(join(at.sockets, '222.sock'), '');
  const past = Date.now() - 60_000;
  fs.utimesSync(path, new Date(past), new Date(past));
}

function populateRegistries(at: World): void {
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
  // Ensure the checkout message key exists on disk before measuring reads during runSend.
  messageKeyOf(at.home);
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

describe('S3: no duplicate staging on socket, typed and drop legs', () => {
  test('socket leg writes the signed record and events once and never attempts a second stage', async () => {
    made = world(null);
    declareEntity(made);
    declareSocket(made);
    populateRegistries(made);

    const stageSpy = spyOn(relay, 'stage');
    const stepSpy = spyOn(steps, 'stagedStep');
    restores.push(
      () => stageSpy.mockRestore(),
      () => stepSpy.mockRestore(),
    );

    const io = owner(made.root);
    const code = await runSend(['lead', 'hello socket'], io, fake(made));
    expect(code, io.err).toBe(0);

    const id = idOf(io.out);
    expect(stageSpy).toHaveBeenCalledTimes(1);
    expect(stepSpy).toHaveBeenCalledTimes(1);

    const recordPath = join(dropDir(made.dir, 'lead'), id);
    const read = readRecord(recordPath, id);
    expect(read.ok).toBe(true);
    if (!read.ok || read.record === null) throw new Error('expected signed record');
    expect(read.record.payload.body).toBe(filed('hello socket'));
    expect(verifyRecord(read.record, messageKeyOf(made.home))).toBe(true);

    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ id, to: 'lead', outcome: 'delivered', via: 'socket' });
    }

    const evs = stepsOf(made, id);
    expect(evs.map((e) => [e.kind, e.record_id])).toEqual([
      ['message.staged', `${id}:staged`],
      ['leg.tried', `${id}:leg.tried:socket`],
    ]);
  });

  test('typed wake leg writes the signed record and events once and never attempts a second stage', async () => {
    made = world(['typed']);
    declareEntity(made);
    populateRegistries(made);

    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const host = fake(made, {
      agents: () => [{ name: 'native', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });

    const stageSpy = spyOn(relay, 'stage');
    const stepSpy = spyOn(steps, 'stagedStep');
    restores.push(
      () => stageSpy.mockRestore(),
      () => stepSpy.mockRestore(),
    );

    const io = owner(made.root);
    const code = await runSend(['native', 'hello typed'], io, host);
    expect(code, io.err).toBe(0);

    const id = idOf(io.out);
    expect(stageSpy).toHaveBeenCalledTimes(1);
    expect(stepSpy).toHaveBeenCalledTimes(1);

    const recordPath = join(dropDir(made.dir, 'native'), id);
    const read = readRecord(recordPath, id);
    expect(read.ok).toBe(true);
    if (!read.ok || read.record === null) throw new Error('expected signed record');
    expect(read.record.payload.body).toBe(filed('hello typed'));
    expect(verifyRecord(read.record, messageKeyOf(made.home))).toBe(true);

    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ id, to: 'native', outcome: 'delivered (typed wake)', via: 'typed' });
    }

    const evs = stepsOf(made, id);
    expect(evs.map((e) => [e.kind, e.record_id])).toEqual([
      ['message.staged', `${id}:staged`],
      ['leg.tried', `${id}:leg.tried:native`],
      ['leg.tried', `${id}:leg.tried:typed`],
    ]);
  });

  test('drop leg writes the signed record and events once and never attempts a second stage', async () => {
    made = world(['drop']);
    declareEntity(made);
    populateRegistries(made);

    const stageSpy = spyOn(relay, 'stage');
    const stepSpy = spyOn(steps, 'stagedStep');
    restores.push(
      () => stageSpy.mockRestore(),
      () => stepSpy.mockRestore(),
    );

    const io = owner(made.root);
    const code = await runSend(['lead', 'hello drop'], io, fake(made));
    expect(code, io.err).toBe(0);

    const id = idOf(io.out);
    expect(stageSpy).toHaveBeenCalledTimes(1);
    expect(stepSpy).toHaveBeenCalledTimes(1);

    const recordPath = join(dropDir(made.dir, 'lead'), id);
    const read = readRecord(recordPath, id);
    expect(read.ok).toBe(true);
    if (!read.ok || read.record === null) throw new Error('expected signed record');
    expect(read.record.payload.body).toBe(filed('hello drop'));
    expect(verifyRecord(read.record, messageKeyOf(made.home))).toBe(true);

    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ id, to: 'lead', via: 'drop' });
    }

    const evs = stepsOf(made, id);
    expect(evs.map((e) => [e.kind, e.record_id])).toEqual([
      ['message.staged', `${id}:staged`],
      ['leg.tried', `${id}:leg.tried:drop`],
    ]);
  });
});

describe('S3: per-run memoising of readAgents, readTeams, readProjects, messageKeyState and git rev-parse', () => {
  test('a single runSend reads each store and runs git rev-parse at most once', async () => {
    made = world(null);
    declareEntity(made);
    declareSocket(made);
    populateRegistries(made);

    const agentsDir = join(made.home, '.config', 'team', 'agents');
    const teamsFile = join(made.home, '.config', 'team', 'teams.yaml');
    const projectsFile = join(made.home, '.config', 'team', 'projects.yaml');
    const keyFile = messageKeyPath(made.home);

    let agentsDirReads = 0;
    let teamsFileReads = 0;
    let projectsFileReads = 0;
    let keyFileReads = 0;
    let gitRevParseCalls = 0;

    const origReaddirSync = fs.readdirSync;
    const origReadFileSync = fs.readFileSync;
    const origExecFileSync = childProcess.execFileSync;

    const readdirSpy = spyOn(fs, 'readdirSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path) === agentsDir) agentsDirReads += 1;
      return Reflect.apply(origReaddirSync, fs, [path, ...rest]);
    }) as typeof fs.readdirSync);

    const readFileSpy = spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const p = String(path);
      if (p === teamsFile) teamsFileReads += 1;
      else if (p === projectsFile) projectsFileReads += 1;
      else if (p === keyFile) keyFileReads += 1;
      return Reflect.apply(origReadFileSync, fs, [path, ...rest]);
    }) as typeof fs.readFileSync);

    const execSpy = spyOn(childProcess, 'execFileSync').mockImplementation(((file: string, args?: readonly string[], options?: unknown) => {
      if (file === 'git' && Array.isArray(args) && args.includes('rev-parse')) {
        gitRevParseCalls += 1;
      }
      return Reflect.apply(origExecFileSync, childProcess, [file, args, options]);
    }) as typeof childProcess.execFileSync);

    restores.push(
      () => readdirSpy.mockRestore(),
      () => readFileSpy.mockRestore(),
      () => execSpy.mockRestore(),
    );

    const io = owner(made.root);
    const code = await runSend(['lead', 'hello memo'], io, fake(made));
    expect(code, io.err).toBe(0);

    expect(agentsDirReads).toBeLessThanOrEqual(1);
    expect(teamsFileReads).toBeLessThanOrEqual(1);
    expect(projectsFileReads).toBeLessThanOrEqual(1);
    expect(keyFileReads).toBeLessThanOrEqual(1);
    expect(gitRevParseCalls).toBeLessThanOrEqual(1);
  });

  test('memoised state is per-run in memory only and does not leak across separate runSend runs', async () => {
    made = world(null);
    declareEntity(made);
    declareSocket(made);
    populateRegistries(made);

    const io1 = owner(made.root);
    expect(await runSend(['lead', 'first run'], io1, fake(made))).toBe(0);

    // Corrupt message.key on disk after the first run: the second run must read disk fresh
    // rather than reusing the first run's in-memory key state.
    const keyFile = messageKeyPath(made.home);
    let keyFileReadsInRun2 = 0;
    const origReadFileSync = fs.readFileSync;
    const readFileSpy = spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(path) === keyFile) keyFileReadsInRun2 += 1;
      return Reflect.apply(origReadFileSync, fs, [path, ...rest]);
    }) as typeof fs.readFileSync);
    restores.push(() => readFileSpy.mockRestore());

    const io2 = owner(made.root);
    expect(await runSend(['lead', 'second run'], io2, fake(made))).toBe(0);
    expect(keyFileReadsInRun2).toBe(1);
  });
});
