import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import { sweepFallbackEscalations } from '../src/daemon/fallback-sweep.ts';
import {
  buildDaemonRelayTargets,
  deliverDaemonRelayRoute,
  handleDaemonRelaySend,
  probeDaemonRelayRoutes,
  selectDaemonRelayRoutes,
} from '../src/daemon/relay-routes.ts';
import { resolveScope, routeOf, type HostedRoute } from '../src/daemon/routes.ts';
import { entitiesPath } from '../src/entities.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { readMessage } from '../src/mcp/inbox.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { pushPointer } from '../src/send/push.ts';
import {
  RECORD_KIND,
  signReceiptPayload,
  signRecord,
  type RecordPayload,
  type SignedRecord,
} from '../src/send/record.ts';

const NOW = new Date('2026-10-20T10:30:00.000Z');
const SESSION = 'acme';
const THREAD_ID = '019a0000-1111-7222-8333-444455556666';
const GEMINI_SESSION = 'gem-session-019a0000';
const CURSOR_SESSION = 'cur-session-019a0000';

type Scene = {
  base: string;
  root: string;
  home: string;
  stateDir: string;
  route: HostedRoute;
  team: TeamFile;
  dropDir(seat: string): string;
};

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});

function createScene(options: {
  deliveryOrderYaml?: string;
  claudeInbound?: 'accept' | 'hold' | 'refuse' | null;
  claudeTeamInbound?: 'accept' | 'hold' | 'refuse' | null;
  claudeLaunch?: string;
  codexDaemonPolicy?: 'on' | 'off';
  stoppedSeat?: boolean;
} = {}): Scene {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-relay-routes-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  const stateDir = join(root, '.agents');
  const lobby = resolveLobby(home, { entity: 'floor' });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(entitiesPath(home)), { recursive: true });
  writeFileSync(entitiesPath(home), `floor:\n  roots:\n    - ${JSON.stringify(base)}\n`);
  execFileSync('git', ['init', '-q'], { cwd: root });

  const stoppedLine = options.stoppedSeat === true ? '\n    stopped: true' : '';
  const teamInboundWord =
    options.claudeTeamInbound === undefined ? 'accept' : options.claudeTeamInbound;
  const inboundLine =
    teamInboundWord === null ? '' : `\n    inbound: ${teamInboundWord}`;
  const launchLine = options.claudeLaunch ?? 'claude';
  const orderBlock = options.deliveryOrderYaml ?? '';

  const teamYaml = `format: 1
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
${orderBlock}seats:
  - role: orchestrator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: ${launchLine}${inboundLine}
    leads: true
  - role: builder
    name: worker-claude
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "2.1.295"
    launch: ${launchLine}${inboundLine}${stoppedLine}
  - role: builder
    name: worker-codex
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "0.161.0"
    launch: codex -m gpt-6.1-sol
  - role: builder
    name: worker-gemini
    cli: gemini
    vendor: google
    model: Gemini Argon
    version: "0.64.0"
    launch: gemini
    delivery_order: [headless-resume, drop]
  - role: builder
    name: worker-cursor
    cli: cursor
    vendor: xai
    model: Grok
    version: "2026.10.16"
    launch: cursor-agent${inboundLine}
    delivery_order: [headless-resume, drop]
  - role: builder
    name: worker-human
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "2.1.295"
    launch: claude
    human: true
`;
  writeFileSync(join(stateDir, 'team.yaml'), teamYaml, { mode: 0o600 });

  if (options.claudeInbound !== undefined && options.claudeInbound !== null) {
    const settingsPath = cliHookSettingsPath(stateDir, SESSION, 'worker-claude')!;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ crossSessionInbound: options.claudeInbound }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const declaredTime = new Date(NOW.getTime() - 10_000);
    utimesSync(settingsPath, declaredTime, declaredTime);
  }

  writeFileSync(
    join(stateDir, 'team.state.json'),
    `${JSON.stringify(
      {
        format: 1,
        sessions: {
          [SESSION]: {
            created_at: NOW.toISOString(),
            seats: {
              lead: { id: 'seat_111111111111', pane: '%1', cli: 'claude-code', stage: 'ready' },
              'worker-claude': { id: 'seat_222222222222', pane: '%2', cli: 'claude-code', stage: 'ready' },
              'worker-codex': {
                id: 'seat_333333333333',
                pane: '%3',
                cli: 'codex',
                stage: 'ready',
                agent_session: THREAD_ID,
              },
              'worker-gemini': {
                id: 'seat_444444444444',
                pane: '%4',
                cli: 'gemini',
                stage: 'ready',
                agent_session: GEMINI_SESSION,
              },
              'worker-cursor': {
                id: 'seat_555555555555',
                pane: '%5',
                cli: 'cursor',
                stage: 'ready',
                agent_session: CURSOR_SESSION,
              },
              'worker-human': { id: 'seat_666666666666', pane: '%6', cli: 'claude-code', stage: 'ready' },
            },
            worktrees: {},
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) {
    throw new Error(`failed to load test team.yaml: ${loaded.errors.map((e) => e.message).join('; ')}`);
  }

  const teamId = teamIdOf(loaded.root);
  const leadAgent = registerAgent(home, {
    name: 'lead',
    signing: { model: 'Claude Opus', version: '4.6', role: 'orchestrator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    seat_handle: 'seat_111111111111',
    reach: {
      team: teamId,
      seat: 'lead',
      session: SESSION,
      agent_session: null,
      pane: '%1',
      address: null,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  for (const reg of [
    {
      seat: 'worker-codex',
      cli: 'codex',
      vendor: 'openai',
      model: 'GPT Sol',
      version: '0.161.0',
      launch: 'codex -m gpt-6.1-sol',
      handle: 'seat_333333333333',
      pane: '%3',
      sessionToken: THREAD_ID,
    },
    {
      seat: 'worker-gemini',
      cli: 'gemini',
      vendor: 'google',
      model: 'Gemini Argon',
      version: '0.64.0',
      launch: 'gemini',
      handle: 'seat_444444444444',
      pane: '%4',
      sessionToken: GEMINI_SESSION,
    },
    {
      seat: 'worker-cursor',
      cli: 'cursor',
      vendor: 'xai',
      model: 'Grok',
      version: '2026.10.16',
      launch: 'cursor-agent',
      handle: 'seat_555555555555',
      pane: '%5',
      sessionToken: CURSOR_SESSION,
    },
  ]) {
    registerAgent(home, {
      name: reg.seat,
      signing: { model: reg.model, version: reg.version, role: 'builder' },
      lab: reg.vendor,
      cli: reg.cli,
      launcher: null,
      launch: reg.launch,
      seat_handle: reg.handle,
      reach: {
        team: teamId,
        seat: reg.seat,
        session: SESSION,
        agent_session: reg.sessionToken,
        pane: reg.pane,
        address: null,
      },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'owner',
    });
  }

  upsertTeam(home, teamId, {
    project: 'acme',
    entity: 'floor',
    session: SESSION,
    root: loaded.root,
    lobby,
    roster: [
      {
        seat: 'lead',
        agent: leadAgent.id,
        role: 'orchestrator',
        leads: true,
      },
    ],
  });
  const entityRoot = join(base, 'floor-entity-root');
  mkdirSync(entityRoot, { recursive: true });
  upsertTeam(home, teamIdOf(entityRoot), {
    project: 'floor',
    entity: 'floor',
    session: SESSION,
    root: entityRoot,
    lobby,
    roster: [
      {
        seat: 'lead',
        agent: leadAgent.id,
        role: 'orchestrator',
        leads: true,
      },
    ],
  });

  const route = routeOf(
    loaded.root,
    loaded.team.project,
    loaded.team.session,
    loaded.team.seats.map((s) => s.name),
  );

  return {
    base,
    root: loaded.root,
    home,
    stateDir,
    route,
    team: loaded.team,
    dropDir: (seat: string) => join(stateDir, 'send-drops', SESSION, seat),
  };
}

function makeSignedMessage(
  scene: Scene,
  id: string,
  to: string,
  body = 'From lead@acme\n\nSynthetic route test message.',
  overrides: Partial<RecordPayload> = {},
): SignedRecord {
  const payload: RecordPayload = {
    kind: RECORD_KIND,
    id,
    to,
    to_id: null,
    root: scene.root,
    session: SESSION,
    at: NOW.toISOString(),
    body,
    from: 'lead',
    from_id: null,
    rule: 'an orchestrator or operator to a seat of its own team',
    thread: id,
    ...overrides,
  };
  return signRecord(payload, scene.home);
}

function createFreshSocketFile(scene: Scene, name = 'claude.sock', mtimeMs = NOW.getTime()): string {
  const sockPath = join(scene.base, name);
  writeFileSync(sockPath, '', { mode: 0o600 });
  const at = new Date(mtimeMs);
  utimesSync(sockPath, at, at);
  return sockPath;
}

describe('daemon route-selection and capability integration (selectDaemonRelayRoutes)', () => {
  test('resolves scope via resolveScope and refuses route/team mismatch, undeclared seat, stopped seat, and tampered settings', () => {
    const scene = createScene({ stoppedSeat: true });

    const resolved = resolveScope([scene.route], {
      root: scene.root,
      team: 'acme',
      session: SESSION,
      seat: 'worker-codex',
    });
    expect(resolved.kind).toBe('one');

    const mismatch = selectDaemonRelayRoutes({
      route: scene.route,
      team: { ...scene.team, project: 'other-project' },
      seat: 'worker-codex',
      home: scene.home,
      now: NOW,
    });
    expect(mismatch).toEqual({
      ok: false,
      code: 'daemon.route-file',
      outcome: 'refused',
      message: 'the hosted route and its team file disagree; nothing was routed',
      broker: 'absent',
    });

    const undeclared = selectDaemonRelayRoutes({
      route: scene.route,
      team: scene.team,
      seat: 'ghost-seat',
      home: scene.home,
      now: NOW,
    });
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) {
      expect(undeclared.code).toBe('daemon.route-seat');
      expect(undeclared.broker).toBe('absent');
    }

    const stopped = selectDaemonRelayRoutes({
      route: scene.route,
      team: scene.team,
      seat: 'worker-claude',
      home: scene.home,
      now: NOW,
    });
    expect(stopped).toEqual({
      ok: false,
      code: 'daemon.route-stopped',
      outcome: 'refused',
      message: 'worker-claude is stopped',
      broker: 'absent',
    });

    // Write a corrupt teams.yaml settings source in the registry -> must fail closed.
    writeFileSync(
      join(scene.home, '.config', 'team', 'teams.yaml'),
      'teams: "not-a-map"\n',
      { mode: 0o600 },
    );

    const badSettings = selectDaemonRelayRoutes({
      route: scene.route,
      team: scene.team,
      seat: 'worker-codex',
      home: scene.home,
      now: NOW,
    });
    expect(badSettings.ok).toBe(false);
    if (!badSettings.ok) {
      expect(badSettings.code).toBe('daemon.route-settings');
      expect(badSettings.broker).toBe('absent');
    }
  });

  test('selects implied socket-first for claude-code with accept, implied native-first for codex, headless-resume for gemini/cursor, and durable-copy only for human', () => {
    const acceptScene = createScene({ claudeInbound: 'accept' });
    const claudePlan = selectDaemonRelayRoutes({
      route: acceptScene.route,
      team: acceptScene.team,
      seat: 'worker-claude',
      home: acceptScene.home,
      now: NOW,
    });
    expect(claudePlan.ok).toBe(true);
    if (claudePlan.ok) {
      expect(claudePlan.plan.inbound.policy).toBe('accept');
      expect(claudePlan.plan.selectedRoutes).toEqual(['socket', 'durable-copy']);
      expect(claudePlan.plan.capabilities.socket.supported).toBe(true);
      expect(claudePlan.plan.capabilities.liveReceiptProven).toBe(false);
      expect(claudePlan.plan.broker).toBe('absent');
    }

    const holdScene = createScene({ claudeInbound: 'hold' });
    const claudeHoldPlan = selectDaemonRelayRoutes({
      route: holdScene.route,
      team: holdScene.team,
      seat: 'worker-claude',
      home: holdScene.home,
      now: NOW,
    });
    expect(claudeHoldPlan.ok).toBe(true);
    if (claudeHoldPlan.ok) {
      expect(claudeHoldPlan.plan.inbound.policy).toBe('hold');
      expect(claudeHoldPlan.plan.selectedRoutes).toEqual(['durable-copy']);
    }

    const codexPlan = selectDaemonRelayRoutes({
      route: acceptScene.route,
      team: acceptScene.team,
      seat: 'worker-codex',
      home: acceptScene.home,
      now: NOW,
    });
    expect(codexPlan.ok).toBe(true);
    if (codexPlan.ok) {
      expect(codexPlan.plan.codexDaemon).toBe('on');
      expect(codexPlan.plan.selectedRoutes).toEqual(['native', 'durable-copy']);
      expect(codexPlan.plan.capabilities.native.supported).toBe(true);
      expect(codexPlan.plan.capabilities.native.ack).toBe(false);
      expect(codexPlan.plan.capabilities.liveReceiptProven).toBe(false);
    }

    const geminiPlan = selectDaemonRelayRoutes({
      route: acceptScene.route,
      team: acceptScene.team,
      seat: 'worker-gemini',
      home: acceptScene.home,
      now: NOW,
    });
    expect(geminiPlan.ok).toBe(true);
    if (geminiPlan.ok) {
      expect(geminiPlan.plan.selectedRoutes).toEqual(['headless-resume', 'durable-copy']);
      expect(geminiPlan.plan.capabilities.headlessResume.supported).toBe(true);
      expect(geminiPlan.plan.capabilities.headlessResume.ack).toBe(false);
      expect(geminiPlan.plan.capabilities.liveReceiptProven).toBe(false);
    }

    const cursorPlan = selectDaemonRelayRoutes({
      route: acceptScene.route,
      team: acceptScene.team,
      seat: 'worker-cursor',
      home: acceptScene.home,
      now: NOW,
    });
    expect(cursorPlan.ok).toBe(true);
    if (cursorPlan.ok) {
      expect(cursorPlan.plan.selectedRoutes).toEqual(['headless-resume', 'durable-copy']);
      expect(cursorPlan.plan.capabilities.headlessResume.supported).toBe(true);
      expect(cursorPlan.plan.capabilities.liveReceiptProven).toBe(false);
    }

    const humanPlan = selectDaemonRelayRoutes({
      route: acceptScene.route,
      team: acceptScene.team,
      seat: 'worker-human',
      home: acceptScene.home,
      chain: { seat: ['socket', 'drop'] },
      now: NOW,
    });
    expect(humanPlan.ok).toBe(true);
    if (humanPlan.ok) {
      expect(humanPlan.plan.human).toBe(true);
      expect(humanPlan.plan.selectedRoutes).toEqual(['durable-copy']);
      expect(humanPlan.plan.skippedLegs.length).toBeGreaterThan(0);
    }

    const directHumanPlan = selectDaemonRelayRoutes({
      route: acceptScene.route,
      team: acceptScene.team,
      seat: 'worker-human',
      home: acceptScene.home,
      directOnly: true,
      now: NOW,
    });
    expect(directHumanPlan.ok).toBe(true);
    if (directHumanPlan.ok) {
      expect(directHumanPlan.plan.selectedRoutes).toEqual([]);
    }
  });
});

describe('daemon pre-attempt route probing (probeDaemonRelayRoutes)', () => {
  test('classifies stale pre-declaration sockets and active Codex threads as would-hold and picks the first ready route', async () => {
    const scene = createScene({ claudeInbound: 'accept' });
    const selection = selectDaemonRelayRoutes({
      route: scene.route,
      team: scene.team,
      seat: 'worker-codex',
      home: scene.home,
      chain: { seat: ['socket', 'native', 'headless-resume', 'drop'] },
      now: NOW,
    });
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;

    // Socket mtime older than crossSessionInbound declaration -> would-hold
    const staleSocket = createFreshSocketFile(scene, 'stale.sock', NOW.getTime() - 60_000);
    const msgId = '11111111-2222-4333-8444-555555555555';

    const probed = await probeDaemonRelayRoutes({
      plan: {
        ...selection.plan,
        cli: 'codex',
        inbound: {
          policy: 'accept',
          declaredAt: NOW.getTime() - 5_000,
          source: 'claude-settings',
        },
      },
      messageId: msgId,
      sender: { seat: 'lead', team: teamIdOf(scene.root) },
      socketPath: staleSocket,
      agentSession: THREAD_ID,
      perRouteProbeOptions: {
        // Provide a claude-code socket probe override and an active Codex thread probe
        native: {
          liveProbe: async () => ({
            ok: true,
            thread: {
              id: THREAD_ID,
              status: {
                type: 'active',
                activeFlags: ['waitingOnApproval'],
              },
            },
          }),
        },
      },
    });

    expect(probed.probes.map((p) => p.route)).toEqual([
      'socket',
      'native',
      'headless-resume',
      'durable-copy',
    ]);
    // codex has no cross-session socket -> unsupported on socket; native is would-hold; headless-resume is unsupported on codex; durable-copy is ready
    expect(probed.probes[0]?.probe.status).toBe('unsupported');
    expect(probed.probes[1]?.probe.status).toBe('would-hold');
    expect(probed.probes[2]?.probe.status).toBe('unsupported');
    expect(probed.probes[3]?.probe.status).toBe('ready');
    expect(probed.wouldHoldRoutes).toEqual(['native']);
    expect(probed.firstReadyRoute).toBe('durable-copy');
  });
});

describe('daemon relay send handler and fallback walk (handleDaemonRelaySend)', () => {
  test('verifies signed message records and refuses tampered signatures or mismatched root/session/recipient before staging', async () => {
    const scene = createScene({ claudeInbound: 'accept' });
    const msgId = '22222222-3333-4444-8555-666666666666';
    const signed = makeSignedMessage(scene, msgId, 'worker-claude');

    const tampered: SignedRecord = {
      payload: { ...signed.payload, body: 'tampered body' },
      signature: signed.signature,
    };
    const badSig = await handleDaemonRelaySend({
      route: scene.route,
      team: scene.team,
      home: scene.home,
      record: tampered,
      now: () => NOW,
    });
    expect(badSig.ok).toBe(false);
    if (!badSig.ok) {
      expect(badSig.code).toBe('daemon.route-record');
      expect(badSig.broker).toBe('absent');
    }
    expect(existsSync(join(scene.dropDir('worker-claude'), msgId))).toBe(false);

    const wrongRoot = makeSignedMessage(scene, msgId, 'worker-claude', 'hello', {
      root: join(scene.base, 'other-root'),
    });
    const badRoot = await handleDaemonRelaySend({
      route: scene.route,
      team: scene.team,
      home: scene.home,
      record: wrongRoot,
      now: () => NOW,
    });
    expect(badRoot.ok).toBe(false);
    if (!badRoot.ok) {
      expect(badRoot.code).toBe('daemon.route-record');
    }
    expect(existsSync(join(scene.dropDir('worker-claude'), msgId))).toBe(false);
  });

  test('delivers via Codex native route when ready, and promotes to read only when verified <id>.read.json exists', async () => {
    const scene = createScene();
    const msgId = '33333333-4444-4555-8666-777777777777';
    const signed = makeSignedMessage(scene, msgId, 'worker-codex');
    const spawnedArgv: string[][] = [];

    const delivered = await handleDaemonRelaySend(
      {
        route: scene.route,
        team: scene.team,
        home: scene.home,
        record: signed,
        agentSession: THREAD_ID,
        now: () => NOW,
      },
      {
        codexLiveProbe: async () => ({
          ok: true,
          thread: {
            id: THREAD_ID,
            status: { type: 'idle' },
            canAcceptDirectInput: true,
          },
        }),
        codexSpawn: async (binary, args) => {
          spawnedArgv.push([binary, ...args]);
          return { status: 0, stdout: 'queued\n', stderr: '' };
        },
      },
    );

    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;
    expect(delivered.outcome).toBe('delivered');
    expect(delivered.deliveredRoute).toBe('native');
    expect(delivered.readReceiptVerified).toBe(false);
    expect(delivered.liveReceiptProven).toBe(false);
    expect(delivered.broker).toBe('absent');
    expect(spawnedArgv).toEqual([
      [
        'codex',
        'queue',
        '--remote',
        `unix://${join(scene.home, '.codex', 'app-server-control', 'app-server-control.sock')}`,
        '--thread',
        THREAD_ID,
        '--message',
        pushPointer(msgId, { seat: 'lead', team: teamIdOf(scene.root) })!,
      ],
    ]);

    // Now write a verified signed <id>.read.json receipt and verify promotion to `outcome: 'read'`
    const msgIdRead = '44444444-5555-4666-8777-888888888888';
    const signedRead = makeSignedMessage(scene, msgIdRead, 'worker-gemini');
    const geminiArgv: string[][] = [];

    const readResult = await handleDaemonRelaySend(
      {
        route: scene.route,
        team: scene.team,
        home: scene.home,
        record: signedRead,
        agentSession: GEMINI_SESSION,
        now: () => NOW,
      },
      {
        headlessSpawn: async (binary, args) => {
          geminiArgv.push([binary, ...args]);
          const dropDir = scene.dropDir('worker-gemini');
          const receipt = signReceiptPayload(
            {
              kind: 'receipt',
              status: 'read',
              id: msgIdRead,
              to: 'worker-gemini',
              root: scene.root,
              session: SESSION,
              at: NOW.toISOString(),
            },
            scene.home,
          );
          writeFileSync(
            join(dropDir, `${msgIdRead}.read.json`),
            `${JSON.stringify(receipt, null, 2)}\n`,
            { mode: 0o600 },
          );
          return { status: 0, stdout: '{"response":"ok"}\n', stderr: '' };
        },
      },
    );

    expect(readResult.ok).toBe(true);
    if (!readResult.ok) return;
    expect(readResult.outcome).toBe('read');
    expect(readResult.deliveredRoute).toBe('headless-resume');
    expect(readResult.readReceiptVerified).toBe(true);
    expect(readResult.liveReceiptProven).toBe(false);
    expect(geminiArgv).toEqual([
      [
        'gemini',
        '--approval-mode',
        'yolo',
        '--resume',
        GEMINI_SESSION,
        '-p',
        pushPointer(msgIdRead, { seat: 'lead', team: teamIdOf(scene.root) })!,
      ],
    ]);
  });

  test('falls through mid-send socket death to headless-resume with identical message id, records both attempts, and deduplicates at readMessage', async () => {
    const scene = createScene({ claudeInbound: 'accept' });
    const msgId = '55555555-6666-4777-8888-999999999999';
    const signed = makeSignedMessage(
      scene,
      msgId,
      'worker-cursor',
      'From lead@acme\n\nMid-send socket reset fallback test.',
    );
    const sockPath = createFreshSocketFile(scene, 'cursor-mid.sock', NOW.getTime());
    let dialCalls = 0;
    let cursorSpawns = 0;

    const answer = await handleDaemonRelaySend(
      {
        route: scene.route,
        team: scene.team,
        home: scene.home,
        record: signed,
        routes: ['socket', 'headless-resume', 'durable-copy'],
        socketPath: sockPath,
        socketRuntime: 'claude-code',
        agentSession: CURSOR_SESSION,
        caller: { kind: 'seat', name: 'lead', pane: '%1' },
        now: () => NOW,
      },
      {
        perRouteOptions: {
          socket: {
            crossSessionInbound: {
              policy: 'accept',
              declaredAt: NOW.getTime() - 5_000,
              source: 'explicit',
            },
          },
        },
        dial: async () => {
          dialCalls += 1;
          return {
            ok: false,
            code: 'ECONNRESET',
            reason: 'the receiving session closed the connection before it took the frame',
          };
        },
        headlessSpawn: async (binary, args) => {
          cursorSpawns += 1;
          expect([binary, ...args]).toEqual([
            'cursor-agent',
            '--force',
            '--sandbox',
            'disabled',
            '--approve-mcps',
            '--trust',
            '--resume',
            CURSOR_SESSION,
            '-p',
            pushPointer(msgId, { seat: 'lead', team: teamIdOf(scene.root) })!,
          ]);
          return { status: 0, stdout: '{"result":"ok"}\n', stderr: '' };
        },
      },
    );

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(dialCalls).toBe(1);
    expect(cursorSpawns).toBe(1);
    expect(answer.outcome).toBe('delivered');
    expect(answer.deliveredRoute).toBe('headless-resume');
    expect(answer.readReceiptVerified).toBe(false);
    expect(answer.attempts.map((a) => a.route)).toEqual(['socket', 'headless-resume']);
    expect(answer.attempts[0]?.outcome).toBe('refused');
    if (answer.attempts[0]?.outcome === 'refused') {
      expect(answer.attempts[0].ambiguousConsumption).toBe(true);
    }
    expect(answer.attempts[0]?.walkAttempt.outcome).toBe('unreachable');
    expect(answer.attempts[0]?.walkAttempt.receipt).toEqual({ kind: 'maybe-consumed' });
    expect(answer.attempts[1]?.walkAttempt.outcome).toBe('delivered');
    expect(answer.attempts[1]?.walkAttempt.receipt).toEqual({ kind: 'maybe-consumed' });

    // Receiver read gate serves the message once and deduplicates any second read of the same ID
    const dropDir = scene.dropDir('worker-cursor');
    const firstRead = readMessage(
      { dropDir, seat: 'worker-cursor', root: scene.root, session: SESSION },
      msgId,
      scene.home,
    );
    expect(firstRead.ok).toBe(true);
    if (firstRead.ok) {
      expect(firstRead.body).toContain('Mid-send socket reset fallback test.');
    }

    const secondRead = readMessage(
      { dropDir, seat: 'worker-cursor', root: scene.root, session: SESSION },
      msgId,
      scene.home,
    );
    expect(secondRead).toEqual({
      ok: false,
      reason: `message ${JSON.stringify(msgId)} was already served in this inbox`,
      served: 'already-served',
    });
  });

  test('skips would-hold Codex native route without spawning, falls through to durable-copy as held, and fires delayed escalation via sweepFallbackEscalations', async () => {
    const scene = createScene();
    const msgId = '66666666-7777-4888-8999-000000000000';
    const signed = makeSignedMessage(scene, msgId, 'worker-codex');
    let spawnCalled = false;

    const heldAnswer = await handleDaemonRelaySend(
      {
        route: scene.route,
        team: scene.team,
        home: scene.home,
        record: signed,
        agentSession: THREAD_ID,
        caller: { kind: 'seat', name: 'lead', pane: '%1' },
        now: () => NOW,
      },
      {
        codexLiveProbe: async () => ({
          ok: true,
          thread: {
            id: THREAD_ID,
            status: {
              type: 'active',
              activeFlags: ['waitingOnApproval'],
            },
          },
        }),
        codexSpawn: async () => {
          spawnCalled = true;
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );

    expect(spawnCalled).toBe(false);
    expect(heldAnswer.ok).toBe(true);
    if (!heldAnswer.ok) return;
    expect(heldAnswer.outcome).toBe('held');
    expect(heldAnswer.deliveredRoute).toBeNull();
    expect(heldAnswer.readReceiptVerified).toBe(false);
    expect(heldAnswer.attempts.map((a) => a.route)).toEqual(['native', 'durable-copy']);
    expect(heldAnswer.attempts[0]?.outcome).toBe('refused');
    if (heldAnswer.attempts[0]?.outcome === 'refused') {
      expect(heldAnswer.attempts[0].wouldHold).toBe(true);
    }
    expect(heldAnswer.attempts[1]?.outcome).toBe('held');

    // Verify fallback marker was written and immediate message.held event was emitted once
    const markerPath = join(scene.dropDir('worker-codex'), `${msgId}.fallback.json`);
    expect(existsSync(markerPath)).toBe(true);
    const readBeforeSweep = readEvents('acme', scene.root, scene.home);
    expect(readBeforeSweep.ok).toBe(true);
    if (readBeforeSweep.ok) {
      const eventsBeforeSweep = readBeforeSweep.events.filter(
        (e) => e.payload.kind === 'message.held',
      );
      expect(eventsBeforeSweep).toHaveLength(1);
    }

    // Sweep after the 300s escalation delay -> fires the delayed main-orchestrator escalation once
    const dueInstant = new Date(NOW.getTime() + 301_000);
    const swept = sweepFallbackEscalations({
      home: scene.home,
      roots: [{ root: scene.root, team: scene.team }],
      now: () => dueInstant,
    });
    expect(swept.roots).toHaveLength(1);
    expect(swept.roots[0]?.report?.escalated).toHaveLength(1);

    const readAfterSweep = readEvents('acme', scene.root, scene.home);
    expect(readAfterSweep.ok).toBe(true);
    if (readAfterSweep.ok) {
      const eventsAfterSweep = readAfterSweep.events.filter(
        (e) => e.payload.kind === 'message.held',
      );
      expect(eventsAfterSweep).toHaveLength(2);
    }
  });

  test('deliverDaemonRelayRoute handles missing socket path as unreachable without dialing', async () => {
    const scene = createScene({ claudeInbound: 'accept' });
    const selection = selectDaemonRelayRoutes({
      route: scene.route,
      team: scene.team,
      seat: 'worker-claude',
      home: scene.home,
      now: NOW,
    });
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;

    const msgId = '77777777-8888-4999-8000-111111111111';
    const targets = buildDaemonRelayTargets({
      plan: selection.plan,
      messageId: msgId,
      sender: { seat: 'lead', team: teamIdOf(scene.root) },
      socketPath: null,
    });
    const socketTarget = targets[0]!;
    expect(socketTarget.route).toBe('socket');

    let dialed = false;
    const attempt = await deliverDaemonRelayRoute(
      socketTarget,
      { id: msgId, record: '{"test":true}\n', frame: '{"test":true}\n' },
      selection.plan,
      {
        now: () => NOW,
        dial: async () => {
          dialed = true;
          return { ok: true };
        },
      },
    );
    expect(dialed).toBe(false);
    expect(attempt.outcome).toBe('refused');
    if (attempt.outcome === 'refused') {
      expect(attempt.adapterOutcome).toBe('unreachable');
      expect(attempt.reason).toContain('no cross-session socket was found');
    }
    expect(attempt.walkAttempt.outcome).toBe('unreachable');
  });

  test('enforces launch attestation with the team file’s explicit opt-out, and reports precise reasons for human-launched, hook-unset, and own-seat self-send', async () => {
    // 1. Compare writer-01 style wrapper (claude-deepseek.sh with --settings '{"crossSessionInbound":"accept"}')
    //    plus team.yaml inbound: accept -> socket is eligible and dials.
    const writerScene = createScene({
      claudeTeamInbound: 'accept',
      claudeLaunch: 'zsh ./tools/claude-deepseek.sh',
    });
    const toolsDir = join(writerScene.root, 'tools');
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(
      join(toolsDir, 'claude-deepseek.sh'),
      '#!/usr/bin/env zsh\nexec claude --settings \'{"crossSessionInbound":"accept"}\' "$@"\n',
      { mode: 0o755 },
    );
    const writerSock = join(writerScene.base, 'writer.sock');
    writeFileSync(writerSock, '');

    const writerSelect = selectDaemonRelayRoutes({
      route: writerScene.route,
      team: writerScene.team,
      seat: 'worker-claude',
      home: writerScene.home,
      now: NOW,
    });
    expect(writerSelect.ok).toBe(true);
    if (!writerSelect.ok) return;
    expect(writerSelect.plan.socketEligible).toBe(true);
    expect(writerSelect.plan.socketIneligibleReason).toBeNull();
    expect(writerSelect.plan.selectedRoutes[0]).toBe('socket');

    // 2. Compare orchestrator@floor style: team.yaml has inbound: accept, socket file exists, and
    //    synthetic owner ~/.claude/settings.json has {"crossSessionInbound":"accept"}, BUT
    //    floor-coordinator.sh passes no --settings and .agents/hooks/acme/lead.json has only hooks
    //    (no crossSessionInbound). Owner ~/.claude settings are never read, socket is skipped with
    //    precise reason, and own-seat self-send (lead -> lead) also skips typing into own pane.
    const coordScene = createScene({
      claudeTeamInbound: 'accept',
      claudeLaunch: 'zsh ./tools/floor-coordinator.sh',
    });
    const coordTools = join(coordScene.root, 'tools');
    mkdirSync(coordTools, { recursive: true });
    writeFileSync(
      join(coordTools, 'floor-coordinator.sh'),
      '#!/usr/bin/env zsh\nexec claude "$@"\n',
      { mode: 0o755 },
    );
    // Synthetic owner CLI settings inside isolated temp home (must never be read or trusted)
    const ownerClaudeDir = join(coordScene.home, '.claude');
    mkdirSync(ownerClaudeDir, { recursive: true });
    writeFileSync(
      join(ownerClaudeDir, 'settings.json'),
      JSON.stringify({ crossSessionInbound: 'accept' }),
    );
    // Generated hook file without crossSessionInbound (matching .agents/hooks/floor/orchestrator.json)
    const hookSettingsPath = cliHookSettingsPath(coordScene.stateDir, SESSION, 'lead')!;
    mkdirSync(dirname(hookSettingsPath), { recursive: true });
    writeFileSync(
      hookSettingsPath,
      JSON.stringify({ hooks: { UserPromptSubmit: [], Stop: [] } }),
    );
    const coordSock = join(coordScene.base, 'coord.sock');
    writeFileSync(coordSock, '');

    const selfSelect = selectDaemonRelayRoutes({
      route: coordScene.route,
      team: coordScene.team,
      seat: 'lead',
      from: 'lead',
      fromTeam: 'acme',
      home: coordScene.home,
      now: NOW,
    });
    expect(selfSelect.ok).toBe(true);
    if (!selfSelect.ok) return;
    expect(selfSelect.plan.selfSend).toBe(true);
    expect(selfSelect.plan.socketEligible).toBe(false);
    expect(selfSelect.plan.socketIneligibleReason).toContain(
      `the receiving Claude session does not declare crossSessionInbound accept in its launch-effective settings (${hookSettingsPath}); owner CLI settings are not read`,
    );
    expect(selfSelect.plan.selectedRoutes).not.toContain('socket');
    expect(selfSelect.plan.skippedLegs).toContainEqual({
      leg: 'socket',
      reason: `the receiving Claude session does not declare crossSessionInbound accept in its launch-effective settings (${hookSettingsPath}); owner CLI settings are not read`,
    });
    expect(selfSelect.plan.skippedLegs).toContainEqual({
      leg: 'typed',
      reason: "own-seat self-send (lead -> lead): nothing is typed into the sender's own active pane",
    });

    // Self-send with directOnly: true refuses with daemon.route-empty and surfaces both precise reasons
    const selfMsgId = '88888888-9999-4000-8000-222222222222';
    const selfRecord = makeSignedMessage(
      coordScene,
      selfMsgId,
      'lead',
      'self-send synthetic check',
      { from: 'lead' },
    );
    let selfDialed = false;
    const selfSendResult = await handleDaemonRelaySend(
      {
        route: coordScene.route,
        team: coordScene.team,
        home: coordScene.home,
        record: selfRecord,
        directOnly: true,
        socketPath: coordSock,
        now: () => NOW,
      },
      {
        dial: async () => {
          selfDialed = true;
          return { ok: true };
        },
      },
    );
    expect(selfDialed).toBe(false);
    expect(selfSendResult.ok).toBe(false);
    if (!selfSendResult.ok) {
      expect(selfSendResult.code).toBe('daemon.route-empty');
      expect(selfSendResult.message).toContain(
        `socket: the receiving Claude session does not declare crossSessionInbound accept in its launch-effective settings (${hookSettingsPath}); owner CLI settings are not read`,
      );
      expect(selfSendResult.message).toContain(
        "typed: own-seat self-send (lead -> lead): nothing is typed into the sender's own active pane",
      );
    }

    // 3. Human-launched session (no .agents/hooks file on disk, launch has no --settings):
    //    even with team.yaml inbound: accept and synthetic ~/.claude/settings.json accept,
    //    socket is skipped with the human-launched / no --settings diagnostic reason.
    const humanLaunchedScene = createScene({
      claudeTeamInbound: 'accept',
      claudeLaunch: 'claude',
    });
    const humanOwnerClaudeDir = join(humanLaunchedScene.home, '.claude');
    mkdirSync(humanOwnerClaudeDir, { recursive: true });
    writeFileSync(
      join(humanOwnerClaudeDir, 'settings.json'),
      JSON.stringify({ crossSessionInbound: 'accept' }),
    );
    const humanSelect = selectDaemonRelayRoutes({
      route: humanLaunchedScene.route,
      team: humanLaunchedScene.team,
      seat: 'lead',
      home: humanLaunchedScene.home,
      now: NOW,
    });
    expect(humanSelect.ok).toBe(true);
    if (!humanSelect.ok) return;
    expect(humanSelect.plan.socketEligible).toBe(false);
    expect(humanSelect.plan.socketIneligibleReason).toBe(
      'the receiving Claude session does not declare crossSessionInbound accept (human-launched or launch without --settings; owner CLI settings are not read)',
    );
    expect(humanSelect.plan.skippedLegs).toContainEqual({
      leg: 'socket',
      reason:
        'the receiving Claude session does not declare crossSessionInbound accept (human-launched or launch without --settings; owner CLI settings are not read)',
    });

    // 4. The launch attests accept (the generated settings file is on its line) and team.yaml
    //    omits inbound -> the launch is the authorization; the socket is eligible.
    const missingTeamWordScene = createScene({
      claudeTeamInbound: null,
      claudeInbound: 'accept',
    });
    const missingTeamSelect = selectDaemonRelayRoutes({
      route: missingTeamWordScene.route,
      team: missingTeamWordScene.team,
      seat: 'worker-claude',
      home: missingTeamWordScene.home,
      now: NOW,
    });
    expect(missingTeamSelect.ok).toBe(true);
    if (!missingTeamSelect.ok) return;
    expect(missingTeamSelect.plan.socketEligible).toBe(true);
    expect(missingTeamSelect.plan.socketIneligibleReason).toBeNull();

    // 5. A launch this build did not write (a wrapper's own --settings, no generated file) is
    //    not attested: with team.yaml omitting inbound, the team file's word is still required.
    const unattestedScene = createScene({
      claudeTeamInbound: null,
      claudeLaunch: 'zsh ./tools/claude-accept.sh',
    });
    const unattestedTools = join(unattestedScene.root, 'tools');
    mkdirSync(unattestedTools, { recursive: true });
    writeFileSync(
      join(unattestedTools, 'claude-accept.sh'),
      '#!/bin/zsh\nexec claude --settings \'{"crossSessionInbound":"accept"}\' "$@"\n',
      { mode: 0o755 },
    );
    const unattestedSelect = selectDaemonRelayRoutes({
      route: unattestedScene.route,
      team: unattestedScene.team,
      seat: 'worker-claude',
      home: unattestedScene.home,
      now: NOW,
    });
    expect(unattestedSelect.ok).toBe(true);
    if (!unattestedSelect.ok) return;
    expect(unattestedSelect.plan.socketEligible).toBe(false);
    expect(unattestedSelect.plan.socketIneligibleReason).toBe(
      "the receiving seat's team file does not declare inbound accept",
    );
    expect(unattestedSelect.plan.skippedLegs).toContainEqual({
      leg: 'socket',
      reason: "the receiving seat's team file does not declare inbound accept",
    });
  });
});
