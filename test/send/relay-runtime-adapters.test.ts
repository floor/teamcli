// Focused synthetic tests for the runtime-adapter contract and fallback-walk
// coordinator (`src/send/push-adapters/relay-runtime.ts`).
//
// Verifies:
//   1. `runtimeRelayCapabilities(runtime, version)` across `claude-code`, `codex`, `gemini`,
//      `cursor`, and unsupported runtimes (`grok`, `antigravity`, `jules`, `muse`, `opencode`),
//      preserving `ack: false` and `liveReceiptProven: false`.
//   2. `probeRuntimeRelayRoute` live/accepts prechecks (`socket` `crossSessionInbound`, `native`
//      `<= 400ms` `thread/read` readiness, `headless-resume` session binding) and `would-hold`
//      classification.
//   3. `deliverRuntimeRelayRoute` copy-before-attempt, non-blocking `would-hold` skip, and receipt
//      semantics (`delivered`/`enqueue` != `read` without verified `<id>.read.json`; `durable-copy`
//      is `held`, never wake or read).
//   4. `walkRuntimeRelayRoutes` + `FallbackWalk` + `readMessage` + `escalateDue` binding addendum:
//      - synthetic socket killed mid-send (`ECONNRESET` / connection closed before frame taken)
//        falls through to the next allowed route (`native` or `headless-resume`) with the exact
//        same `message.id` and staged record, recording both attempts and deduplicating at the
//        receiver's `readMessage` gate;
//      - all live routes failing leaves the durable copy `held`, emits one immediate `message.held`
//        event, and fires the delayed main-orchestrator escalation once at `dueAt`.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readEvents } from '../../src/bus/log.ts';
import type { Caller } from '../../src/caller.ts';
import { entitiesPath } from '../../src/entities.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { cliHookSettingsPath } from '../../src/launch/cli-hook.ts';
import { resolveLobby } from '../../src/lobby/gate.ts';
import { readMessage } from '../../src/mcp/inbox.ts';
import { DELIVERY_ESCALATION_SECONDS } from '../../src/policy/types.ts';
import { registerAgent } from '../../src/registry/agents.ts';
import type { RecordedSeatSession } from '../../src/registry/resume.ts';
import { teamIdOf } from '../../src/registry/teams.ts';
import {
  allFailedRecordId,
  attemptLedgerFileName,
  escalatedRecordId,
  escalationMailboxId,
  escalateDue,
  markerPathOf,
  type CanonicalRecipient,
  type FallbackMarker,
} from '../../src/send/fallback-events.ts';
import { beginFallbackWalk } from '../../src/send/fallback-walk.ts';
import { historyPath } from '../../src/send/history.ts';
import { pushPointer } from '../../src/send/push.ts';
import {
  deliverRuntimeRelayRoute,
  probeRuntimeRelayRoute,
  RUNTIME_PUSH_ADAPTERS,
  RUNTIME_RELAY_ROUTES,
  runtimeRelayCapabilities,
  walkRuntimeRelayRoutes,
} from '../../src/send/push-adapters.ts';
import { signRecord, verifyReceipt, verifyRecord, type RecordPayload } from '../../src/send/record.ts';
import { messageKeyOf } from '../../src/store/keys.ts';

const NOW = new Date('2026-10-20T09:30:00.000Z');
const MESSAGE_ID = '33333333-4444-4555-8666-777777777777';
const THREAD_ID = '019a1111-2222-7333-8444-555566667777';
const SESSION_ID = 'ses_gemini_cursor_019a1111';
const SESSION = 'teamcli';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeScratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-runtime-adapters-')));
  tempDirs.push(dir);
  return dir;
}

function makeBoundSession(
  cli: string,
  sessionId: string,
  seat = 'worker',
): RecordedSeatSession {
  return {
    agentId: 'agt_123456789abc',
    seatHandle: 'seat_123456789abc',
    sessionId,
    team: 'team_acme',
    seat,
    cli,
    herdrSession: SESSION,
    pane: 'w1:p2',
    address: null,
  };
}

type Scene = {
  base: string;
  root: string;
  dir: string;
  home: string;
  sockets: string;
  dropDir: string;
  seat: string;
  cli: string;
  recordText: string;
  frame: string;
  pointer: string;
};

