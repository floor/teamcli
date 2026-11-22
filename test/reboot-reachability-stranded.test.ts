// Reboot reachability, the net under the restart rebind: on an active root a Claude seat whose
// typed pointer the pane ownership proof keeps refusing (a restart left its records behind: a new
// shell and CLI) is reached by nothing, so the hosted watch rolls the root back to dark, says so,
// and types nothing. Synthetic readings only: the seat's restored pane is shell 900 and CLI 901,
// born after the recorded launch (shell 500, CLI 501).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as send from '../src/commands/send.ts';
import type { SendHost } from '../src/commands/send.ts';
import { runQueues } from '../src/commands/queues.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { typedPaneProof, type TypedPaneRecord, type TypedPaneSources } from '../src/launch/identity.ts';
import { writeListener, type InboxListener } from '../src/mcp/inbox.ts';
import type { ProcessParent } from '../src/process-parent-adapter.ts';
import { activate, deactivate, type FloorActor } from '../src/queue/floor.ts';
import { attemptLedger } from '../src/queue/handover.ts';
import { seatMailDirIn } from '../src/queue/mail-tree.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord, stampedPayload, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { deliverTypedWake, type TypedWakeResult } from '../src/send/typed-wake.ts';
import type { Live } from '../src/status/compare.ts';
import type { RetryScene, RetrySources } from '../src/watch/retry.ts';
import { wakeUnreadDrops } from '../src/watch/unread.ts';
import { clearStranded, noteReachedPointer, noteStrandedPointer, STRANDED_FRESH_MS, STRANDED_ROLLBACK_MS, strandedSeats } from '../src/queue/stranded.ts';
import { floorPass, floorState, resumeRollback, rollbackBegun } from '../src/queue/floor.ts';
import { testIo } from './helpers.ts';
import { fake, world, type World } from './send-native-fixtures.ts';

const SESSION = 'acme';
const SEAT = 'helper';
const DAEMON: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const MSG_ID = '8b110000-0000-4000-8000-0000000071b0';
const CLAUDE_IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'claude-code', '2.1.326', 'idle.txt'), 'utf8');

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

type Fixture = World & { leadId: string; listener: InboxListener };

const RECORDED_RECORD: TypedPaneRecord = {
  pane: `pane-${SEAT}`,
  pane_shell: 500,
  pane_shell_start: 1_700_000_000_000,
  agent_session: `conv-${SEAT}`,
  launched: {
    shell: 500,
    cli: [501],
    cli_start: [1_700_000_000_500],
  },
};

function realisticClaudeNodes(): Map<number, ProcessParent> {
  return new Map<number, ProcessParent>([
    [501, { pid: 501, ppid: 500, birth: 1_700_000_000_500_000 }], // recorded Claude CLI
    [502, { pid: 502, ppid: 501, birth: 1_700_000_000_510_000 }], // MCP server child
    [503, { pid: 503, ppid: 501, birth: 1_700_000_000_520_000 }], // tool shell child
    [504, { pid: 504, ppid: 503, birth: 1_700_000_000_530_000 }], // tool grandchild
  ]);
}

function ownerFromNodes(
  nodes: Map<number, ProcessParent>,
  foreground: number[] = [501, 502, 503, 504],
): TypedPaneSources {
  return {
    agents: () => [{ name: SEAT, pane: `pane-${SEAT}`, session: `conv-${SEAT}` }],
    processes: () => ({ shell: 500, foreground }),
    processStart: (pid) => (pid === 500 ? 1_700_000_000_000 : 1_700_000_000_500),
    processParent: (pid) => nodes.get(pid) ?? null,
  };
}

