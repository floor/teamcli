// `team send`: the socket channel against fixtures — a fake seat, a fake sockets folder, and a
// real unix socket (a listener this test owns). No pane is read and no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { plantRecord } from '../src/commands/messages.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import type { ProjectSources, ProjectView } from '../src/commands/projects.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { historyPath, readHistory } from '../src/send/history.ts';
import { receiptPath } from '../src/mcp/inbox.ts';
import { signReceiptPayload, writeReceipt } from '../src/send/record.ts';
import { dropMessage, readTriggerLine, sawSubmission, triggerLine, TRIGGER_MAX, type NativePane } from '../src/send/native.ts';
import { FRAME_LIMIT, sendFrame, type SendOutcome } from '../src/send/uds.ts';
import { readReply } from '../src/send/reply.ts';
import { SEND_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { LOG_FILE, updateState } from '../src/state.ts';
import { recordBody, testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

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
operator: lead
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
# The scenes below exercise the typed leg: the inbox is tried first and skipped for want of a
# listener, then the trigger line is typed. The team's word keeps the drop leg (the default's
# second step) out, which is what these fixtures have always walked.
delivery_order: [mcp-inbox, typed]
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
 *  header, and the reach its rules read. The id is returned so a team record can roster it. */
function registerSeat(seat: string, role: string, pane = 'w1:p1', team = 'acme'): string {
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
      `  team: "${team}"`,
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
  return id;
}

function record(dir: string, seat: string, pane: string): void {
  updateState(dir, (state) => {
    state.sessions.acme = { seats: { [seat]: { stage: 'launched', pane, workspace: 'w1' } }, worktrees: {} };
  });
}

/** The team's registry record, and the target seat's agent record on the id the registry keys the
 *  team by, as `up` writes both: a plain-seat spec resolves through the registry, so the send
 *  rides the resolved-target path while the sender's own record is still missing. */
function registerTarget(root: string, seat: string, role: string, pane = 'w1:p1'): void {
  const home = join(base, 'home');
  const id = teamIdOf(root);
  const agent = registerSeat(seat, role, pane, id);
  upsertTeam(home, id, {
    project: 'acme',
    entity: 'acme',
    session: 'acme',
    root,
    lobby: lobbyDir(home),
    roster: [{ agent, seat, role, leads: false }],
    lifecycle: 'running',
    by: 'test',
  });
}

const owner = (root: string) => testIo(root, { kind: 'owner' });

describe('team send: the typed trigger', () => {
  test('a Claude Code seat with no socket takes the typed trigger when herdr reports working', async () => {
    const { root, dir, sockets } = world();
    const pane = scripted(['idle', 'working']);
    const host = fake(sockets, { native: pane });
    const io = owner(root);

    const code = await runSend(['lead', 'hello', 'world'], io, host);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    // The trigger left the composer, and no signed read receipt came back: the send is
    // `sent (unconfirmed)`, never delivered.
    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
    expect(host.frames).toEqual([]);
    expect(pane.typed.length).toBe(1);
    // The body's first line is the summary the typed line carries; the body itself stays in the drop.
    expect(pane.typed[0]).toContain('hello world');
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    const path = join(drops, readdirSync(drops).find((name) => !name.includes('.')) as string);
    expect(recordBody(path)).toBe('from the owner — admitted by: the owner\n\nhello world');
    expect(pane.typed[0]).toBe(readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello world' }) as string);
    const log = readFileSync(join(dir, LOG_FILE), 'utf8');
    expect(log).toContain('send [owner] lead: sent (unconfirmed)');
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
    expect(recordBody(join(drops, readdirSync(drops).find((name) => !name.includes('.')) as string))).toBe('from the owner — admitted by: the owner\n\nline one\nline two\n');
    expect(pane.typed[0]).toContain('line one');
  });

  test('the orchestrator from its recorded pane may send, and its id rides the record while the header names the seat', async () => {
    const { root, dir, sockets } = world();
    registerSeat('lead', 'coordinator', 'w1:p1');
    record(dir, 'lead', 'w1:p1');
    const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });

    const code = await runSend(['lead', 'a note'], io, fake(sockets, { native: scripted(['idle', 'working']) }));

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    expect(recordBody(join(drops, readdirSync(drops).find((name) => !name.includes('.')) as string))).toBe(
      'from lead — admitted by: an orchestrator to another orchestrator\n\na note',
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
    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    expect(recordBody(join(drops, readdirSync(drops).find((name) => !name.includes('.')) as string))).toBe(
      "from helper — admitted by: a seat to its own team's orchestrator\n\na note",
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
    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    expect(recordBody(join(drops, readdirSync(drops).find((name) => !name.includes('.')) as string))).toBe(
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

  test('a worker seat reaches another declared seat of its own team, and the header names the rule', async () => {
    const { root, dir, sockets } = world();
    registerSeat('helper', 'implementer', 'w2:p1');
    record(dir, 'helper', 'w2:p1');
    const host = fake(sockets, {
      agents: () => [{ name: 'lead', pane: 'w1:p1' }, { name: 'native', pane: 'w9:p1' }],
      native: scripted(['idle', 'working']),
    });
    const io = testIo(root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });

    const code = await runSend(['native', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe('team acme, session "acme"\nnative: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
    const drops = join(dir, 'send-drops', 'acme', 'native');
    expect(recordBody(join(drops, readdirSync(drops).find((name) => !name.includes('.')) as string))).toBe(
      'from helper — admitted by: a seat to a declared seat of its own team\n\nhello',
    );
  });

  test('a caller with neither an agent record nor a seat in the file is refused, and the refusal names the command that records it', async () => {
    const { root, dir, sockets } = world();
    record(dir, 'drifter', 'w9:p9');
    const host = fake(sockets);
    const io = testIo(root, { kind: 'seat', name: 'drifter', pane: 'w9:p9', session: 'acme' });

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('sender drifter has no agent record on this machine, so no rule admits the send');
    expect(io.err).toContain('`team up` registers a seat it leaves standing');
    // The file declares no seat "drifter", so `register` is not named: it reads the same file and
    // would refuse a name the file does not hold.
    expect(io.err).not.toContain('`team register');
    expect(host.frames).toEqual([]);
  });

  test('a record-less seat on another pane is refused when the target has a registry record', async () => {
    // The declared judgement asks placement whatever the spec resolved to: the state records
    // helper on w2:p1, and this call is on w9:p9.
    const { root, dir, sockets } = world();
    registerTarget(root, 'lead', 'coordinator');
    record(dir, 'helper', 'w2:p1');
    const host = fake(sockets);
    const io = testIo(root, { kind: 'seat', name: 'helper', pane: 'w9:p9', session: 'acme' });

    const code = await runSend(['lead', 'a note'], io, host);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain('the state records pane w2:p1 for seat helper in this session, not the pane this call is on');
    expect(host.frames).toEqual([]);
  });

  test('a record-less seat placed in another session is refused', async () => {
    // The seat is judged where it stands: the pane matches, but the call is not placed in the
    // session the seat is judged in, so the caller is not that seat.
    const { root, dir, sockets } = world();
    registerTarget(root, 'lead', 'coordinator');
    record(dir, 'helper', 'w2:p1');
    const host = fake(sockets);
    const io = testIo(root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'elsewhere' });

    const code = await runSend(['lead', 'a note'], io, host);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain('seat helper stands in session acme, and this call is not placed in it');
    expect(host.frames).toEqual([]);
  });

  test('a native --wait walks the typed leg and waits on the thread without dialing the socket', async () => {
    const { root, dir, sockets } = world();
    const { host, pane } = nativeHost(sockets, ['idle', 'working']);
    host.waitMs = 0;
    const io = owner(root);

    const code = await runSend(['native', 'hello', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.err).toBe('team send: native: timeout: sent, no reply on the thread within 1s; the thread stays open\n');
    expect(host.frames).toEqual([]);
    expect(pane.typed.length).toBe(1);
    expect(existsSync(join(dir, 'send-drops', 'acme', 'native'))).toBe(true);
  });

  test('a --wait message over the socket limit still writes the drop record and waits on the thread', async () => {
    const { root, sockets } = world();
    const host = fake(sockets, { native: scripted(['idle', 'working']), waitMs: 0 });
    const io = owner(root);

    const code = await runSend(['lead', 'x'.repeat(FRAME_LIMIT), '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.err).toBe('team send: lead: timeout: sent, no reply on the thread within 1s; the thread stays open\n');
    expect(io.err).not.toContain('too large');
    expect(host.frames).toEqual([]);
  });

  test('a lock another command holds queues the send instead of refusing it', async () => {
    const { root, dir, sockets } = world();
    writeFileSync(join(sockets, '222.sock'), '');
    mkdirSync(join(dir, 'seat-locks', 'acme'), { recursive: true });
    writeFileSync(seatLockPath(dir, 'acme', 'lead'), `${String(process.pid)} deadbeef\n`);
    const host = fake(sockets);
    const io = owner(root);

    const code = await runSend(['lead', 'hello'], io, host);

    // A held seat is a queue: the typed leg's record and marker are written without that lock,
    // nothing is dialed or typed, and the run answers with the id the delivery keeps.
    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toMatch(/lead: queued \(receiver busy\) \(typed, \d+ ms; id [0-9a-f-]+\)\n$/);
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    const names = readdirSync(drops);
    // The record's own name is the bare id; the marker and the walk's own sidecars carry a
    // suffix, and the sidecar is not a second drop.
    const id = names.find((name) => /^[0-9a-f-]{36}$/.test(name));
    expect(id).toBeDefined();
    expect(names).toContain(`${id}.pending`);
    expect(recordBody(join(drops, id as string))).toBe('from the owner — admitted by: the owner\n\nhello');
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

  test('--wait never looks for a cross-session socket', async () => {
    const { root, sockets } = world();
    const host = fake(sockets, { native: scripted(['idle', 'working']), waitMs: 0 });
    const io = owner(root);

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.err).toBe('team send: lead: timeout: sent, no reply on the thread within 1s; the thread stays open\n');
    expect(io.err).not.toContain('no cross-session socket was found');
    expect(host.socketsTried).toEqual([]);
  });

  test('the real client maps a non-socket file at the path to one sentence (measured)', async () => {
    const { sockets } = world();
    // A closed listener removes its file (measured: `server.close()` unlinks it), so the stale
    // path is a plain file at the measured name — the state a socket left by a session that is
    // gone can hold. sendFrame is called directly: no runSend path dials, and this measurement is
    // the client's own, kept for the day the socket is the channel again.
    writeFileSync(join(sockets, '222.sock'), '');
    const taken = await sendFrame(join(sockets, '222.sock'), '{"type":"user"}\n');
    expect(taken.ok).toBe(false);
    if (taken.ok) return;
    // What a non-socket file at the socket's path answers, measured on two platforms: ENOTSOCK on
    // macOS (this build's own run) and ECONNREFUSED on the ubuntu runner (the pull request run's
    // log, 2026-10-10T20:27:34.8654866Z). The client maps both to one sentence; the test accepts
    // either, so neither platform's kernel is baked in.
    expect(taken.reason).toMatch(/nothing is listening there \((the path is not a socket|the connection was refused)\)/);
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
  test('--wait writes the signed record without dialing the socket and times out on the thread when no reply arrives', async () => {
    const { root, dir, sockets } = world();
    const { received } = await listen(sockets, 222);
    const io = owner(root);
    const host = fake(sockets, {
      native: scripted(['idle', 'working']),
      deliver: (socketPath, frame) => sendFrame(socketPath, frame),
      waitMs: 0,
    });

    const code = await runSend(['lead', 'hello', 'world', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe('team send: lead: timeout: sent, no reply on the thread within 1s; the thread stays open\n');
    expect(received).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.socketsTried).toEqual([]);
    expect(existsSync(senderSocket(sockets))).toBe(false);
    const log = readFileSync(join(dir, LOG_FILE), 'utf8');
    expect(log).toContain('lead: timeout (sent, no reply on the thread within 1s; the thread stays open)');
    expect(log).not.toContain('hello world');
  });

  test('--json --wait returns answered with ids.sent, ids.reply and thread when a reply record arrives on the thread', async () => {
    const { root, sockets } = world();
    const sentId = '44444444-4444-4444-8444-444444444444';
    const host = fake(sockets, {
      native: scripted(['idle', 'working']),
      sendId: () => sentId,
      waitMs: 0,
    });
    plantRecord(host.home, root, 'acme', 'owner', 'reply-1', 'pong', {
      from: 'lead',
      at: NOW.toISOString(),
      thread: sentId,
      in_reply_to: sentId,
    });
    const io = owner(root);

    const code = await runSend(['lead', 'ping', '--wait', '--json'], io, host);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    assertMatchesOutputSchema(io.out, SEND_OUTPUT_SCHEMA);
    const doc = JSON.parse(io.out) as Record<string, unknown>;
    expect(doc).toEqual({
      schema: { name: 'team.send', version: 1 },
      format: 1,
      dry_run: false,
      status: 'answered',
      action_summary: 'lead: answered',
      project: 'acme',
      session: 'acme',
      seat: 'lead',
      channel: 'typed',
      delivery: [
        { leg: 'mcp-inbox', state: 'skipped', reason: 'no live inbox listener' },
        { leg: 'typed', state: 'attempted' },
      ],
      thread: sentId,
      ids: { sent: sentId, reply: 'reply-1' },
      reply: 'pong',
    });
    expect(host.frames).toEqual([]);
  });
});

// The reply reader, exercised on its own: no run reaches it while SOCKET_SEND is off, and the
// measured peel (reply.ts) is what a waited send reads again when the native leg ships.
describe('the reply line reader', () => {
  test('peels the measured wrapper and keeps the frame id', () => {
    expect(readReply(REPLY_FRAME)).toEqual({ reply: 'pong', msg_id: 'reply-1' });
    expect(readReply(WRAPPED_REPLY)).toEqual({ reply: 'pong', msg_id: 'reply-2' });
    expect(readReply('plain words, not JSON')).toEqual({ reply: 'plain words, not JSON', msg_id: null });
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
  test("the file's seats print with their cli, their role and the project they sit in", async () => {
    const { root, dir, sockets } = world();
    const io = owner(root);

    const code = await runSend(['--list'], io, fake(sockets));

    expect(code).toBe(0);
    expect(io.err).toBe('');
    // A listing reads the roster and writes nothing, so it adds no line to the log.
    expect(existsSync(join(dir, LOG_FILE))).toBe(false);
    // No project source is handed in: each seat's project is its team's own (a team the registry
    // places in none is its own project). The table is the contract's: the seat, its role, the
    // project it sits in, and the reach a send would take.
    expect(io.out).toBe(
      'team acme, session "acme"\n'
        + '  SEAT    NICKNAME  ROLE         PROJECT  REACH\n'
        + '  lead    -         coordinator  acme     socket\n'
        + '  helper  -         implementer  acme     socket\n'
        + '  native  -         reviewer     acme     typed\n'
        + '3 seats\n',
    );
  });

  test('a worker seat may read the roster: no caller check', async () => {
    const { root, dir, sockets } = world();
    record(dir, 'helper', 'w2:p1');
    const io = testIo(root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });

    const code = await runSend(['--list'], io, fake(sockets));

    expect(code).toBe(0);
    expect(io.out).toContain('  lead    -         coordinator  acme     socket');
  });

  test("a registry that names the team's project shows that project on every row", async () => {
    const { root, sockets } = world();
    const io = owner(root);
    // The team file calls its project "acme"; the registry places this team in the project named
    // "TeamCLI" — its name is the one the roster carries.
    const project: ProjectView = {
      id: '4f2a1b7c9d0e',
      name: 'TeamCLI',
      entity: 'floor',
      lead: 'agt_2b9f',
      teams: [teamIdOf(root)],
      provenance: { registered_by: 'test', registered_at: NOW.toISOString(), updated_at: NOW.toISOString() },
    };
    const projects: ProjectSources = {
      list: () => [project],
      byName: (key) => (project.name === key ? project : null),
      ofTeam: (teamId) => (project.teams.includes(teamId) ? project : null),
    };

    const code = await runSend(['--list'], io, fake(sockets, { projects }));

    expect(code).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\n'
        + '  SEAT    NICKNAME  ROLE         PROJECT  REACH\n'
        + '  lead    -         coordinator  TeamCLI  socket\n'
        + '  helper  -         implementer  TeamCLI  socket\n'
        + '  native  -         reviewer     TeamCLI  typed\n'
        + '3 seats\n',
    );
  });

  test("with no projects source injected, the registry the host's home holds places the team", async () => {
    const { root, sockets } = world();
    const io = owner(root);
    // Written through the registry's own writer, under the home the host carries: the reading that
    // finds it is the one bound to that home, not to wherever the process runs.
    upsertProject(join(base, 'home'), '4f2a1b7c9d0e', { name: 'TeamCLI', entity: 'floor', lead: 'agt_2b9f', teams: [teamIdOf(root)] });

    const code = await runSend(['--list'], io, fake(sockets));

    expect(code).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\n'
        + '  SEAT    NICKNAME  ROLE         PROJECT  REACH\n'
        + '  lead    -         coordinator  TeamCLI  socket\n'
        + '  helper  -         implementer  TeamCLI  socket\n'
        + '  native  -         reviewer     TeamCLI  typed\n'
        + '3 seats\n',
    );
  });

  test('--list marks a stopped seat; --json carries the same roster as a document', async () => {
    const { root, sockets } = world();
    const file = join(root, '.agents', 'team.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('  - role: reviewer', '  - role: reviewer\n    stopped: true'));
    const io = owner(root);

    const code = await runSend(['--list', '--json'], io, fake(sockets));

    expect(code).toBe(0);
    const roster = assertMatchesOutputSchema<Record<string, unknown>>(io.out, SEND_OUTPUT_SCHEMA);
    expect(roster).toEqual({
      schema: { name: 'team.send.list', version: 1 },
      format: 1,
      project: 'acme',
      session: 'acme',
      seats: [
        { name: 'lead', nickname: null, cli: 'claude-code', role: 'coordinator', project: 'acme', reach: 'socket', stopped: false },
        { name: 'helper', nickname: null, cli: 'claude-code', role: 'implementer', project: 'acme', reach: 'socket', stopped: false },
        { name: 'native', nickname: null, cli: 'codex', role: 'reviewer', project: 'acme', reach: 'typed', stopped: true },
      ],
      summary: '3 seats',
    });
    const plain = owner(root);
    expect(await runSend(['--list'], plain, fake(sockets))).toBe(0);
    expect(plain.out).toContain('  native  -         reviewer     acme     stopped');
  });
});

describe('team send: --json documents', () => {
  test('a refused send is a document on stdout; stderr stays empty', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['ghost', 'hello', '--json'], io, fake(sockets));

    expect(code).toBe(1);
    expect(io.err).toBe('');
    const doc = assertJsonErrorShape(io.out, { id: 'send.refused', messageContains: 'ghost: it is not a declared seat', repair: null });
    expect(doc.error.message.startsWith('refused: ')).toBe(true);
  });

  test('a usage error carries no seat and exit 2', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['--json'], io, fake(sockets));

    expect(code).toBe(2);
    expect(io.err).toBe('');
    const doc = assertJsonErrorShape(io.out, { id: 'send.usage', repair: null });
    expect(doc.error.message).toBe('a seat and a message are required');

    // --json read from raw argv: the parser's own error must not lose the structured face.
    for (const [argv, messageContains] of [
      [['--nope', '--json'], 'unknown option --nope'],
      [['--json=1'], 'unknown option --json'],
    ] as const) {
      const badIo = owner(root);
      expect(await runSend([...argv], badIo, fake(sockets))).toBe(2);
      expect(badIo.err).toBe('');
      assertJsonErrorShape(badIo.out, { id: 'send.usage', messageContains, repair: null });
    }
  });

  test('an unreachable seat is a document too', async () => {
    const { root, sockets } = world();
    const io = owner(root);

    const code = await runSend(['lead', 'hello', '--json'], io, fake(sockets, { agents: () => null }));

    expect(code).toBe(1);
    assertJsonErrorShape(io.out, { id: 'send.unreachable', messageContains: 'could not be read' });
  });

  test('a sent send carries the drop file\'s id', async () => {
    const { root, dir, sockets } = world();
    const host = fake(sockets, { native: scripted(['idle', 'working']) });
    const io = owner(root);

    const code = await runSend(['lead', 'hello', '--json'], io, host);

    expect(code).toBe(0);
    expect(host.frames).toEqual([]);
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      format: number;
      dry_run: boolean;
      status: string;
      action_summary: string;
      project: string;
      session: string;
      seat: string;
      channel: string;
      delivery: { leg: string; state: string; reason?: string }[];
      ids: { sent: string; reply: string | null };
    }>(io.out, SEND_OUTPUT_SCHEMA);
    const drops = join(dir, 'send-drops', 'acme', 'lead');
    expect(readdirSync(drops).filter((name) => !name.includes('.'))).toEqual([doc.ids.sent]);
    expect(doc).toEqual({
      schema: { name: 'team.send', version: 1 },
      format: 1,
      dry_run: false,
      status: 'sent (unconfirmed)',
      action_summary: 'lead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)',
      project: 'acme',
      session: 'acme',
      seat: 'lead',
      channel: 'typed',
      delivery: [
        { leg: 'mcp-inbox', state: 'skipped', reason: 'no live inbox listener' },
        { leg: 'typed', state: 'attempted' },
      ],
      ids: { sent: doc.ids.sent, reply: null },
    });
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
    expect(io.out).toBe('team acme, session "acme"\nnative: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
    expect(host.frames).toEqual([]);
    expect(pane.typed.length).toBe(1);
    const trigger = pane.typed[0] as string;
    expect(trigger.includes('\n')).toBe(false);
    expect(trigger.length).toBeLessThanOrEqual(TRIGGER_MAX);
    expect(trigger).not.toContain(body);
    expect(pane.enters).toBe(1);
    const drops = join(dir, 'send-drops', 'acme', 'native');
    const files = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(files.length).toBe(1);
    const path = join(drops, files[0] as string);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dropsRoot).mode & 0o777).toBe(0o700);
    expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
    expect(statSync(drops).mode & 0o777).toBe(0o700);
    expect(recordBody(path)).toBe(`from the owner — admitted by: the owner\n\n${body}`);
    expect(trigger).toBe(readTriggerLine('native', 'acme', { seat: 'owner', team: 'acme', body }) as string);
    const log = readFileSync(join(dir, LOG_FILE), 'utf8');
    expect(log).toContain('herdr status working');
    expect(log).not.toContain(body);
  });

  test('a seat that writes its signed receipt is delivered (read): the receipt ends the window', async () => {
    const { root, dir, sockets } = world();
    const dropDir = join(dir, 'send-drops', 'acme', 'native');
    // In an object, so the closure's write is a property write the compiler does not narrow away.
    const written = { at: null as string | null };
    const pane = scripted(['idle', 'working']);
    const enter = pane.pressEnter;
    // The trigger is the seat's own `team drops --read`, whose first act is the signed receipt:
    // a seat that runs it has read the message before the line even leaves the box. The status
    // never has to move, because the receipt — not the status — is the read.
    pane.pressEnter = () => {
      const id = readdirSync(dropDir).find((entry) => !entry.includes('.'));
      if (id === undefined) throw new Error(`no drop was written in ${dropDir}`);
      const receipt = writeReceipt(dropDir, signReceiptPayload({
        kind: 'receipt',
        status: 'read',
        id,
        to: 'native',
        root,
        session: 'acme',
        at: NOW.toISOString(),
      }, host.home), host.home);
      written.at = receipt.ok ? receipt.path : receipt.reason;
      return enter('acme', 'w9:p1');
    };
    const host = fake(sockets, {
      agents: () => [{ name: 'native', pane: 'w9:p1' }],
      native: pane,
    });
    const io = owner(root);

    const code = await runSend(['native', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    // A read receipt is the one word a typed line earns: never merely `delivered`, and never
    // `sent` — the receipt is a signed proof, not the line having left the box.
    expect(io.out).toBe('team acme, session "acme"\nnative: delivered (read)\n');
    expect(pane.typed).toEqual([readTriggerLine('native', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string]);
    expect(pane.enters).toBe(1);
    const name = readdirSync(dropDir).find((entry) => !entry.includes('.')) as string;
    expect(written.at).toBe(receiptPath(dropDir, name));
    const log = readFileSync(join(dir, LOG_FILE), 'utf8');
    expect(log).toContain('native: delivered (read)');
    const history = readHistory('acme', root, host.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toMatchObject([
      { from: 'owner', to: 'native', id: name, outcome: 'delivered (read)', via: 'typed' },
    ]);
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
    const names = readdirSync(drops);
    const name = names.filter((entry) => !entry.includes('.'))[0] as string;
    expect(io.err).toContain(join(drops, name));
    expect(recordBody(join(drops, name))).toBe('from the owner — admitted by: the owner\n\nhello');
    // A not-submitted drop is marked pending so a running watch retries it.
    expect(names.filter((entry) => entry.endsWith('.pending'))).toHaveLength(1);
  });

  test('a codex seat already at done is not delivered until the status changes', async () => {
    const { root, sockets } = world();
    const stayed = nativeHost(sockets, ['done']);
    const io = owner(root);
    expect(await runSend(['native', 'hello'], io, stayed.host)).toBe(1);

    const moved = nativeHost(sockets, ['done', 'working']);
    const again = owner(root);
    expect(await runSend(['native', 'hello'], again, moved.host)).toBe(0);
    expect(again.out).toBe('team acme, session "acme"\nnative: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
  });

  test('two sends to one seat do not interleave triggers: the second is queued, not typed', async () => {
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
    const secondIo = owner(root);
    const second = await runSend(['native', 'two'], secondIo, host);
    // The first send owns the seat's lock, so the second types nothing: it stores its record and
    // marker for the watch and answers with its own id.
    expect(second).toBe(0);
    expect(secondIo.out).toMatch(/native: queued \(receiver busy\) \(typed, \d+ ms; id [0-9a-f-]+\)\n$/);
    release();
    expect(await first).toBe(0);
    expect(typed.length).toBe(1);
    expect(typed[0]).toContain('one');
    expect(typed[0]).not.toContain('two');
  });

  test('--dry-run names the channel and writes nothing', async () => {
    const { root, dir, sockets } = world();
    const { host, pane } = nativeHost(sockets, ['working']);
    const io = owner(root);

    const code = await runSend(['native', 'hello', '--dry-run'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nnative: dry-run: codex via the seat\'s own MCP inbox, falling back to a 0600 drop file and one trigger line; nothing was written\n');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(existsSync(join(dir, 'send-drops'))).toBe(false);
    const json = owner(root);
    expect(await runSend(['lead', 'hello', '--dry-run', '--json'], json, fake(sockets))).toBe(0);
    const dry = assertMatchesOutputSchema<Record<string, unknown>>(json.out, SEND_OUTPUT_SCHEMA);
    expect(dry).toEqual({
      schema: { name: 'team.send', version: 1 },
      format: 1,
      dry_run: true,
      status: 'dry-run',
      action_summary: 'lead: dry-run: claude-code via the seat\'s own MCP inbox, falling back to a 0600 drop file and one trigger line; nothing was written',
      project: 'acme',
      session: 'acme',
      seat: 'lead',
      channel: null,
      delivery: [
        { leg: 'mcp-inbox', state: 'candidate', eligible: true },
        { leg: 'typed', state: 'candidate', eligible: true },
      ],
      ids: { sent: null, reply: null },
      plan: [{ step: 'send', seat: 'lead', detail: 'claude-code via the seat\'s own MCP inbox, falling back to a 0600 drop file and one trigger line; nothing was written', prefix: '+' }],
    });
    const claude = owner(root);
    expect(await runSend(['lead', 'hello', '--dry-run'], claude, fake(sockets))).toBe(0);
    expect(claude.out).toBe('team acme, session "acme"\nlead: dry-run: claude-code via the seat\'s own MCP inbox, falling back to a 0600 drop file and one trigger line; nothing was written\n');
    const waited = owner(root);
    expect(await runSend(['lead', 'hello', '--wait', '--dry-run'], waited, fake(sockets))).toBe(0);
    expect(waited.out).toBe('team acme, session "acme"\nlead: dry-run: claude-code via the seat\'s own MCP inbox, falling back to a 0600 drop file and one trigger line; nothing was written\n');
    // No dry run above wrote a line: the log records writes, and a dry run writes nothing.
    expect(existsSync(join(dir, LOG_FILE))).toBe(false);
  });

  test('a seat the file marks stopped is refused before anything is written, and plans once un-stopped', async () => {
    const { root, dir, sockets } = world();
    const file = join(root, '.agents', 'team.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('  - role: reviewer', '  - role: reviewer\n    stopped: true'));
    const { host, pane } = nativeHost(sockets, ['idle', 'working']);

    for (const argv of [['native', 'hello', '--dry-run'], ['native', 'hello']]) {
      const io = owner(root);
      expect(await runSend(argv, io, host)).toBe(1);
      expect(io.err).toBe('team send: native: unreachable: native is stopped\n');
      expect(io.out).toBe('');
    }
    const json = owner(root);
    expect(await runSend(['native', 'hello', '--json'], json, host)).toBe(1);
    const doc = assertJsonErrorShape(json.out, { id: 'send.stopped', messageContains: 'native is stopped', repair: null });
    expect(doc.error.message).toBe('native: unreachable: native is stopped');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(existsSync(join(dir, 'send-drops'))).toBe(false);
    expect(existsSync(historyPath('acme', root, host.home))).toBe(false);

    // The same seat, not stopped: the dry run plans, and the real send writes its drop file.
    writeFileSync(file, teamFile(root, lobbyDir(host.home)));
    const plans = owner(root);
    expect(await runSend(['native', 'hello', '--dry-run'], plans, fake(sockets))).toBe(0);
    expect(plans.out).toBe('team acme, session "acme"\nnative: dry-run: codex via the seat\'s own MCP inbox, falling back to a 0600 drop file and one trigger line; nothing was written\n');
    const sent = owner(root);
    expect(await runSend(['native', 'hello'], sent, host)).toBe(0);
    expect(sent.out).toBe('team acme, session "acme"\nnative: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
    expect(existsSync(join(dir, 'send-drops'))).toBe(true);
  });

  test('a --record to a stopped seat is refused, and nothing is recorded', async () => {
    const { root, dir, sockets } = world();
    const file = join(root, '.agents', 'team.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('  - role: reviewer', '  - role: reviewer\n    stopped: true'));
    const host = fake(sockets);

    for (const argv of [
      ['--record', 'native', '--channel', 'native', '--ms', '812'],
      ['--record', 'native', '--channel', 'native', '--ms', '812', '--dry-run'],
    ]) {
      const io = owner(root);
      expect(await runSend(argv, io, host)).toBe(1);
      expect(io.err).toBe('team send: native: unreachable: native is stopped\n');
      expect(io.out).toBe('');
    }
    const json = owner(root);
    expect(await runSend(['--record', 'native', '--channel', 'native', '--ms', '812', '--json'], json, host)).toBe(1);
    const doc = assertJsonErrorShape(json.out, { id: 'send.stopped', messageContains: 'native is stopped', repair: null });
    expect(doc.error.message).toBe('native: unreachable: native is stopped');
    expect(existsSync(join(dir, 'send-drops'))).toBe(false);
    expect(existsSync(historyPath('acme', root, host.home))).toBe(false);
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
    expect(recordBody(join(drops, readdirSync(drops).find((name) => !name.includes('.')) as string))).toBe('from the owner — admitted by: the owner\n\nhello');
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
    expect(io.err).toContain('unreachable now (the screen reads question); a running watch retries it when the seat is idle');
    const leadDrops = join(dir, 'send-drops', 'acme', 'lead');
    const leadFiles = readdirSync(leadDrops);
    // The drop and the record beside it: the watch reads the record, the seat reads the drop.
    expect(leadFiles.filter((name) => name.endsWith('.pending'))).toHaveLength(1);
    expect(io.err).toContain(join(leadDrops, leadFiles.filter((name) => !name.includes('.'))[0] as string));
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
    expect(again.err).toContain('unreachable now (the screen reads permission); a running watch retries it when the seat is idle');
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
    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
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