function makeScene(cli: 'claude-code' | 'codex' | 'gemini' | 'cursor', seat = 'worker'): Scene {
  const base = makeScratch();
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  const lobby = resolveLobby(home, { entity: 'floor' });
  const dropDir = join(dir, 'send-drops', SESSION, seat);

  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(entitiesPath(home)), { recursive: true });
  writeFileSync(entitiesPath(home), `floor:\n  roots:\n    - ${JSON.stringify(base)}\n`);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });

  const launch =
    cli === 'claude-code'
      ? 'claude'
      : cli === 'codex'
        ? 'codex -m gpt-6-sol'
        : cli === 'gemini'
          ? 'gemini -m gemini-3-pro'
          : 'cursor-agent --model composer-2';
  const sessionToken = cli === 'codex' ? THREAD_ID : SESSION_ID;

  writeFileSync(
    join(dir, 'team.yaml'),
    `format: 1
project: acme
entity: floor
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: ${seat}
    cli: ${cli}
    vendor: test
    model: Test
    version: "1"
    launch: ${launch}
`,
  );

  writeFileSync(
    join(dir, 'team.state.json'),
    `${JSON.stringify({
      format: 1,
      sessions: {
        [SESSION]: {
          seats: {
            lead: { id: 'seat_lead_001', stage: 'ready', pane: 'w1:p1' },
            [seat]: {
              id: 'seat_123456789abc',
              stage: 'ready',
              pane: 'w1:p2',
              agent_session: sessionToken,
            },
          },
          worktrees: {},
        },
      },
    })}\n`,
  );

  registerAgent(home, {
    name: seat,
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test',
    cli,
    launcher: null,
    launch,
    seat_handle: 'seat_123456789abc',
    reach: {
      team: teamIdOf(root),
      seat,
      session: SESSION,
      agent_session: sessionToken,
      pane: 'w1:p2',
      address: null,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });

  const payload: RecordPayload = {
    kind: 'message',
    id: MESSAGE_ID,
    to: seat,
    to_id: 'agt_123456789abc',
    root,
    session: SESSION,
    at: NOW.toISOString(),
    body: 'from lead — admitted by: a coordinator to a seat of its own team\n\nrun team next',
    from: 'lead',
    from_id: 'seat_lead_001',
    rule: 'a coordinator to a seat of its own team',
    thread: MESSAGE_ID,
  };
  const signed = signRecord(payload, home);
  const recordText = `${JSON.stringify(signed, null, 2)}\n`;
  const pointer = pushPointer(MESSAGE_ID, { seat: 'lead', team: 'acme' })!;
  const frame = `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: pointer },
    msg_id: MESSAGE_ID,
  })}\n`;

  return {
    base,
    root,
    dir,
    home,
    sockets,
    dropDir,
    seat,
    cli,
    recordText,
    frame,
    pointer,
  };
}

describe('runtimeRelayCapabilities across runtimes', () => {
  test('reports truthful routes, commands, and liveReceiptProven: false for every runtime', () => {
    expect(RUNTIME_RELAY_ROUTES).toEqual([
      'socket',
      'native',
      'headless-resume',
      'durable-copy',
    ]);
    // Native push registry remains Codex-only.
    expect(RUNTIME_PUSH_ADAPTERS.map((a) => a.clis)).toEqual([['codex']]);

    const claude = runtimeRelayCapabilities('claude-code');
    expect(claude.routes).toEqual(['socket', 'durable-copy']);
    expect(claude.socket.supported).toBe(true);
    expect(claude.socket.ack).toBe(false);
    expect(claude.socket.liveReceiptProven).toBe(false);
    expect(claude.native.supported).toBe(false);
    expect(claude.headlessResume.supported).toBe(false);
    expect(claude.durableCopy).toEqual({
      supported: true,
      wakesReceiver: false,
      isReadReceipt: false,
    });
    expect(claude.liveReceiptProven).toBe(false);

    const codex = runtimeRelayCapabilities('codex', '0.161.0');
    expect(codex.routes).toEqual(['native', 'durable-copy']);
    expect(codex.socket.supported).toBe(false);
    expect(codex.native.supported).toBe(true);
    if (codex.native.supported) {
      expect(codex.native.command).toEqual([
        'codex',
        'queue',
        '--thread',
        '<agent_session>',
        '--message',
        '<pointer>',
      ]);
      expect(codex.native.preprobeTimeoutMs).toBe(400);
      expect(codex.native.timeoutMs).toBe(15_000);
      expect(codex.native.ack).toBe(false);
      expect(codex.native.proof).toBe('queue-accepted-only');
      expect(codex.native.liveReceiptProven).toBe(false);
    }
    expect(codex.headlessResume.supported).toBe(false);
    expect(codex.liveReceiptProven).toBe(false);

    const gemini = runtimeRelayCapabilities('gemini', '0.64.0');
    expect(gemini.routes).toEqual(['headless-resume', 'durable-copy']);
    expect(gemini.socket.supported).toBe(false);
    expect(gemini.native.supported).toBe(false);
    expect(gemini.headlessResume.supported).toBe(true);
    if (gemini.headlessResume.supported) {
      expect(gemini.headlessResume.binary).toBe('gemini');
      expect(gemini.headlessResume.command).toEqual([
        'gemini',
        '--approval-mode',
        'yolo',
        '--resume',
        '<agent_session>',
        '-p',
        '<pointer>',
      ]);
      expect(gemini.headlessResume.ack).toBe(false);
      expect(gemini.headlessResume.proof).toBe('process-exit-0-only');
      expect(gemini.headlessResume.liveReceiptProven).toBe(false);
    }

    const cursor = runtimeRelayCapabilities('cursor', '2026.10.16');
    expect(cursor.routes).toEqual(['headless-resume', 'durable-copy']);
    expect(cursor.headlessResume.supported).toBe(true);
    if (cursor.headlessResume.supported) {
      expect(cursor.headlessResume.binary).toBe('cursor-agent');
      expect(cursor.headlessResume.command).toEqual([
        'cursor-agent',
        '--force',
        '--sandbox',
        'disabled',
        '--approve-mcps',
        '--trust',
        '--resume',
        '<agent_session>',
        '-p',
        '<pointer>',
      ]);
    }

    for (const other of ['grok', 'antigravity', 'jules', 'muse', 'opencode']) {
      const caps = runtimeRelayCapabilities(other);
      expect(caps.routes).toEqual(['durable-copy']);
      expect(caps.socket.supported).toBe(false);
      expect(caps.native.supported).toBe(false);
      expect(caps.headlessResume.supported).toBe(false);
      expect(caps.durableCopy.supported).toBe(true);
      expect(caps.liveReceiptProven).toBe(false);
    }
  });
});

