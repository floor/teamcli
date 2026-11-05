import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runTeamCheck, type CodexEndpointCheckSources } from '../src/check/team.ts';
import type { CodexEndpointRecord } from '../src/daemon/presence/endpoint-record.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { codexEndpointSocket, ensureCodexEndpoint } from '../src/launch/codex-endpoint.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { codexCommandHasFlag, codexCommandRemoteUrl, upPlan, type Step, type UpSeat } from '../src/launch/plan.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { deliverBriefs, shortSocketBase, testIo } from './helpers.ts';

// All processes, sockets, hosts, homes, and server starts below are synthetic.
const SESSION = 'acme';
const SEAT = 'worker';
const BINDING = 'prs_123456789abc';
const THREAD = '12345678-1234-4234-9234-123456789abc';
const NOW = new Date('2026-11-05T08:00:00.000Z');
const CONFIG = ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '-c', 'model_reasoning_effort=low'];
let base: string;
let originalXdg: string | undefined;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(shortSocketBase(), 'cmi-')));
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(base, 'config');
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  rmSync(base, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = join(base, '.agents');
  updateState(dir, (state) => {
    const session = state.sessions[SESSION] ??= emptySession();
    session.seats[SEAT] = { stage: 'ready', presence_binding: BINDING };
  });
  return dir;
}

function fakeHost(lines: string[], managed?: Host['managedCodexEndpoint']): Host {
  return {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'pane-2', workspace: 'w2' }),
    paneRun: (_session, _pane, line) => { lines.push(line); return true; },
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
    say: () => {},
    log: () => {},
  };
}

