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
import { wakeTryPath, wakeUnreadDrops } from '../src/watch/unread.ts';
import { testIo } from './helpers.ts';
import { fake, world, type World } from './send-native-fixtures.ts';

const SESSION = 'acme';
const SEAT = 'helper';
const DAEMON: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const MSG_ID = '8b110000-0000-4000-8000-000000001472';
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

describe('independent verification of Claude descendant pointer proof and dark-root activation', () => {
  test('1. realistic Claude tree (CLI + MCP server + tool shell + grandchild) passes proof and delivers a guarded pointer', async () => {
    const nodes = realisticClaudeNodes();
    const owner = ownerFromNodes(nodes);
    expect(typedPaneProof(RECORDED_RECORD, SEAT, `pane-${SEAT}`, SESSION, owner, true)).toEqual({ ok: true });

    const at = setupRoot();
    writeStamped(at, MSG_ID);
    const lines: string[] = [];
    let entered = false;
    const scene = buildScene(at, new Date(Date.now() + 1_000), lines);
    scene.sources.keyOwner = owner;
    scene.sources.typedWake = (pane, line, cli, _session, options) =>
      deliverTypedWake(
        {
          read: () =>
            entered
              ? CLAUDE_IDLE.replace('❯', '✻ Working…\n❯')
              : lines.length === 0
                ? CLAUDE_IDLE
                : CLAUDE_IDLE.replace(/❯[^\n]*/, `❯ ${lines[0]}`),
          type: (_pane, text) => {
            lines.push(text);
            return true;
          },
          enter: () => {
            entered = true;
            return true;
          },
          wait: async () => {},
        },
        pane,
        line,
        cli,
        { ...options, settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 },
      );

    await wakeUnreadDrops(scene, { unreadAfter: 600 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`team drops --read --seat ${SEAT}`);
    expect(entered).toBe(true);
    expect(attemptLedger(seatMailDirIn(at.dir, SESSION, SEAT, 'stamped'), MSG_ID).attempts).toBe(1);
  });

  test('2. refusals: unrelated process, reparented orphan, reused pid with later birth, parent change between typing and Enter, cycle, and depth > 64 all refuse', async () => {
    // Baseline realistic tree passes first.
    expect(typedPaneProof(RECORDED_RECORD, SEAT, `pane-${SEAT}`, SESSION, ownerFromNodes(realisticClaudeNodes()), true)).toEqual({ ok: true });

    // 2a. Unrelated process in front (another child of the shell, ppid 500).
    const unrelated = realisticClaudeNodes();
    unrelated.set(504, { pid: 504, ppid: 500, birth: 1_700_000_000_530_000 });
    expect(typedPaneProof(RECORDED_RECORD, SEAT, `pane-${SEAT}`, SESSION, ownerFromNodes(unrelated), true)).toEqual({
      ok: false,
      why: 'foreground ancestry does not reach the recorded CLI',
    });

    // 2b. Reparented orphan (ppid 1).
    const orphan = realisticClaudeNodes();
    orphan.set(504, { pid: 504, ppid: 1, birth: 1_700_000_000_530_000 });
    expect(typedPaneProof(RECORDED_RECORD, SEAT, `pane-${SEAT}`, SESSION, ownerFromNodes(orphan), true)).toEqual({
      ok: false,
      why: 'foreground ancestry does not reach the recorded CLI',
    });

    // 2c. Reused intermediate pid with a later birth than its child.
    const reused = realisticClaudeNodes();
    reused.set(503, { pid: 503, ppid: 501, birth: 1_700_000_000_590_000 });
    expect(typedPaneProof(RECORDED_RECORD, SEAT, `pane-${SEAT}`, SESSION, ownerFromNodes(reused), true)).toEqual({
      ok: false,
      why: 'a foreground ancestor was born after its child',
    });

    // 2d. Cycle in ancestry (503 -> 504 -> 503 with equal birth so the cycle guard itself is reached).
    const cyclic = realisticClaudeNodes();
    cyclic.set(503, { pid: 503, ppid: 504, birth: 1_700_000_000_530_000 });
    expect(typedPaneProof(RECORDED_RECORD, SEAT, `pane-${SEAT}`, SESSION, ownerFromNodes(cyclic), true)).toEqual({
      ok: false,
      why: 'foreground ancestry contains a cycle',
    });

    // 2e. Chain deeper than 64 links (65 links from 700..764 under 501).
    const deep = realisticClaudeNodes();
    for (let i = 0; i <= 64; i += 1) {
      const pid = 700 + i;
      const ppid = i === 0 ? 501 : pid - 1;
      deep.set(pid, { pid, ppid, birth: 1_700_000_001_000_000 + i * 1_000 });
    }
    expect(
      typedPaneProof(RECORDED_RECORD, SEAT, `pane-${SEAT}`, SESSION, ownerFromNodes(deep, [501, 764]), true),
    ).toEqual({
      ok: false,
      why: 'foreground ancestry exceeds its depth bound',
    });

    // 2f. Non-Claude CLI keeps its refusal on the realistic tree.
    expect(typedPaneProof(RECORDED_RECORD, SEAT, `pane-${SEAT}`, SESSION, ownerFromNodes(realisticClaudeNodes()), false)).toEqual({
      ok: false,
      why: 'an unrecorded process is in front of the shell',
    });

    // 2g. Parent change between typing and Enter prevents Enter from reaching the pane.
    const at = setupRoot();
    writeStamped(at, MSG_ID);
    const liveNodes = realisticClaudeNodes();
    const typedTexts: string[] = [];
    let enterPressed = false;
    const scene = buildScene(at, new Date(Date.now() + 1_000), typedTexts);
    scene.sources.keyOwner = ownerFromNodes(liveNodes);
    scene.sources.typedWake = (pane, line, cli, _session, options) =>
      deliverTypedWake(
        {
          read: () => (typedTexts.length === 0 ? CLAUDE_IDLE : CLAUDE_IDLE.replace(/❯[^\n]*/, `❯ ${typedTexts[0]}`)),
          type: (_pane, text) => {
            typedTexts.push(text);
            // Reparent grandchild 504 to init (1) after typing and before Enter.
            liveNodes.set(504, { pid: 504, ppid: 1, birth: 1_700_000_000_530_000 });
            return true;
          },
          enter: () => {
            enterPressed = true;
            return true;
          },
          wait: async () => {},
        },
        pane,
        line,
        cli,
        { ...options, settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 },
      );

    await wakeUnreadDrops(scene, { unreadAfter: 600 });
    expect(typedTexts).toHaveLength(1);
    expect(enterPressed).toBe(false);
    const retry = JSON.parse(readFileSync(wakeTryPath(seatMailDirIn(at.dir, SESSION, SEAT), MSG_ID), 'utf8')) as {
      reason?: string;
      typed?: boolean;
    };
    expect(retry.typed).toBe(true);
    expect(retry.reason).toContain('foreground ancestry does not reach the recorded CLI');
  });

  test('3. dark-root activation passes with reachable Claude descendant trees, and refuses and names an unreachable seat without writing', async () => {
    const at = setupRoot();
    writeDaemon(at.home);
    expect(deactivate(at.root, at.home).kind).toBe('dark');

    const nodes = new Map<number, ProcessParent>([
      // lead tree: shell 300 -> CLI 301 -> MCP 302, tool shell 303 -> grandchild 304
      [301, { pid: 301, ppid: 300, birth: 1_700_000_000_500_000 }],
      [302, { pid: 302, ppid: 301, birth: 1_700_000_000_510_000 }],
      [303, { pid: 303, ppid: 301, birth: 1_700_000_000_520_000 }],
      [304, { pid: 304, ppid: 303, birth: 1_700_000_000_530_000 }],
      // helper tree: shell 500 -> CLI 501 -> MCP 502, tool shell 503 -> grandchild 504
      ...realisticClaudeNodes(),
    ]);

    const multiSeatOwner: TypedPaneSources = {
      agents: () => [
        { name: 'lead', pane: 'pane-lead', session: 'conv-lead' },
        { name: SEAT, pane: `pane-${SEAT}`, session: `conv-${SEAT}` },
      ],
      processes: (pane) =>
        pane === 'pane-lead'
          ? { shell: 300, foreground: [301, 302, 303, 304] }
          : { shell: 500, foreground: [501, 502, 503, 504] },
      processStart: (pid) => (pid === 300 || pid === 500 ? 1_700_000_000_000 : 1_700_000_000_500),
      processParent: (pid) => nodes.get(pid) ?? null,
    };

    // When helper has an orphan/unrelated foreground process (504 reparented to 1), activation refuses, names helper only, and writes nothing.
    nodes.set(504, { pid: 504, ppid: 1, birth: 1_700_000_000_530_000 });
    const before = [treeSnapshot(at.root), treeSnapshot(at.home)];
    const ioRefused = testIo(at.root, { kind: 'owner' });
    expect(await runQueues(['activate'], ioRefused, { home: at.home, paneOwner: multiSeatOwner })).toBe(1);
    expect(ioRefused.err).toContain(`${SEAT}:`);
    expect(ioRefused.err).not.toContain('lead:');
    expect([treeSnapshot(at.root), treeSnapshot(at.home)]).toEqual(before);

    // When both running Claude seats have valid descendant trees, dark-root activation succeeds.
    nodes.set(504, { pid: 504, ppid: 503, birth: 1_700_000_000_530_000 });
    const ioOk = testIo(at.root, { kind: 'owner' });
    expect(await runQueues(['activate'], ioOk, { home: at.home, paneOwner: multiSeatOwner })).toBe(0);
    expect(ioOk.out).toContain('activated at level 3');
  });
});
