// What `team down` does with a seat's managed Codex endpoint and with the watch the state
// records. A seat that records an endpoint for the presence binding it holds now is stopped
// through the same proof `remove` uses, before the record that names it goes; a seat that
// records none — every seat whose launch managed no endpoint — is never mentioned. A watch whose
// pid the state records and whose pane is not is stopped only when the live process's command
// line proves this install's own CLI entry running this session's watch and its start instant is
// the one the watch recorded; a reused pid, another install's entry, a watch word inside some
// other program's arguments, a record with no start instant, a record carrying a well-formed
// epoch (the session host's own process) and a record with a pane are never signalled here.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runDown, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import type { EndpointStopRead } from '../../src/launch/codex-endpoint.ts';
import { gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-15T11:30:00Z');
const owner = { kind: 'owner' } as const;
const FILE = ['--file', '.agents/team.yaml'];
const BINDING = 'prs_ab12cd34ef56';
const OTHER = 'prs_ffffffffffff';
const ENDPOINT = {
  url: `unix:///tmp/acme/run/acme/worker/${BINDING}.sock`,
  binding: BINDING,
  pid: 4242,
  started_at: '2026-10-15T11:00:00Z',
};
const EPOCH = `watch_${'a'.repeat(32)}`;
// The instant the watch process recorded when it started; the scenes' `ps` reads agree with it.
const WATCH_STARTED = '2026-10-15T11:29:50Z';
// This install's own CLI entry, resolved as the watch proof resolves it: a watch spawned from
// this checkout runs it. Another install's cli.js, or this path named later in some other
// program's arguments, is never this install's watch.
const SELF_ENTRY = realpathSync(join(import.meta.dir, '../../src/cli.ts'));
const WATCH_COMMAND = `node ${SELF_ENTRY} watch --session acme`;

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

function teamText(): string {
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
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function layout(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-down-endpoint-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  const file = join(root, '.agents', 'team.yaml');
  const text = teamText();
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

function seedWatch(
  at: Place,
  watch: { pid?: number; heartbeat: string; pane?: string; workspace?: string; epoch?: string; started_at?: string },
): void {
  updateState(at.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watch = watch;
  });
}

const agent = (): HerdrAgent => ({
  name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null,
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

type StopSeen = { dir: string; session: string; seat: string; recordPresent: boolean };

function sourcesOf(
  at: Place,
  over: Partial<DownSources> = {},
  stop?: (seen: { dir: string; session: string; seat: string }) => EndpointStopRead,
): { sources: DownSources; stops: StopSeen[]; kills: number[] } {
  const stops: StopSeen[] = [];
  const kills: number[] = [];
  const sources: DownSources = {
    sessionRunning: () => true,
    agents: () => [agent()],
    alive: () => true,
    // The watch proof's two readings, for the one pid the watch scenes record.
    commandOf: (pid) => (pid === 4242 ? WATCH_COMMAND : null),
    startOf: (pid) => (pid === 4242 ? Date.parse(WATCH_STARTED) : null),
    // The seat's CLI has exited: its shell is back in front of it, so it is closed without
    // typing and the close is what carries the endpoint stop under test.
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
  return { sources, stops, kills };
}

function stateSeat(at: Place) {
  return readState(at.dir).sessions.acme?.seats?.worker;
}

let places: Place[] = [];
function place(): Place {
  const made = layout();
  places.push(made);
  return made;
}
afterEach(() => {
  for (const made of places) rmSync(made.base, { recursive: true, force: true });
  places = [];
});

async function down(at: Place, sources: DownSources) {
  const io = testIo(at.root, owner);
  const code = await runDown([...FILE], io, sources);
  return { code, out: io.out, err: io.err };
}

describe('a seat and its managed endpoint', () => {
  test('a seat that records no endpoint is closed without any endpoint notice', async () => {
    const at = place();
    // A launch-installed presence binding without an endpoint record: the shape a seat whose
    // launch managed no endpoint has, and every non-Codex seat's.
    seedSeat(at, { stage: 'ready', pane: 'w1:p1', workspace: 'w1', presence_binding: BINDING });
    const { sources, stops } = sourcesOf(at, {}, () => ({ stopped: true }));
    const run = await down(at, sources);
    expect(run.code).toBe(0);
    expect(stops).toEqual([]);
    expect(run.err).not.toContain('records no endpoint');
    expect(run.err).not.toContain('endpoint');
    expect(stateSeat(at)).toBeUndefined();
  });

  test('a seat that records one for its current binding is stopped through it before the record goes', async () => {
    const at = place();
    seedSeat(at, { stage: 'ready', pane: 'w1:p1', workspace: 'w1', presence_binding: BINDING, codex_endpoint: { ...ENDPOINT } });
    const { sources, stops } = sourcesOf(at, {}, () => ({ stopped: true }));
    const run = await down(at, sources);
    expect(run.code).toBe(0);
    expect(stops).toEqual([{ dir: at.dir, session: 'acme', seat: 'worker', recordPresent: true }]);
    expect(stateSeat(at)).toBeUndefined();
  });

  test('an endpoint that cannot be proven is left alone and the refusal is said', async () => {
    const at = place();
    seedSeat(at, { stage: 'ready', pane: 'w1:p1', workspace: 'w1', presence_binding: BINDING, codex_endpoint: { ...ENDPOINT } });
    const { sources, stops } = sourcesOf(at, {}, () => ({
      stopped: false,
      why: 'the recorded process cannot be proven to serve this endpoint; it was not signalled',
    }));
    const run = await down(at, sources);
    expect(run.code).toBe(0);
    expect(stops).toHaveLength(1);
    expect(run.err).toContain('the recorded process cannot be proven');
  });

  test('a record for another binding names no endpoint of this seat and is not stopped', async () => {
    const at = place();
    seedSeat(at, {
      stage: 'ready', pane: 'w1:p1', workspace: 'w1', presence_binding: BINDING,
      codex_endpoint: { ...ENDPOINT, binding: OTHER, url: `unix:///tmp/acme/run/acme/worker/${OTHER}.sock` },
    });
    const { sources, stops } = sourcesOf(at, {}, () => ({ stopped: true }));
    const run = await down(at, sources);
    expect(run.code).toBe(0);
    expect(stops).toEqual([]);
    expect(run.err).not.toContain('records no endpoint');
  });
});

describe('a watch whose pid is only in the state', () => {
  function run(over: {
    watch?: Parameters<typeof seedWatch>[1];
    alive?: (pid: number) => boolean;
    commandOf?: (pid: number) => string | null;
    startOf?: (pid: number) => number | null;
  } = {}) {
    const at = place();
    seedWatch(at, over.watch ?? { pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED });
    let running = true;
    const { sources, kills } = sourcesOf(at, {
      sessionRunning: () => running,
      agents: () => [],
      alive: over.alive ?? ((pid: number) => pid === 4242),
      ...(over.commandOf === undefined ? {} : { commandOf: over.commandOf }),
      ...(over.startOf === undefined ? {} : { startOf: over.startOf }),
      launch: launchOf({
        kill: (pid) => { kills.push(pid); return true; },
        stopSession: () => { running = false; return true; },
        deleteSession: () => { running = false; return true; },
      }),
    });
    return down(at, sources).then((made) => ({
      ...made,
      kills,
      watchLeft: readState(at.dir).sessions.acme?.watch,
    }));
  }

  test('a proven watch is stopped by pid', async () => {
    const run0 = await run();
    expect(run0.code).toBe(0);
    expect(run0.kills).toEqual([4242]);
    expect(run0.out).toContain('watch: the stop signal was sent');
  });

  test('a bun runtime running this install\'s entry is proven too', async () => {
    const run0 = await run({ commandOf: () => `bun ${SELF_ENTRY} watch --session acme` });
    expect(run0.code).toBe(0);
    expect(run0.kills).toEqual([4242]);
    expect(run0.out).toContain('watch: the stop signal was sent');
  });

  test('an executable named team that resolves to this install\'s entry is proven', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-entry-')));
    try {
      const team = join(dir, 'team');
      symlinkSync(SELF_ENTRY, team);
      const run0 = await run({ commandOf: () => `${team} watch --session acme` });
      expect(run0.code).toBe(0);
      expect(run0.kills).toEqual([4242]);
      expect(run0.out).toContain('watch: the stop signal was sent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a watch word later in another program\'s arguments is that program\'s, and is left alone', async () => {
    const run0 = await run({
      commandOf: () => `node /srv/unrelated-worker.js ${SELF_ENTRY} watch --session acme`,
    });
    expect(run0.code).toBe(0);
    expect(run0.kills).toEqual([]);
    expect(run0.out).toContain("watch: pid 4242 is not running this team's watch for session acme; it was not signalled and the record is kept");
    expect(run0.watchLeft).toEqual({ pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED });
  });

  test('a watch from another install\'s cli.js is left alone, said, and kept', async () => {
    const run0 = await run({ commandOf: () => 'node /opt/other/dist/cli.js watch --session acme' });
    expect(run0.code).toBe(0);
    expect(run0.kills).toEqual([]);
    expect(run0.out).toContain("watch: pid 4242 is not running this team's watch for session acme; it was not signalled and the record is kept");
    expect(run0.watchLeft).toEqual({ pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED });
  });

  test('a reused pid whose command line is not the watch is left alone, said, and kept', async () => {
    const run0 = await run({ commandOf: () => 'node /srv/worker.js' });
    expect(run0.code).toBe(0);
    expect(run0.kills).toEqual([]);
    expect(run0.out).toContain("watch: pid 4242 is not running this team's watch for session acme; it was not signalled and the record is kept");
    expect(run0.watchLeft).toEqual({ pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED });
  });

  test('a command line for another session is not this team\'s watch', async () => {
    const run0 = await run({ commandOf: () => `node ${SELF_ENTRY} watch --session other` });
    expect(run0.code).toBe(0);
    expect(run0.kills).toEqual([]);
    expect(run0.out).toContain('is not running this team\'s watch for session acme');
  });

  test('a reused pid that started after the record is left alone, said, and kept', async () => {
    const run0 = await run({ startOf: () => Date.parse(WATCH_STARTED) + 60_000 });
    expect(run0.code).toBe(0);
    expect(run0.kills).toEqual([]);
    expect(run0.out).toContain('watch: pid 4242 started at a time its record does not match; it was not signalled and the record is kept');
    expect(run0.watchLeft).toEqual({ pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED });
  });

  test('a record an older build wrote with no start instant is left alone and kept', async () => {
    const run0 = await run({ watch: { pid: 4242, heartbeat: NOW.toISOString() } });
    expect(run0.code).toBe(0);
    expect(run0.kills).toEqual([]);
    expect(run0.out).toContain('watch: pid 4242 has no recorded start instant to match; it was not signalled and the record is kept');
    expect(run0.watchLeft).toEqual({ pid: 4242, heartbeat: NOW.toISOString() });
  });

  test('a record carrying an epoch names the session host and is never signalled', async () => {
    const run0 = await run({ watch: { pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED, epoch: EPOCH } });
    expect(run0.code).toBe(0);
    expect(run0.kills).toEqual([]);
    expect(run0.out).not.toContain('watch: the stop signal was sent');
  });

  test('a record with a pane is left to `up` and to the session stop', async () => {
    const run0 = await run({ watch: { pid: 4242, heartbeat: NOW.toISOString(), started_at: WATCH_STARTED, pane: 'w9:p1', workspace: 'w9' } });
    expect(run0.code).toBe(0);
    expect(run0.kills).toEqual([]);
    expect(run0.out).not.toContain('watch: the stop signal was sent');
  });

  test('a pid that is not alive has nothing to stop', async () => {
    const run0 = await run({ alive: () => false });
    expect(run0.code).toBe(0);
    expect(run0.kills).toEqual([]);
    expect(run0.out).not.toContain('watch: the stop signal was sent');
  });
});
