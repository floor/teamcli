import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as send from '../src/commands/send.ts';
import { runQueues } from '../src/commands/queues.ts';
import { realWatchSources, runWatch } from '../src/commands/watch.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import type { SendHost } from '../src/commands/send.ts';
import { listenerKeyOf, proveOffer } from '../src/comms/offer.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { setHerdrRun } from '../src/herdr.ts';
import { executePlan, type ScreenKind } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { writeListener, type InboxListener } from '../src/mcp/inbox.ts';
import { activate, deactivate, type FloorActor } from '../src/queue/floor.ts';
import { attemptLedger, takeCopyNumber } from '../src/queue/handover.ts';
import { seatMailDirIn } from '../src/queue/mail-tree.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { signRecord, stampedPayload, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { deliverTypedWake, type TypedWakeResult } from '../src/send/typed-wake.ts';
import { readState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { messageKeyState } from '../src/store/keys.ts';
import type { RetryScene, RetrySources } from '../src/watch/retry.ts';
import { wakeTryPath, wakeUnreadDrops } from '../src/watch/unread.ts';
import { testIo } from './helpers.ts';
import { hostedLoop } from './helpers/hosted-watch.ts';
import { fake, world, type World } from './send-native-fixtures.ts';

const SESSION = 'acme';
const SEAT = 'helper';
const DAEMON: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const MSG_ID = '7a110000-0000-4000-8000-000000001469';
const PROVE_ID = '7a220000-0000-4000-8000-000000001469';
const CLAUDE_IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'claude-code', '2.1.326', 'idle.txt'), 'utf8');
const AGY_IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12', 'idle.txt'), 'utf8');

const cleanups: (() => void)[] = [];
afterEach(() => {
  setHerdrRun(null);
  for (const clean of cleanups.splice(0)) clean();
});

type Fixture = World & { leadId: string; listener: InboxListener };

function keyOf(home: string) {
  const state = messageKeyState(home);
  if (state.kind !== 'key') throw new Error('missing message key');
  return state.key;
}

