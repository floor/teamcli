// The managed Codex endpoint and the pane-less watch a stop may meet: what `team down` stops,
// what it leaves alone, what a removal must stop before it drops a record, how a live endpoint is
// reused under a launch's configuration, and what a failed presence-binding mint does to a launch.
// Command-level scenes drive the shipped `down` and `remove` with injected measurements;
// launch-level scenes drive `ensureCodexEndpoint` and `launchCodexEndpoint` the same way. No
// process is read, started or signalled.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalOf } from '../../src/approve/approval.ts';
import { realSources as downSources, runDown, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { codexEndpointSocket, ensureCodexEndpoint, launchCodexEndpoint, stopSeatCodexEndpoint } from '../../src/launch/codex-endpoint.ts';
import { emptySession, LOCK_FILE, readState, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import type { EndpointStopRead } from '../../src/launch/codex-endpoint.ts';
import { gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-15T11:30:00Z');
const owner = { kind: 'owner' } as const;
const leadSeat = { kind: 'seat', name: 'lead', pane: 'fixture-pane-1', session: 'acme' } as const;
const FILE = ['--file', '.agents/team.yaml'];
const BINDING = 'prs_ab12cd34ef56';
const OTHER = 'prs_ffffffffffff';
const ENDPOINT = {
  url: `unix:///tmp/acme/run/acme/worker/${BINDING}.sock`,
  binding: BINDING,
  pid: 4242,
  started_at: '2026-10-15T11:00:00Z',
};
const EPOCH = `watch_${'b'.repeat(32)}`;
const WATCH_STARTED = '2026-10-15T11:29:50Z';
const WATCH_START_MS = Date.parse(WATCH_STARTED);
// This install's own CLI entry, as the watch proof resolves it: the proof compares the real path of
// the entry word against the script this process loaded and the entry beside the watch module, so a
// scene that means "this team's watch" must name a path that resolves to this worktree's entry.
const CLI_ENTRY = realpathSync(fileURLToPath(new URL('../../src/cli.ts', import.meta.url)));
const WATCH_COMMAND = `node ${CLI_ENTRY} watch --session acme`;

// ---------------------------------------------------------------- the down scenes' world

type Place = { base: string; root: string; home: string; file: string; dir: string };

const LEAD = `  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function teamText(workerCli = 'claude-code', workerName = 'claude', workerModel = 'Claude Opus'): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
${LEAD}  - role: implementer
    name: worker
    label: worker
    cli: ${workerCli}
    vendor: ${workerCli === 'codex' ? 'openai' : 'anthropic'}
    model: ${workerModel}
    version: "5.5"
    launch: ${workerName} --model test-model
`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function layout(workerCli = 'claude-code', workerName = 'claude', workerModel = 'Claude Opus'): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 't1-a3-down-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  const file = join(root, '.agents', 'team.yaml');
  const text = teamText(workerCli, workerName, workerModel);
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
  return { base, root, home, file, dir: join(root, '.agents') };
}

function seedSeat(at: Place, seat: Record<string, unknown>): void {
  updateState(at.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.worker = seat as never;
  });
}

function seedWatch(at: Place, watch: Record<string, unknown>): void {
  updateState(at.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watch = watch as never;
  });
}

function seedBus(at: Place, workspace: string): void {
  updateState(at.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.bus = { pane: 'fixture-pane-2', workspace, started: '2026-10-15T11:00:00Z' } as never;
  });
}

const agent = (cli = 'claude'): HerdrAgent => ({
  name: 'worker', agent: cli, pane: 'fixture-pane-1', workspace: 'w1', status: 'idle', cwd: null,
});

function launchOf(over: Partial<DownLaunch> = {}): DownLaunch {
  return {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => [],
    closeWorkspace: () => true,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
    ...over,
  };
}

