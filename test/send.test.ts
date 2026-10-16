// `team send`: the socket channel against fixtures — a fake seat, a fake sockets folder, and a
// real unix socket (a listener this test owns). No pane is read and no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { dropMessage, sawSubmission, triggerLine, TRIGGER_MAX, type NativePane } from '../src/send/native.ts';
import { FRAME_LIMIT, sendFrame, type SendOutcome } from '../src/send/uds.ts';
import { LOG_FILE, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-05T04:00:00.000Z');

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
  - role: reviewer
    name: native
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m test
`;
}

function world(): { root: string; dir: string; sockets: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-')));
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

type Fake = SendHost & { frames: string[]; socketsTried: string[] };

function fake(sockets: string, patch: Partial<SendHost> = {}): Fake {
  const frames: string[] = [];
  const socketsTried: string[] = [];
  return {
    frames,
    socketsTried,
    agents: () => [{ name: 'lead', pane: 'w1:p1' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: sockets,
    deliver: async (socketPath: string, frame: string): Promise<SendOutcome> => {
      socketsTried.push(socketPath);
      frames.push(frame);
      return { ok: true };
    },
    native: quietNative(),
    now: () => NOW,
    home: join(base, 'home'),
    ...patch,
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

/** A native pane that never moves. Socket tests must not depend on it. */
function quietNative(): NativePane {
  return {
    typeText: () => false,
    pressEnter: () => false,
    status: () => null,
    wait: async () => {},
  };
}

/** The agent record `up` writes for a launched seat: the id admission names in the drop file's
 *  header, and the reach its rules read. */
function registerSeat(seat: string, role: string, pane = 'w1:p1'): void {
  const id = `agt_${Buffer.from(seat).toString('hex').slice(0, 12).padEnd(12, '0')}`;
  const file = join(base, 'home', '.config', 'team', 'agents', `${id}.yaml`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      `id: "${id}"`,
      `name: "${seat}"`,
      'signing:',
      '  model: "Test"',
      '  version: "1"',
      `  role: "${role}"`,
      'lab: "test"',
      'cli: "claude-code"',
      'launcher: null',
      'launch: "claude"',
      'reach:',
      '  team: "acme"',
      `  seat: "${seat}"`,
      '  session: "acme"',
      `  pane: "${pane}"`,
      '  address: null',
      'mcp: []',
      'skills: []',
      'lifecycle: "running"',
      'provenance:',
      '  registered_by: "team up"',
      '  registered_at: "2026-10-05T04:00:00.000Z"',
      '  updated_at: "2026-10-05T04:00:00.000Z"',
      '',
    ].join('\n'),
  );
}

function record(dir: string, seat: string, pane: string): void {
  updateState(dir, (state) => {
    state.sessions.acme = { seats: { [seat]: { stage: 'launched', pane, workspace: 'w1' } }, worktrees: {} };
  });
}

const owner = (root: string) => testIo(root, { kind: 'owner' });

describe('team send: delivered', () => {
  test('a Claude Code seat with no socket falls back to the drop file when herdr reports working', async () => {
    const { root, dir, sockets } = world();
    const pane = scripted(['idle', 'working']);
    const host = fake(sockets, { native: pane });
    const io = owner(root);

    const code = await runSend(['lead', 'hello', 'world'], io, host);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    // The fixture's sockets folder holds no socket file, so the default (socket) path is
    // unavailable and the typed trigger carries it; the outcome names that and the reason.
    expect(io.out).toMatch(/^lead: delivered \(typed, socket .+\)\n$/);
    expect(host.frames).toEqual([]);
    expect(pane.typed.length).toBe(1);
    expect(pane.typed[0]).not.toContain('hello world');
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    const path = join(drops, readdirSync(drops)[0] as string);
    expect(readFileSync(path, 'utf8')).toBe('from the owner — admitted by: the owner\n\nhello world');
    expect(pane.typed[0]).toContain(path);
    const log = readFileSync(join(dir, LOG_FILE), 'utf8');
    expect(log).toContain('send [owner] lead: delivered');
    expect(log).not.toContain('hello world');
  });

  test('--file writes the file body whole to the drop file', async () => {
    const { root, dir, sockets } = world();
    const pane = scripted(['idle', 'working']);
    const host = fake(sockets, { native: pane });
    writeFileSync(join(root, 'note.txt'), 'line one\nline two\n');
    const io = owner(root);

    const code = await runSend(['lead', '--file', 'note.txt'], io, host);

    expect(code).toBe(0);
    expect(host.frames).toEqual([]);
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    expect(readFileSync(join(drops, readdirSync(drops)[0] as string), 'utf8')).toBe('from the owner — admitted by: the owner\n\nline one\nline two\n');
    expect(pane.typed[0]).not.toContain('line one');
  });

  test('the orchestrator from its recorded pane may send, and its id rides the drop file', async () => {
    const { root, dir, sockets } = world();
    registerSeat('lead', 'coordinator', 'w1:p1');
    record(dir, 'lead', 'w1:p1');
    const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });

    const code = await runSend(['lead', 'a note'], io, fake(sockets, { native: scripted(['idle', 'working']) }));

    expect(code).toBe(0);
    expect(io.out).toMatch(/^lead: delivered \(typed, socket .+\)\n$/);
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    expect(readFileSync(join(drops, readdirSync(drops)[0] as string), 'utf8')).toBe(
      `from agt_${Buffer.from('lead').toString('hex').padEnd(12, '0')} (lead, lead@acme) — admitted by: an orchestrator to another orchestrator\n\na note`,
    );
  });

  test('a seat of the team reaches its own orchestrator, and the header names it', async () => {
    const { root, dir, sockets } = world();
    registerSeat('helper', 'implementer', 'w2:p1');
    record(dir, 'helper', 'w2:p1');
    const io = testIo(root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });

    const code = await runSend(['lead', 'a note'], io, fake(sockets, { native: scripted(['idle', 'working']) }));

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toMatch(/^lead: delivered \(typed, socket .+\)\n$/);
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    expect(readFileSync(join(drops, readdirSync(drops)[0] as string), 'utf8')).toBe(
      `from agt_${Buffer.from('helper').toString('hex').padEnd(12, '0')} (helper, helper@acme) — admitted by: a seat to its own team's orchestrator\n\na note`,
    );
  });

  test('a seat the file declares, with no agent record yet, is judged as that seat — and the header says so', async () => {
    // The bootstrap: herdr placed this caller on the pane the live file declares for the seat, so
    // the own-team rules judge it as that seat before any record exists for it.
    const { root, dir, sockets } = world();
    record(dir, 'helper', 'w2:p1');
    const io = testIo(root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });

    const code = await runSend(['lead', 'a note'], io, fake(sockets, { native: scripted(['idle', 'working']) }));

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toMatch(/^lead: delivered \(typed, socket .+\)\n$/);
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    expect(readFileSync(join(drops, readdirSync(drops)[0] as string), 'utf8')).toBe(
      "from the file's seat helper (no registry record yet) — admitted by: a seat to its own team's orchestrator\n\na note",
    );
  });
});

