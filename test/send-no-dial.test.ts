// No `team send` this process runs opens another session's cross-session socket: not the plain
// send, not `--wait`, not a request through the daemon. The watch's own automatic work typing is
// retired: every automatic work request is the dispatcher's, and the dispatcher reaches a seat
// only through the sources' `pushWork`, never a keystroke of its own. Its scene pins that an idle
// seat with a takeable queue and no route is typed nothing and leaves no work drop, so the
// watch's own passes never reach a send socket.
//
// Fixtures only: fake seats, fake panes, a fake sockets folder, and this test's own runWatch
// sources. No live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import type { TeamFile } from '../src/file/types.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { requestDaemon, startSendDaemon, type DaemonHost, type SendDaemonHandle } from '../src/send/daemon.ts';
import { readTriggerLine } from '../src/send/native.ts';
import type { SendOutcome } from '../src/send/uds.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { claudeBox, recordBody, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T05:00:00.000Z');
const RULE = '─'.repeat(30);
const MIN = 60_000;
const PROMPT = 'Take the next unfinished item in your queue and start it.';

let base = '';
const handles: SendDaemonHandle[] = [];

afterEach(async () => {
  for (const handle of handles) await handle.close();
  handles.length = 0;
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

function teamYaml(root: string, lobby: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: helper
session: acme
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
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: reviewer
    name: native
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m test
# These scenes walk the typed trigger: the inbox is tried and skipped for want of a listener,
# then the line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`;
}

function world(): { root: string; dir: string; sockets: string; home: string; team: TeamFile } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-no-dial-')));
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), teamYaml(root, lobbyDir(home)));
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error('fixture team.yaml failed to load');
  return { root, dir, sockets, home, team: loaded.team };
}

type Dialer = SendHost & DaemonHost & {
  typed: { pane: string; text: string }[];
  enters: string[];
  frames: string[];
  dials: () => number;
};

/** The host every send-side scene is handed: its `deliver` is the socket, and it counts the
 *  attempt before throwing, so a path that dials fails loudly and a path that swallows the
 *  failure still shows up in the count. The pane is the daemon tests' own shape: an idle box
 *  that reads back the trigger once it is typed. */