function sourcesOf(
  at: Place,
  stops: { dir: string; session: string; seat: string; recordPresent: boolean }[],
  kills: number[],
  over: Partial<DownSources> = {},
  stop?: (seen: { dir: string; session: string; seat: string }) => EndpointStopRead,
): DownSources {
  return {
    sessionRunning: () => true,
    agents: () => [agent()],
    alive: () => true,
    commandOf: (pid) => (pid === 4242 ? WATCH_COMMAND : null),
    startOf: (pid) => (pid === 4242 ? WATCH_START_MS : null),
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['zsh'],
    shellBack: () => true,
    foregroundCwd: () => null,
    now: () => NOW,
    sleep: async () => {},
    home: at.home,
    launch: launchOf({ kill: (pid) => { kills.push(pid); return true; } }),
    ...(stop === undefined
      ? {}
      : {
          codexEndpoint: {
            stop: (seen) => {
              const recordPresent = readState(at.dir).sessions.acme?.seats?.worker?.codex_endpoint !== undefined;
              stops.push({ ...seen, recordPresent });
              return stop(seen);
            },
          },
        }),
    ...over,
  };
}

let places: Place[] = [];
function place(workerCli = 'claude-code', workerName = 'claude', workerModel = 'Claude Opus'): Place {
  const made = layout(workerCli, workerName, workerModel);
  places.push(made);
  return made;
}
afterEach(() => {
  for (const made of places) rmSync(made.base, { recursive: true, force: true });
  places = [];
});

function stateSeat(at: Place) {
  return readState(at.dir).sessions.acme?.seats?.worker;
}

/** A path named `team` resolving to this worktree's own CLI entry: the installed executable shape. */
function teamLink(at: Place): string {
  const bin = join(at.base, 'bin');
  mkdirSync(bin);
  const link = join(bin, 'team');
  symlinkSync(CLI_ENTRY, link);
  return link;
}

async function down(at: Place, sources: DownSources, caller = owner, extra: string[] = []) {
  const io = testIo(at.root, caller);
  const code = await runDown([...FILE, ...extra], io, sources);
  return { code, out: io.out, err: io.err };
}

describe('down and a seat that records a managed endpoint', () => {
  test('the endpoint for the current binding is stopped before the seat record goes', async () => {
    const at = place();
    seedSeat(at, { stage: 'ready', pane: 'fixture-pane-1', workspace: 'w1', presence_binding: BINDING, codex_endpoint: { ...ENDPOINT } });
    const stops: { dir: string; session: string; seat: string; recordPresent: boolean }[] = [];
    const kills: number[] = [];
    const run = await down(at, sourcesOf(at, stops, kills, {}, () => ({ stopped: true })));
    expect(run.code).toBe(0);
    expect(stops).toEqual([{ dir: at.dir, session: 'acme', seat: 'worker', recordPresent: true }]);
    expect(stateSeat(at)).toBeUndefined();
    expect(run.err).not.toContain('endpoint');
  });

  test('a proof that refuses leaves the process alone, says why, and holds the seat', async () => {
    const at = place();
    seedSeat(at, { stage: 'ready', pane: 'fixture-pane-1', workspace: 'w1', presence_binding: BINDING, codex_endpoint: { ...ENDPOINT } });
    const stops: { dir: string; session: string; seat: string; recordPresent: boolean }[] = [];
    const kills: number[] = [];
    const run = await down(at, sourcesOf(at, stops, kills, {}, () => ({
      stopped: false,
      why: 'the recorded process cannot be proven to serve this endpoint; it was not signalled',
    })));
    // Nothing was signalled and the run holds: the whole seat record stays — the endpoint claim
    // and the presence binding included — so a later cleanup can still account for the process.
    expect(run.code).toBe(1);
    expect(stops).toHaveLength(1);
    expect(run.err).toContain('the recorded process cannot be proven');
    expect(run.err).toContain('its launch record was kept');
    expect(kills).toEqual([]);
    expect(stateSeat(at)?.codex_endpoint).toEqual(ENDPOINT);
    expect(stateSeat(at)?.presence_binding).toBe(BINDING);
  });

  test('a seat that records no endpoint is closed and never mentioned', async () => {
    const at = place();
    seedSeat(at, { stage: 'ready', pane: 'fixture-pane-1', workspace: 'w1', presence_binding: BINDING });
    const stops: { dir: string; session: string; seat: string; recordPresent: boolean }[] = [];
    const kills: number[] = [];
    // The real stop's refusal for a seat with no current-binding record: asking it at all would
    // put that line on the owner's terminal.
    const run = await down(at, sourcesOf(at, stops, kills, {}, () => ({
      stopped: false,
      why: 'the seat records no endpoint for its current binding',
    })));
    expect(run.code).toBe(0);
    expect(stops).toEqual([]);
    expect(run.err).not.toContain('records no endpoint');
    expect(stateSeat(at)).toBeUndefined();
  });

  test('an endpoint recorded for another binding is not this seat\'s and is not stopped', async () => {
    const at = place();
    seedSeat(at, {
      stage: 'ready', pane: 'fixture-pane-1', workspace: 'w1', presence_binding: BINDING,
      codex_endpoint: { ...ENDPOINT, binding: OTHER, url: `unix:///tmp/acme/run/acme/worker/${OTHER}.sock` },
    });
    const stops: { dir: string; session: string; seat: string; recordPresent: boolean }[] = [];
    const kills: number[] = [];
    const run = await down(at, sourcesOf(at, stops, kills, {}, () => ({ stopped: true })));
    expect(run.code).toBe(0);
    expect(stops).toEqual([]);
  });
});

