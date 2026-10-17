// `team send` to a Claude Code seat: the cross-session socket is the default channel, and the
// typed trigger (a 0600 drop file and one line) is the named fallback when the socket is
// missing or refuses. The outcome says which path carried the message.
//
// Fixtures only: a fake seat, a fake sockets folder, and a real unix socket listener this test
// owns — the shape `test/send.test.ts` measured. No pane is read and no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../../src/commands/send.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import type { NativePane } from '../../src/send/native.ts';
import { sendFrame, type SendOutcome } from '../../src/send/uds.ts';
import { testIo } from '../helpers.ts';

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

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check() && Date.now() - start < ms) await new Promise((resolve) => setTimeout(resolve, 5));
}

const owner = (root: string) => testIo(root, { kind: 'owner' });

describe('team send: the socket is the default for a Claude Code seat', () => {
  test('a plain send goes through the socket, and nothing is typed', async () => {
    const { root, sockets } = world();
    const { received } = await listen(sockets, 222);
    // Samples the typed path would consume: an idle pane, then one that takes the line. They are
    // here so a run that wrongly falls back still delivers, and the `typed`/`enters` assertions
    // below catch it — rather than the run stopping at the typed path's own refusal.
    const host = claudeHost(sockets, ['idle', 'working']);
    realDeliver(host);
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe('lead: delivered (socket)\n');
    // The trigger only exists on the typed path: none may be typed, and no Enter may land,
    // when the frame was taken.
    expect(host.pane.typed).toEqual([]);
    expect(host.pane.enters).toBe(0);
    expect(host.socketsTried).toEqual([join(sockets, '222.sock')]);
    await until(() => received.length > 0);
    const frame = received.join('');
    expect(frame.endsWith('\n')).toBe(true);
    expect((frame.match(/\n/g) ?? []).length).toBe(1);
    const parsed = JSON.parse(frame) as { type: string; message: { role: string; content: string } };
    expect(parsed.type).toBe('user');
    expect(parsed.message).toEqual({ role: 'user', content: 'from the owner — admitted by: the owner\n\nhello' });
  });

  test('a busy pane takes the same path: the frame is not queued behind the composer', async () => {
    const { root, sockets } = world();
    const { received } = await listen(sockets, 222);
    const host = claudeHost(sockets, ['working']);
    realDeliver(host);
    const io = owner(root);

    const code = await runSend(['lead', 'while you work'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('lead: delivered (socket)\n');
    expect(host.pane.typed).toEqual([]);
    expect(host.pane.enters).toBe(0);
    await until(() => received.length > 0);
    const parsed = JSON.parse(received.join('')) as { message: { content: string } };
    expect(parsed.message.content).toBe('from the owner — admitted by: the owner\n\nwhile you work');
  });
});

describe('team send: the typed fallback names its reason', () => {
  test('no socket is found: one drop file, one typed trigger, and the outcome says so', async () => {
    const { root, dir, sockets } = world();
    const host = claudeHost(sockets, ['idle', 'working']);
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toMatch(/^lead: delivered \(typed, socket .+\)\n$/);
    expect(host.frames).toEqual([]);
    expect(host.pane.typed.length).toBe(1);
    expect(host.pane.enters).toBe(1);
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    const path = join(drops, readdirSync(drops)[0] as string);
    expect(host.pane.typed[0]).toContain(path);
    expect(host.pane.typed[0]).not.toContain('hello');
    expect(readFileSync(path, 'utf8')).toBe('from the owner — admitted by: the owner\n\nhello');
  });

  test('a socket that refuses falls back the same way, and the state names the refusal', async () => {
    const { root, sockets } = world();
    // A plain file at the measured name: what a socket left by a session that is gone holds.
    // The real client answers ENOTSOCK on macOS and ECONNREFUSED on the ubuntu runner; both map
    // to the one sentence this asserts.
    writeFileSync(join(sockets, '222.sock'), '');
    const host = claudeHost(sockets, ['idle', 'working']);
    realDeliver(host);
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toMatch(/^lead: delivered \(typed, socket nothing is listening there \(.+\)\)\n$/);
    expect(host.pane.typed.length).toBe(1);
    expect(host.pane.enters).toBe(1);
  });

  test('--wait keeps the socket-only contract: a missing socket is unreachable, never typed', async () => {
    const { root, sockets } = world();
    const host = claudeHost(sockets, ['idle', 'working']);
    const io = owner(root);

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);

    // The reply channel is the socket: a typed fallback could deliver a message no reply can
    // come back from, so a --wait send with no socket is refused, not rerouted.
    expect(code).toBe(1);
    expect(io.err).toContain('lead: unreachable');
    expect(io.err).toContain('no cross-session socket was found');
    expect(host.pane.typed).toEqual([]);
    expect(host.pane.enters).toBe(0);
  });
});
