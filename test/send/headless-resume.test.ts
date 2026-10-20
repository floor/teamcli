// Synthetic fixture tests for the Gemini (`0.64.0`) and Cursor (`2026.10.16`) `headless-resume`
// adapter and `runSend` / `sendDirect` integration.
//
// Never inspects or touches owner CLI homes (`~/.gemini`, `~/.cursor`, `~/.claude`, `~/.codex`,
// `~/.grok`) or live sessions.
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSend, sendDirect, type SendHost } from '../../src/commands/send.ts';
import { entitiesPath } from '../../src/entities.ts';
import { resolveLobby } from '../../src/lobby/gate.ts';
import { registerAgent } from '../../src/registry/agents.ts';
import type { RecordedSeatSession } from '../../src/registry/resume.ts';
import { teamIdOf } from '../../src/registry/teams.ts';
import {
  buildHeadlessResumeArgs,
  CURSOR_HEADLESS_RESUME_ADAPTER,
  deliverHeadlessResumeRoute,
  GEMINI_HEADLESS_RESUME_ADAPTER,
  HEADLESS_RESUME_ADAPTERS,
  HEADLESS_RESUME_CLIS,
  HEADLESS_RESUME_ROUTE,
  HEADLESS_RESUME_TIMEOUT_MS,
  HEADLESS_RESUME_UNAVAILABLE_REASON,
  headlessResumeAdapterFor,
  headlessResumeBinaryFor,
  headlessResumeCapabilities,
  headlessResumePushAdapter,
  isHeadlessResumeCli,
  probeHeadlessResumeRoute,
  resolveHeadlessResumeAttemptTimeoutMs,
  type HeadlessResumeCli,
  type HeadlessResumeSpawn,
} from '../../src/send/headless-resume.ts';
import { readHistory } from '../../src/send/history.ts';
import { pushPointer } from '../../src/send/push.ts';
import { RUNTIME_PUSH_ADAPTERS } from '../../src/send/push-adapters.ts';
import { signReceiptPayload, writeReceipt } from '../../src/send/record.ts';
import { recordBody, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-20T09:00:00.000Z');
const MESSAGE_ID = '22222222-3333-4444-8555-666666666666';
const SESSION_ID = 'ses_gemini_cursor_019a0000';
const SESSION = 'teamcli';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeScratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-resume-test-')));
  tempDirs.push(dir);
  return dir;
}

function makeBoundSession(
  cli: HeadlessResumeCli,
  sessionId = SESSION_ID,
  seat = 'builder-3',
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
  cli: HeadlessResumeCli;
};