describe('down and a watch whose pid is only in the state', () => {
  async function watchRun(over: {
    watch?: Record<string, unknown>;
    alive?: (pid: number) => boolean;
    commandOf?: (pid: number) => string | null;
    startOf?: (pid: number) => number | null;
    installedName?: boolean;
  } = {}) {
    const at = place();
    seedWatch(at, over.watch ?? { pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED });
    const commandOf = over.commandOf
      ?? (over.installedName === true ? (() => `${teamLink(at)} watch --session acme`) : undefined);
    const stops: { dir: string; session: string; seat: string; recordPresent: boolean }[] = [];
    const kills: number[] = [];
    const sources = sourcesOf(at, stops, kills, {
      agents: () => [],
      alive: over.alive ?? ((pid: number) => pid === 4242),
      ...(commandOf === undefined ? {} : { commandOf }),
      ...(over.startOf === undefined ? {} : { startOf: over.startOf }),
    });
    const run = await down(at, sources);
    return { ...run, kills, watchLeft: readState(at.dir).sessions.acme?.watch };
  }

  test('a proven pane-less watch is signalled, including one that started before its record', async () => {
    const run = await watchRun({ startOf: () => WATCH_START_MS - 90_000 });
    expect(run.code).toBe(0);
    expect(run.kills).toEqual([4242]);
    expect(run.out).toContain('watch: the stop signal was sent');
  });

  test('the installed entry name proves the same watch', async () => {
    const run = await watchRun({ installedName: true });
    expect(run.kills).toEqual([4242]);
  });

  test('a watch word further inside another program\'s arguments never proves that program', async () => {
    // The entry is the program at its fixed position, not any word that looks like a CLI later in
    // the line: this process runs an unrelated program whose argument happens to be a cli.js path
    // and the word `watch`.
    const run = await watchRun({
      commandOf: () => 'node /srv/unrelated-worker.js /opt/other/dist/cli.js watch --session acme',
    });
    expect(run.code).toBe(0);
    expect(run.kills).toEqual([]);
    expect(run.out).toContain("is not running this team's watch for session acme");
    expect(run.watchLeft).toEqual({ pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED });
  });

  test('a reused pid with another command is left alone and the record kept', async () => {
    const run = await watchRun({ commandOf: () => 'python3 /srv/watchdog.py' });
    expect(run.code).toBe(0);
    expect(run.kills).toEqual([]);
    expect(run.out).toContain("is not running this team's watch for session acme");
    expect(run.watchLeft).toEqual({ pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED });
  });

  test('a watch for another session, in the equals form, is not this team\'s', async () => {
    const run = await watchRun({ commandOf: () => `node ${CLI_ENTRY} watch --session=other` });
    expect(run.kills).toEqual([]);
    expect(run.watchLeft).toEqual({ pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED });
  });

  test('a start instant one millisecond past the two-second skew is not proven', async () => {
    const run = await watchRun({ startOf: () => WATCH_START_MS + 2_001 });
    expect(run.kills).toEqual([]);
    expect(run.out).toContain('started at a time its record does not match');
    expect(run.watchLeft).toEqual({ pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED });
  });

  test('a record with no start instant is left alone and kept', async () => {
    const run = await watchRun({ watch: { pid: 4242, heartbeat: NOW.toISOString() } });
    expect(run.kills).toEqual([]);
    expect(run.out).toContain('has no recorded start instant to match');
    expect(run.watchLeft).toEqual({ pid: 4242, heartbeat: NOW.toISOString() });
  });

  test('a record carrying an epoch names the session host and is never signalled', async () => {
    const run = await watchRun({ watch: { pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED, epoch: EPOCH } });
    expect(run.kills).toEqual([]);
    expect(run.out).not.toContain('watch: the stop signal was sent');
  });

  test('a record with a pane belongs to up and is not signalled here', async () => {
    const run = await watchRun({ watch: { pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED, pane: 'fixture-pane-9', workspace: 'w9' } });
    expect(run.kills).toEqual([]);
    expect(run.out).not.toContain('watch: the stop signal was sent');
  });

  test('a dead pid has nothing to stop', async () => {
    const run = await watchRun({ alive: () => false });
    expect(run.kills).toEqual([]);
    expect(run.out).not.toContain('watch: the stop signal was sent');
  });
});