describe('probeRuntimeRelayRoute live/accepts and would-hold classification', () => {
  test('classifies socket crossSessionInbound accept vs hold/refuse/unset/stale-socket', async () => {
    const scene = makeScene('claude-code');
    const socketPath = join(scene.sockets, '222.sock');
    writeFileSync(socketPath, '');
    const copy = { dir: scene.dropDir, name: MESSAGE_ID };
    const target = {
      route: 'socket' as const,
      runtime: 'claude-code',
      socket: socketPath,
      copy,
      root: scene.root,
      dir: scene.dir,
      session: SESSION,
      seat: scene.seat,
    };

    // Unset declaration -> unavailable
    const unset = await probeRuntimeRelayRoute(target);
    expect(unset.status).toBe('unavailable');

    // Hold declaration -> would-hold
    const settingsPath = cliHookSettingsPath(scene.dir, SESSION, scene.seat)!;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'hold' }));
    const hold = await probeRuntimeRelayRoute(target);
    expect(hold.status).toBe('would-hold');
    if (hold.status === 'would-hold') {
      expect(hold.reason).toContain('crossSessionInbound hold');
    }

    // Refuse declaration -> refused
    writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'refuse' }));
    const refused = await probeRuntimeRelayRoute(target);
    expect(refused.status).toBe('refused');

    // Accept declaration newer than socket -> would-hold (stale socket predates declaration)
    writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: 'accept' }));
    const futureMs = Date.now() + 60_000;
    utimesSync(settingsPath, new Date(futureMs), new Date(futureMs));
    const staleSocket = await probeRuntimeRelayRoute(target);
    expect(staleSocket.status).toBe('would-hold');

    // Accept declaration older than socket -> ready
    const pastMs = Date.now() - 60_000;
    utimesSync(settingsPath, new Date(pastMs), new Date(pastMs));
    const ready = await probeRuntimeRelayRoute(target, { requireSocketFile: true });
    expect(ready).toEqual({
      status: 'ready',
      route: 'socket',
      socket: socketPath,
    });
  });

  test('classifies Codex native live thread/read ready vs would-hold and Gemini/Cursor headless-resume ready', async () => {
    const codexScene = makeScene('codex');
    const copy = { dir: codexScene.dropDir, name: MESSAGE_ID };
    const codexTarget = {
      route: 'native' as const,
      runtime: 'codex',
      copy,
      root: codexScene.root,
      home: codexScene.home,
      session: SESSION,
      seat: codexScene.seat,
      sender: { seat: 'lead', team: 'acme' },
    };

    const activeOutcome = await probeRuntimeRelayRoute(codexTarget, {
      liveProbe: async () => ({
        ok: true,
        thread: {
          id: THREAD_ID,
          status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
          canAcceptDirectInput: false,
        },
      }),
    });
    expect(activeOutcome.status).toBe('would-hold');

    const idleOutcome = await probeRuntimeRelayRoute(codexTarget, {
      liveProbe: async () => ({
        ok: true,
        thread: {
          id: THREAD_ID,
          status: { type: 'idle' },
          canAcceptDirectInput: true,
        },
      }),
    });
    expect(idleOutcome.status).toBe('ready');

    const geminiScene = makeScene('gemini');
    const geminiOutcome = await probeRuntimeRelayRoute({
      route: 'headless-resume',
      runtime: 'gemini',
      copy: { dir: geminiScene.dropDir, name: MESSAGE_ID },
      root: geminiScene.root,
      home: geminiScene.home,
      session: SESSION,
      seat: geminiScene.seat,
      sender: { seat: 'lead', team: 'acme' },
    });
    expect(geminiOutcome.status).toBe('ready');
    if (geminiOutcome.status === 'ready') {
      expect(geminiOutcome.binary).toBe('gemini');
      expect(geminiOutcome.sessionId).toBe(SESSION_ID);
    }
  });
});