function setupRoot(): Fixture {
  const at = world(null);
  cleanups.push(at.cleanup);
  expect(activate(at.root, { home: at.home, build: 'b', actors: () => [DAEMON] }).kind).toBe('activated');
  const root = realpathSync(at.root);
  const teamId = teamIdOf(root);
  const leadId = registerAgent(at.home, {
    name: 'lead',
    signing: { model: 'Model', version: 'S 6.2', role: 'coordinator' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamId, seat: 'lead', session: SESSION, pane: 'pane-lead', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  }).id;
  upsertTeam(at.home, teamId, {
    project: 'acme',
    session: SESSION,
    root,
    roster: [{ agent: leadId, seat: 'lead', role: 'coordinator', nickname: 'Wren' }],
  });
  writeFileSync(
    join(at.dir, 'team.state.json'),
    `${JSON.stringify({
      format: 1,
      sessions: {
        [SESSION]: {
          seats: {
            lead: {
              stage: 'ready',
              pane: 'pane-lead',
              agent_session: 'conv-lead',
              pane_shell: 300,
              pane_shell_start: 1_700_000_000_000,
              launched: { shell: 300, cli: [301], cli_start: [1_700_000_000_500] },
            },
            [SEAT]: {
              stage: 'ready',
              ...RECORDED_RECORD,
            },
          },
          worktrees: {},
        },
      },
    })}\n`,
  );
  const dropDir = seatMailDirIn(at.dir, SESSION, SEAT);
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  const listener: InboxListener = {
    v: 1,
    seat: SEAT,
    session: SESSION,
    root,
    cli: 'claude-code',
    pid: process.pid,
    ts: new Date().toISOString(),
    channel: true,
    level: 3,
  };
  expect(writeListener(dropDir, listener)).toBe(true);
  return { ...at, root, leadId, listener };
}

function writeStamped(at: Fixture, id: string): void {
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: SEAT,
    to_id: null,
    root: at.root,
    session: SESSION,
    at: new Date().toISOString(),
    body: `payload for ${id}`,
    from: 'lead',
    from_id: at.leadId,
    rule: 'the owner',
    thread: id,
  };
  const signed = signRecord(stampedPayload(payload, at.home), at.home);
  expect(writeRecord(seatMailDirIn(at.dir, SESSION, SEAT), signed).ok).toBe(true);
}

function writeDaemon(home: string): void {
  const now = new Date().toISOString();
  writeDaemonState(home, {
    format: 1,
    pid: process.pid,
    uid: process.getuid!(),
    since: now,
    heartbeatAt: now,
    startedBy: 'manual',
    version: 'b',
    socket: join(home, 'daemon.sock'),
    features: { broker: 'off' },
    stuck: [],
    roots: [],
    floorLevel: 3,
  });
}

function treeSnapshot(folder: string): string {
  return JSON.stringify(
    readdirSync(folder, { recursive: true })
      .map(String)
      .sort()
      .map((name) => {
        try {
          return [name, readFileSync(join(folder, name), 'base64')];
        } catch {
          return [name, 'dir'];
        }
      }),
  );
}

function buildScene(at: Fixture, now: Date, lines: string[]): RetryScene {
  const loaded = loadTeamFile(at.root, { home: at.home });
  if (!loaded.ok) throw new Error('failed to load team file');
  const team = loaded.team;
  const live: Live = {
    running: true,
    agents: [{ name: SEAT, agent: 'claude', pane: `pane-${SEAT}`, workspace: 'w', status: 'idle', cwd: null }],
    workspaces: [],
    screens: { [`pane-${SEAT}`]: CLAUDE_IDLE },
  };
  const host: SendHost = fake(at, { agents: () => [{ name: SEAT, pane: `pane-${SEAT}`, cli: 'claude-code' }] });
  const { typedWake: _ignored, ...rest } = host;
  const seam: NonNullable<RetrySources['typedWake']> = async (_pane, line, _cli, _session, wakeOpts) => {
    if (
      (wakeOpts?.beforeEachKey !== undefined && !wakeOpts.beforeEachKey()) ||
      (wakeOpts?.beforeFirstKey !== undefined && !wakeOpts.beforeFirstKey())
    ) {
      return { delivered: false, typed: false, tries: 0, reason: 'refused before the first key' } as TypedWakeResult;
    }
    lines.push(line);
    return { delivered: true, typed: true, tries: 1, reason: 'the working screen showed', lineWritten: true } as TypedWakeResult;
  };
  return {
    dir: at.dir,
    session: SESSION,
    root: at.root,
    home: at.home,
    team,
    live,
    ownPane: null,
    now,
    say: () => {},
    sources: {
      screen: () => CLAUDE_IDLE,
      status: () => 'idle',
      typeText: () => {
        throw new Error('unexpected raw typeText');
      },
      pressEnter: () => {
        throw new Error('unexpected raw pressEnter');
      },
      sleep: async () => {},
      typedWake: seam,
    },
    eventLegs: (one: string) =>
      send.permittedEventLegs({ dir: at.dir, root: at.root, home: at.home, session: SESSION, seat: one, team, now: () => now }),
    resendStamped: (one, dropDir, id, typedRequest, startAfter) =>
      send.resendStampedRecord({
        host: { ...rest, now: () => now },
        dir: at.dir,
        root: at.root,
        project: team.project,
        session: SESSION,
        seat: one.name,
        cli: one.cli,
        dropDir,
        id,
        team,
        typedRequest,
        ...(startAfter === undefined ? {} : { startAfter }),
      }),
  };
}