describe('removing a seat whose endpoint record is present but unproven', () => {
  function endpointRecord(at: Place): Record<string, unknown> {
    // Measured, not assumed: the runtime temp folder can be deep, and the build refuses a socket
    // path over 100 bytes.
    expect(Buffer.byteLength(join(at.dir, 'run', 'acme', 'worker', `${BINDING}.sock`))).toBeLessThanOrEqual(100);
    const socket = codexEndpointSocket(at.dir, 'acme', 'worker', BINDING);
    if (socket === null) throw new Error('the scene names no endpoint socket');
    return {
      url: socket.url,
      binding: BINDING,
      pid: 4242,
      started_at: '2026-10-15T11:00:00Z',
      config: ['-c', 'approval_policy="never"'],
    };
  }

  function removeSources(
    at: Place,
    real: { terminations: number[]; socket?: boolean },
    over: Partial<RemoveSources> = {},
  ): RemoveSources {
    const url = endpointRecord(at).url as string;
    const stop = (seen: { dir: string; session: string; seat: string }): EndpointStopRead =>
      stopSeatCodexEndpoint(seen, {
        alive: (pid) => pid === 4242,
        commandOf: (pid) => (pid === 4242 ? `codex app-server --listen ${url}` : null),
        startOf: (pid) => (pid === 4242 ? Date.parse('2026-10-15T11:00:00Z') + 500 : null),
        isPlainDir: () => true,
        isSocket: () => real.socket ?? true,
        drop: () => {},
        terminate: (pid) => { real.terminations.push(pid); },
        sleep: async () => {},
      });
    return {
      ...downSources,
      home: at.home,
      sessionRunning: () => false,
      agents: () => [],
      screen: () => ({ kind: 'idle' }),
      screenText: () => undefined,
      status: () => 'idle',
      foreground: () => [],
      foregroundCwd: () => null,
      now: () => NOW,
      sleep: async () => {},
      codexEndpoint: { stop },
      ...over,
    };
  }

  async function remove(
    at: Place,
    args: string[],
    over: Partial<RemoveSources> = {},
    realExtra: { socket?: boolean } = {},
  ) {
    const real = { terminations: [] as number[], ...realExtra };
    const io = testIo(at.root, owner);
    const code = await runRemove(args, io, removeSources(at, real, over));
    return { code, out: io.out, err: io.err, terminations: real.terminations };
  }

  test('a record with no pid is unproven, not absent: the removal is refused and the record kept', async () => {
    const at = place();
    const record = endpointRecord(at);
    delete record.pid;
    seedSeat(at, { stage: 'ready', pane: 'fixture-pane-1', presence_binding: BINDING, codex_endpoint: record });
    const run = await remove(at, ['worker']);
    expect(run.code).toBe(1);
    expect(run.terminations).toEqual([]);
    expect(run.err).toContain('endpoint record cannot be read');
    expect(run.err).toContain('left as it is');
    expect(stateSeat(at)?.codex_endpoint).toBeDefined();
    expect(readFileSync(at.file, 'utf8')).toContain('name: worker');
  });

  test('a full record whose socket file is gone is stopped by pid, not read as already stopped', async () => {
    const at = place();
    seedSeat(at, { stage: 'ready', pane: 'fixture-pane-1', presence_binding: BINDING, codex_endpoint: endpointRecord(at) });
    const run = await remove(at, ['worker'], {}, { socket: false });
    expect(run.code).toBe(0);
    expect(run.terminations).toEqual([4242]);
    expect(stateSeat(at)).toBeUndefined();
    expect(readFileSync(at.file, 'utf8')).not.toContain('name: worker');
  });
});

