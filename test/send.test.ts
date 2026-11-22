import { NO_EVENT_ADAPTER_TOOK_IT, NO_PANE_MESSAGING, queuedLine } from '../src/send/no-pane-messaging.ts';
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
import { readPending } from '../src/send/pending.ts';
import { signedRecordOf } from '../src/send/record.ts';
import { dropMessage, readTriggerLine, sawSubmission, triggerLine, TRIGGER_MAX, type NativePane } from '../src/send/native.ts';
import { FRAME_LIMIT, sendFrame, type SendOutcome } from '../src/send/uds.ts';
import { readReply } from '../src/send/reply.ts';
import { SEND_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { LOG_FILE, updateState } from '../src/state.ts';
import { recordBody, testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema, withoutSendId } from './helpers/output.ts';

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
# The scenes below exercise the typed leg: the file declares no wake for this seat, so the typed
# leg is set aside with its reason, and the mailbox closes the walk. The mcp-inbox word stays in
# the order as a retired name this build only reads: it is dropped before the walk, the report
# carries nothing for it, and the drop file takes the send.
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
});

describe('team send: unreachable', () => {

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
    // Written through the registry's own writers, under the home the host carries: the reading that
    // finds it is the one bound to that home, not to wherever the process runs. Membership is the
    // team record's own, so the join is written there; the project side keeps no team list.
    const home = join(base, 'home');
    upsertProject(home, '4f2a1b7c9d0e', { name: 'TeamCLI', entity: 'floor', lead: 'agt_2b9f' });
    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      session: 'acme',
      root,
      projectId: '4f2a1b7c9d0e',
      projects: ['4f2a1b7c9d0e'],
    });

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