async function plannedLaunch(launch: string, options: {
  resume?: boolean;
  daemon?: 'on' | 'off';
  managed?: Host['managedCodexEndpoint'];
  dir: string;
}): Promise<string | null> {
  const seat: UpSeat = {
    name: SEAT, cli: 'codex', launch, cwd: base, label: SEAT,
    repairLine: 'team restart worker', stopped: false, rules: 'Synthetic rules.',
    codexDaemon: options.daemon ?? 'on',
    ...(options.resume ? { resume: THREAD } : {}),
  };
  const plan = upPlan({
    root: base, session: SESSION, sessionRunning: true, seats: [seat],
    watchAlive: true, watchLabel: 'Watch', stateDir: options.dir,
  });
  const launchStep = plan.find((step) => step.do?.do === 'launch');
  expect(launchStep).toBeDefined();
  const create: Step = {
    kind: 'run', argv: ['herdr', 'workspace', 'create'],
    do: { do: 'create', seat: SEAT, label: SEAT, cwd: base, repairLine: 'team restart worker', watcher: 'none' },
  };
  const lines: string[] = [];
  await executePlan([create, launchStep!], SESSION, fakeHost(lines, options.managed));
  if (lines.length === 0) return null;
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

describe('independent managed endpoint launch contract', () => {
  test.each([
    ["sh -c 'codex --ask-for-approval=never --sandbox=read-only -c model_reasoning_effort=low'", "'"],
    ['zsh -lc "codex -anever -sread-only -c model_reasoning_effort=low"', '"'],
  ])('quoted wrapper routes start settings to the app-server: %s', async (launch, quote) => {
    const dir = stateDir();
    const spawned: { url: string; config?: string[] }[] = [];
    const line = await plannedLaunch(launch, {
      dir,
      managed: (input) => ensureCodexEndpoint({
        ...input,
        deps: {
          spawn: (server) => { spawned.push(server); return { pid: 901 }; },
          alive: () => true,
          commandOf: () => { throw new Error('no prior server in this scene'); },
          startOf: () => NOW.getTime(),
          terminate: () => { throw new Error('a successful fresh launch must not terminate'); },
          isPlainDir: () => true,
          isSocket: () => true,
          herdrEnv: () => null,
          drop: () => { throw new Error('nothing to drop'); },
          sleep: async () => {},
          now: () => NOW,
        },
      }),
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.config).toEqual(expect.arrayContaining(CONFIG));
    expect(readState(dir).sessions[SESSION]!.seats[SEAT]!.codex_endpoint?.config).toEqual(spawned[0]!.config);
    expect(line).not.toBeNull();
    if (line === null) return;
    expect(line.endsWith(`--remote ${spawned[0]!.url}${quote}`)).toBe(true);
    expect(codexCommandRemoteUrl(line)).toBe(spawned[0]!.url);
  });

  test.each(['same', 'missing', 'changed'] as const)('live server flags %s decide reuse, not the cached config alone', async (kind) => {
    const dir = stateDir();
    const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING)!;
    expect(socket).not.toBeNull();
    updateState(dir, (state) => {
      state.sessions[SESSION]!.seats[SEAT]!.codex_endpoint = {
        url: socket.url, binding: BINDING, pid: 811, started_at: NOW.toISOString(), config: CONFIG,
      };
    });
    const terminated: number[] = [];
    const starts: { url: string; config?: string[] }[] = [];
    const liveFlags = kind === 'same' ? CONFIG.join(' ')
      : kind === 'missing' ? '' : '-c approval_policy="on-request" -c sandbox_mode="workspace-write"';
    const result = await ensureCodexEndpoint({
      dir, session: SESSION, seat: SEAT, config: CONFIG,
      deps: {
        spawn: (input) => { starts.push(input); return { pid: 812 }; },
        alive: (pid) => !terminated.includes(pid),
        commandOf: () => `codex app-server --listen ${socket.url}${liveFlags ? ' '+liveFlags : ''}`,
        startOf: () => NOW.getTime(),
        terminate: (pid) => { terminated.push(pid); },
        isPlainDir: () => true, isSocket: () => true, drop: () => {},
        sleep: async () => {}, now: () => NOW,
      },
    });
    expect(result).toMatchObject({ kind: 'up', url: socket.url, started: kind !== 'same' });
    if (kind === 'same') {
      expect(terminated).toEqual([]);
      expect(starts).toEqual([]);
    } else {
      expect(terminated).toEqual([811]);
      expect(starts).toEqual([{ url: socket.url, config: CONFIG }]);
      expect(readState(dir).sessions[SESSION]!.seats[SEAT]!.codex_endpoint?.pid).toBe(812);
    }
  });

  for (const resume of [false, true]) {
    test.each(['managed', 'refused', 'no host', 'disabled'] as const)(`${resume ? 'resumed' : 'fresh'} launch has an owned remote or no daemon: %s`, async (kind) => {
      const dir = stateDir();
      const own = codexEndpointSocket(dir, SESSION, SEAT, BINDING)!.url;
      const managed: Host['managedCodexEndpoint'] = async (input) => {
        expect(input).toMatchObject({ dir, session: SESSION, seat: SEAT });
        return kind === 'managed' ? { kind: 'up', url: own, started: true }
          : { kind: 'unmanaged', why: 'synthetic start refusal' };
      };
      const line = await plannedLaunch("sh -c 'codex -a never -s read-only'", {
        dir, resume, daemon: kind === 'disabled' ? 'off' : 'on',
        ...(kind === 'no host' ? {} : { managed }),
      });
      if (kind === 'managed' || kind === 'disabled') {
        expect(line).not.toBeNull();
        if (resume) {
          expect(line).toContain('resume');
          expect(line).toContain(THREAD);
        }
      }
      if (kind === 'managed') {
        expect(codexCommandRemoteUrl(line ?? '')).toBe(own);
        expect(line).not.toContain('--no-daemon');
      } else if (kind === 'disabled') {
        expect(codexCommandRemoteUrl(line ?? '')).toBeNull();
        expect(line).toContain('--no-daemon');
        expect(codexCommandHasFlag(line ?? '', '--no-daemon')).toBe(true);
      } else {
        expect(line).toBeNull();
      }
    });
  }
});

const TEAM = `format: 1
project: acme
operator: lead
workspace:
  mode: shared
seats:
  - name: lead
    role: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - name: worker
    role: tester
    cli: codex
    vendor: openai
    model: GPT
    version: "5.4"
    launch: codex -a never -s read-only -c model_reasoning_effort=low
`;

function checkWorld() {
  const root = join(base, 'repo');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(join(dir, 'rules'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), TEAM);
  writeFileSync(join(dir, 'rules', `${SEAT}.md`), 'Synthetic rules.\n');
  const parsed = validateTeamFile(TEAM);
  if (!parsed.ok) throw new Error('invalid synthetic team');
  const standing = verifiedOf(parsed.team, TEAM, root, NOW);
  deliverBriefs({ dir, root, session: SESSION, seats: ['lead', SEAT], home, at: NOW.toISOString() });
  const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING)!;
  const record: CodexEndpointRecord = { url: socket.url, binding: BINDING, pid: 811, started_at: NOW.toISOString(), config: CONFIG };
  const live: Live = {
    running: true,
    agents: [
      { name: 'lead', agent: 'claude', pane: 'pane-1', workspace: 'w1', status: 'idle', cwd: root },
      { name: SEAT, agent: 'codex', pane: 'pane-2', workspace: 'w2', status: 'idle', cwd: root },
    ],
    workspaces: [{ id: 'w1', label: 'lead · orchestrator' }, { id: 'w2', label: 'worker · tester' }],
    screens: {},
    processes: { 'pane-1': { shell: 100, foreground: [101] }, 'pane-2': { shell: 200, foreground: [201] } },
  };
  updateState(dir, (state) => {
    const session = state.sessions[SESSION] ??= emptySession();
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats.lead = { stage: 'ready', pane: 'pane-1', workspace: 'w1', cli: 'claude-code', launch_line: 'claude', launched: { shell: 100, cli: [101] } };
    session.seats[SEAT] = {
      stage: 'ready', pane: 'pane-2', workspace: 'w2', cli: 'codex', presence_binding: BINDING,
      launch_line: `codex -a never -s read-only -c model_reasoning_effort=low --remote ${socket.url}`,
      launched: { shell: 200, cli: [201] }, codex_endpoint: record,
    };
  });
  const facts: CodexEndpointCheckSources = {
    alive: () => true, isSocket: () => true, startOf: () => NOW.getTime(),
  };
  function check(overrides: CodexEndpointCheckSources = {}) {
    let commandReads = 0;
    const io = testIo(root, { kind: 'owner' });
    runTeamCheck({ file: '.agents/team.yaml' }, io, {
      live: () => live, standing: () => standing, home, branch: () => 'main', now: () => NOW,
      codexEndpoint: { ...facts, ...overrides, commandOf: () => { commandReads++; throw new Error('diagnostics must not read process command lines'); } },
    });
    expect(commandReads).toBe(0);
    return {
      output: io.out,
      endpoint: io.out.split('\n').filter((line) => line.startsWith(`difference: ${SEAT}:`)
        && (line.includes('Codex server') || line.includes('app-server pid'))),
    };
  }
  return { dir, socket, record, check };
}

