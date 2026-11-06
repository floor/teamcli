// Launch, restore, and reload epoch and placement contract for `team mcp serve`:
// 1. At launch, a managed Codex seat's `codex app-server` is started detached (`PPID 1`, outside
//    herdr) with `-c mcp_servers.team_inbox.args=[...,"--epoch","<epoch>"]` extracted from the
//    launch line (`codexEndpointConfig`). When `codex --remote <url>` attaches during `case 'idle'`
//    before `case 'rename'` names the pane in herdr, `app-server` spawns `team mcp serve`:
//    `placeCaller` / `runMcpServe` places the caller as that seat while herdr lists the pane
//    unnamed (`name: null`) or `paneRootPid` vouches for the pane, and refuses a pane named for
//    another seat or unknown to herdr.
// 2. At restore / `team up`, a ready Codex seat (`verdict === 'same'`, such as a pane adopted
//    after a host restore or one whose app-server died while its TUI stayed alive) whose recorded
//    managed endpoint is provably dead is relaunched in place with a fresh managed endpoint and a
//    fresh `--epoch` on its launch line and endpoint config.
// 3. At `team reload <seat>`, when the seat already matches the file (with or without a recorded
//    model), the general seat brief is delivered before `registerInbox` writes the MCP config, so
//    the registered server carries the claim's `--epoch` and `runMcpServe` serves the inbox.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { CallerSources } from '../src/caller.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runReload } from '../src/commands/reload.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { codexEndpointSocket, type ManagedEndpointRead } from '../src/launch/codex-endpoint.ts';
import { currentBriefClaim } from '../src/launch/general-brief.ts';
import { codexEndpointConfig } from '../src/launch/plan.ts';
import { listenerPath, receiptPath } from '../src/mcp/inbox.ts';
import { registerInbox } from '../src/mcp/register.ts';
import { runMcpServe, type ServeOptions } from '../src/mcp/serve.ts';
import { launchCommand, profileFor } from '../src/profiles/profile.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { signRecord } from '../src/send/record.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, shortSocketBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T04:00:00.000Z');
const SESSION = 'acme';
const SEAT = 'worker';
const HANDLE = 'seat_0123456789ab';
const BINDING = 'prs_0123456789ab';
const THREAD = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const PANE = 'pane-worker';
const WORKSPACE = 'ws-worker';
const LAUNCHED = { shell: 100, cli: [200] };
const LIVE_PROCESS: PaneProcesses = { shell: 100, foreground: [200] };
const APP_URL = 'unix:///private/tmp/scene-app.sock';
const EPOCH = 'run_42a1bc08d357';

const CODEX_IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');
const GROK_IDLE = readFileSync(new URL('./fixtures/grok/1.0.52/idle.txt', import.meta.url), 'utf8');

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv(),
  });
}