describe('down and the event bus in the state', () => {
  test('a real stop closes the recorded workspace and clears the record', async () => {
    const at = place();
    seedSeat(at, { stage: 'ready', pane: 'fixture-pane-1', workspace: 'w1' });
    seedBus(at, 'w7');
    const stops: { dir: string; session: string; seat: string; recordPresent: boolean }[] = [];
    const kills: number[] = [];
    const closes: [string, string][] = [];
    const sources = sourcesOf(at, stops, kills, {
      agents: () => [],
      launch: launchOf({ closeWorkspace: (session, workspace) => { closes.push([session, workspace]); return true; } }),
    });
    const run = await down(at, sources);
    expect(run.code).toBe(0);
    expect(closes).toContainEqual(['acme', 'w7']);
    expect(run.out).toContain('bus: stopped');
    expect(readState(at.dir).sessions.acme?.bus).toBeUndefined();
  });

  test('a dry run prints the close and performs none of it', async () => {
    const at = place();
    seedSeat(at, { stage: 'ready', pane: 'fixture-pane-1', workspace: 'w1' });
    seedBus(at, 'w7');
    const stops: { dir: string; session: string; seat: string; recordPresent: boolean }[] = [];
    const kills: number[] = [];
    const closes: [string, string][] = [];
    const sources = sourcesOf(at, stops, kills, {
      agents: () => [],
      launch: launchOf({ closeWorkspace: (session, workspace) => { closes.push([session, workspace]); return true; } }),
    });
    const run = await down(at, sources, owner, ['--dry-run']);
    expect(run.code).toBe(0);
    expect(run.out).toContain('the event bus');
    expect(run.out).toContain('workspace close w7');
    expect(closes).toEqual([]);
    expect(readState(at.dir).sessions.acme?.bus).toBeDefined();
  });

  test('a refused run closes nothing and keeps the record', async () => {
    const at = place();
    seedSeat(at, { stage: 'ready', pane: 'fixture-pane-1', workspace: 'w1' });
    seedBus(at, 'w7');
    const stops: { dir: string; session: string; seat: string; recordPresent: boolean }[] = [];
    const kills: number[] = [];
    const closes: [string, string][] = [];
    const sources = sourcesOf(at, stops, kills, {
      agents: () => [],
      launch: launchOf({ closeWorkspace: (session, workspace) => { closes.push([session, workspace]); return true; } }),
    });
    // No --file: that flag itself is the owner's, and the refusal under test is the abandon one.
    const io = testIo(at.root, leadSeat);
    const code = await runDown(['--abandon'], io, sources);
    const run = { code, out: io.out, err: io.err };
    expect(run.code).toBe(1);
    expect(run.err).toContain('only the owner abandons a team');
    expect(closes).toEqual([]);
    expect(readState(at.dir).sessions.acme?.bus).toBeDefined();
  });
});

// ---------------------------------------------------------------- the launch scenes' world

const SESSION = 'teamcli';
const SEAT = 'builder-4';
const T0 = '2026-10-01T10:00:00.000Z';
const T0_MS = Date.parse(T0);
const SHORT_TMP = realpathSync(tmpdir());

function scratch(): string {
  return mkdtempSync(join(SHORT_TMP, 't1r2-'));
}

