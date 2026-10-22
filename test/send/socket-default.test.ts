// `team send` to a Claude Code seat: the typed trigger (a 0600 drop file and one line) is the
// channel, and no path opens the seat's cross-session socket. The gate is SOCKET_SEND in
// src/send/uds.ts, off while the channel is unattested; these scenes pin the gated state, so
// flipping the constant back reddens them loudly.
//
// Fixtures only: a fake seat, a fake sockets folder, and a real unix socket listener this test
// owns — the shape `test/send.test.ts` measured. No pane is read and no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../../src/commands/send.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { readTriggerLine, type NativePane } from '../../src/send/native.ts';
import { sendFrame, type SendOutcome } from '../../src/send/uds.ts';
import { recordBody, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-16T04:00:00.000Z');

let base = '';
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
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

function world(): { root: string; dir: string; sockets: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-socket-default-')));
  const root = join(base, 'acme');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamFile(root, lobbyDir(home)));
  return { root, dir: join(root, '.agents'), sockets };
}

type Scripted = NativePane & { typed: string[]; enters: number };

/** A native pane that walks its samples, one per status read: the same shape send.test.ts
 *  drives the typed path with. The socket scenes must not depend on it. */
function scripted(samples: string[]): Scripted {
  const typed: string[] = [];
  let enters = 0;
  let read = 0;
  return {
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
}

type Fake = SendHost & { frames: string[]; socketsTried: string[]; pane: Scripted };

/** Swap the fake's `deliver` for the real client, keeping the attempt recorded: the send path
 *  calls this one hook, so a scene can assert exactly which socket it tried. */
function realDeliver(host: Fake): void {
  host.deliver = async (socketPath, frame) => {
    host.socketsTried.push(socketPath);
    return sendFrame(socketPath, frame);
  };
}

/** The fake host: the `lead` seat lives on w1:p1, its pane's processes are 222 (the CLI) and
 *  111 (the shell), and the socket folder is the caller's own. `deliver` records the attempt
 *  and takes it; a scene that wants the real client swaps it with `realDeliver`. */
function claudeHost(sockets: string, samples: string[]): Fake {
  const frames: string[] = [];
  const socketsTried: string[] = [];
  const pane = scripted(samples);
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

/** A real listener at `<sockets>/<pid>.sock`, the shape the probe measured, collecting
 *  everything it receives. */
async function listen(sockets: string, pid: number): Promise<{ path: string; received: string[] }> {
  const path = join(sockets, `${String(pid)}.sock`);
  const received: string[] = [];
  const server = createServer((socket) => {
    socket.on('data', (chunk: Buffer) => received.push(chunk.toString('utf8')));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, received };
}

const owner = (root: string) => testIo(root, { kind: 'owner' });

/** Files the delivery walk leaves beside a message record: the watch's retry record
 *  (`.pending`) and the fallback episode marker (`.fallback.json`). Neither is a message. */
const derivative = (name: string): boolean => name.endsWith('.pending') || name.endsWith('.fallback.json');

/** The one signed record in a drop folder, with the episode marker asserted by its id. */
function dropRecord(drops: string): string {
  const names = readdirSync(drops);
  const records = names.filter((name) => !derivative(name));
  expect(records.length).toBe(1);
  const id = records[0] as string;
  expect(names).toContain(`${id}.fallback.json`);
  return join(drops, id);
}

describe('team send: the typed trigger is the default for a Claude Code seat', () => {
  test('a plain send is typed while a live socket stands, and the frame is not written', async () => {
    const { root, dir, sockets } = world();
    const { received } = await listen(sockets, 222);
    const host = claudeHost(sockets, ['idle', 'working']);
    realDeliver(host);
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe(
      'team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n',
    );
    // The socket is not this path's channel: it is never tried, and the live listener at the
    // pane's pid hears nothing.
    expect(host.socketsTried).toEqual([]);
    expect(received).toEqual([]);
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    const path = dropRecord(drops);
    // The typed line is the message-display line, so the summary is the body's first word.
    expect(host.pane.typed).toEqual([readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string]);
    expect(host.pane.enters).toBe(1);
    expect(recordBody(path)).toBe('from the owner — admitted by: the owner\n\nhello');
  });

  test('a socket file that would refuse is not tried either', async () => {
    const { root, sockets } = world();
    // A plain file at the measured name: what a socket left by a session that is gone holds —
    // and what the flipped default never touches.
    writeFileSync(join(sockets, '222.sock'), '');
    const host = claudeHost(sockets, ['idle', 'working']);
    realDeliver(host);
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n',
    );
    expect(host.socketsTried).toEqual([]);
    expect(host.pane.typed.length).toBe(1);
    expect(host.pane.enters).toBe(1);
  });
});

describe('team send: a typed send with no socket at all', () => {
  test('one drop file, one typed trigger, and no socket sentence', async () => {
    const { root, dir, sockets } = world();
    const host = claudeHost(sockets, ['idle', 'working']);
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n',
    );
    expect(host.frames).toEqual([]);
    expect(host.socketsTried).toEqual([]);
    expect(host.pane.typed.length).toBe(1);
    expect(host.pane.enters).toBe(1);
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    const path = dropRecord(drops);
    // The typed line is the message-display line, so the summary is the body's first word; the
    // signed body's own attribution is never typed.
    expect(host.pane.typed[0]).toBe(readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string);
    expect(host.pane.typed[0]).not.toContain('admitted by:');
    expect(recordBody(path)).toBe('from the owner — admitted by: the owner\n\nhello');
  });
});

describe('team send: --wait to a Claude Code seat never dials the socket', () => {
  test('the send walks the delivery order, dials no socket, and waits on the thread', async () => {
    const { root, sockets } = world();
    const host = { ...claudeHost(sockets, ['idle', 'working']), waitMs: 0 };
    const io = owner(root);

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.err).toBe('team send: lead: timeout: sent, no reply on the thread within 1s; the thread stays open\n');
    expect(host.socketsTried).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.pane.typed.length).toBe(1);
    expect(host.pane.enters).toBe(1);
  });
});