function setupActiveRoot(extra: Parameters<typeof world>[1] = [], order: readonly string[] | null = null): Fixture {
  const at = world(order, extra);
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
  const seatRecord = (name: string) => ({
    stage: 'ready',
    pane: `pane-${name}`,
    agent_session: `conv-${name}`,
    launched: { shell: 111, cli: [222], cli_start: [1_700_000_000_500] },
    pane_shell: 111,
    pane_shell_start: 1_700_000_000_000,
  });
  writeFileSync(
    join(at.dir, 'team.state.json'),
    `${JSON.stringify({
      format: 1,
      sessions: {
        [SESSION]: {
          seats: {
            [SEAT]: seatRecord(SEAT),
            lead: seatRecord('lead'),
            ...Object.fromEntries(extra.map((one) => [one.name, seatRecord(one.name)])),
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

function writeStampedTo(at: Fixture, to: string, id: string): void {
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to,
    to_id: null,
    root: at.root,
    session: SESSION,
    at: new Date().toISOString(),
    body: `independent test payload ${id}`,
    from: 'lead',
    from_id: at.leadId,
    rule: 'the owner',
    thread: id,
  };
  const signed = signRecord(stampedPayload(payload, at.home), at.home);
  expect(writeRecord(seatMailDirIn(at.dir, SESSION, to), signed).ok).toBe(true);
}

function proveChannelFor(at: Fixture, seat: string): void {
  writeStampedTo(at, seat, PROVE_ID);
  const dropDir = seatMailDirIn(at.dir, SESSION, seat);
  const listener: InboxListener = { ...at.listener, seat };
  expect(writeListener(dropDir, listener)).toBe(true);
  const token = 'e'.repeat(32);
  expect(
    takeCopyNumber(seatMailDirIn(at.dir, SESSION, seat, 'stamped'), PROVE_ID, 'channel', Date.now(), {
      token,
      listener: listenerKeyOf(listener),
    }),
  ).not.toBeNull();
  expect(
    publishRecordRead({
      dropDir,
      id: PROVE_ID,
      to: seat,
      root: at.root,
      session: SESSION,
      home: at.home,
      key: keyOf(at.home),
      at: new Date().toISOString(),
      readBy: 'channel',
    }).kind,
  ).toBe('published');
  expect(
    proveOffer(dropDir, PROVE_ID, token, listenerKeyOf(listener), {
      root: at.root,
      session: SESSION,
      seat,
      key: keyOf(at.home),
    }),
  ).not.toBeNull();
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

function buildScene(
  at: Fixture,
  now: Date,
  lines: string[],
  options: { seat?: string; cli?: string; screen?: string } = {},
): RetryScene {
  const loaded = loadTeamFile(at.root, { home: at.home });
  if (!loaded.ok) throw new Error('failed to load team file');
  const team = loaded.team;
  const seat = options.seat ?? SEAT;
  const cli = options.cli ?? 'claude-code';
  const screen = options.screen ?? CLAUDE_IDLE;
  const live: Live = {
    running: true,
    agents: [{ name: seat, agent: cli === 'claude-code' ? 'claude' : cli, pane: `pane-${seat}`, workspace: 'w', status: 'idle', cwd: null }],
    workspaces: [],
    screens: { [`pane-${seat}`]: screen },
  };
  const host: SendHost = fake(at, { agents: () => [{ name: seat, pane: `pane-${seat}`, cli }] });
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
      screen: () => screen,
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

describe('independent verification of the unproven Claude seat pointer and activation guard', () => {
  test('1. activation guard: refuses running unproven Claude seat without pointer proof, ignores stopped seat, and activates when proven or pointer-proved', async () => {
    const at = setupActiveRoot();
    writeDaemon(at.home);
    proveChannelFor(at, 'lead');
    expect(deactivate(at.root, at.home).kind).toBe('dark');

    const unprovableOwner: NonNullable<RetrySources['keyOwner']> = {
      agents: () => [
        { name: 'lead', pane: 'pane-lead', session: 'conv-lead' },
        { name: SEAT, pane: `pane-${SEAT}`, session: `conv-${SEAT}` },
      ],
      processes: () => null,
      processStart: () => null,
    };

    // Running unproven Claude seat with no passing pointer proof refuses, names the seat, exits 1, and writes nothing.
    const before = [treeSnapshot(at.root), treeSnapshot(at.home)];
    const ioRefused = testIo(at.root, { kind: 'owner' });
    expect(await runQueues(['activate'], ioRefused, { home: at.home, paneOwner: unprovableOwner })).toBe(1);
    expect(ioRefused.err).toContain(`${SEAT}:`);
    expect(ioRefused.err).not.toContain('lead:');
    expect([treeSnapshot(at.root), treeSnapshot(at.home)]).toEqual(before);

    // Marking the unproven Claude seat stopped allows activation to proceed.
    const teamFile = join(at.dir, 'team.yaml');
    const originalTeamYaml = readFileSync(teamFile, 'utf8');
    writeFileSync(teamFile, originalTeamYaml.replace(`name: ${SEAT}\n`, `name: ${SEAT}\n    stopped: true\n`));
    const ioStopped = testIo(at.root, { kind: 'owner' });
    expect(await runQueues(['activate'], ioStopped, { home: at.home, paneOwner: unprovableOwner })).toBe(0);
    expect(ioStopped.out).toContain('activated at level 3');

    // Restore running seat, prove its channel, and verify activation succeeds even when pointer proof is unavailable.
    writeFileSync(teamFile, originalTeamYaml);
    expect(deactivate(at.root, at.home).kind).toBe('dark');
    proveChannelFor(at, SEAT);
    const ioProven = testIo(at.root, { kind: 'owner' });
    expect(await runQueues(['activate'], ioProven, { home: at.home, paneOwner: unprovableOwner })).toBe(0);
    expect(ioProven.out).toContain('activated at level 3');
  });

  test('1b. activation guard: foreign-root entity orchestrator does not block, own-root protected entity orchestrator blocks, unreadable state refuses cleanly', async () => {
    const at = setupActiveRoot();
    writeDaemon(at.home);
    expect(deactivate(at.root, at.home).kind).toBe('dark');

    const validOwner: NonNullable<RetrySources['keyOwner']> = {
      agents: () => [
        { name: 'lead', pane: 'pane-lead', session: 'conv-lead' },
        { name: SEAT, pane: `pane-${SEAT}`, session: `conv-${SEAT}` },
        { name: 'foreign-entity-lead', pane: 'pane-foreign', session: 'conv-foreign' },
      ],
      processes: () => ({ shell: 111, foreground: [222] }),
      processStart: (pid) => (pid === 111 ? 1_700_000_000_000 : 1_700_000_000_500),
    };

    // Child root whose entity is another project ('parent'): lead's pointer is permitted, foreign entity lead has no local record.
    const parentLobby = resolveLobby(at.home, { entity: 'parent' });
    mkdirSync(parentLobby, { recursive: true });
    const teamFile = join(at.dir, 'team.yaml');
    const baseYaml = readFileSync(teamFile, 'utf8');
    writeFileSync(teamFile, `${baseYaml.replace(lobbyDir(at.home), parentLobby)}entity: parent\n`);
    const ioChild = testIo(at.root, { kind: 'owner' });
    expect(await runQueues(['activate'], ioChild, { home: at.home, paneOwner: validOwner })).toBe(0);

    // Own-root entity orchestrator (entity === project === 'acme'): lead is protected (pointer: false) and unproven, so activation refuses.
    expect(deactivate(at.root, at.home).kind).toBe('dark');
    const acmeLobby = resolveLobby(at.home, { entity: 'acme' });
    mkdirSync(acmeLobby, { recursive: true });
    writeFileSync(teamFile, `${baseYaml.replace(lobbyDir(at.home), acmeLobby)}entity: acme\n`);
    const beforeEntityRefusal = [treeSnapshot(at.root), treeSnapshot(at.home)];
    const ioOwnEntity = testIo(at.root, { kind: 'owner' });
    expect(await runQueues(['activate'], ioOwnEntity, { home: at.home, paneOwner: validOwner })).toBe(1);
    expect(ioOwnEntity.err).toContain('lead:');
    expect(ioOwnEntity.err).toContain('typed pointer is protected');
    expect([treeSnapshot(at.root), treeSnapshot(at.home)]).toEqual(beforeEntityRefusal);

    // Unreadable team.state.json refuses with exit 1 and writes nothing.
    writeFileSync(teamFile, baseYaml);
    const stateFile = join(at.dir, 'team.state.json');
    writeFileSync(stateFile, '{corrupted-json');
    const beforeCorrupt = [treeSnapshot(at.root), treeSnapshot(at.home)];
    const ioCorrupt = testIo(at.root, { kind: 'owner' });
    expect(await runQueues(['activate'], ioCorrupt, { home: at.home, paneOwner: validOwner })).toBe(1);
    expect(ioCorrupt.err).toContain('seat state cannot be read');
    expect([treeSnapshot(at.root), treeSnapshot(at.home)]).toEqual(beforeCorrupt);
  });

  for (const withCliStart of [false, true]) {
    test(`2 & 4a. record without shell anchors (${withCliStart ? 'relaunched with cli_start' : 'pre-install without cli_start'}) gets pointer in one pass using production keyOwner.agents`, async () => {
      const at = setupActiveRoot();
      const state = readState(at.dir);
      const held = state.sessions[SESSION]!.seats[SEAT]!;
      delete held.pane_shell;
      delete held.pane_shell_start;
      if (!withCliStart) delete held.launched!.cli_start;
      writeFileSync(join(at.dir, 'team.state.json'), JSON.stringify(state));

      writeStampedTo(at, SEAT, MSG_ID);

      // Drive the production realWatchSources.keyOwner.agents reader through the terminal host reader.
      setHerdrRun((args) => {
        if (args[0] === 'agent' && args[1] === 'list') {
          return {
            agents: [
              {
                name: SEAT,
                agent: 'claude',
                pane_id: `pane-${SEAT}`,
                workspace_id: 'w',
                agent_status: 'idle',
                cwd: null,
                agent_session: { agent: 'claude', kind: 'id', source: 'hook', value: `conv-${SEAT}` },
              },
            ],
          };
        }
        return null;
      });

      const lines: string[] = [];
      let entered = false;
      const scene = buildScene(at, new Date(Date.now() + 1_000), lines);
      scene.sources.keyOwner = {
        agents: realWatchSources.keyOwner!.agents,
        processes: () => ({ shell: 111, foreground: [222] }),
        processStart: (pid) => (pid === 111 ? 1_700_000_000_000 : 1_700_000_000_500),
      };
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

      const io = testIo(at.root, { kind: 'owner' });
      expect(
        await runWatch(['--file', join(at.dir, 'team.yaml')], io, {
          ...scene.sources,
          live: () => scene.live,
          machine: () => ({ loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 }),
          standing: () => ({ kind: 'none' }),
          readChecks: () => [],
          foreground: () => ['claude'],
          notify: () => {},
          now: () => scene.now,
          wait: async () => false,
          alive: () => false,
          pid: process.pid,
          home: at.home,
          hosted: hostedLoop(),
        }),
      ).toBe(0);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`team drops --read --seat ${SEAT}`);
      expect(entered).toBe(true);
      expect(attemptLedger(seatMailDirIn(at.dir, SESSION, SEAT, 'stamped'), MSG_ID).attempts).toBe(1);
    });
  }

  test('3. refusals stay closed: duplicate seat name, missing/different conversation, replaced shell, reused CLI pid, mismatched anchors, and non-Claude CLI all type nothing', async () => {
    const scenarios: {
      label: string;
      keepPaneShell?: boolean;
      paneShellStart?: number;
      agents: { name: string; pane: string; session?: string }[];
      shell: number;
      cliStart: number;
    }[] = [
      {
        label: 'another agent with the same seat name',
        agents: [
          { name: SEAT, pane: `pane-${SEAT}`, session: `conv-${SEAT}` },
          { name: SEAT, pane: 'pane-duplicate', session: 'conv-other' },
        ],
        shell: 111,
        cliStart: 1_700_000_000_500,
      },
      {
        label: 'missing live conversation id',
        agents: [{ name: SEAT, pane: `pane-${SEAT}` }],
        shell: 111,
        cliStart: 1_700_000_000_500,
      },
      {
        label: 'different live conversation id',
        agents: [{ name: SEAT, pane: `pane-${SEAT}`, session: 'conv-stranger' }],
        shell: 111,
        cliStart: 1_700_000_000_500,
      },
      {
        label: 'replaced shell pid',
        agents: [{ name: SEAT, pane: `pane-${SEAT}`, session: `conv-${SEAT}` }],
        shell: 999,
        cliStart: 1_700_000_000_500,
      },
      {
        label: 'reused CLI pid with a different birth',
        agents: [{ name: SEAT, pane: `pane-${SEAT}`, session: `conv-${SEAT}` }],
        shell: 111,
        cliStart: 1_700_000_099_999,
      },
      {
        label: 'anchors present but mismatched shell start',
        keepPaneShell: true,
        paneShellStart: 1_700_000_099_999,
        agents: [{ name: SEAT, pane: `pane-${SEAT}`, session: `conv-${SEAT}` }],
        shell: 111,
        cliStart: 1_700_000_000_500,
      },
    ];

    for (const item of scenarios) {
      const at = setupActiveRoot();
      const state = readState(at.dir);
      const held = state.sessions[SESSION]!.seats[SEAT]!;
      if (!item.keepPaneShell) delete held.pane_shell;
      if (item.paneShellStart === undefined) delete held.pane_shell_start;
      else held.pane_shell_start = item.paneShellStart;
      writeFileSync(join(at.dir, 'team.state.json'), JSON.stringify(state));

      writeStampedTo(at, SEAT, MSG_ID);
      const lines: string[] = [];
      const scene = buildScene(at, new Date(Date.now() + 1_000), lines);
      scene.sources.keyOwner = {
        agents: () => item.agents,
        processes: () => ({ shell: item.shell, foreground: [222] }),
        processStart: (pid) => (pid === item.shell ? 1_700_000_000_000 : item.cliStart),
      };
      await wakeUnreadDrops(scene, { unreadAfter: 600 });
      expect(lines).toEqual([]);
      expect(attemptLedger(seatMailDirIn(at.dir, SESSION, SEAT, 'stamped'), MSG_ID).attempts).toBe(0);
      const retry = JSON.parse(readFileSync(wakeTryPath(seatMailDirIn(at.dir, SESSION, SEAT), MSG_ID), 'utf8')) as { reason?: string };
      expect(retry.reason).toContain('refused before the first key; ');
    }

    // Non-Claude CLI without shell anchors never gets the conversation fallback even when its conversation matches.
    const atNonClaude = setupActiveRoot(
      [{ name: 'agy', role: 'implementer', cli: 'antigravity', launch: 'agy' }],
      ['typed'],
    );
    const nonClaudeState = readState(atNonClaude.dir);
    const heldAgy = nonClaudeState.sessions[SESSION]!.seats['agy']!;
    delete heldAgy.pane_shell;
    delete heldAgy.pane_shell_start;
    writeFileSync(join(atNonClaude.dir, 'team.state.json'), JSON.stringify(nonClaudeState));

    writeStampedTo(atNonClaude, 'agy', MSG_ID);
    takeCopyNumber(seatMailDirIn(atNonClaude.dir, SESSION, 'agy', 'stamped'), MSG_ID, 'typed');
    const agyLines: string[] = [];
    const agyScene = buildScene(atNonClaude, new Date(Date.now() + 61_000), agyLines, {
      seat: 'agy',
      cli: 'antigravity',
      screen: AGY_IDLE,
    });
    agyScene.sources.keyOwner = {
      agents: () => [{ name: 'agy', pane: 'pane-agy', session: 'conv-agy' }],
      processes: () => ({ shell: 111, foreground: [222] }),
      processStart: (pid) => (pid === 111 ? 1_700_000_000_000 : 1_700_000_000_500),
    };
    await wakeUnreadDrops(agyScene, { unreadAfter: 600 });
    expect(agyLines).toEqual([]);
    expect(attemptLedger(seatMailDirIn(atNonClaude.dir, SESSION, 'agy', 'stamped'), MSG_ID).attempts).toBe(0);
  });

  test('4b. switching the conversation between typing and Enter prevents Enter from reaching the new conversation', async () => {
    const at = setupActiveRoot();
    const state = readState(at.dir);
    const held = state.sessions[SESSION]!.seats[SEAT]!;
    delete held.pane_shell;
    delete held.pane_shell_start;
    writeFileSync(join(at.dir, 'team.state.json'), JSON.stringify(state));

    writeStampedTo(at, SEAT, MSG_ID);
    let liveConversation = `conv-${SEAT}`;
    setHerdrRun((args) => {
      if (args[0] === 'agent' && args[1] === 'list') {
        return {
          agents: [
            {
              name: SEAT,
              agent: 'claude',
              pane_id: `pane-${SEAT}`,
              workspace_id: 'w',
              agent_status: 'idle',
              cwd: null,
              agent_session: { agent: 'claude', kind: 'id', source: 'hook', value: liveConversation },
            },
          ],
        };
      }
      return null;
    });

    const typedTexts: string[] = [];
    let enterPressed = false;
    const scene = buildScene(at, new Date(Date.now() + 1_000), typedTexts);
    scene.sources.keyOwner = {
      agents: realWatchSources.keyOwner!.agents,
      processes: () => ({ shell: 111, foreground: [222] }),
      processStart: (pid) => (pid === 111 ? 1_700_000_000_000 : 1_700_000_000_500),
    };
    scene.sources.typedWake = (pane, line, cli, _session, options) =>
      deliverTypedWake(
        {
          read: () => (typedTexts.length === 0 ? CLAUDE_IDLE : CLAUDE_IDLE.replace(/❯[^\n]*/, `❯ ${typedTexts[0]}`)),
          type: (_pane, text) => {
            typedTexts.push(text);
            // Immediately after typing the pointer text, the pane switches to another conversation.
            liveConversation = 'conv-switched-mid-wake';
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
    const retry = JSON.parse(readFileSync(wakeTryPath(seatMailDirIn(at.dir, SESSION, SEAT), MSG_ID), 'utf8')) as { reason?: string; typed?: boolean };
    expect(retry.typed).toBe(true);
    expect(retry.reason).toContain('the live conversation does not match the recorded conversation');
  });

  test('same-pane relaunch writer records pane_shell and pane_shell_start without creating a workspace', async () => {
    const records: { seat: string; patch: Record<string, unknown> }[] = [];
    const steps: Step[] = [
      {
        kind: 'run',
        argv: [],
        do: {
          do: 'launch',
          seat: SEAT,
          label: SEAT,
          command: 'claude',
          pane: `pane-${SEAT}`,
          workspace: 'w',
          cli: 'claude-code',
          cwd: '.',
        },
      },
      {
        kind: 'run',
        argv: [],
        do: {
          do: 'idle',
          seat: SEAT,
          label: SEAT,
          cli: 'claude-code',
          seconds: 30,
          command: 'claude',
          pane: `pane-${SEAT}`,
          workspace: 'w',
          repairLine: `team remove ${SEAT}`,
        },
      },
      {
        kind: 'run',
        argv: [],
        do: {
          do: 'rename',
          seat: SEAT,
          label: SEAT,
          cli: 'claude-code',
          seconds: 30,
          rules: 'option',
          pane: `pane-${SEAT}`,
        },
      },
    ];

    let now = 0;
    await executePlan(steps, SESSION, {
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => {
        throw new Error('same-pane relaunch must not create a workspace');
      },
      paneRun: () => true,
      typeLine: () => false,
      stopSession: () => true,
      kill: () => true,
      agentPanes: () => [`pane-${SEAT}`],
      allow: () => null,
      agentList: () => [
        {
          name: SEAT,
          agent: 'claude',
          pane: `pane-${SEAT}`,
          workspace: 'w',
          status: 'idle',
          cwd: '/tmp',
          session: `conv-${SEAT}`,
        },
      ],
      workspacePanes: () => [`pane-${SEAT}`],
      processInfo: () => ({ shell: 555, foreground: [777] }),
      processStartOf: (pid) => (pid === 555 ? 1_700_000_111_000 : 1_700_000_222_000),
      classify: (): ScreenKind => 'idle',
      paneText: () => CLAUDE_IDLE,
      foreground: () => ['claude'],
      shellBack: () => false,
      agentStatus: () => null,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
      renameAgent: () => true,
      closeWorkspace: () => true,
      record: (seat, patch) => {
        records.push({ seat, patch: patch as Record<string, unknown> });
      },
      drop: () => true,
      running: () => {},
      say: () => {},
      final: () => {},
      log: () => {},
    });

    const launchedPatch = records.find((one) => one.patch.launched !== undefined)?.patch;
    expect(launchedPatch).toBeDefined();
    expect(launchedPatch?.pane_shell).toBe(555);
    expect(launchedPatch?.pane_shell_start).toBe(1_700_000_111_000);
    expect(launchedPatch?.launched).toEqual({
      shell: 555,
      cli: [777],
      cli_start: [1_700_000_222_000],
    });
    expect(launchedPatch?.agent_session).toBe(`conv-${SEAT}`);
  });
});