function seedBinding(dir: string, binding: string = BINDING): void {
  updateState(dir, (state) => {
    (state.sessions[SESSION] ??= emptySession()).seats[SEAT] = { stage: 'launched', presence_binding: binding } as never;
  });
}

function seedRecord(dir: string, record: Record<string, unknown>): void {
  updateState(dir, (state) => {
    (state.sessions[SESSION] ??= emptySession()).seats[SEAT] = {
      stage: 'launched', presence_binding: BINDING, codex_endpoint: record,
    } as never;
  });
}

function recordedAt(dir: string): unknown {
  return readState(dir).sessions[SESSION]?.seats[SEAT]?.codex_endpoint;
}

function ownedRecord(dir: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  // Measured, not assumed: the runtime temp folder can be deep, and the build refuses a socket
  // path over 100 bytes.
  expect(Buffer.byteLength(join(dir, 'run', SESSION, SEAT, `${BINDING}.sock`))).toBeLessThanOrEqual(100);
  const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING);
  if (socket === null) throw new Error('the scene names no endpoint socket');
  return { url: socket.url, binding: BINDING, pid: 700, started_at: T0, ...extra };
}

function launchDeps(prior: Record<string, unknown>, seen: {
  spawns: (string[] | undefined)[];
  terminations: number[];
  now?: () => Date;
}) {
  return {
    alive: () => true,
    commandOf: () => `codex app-server --listen ${prior.url as string}`,
    startOf: () => T0_MS + 500,
    isPlainDir: () => true,
    isSocket: () => true,
    drop: () => {},
    sleep: async () => {},
    now: seen.now ?? (() => new Date('2026-10-01T10:00:05.000Z')),
    spawn: (input: { config?: string[] }) => {
      seen.spawns.push(input.config);
      return { pid: 8_000 + seen.spawns.length };
    },
    terminate: (pid: number) => { seen.terminations.push(pid); },
  };
}