describe('team send: refused', () => {
  test('an unknown seat names the file s seats and sends nothing', async () => {
    const { root, sockets } = world();
    const host = fake(sockets);
    const io = owner(root);

    const code = await runSend(['ghost', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain('ghost: it is not a declared seat');
    expect(io.err).toContain('lead, helper, native');
    expect(host.frames).toEqual([]);
  });

  test('a worker seat may not send to another worker, and the refusal names the rules', async () => {
    const { root, dir, sockets } = world();
    registerSeat('helper', 'implementer', 'w2:p1');
    record(dir, 'helper', 'w2:p1');
    const host = fake(sockets);
    const io = testIo(root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });

    const code = await runSend(['native', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('helper@acme may not send to native@acme: no rule admits it');
    expect(io.err).toContain("a seat to its own team's orchestrator");
    expect(host.frames).toEqual([]);
  });

  test('a caller with neither an agent record nor a seat in the file is refused, and the refusal names the command that records it', async () => {
    const { root, dir, sockets } = world();
    record(dir, 'drifter', 'w9:p9');
    const host = fake(sockets);
    const io = testIo(root, { kind: 'seat', name: 'drifter', pane: 'w9:p9', session: 'acme' });

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('drifter: no agent record on this machine, so no rule admits the send');
    expect(io.err).toContain('`team up` registers a seat it leaves standing');
    // The file declares no seat "drifter", so `register` is not named: it reads the same file and
    // would refuse a name the file does not hold.
    expect(io.err).not.toContain('`team register');
    expect(host.frames).toEqual([]);
  });

  test('a native --wait is refused before anything is written', async () => {
    const { root, dir, sockets } = world();
    const host = fake(sockets, { agents: () => [{ name: 'native', pane: 'w9:p1' }] });
    const io = owner(root);

    const code = await runSend(['native', 'hello', '--wait'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('native runs codex');
    expect(io.err).toContain('does not carry its reply');
    expect(io.err).toContain('nothing was sent');
    expect(host.frames).toEqual([]);
    expect(existsSync(join(dir, 'send-drops'))).toBe(false);
  });

  test('a message over the measured limit is refused, never truncated', async () => {
    const { root, sockets } = world();
    const host = fake(sockets);
    const io = owner(root);

    const code = await runSend(['lead', 'x'.repeat(FRAME_LIMIT), '--wait'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('too large for this channel');
    expect(io.err).toContain(String(FRAME_LIMIT));
    expect(host.frames).toEqual([]);
  });

  test('a lock another command holds refuses the send', async () => {
    const { root, dir, sockets } = world();
    writeFileSync(join(sockets, '222.sock'), '');
    mkdirSync(join(dir, 'seat-locks', 'acme'), { recursive: true });
    writeFileSync(seatLockPath(dir, 'acme', 'lead'), `${String(process.pid)} deadbeef\n`);
    const host = fake(sockets);
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain(`another command holds it (pid ${String(process.pid)})`);
    expect(host.frames).toEqual([]);
  });
});

describe('team send: unreachable', () => {
  test('a session that cannot be read is unreachable', async () => {
    const { root, sockets } = world();
    const host = fake(sockets, { agents: () => null });
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('lead: unreachable');
    expect(io.err).toContain('could not be read');
  });

  test('no live agent of that name is unreachable', async () => {
    const { root, sockets } = world();
    const host = fake(sockets, { agents: () => [] });
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('no live agent carries that name in the session');
  });

  test('no socket for the pane s processes is unreachable', async () => {
    const { root, sockets } = world();
    const host = fake(sockets);
    const io = owner(root);

    const code = await runSend(['lead', 'hello', '--wait'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('unreachable');
    expect(io.err).toContain('no cross-session socket was found');
    expect(io.err).toContain(sockets);
  });

  test('a socket path with no listener is unreachable through the real client', async () => {
    const { root, sockets } = world();
    // A closed listener here removes its file (measured: `server.close()` unlinks it, so the
    // sender then reads "no socket found"), so the stale path is a plain file at the measured
    // name — the state a socket left by a session that is gone can hold.
    writeFileSync(join(sockets, '222.sock'), '');
    const host = fake(sockets, { deliver: (socketPath, frame) => sendFrame(socketPath, frame) });
    const io = owner(root);

    const code = await runSend(['lead', 'hello', '--wait'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('lead: unreachable');
    // What a non-socket file at the socket's path answers, measured on two platforms: ENOTSOCK on
    // macOS (this build's own run) and ECONNREFUSED on the ubuntu runner (the pull request run's
    // log, 2026-10-10T20:27:34.8654866Z). The client maps both to one sentence; the test accepts
    // either, so neither platform's kernel is baked in.
    expect(io.err).toMatch(/nothing is listening there \((the path is not a socket|the connection was refused)\)/);
  });
});

describe('team send: usage and configuration', () => {
  test('no seat and no message is a usage error that prints the usage', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend([], io, fake(sockets));

    expect(code).toBe(2);
    expect(io.err).toContain('team send: a seat and a message are required');
    expect(io.err).toContain('Usage: team send <seat> <message>');
  });

  test('a seat with no message is a usage error', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['lead'], io, fake(sockets));

    expect(code).toBe(2);
    expect(io.err).toContain('a message or --file is required');
  });

  test('a message and --file together are a usage error', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['lead', 'hello', '--file', 'note.txt'], io, fake(sockets));

    expect(code).toBe(2);
    expect(io.err).toContain('a message and --file cannot both be given');
  });

  test('an empty message is a usage error', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['lead', ''], io, fake(sockets));

    expect(code).toBe(2);
    expect(io.err).toContain('the message is empty');
  });

  test('a message file that cannot be read is a configuration error', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['lead', '--file', 'missing.txt'], io, fake(sockets));

    expect(code).toBe(2);
    expect(io.err).toContain('the message file cannot be read: missing.txt');
  });
});

/** `fake`, whose deliver also makes the seat answer: a message written back to the sender's
 *  own pid socket, the address the receiving side derives. `reply === null` answers nothing
 *  (the timeout case). */
function replying(sockets: string, reply: string | null, patch: Partial<SendHost> = {}): Fake {
  const host = fake(sockets, patch);
  const record = host.deliver;
  host.deliver = async (socketPath, frame) => {
    const outcome = await record(socketPath, frame);
    if (reply !== null) {
      const back = createConnection(senderSocket(sockets));
      back.on('error', () => {});
      back.on('connect', () => back.end(`${reply}\n`));
    }
    return outcome;
  };
  return host;
}

/** The sender's own listener path: `<sockets>/<this process's pid>.sock`, as the session on
 *  the other side computes it from the connection's verified pid. */
function senderSocket(sockets: string): string {
  return join(sockets, `${String(process.pid)}.sock`);
}

const REPLY_FRAME = '{"type":"user","message":{"role":"user","content":"pong"},"msg_id":"reply-1"}';

/** The measured shape a replying session's harness writes: the body inside its attribution
 *  wrapper (see reply.ts). */
const WRAPPED_REPLY = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: '<cross-session-message from="uds:/tmp/cc-socks/14495.sock" from-name="lobby-93" from-mode="bypass">\npong\n</cross-session-message>',
  },
  msg_id: 'reply-2',
});

