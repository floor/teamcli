import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../../src/approve/approval.ts';
import { runTeamCheck } from '../../src/check/team.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { codexEndpointSocket, ensureCodexEndpoint } from '../../src/launch/codex-endpoint.ts';
import { executePlan, type Host } from '../../src/launch/execute.ts';
import { codexEndpointConfig, upPlan, type Step, type UpInput, type UpSeat } from '../../src/launch/plan.ts';
import type { CodexEndpointRecord } from '../../src/daemon/presence/endpoint-record.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import type { Standing } from '../../src/store/store.ts';
import type { Live } from '../../src/status/compare.ts';
import { deliverBriefs, shortSocketBase, testIo } from '../helpers.ts';

const SHORT_TMP = shortSocketBase();
const SESSION = 'acme';
const SEAT = 'tester-2';
const BINDING = 'prs_0123456789ab';
const T0 = '2026-11-05T01:00:00.000Z';
const T0_MS = Date.parse(T0);
const NOW = new Date('2026-11-05T01:05:00.000Z');
const REPAIR = '`team remove tester-2 --keep` then `team add tester-2`';

function scratch(): string {
  return mkdtempSync(join(SHORT_TMP, 'cem-'));
}

function makeHost(
  ran: string[],
  said: string[],
  managed?: Host['managedCodexEndpoint'],
): Host {
  return {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'pane-2', workspace: 'w2' }),
    paneRun: (_s, _p, command) => {
      ran.push(command);
      return true;
    },
    ...(managed === undefined ? {} : { managedCodexEndpoint: managed }),
    typeLine: () => false,
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [],
    classify: () => 'idle',
    sleep: async () => {},
    now: () => 0,
    allow: () => null,
    record: () => {},
    running: () => {},
    drop: () => {},
    say: (text) => {
      said.push(text);
    },
    log: () => {},
  };
}

function seedEndpointRecord(dir: string, record: CodexEndpointRecord, binding = BINDING): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = {
      stage: 'ready',
      pane: 'pane-2',
      workspace: 'w2',
      presence_binding: binding,
      codex_endpoint: record,
    };
  });
}

describe('Scope (1): codexEndpointConfig unwraps sh -c and zsh -lc launches and passes approval and sandbox flags', () => {
  test('unwraps single-quoted sh -c and double-quoted zsh -lc launches to extract approval, sandbox, and -c flags', () => {
    expect(
      codexEndpointConfig("sh -c 'codex -m gpt-5.4 -a never -s danger-full-access -c model_reasoning_effort=high'"),
    ).toEqual([
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
      '-c', 'model_reasoning_effort=high',
    ]);

    expect(
      codexEndpointConfig('zsh -lc "codex --ask-for-approval on-request --sandbox workspace-write -c \'mcp_servers.team_inbox.command=\\"team\\"\'"'),
    ).toEqual([
      '-c', 'approval_policy="on-request"',
      '-c', 'sandbox_mode="workspace-write"',
      '-c', 'mcp_servers.team_inbox.command="team"',
    ]);

    expect(
      codexEndpointConfig("sh -c 'zsh -lc \"codex --dangerously-bypass-approvals-and-sandbox\"'"),
    ).toEqual([
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
    ]);
  });

  test('upPlan marks a sh -c or zsh -lc Codex seat for a managed endpoint and executePlan attaches --remote inside the script', async () => {
    const seatSpec: UpSeat = {
      name: SEAT,
      cli: 'codex',
      launch: "zsh -lc 'codex -m gpt-5.4 -a never -s danger-full-access'",
      cwd: '/tmp/acme',
      label: SEAT,
      repairLine: REPAIR,
      stopped: false,
      rules: 'Rules.',
      codexDaemon: 'on',
    };
    const planInput: UpInput = {
      root: '/tmp/acme',
      session: SESSION,
      sessionRunning: true,
      seats: [seatSpec],
      watchAlive: true,
      watchLabel: 'Watch · acme',
      stateDir: '/tmp/acme/.agents',
    };
    const plan = upPlan(planInput);
    const launchStep = plan.find((step) => step.do?.do === 'launch');
    expect(launchStep?.do).toMatchObject({
      do: 'launch',
      codexEndpoint: { dir: '/tmp/acme/.agents' },
    });

    const seenConfigs: (string[] | undefined)[] = [];
    const ranLines: string[] = [];
    const url = 'unix:///tmp/acme/.agents/run/acme/tester-2/prs_0123456789ab.sock';
    const host = makeHost(ranLines, [], async (ep) => {
      seenConfigs.push(ep.config);
      return { kind: 'up', url, started: true };
    });
    await executePlan(
      [
        {
          kind: 'run',
          argv: ['herdr', 'workspace', 'create'],
          do: { do: 'create', seat: SEAT, label: SEAT, cwd: '/tmp/acme', repairLine: REPAIR, watcher: 'none' },
        },
        launchStep!,
      ],
      SESSION,
      host,
    );
    expect(seenConfigs).toHaveLength(1);
    expect(seenConfigs[0]).toEqual(
      expect.arrayContaining([
        'approval_policy="never"',
        'sandbox_mode="danger-full-access"',
      ]),
    );
    expect(ranLines).toHaveLength(1);
    expect(ranLines[0]).toContain(`--remote ${url}'`);
  });
});

