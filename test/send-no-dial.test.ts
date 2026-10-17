// No `team send` this process runs opens another session's cross-session socket: not the plain
// send, not `--wait`, not a request through the daemon — and the watch's nudge, which is the same
// drop file and typed trigger, dials nothing either. Each send-side scene hands the path a
// `deliver` that counts the attempt and throws, so a swallow somewhere on the way still leaves
// the count behind (the gate is SOCKET_SEND in src/send/uds.ts; flipping it back reddens these
// scenes). The watch's pass takes no host — its sources carry no socket hook at all — so its
// scene pins the channel a dial would have to replace: the trigger typed into the pane is the
// exact line a plain send types.
//
// Fixtures only: fake seats, fake panes, a fake sockets folder, and this test's own runWatch
// sources. No live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import type { TeamFile } from '../src/file/types.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { requestDaemon, startSendDaemon, type DaemonHost, type SendDaemonHandle } from '../src/send/daemon.ts';
import { triggerLine } from '../src/send/native.ts';
import type { SendOutcome } from '../src/send/uds.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { claudeBox, testIo } from './helpers.ts';

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
    expect(io.out).toBe('lead: delivered\n');
    expect(host.dials()).toBe(0);
    expect(host.frames).toEqual([]);
    const path = dropped(w.root, 'lead');
    expect(readFileSync(path, 'utf8')).toBe('from the owner — admitted by: the owner\n\nhello');
    const trigger = triggerLine(path);
    if (trigger === null) throw new Error('the drop path did not fit a trigger line');
    expect(host.typed).toEqual([{ pane: 'pane-lead', text: trigger }]);
    expect(host.enters).toEqual(['pane-lead']);
  });

  test('--wait is refused before anything is typed, dropped or dialed', async () => {
    const w = world();
    const host = dialer(w);
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe(
      'team send: refused: lead: --wait needs the native leg (team route + your own SendMessage), which this build does not carry; nothing was sent\n',
    );
    expect(host.dials()).toBe(0);
    expect(host.frames).toEqual([]);
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(existsSync(join(w.dir, 'send-drops'))).toBe(false);
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
    expect(host.typed[0]?.text).toContain(' and do that.');
  });
});

describe("the watch's nudge is the typed channel", () => {
  test('a work nudge types the same trigger a plain send does, and takes no socket', async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-no-dial-watch-')));
    const dir = join(base, 'acme-web');
    mkdirSync(join(dir, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    const raw = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
    writeFileSync(join(dir, '.agents', 'team.yaml'), raw.replace('watch:\n', `watch:\n  nudge: ${PROMPT}\n`));

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
    let clock = 0;
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
    const triggers = typed.filter((line) => line.includes(' and do that.'));
    expect(triggers).toHaveLength(1);
    const line = triggers[0] as string;
    expect(line.startsWith('second:pane Read ')).toBe(true);
    const path = line.slice('second:pane Read '.length, -' and do that.'.length);
    // The same line, the same file, the same channel a plain send uses.
    expect(line).toBe(`second:pane ${triggerLine(path)}`);
    expect(readFileSync(path, 'utf8')).toBe(PROMPT);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Nothing this scene typed was a frame, and the drop lives where `team send` writes its own.
    expect(path).toContain(join('.agents', 'send-drops', 'acme-web', 'deepseek-acme-2'));
    expect(typed.some((one) => one.includes('"type":"user"'))).toBe(false);
  });
});