describe('team send: --wait', () => {
  test('writes one measured frame through the real socket client and says it was sent', async () => {
    const { root, dir, sockets } = world();
    const { received } = await listen(sockets, 222);
    const io = owner(root);
    const host = fake(sockets, { deliver: (socketPath, frame) => sendFrame(socketPath, frame) });

    const code = await runSend(['lead', 'hello', 'world', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain('sent, no reply within 1s');
    expect(io.err).not.toContain('delivered');
    await until(() => received.length > 0);
    const frame = received.join('');
    expect(frame.endsWith('\n')).toBe(true);
    expect((frame.match(/\n/g) ?? []).length).toBe(1);
    const parsed = JSON.parse(frame) as { type: string; message: { role: string; content: string }; msg_id: string };
    expect(parsed.type).toBe('user');
    expect(parsed.message).toEqual({ role: 'user', content: 'from the owner — admitted by: the owner\n\nhello world' });
    expect(parsed.msg_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const log = readFileSync(join(dir, LOG_FILE), 'utf8');
    expect(log).toContain('lead: sent on the socket (');
    expect(log).not.toContain('hello world');
    expect(log).not.toContain('delivered');
  });

  test('the pane probe takes the first process with a socket, shell included', async () => {
    const { root, sockets } = world();
    // Only the shell's pid has a socket: the foreground pids are tried first, then the shell.
    writeFileSync(join(sockets, '111.sock'), '');
    const host = fake(sockets);
    const io = owner(root);

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(host.socketsTried).toEqual([join(sockets, '111.sock')]);
    expect(host.frames.length).toBe(1);
  });

  test("the seat's reply is printed, the listener is gone and the log keeps no text", async () => {
    const { root, dir, sockets } = world();
    writeFileSync(join(sockets, '222.sock'), '');
    const io = owner(root);

    const code = await runSend(['lead', 'ping', '--wait'], io, replying(sockets, REPLY_FRAME));

    expect(code).toBe(0);
    expect(io.out).toBe('lead: answered\npong\n');
    expect(io.err).toBe('');
    expect(existsSync(senderSocket(sockets))).toBe(false);
    const log = readFileSync(join(dir, LOG_FILE), 'utf8');
    expect(log).toContain('lead: answered (reply 4 characters)');
    expect(log).not.toContain('pong');
  });

  test('--json answered: the document carries the reply and both ids', async () => {
    const { root, sockets } = world();
    writeFileSync(join(sockets, '222.sock'), '');
    const host = replying(sockets, REPLY_FRAME);
    const io = owner(root);

    const code = await runSend(['lead', 'ping', '--wait', '--json'], io, host);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    const doc = JSON.parse(io.out) as { seat: string; status: string; exit: number; reply: string; ids: { sent: string; reply: string } };
    const sent = JSON.parse((host.frames[0] as string).trim()) as { msg_id: string };
    expect(doc).toEqual({ seat: 'lead', status: 'answered', exit: 0, reply: 'pong', ids: { sent: sent.msg_id, reply: 'reply-1' } });
  });

  test("a reply line that is not this channel's frame is kept whole", async () => {
    const { root, sockets } = world();
    writeFileSync(join(sockets, '222.sock'), '');
    const io = owner(root);

    const code = await runSend(['lead', 'ping', '--wait'], io, replying(sockets, 'plain words, not JSON'));

    expect(code).toBe(0);
    expect(io.out).toBe('lead: answered\nplain words, not JSON\n');
  });

  test("the replying harness's wrapper is peeled off, and the frame's own id is kept", async () => {
    const { root, sockets } = world();
    writeFileSync(join(sockets, '222.sock'), '');
    const io = owner(root);

    const code = await runSend(['lead', 'ping', '--wait'], io, replying(sockets, WRAPPED_REPLY));

    expect(code).toBe(0);
    expect(io.out).toBe('lead: answered\npong\n');

    const doc = owner(root);
    expect(await runSend(['lead', 'ping', '--wait', '--json'], doc, replying(sockets, WRAPPED_REPLY))).toBe(0);
    const parsed = JSON.parse(doc.out) as { reply: string; ids: { reply: string } };
    expect(parsed.reply).toBe('pong');
    expect(parsed.ids.reply).toBe('reply-2');
  });

  test('no reply within the window: timeout, exit 1, nothing on stdout', async () => {
    const { root, dir, sockets } = world();
    writeFileSync(join(sockets, '222.sock'), '');
    const io = owner(root);

    const code = await runSend(['lead', 'ping', '--wait', '--timeout', '1'], io, replying(sockets, null));

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain('lead: timeout: sent, no reply within 1s; a seat which does not accept messages from other sessions holds the frame until a person lets it through');
    expect(io.err).not.toContain('delivered');
    expect(existsSync(senderSocket(sockets))).toBe(false);
    const log = readFileSync(join(dir, LOG_FILE), 'utf8');
    // The write is recorded first; the window closing is its own line. Neither says delivered.
    expect(log).toContain('lead: sent on the socket (');
    expect(log).toContain('lead: timeout (sent, no reply within 1s)');
    expect(log).not.toContain('delivered');
  });

  test('--json timeout: a document that says the frame was sent and no reply came', async () => {
    const { root, sockets } = world();
    writeFileSync(join(sockets, '222.sock'), '');
    const io = owner(root);

    const code = await runSend(['lead', 'ping', '--wait', '--timeout', '1', '--json'], io, replying(sockets, null));

    expect(code).toBe(1);
    expect(io.err).toBe('');
    const doc = JSON.parse(io.out) as { seat: string; status: string; exit: number; error: string; ids: { sent: string | null } };
    expect(doc.status).toBe('timeout');
    expect(doc.exit).toBe(1);
    expect(doc.error).toBe('sent, no reply within 1s; a seat which does not accept messages from other sessions holds the frame until a person lets it through');
    expect(typeof doc.ids.sent).toBe('string');
    expect('reply' in doc).toBe(false);
  });

  test("a dead file at the sender's own pid path is cleared, and the reply still lands", async () => {
    const { root, sockets } = world();
    writeFileSync(join(sockets, '222.sock'), '');
    writeFileSync(senderSocket(sockets), '');
    const io = owner(root);

    const code = await runSend(['lead', 'ping', '--wait'], io, replying(sockets, 'pong'));

    expect(code).toBe(0);
    expect(io.out).toBe('lead: answered\npong\n');
  });

  test("a live listener at the sender's own pid path refuses before anything is sent", async () => {
    const { root, sockets } = world();
    writeFileSync(join(sockets, '222.sock'), '');
    await listen(sockets, process.pid);
    const host = replying(sockets, 'pong');
    const io = owner(root);

    const code = await runSend(['lead', 'ping', '--wait'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('refused');
    expect(io.err).toContain('a listener already answers at');
    expect(host.frames).toEqual([]);
  });
});

describe('team send: --timeout', () => {
  test('--timeout without --wait is a usage error', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['lead', 'ping', '--timeout', '5'], io, fake(sockets));

    expect(code).toBe(2);
    expect(io.err).toContain('--timeout is only meaningful with --wait');
  });

  test('--timeout takes a whole number of seconds within the day', async () => {
    const { root, sockets } = world();

    for (const value of ['abc', '0', '86401', '-3']) {
      const io = owner(root);
      const code = await runSend(['lead', 'ping', '--wait', '--timeout', value], io, fake(sockets));
      expect(code).toBe(2);
      expect(io.err).toContain(`--timeout takes a whole number of seconds, 1 to 86400 (got "${value}")`);
    }
  });
});

describe('team send: --list', () => {
  test("the file's seats print with their cli and their role", async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['--list'], io, fake(sockets));

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe('lead  claude-code  coordinator\nhelper  claude-code  implementer\nnative  codex  reviewer\n');
  });

  test('a worker seat may read the roster: no caller check', async () => {
    const { root, dir, sockets } = world();
    record(dir, 'helper', 'w2:p1');
    const io = testIo(root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });

    const code = await runSend(['--list'], io, fake(sockets));

    expect(code).toBe(0);
    expect(io.out).toContain('lead  claude-code  coordinator');
  });

  test('--list marks a stopped seat; --json carries the same roster as a document', async () => {
    const { root, sockets } = world();
    const file = join(root, '.agents', 'team.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('  - role: reviewer', '  - role: reviewer\n    stopped: true'));
    const io = owner(root);

    const code = await runSend(['--list', '--json'], io, fake(sockets));

    expect(code).toBe(0);
    const doc = JSON.parse(io.out) as { seat: null; status: string; exit: number; ids: { sent: null; reply: null }; seats: unknown[] };
    expect(doc).toEqual({
      seat: null,
      status: 'listed',
      exit: 0,
      ids: { sent: null, reply: null },
      seats: [
        { name: 'lead', cli: 'claude-code', role: 'coordinator', stopped: false },
        { name: 'helper', cli: 'claude-code', role: 'implementer', stopped: false },
        { name: 'native', cli: 'codex', role: 'reviewer', stopped: true },
      ],
    });
    const plain = owner(root);
    expect(await runSend(['--list'], plain, fake(sockets))).toBe(0);
    expect(plain.out).toContain('native  codex  reviewer  (stopped)');
  });
});

describe('team send: --json documents', () => {
  test('a refused send is a document on stdout; stderr stays empty', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['ghost', 'hello', '--json'], io, fake(sockets));

    expect(code).toBe(1);
    expect(io.err).toBe('');
    const doc = JSON.parse(io.out) as { status: string; error: string };
    expect(doc.status).toBe('refused');
    expect(doc.error).toContain('ghost: it is not a declared seat');
  });

  test('a usage error carries no seat and exit 2', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['--json'], io, fake(sockets));

    expect(code).toBe(2);
    expect(io.err).toBe('');
    expect(JSON.parse(io.out)).toEqual({ seat: null, status: 'usage', exit: 2, error: 'a seat and a message are required', ids: { sent: null, reply: null } });
  });

  test('an unreachable seat is a document too', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['lead', 'hello', '--json'], io, fake(sockets, { agents: () => null }));

    expect(code).toBe(1);
    const doc = JSON.parse(io.out) as { status: string; error: string };
    expect(doc.status).toBe('unreachable');
    expect(doc.error).toContain('could not be read');
  });

  test('a delivered send carries the drop file\'s id', async () => {
    const { root, dir, sockets } = world();
    const host = fake(sockets, { native: scripted(['idle', 'working']) });
    const io = owner(root);

    const code = await runSend(['lead', 'hello', '--json'], io, host);

    expect(code).toBe(0);
    expect(host.frames).toEqual([]);
    const doc = JSON.parse(io.out) as { seat: string; status: string; exit: number; ids: { sent: string; reply: null } };
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    expect(readdirSync(drops)).toEqual([doc.ids.sent]);
    expect(doc).toEqual({ seat: 'lead', status: 'delivered', exit: 0, ids: { sent: doc.ids.sent, reply: null } });
  });
});