/** The restored pane: a new shell and CLI the record does not name. */
function restartedOwner(): TypedPaneSources {
  return {
    agents: () => [{ name: SEAT, pane: `pane-${SEAT}`, session: `conv-${SEAT}` }],
    processes: () => ({ shell: 900, foreground: [901] }),
    processStart: (pid) => (pid === 900 ? 1_700_000_900_000 : 1_700_000_900_500),
    processParent: (pid) => (pid === 901 ? { pid: 901, ppid: 900, birth: 1_700_000_900_500_000 } : null),
  };
}

async function pass(at: Fixture, nowMs: number, owner: TypedPaneSources, lines: string[], said: string[]): Promise<void> {
  const scene = buildScene(at, new Date(nowMs), lines);
  scene.sources.keyOwner = owner;
  scene.say = (text) => { said.push(text); };
  await wakeUnreadDrops(scene, { unreadAfter: 600 });
}

describe('a stranded Claude seat rolls its active root back to dark', () => {
  test('the notes: one unbroken streak on one activation, past the window, while refusals are fresh; a passing pointer clears it', () => {
    const root = '/synthetic/root';
    const A = '2026-11-20T06:00:00.000Z';
    clearStranded(root);
    for (let t = 0; t <= STRANDED_ROLLBACK_MS - 60_000; t += 60_000) noteStrandedPointer(root, SEAT, t, 'the shell is not the recorded shell', A);
    expect(strandedSeats(root, STRANDED_ROLLBACK_MS - 1, A)).toEqual([]);
    expect(strandedSeats(root, STRANDED_ROLLBACK_MS, A).map(one => one.seat)).toEqual([SEAT]);
    // Another activation's notes never count for this one.
    expect(strandedSeats(root, STRANDED_ROLLBACK_MS, '2026-11-20T07:00:00.000Z')).toEqual([]);
    // No refusal for longer than the freshness bound: the seat is no longer being asked for.
    expect(strandedSeats(root, STRANDED_ROLLBACK_MS - 60_000 + STRANDED_FRESH_MS + 1, A)).toEqual([]);
    noteReachedPointer(root, SEAT);
    expect(strandedSeats(root, STRANDED_ROLLBACK_MS, A)).toEqual([]);
    clearStranded(root);
  });

  test('two failures with a gap longer than the freshness bound never add up to a stranded seat', () => {
    const root = '/synthetic/gap';
    const A = '2026-11-20T06:00:00.000Z';
    clearStranded(root);
    noteStrandedPointer(root, SEAT, 0, 'the shell is not the recorded shell', A);
    noteStrandedPointer(root, SEAT, STRANDED_FRESH_MS + 60_000, 'the shell is not the recorded shell', A);
    expect(strandedSeats(root, STRANDED_FRESH_MS + 120_000, A)).toEqual([]);
    expect(strandedSeats(root, STRANDED_ROLLBACK_MS + 1, A)).toEqual([]);
    clearStranded(root);
  });

  test('a deactivate and reactivate between refusals starts a new streak', () => {
    const root = '/synthetic/cycle';
    clearStranded(root);
    noteStrandedPointer(root, SEAT, 0, 'the shell is not the recorded shell', 'first activation');
    noteStrandedPointer(root, SEAT, 60_000, 'the shell is not the recorded shell', 'second activation');
    for (let t = 120_000; t <= STRANDED_ROLLBACK_MS; t += 60_000) noteStrandedPointer(root, SEAT, t, 'the shell is not the recorded shell', 'second activation');
    expect(strandedSeats(root, STRANDED_ROLLBACK_MS, 'second activation')).toEqual([]);
    expect(strandedSeats(root, STRANDED_ROLLBACK_MS + 60_000, 'second activation').map(one => one.seat)).toEqual([SEAT]);
    clearStranded(root);
  });

  test('a rollback cut off after its marker is finished by a later floor pass, without any stranded note', () => {
    const at = setupRoot();
    clearStranded(at.root);
    const failed = deactivate(at.root, at.home, { removeFaults: { before: (_step, path) => { if (path.endsWith('PUBLISHED')) throw new Error('injected'); } } });
    expect(failed.kind).toBe('failed');
    expect(rollbackBegun(at.root)).toBe(true);
    expect(floorState(at.root, at.home).kind).toBe('unknown');
    const later = Date.now() + 10 * 60_000;
    expect(floorPass(at.root, at.home, later, () => [DAEMON], null).kind).toBe('dark');
    expect(rollbackBegun(at.root)).toBe(false);
  });

  test('a rollback another process finished, followed by a new activation, is never undone by a resume', () => {
    const at = setupRoot();
    const failed = deactivate(at.root, at.home, { removeFaults: { before: (_step, path) => { if (path.endsWith('PUBLISHED')) throw new Error('injected'); } } });
    expect(failed.kind).toBe('failed');
    // The watch reads the marker, then loses the race: another process finishes the rollback and
    // the operator activates again before the watch takes the lock.
    const seen = readFileSync(join(at.root, '.agents', 'queues', 'DEACTIVATING'), 'utf8');
    expect(deactivate(at.root, at.home).kind).toBe('dark');
    expect(activate(at.root, { home: at.home, build: 'b', actors: () => [DAEMON] }).kind).toBe('activated');
    expect(resumeRollback(at.root, seen).kind).toBe('superseded');
    expect(floorState(at.root, at.home).kind).toBe('active');
    // A malformed marker is no rollback to resume either.
    writeFileSync(join(at.root, '.agents', 'queues', 'DEACTIVATING'), '{"v":2}\n');
    expect(rollbackBegun(at.root)).toBe(false);
  });

  test('a marker linked but not synced is synced before any removal; a failed sync removes nothing, and the resume finishes once it clears', () => {
    const at = setupRoot();
    // The rollback is cut off after the marker's link, before its folder fsync.
    const cut = deactivate(at.root, at.home, { faults: { before: (step, path) => { if (step === 'folder-fsync' && path.endsWith('DEACTIVATING')) throw new Error('injected'); } } });
    expect(cut.kind).toBe('failed');
    expect(rollbackBegun(at.root)).toBe(true);
    const seen = readFileSync(join(at.root, '.agents', 'queues', 'DEACTIVATING'), 'utf8');
    const queues = join(at.root, '.agents', 'queues');
    const before = readdirSync(queues).sort();
    expect(resumeRollback(at.root, seen, { syncFault: () => { throw new Error('injected'); } }).kind).toBe('failed');
    expect(readdirSync(queues).sort()).toEqual(before);
    expect(resumeRollback(at.root, seen).kind).toBe('dark');
    expect(floorState(at.root, at.home).kind).toBe('dark');
  });

  test('a rollback decided on one activation leaves a root reactivated since as it is', () => {
    const at = setupRoot();
    const first = floorState(at.root, at.home);
    if (first.kind !== 'active') throw new Error('not active');
    expect(deactivate(at.root, at.home).kind).toBe('dark');
    expect(activate(at.root, { home: at.home, build: 'b', actors: () => [DAEMON], now: () => new Date(Date.parse(first.at) + 60_000) }).kind).toBe('activated');
    expect(deactivate(at.root, at.home, { expectAt: first.at }).kind).toBe('superseded');
    expect(floorState(at.root, at.home).kind).toBe('active');
  });

  test('refused past the window: the root goes dark, the rollback is said, and no key reached the pane', async () => {
    const at = setupRoot();
    clearStranded(at.root);
    writeStamped(at, MSG_ID);
    const lines: string[] = [];
    const said: string[] = [];
    const t0 = Date.now() + 1_000;
    const owner = restartedOwner();
    for (const at_ of [0, 60_000, 150_000, 240_000]) await pass(at, t0 + at_, owner, lines, said);
    expect(floorState(at.root, at.home).kind).toBe('active');
    expect(said.some(line => line.includes('rolled back to dark'))).toBe(false);
    await pass(at, t0 + STRANDED_ROLLBACK_MS + 1_000, owner, lines, said);
    expect(floorState(at.root, at.home).kind).toBe('dark');
    const rollback = said.find(line => line.includes('rolled back to dark'));
    expect(rollback).toBeDefined();
    expect(rollback).toContain(SEAT);
    expect(rollback).toContain('the shell is not the recorded shell');
    expect(lines).toEqual([]);
    clearStranded(at.root);
  });

  test('a seat the proof lets through is never stranded: the root stays active', async () => {
    const at = setupRoot();
    clearStranded(at.root);
    writeStamped(at, MSG_ID);
    const lines: string[] = [];
    const said: string[] = [];
    const t0 = Date.now() + 1_000;
    await pass(at, t0, ownerFromNodes(realisticClaudeNodes()), lines, said);
    await pass(at, t0 + STRANDED_ROLLBACK_MS + 1_000, ownerFromNodes(realisticClaudeNodes()), lines, said);
    expect(floorState(at.root, at.home).kind).toBe('active');
    expect(said.some(line => line.includes('rolled back to dark'))).toBe(false);
    expect(strandedSeats(at.root, t0 + STRANDED_ROLLBACK_MS + 1_000, (floorState(at.root, at.home) as { at: string }).at)).toEqual([]);
    clearStranded(at.root);
  });
});