function teamText(cli: 'codex' | 'grok' = 'codex'): string {
  const workerBlock = cli === 'codex'
    ? `  - role: implementer
    name: ${SEAT}
    label: ${SEAT}
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol`
    : `  - role: implementer
    name: ${SEAT}
    label: ${SEAT}
    cli: grok
    vendor: xai
    model: Grok
    version: "4.7"
    launch: grok`;
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
delivery_order: [mcp-inbox, drop]
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
    human: true
${workerBlock}
`;
}

function writeApprovedTeam(cli: 'codex' | 'grok' = 'codex', ownFolder?: string): string {
  const text = ownFolder === undefined ? teamText(cli) : teamText(cli)
    .replace('    cli: grok\n', `    cli: grok\n    cwd: ${JSON.stringify(relative(root, ownFolder))}\n`)
    .replace('delivery_order:', `trust: [${JSON.stringify(relative(root, ownFolder))}]\ndelivery_order:`);
  const file = join(dir, 'team.yaml');
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
  return file;
}

function ownedUrl(): string {
  const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING);
  if (socket === null) throw new Error('the fixture state folder is too long for an owned endpoint path');
  return socket.url;
}

function writeSignedDrop(body: string): { dropDir: string; id: string } {
  const dropDir = join(dir, 'send-drops', SESSION, SEAT);
  const id = randomUUID();
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dropDir, id),
    `${JSON.stringify(signRecord({
      kind: 'message',
      id,
      to: SEAT,
      to_id: null,
      from: 'lead',
      from_id: null,
      root,
      session: SESSION,
      at: NOW.toISOString(),
      body,
      rule: 'synthetic sender',
      thread: id,
    }, home))}\n`,
    { mode: 0o600 },
  );
  return { dropDir, id };
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

async function runServeCalls(
  io: ReturnType<typeof testIo>,
  options: ServeOptions,
  requests: string[],
): Promise<{ code: number; replies: any[]; err: string }> {
  const replies: any[] = [];
  const code = await runMcpServe(
    options,
    io,
    {
      lines: (async function* () {
        for (const line of requests) yield line;
      })(),
      write: (line) => {
        replies.push(JSON.parse(line));
      },
    },
    {
      home,
      build: { version: '0.0.0-fixture', build: 'fixture', builtAt: 0, head: null },
      restart: () => {
        throw new Error('unexpected install restart');
      },
    },
  );
  return { code, replies, err: io.err };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(shortSocketBase(), 'cmse-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('codex mcp serve epoch across launch, restore, and reload', () => {
  test.each(['unnamed-pane', 'unlisted-vouched-pane'] as const)(
    'at launch: managed Codex app-server spawns team mcp serve before rename (%s) and serves with its launch epoch',
    async (stage) => {
      const file = writeApprovedTeam('codex');
      updateState(dir, (state) => {
        const one = (state.sessions[SESSION] ??= emptySession());
        one.seats[SEAT] = {
          stage: 'launched',
          pane: PANE,
          workspace: WORKSPACE,
          start_cwd: root,
          presence_binding: BINDING,
          codex_endpoint: { url: ownedUrl(), binding: BINDING, pid: 900, started_at: NOW.toISOString() },
        };
        one.briefs = {
          [SEAT]: {
            id: randomUUID(),
            at: NOW.toISOString(),
            incarnation: 'inc_039bca7210fe',
            epoch: EPOCH,
            sha256: 'd'.repeat(64),
            stage: 'claimed',
          },
        };
      });
      const profile = profileFor('codex')!;
      const line = launchCommand(profile, 'codex -m gpt-6.1-sol', 'Synthetic rules.', undefined, {
        command: 'synthetic-runner',
        entry: 'synthetic-entry',
        seat: SEAT,
        session: SESSION,
        file,
        epoch: EPOCH,
      });
      const endpointFlags = codexEndpointConfig(line);
      const argsPair = endpointFlags.find((item) => item.startsWith('mcp_servers.team_inbox.args='));
      expect(argsPair).toBeDefined();
      const args = JSON.parse(argsPair!.slice(argsPair!.indexOf('=') + 1)) as string[];
      const flag = (name: string) => {
        const index = args.indexOf(name);
        return index < 0 ? undefined : args[index + 1];
      };
      expect(flag('--epoch')).toBe(EPOCH);

      const { dropDir, id } = writeSignedDrop('launch message body');
      const io = testIo(root);
      io.env = { HERDR_PANE_ID: PANE };
      // Detached `codex app-server` (PID 900, PPID 1): no `herdr` process in ancestors.
      io.callerSources = (asked): CallerSources => ({
        ancestors: () => [{ pid: 910, name: 'node' }, { pid: 900, name: 'codex' }, { pid: 1, name: 'launchd' }],
        agents: () =>
          asked === SESSION && stage === 'unnamed-pane'
            ? [{ name: null, agent: 'codex', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: root }]
            : [],
        paneRootPid: (pane) => (asked === SESSION && pane === PANE ? 100 : null),
        env: io.env,
        stdinIsTTY: false,
        managedEndpointSeat: (pid) => (pid === 900 ? { session: SESSION, seat: SEAT, pane: PANE } : null),
      });

      const out = await runServeCalls(
        io,
        { seat: flag('--seat'), session: flag('--session'), file: flag('--file'), epoch: flag('--epoch') },
        [toolCall('check-1', 'inbox_check'), toolCall('read-1', 'inbox_read', { id })],
      );
      expect(out.code, out.err).toBe(0);
      expect(out.err).toBe('');
      expect(out.replies).toHaveLength(2);
      expect(JSON.stringify(out.replies[0])).toContain(id);
      expect(JSON.stringify(out.replies[1])).toContain('launch message body');
      expect(existsSync(receiptPath(dropDir, id))).toBe(true);
      expect(existsSync(listenerPath(dropDir))).toBe(false);
    },
  );

  test('at restore / team up: a ready Codex seat (verdict === same) whose managed endpoint is dead is relaunched in place with a fresh endpoint and epoch', async () => {
    writeApprovedTeam('codex');
    updateState(dir, (state) => {
      const held = (state.sessions[SESSION] ??= emptySession());
      held.seats[SEAT] = {
        stage: 'ready',
        id: HANDLE,
        pane: PANE,
        workspace: WORKSPACE,
        launched: LAUNCHED,
        agent_session: THREAD,
        presence_binding: BINDING,
        codex_endpoint: { url: ownedUrl(), binding: BINDING, pid: 4242, started_at: NOW.toISOString() },
      };
    });
    registerAgent(home, {
      name: SEAT,
      signing: { model: 'GPT Sol', version: '6.1', role: 'implementer' },
      lab: 'openai',
      cli: 'codex',
      launcher: null,
      launch: 'codex -m gpt-6.1-sol',
      reach: {
        team: teamIdOf(root),
        seat: SEAT,
        session: SESSION,
        pane: PANE,
        address: null,
        agent_session: THREAD,
      },
      seat_handle: HANDLE,
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    });

    const typed: string[] = [];
    const runs: { pane: string; command: string }[] = [];
    const managedCalls: { dir: string; seat: string; config?: string[] }[] = [];
    let exited = false;
    const agents = (): HerdrAgent[] => [{
      name: SEAT,
      agent: 'codex',
      pane: PANE,
      workspace: WORKSPACE,
      status: 'idle',
      cwd: root,
      session: THREAD,
    }];
    const launch: Launch = {
      sessionState: () => 'running',
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => ({ pane: 'made-1', workspace: 'ws-1' }),
      paneRun(_session, pane, command) {
        runs.push({ pane, command });
        exited = false;
        return true;
      },
      typeText(_session, pane, text) {
        typed.push(text);
        if (pane === PANE && text === '/exit') exited = true;
        return true;
      },
      pressEnter: () => true,
      sendKey: () => true,
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [PANE],
      agents,
      workspacePanes: (_session, workspace) => (workspace === WORKSPACE ? [PANE] : null),
      paneText: () => CODEX_IDLE,
      foreground: () => (exited ? ['zsh'] : ['codex']),
      processInfo: (_session, pane) => {
        if (pane === PANE && exited) return { shell: LIVE_PROCESS.shell, foreground: [LIVE_PROCESS.shell] };
        return LIVE_PROCESS;
      },
      codexEndpoint: {
        async managed(input): Promise<ManagedEndpointRead> {
          managedCalls.push({ dir: input.dir, seat: input.seat, ...(input.config === undefined ? {} : { config: input.config }) });
          return { kind: 'up', url: APP_URL, started: true };
        },
        stop: () => ({ stopped: true }),
      },
      sleep: async () => {},
      now: () => NOW,
    };
    const doctor: DoctorSources = {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => true,
      now: () => NOW,
      home,
    };
    const upSources: UpSources = {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents,
      workspaces: () => [{ id: WORKSPACE, label: SEAT }],
      home,
      doctor,
      launch,
      now: () => NOW,
      codexEndpoint: {
        alive: () => false,
        startOf: () => NOW.getTime() - 30_000,
        isSocket: () => false,
      },
    };

    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, upSources), io.out + io.err).toBe(0);
    expect(typed).toEqual(['/exit']);
    const seatRuns = runs.filter((run) => run.pane === PANE);
    expect(seatRuns).toHaveLength(1);
    expect(seatRuns[0]!.command).toContain(`resume ${THREAD}`);
    expect(seatRuns[0]!.command).toContain(`--remote ${APP_URL}`);

    const claim = currentBriefClaim(readState(dir).sessions[SESSION]?.briefs?.[SEAT]);
    expect(claim).not.toBeNull();
    expect(seatRuns[0]!.command).toContain(claim!.epoch);
    expect(managedCalls).toHaveLength(1);
    expect(managedCalls[0]!.config?.some((entry) => entry.includes(claim!.epoch))).toBe(true);
  });

  test.each([true, false])(
    'at reload (recordedModel=%s): delivers the general seat brief before registering the inbox so the config carries --epoch',
    async (withRecordedModel) => {
      const ownFolder = join(base, 'worker');
      mkdirSync(ownFolder, { mode: 0o700 });
      const file = writeApprovedTeam('grok', ownFolder);
      updateState(dir, (state) => {
        const held = (state.sessions[SESSION] ??= emptySession());
        held.seats[SEAT] = {
          stage: 'ready',
          pane: PANE,
          workspace: WORKSPACE,
          cli: 'grok',
          start_cwd: ownFolder,
          launched: LAUNCHED,
          ...(withRecordedModel ? { model: 'Grok', version: '4.7', launch_line: 'grok' } : {}),
        };
      });

      const addCalls: string[][] = [];
      const launch: Launch = {
        sessionState: () => 'running',
        startServer: () => true,
        sessionUp: () => true,
        createWorkspace: () => ({ pane: 'new-pane', workspace: 'new-ws' }),
        paneRun: () => true,
        registerInbox: (cli, seat, cwd, sessionArg, teamFile) =>
          registerInbox({
            cli,
            seat,
            cwd,
            ...(sessionArg === undefined ? {} : { session: sessionArg }),
            ...(teamFile === undefined ? {} : { file: teamFile }),
            home,
            run: (_command, argv, at) => {
              addCalls.push([...argv]);
              const split = argv.indexOf('--');
              mkdirSync(join(at, '.grok'), { recursive: true });
              writeFileSync(
                join(at, '.grok', 'config.toml'),
                `[mcp_servers.team-inbox]\ncommand = ${JSON.stringify(argv[split - 1])}\nargs = ${JSON.stringify(argv.slice(split + 1))}\n`,
              );
              return { code: 0 };
            },
          }),
        renameAgent: () => true,
        closeWorkspace: () => true,
        agentPanes: () => [PANE],
        agents: () => [{ name: SEAT, agent: 'grok', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: ownFolder }],
        paneText: () => GROK_IDLE,
        foreground: () => ['grok'],
        processInfo: () => LIVE_PROCESS,
        sleep: async () => {},
        now: () => NOW,
      };

      const reloadIo = testIo(root, { kind: 'owner' });
      const code = await runReload([SEAT, '--file', file], reloadIo, { launch, home, now: () => NOW });
      expect(code, reloadIo.out + reloadIo.err).toBe(0);
      expect(reloadIo.out).toContain('already running what the file declares');

      const claim = currentBriefClaim(readState(dir).sessions[SESSION]?.briefs?.[SEAT]);
      expect(claim).not.toBeNull();
      expect(addCalls).toHaveLength(1);
      const registeredArgs = addCalls[0]!.slice(addCalls[0]!.indexOf('--') + 1);
      const flag = (name: string) => {
        const index = registeredArgs.indexOf(name);
        return index < 0 ? undefined : registeredArgs[index + 1];
      };
      expect(flag('--epoch')).toBe(claim!.epoch);

      const { dropDir, id } = writeSignedDrop('reload message body');
      const serveIo = testIo(ownFolder);
      serveIo.env = { HERDR_PANE_ID: PANE };
      serveIo.callerSources = (asked): CallerSources => ({
        ancestors: () => [{ pid: 302, name: 'node' }, { pid: 301, name: 'grok' }, { pid: 300, name: 'zsh' }, { pid: 10, name: 'herdr' }, { pid: 1, name: 'launchd' }],
        agents: () => (asked === SESSION ? [{ name: SEAT, agent: 'grok', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: ownFolder }] : []),
        paneRootPid: (pane) => (asked === SESSION && pane === PANE ? 300 : null),
        env: serveIo.env,
        stdinIsTTY: false,
      });

      const out = await runServeCalls(
        serveIo,
        { seat: flag('--seat'), session: flag('--session'), file: flag('--file') ?? file, epoch: flag('--epoch') },
        [toolCall('read-reload', 'inbox_read', { id })],
      );
      expect(out.code, out.err).toBe(0);
      expect(JSON.stringify(out.replies[0])).toContain('reload message body');
      expect(existsSync(receiptPath(dropDir, id))).toBe(true);
    },
  );
});