type Scripted = NativePane & { typed: string[]; enters: number };

/** Status samples, one per read. `wait` resolves immediately so the polls cost nothing. */
function scripted(samples: string[]): Scripted {
  const typed: string[] = [];
  let enters = 0;
  let read = 0;
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
  return pane;
}

function nativeHost(sockets: string, samples: string[]): { host: Fake; pane: Scripted } {
  const pane = scripted(samples);
  const host = fake(sockets, {
    agents: () => [{ name: 'native', pane: 'w9:p1' }],
    native: pane,
  });
  return { host, pane };
}

describe('team send: native drop', () => {
  test('a codex seat is delivered when herdr reports working, and the body is not typed', async () => {
    const { root, dir, sockets } = world();
    const { host, pane } = nativeHost(sockets, ['idle', 'working']);
    const io = owner(root);
    const body = 'y'.repeat(500);
    const dropsRoot = join(dir, 'send-drops');
    const sessionDir = join(dropsRoot, 'acme');
    mkdirSync(sessionDir, { recursive: true });
    chmodSync(dropsRoot, 0o755);
    chmodSync(sessionDir, 0o755);

    const code = await runSend(['native', body], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('native: delivered\n');
    expect(host.frames).toEqual([]);
    expect(pane.typed.length).toBe(1);
    const trigger = pane.typed[0] as string;
    expect(trigger.includes('\n')).toBe(false);
    expect(trigger.length).toBeLessThanOrEqual(TRIGGER_MAX);
    expect(trigger).not.toContain(body);
    expect(pane.enters).toBe(1);
    const drops = join(dir, 'send-drops', 'acme', 'native');
    const files = readdirSync(drops);
    expect(files.length).toBe(1);
    const path = join(drops, files[0] as string);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dropsRoot).mode & 0o777).toBe(0o700);
    expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
    expect(statSync(drops).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, 'utf8')).toBe(`from the owner — admitted by: the owner\n\n${body}`);
    expect(trigger).toContain(path);
    const log = readFileSync(join(dir, LOG_FILE), 'utf8');
    expect(log).toContain('herdr status working');
    expect(log).not.toContain(body);
  });

  test('cursor, grok and antigravity take the same drop path', async () => {
    const { root, sockets } = world();
    const file = join(root, '.agents', 'team.yaml');
    const original = readFileSync(file, 'utf8');
    for (const cli of ['cursor', 'grok', 'antigravity']) {
      writeFileSync(file, original.replace('cli: codex', `cli: ${cli}`));
      const { host, pane } = nativeHost(sockets, ['idle', 'working']);
      const io = owner(root);

      const code = await runSend(['native', 'hello'], io, host);

      expect(code).toBe(0);
      expect(pane.typed.length).toBe(1);
      expect(host.frames).toEqual([]);
    }
  });

  test('a seat that stays idle through the first window is delivered on its status, with one Enter', async () => {
    const { root, sockets } = world();
    // Before Enter, then five polls of idle, then working on the next read. The pane cannot be
    // read, so nothing confirms the trigger is still in the box and no second Enter goes: the
    // status that moves in the next window is the evidence.
    const { host, pane } = nativeHost(sockets, ['idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'working']);
    const io = owner(root);

    const code = await runSend(['native', 'hello'], io, host);

    expect(code).toBe(0);
    expect(pane.enters).toBe(1);
    expect(pane.typed.length).toBe(1);
  });

  test('no working status is not-submitted, and the drop file is kept whole', async () => {
    const { root, dir, sockets } = world();
    const { host, pane } = nativeHost(sockets, ['idle']);
    const io = owner(root);

    const code = await runSend(['native', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('not-submitted');
    expect(io.err).toContain('the seat did not take the trigger after 1 Enter; the box could not be read');
    expect(pane.enters).toBe(1);
    expect(pane.typed.length).toBe(1);
    const drops = join(dir, 'send-drops', 'acme', 'native');
    const name = readdirSync(drops)[0] as string;
    expect(io.err).toContain(join(drops, name));
    expect(readFileSync(join(drops, name), 'utf8')).toBe('from the owner — admitted by: the owner\n\nhello');
  });

  test('a codex seat already at done is not delivered until the status changes', async () => {
    const { root, sockets } = world();
    const stayed = nativeHost(sockets, ['done']);
    const io = owner(root);
    expect(await runSend(['native', 'hello'], io, stayed.host)).toBe(1);

    const moved = nativeHost(sockets, ['done', 'working']);
    const again = owner(root);
    expect(await runSend(['native', 'hello'], again, moved.host)).toBe(0);
    expect(again.out).toBe('native: delivered\n');
  });

  test('two sends to one seat do not interleave triggers', async () => {
    const { root, sockets } = world();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waits = 0;
    const typed: string[] = [];
    const host = fake(sockets, {
      agents: () => [{ name: 'native', pane: 'w9:p1' }],
      native: {
        typeText: (_session, _pane, text) => {
          typed.push(text);
          return true;
        },
        pressEnter: () => true,
        status: () => (waits < 2 ? 'idle' : 'working'),
        wait: () => {
          waits += 1;
          return waits === 1 ? gate : Promise.resolve();
        },
      },
    });
    const first = runSend(['native', 'one'], owner(root), host);
    const started = Date.now();
    while (typed.length === 0 && Date.now() - started < 1000) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await runSend(['native', 'two'], owner(root), host);
    expect(second).toBe(1);
    release();
    expect(await first).toBe(0);
    expect(typed.length).toBe(1);
    expect(typed[0]).not.toContain('one');
    expect(typed[0]).not.toContain('two');
  });

  test('--dry-run names the channel and writes nothing', async () => {
    const { root, dir, sockets } = world();
    const { host, pane } = nativeHost(sockets, ['working']);
    const io = owner(root);

    const code = await runSend(['native', 'hello', '--dry-run'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('native: dry-run: codex via a 0600 drop file and one trigger line; nothing was written\n');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(existsSync(join(dir, 'send-drops'))).toBe(false);
    const json = owner(root);
    expect(await runSend(['lead', 'hello', '--dry-run', '--json'], json, fake(sockets))).toBe(0);
    expect(JSON.parse(json.out)).toEqual({ seat: 'lead', status: 'dry-run', exit: 0, ids: { sent: null, reply: null } });
    const claude = owner(root);
    expect(await runSend(['lead', 'hello', '--dry-run'], claude, fake(sockets))).toBe(0);
    expect(claude.out).toBe('lead: dry-run: claude-code via its cross-session socket, falling back to a 0600 drop file and one trigger line; nothing was written\n');
    const waited = owner(root);
    expect(await runSend(['lead', 'hello', '--wait', '--dry-run'], waited, fake(sockets))).toBe(0);
    expect(waited.out).toBe('lead: dry-run: claude-code via the cross-session socket; nothing was sent\n');
  });

  test('a pane that rejects the trigger is unreachable and the file remains', async () => {
    const { root, dir, sockets } = world();
    const host = fake(sockets, {
      agents: () => [{ name: 'native', pane: 'w9:p1' }],
      native: { ...quietNative(), status: () => 'idle', typeText: () => false },
    });
    const io = owner(root);

    const code = await runSend(['native', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('the pane did not take the trigger');
    const drops = join(dir, 'send-drops', 'acme', 'native');
    expect(readFileSync(join(drops, readdirSync(drops)[0] as string), 'utf8')).toBe('from the owner — admitted by: the owner\n\nhello');
  });

  test('a dialog the classifier already knows is not reached, and nothing further is pressed', async () => {
    const { root, dir, sockets } = world();
    const question = readFileSync(new URL('./fixtures/claude-code/2.1.289/question-plain.txt', import.meta.url), 'utf8');
    const permission = readFileSync(new URL('./fixtures/codex/0.157.0/permission.txt', import.meta.url), 'utf8');
    const asked = scripted(['idle', 'working']);
    asked.paneText = () => question;
    const lead = fake(sockets, { native: asked });
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, lead);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain('not reached');
    expect(io.err).toContain('the screen reads question');
    const leadDrops = join(dir, 'send-drops', 'acme', 'lead');
    expect(io.err).toContain(join(leadDrops, readdirSync(leadDrops)[0] as string));
    expect(asked.enters).toBe(0);
    expect(asked.typed).toEqual([]);
    expect(lead.frames).toEqual([]);

    const held = scripted(['idle']);
    held.paneText = () => permission;
    const host = fake(sockets, {
      agents: () => [{ name: 'native', pane: 'w9:p1' }],
      native: held,
    });
    const again = owner(root);
    expect(await runSend(['native', 'hello'], again, host)).toBe(1);
    expect(again.err).toContain('not reached');
    expect(again.err).toContain('the screen reads permission');
    expect(held.enters).toBe(0);
    expect(held.typed).toEqual([]);
  });

  test('a screen that is not one of those dialogs still follows the status rule', async () => {
    const { root, sockets } = world();
    const pane = scripted(['idle', 'working']);
    pane.paneText = () => 'no dialog on this screen\n';
    const host = fake(sockets, { native: pane });
    const io = owner(root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
    expect(io.out).toMatch(/^lead: delivered \(typed, socket .+\)\n$/);
  });
});

describe('native delivery core', () => {
  test('sawSubmission treats a leftover done as not a new submit', () => {
    expect(sawSubmission('idle', ['working'])).toBe(true);
    expect(sawSubmission('done', ['done'])).toBe(false);
    expect(sawSubmission('done', ['working'])).toBe(true);
    expect(sawSubmission('idle', ['done'])).toBe(true);
    expect(sawSubmission('idle', ['idle', 'idle'])).toBe(false);
    expect(sawSubmission('idle', ['blocked'])).toBe(true);
    // A seat that was already working proves nothing by its status: its turn is not this line.
    expect(sawSubmission('working', ['working'])).toBe(false);
    expect(sawSubmission('working', ['working', 'done'])).toBe(false);
    expect(sawSubmission('working', ['idle', 'working'])).toBe(false);
  });

  test('dropMessage keeps a long body whole at mode 0600', () => {
    const { dir } = world();
    const body = `S${'y'.repeat(4000)}E`;
    const path = dropMessage(join(dir, 'drops'), 'one', body);
    expect(readFileSync(path, 'utf8')).toBe(body);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(triggerLine(path)).toBe(`Read ${path} and do that.`);
    expect(triggerLine(`${'p'.repeat(TRIGGER_MAX)}`)).toBeNull();
  });
});