function makeScene(
  cli: HeadlessResumeCli,
  options: {
    seat?: string;
    sessionId?: string | null;
    stateSessionId?: string | null;
    deliveryOrder?: readonly string[];
  } = {},
): Scene {
  const seat = options.seat ?? (cli === 'gemini' ? 'gemini-seat' : 'cursor-seat');
  const sessionId = options.sessionId === undefined ? SESSION_ID : options.sessionId;
  const stateSessionId =
    options.stateSessionId === undefined ? sessionId : options.stateSessionId;
  const order = options.deliveryOrder ?? ['headless-resume', 'drop'];

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

  const launch = cli === 'gemini' ? 'gemini -m gemini-3-pro' : 'cursor-agent --model composer-2';
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
delivery_order: [${order.join(', ')}]
`,
  );

  writeFileSync(
    join(dir, 'team.state.json'),
    `${JSON.stringify({
      format: 1,
      sessions: {
        [SESSION]: {
          seats: {
            [seat]: {
              id: 'seat_123456789abc',
              stage: 'ready',
              pane: 'w1:p2',
              ...(stateSessionId === null ? {} : { agent_session: stateSessionId }),
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
      ...(sessionId === null ? {} : { agent_session: sessionId }),
      pane: 'w1:p2',
      address: null,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });

  return { base, root, dir, home, sockets, dropDir, seat, cli };
}

function makeHost(
  scene: Scene,
  overrides: Partial<SendHost> = {},
): SendHost {
  return {
    agents: () => [
      { name: 'lead', pane: 'w1:p1', cli: 'claude' },
      { name: scene.seat, pane: 'w1:p2', cli: scene.cli },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: scene.sockets,
    deliver: async () => ({ ok: false, reason: 'no socket' }),
    native: {
      typeText: () => true,
      pressEnter: () => true,
      status: () => 'idle',
      wait: async () => {},
      paneText: () => '',
      sendKey: () => true,
      foregroundCwd: () => scene.root,
    },
    now: () => NOW,
    sendId: () => MESSAGE_ID,
    home: scene.home,
    inboxGraceMs: 0,
    ...overrides,
  };
}

describe('headless-resume capabilities and command construction', () => {
  test('supports gemini (0.64.0) and cursor (2026.10.16) only, leaving RUNTIME_PUSH_ADAPTERS intact', () => {
    expect(HEADLESS_RESUME_ROUTE).toBe('headless-resume');
    expect(HEADLESS_RESUME_CLIS).toEqual(['gemini', 'cursor']);
    expect(isHeadlessResumeCli('gemini')).toBe(true);
    expect(isHeadlessResumeCli('cursor')).toBe(true);
    expect(isHeadlessResumeCli('claude-code')).toBe(false);
    expect(isHeadlessResumeCli('codex')).toBe(false);
    expect(isHeadlessResumeCli('grok')).toBe(false);

    expect(headlessResumeBinaryFor('gemini')).toBe('gemini');
    expect(headlessResumeBinaryFor('cursor')).toBe('cursor-agent');

    expect(HEADLESS_RESUME_ADAPTERS).toEqual([
      GEMINI_HEADLESS_RESUME_ADAPTER,
      CURSOR_HEADLESS_RESUME_ADAPTER,
    ]);
    expect(headlessResumeAdapterFor('gemini')).toBe(GEMINI_HEADLESS_RESUME_ADAPTER);
    expect(headlessResumeAdapterFor('cursor')).toBe(CURSOR_HEADLESS_RESUME_ADAPTER);
    expect(headlessResumeAdapterFor('claude-code')).toBeNull();
    // Native push registry stays Codex-only.
    expect(RUNTIME_PUSH_ADAPTERS.map((a) => a.clis)).toEqual([['codex']]);
  });

  test('builds measured non-interactive resume argv for gemini and cursor', () => {
    const pointer = pushPointer(MESSAGE_ID, { seat: 'owner', team: 'acme' })!;
    expect(buildHeadlessResumeArgs('gemini', SESSION_ID, pointer)).toEqual([
      '--approval-mode',
      'yolo',
      '--resume',
      SESSION_ID,
      '-p',
      pointer,
    ]);
    expect(buildHeadlessResumeArgs('cursor', SESSION_ID, pointer)).toEqual([
      '--force',
      '--sandbox',
      'disabled',
      '--approve-mcps',
      '--trust',
      '--resume',
      SESSION_ID,
      '-p',
      pointer,
    ]);

    const caps = headlessResumeCapabilities();
    expect(caps.route).toBe('headless-resume');
    expect(caps.timeoutMs).toBe(15_000);
    expect(caps.ack).toBe(false);
    expect(caps.proof).toBe('process-exit-0-only');
    expect(caps.profiles.gemini.command).toEqual([
      'gemini',
      '--approval-mode',
      'yolo',
      '--resume',
      '<agent_session>',
      '-p',
      '<pointer>',
    ]);
    expect(caps.profiles.cursor.command).toEqual([
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
  });
});

describe('probeHeadlessResumeRoute session binding and pointer guards', () => {
  test('verifies bound recordedSeatSession from synthetic team.state.json + agent registry', () => {
    for (const cli of ['gemini', 'cursor'] as const) {
      const scene = makeScene(cli);
      const outcome = probeHeadlessResumeRoute({
        cli,
        root: scene.root,
        home: scene.home,
        session: SESSION,
        seat: scene.seat,
        id: MESSAGE_ID,
        sender: { seat: 'owner', team: 'acme' },
      });
      expect(outcome.status).toBe('ready');
      if (outcome.status !== 'ready') continue;
      expect(outcome.cli).toBe(cli);
      expect(outcome.sessionId).toBe(SESSION_ID);
      expect(outcome.binary).toBe(cli === 'gemini' ? 'gemini' : 'cursor-agent');
      expect(outcome.pointer).toBe(
        `From owner@acme: New team message ${MESSAGE_ID}: call inbox_read({"id":"${MESSAGE_ID}"})`,
      );
    }
  });

  test('fails closed on unsupported CLI, unbound/mismatched session, flag token, "latest", or invalid pointer', () => {
    const scene = makeScene('gemini');

    // Unsupported CLI
    expect(
      probeHeadlessResumeRoute({
        cli: 'claude-code',
        root: scene.root,
        home: scene.home,
        session: SESSION,
        seat: scene.seat,
        id: MESSAGE_ID,
        sender: { seat: 'owner', team: 'acme' },
      }),
    ).toEqual({
      status: 'unsupported',
      reason: HEADLESS_RESUME_UNAVAILABLE_REASON,
    });

    // Mismatched caller agentSession
    expect(
      probeHeadlessResumeRoute({
        cli: 'gemini',
        root: scene.root,
        home: scene.home,
        session: SESSION,
        seat: scene.seat,
        id: MESSAGE_ID,
        sender: { seat: 'owner', team: 'acme' },
        agentSession: 'ses_different',
      }),
    ).toEqual({
      status: 'unavailable',
      reason: 'the seat state and the agent record name different sessions',
    });

    // "latest" session token is rejected so gemini --resume never guesses the latest conversation
    expect(
      probeHeadlessResumeRoute({
        cli: 'gemini',
        root: scene.root,
        home: scene.home,
        session: SESSION,
        seat: scene.seat,
        id: MESSAGE_ID,
        sender: { seat: 'owner', team: 'acme' },
        sessionBinding: {
          kind: 'bound',
          recorded: makeBoundSession('gemini', 'latest', scene.seat),
        },
      }),
    ).toEqual({
      status: 'unavailable',
      reason: 'the recorded runtime session is not a valid session id',
    });

    // Flag-like session token is rejected
    expect(
      probeHeadlessResumeRoute({
        cli: 'cursor',
        root: scene.root,
        home: scene.home,
        session: SESSION,
        seat: scene.seat,
        id: MESSAGE_ID,
        sender: { seat: 'owner', team: 'acme' },
        sessionBinding: {
          kind: 'bound',
          recorded: makeBoundSession('cursor', '--help', scene.seat),
        },
      }),
    ).toEqual({
      status: 'unavailable',
      reason: 'the recorded runtime session is not a valid session id',
    });

    // Multi-line pointer is refused
    expect(
      probeHeadlessResumeRoute({
        cli: 'gemini',
        root: scene.root,
        home: scene.home,
        session: SESSION,
        seat: scene.seat,
        id: MESSAGE_ID,
        sender: { seat: 'owner', team: 'acme' },
        pointer: 'line1\nline2',
      }),
    ).toEqual({
      status: 'refused',
      reason: 'the runtime pointer is not a valid single line',
    });
  });
});

describe('deliverHeadlessResumeRoute budget clamping and deadline accounting', () => {
  test('clamps timeoutMs override to signed deliveryTimeout and deducts routeStartedAt elapsed time', async () => {
    const scene = makeScene('gemini');
    let clockMs = NOW.getTime();
    let capturedTimeoutMs = -1;
    let capturedBinary = '';
    let capturedArgs: readonly string[] = [];

    const spawn: HeadlessResumeSpawn = (binary, args, options) => {
      capturedBinary = binary;
      capturedArgs = args;
      capturedTimeoutMs = options.timeoutMs;
      return { status: 0, stdout: 'ok\n', stderr: '' };
    };

    const routeStartedAt = clockMs;
    clockMs += 1_250; // 1250ms spent in caller route preparation before deliverHeadlessResumeRoute

    const attempt = await deliverHeadlessResumeRoute(
      {
        route: 'headless-resume',
        cli: 'gemini',
        copy: { dir: scene.dropDir, name: MESSAGE_ID },
        root: scene.root,
        home: scene.home,
        session: SESSION,
        seat: scene.seat,
        sender: { seat: 'owner', team: 'acme' },
      },
      { id: MESSAGE_ID, record: '{"signed":true}\n' },
      {
        now: () => new Date(clockMs),
        startedAt: routeStartedAt,
        routeStartedAt,
        deliveryTimeout: {
          ok: true,
          budgets: { socket: 15, 'mcp-inbox': 15, typed: 15, native: 8 },
          level: 'team',
        },
        // Override tries to lengthen to 20s, must be clamped to 8s (8000ms) minus 1250ms = 6750ms
        timeoutMs: 20_000,
        spawn,
      },
    );

    expect(attempt.outcome).toBe('enqueue');
    expect(capturedBinary).toBe('gemini');
    expect(capturedArgs[0]).toBe('--approval-mode');
    expect(capturedArgs[2]).toBe('--resume');
    expect(capturedArgs[3]).toBe(SESSION_ID);
    expect(capturedTimeoutMs).toBe(6_750);
    expect(attempt.walkAttempt.route).toBe('headless-resume');
    expect(attempt.walkAttempt.outcome).toBe('delivered');
    expect(attempt.walkAttempt.liveRoutesRemain).toBe(false);
    expect(attempt.walkAttempt.receipt).toEqual({ kind: 'maybe-consumed' });
    expect(readFileSync(join(scene.dropDir, MESSAGE_ID), 'utf8')).toBe('{"signed":true}\n');
  });

  test('aborts before spawn when preparation exhausts the attempt budget or routeStartedAt is invalid', async () => {
    const scene = makeScene('cursor');
    let spawns = 0;
    const spawn: HeadlessResumeSpawn = () => {
      spawns += 1;
      return { status: 0, stdout: '', stderr: '' };
    };

    const exhausted = await deliverHeadlessResumeRoute(
      {
        route: 'headless-resume',
        cli: 'cursor',
        copy: { dir: scene.dropDir, name: MESSAGE_ID },
        root: scene.root,
        home: scene.home,
        session: SESSION,
        seat: scene.seat,
        sender: { seat: 'owner', team: 'acme' },
      },
      { id: MESSAGE_ID, record: '{"signed":true}\n' },
      {
        now: () => new Date(NOW.getTime() + 5_000),
        startedAt: NOW.getTime(),
        routeStartedAt: NOW.getTime(),
        deliveryTimeout: {
          ok: true,
          budgets: { socket: 15, 'mcp-inbox': 15, typed: 15, native: 5 },
          level: 'team',
        },
        spawn,
      },
    );

    expect(spawns).toBe(0);
    expect(exhausted.outcome).toBe('unreachable');
    if (exhausted.outcome !== 'enqueue') {
      expect(exhausted.timedOut).toBe(true);
      expect(exhausted.walkAttempt.outcome).toBe('timeout');
    }

    const futureStart = await deliverHeadlessResumeRoute(
      {
        route: 'headless-resume',
        cli: 'cursor',
        copy: { dir: scene.dropDir, name: '33333333-4444-4555-8666-777777777777' },
        root: scene.root,
        home: scene.home,
        session: SESSION,
        seat: scene.seat,
        sender: { seat: 'owner', team: 'acme' },
      },
      { id: '33333333-4444-4555-8666-777777777777', record: '{"signed":true}\n' },
      {
        now: () => NOW,
        routeStartedAt: NOW.getTime() + 1_000,
        spawn,
      },
    );
    expect(spawns).toBe(0);
    expect(futureStart.outcome).toBe('unsupported');
  });

  test('resolveHeadlessResumeAttemptTimeoutMs fails closed on invalid signed budget', () => {
    expect(resolveHeadlessResumeAttemptTimeoutMs()).toEqual({
      ok: true,
      timeoutMs: HEADLESS_RESUME_TIMEOUT_MS,
      attemptSeconds: 15,
    });
    expect(
      resolveHeadlessResumeAttemptTimeoutMs({ ok: false, why: 'tampered policy' }),
    ).toEqual({
      ok: false,
      why: 'tampered policy',
    });
  });

  test('headlessResumePushAdapter classifies unknown option as unsupported and exit!=0 as unreachable', async () => {
    const scene = makeScene('cursor');
    const unsupportedAdapter = headlessResumePushAdapter({
      cli: 'cursor',
      spawn: () => ({ status: 2, stdout: '', stderr: 'error: unknown option --resume\n' }),
    });
    const unsupported = await unsupportedAdapter.push({
      root: scene.root,
      session: SESSION,
      seat: scene.seat,
      id: MESSAGE_ID,
      sender: { seat: 'owner', team: 'acme' },
      agentSession: SESSION_ID,
      pointer: pushPointer(MESSAGE_ID, { seat: 'owner', team: 'acme' })!,
      home: scene.home,
    });
    expect(unsupported.kind).toBe('unsupported');

    const unreachableAdapter = headlessResumePushAdapter({
      cli: 'cursor',
      spawn: () => ({ status: 1, stdout: '', stderr: 'session locked by another process\n' }),
    });
    const unreachable = await unreachableAdapter.push({
      root: scene.root,
      session: SESSION,
      seat: scene.seat,
      id: MESSAGE_ID,
      sender: { seat: 'owner', team: 'acme' },
      agentSession: SESSION_ID,
      pointer: pushPointer(MESSAGE_ID, { seat: 'owner', team: 'acme' })!,
      home: scene.home,
    });
    expect(unreachable).toEqual({
      kind: 'unreachable',
      reason: 'cursor-agent headless resume refused (session locked by another process)',
    });
  });
});

describe('runSend and sendDirect integration for Gemini and Cursor headless-resume', () => {
  test('delivers to a Gemini seat via headless-resume as sent (unconfirmed) and records history via headless-resume', async () => {
    const scene = makeScene('gemini');
    const calls: { binary: string; args: readonly string[]; cwd?: string }[] = [];
    const host = makeHost(scene, {
      headlessResumeSpawn: (binary, args, options) => {
        calls.push({ binary, args, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
        return { status: 0, stdout: 'resumed\n', stderr: '' };
      },
    });
    const io = testIo(scene.root, { kind: 'owner' });

    const code = await runSend([scene.seat, 'hello gemini'], io, host);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe(
      `team acme, session "${SESSION}"\n${scene.seat}: sent (unconfirmed) (headless-resume, 0 ms)\n`,
    );
    expect(calls).toEqual([
      {
        binary: 'gemini',
        args: [
          '--approval-mode',
          'yolo',
          '--resume',
          SESSION_ID,
          '-p',
          `From owner@${teamIdOf(scene.root)}: New team message ${MESSAGE_ID}: call inbox_read({"id":"${MESSAGE_ID}"})`,
        ],
        cwd: scene.root,
      },
    ]);
    expect(recordBody(join(scene.dropDir, MESSAGE_ID))).toContain('hello gemini');
    const history = readHistory('acme', scene.root, scene.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      to: scene.seat,
      id: MESSAGE_ID,
      outcome: 'sent (unconfirmed)',
      via: 'headless-resume',
    });
  });

  test('promotes a Cursor headless-resume send to delivered (read) when inbox_read writes a verified receipt', async () => {
    const scene = makeScene('cursor');
    const calls: { binary: string; args: readonly string[] }[] = [];
    const host = makeHost(scene, {
      inboxGraceMs: 25,
      headlessResumeSpawn: (binary, args) => {
        calls.push({ binary, args });
        const receipt = signReceiptPayload(
          {
            kind: 'receipt',
            status: 'read',
            id: MESSAGE_ID,
            to: scene.seat,
            root: scene.root,
            session: SESSION,
            at: NOW.toISOString(),
          },
          scene.home,
        );
        writeReceipt(scene.dropDir, receipt, scene.home);
        return { status: 0, stdout: 'read\n', stderr: '' };
      },
    });
    const io = testIo(scene.root, { kind: 'owner' });

    const code = await runSend([scene.seat, 'hello cursor', '--json'], io, host);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.binary).toBe('cursor-agent');
    expect(calls[0]?.args).toEqual([
      '--force',
      '--sandbox',
      'disabled',
      '--approve-mcps',
      '--trust',
      '--resume',
      SESSION_ID,
      '-p',
      `From owner@${teamIdOf(scene.root)}: New team message ${MESSAGE_ID}: call inbox_read({"id":"${MESSAGE_ID}"})`,
    ]);
    const doc = JSON.parse(io.out);
    expect(doc).toMatchObject({
      status: 'delivered (read)',
      channel: 'headless-resume',
      seat: scene.seat,
      ids: { sent: MESSAGE_ID, reply: null },
    });
    const history = readHistory('acme', scene.root, scene.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries[0]).toMatchObject({
      to: scene.seat,
      id: MESSAGE_ID,
      outcome: 'delivered (read)',
      via: 'headless-resume',
    });
  });

  test('falls back from headless-resume to drop when the seat has no bound session or the resume fails', async () => {
    const scene = makeScene('cursor', { stateSessionId: null });
    let spawns = 0;
    const host = makeHost(scene, {
      headlessResumeSpawn: () => {
        spawns += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const io = testIo(scene.root, { kind: 'owner' });

    const code = await runSend([scene.seat, 'fallback message'], io, host);

    expect(code).toBe(0);
    expect(spawns).toBe(0);
    expect(io.out).toBe(
      `team acme, session "${SESSION}"\n${scene.seat}: sent (unconfirmed) (drop, 0 ms)\n`,
    );
    const history = readHistory('acme', scene.root, scene.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      to: scene.seat,
      id: MESSAGE_ID,
      outcome: 'sent (unconfirmed)',
      via: 'drop',
      failed: [
        'headless-resume: no trusted runtime session is recorded for this seat (the seat state names no agent session)',
      ],
    });
    expect(readdirSync(scene.dropDir)).toContain(MESSAGE_ID);
  });

  test('dry-run names headless session resume for gemini and cursor, and keeps claude-code unwalkable', async () => {
    const scene = makeScene('gemini', { deliveryOrder: ['headless-resume', 'drop'] });
    const host = makeHost(scene);

    const geminiIo = testIo(scene.root, { kind: 'owner' });
    expect(await runSend([scene.seat, 'check', '--dry-run'], geminiIo, host)).toBe(0);
    expect(geminiIo.out).toBe(
      `team acme, session "${SESSION}"\n${scene.seat}: dry-run: gemini via its headless session resume, falling back to a 0600 drop file, with nothing typed into the pane; nothing was written\n`,
    );
    expect(existsSync(scene.dropDir)).toBe(false);

    const claudeHost = makeHost(scene, { delivery: { seat: ['headless-resume'] } });
    const claudeIo = testIo(scene.root, { kind: 'owner' });
    expect(await runSend(['lead', 'check', '--dry-run'], claudeIo, claudeHost)).toBe(0);
    expect(claudeIo.out).toBe(
      `team acme, session "${SESSION}"\nlead: dry-run: claude-code via no leg of its delivery order this build can walk; nothing was written\n`,
    );
  });

  test('sendDirect wakes a bound Gemini seat over headless-resume after skipping socket', async () => {
    const scene = makeScene('gemini', {
      deliveryOrder: ['socket', 'headless-resume', 'typed', 'drop'],
    });
    const calls: string[] = [];
    const host = makeHost(scene, {
      headlessResumeSpawn: (binary) => {
        calls.push(binary);
        return { status: 0, stdout: 'ok\n', stderr: '' };
      },
    });
    const io = testIo(scene.root, { kind: 'owner' });

    const run = await sendDirect(io, host, {
      seat: scene.seat,
      pane: 'w1:p2',
      cli: 'gemini',
      body: 'wake from watch',
    });

    expect(run.code).toBe(0);
    expect(calls).toEqual(['gemini']);
    expect(run.result).toEqual({
      outcome: 'delivered',
      route: 'headless-resume',
      id: MESSAGE_ID,
      record: join(scene.dropDir, MESSAGE_ID),
      reason: 'resumed gemini session headlessly; no read receipt yet',
    });
  });

  test('defaultHeadlessResumeSpawn runs a synthetic PATH binary with AGENT_UNATTENDED=1 without headlessResumeSpawn injection', async () => {
    const scene = makeScene('gemini', { deliveryOrder: ['headless-resume', 'drop'] });
    const binDir = join(scene.base, 'bin');
    const argvLog = join(scene.base, 'gemini-argv.log');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'gemini'),
      `#!/bin/sh
printf '%s\\n' "$AGENT_UNATTENDED" > "${argvLog}"
for arg in "$@"; do printf '%s\\n' "$arg" >> "${argvLog}"; done
exit 0
`,
      { mode: 0o755 },
    );

    const savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath ?? ''}`;
    try {
      const host = makeHost(scene);
      const io = testIo(scene.root, { kind: 'owner' });
      const code = await runSend([scene.seat, 'synthetic path binary'], io, host);
      expect(code).toBe(0);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }

    const lines = readFileSync(argvLog, 'utf8').trim().split('\n');
    expect(lines).toEqual([
      '1',
      '--approval-mode',
      'yolo',
      '--resume',
      SESSION_ID,
      '-p',
      `From owner@${teamIdOf(scene.root)}: New team message ${MESSAGE_ID}: call inbox_read({"id":"${MESSAGE_ID}"})`,
    ]);
  });
});