describe('deliverRuntimeRelayRoute copy-before-attempt, non-blocking skip, and receipt semantics', () => {
  test('stages signed copy at 0600 before dialing/spawning, skips would-hold without invoking transport, and preserves delivered != read', async () => {
    const scene = makeScene('codex');
    const copy = { dir: scene.dropDir, name: MESSAGE_ID };

    // 1. Would-hold on Codex native aborts before spawning codex queue, but stages the signed copy first.
    let spawnCount = 0;
    const wouldHoldAttempt = await deliverRuntimeRelayRoute(
      {
        route: 'native',
        runtime: 'codex',
        copy,
        root: scene.root,
        home: scene.home,
        session: SESSION,
        seat: scene.seat,
        sender: { seat: 'lead', team: 'acme' },
      },
      { id: MESSAGE_ID, record: scene.recordText, pointer: scene.pointer },
      {
        now: () => NOW,
        sessionBinding: { kind: 'bound', recorded: makeBoundSession('codex', THREAD_ID, scene.seat) },
        liveProbe: async () => ({
          ok: true,
          thread: {
            id: THREAD_ID,
            status: { type: 'active', activeFlags: ['waitingOnApproval'] },
            canAcceptDirectInput: false,
          },
        }),
        spawn: async () => {
          spawnCount += 1;
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );
    expect(spawnCount).toBe(0);
    expect(wouldHoldAttempt.outcome).toBe('refused');
    if (wouldHoldAttempt.outcome === 'refused') {
      expect(wouldHoldAttempt.wouldHold).toBe(true);
      expect(wouldHoldAttempt.readReceiptVerified).toBe(false);
    }
    const stagedPath = join(scene.dropDir, MESSAGE_ID);
    expect(existsSync(stagedPath)).toBe(true);
    expect(statSync(stagedPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(stagedPath, 'utf8')).toBe(scene.recordText);
    expect(
      verifyRecord(
        JSON.parse(readFileSync(stagedPath, 'utf8')) as ReturnType<typeof signRecord>,
        messageKeyOf(scene.home),
      ),
    ).toBe(true);

    // 2. Idle accepting thread spawns codex queue and returns outcome: 'delivered' (never 'read' without verified receipt).
    const deliveredAttempt = await deliverRuntimeRelayRoute(
      {
        route: 'native',
        runtime: 'codex',
        copy,
        root: scene.root,
        home: scene.home,
        session: SESSION,
        seat: scene.seat,
        sender: { seat: 'lead', team: 'acme' },
      },
      { id: MESSAGE_ID, record: scene.recordText, pointer: scene.pointer },
      {
        now: () => NOW,
        sessionBinding: { kind: 'bound', recorded: makeBoundSession('codex', THREAD_ID, scene.seat) },
        liveProbe: async () => ({
          ok: true,
          thread: {
            id: THREAD_ID,
            status: { type: 'idle' },
            canAcceptDirectInput: true,
          },
        }),
        spawn: async () => {
          spawnCount += 1;
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );
    expect(spawnCount).toBe(1);
    expect(deliveredAttempt.outcome).toBe('delivered');
    if (deliveredAttempt.outcome === 'delivered') {
      expect(deliveredAttempt.adapterOutcome).toBe('enqueue');
      expect(deliveredAttempt.readReceiptVerified).toBe(false);
      expect(deliveredAttempt.walkAttempt.outcome).toBe('delivered');
      expect(deliveredAttempt.walkAttempt.receipt).toEqual({ kind: 'maybe-consumed' });
    }

    // 3. Only when verifyReadReceipt confirms a verified <id>.read.json does outcome become 'read'.
    const readAttempt = await deliverRuntimeRelayRoute(
      {
        route: 'native',
        runtime: 'codex',
        copy,
        root: scene.root,
        home: scene.home,
        session: SESSION,
        seat: scene.seat,
        sender: { seat: 'lead', team: 'acme' },
      },
      { id: MESSAGE_ID, record: scene.recordText, pointer: scene.pointer },
      {
        now: () => NOW,
        sessionBinding: { kind: 'bound', recorded: makeBoundSession('codex', THREAD_ID, scene.seat) },
        spawn: async () => ({ status: 0, stdout: '', stderr: '' }),
        verifyReadReceipt: () => true,
      },
    );
    expect(readAttempt.outcome).toBe('read');
    if (readAttempt.outcome === 'read') {
      expect(readAttempt.readReceiptVerified).toBe(true);
    }

    // 4. Durable copy route returns 'held', never 'delivered' or 'read'.
    const heldAttempt = await deliverRuntimeRelayRoute(
      { route: 'durable-copy', copy },
      { id: MESSAGE_ID, record: scene.recordText },
      { now: () => NOW },
    );
    expect(heldAttempt.outcome).toBe('held');
    if (heldAttempt.outcome === 'held') {
      expect(heldAttempt.adapterOutcome).toBe('held');
      expect(heldAttempt.readReceiptVerified).toBe(false);
      expect(heldAttempt.walkAttempt.outcome).toBe('held');
      expect(heldAttempt.walkAttempt.receipt).toEqual({ kind: 'stored', id: MESSAGE_ID });
    }
  });
});

describe('walkRuntimeRelayRoutes binding owner addendum scenes', () => {
  test('socket killed mid-send reaches next route (headless-resume) exactly once with both attempts recorded and receiver deduplication', async () => {
    const scene = makeScene('gemini');
    const copy = { dir: scene.dropDir, name: MESSAGE_ID };
    const socketPath = join(scene.sockets, '222.sock');
    writeFileSync(socketPath, '');

    const loaded = loadTeamFile(scene.root, { home: scene.home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const caller: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: SESSION };
    const recipient: CanonicalRecipient = {
      team: 'acme',
      seat: scene.seat,
      toId: 'agt_123456789abc',
      session: SESSION,
      root: scene.root,
    };
    const fallbackWalk = beginFallbackWalk({
      caller,
      team: loaded.team,
      root: scene.root,
      home: scene.home,
      now: () => NOW,
      recipient,
      messageId: MESSAGE_ID,
      record: scene.recordText,
    });

    let dialCalls = 0;
    let copyExistedAtDial = false;
    const spawnedCalls: Array<{ binary: string; args: readonly string[] }> = [];

    const walkResult = await walkRuntimeRelayRoutes({
      routes: [
        {
          route: 'socket',
          runtime: 'claude-code',
          socket: socketPath,
          copy,
        },
        {
          route: 'headless-resume',
          runtime: 'gemini',
          copy,
          root: scene.root,
          home: scene.home,
          session: SESSION,
          seat: scene.seat,
          sender: { seat: 'lead', team: 'acme' },
        },
        {
          route: 'durable-copy',
          copy,
        },
      ],
      message: {
        id: MESSAGE_ID,
        record: scene.recordText,
        frame: scene.frame,
        pointer: scene.pointer,
      },
      fallbackWalk,
      options: {
        now: () => NOW,
        crossSessionInbound: 'accept',
        dial: async () => {
          dialCalls += 1;
          copyExistedAtDial = existsSync(join(scene.dropDir, MESSAGE_ID));
          return {
            ok: false,
            reason: 'the session closed the connection before it took the frame',
          };
        },
        spawn: async (binary, args) => {
          spawnedCalls.push({ binary, args });
          return { status: 0, stdout: 'resumed\n', stderr: '' };
        },
      },
    });

    // 1. Signed durable copy existed before the first route dialed, and only one record file exists.
    expect(copyExistedAtDial).toBe(true);
    expect(dialCalls).toBe(1);
    expect(spawnedCalls).toHaveLength(1);
    expect(spawnedCalls[0]?.binary).toBe('gemini');
    expect(spawnedCalls[0]?.args).toEqual([
      '--approval-mode',
      'yolo',
      '--resume',
      SESSION_ID,
      '-p',
      scene.pointer,
    ]);

    // 2. Walk succeeded on headless-resume (and stopped before durable-copy); transport is delivered, not read.
    expect(walkResult.outcome).toBe('delivered');
    expect(walkResult.deliveredRoute).toBe('headless-resume');
    expect(walkResult.readReceiptVerified).toBe(false);
    expect(walkResult.attempts).toHaveLength(2);
    expect(walkResult.attempts[0]?.route).toBe('socket');
    expect(walkResult.attempts[0]?.outcome).toBe('refused');
    if (walkResult.attempts[0]?.outcome === 'refused') {
      expect(walkResult.attempts[0]?.ambiguousConsumption).toBe(true);
      expect(walkResult.attempts[0]?.walkAttempt.receipt).toEqual({ kind: 'maybe-consumed' });
    }
    expect(walkResult.attempts[1]?.route).toBe('headless-resume');
    expect(walkResult.attempts[1]?.outcome).toBe('delivered');

    // 3. Both attempts are recorded in the FallbackMarker and the durable attempt ledger with the same message ID.
    const marker = JSON.parse(readFileSync(markerPathOf(recipient, MESSAGE_ID), 'utf8')) as FallbackMarker;
    expect(marker.status).toBe('delivered');
    expect(marker.messageId).toBe(MESSAGE_ID);
    expect(
      marker.attempts.map((a) => ({ route: a.route, outcome: a.outcome, receipt: a.receipt })),
    ).toEqual([
      { route: 'socket', outcome: 'unreachable', receipt: { kind: 'maybe-consumed' } },
      { route: 'headless-resume', outcome: 'delivered', receipt: { kind: 'maybe-consumed' } },
    ]);

    const ledgerPath = join(
      dirname(historyPath('acme', scene.root, scene.home)),
      attemptLedgerFileName(recipient, MESSAGE_ID),
    );
    const ledgerLines = readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { route: string; outcome: string; messageId: string });
    expect(ledgerLines).toEqual([
      expect.objectContaining({ route: 'socket', outcome: 'unreachable', messageId: MESSAGE_ID }),
      expect.objectContaining({
        route: 'headless-resume',
        outcome: 'delivered',
        messageId: MESSAGE_ID,
      }),
    ]);

    // 4. Receiver deduplication across ambiguous first receipt + second delivery: `readMessage` serves once
    //    and writes the signed `<id>.read.json` receipt; a second read of the same ID is rejected as already-served.
    const inboxTarget = {
      dropDir: scene.dropDir,
      root: scene.root,
      seat: scene.seat,
      session: SESSION,
    };
    const firstRead = readMessage(inboxTarget, MESSAGE_ID, scene.home);
    expect(firstRead.ok).toBe(true);
    const receiptPath = join(scene.dropDir, `${MESSAGE_ID}.read.json`);
    expect(existsSync(receiptPath)).toBe(true);
    expect(
      verifyReceipt(
        JSON.parse(readFileSync(receiptPath, 'utf8')),
        messageKeyOf(scene.home),
      ),
    ).toBe(true);

    const secondRead = readMessage(inboxTarget, MESSAGE_ID, scene.home);
    expect(secondRead).toEqual({
      ok: false,
      reason: `message ${JSON.stringify(MESSAGE_ID)} was already served in this inbox`,
      served: 'already-served',
    });
  });

  test('all live routes failing leaves durable copy held, emits one immediate message.held event, and fires delayed main escalation once', async () => {
    const scene = makeScene('codex');
    const copy = { dir: scene.dropDir, name: MESSAGE_ID };
    const socketPath = join(scene.sockets, '222.sock');
    writeFileSync(socketPath, '');

    const loaded = loadTeamFile(scene.root, { home: scene.home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const caller: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: SESSION };
    const recipient: CanonicalRecipient = {
      team: 'acme',
      seat: scene.seat,
      toId: 'agt_123456789abc',
      session: SESSION,
      root: scene.root,
    };
    const fallbackWalk = beginFallbackWalk({
      caller,
      team: loaded.team,
      root: scene.root,
      home: scene.home,
      now: () => NOW,
      recipient,
      messageId: MESSAGE_ID,
      record: scene.recordText,
    });

    const walkResult = await walkRuntimeRelayRoutes({
      routes: [
        {
          route: 'socket',
          runtime: 'claude-code',
          socket: socketPath,
          copy,
        },
        {
          route: 'native',
          runtime: 'codex',
          copy,
          root: scene.root,
          home: scene.home,
          session: SESSION,
          seat: scene.seat,
          sender: { seat: 'lead', team: 'acme' },
        },
        {
          route: 'durable-copy',
          copy,
        },
      ],
      message: {
        id: MESSAGE_ID,
        record: scene.recordText,
        frame: scene.frame,
        pointer: scene.pointer,
      },
      fallbackWalk,
      options: {
        now: () => NOW,
        crossSessionInbound: 'accept',
        dial: async () => ({
          ok: false,
          reason: 'nothing is listening there (the connection was refused)',
        }),
        sessionBinding: { kind: 'bound', recorded: makeBoundSession('codex', THREAD_ID, scene.seat) },
        spawn: async () => ({
          status: 1,
          stdout: '',
          stderr: 'codex daemon unreachable\n',
        }),
      },
    });

    expect(walkResult.outcome).toBe('held');
    expect(walkResult.deliveredRoute).toBeNull();
    expect(walkResult.readReceiptVerified).toBe(false);
    expect(walkResult.attempts.map((a) => ({ route: a.route, outcome: a.outcome }))).toEqual([
      { route: 'socket', outcome: 'refused' },
      { route: 'native', outcome: 'refused' },
      { route: 'durable-copy', outcome: 'held' },
    ]);

    // Exactly one record file + fallback marker in dropDir.
    expect(readdirSync(scene.dropDir).sort()).toEqual([
      MESSAGE_ID,
      `${MESSAGE_ID}.fallback.json`,
    ]);

    const dueAt = new Date(NOW.getTime() + DELIVERY_ESCALATION_SECONDS * 1000).toISOString();
    const marker = JSON.parse(readFileSync(markerPathOf(recipient, MESSAGE_ID), 'utf8')) as FallbackMarker;
    expect(marker).toMatchObject({
      format: 1,
      messageId: MESSAGE_ID,
      status: 'all-failed',
      allFailedAt: NOW.toISOString(),
      dueAt,
    });
    expect(marker.attempts.map((a) => ({ route: a.route, outcome: a.outcome }))).toEqual([
      { route: 'socket', outcome: 'unreachable' },
      { route: 'native', outcome: 'unreachable' },
    ]);

    // Immediate message.held event emitted once.
    const eventsBefore = readEvents('acme', scene.root, scene.home);
    expect(eventsBefore.ok).toBe(true);
    if (!eventsBefore.ok) return;
    const allFailedId = allFailedRecordId(recipient, MESSAGE_ID);
    expect(
      eventsBefore.events.filter((e) => e.payload.record_id === allFailedId),
    ).toHaveLength(1);

    // Delayed main-orchestrator escalation fires once at dueAt and is idempotent on repeat passes.
    const orchestrator = { seat: 'orchestrator', team: 'acme', root: scene.root, session: SESSION };
    const escCtx = {
      team: loaded.team,
      root: scene.root,
      home: scene.home,
      now: () => new Date(dueAt),
      orchestrator,
    };
    const firstEsc = escalateDue(escCtx, { at: new Date(dueAt) });
    expect(firstEsc.escalated).toHaveLength(1);
    expect(firstEsc.escalated[0]?.event.payload.record_id).toBe(
      escalatedRecordId(recipient, MESSAGE_ID),
    );
    const mailboxPath = join(
      scene.root,
      '.agents',
      'messages',
      'orchestrator',
      `${escalationMailboxId(recipient, MESSAGE_ID)}.json`,
    );
    expect(firstEsc.escalated[0]?.mailbox).toBe(mailboxPath);
    expect(existsSync(mailboxPath)).toBe(true);

    const secondEsc = escalateDue(escCtx, { at: new Date(Date.parse(dueAt) + 5_000) });
    expect(secondEsc.escalated).toHaveLength(0);
  });

  test('socket killed mid-send falls back to Codex native with live thread/read probe, and conflicting holder refuses before any attempt', async () => {
    const scene = makeScene('codex');
    const copy = { dir: scene.dropDir, name: MESSAGE_ID };
    const socketPath = join(scene.sockets, '222.sock');
    writeFileSync(socketPath, '');

    // First verify that a conflicting holder at `copy` refuses before any dial or spawn.
    mkdirSync(scene.dropDir, { recursive: true });
    writeFileSync(join(scene.dropDir, MESSAGE_ID), 'foreign conflicting record\n');
    let conflictDials = 0;
    let conflictSpawns = 0;
    const conflictWalk = await walkRuntimeRelayRoutes({
      routes: [
        { route: 'socket', runtime: 'claude-code', socket: socketPath, copy },
        {
          route: 'native',
          runtime: 'codex',
          copy,
          root: scene.root,
          home: scene.home,
          session: SESSION,
          seat: scene.seat,
          sender: { seat: 'lead', team: 'acme' },
        },
      ],
      message: {
        id: MESSAGE_ID,
        record: scene.recordText,
        frame: scene.frame,
        pointer: scene.pointer,
      },
      options: {
        now: () => NOW,
        crossSessionInbound: 'accept',
        dial: async () => {
          conflictDials += 1;
          return { ok: true };
        },
        spawn: async () => {
          conflictSpawns += 1;
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    });
    expect(conflictWalk.outcome).toBe('refused');
    expect(conflictWalk.attempts).toHaveLength(0);
    expect(conflictDials).toBe(0);
    expect(conflictSpawns).toBe(0);
    expect(readFileSync(join(scene.dropDir, MESSAGE_ID), 'utf8')).toBe('foreign conflicting record\n');

    // Remove the foreign file and run the mid-send socket death -> Codex native fallback scene.
    rmSync(join(scene.dropDir, MESSAGE_ID));

    const loaded = loadTeamFile(scene.root, { home: scene.home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const caller: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: SESSION };
    const recipient: CanonicalRecipient = {
      team: 'acme',
      seat: scene.seat,
      toId: 'agt_123456789abc',
      session: SESSION,
      root: scene.root,
    };
    const fallbackWalk = beginFallbackWalk({
      caller,
      team: loaded.team,
      root: scene.root,
      home: scene.home,
      now: () => NOW,
      recipient,
      messageId: MESSAGE_ID,
      record: scene.recordText,
    });

    const codexSpawns: Array<{ binary: string; args: readonly string[] }> = [];
    const walkResult = await walkRuntimeRelayRoutes({
      routes: [
        { route: 'socket', runtime: 'claude-code', socket: socketPath, copy },
        {
          route: 'native',
          runtime: 'codex',
          copy,
          root: scene.root,
          home: scene.home,
          session: SESSION,
          seat: scene.seat,
          sender: { seat: 'lead', team: 'acme' },
        },
        { route: 'durable-copy', copy },
      ],
      message: {
        id: MESSAGE_ID,
        record: scene.recordText,
        frame: scene.frame,
        pointer: scene.pointer,
      },
      fallbackWalk,
      options: {
        now: () => NOW,
        crossSessionInbound: 'accept',
        dial: async () => ({
          ok: false,
          reason: 'the session closed the connection before it took the frame',
        }),
        sessionBinding: { kind: 'bound', recorded: makeBoundSession('codex', THREAD_ID, scene.seat) },
        liveProbe: async () => ({
          ok: true,
          thread: {
            id: THREAD_ID,
            status: { type: 'idle' },
            canAcceptDirectInput: true,
          },
        }),
        spawn: async (binary, args) => {
          codexSpawns.push({ binary, args });
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    });

    expect(walkResult.outcome).toBe('delivered');
    expect(walkResult.deliveredRoute).toBe('native');
    expect(walkResult.readReceiptVerified).toBe(false);
    expect(codexSpawns).toHaveLength(1);
    expect(codexSpawns[0]?.binary).toBe('codex');
    expect(codexSpawns[0]?.args).toContain('--thread');
    expect(codexSpawns[0]?.args).toContain(THREAD_ID);
    expect(codexSpawns[0]?.args).toContain(scene.pointer);
    expect(walkResult.attempts.map((a) => ({ route: a.route, outcome: a.outcome }))).toEqual([
      { route: 'socket', outcome: 'refused' },
      { route: 'native', outcome: 'delivered' },
    ]);
  });

  test('skips would-hold routes (socket hold + Codex active thread) without dialing or spawning and delivers via Cursor headless-resume', async () => {
    const scene = makeScene('cursor');
    const copy = { dir: scene.dropDir, name: MESSAGE_ID };
    const socketPath = join(scene.sockets, '222.sock');
    writeFileSync(socketPath, '');

    let dialCount = 0;
    const spawned: Array<{ binary: string; args: readonly string[] }> = [];

    const walkResult = await walkRuntimeRelayRoutes({
      routes: [
        { route: 'socket', runtime: 'claude-code', socket: socketPath, copy },
        {
          route: 'native',
          runtime: 'codex',
          copy,
          root: scene.root,
          home: scene.home,
          session: SESSION,
          seat: scene.seat,
          sender: { seat: 'lead', team: 'acme' },
        },
        {
          route: 'headless-resume',
          runtime: 'cursor',
          copy,
          root: scene.root,
          home: scene.home,
          session: SESSION,
          seat: scene.seat,
          sender: { seat: 'lead', team: 'acme' },
        },
      ],
      message: {
        id: MESSAGE_ID,
        record: scene.recordText,
        frame: scene.frame,
        pointer: scene.pointer,
      },
      options: {
        now: () => NOW,
        crossSessionInbound: 'hold',
        dial: async () => {
          dialCount += 1;
          return { ok: true };
        },
        perRouteOptions: {
          native: {
            sessionBinding: { kind: 'bound', recorded: makeBoundSession('codex', THREAD_ID, scene.seat) },
            liveProbe: async () => ({
              ok: true,
              thread: {
                id: THREAD_ID,
                status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
                canAcceptDirectInput: false,
              },
            }),
          },
          'headless-resume': {
            sessionBinding: { kind: 'bound', recorded: makeBoundSession('cursor', SESSION_ID, scene.seat) },
          },
        },
        spawn: async (binary, args) => {
          spawned.push({ binary, args });
          return { status: 0, stdout: 'cursor resumed\n', stderr: '' };
        },
      },
    });

    expect(dialCount).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.binary).toBe('cursor-agent');
    expect(spawned[0]?.args).toEqual([
      '--force',
      '--sandbox',
      'disabled',
      '--approve-mcps',
      '--trust',
      '--resume',
      SESSION_ID,
      '-p',
      scene.pointer,
    ]);
    expect(walkResult.outcome).toBe('delivered');
    expect(walkResult.deliveredRoute).toBe('headless-resume');
    expect(walkResult.attempts).toHaveLength(3);
    if (walkResult.attempts[0]?.outcome === 'refused') {
      expect(walkResult.attempts[0]?.wouldHold).toBe(true);
    }
    if (walkResult.attempts[1]?.outcome === 'refused') {
      expect(walkResult.attempts[1]?.wouldHold).toBe(true);
    }
    expect(walkResult.attempts[2]?.outcome).toBe('delivered');
  });
});