function dialer(w: { sockets: string; home: string }): Dialer {
  const typed: { pane: string; text: string }[] = [];
  const enters: string[] = [];
  const frames: string[] = [];
  let dials = 0;
  const statusByPane: Record<string, string> = { 'pane-lead': 'idle', 'pane-native': 'idle' };
  return {
    typed,
    enters,
    frames,
    dials: () => dials,
    agents: () => [
      { name: 'lead', pane: 'pane-lead' },
      { name: 'native', pane: 'pane-native' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async (_socketPath: string, frame: string): Promise<SendOutcome> => {
      dials += 1;
      frames.push(frame);
      throw new Error('the socket was dialed');
    },
    native: {
      typeText: (_session, pane, text) => {
        typed.push({ pane, text });
        return true;
      },
      pressEnter: (_session, pane) => {
        enters.push(pane);
        statusByPane[pane] = 'working';
        return true;
      },
      status: (_session, pane) => statusByPane[pane] ?? 'idle',
      wait: async () => {},
      paneText: (_session, pane) => {
        const last = [...typed].reverse().find((one) => one.pane === pane);
        if (last && !enters.includes(pane)) return `${RULE}\n❯ ${last.text}\n${RULE}`;
        return `${RULE}\n❯ \n${RULE}`;
      },
    },
    now: () => NOW,
    home: w.home,
    deliverWaitMs: 50,
    pollReadyMs: 5,
  };
}

const owner = (root: string) => testIo(root, { kind: 'owner' });

function dropped(root: string, seat: string): string {
  const dir = join(root, '.agents', 'send-drops', 'acme', seat);
  return join(dir, readdirSync(dir).sort()[0] as string);
}

describe('the sending paths never dial while the socket is off', () => {
  test('a plain send writes the drop and types the trigger: the throwing deliver is never called', async () => {
    const w = world();
    const host = dialer(w);
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n',
    );
    expect(host.dials()).toBe(0);
    expect(host.frames).toEqual([]);
    const path = dropped(w.root, 'lead');
    expect(recordBody(path)).toBe('from the owner — admitted by: the owner\n\nhello');
    const trigger = readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' });
    if (trigger === null) throw new Error('the trigger line did not fit');
    expect(host.typed).toEqual([{ pane: 'pane-lead', text: trigger }]);
    expect(host.enters).toEqual(['pane-lead']);
  });

  test('--wait walks the typed leg without dialing and times out with the thread open', async () => {
    const w = world();
    const host = { ...dialer(w), waitMs: 0 };
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe(
      'team send: lead: timeout: sent, no reply on the thread within 1s; the thread stays open\n',
    );
    expect(host.dials()).toBe(0);
    expect(host.frames).toEqual([]);
    const path = dropped(w.root, 'lead');
    expect(recordBody(path)).toBe('from the owner — admitted by: the owner\n\nhello');
    const trigger = readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' });
    if (trigger === null) throw new Error('the trigger line did not fit');
    expect(host.typed).toEqual([{ pane: 'pane-lead', text: trigger }]);
    expect(host.enters).toEqual(['pane-lead']);
  });

  test('the daemon refuses a waited request and types a plain one, dialing nothing either way', async () => {
    const w = world();
    const host = dialer(w);
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    // An older caller that still asks for a waited send: the daemon's own gate refuses it.
    const waited = await requestDaemon(started.handle.socketPath, {
      v: 1,
      op: 'send',
      from: 'owner',
      to: 'lead',
      body: 'over the socket',
      wait: true,
      timeout_s: 1,
    });
    expect(waited && 'outcome' in waited ? waited.outcome : null).toBe('refused');
    expect(waited && 'detail' in waited ? waited.detail : '').toContain('needs the native leg');

    // A plain request through the daemon: the typed channel, like the CLI's own.
    const plain = await requestDaemon(started.handle.socketPath, {
      v: 1,
      op: 'send',
      from: 'owner',
      to: 'lead',
      body: 'typed through the daemon',
    });
    expect(plain && 'outcome' in plain ? plain.outcome : null).toBe('delivered');

    expect(host.dials()).toBe(0);
    expect(host.frames).toEqual([]);
    expect(host.typed.length).toBe(1);
    expect(host.typed[0]?.pane).toBe('pane-lead');
    expect(host.typed[0]?.text).toMatch(/(Read it at|read) \S+\/drops\/acme\/lead\/\S+/);
  });
});

describe('the watch types no automatic work', () => {
  test('an idle seat with a takeable queue and no direct route is typed nothing, and no drop is written', async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-no-dial-watch-')));
    const dir = join(base, 'acme-web');
    mkdirSync(join(dir, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    const raw = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
    writeFileSync(join(dir, '.agents', 'team.yaml'), raw.replace('watch:\n', `watch:\n  nudge: ${PROMPT}\n`));
    writeFileSync(join(dir, '.agents', 'queue.yaml'), '- id: t1\n  title: "First"\n');
    // Truthful idle clocks: the reading would offer both workers the task if a route were wired.
    updateState(join(dir, '.agents'), (state) => {
      const seats = (state.sessions['acme-web'] ??= emptySession()).seats;
      for (const seat of ['deepseek-acme', 'deepseek-acme-2']) {
        seats[seat] = { stage: 'ready', last_active: '2026-10-03T13:00:00.000Z' };
      }
    });

    const IDLE = `● Done.\n\n${RULE}\n❯ \n${RULE}\n  main · …/acme-web · Opus 5.5\n`;
    const BUSY = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n  main · …/acme-web · Opus 5.5\n`;
    const agent = (name: string, workspace: string, status: string): HerdrAgent => ({
      name,
      agent: 'claude',
      pane: `${workspace}:pane`,
      workspace,
      status,
      cwd: null,
    });
    const live: Live = {
      running: true,
      agents: [
        agent('claude-coordinator-acme', 'lead', 'working'),
        agent('deepseek-acme', 'first', 'idle'),
        agent('deepseek-acme-2', 'second', 'idle'),
      ],
      workspaces: [
        { id: 'lead', label: 'claude-coordinator-acme' },
        { id: 'first', label: 'deepseek-acme' },
        { id: 'second', label: 'deepseek-acme-2' },
      ],
      screens: { 'lead:pane': BUSY, 'first:pane': IDLE, 'second:pane': IDLE },
    };
    const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

    // The sources a watch runs on: a pane this test scripts, and no socket anywhere — the type
    // the watch takes admits none. Two passes, the second one a nudge cadence on. `first:pane`
    // is this watch's own, so the one work drop the cadence finds is `second:pane`'s.
    const typed: string[] = [];
    let screenNow = IDLE;
    let clock = Date.parse('2026-10-03T14:00:00Z');
    let passes = 2;
    const sources: WatchSources = {
      live: () => live,
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => screenNow,
      status: () => 'idle',
      foreground: () => ['claude'],
      typeText: (pane, text) => {
        typed.push(`${pane} ${text}`);
        screenNow = claudeBox(text);
        return true;
      },
      pressEnter: (pane) => {
        typed.push(`${pane} <enter>`);
        return true;
      },
      sleep: async (ms) => {
        clock += ms;
      },
      notify: () => {},
      now: () => new Date(clock),
      wait: async () => {
        clock += 10 * MIN;
        return --passes > 0;
      },
      alive: () => false,
      pid: 4242,
      ownPane: () => ({ pane: 'first:pane', workspace: 'first' }),
      home: dir,
    };

    const io = testIo(dir, { kind: 'owner' });
    const code = await runWatch(['--file', join(dir, '.agents', 'team.yaml')], io, sources);

    expect(code).toBe(0);
    // The one thing the retired path would have done is type a work drop at the second pane;
    // the dispatcher has no route to attempt, so nothing is typed and no drop exists.
    expect(typed).toEqual([]);
    expect(existsSync(join(dir, '.agents', 'send-drops'))).toBe(false);
    // The refused route is announced where the watch reports, as a signed mailbox record, not as
    // a keystroke.
    expect(existsSync(join(dir, '.agents', 'messages'))).toBe(true);
  });
});