describe('independent diagnostics use recorded facts, never process command lines', () => {
  test('a healthy recorded endpoint and an explicit no-daemon launch need no endpoint repair', () => {
    const w = checkWorld();
    expect(w.check().endpoint).toEqual([]);
    updateState(w.dir, (s) => {
      const seat = s.sessions[SESSION]!.seats[SEAT]!;
      delete seat.codex_endpoint;
      seat.launch_line = 'codex --no-daemon';
    });
    expect(w.check().endpoint).toEqual([]);
  });

  test.each(['no record', 'foreign remote', 'missing flags', 'different process start', 'dead pid', 'dead socket'] as const)('names the affected seat and restart for an unmanaged server: %s', (kind) => {
    const w = checkWorld();
    updateState(w.dir, (s) => {
      const seat = s.sessions[SESSION]!.seats[SEAT]!;
      if (kind === 'no record') delete seat.codex_endpoint;
      if (kind === 'foreign remote') seat.launch_line = 'codex --remote unix:///synthetic-foreign.sock';
      if (kind === 'missing flags') seat.codex_endpoint = { ...w.record, config: [] };
    });
    const result = w.check({
      ...(kind === 'dead pid' ? { alive: () => false } : {}),
      ...(kind === 'dead socket' ? { isSocket: () => false } : {}),
      ...(kind === 'different process start' ? { startOf: () => NOW.getTime() + 60_000 } : {}),
    });
    expect(result.endpoint).toHaveLength(1);
    expect(result.endpoint[0]).toContain('unmanaged Codex server');
    expect(result.output).toContain('repair: team restart worker');
  });

  test.each(['unknown start', 'missing start source', 'missing socket source', 'missing config', 'missing launch evidence'] as const)('reports cannot tell instead of guessing: %s', (kind) => {
    const w = checkWorld();
    updateState(w.dir, (s) => {
      const seat = s.sessions[SESSION]!.seats[SEAT]!;
      if (kind === 'missing config') seat.codex_endpoint = { ...w.record, config: undefined };
      if (kind === 'missing launch evidence') { delete seat.launch_line; delete seat.codex_endpoint; }
    });
    const result = w.check({
      ...(kind === 'unknown start' ? { startOf: () => null } : {}),
      ...(kind === 'missing start source' ? { startOf: undefined } : {}),
      ...(kind === 'missing socket source' ? { isSocket: undefined } : {}),
    });
    expect(result.endpoint).toHaveLength(1);
    expect(result.endpoint[0]).toContain('cannot tell');
    expect(result.endpoint[0]).not.toContain('unmanaged');
    expect(result.output).toContain('repair: team restart worker');
  });
});