describe('ensuring the endpoint reuses a live server only under this launch\'s configuration', () => {
  test('the same words in the same order are reused with no spawn', async () => {
    const dir = scratch();
    try {
      const config = ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"'];
      const prior = ownedRecord(dir, { config });
      seedRecord(dir, prior);
      const seen = { spawns: [] as (string[] | undefined)[], terminations: [] as number[] };
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT, config, deps: launchDeps(prior, seen),
      });
      expect(answer).toEqual({ kind: 'up', url: prior.url as string, started: false });
      expect(seen.spawns).toEqual([]);
      expect(seen.terminations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the same pairs in another order are another configuration: stopped and replaced', async () => {
    const dir = scratch();
    try {
      const prior = ownedRecord(dir, {
        config: ['-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"'],
      });
      seedRecord(dir, prior);
      const config = ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"'];
      const seen = { spawns: [] as (string[] | undefined)[], terminations: [] as number[] };
      const answer = await ensureCodexEndpoint({
        dir, session: SESSION, seat: SEAT, config, deps: launchDeps(prior, seen),
      });
      expect(seen.terminations).toEqual([700]);
      expect(seen.spawns).toEqual([config]);
      expect(answer).toEqual({ kind: 'up', url: prior.url as string, started: true });
      expect(recordedAt(dir)).toMatchObject({ pid: 8001, config });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a quoting-only difference is another configuration: stopped and replaced', async () => {
    const dir = scratch();
    try {
      const prior = ownedRecord(dir, { config: ['-c', 'sandbox_mode=workspace-write'] });
      seedRecord(dir, prior);
      const config = ['-c', 'sandbox_mode="workspace-write"'];
      const seen = { spawns: [] as (string[] | undefined)[], terminations: [] as number[] };
      await ensureCodexEndpoint({ dir, session: SESSION, seat: SEAT, config, deps: launchDeps(prior, seen) });
      expect(seen.terminations).toEqual([700]);
      expect(seen.spawns).toEqual([config]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an empty named configuration is reused by an empty need', async () => {
    const dir = scratch();
    try {
      const prior = ownedRecord(dir, { config: [] });
      seedRecord(dir, prior);
      const seen = { spawns: [] as (string[] | undefined)[], terminations: [] as number[] };
      const answer = await ensureCodexEndpoint({ dir, session: SESSION, seat: SEAT, deps: launchDeps(prior, seen) });
      expect(answer).toEqual({ kind: 'up', url: prior.url as string, started: false });
      expect(seen.spawns).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a record that names no configuration is never reused, even when nothing is needed', async () => {
    const dir = scratch();
    try {
      const prior = ownedRecord(dir);
      seedRecord(dir, prior);
      const seen = { spawns: [] as (string[] | undefined)[], terminations: [] as number[] };
      const answer = await ensureCodexEndpoint({ dir, session: SESSION, seat: SEAT, deps: launchDeps(prior, seen) });
      expect(seen.terminations).toEqual([700]);
      expect(seen.spawns).toEqual([[]]);
      expect(answer).toEqual({ kind: 'up', url: prior.url as string, started: true });
      expect(recordedAt(dir)).toMatchObject({ pid: 8001, config: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unreadable config field reads as none: the endpoint stays stoppable and is replaced', async () => {
    const dir = scratch();
    try {
      const prior = ownedRecord(dir, { config: 'not-a-word-list' });
      seedRecord(dir, prior);
      const seen = { spawns: [] as (string[] | undefined)[], terminations: [] as number[] };
      await ensureCodexEndpoint({ dir, session: SESSION, seat: SEAT, deps: launchDeps(prior, seen) });
      expect(seen.terminations).toEqual([700]);
      expect(seen.spawns).toEqual([[]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the launch after a failed binding mint', () => {
  test('a binding that cannot be recorded makes the launch unmanaged and reuses nothing', async () => {
    const dir = scratch();
    try {
      const prior = ownedRecord(dir, { config: ['-c', 'sandbox_mode="workspace-write"'] });
      seedRecord(dir, prior);
      // A live holder of the state lock makes the mint wait out its lock and fail. The deps
      // never start, read or signal a process.
      writeFileSync(join(dir, LOCK_FILE), `${process.pid}\n`);
      let spawned = 0;
      let hookReads = 0;
      let signals = 0;
      const answer = await launchCodexEndpoint({
        dir, session: SESSION, seat: SEAT, pane: 'fixture-pane-9',
        deps: {
          alive: () => true,
          commandOf: () => `codex app-server --listen ${prior.url as string}`,
          startOf: () => T0_MS + 500,
          isSocket: () => true,
          isPlainDir: () => true,
          herdrEnv: () => { hookReads++; return { HERDR_PANE_ID: 'fixture-pane-9' }; },
          spawn: () => { spawned++; return { pid: 9_002 }; },
          terminate: () => { signals++; },
        },
      });
      expect(answer.kind).toBe('unmanaged');
      if (answer.kind === 'unmanaged') expect(answer.why).toContain('fresh presence binding could not be recorded');
      expect(spawned).toBe(0);
      expect(hookReads).toBe(0);
      expect(signals).toBe(0);
      expect(recordedAt(dir)).toEqual(prior);
      expect(readState(dir).sessions[SESSION]?.seats[SEAT]?.presence_binding).toBe(BINDING);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('with the state free, the launch mints a fresh binding and starts a server under it', async () => {
    const dir = scratch();
    try {
      const prior = ownedRecord(dir);
      seedRecord(dir, prior);
      const spawned: string[] = [];
      const answer = await launchCodexEndpoint({
        dir, session: SESSION, seat: SEAT,
        deps: {
          alive: () => true,
          commandOf: () => null,
          startOf: () => null,
          isSocket: () => true,
          isPlainDir: () => true,
          spawn: (input) => { spawned.push(input.url); return { pid: 9_003 }; },
          terminate: () => {},
          sleep: async () => {},
        },
      });
      expect(answer.kind).toBe('up');
      if (answer.kind === 'up') expect(answer.started).toBe(true);
      const binding = readState(dir).sessions[SESSION]?.seats[SEAT]?.presence_binding;
      expect(typeof binding).toBe('string');
      expect(binding).not.toBe(BINDING);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toContain(`${binding as string}.sock`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