describe('Scope (2): ensureCodexEndpoint does not reuse a live endpoint whose start flags differ from the planned ones', () => {
  test('stops and replaces a live endpoint whose running command lacks the planned start flags even when state config matches', async () => {
    const dir = scratch();
    try {
      const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING);
      if (socket === null) throw new Error('expected socket');
      const config = ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"'];
      const prior: CodexEndpointRecord = {
        url: socket.url,
        binding: BINDING,
        pid: 700,
        started_at: T0,
        config,
      };
      seedEndpointRecord(dir, prior);
      const spawned: (string[] | undefined)[] = [];
      const terminated: number[] = [];
      const answer = await ensureCodexEndpoint({
        dir,
        session: SESSION,
        seat: SEAT,
        config,
        deps: {
          alive: () => true,
          // Live process was started without the planned approval/sandbox flags:
          commandOf: () => `codex app-server --listen ${socket.url}`,
          startOf: () => T0_MS + 200,
          isPlainDir: () => true,
          isSocket: () => true,
          drop: () => {},
          sleep: async () => {},
          now: () => NOW,
          terminate: (pid) => {
            terminated.push(pid);
          },
          spawn: (input) => {
            spawned.push(input.config);
            return { pid: 801 };
          },
        },
      });
      expect(terminated).toEqual([700]);
      expect(spawned).toEqual([config]);
      expect(answer).toEqual({ kind: 'up', url: socket.url, started: true });
      expect(readState(dir).sessions[SESSION]?.seats[SEAT]?.codex_endpoint?.pid).toBe(801);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stops and replaces a live endpoint whose running command has different start flags', async () => {
    const dir = scratch();
    try {
      const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING);
      if (socket === null) throw new Error('expected socket');
      const config = ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"'];
      const prior: CodexEndpointRecord = {
        url: socket.url,
        binding: BINDING,
        pid: 701,
        started_at: T0,
        config,
      };
      seedEndpointRecord(dir, prior);
      const spawned: (string[] | undefined)[] = [];
      const terminated: number[] = [];
      const answer = await ensureCodexEndpoint({
        dir,
        session: SESSION,
        seat: SEAT,
        config,
        deps: {
          alive: () => true,
          commandOf: () =>
            `codex app-server --listen ${socket.url} -c approval_policy="on-request" -c sandbox_mode="workspace-write"`,
          startOf: () => T0_MS + 200,
          isPlainDir: () => true,
          isSocket: () => true,
          drop: () => {},
          sleep: async () => {},
          now: () => NOW,
          terminate: (pid) => {
            terminated.push(pid);
          },
          spawn: (input) => {
            spawned.push(input.config);
            return { pid: 802 };
          },
        },
      });
      expect(terminated).toEqual([701]);
      expect(spawned).toEqual([config]);
      expect(answer).toEqual({ kind: 'up', url: socket.url, started: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Scope (3): a Codex seat never attaches to an unmanaged shared server (--remote or --no-daemon, never neither)', () => {
  function runLaunch(step: Step, managed?: Host['managedCodexEndpoint']): Promise<{ ran: string[]; said: string[] }> {
    const ran: string[] = [];
    const said: string[] = [];
    const host = makeHost(ran, said, managed);
    return executePlan(
      [
        {
          kind: 'run',
          argv: ['herdr', 'workspace', 'create'],
          do: { do: 'create', seat: SEAT, label: SEAT, cwd: '/tmp/acme', repairLine: REPAIR, watcher: 'none' },
        },
        step,
      ],
      SESSION,
      host,
    ).then(() => ({ ran, said }));
  }

  test('passes --no-daemon when managedCodexEndpoint refuses, is absent, or codexEndpoint is unmarked', async () => {
    const baseStep = (command: string, withEndpoint: boolean): Step => ({
      kind: 'run',
      argv: ['herdr', 'pane', 'run', 'pane-2', command],
      do: {
        do: 'launch',
        seat: SEAT,
        label: SEAT,
        command,
        cli: 'codex',
        watcher: 'none',
        ...(withEndpoint ? { codexEndpoint: { dir: '/tmp/acme/.agents' } } : {}),
      },
    });

    const refused = await runLaunch(
      baseStep('codex -m gpt-5.4 -a never -s danger-full-access', true),
      async () => ({ kind: 'unmanaged', why: 'the Codex app-server did not create its socket in time' }),
    );
    expect(refused.ran).toEqual(['codex -m gpt-5.4 -a never -s danger-full-access --no-daemon']);

    const noHost = await runLaunch(baseStep("zsh -lc 'codex -m gpt-5.4 -a never -s danger-full-access'", true));
    expect(noHost.ran).toEqual(["zsh -lc 'codex -m gpt-5.4 -a never -s danger-full-access --no-daemon'"]);

    const unmarked = await runLaunch(baseStep('codex -m gpt-5.4', false));
    expect(unmarked.ran).toEqual(['codex -m gpt-5.4 --no-daemon']);
  });
});

describe('Scope (4): team check names a codex seat running against an unmanaged server, with the repair', () => {
  const TEAM_YAML = `format: 1
project: acme
operator: lead
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: tester
    name: tester-2
    cli: codex
    vendor: openai
    model: GPT
    version: "5.4"
    launch: "zsh -lc 'codex -m gpt-5.4 -a never -s danger-full-access'"
`;

  function setupCheckWorld() {
    const base = realpathSync(mkdtempSync(join(SHORT_TMP, 'chk-')));
    const root = join(base, 'acme');
    const home = join(base, 'home');
    const dir = join(root, '.agents');
    mkdirSync(join(dir, 'rules'), { recursive: true });
    mkdirSync(home, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(dir, 'team.yaml'), TEAM_YAML);
    const checked = validateTeamFile(TEAM_YAML);
    if (!checked.ok) throw new Error('invalid fixture team.yaml');
    const standing: Standing = verifiedOf(checked.team, TEAM_YAML, root, NOW);
    writeFileSync(join(dir, 'rules', `${SEAT}.md`), 'Standing rules.\n');
    deliverBriefs({
      dir,
      root,
      session: SESSION,
      seats: ['lead', SEAT],
      home,
      at: NOW.toISOString(),
    });
    const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING);
    if (socket === null) throw new Error('expected socket');
    const live: Live = {
      running: true,
      agents: [
        { name: 'lead', agent: 'claude', pane: 'pane-1', workspace: 'w1', status: 'idle', cwd: root },
        { name: SEAT, agent: 'codex', pane: 'pane-2', workspace: 'w2', status: 'idle', cwd: root },
      ],
      workspaces: [
        { id: 'w1', label: 'lead · orchestrator' },
        { id: 'w2', label: `${SEAT} · tester` },
      ],
      screens: {},
      processes: {
        'pane-1': { shell: 100, foreground: [101] },
        'pane-2': { shell: 200, foreground: [201] },
      },
    };
    return { base, root, home, dir, standing, socket, live };
  }

  test('judges from recorded launch facts without reading any process command line (commandOf throws if called)', () => {
    const w = setupCheckWorld();
    const forbidCommandOf = (): string | null => {
      throw new Error('team check must not read any process command line');
    };
    try {
      // Scene A: seat has a presence_binding and a recorded launch_line without --no-daemon,
      // with no valid managed codex_endpoint recorded.
      updateState(w.dir, (state) => {
        const session = (state.sessions[SESSION] ??= emptySession());
        session.watch = { pid: 1, heartbeat: NOW.toISOString() };
        session.seats.lead = {
          stage: 'ready',
          pane: 'pane-1',
          workspace: 'w1',
          cli: 'claude-code',
          launch_line: 'claude',
          launched: { shell: 100, cli: [101] },
        };
        session.seats[SEAT] = {
          stage: 'ready',
          pane: 'pane-2',
          workspace: 'w2',
          cli: 'codex',
          presence_binding: BINDING,
          launch_line: "zsh -lc 'codex -m gpt-5.4 -a never -s danger-full-access -c features.mcp_oauth_refresh_coordination=false'",
          launched: { shell: 200, cli: [201] },
        };
      });

      const ioA = testIo(w.root, { kind: 'owner' });
      const codeA = runTeamCheck({ file: '.agents/team.yaml' }, ioA, {
        live: () => w.live,
        branch: () => 'main',
        standing: () => w.standing,
        now: () => NOW,
        home: w.home,
        codexEndpoint: {
          alive: () => true,
          commandOf: forbidCommandOf,
          startOf: () => T0_MS,
          isSocket: () => false,
        },
      });
      expect(codeA).toBe(1);
      expect(ioA.out).toContain(`difference: ${SEAT}:`);
      expect(ioA.out).toContain('unmanaged');
      expect(ioA.out).toContain(`repair: team restart ${SEAT}`);

      const expectedConfig = [
        '-c', 'approval_policy="never"',
        '-c', 'sandbox_mode="danger-full-access"',
        '-c', 'features.mcp_oauth_refresh_coordination=false',
      ];

      // Scene B1: seat recorded remote does not match its own endpoint record.
      updateState(w.dir, (state) => {
        const seat = state.sessions[SESSION]!.seats[SEAT]!;
        seat.launch_line =
          "zsh -lc 'codex -m gpt-5.4 -a never -s danger-full-access -c features.mcp_oauth_refresh_coordination=false --remote unix:///tmp/foreign.sock'";
        seat.codex_endpoint = {
          url: w.socket.url,
          binding: BINDING,
          pid: 700,
          started_at: T0,
          config: expectedConfig,
        };
      });
      const ioB1 = testIo(w.root, { kind: 'owner' });
      const codeB1 = runTeamCheck({ file: '.agents/team.yaml' }, ioB1, {
        live: () => w.live,
        branch: () => 'main',
        standing: () => w.standing,
        now: () => NOW,
        home: w.home,
        codexEndpoint: {
          alive: (pid) => pid === 700,
          commandOf: forbidCommandOf,
          startOf: () => T0_MS,
          isSocket: (path) => path === w.socket.path,
        },
      });
      expect(codeB1).toBe(1);
      expect(ioB1.out).toContain(`difference: ${SEAT}:`);
      expect(ioB1.out).toContain('unmanaged');
      expect(ioB1.out).toContain(`repair: team restart ${SEAT}`);

      // Scene B2: endpoint record config lacks the seat's planned start flags, or pid start time mismatches.
      updateState(w.dir, (state) => {
        const seat = state.sessions[SESSION]!.seats[SEAT]!;
        seat.launch_line =
          `zsh -lc 'codex -m gpt-5.4 -a never -s danger-full-access -c features.mcp_oauth_refresh_coordination=false --remote ${w.socket.url}'`;
        seat.codex_endpoint = {
          url: w.socket.url,
          binding: BINDING,
          pid: 700,
          started_at: T0,
          config: ['-c', 'features.mcp_oauth_refresh_coordination=false'],
        };
      });
      const ioB2 = testIo(w.root, { kind: 'owner' });
      const codeB2 = runTeamCheck({ file: '.agents/team.yaml' }, ioB2, {
        live: () => w.live,
        branch: () => 'main',
        standing: () => w.standing,
        now: () => NOW,
        home: w.home,
        codexEndpoint: {
          alive: (pid) => pid === 700,
          commandOf: forbidCommandOf,
          startOf: () => T0_MS,
          isSocket: (path) => path === w.socket.path,
        },
      });
      expect(codeB2).toBe(1);
      expect(ioB2.out).toContain(`difference: ${SEAT}:`);
      expect(ioB2.out).toContain('unmanaged');
      expect(ioB2.out).toContain(`repair: team restart ${SEAT}`);

      // Scene B3: socket not live, or recorded app-server pid exited, or pid start time mismatches.
      updateState(w.dir, (state) => {
        const seat = state.sessions[SESSION]!.seats[SEAT]!;
        seat.codex_endpoint = {
          url: w.socket.url,
          binding: BINDING,
          pid: 700,
          started_at: T0,
          config: expectedConfig,
        };
      });
      for (const badEndpoint of [
        { alive: () => true, startOf: () => T0_MS, isSocket: () => false },
        { alive: () => false, startOf: () => T0_MS, isSocket: (path: string) => path === w.socket.path },
        { alive: () => true, startOf: () => T0_MS + 60_000, isSocket: (path: string) => path === w.socket.path },
      ]) {
        const ioBad = testIo(w.root, { kind: 'owner' });
        const codeBad = runTeamCheck({ file: '.agents/team.yaml' }, ioBad, {
          live: () => w.live,
          branch: () => 'main',
          standing: () => w.standing,
          now: () => NOW,
          home: w.home,
          codexEndpoint: {
            ...badEndpoint,
            commandOf: forbidCommandOf,
          },
        });
        expect(codeBad).toBe(1);
        expect(ioBad.out).toContain(`difference: ${SEAT}:`);
        expect(ioBad.out).toContain('unmanaged');
        expect(ioBad.out).toContain(`repair: team restart ${SEAT}`);
      }

      // Scene C: when a fact cannot be had from recorded facts / start time (e.g. startOf returns null
      // or endpoint record has no config), check says "cannot tell" for that seat and repair stays team restart.
      const ioC1 = testIo(w.root, { kind: 'owner' });
      const codeC1 = runTeamCheck({ file: '.agents/team.yaml' }, ioC1, {
        live: () => w.live,
        branch: () => 'main',
        standing: () => w.standing,
        now: () => NOW,
        home: w.home,
        codexEndpoint: {
          alive: (pid) => pid === 700,
          commandOf: forbidCommandOf,
          startOf: () => null,
          isSocket: (path) => path === w.socket.path,
        },
      });
      expect(codeC1).toBe(1);
      expect(ioC1.out).toContain(`difference: ${SEAT}:`);
      expect(ioC1.out).toContain('cannot tell');
      expect(ioC1.out).toContain(`repair: team restart ${SEAT}`);

      updateState(w.dir, (state) => {
        const seat = state.sessions[SESSION]!.seats[SEAT]!;
        seat.codex_endpoint = {
          url: w.socket.url,
          binding: BINDING,
          pid: 700,
          started_at: T0,
        };
      });
      const ioC2 = testIo(w.root, { kind: 'owner' });
      const codeC2 = runTeamCheck({ file: '.agents/team.yaml' }, ioC2, {
        live: () => w.live,
        branch: () => 'main',
        standing: () => w.standing,
        now: () => NOW,
        home: w.home,
        codexEndpoint: {
          alive: (pid) => pid === 700,
          commandOf: forbidCommandOf,
          startOf: () => T0_MS,
          isSocket: (path) => path === w.socket.path,
        },
      });
      expect(codeC2).toBe(1);
      expect(ioC2.out).toContain(`difference: ${SEAT}:`);
      expect(ioC2.out).toContain('cannot tell');
      expect(ioC2.out).toContain(`repair: team restart ${SEAT}`);

      // Scene D: when the endpoint record, its config, socket liveness, pid start time, and recorded
      // remote all match, team check reports 0 endpoint differences and never calls commandOf.
      updateState(w.dir, (state) => {
        const seat = state.sessions[SESSION]!.seats[SEAT]!;
        seat.codex_endpoint = {
          url: w.socket.url,
          binding: BINDING,
          pid: 700,
          started_at: T0,
          config: expectedConfig,
        };
      });
      const ioD = testIo(w.root, { kind: 'owner' });
      runTeamCheck({ file: '.agents/team.yaml' }, ioD, {
        live: () => w.live,
        branch: () => 'main',
        standing: () => w.standing,
        now: () => NOW,
        home: w.home,
        codexEndpoint: {
          alive: (pid) => pid === 700,
          commandOf: forbidCommandOf,
          startOf: () => T0_MS,
          isSocket: (path) => path === w.socket.path,
        },
      });
      expect(ioD.out).not.toContain('unmanaged');
      expect(ioD.out).not.toContain('cannot tell');
      expect(ioD.out).not.toContain(`repair: team restart ${SEAT}`);
    } finally {
      rmSync(w.base, { recursive: true, force: true });
    }
  });
});
