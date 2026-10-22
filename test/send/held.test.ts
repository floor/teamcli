// `team send` and the held frame: a socket write the receiving session's "Held message from
// another session" dialog holds is `held (socket)`, never `delivered (socket)`, and no trigger
// is typed into the blocked box — a shape the code keeps for the socket's return, unreachable
// while SOCKET_SEND (src/send/uds.ts) is off. These scenes pin the gated state: the plain send
// is the typed trigger, and a `--wait` is refused before any frame exists, so nothing can land
// at a dialog. Flipping the constant back reddens them loudly.
//
// Fixtures only: a fake seat, a fake sockets folder, and a pane this test scripts. No live
// session is touched and no real pane is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../../src/commands/send.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { readHistory } from '../../src/send/history.ts';
import { readTriggerLine, type NativePane } from '../../src/send/native.ts';
import type { SendOutcome } from '../../src/send/uds.ts';
import { recordBody, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-17T04:00:00.000Z');

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function teamFile(root: string, lobby: string): string {
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
# These scenes walk the typed trigger: the inbox is tried and skipped for want of a listener,
# then the line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`;
}

function world(): { root: string; dir: string; sockets: string; home: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-held-')));
  const root = join(base, 'acme');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamFile(root, lobbyDir(home)));
  return { root, dir: join(root, '.agents'), sockets, home };
}

/** The dialog a busy Claude Code session shows for a cross-session frame. */
const HELD_DIALOG = [
  '╭──────────────────────────────────────╮',
  '│ Held message from another session    │',
  '│ a cross-session frame is waiting for │',
  '│ you to let it through                │',
  '╰──────────────────────────────────────╯',
].join('\n');

/** The same title wrapped mid-sentence inside the frame, the way a narrow pane draws it: the
 *  needle must find the words across the rows and the borders. */
const HELD_WRAPPED = '╭ Held message from\n│ another session\n╰──────────────';

/** A quiet screen: read, and never the held-message dialog. */
const QUIET = '❯ \n  ? for shortcuts';

type Scripted = NativePane & { typed: string[]; enters: number };

/** A pane that walks its status samples, one per status read, and its screens, one per pane read
 *  (the last screen repeats). Without `screens` the pane has no reader at all: the box is never
 *  looked at, the shape `send.test.ts` drives the typed path with. */
function scripted(samples: string[], screens?: string[]): Scripted {
  const typed: string[] = [];
  let enters = 0;
  let read = 0;
  let reads = 0;
  const pane: Scripted = {
    typed,
    get enters() {
      return enters;
    },
    typeText: (_session, _pane, text) => {
      typed.push(text);
      return true;
    },
    pressEnter: () => {
      enters += 1;
      return true;
    },
    status: () => samples[Math.min(read++, samples.length - 1)] ?? 'idle',
    wait: async () => {},
  };
  if (screens !== undefined) {
    pane.paneText = () => screens[Math.min(reads++, screens.length - 1)] ?? null;
  }
  return pane;
}

type Fake = SendHost & { frames: string[]; socketsTried: string[]; pane: Scripted };

/** The fake host: the `lead` seat lives on w1:p1, its pane's processes are 222 (the CLI) and
 *  111 (the shell), and the socket folder is this fixture's own. `deliver` records the attempt
 *  and takes the frame — what a live session's socket does with it is not this fake's to say. */
function claudeHost(sockets: string, samples: string[], screens?: string[]): Fake {
  const frames: string[] = [];
  const socketsTried: string[] = [];
  const pane = scripted(samples, screens);
  return {
    frames,
    socketsTried,
    pane,
    agents: () => [{ name: 'lead', pane: 'w1:p1' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: sockets,
    deliver: async (socketPath: string, frame: string): Promise<SendOutcome> => {
      socketsTried.push(socketPath);
      frames.push(frame);
      return { ok: true };
    },
    native: pane,
    now: () => NOW,
    home: join(base, 'home'),
  };
}

const owner = (root: string) => testIo(root, { kind: 'owner' });

describe('team send: a --wait frame cannot land at a dialog', () => {
  test('--wait never sends a socket frame while SOCKET_SEND is off: it walks the typed leg and waits on the thread', async () => {
    const { root, sockets, home } = world();
    writeFileSync(join(sockets, '222.sock'), '');
    const host = { ...claudeHost(sockets, ['idle', 'working'], [QUIET, QUIET]), waitMs: 0 };
    const io = owner(root);

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe('team send: lead: timeout: sent, no reply on the thread within 1s; the thread stays open\n');
    expect(host.frames.length).toBe(0);
    const read = readHistory('acme', root, home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]?.outcome).toBe('timeout');
    expect(read.entries[0]?.via).toBe('typed');
  });
});

describe('team send: the plain send is the typed trigger again', () => {
  test('a live socket standing does not take the frame, and nothing on it is opened', async () => {
    const { root, dir, sockets } = world();
    writeFileSync(join(sockets, '222.sock'), '');
    const host = claudeHost(sockets, ['idle', 'working']);
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe(
      'team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n',
    );
    expect(host.frames).toEqual([]);
    expect(host.socketsTried).toEqual([]);
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    const path = join(drops, readdirSync(drops).find((name) => !name.includes('.')) as string);
    expect(host.pane.typed).toEqual([readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string]);
    expect(host.pane.enters).toBe(1);
    expect(recordBody(path)).toBe('from the owner — admitted by: the owner\n\nhello');
    const read = readHistory('acme', root, host.home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries[0]).toMatchObject({
      to: 'lead',
      outcome: 'sent (unconfirmed)',
      note: 'trigger taken, no read receipt yet',
      ms: 0,
      via: 'typed',
    });
  });
});
