// `team mcp serve`: the seat's inbox as a stdio MCP server, driven over its own streams and
// synthetic folders. No herdr, no live team: a temporary folder holds a team file and the drop
// tree the server reads. Every message id here is a literal UUID; the bodies are invented.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../src/bus/log.ts';
import { runMcp } from '../src/commands/mcp.ts';
import { listenerPath, receiptPath } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord, verifyReceipt, type SignedReceipt } from '../src/send/record.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { recordBody, testIo } from './helpers.ts';

const SESSION = 'acme';
const LEAD_ID = '0b7c4f4e-3c4a-4f6e-9a2b-5d1c7e8f9a01';
const WORKER_ID = '1c8d5a5f-4d5b-4a7f-8b3c-6e2d8f9a0b12';
const TAMPERED_ID = '2d9e6b60-5e6c-4b80-9c4d-7f3e9a0b1c23';
const UNSIGNED_ID = '3eaf7c71-6f7d-4c91-8d5e-8a4fab1c2d34';
const LEGACY_ID = '4fb08d82-708e-4da2-9e6f-9b5ca01d3e45';

function teamText(seats: readonly string[], session = SESSION): string {
  const rows = seats.map((name, at) => `  - role: ${at === 0 ? 'coordinator' : 'worker'}
    name: ${name}
    cli: ${at === 0 ? 'claude-code' : 'codex'}
    vendor: test
    model: Grok
    version: "4.7"
    launch: ${at === 0 ? 'claude' : 'codex'}`).join('\n');
  return `format: 1
project: acme
coordinator: ${seats[0] ?? 'lead'}
operator: ${seats[0] ?? 'lead'}
session: ${session}
workspace:
  mode: shared
seats:
${rows}
`;
}

type Place = { root: string; home: string; dropDir(name: string): string; cleanup(): void };

/** The pane the fixture's state records for a seat: an invented id, compared and never resolved. */
function paneOf(seat: string): string {
  return `pane-${seat}`;
}

/** The caller a seat's own launch line places: the seat, on its recorded pane, in the session. */
function seatCaller(seat: string, session: string = SESSION): { kind: 'seat'; name: string; pane: string; session: string } {
  return { kind: 'seat', name: seat, pane: paneOf(seat), session };
}

/** The state `team up` leaves: every seat ready on the pane it was launched on. A server proves
 *  its caller against this record before it opens an inbox. */
function writeState(root: string, session: string, seats: readonly string[]): void {
  const rows = Object.fromEntries(seats.map((name) => [name, { stage: 'ready', pane: paneOf(name) }]));
  writeFileSync(join(root, '.agents', 'team.state.json'), `${JSON.stringify({ format: 1, sessions: { [session]: { seats: rows, worktrees: {} } } })}\n`);
}

const BRIEF_ID = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const INCARNATION = 'inc_0123456789ab';
const EPOCH_ONE = 'run_0123456789ab';
const EPOCH_TWO = 'run_ba9876543210';

/** Rewrites the state's claim for a seat: a valid claim at `epoch`, or none when null. A server
 *  proves its launch against this record at every use, so a scene moves it under a running one. */
function setClaim(root: string, session: string, seat: string, epoch: string | null): void {
  const path = join(root, '.agents', 'team.state.json');
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    format: number;
    sessions: Record<string, { seats: Record<string, unknown>; worktrees: Record<string, unknown>; briefs?: Record<string, unknown> }>;
  };
  const one = state.sessions[session]!;
  if (epoch === null) {
    if (one.briefs !== undefined) delete one.briefs[seat];
  } else {
    one.briefs = {
      ...(one.briefs ?? {}),
      [seat]: { id: BRIEF_ID, at: '2026-10-17T12:00:00.000Z', incarnation: INCARNATION, epoch, sha256: 'a'.repeat(64), stage: 'claimed' },
    };
  }
  writeFileSync(path, `${JSON.stringify(state)}\n`);
}

function place(seats: readonly string[] = ['lead', 'worker']): Place {
  // The refusal event names the record's real path, and a temporary directory is a symlink
  // under /var on macOS: the fixture's root is resolved once, so both sides name the same file.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-')));
  mkdirSync(join(root, '.agents'));
  // The message key lives under this home, never the one of the machine running the suite.
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(seats));
  writeState(root, SESSION, seats);
  // A server started with no --file resolves its team from the registry record that holds the
  // seat, so the fixture registers it the way the team's own registration does.
  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    session: SESSION,
    root,
    roster: seats.map((name, at) => ({ agent: `agt_${String(at + 1).padStart(12, '0')}`, seat: name, role: at === 0 ? 'coordinator' : 'worker' })),
  });
  return {
    root,
    home,
    dropDir: (name) => join(root, '.agents', 'send-drops', SESSION, name),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function drop(at: string, id: string, body: string): string {
  mkdirSync(at, { recursive: true, mode: 0o700 });
  const path = join(at, id);
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

/** The record a send writes: one signed envelope under the id's own name, in `to`'s folder. */
function signed(at: Place, to: string, id: string, body: string): string {
  const record = signRecord({
    kind: 'message',
    id,
    to,
    to_id: null,
    root: realpathSync(at.root),
    session: SESSION,
    at: '2026-10-17T12:00:00.000Z',
    body,
    from: 'worker',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, at.home);
  return drop(at.dropDir(to), id, `${JSON.stringify(record, null, 2)}\n`);
}

/** The signed read receipt a read wrote, checked with the checkout's own message key: the one
 *  file shape every reader of a status agrees on. */
function readReceipt(at: Place, seat: string, id: string): SignedReceipt {
  const receipt = JSON.parse(readFileSync(receiptPath(at.dropDir(seat), id), 'utf8')) as SignedReceipt;
  const key = messageKeyState(at.home);
  expect(key.kind).toBe('key');
  if (key.kind !== 'key') throw new Error('the fixture home holds no message key');
  expect(verifyReceipt(receipt, key.key)).toBe(true);
  return receipt;
}

/** A stream the test feeds: `push` one line, `end` closes it, `replies` collects what was written. */
function queue(): {
  lines: AsyncIterable<string>;
  write(line: string): void;
  push(line: string): void;
  end(): void;
  replies: string[];
} {
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const replies: string[] = [];
  const lines = (async function* () {
    for (;;) {
      if (pending.length > 0) {
        yield pending.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  const bump = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    lines,
    write: (line) => replies.push(line),
    push: (line) => {
      pending.push(line);
      bump();
    },
    end: () => {
      ended = true;
      bump();
    },
    replies,
  };
}

async function preloaded(root: string, home: string, lines: readonly string[], seat = 'lead', session: string | undefined = SESSION) {
  const io = testIo(root, seatCaller(seat, session ?? SESSION));
  const replies: string[] = [];
  const code = await runMcpServe({ seat, session }, io, {
    lines: (async function* () {
      for (const line of lines) yield line;
    })(),
    write: (line) => replies.push(line),
  }, { home });
  return { code, io, replies: replies.map((line) => JSON.parse(line) as Record<string, any>) };
}

function call(id: string, name: string, args?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...(args ? { arguments: args } : {}) } });
}

describe('team mcp serve', () => {
  test('the handshake names the tools, and stdin closing removes the marker', async () => {
    const at = place();
    try {
      const { code, io, replies } = await preloaded(at.root, at.home, [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      ]);
      expect(code).toBe(0);
      expect(io.out).toBe('');
      expect(io.err).toBe('');
      expect(replies).toHaveLength(2);
      expect(replies[0]).toMatchObject({
        id: 1,
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'team-inbox' } },
      });
      expect(replies[1]!.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['inbox_check', 'inbox_read']);
      expect(existsSync(listenerPath(at.dropDir('lead')))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('the listener names the seat, session, root and pid while the server runs', async () => {
    const at = place();
    try {
      const io = testIo(at.root, seatCaller('lead'));
      const feed = queue();
      const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed, { home: at.home });
      for (let wait = 0; wait < 200 && !existsSync(listenerPath(at.dropDir('lead'))); wait++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const listener = JSON.parse(readFileSync(listenerPath(at.dropDir('lead')), 'utf8')) as Record<string, unknown>;
      expect(listener).toMatchObject({ v: 1, seat: 'lead', session: SESSION, root: realpathSync(at.root), cli: 'claude-code', pid: process.pid });
      expect((listener.ts as string).length).toBeGreaterThan(10);
      feed.end();
      expect(await running).toBe(0);
      expect(existsSync(listenerPath(at.dropDir('lead')))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('a link anywhere in the folder path refuses to start', async () => {
    const at = place();
    try {
      const elsewhere = join(at.root, 'elsewhere');
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(at.root, '.agents', 'send-drops'));
      const { code, io } = await preloaded(at.root, at.home, []);
      expect(code).toBe(2);
      expect(io.err).toContain('not a real folder');
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      at.cleanup();
    }
  });

  test('a lobby folder with the launch file serves that team, whatever folder it starts in', async () => {
    const at = place();
    const lobby = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-lobby-')));
    try {
      signed(at, 'lead', LEAD_ID, 'for lead');
      const io = testIo(lobby, seatCaller('lead'));
      const replies: string[] = [];
      const code = await runMcpServe({ seat: 'lead', session: SESSION, file: join(at.root, '.agents', 'team.yaml') }, io, {
        lines: (async function* () {
          yield call('1', 'inbox_check');
        })(),
        write: (line) => replies.push(line),
      }, { home: at.home });
      expect(code).toBe(0);
      expect(io.err).toBe('');
      const reply = JSON.parse(replies[0]!) as Record<string, any>;
      const listed = JSON.parse(reply.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
    } finally {
      at.cleanup();
      rmSync(lobby, { recursive: true, force: true });
    }
  });

  test('a lobby folder with no team file and no launch file serves the registered team', async () => {
    const at = place();
    const lobby = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-lobby-')));
    try {
      signed(at, 'lead', LEAD_ID, 'for lead');
      const io = testIo(lobby, seatCaller('lead'));
      const replies: string[] = [];
      const code = await runMcpServe({ seat: 'lead', session: SESSION }, io, {
        lines: (async function* () {
          yield call('1', 'inbox_check');
        })(),
        write: (line) => replies.push(line),
      }, { home: at.home });
      expect(code).toBe(0);
      expect(io.err).toBe('');
      const reply = JSON.parse(replies[0]!) as Record<string, any>;
      const listed = JSON.parse(reply.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
    } finally {
      at.cleanup();
      rmSync(lobby, { recursive: true, force: true });
    }
  });

  test('a lobby folder with no team file and no registered team refuses, naming --file', async () => {
    const lobby = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-lobby-')));
    try {
      const io = testIo(lobby);
      const code = await runMcpServe({ seat: 'lead', session: SESSION }, io, {
        lines: (async function* () {
          // no lines
        })(),
        write: () => {},
      }, { home: join(lobby, 'home') });
      expect(code).toBe(2);
      expect(io.err).toBe('team mcp serve: no registered team holds seat "lead"; pass --file\n');
    } finally {
      rmSync(lobby, { recursive: true, force: true });
    }
  });

  test('a team file in the folder is not read: the registry record holding the seat is the team', async () => {
    const at = place();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-folder-')));
    try {
      mkdirSync(join(elsewhere, '.agents'));
      // The folder's own team declares no lead, so reading it would refuse this seat.
      writeFileSync(join(elsewhere, '.agents', 'team.yaml'), teamText(['worker']));
      signed(at, 'lead', LEAD_ID, 'for lead');
      const io = testIo(elsewhere, seatCaller('lead'));
      const replies: string[] = [];
      const code = await runMcpServe({ seat: 'lead', session: SESSION }, io, {
        lines: (async function* () {
          yield call('1', 'inbox_check');
        })(),
        write: (line) => replies.push(line),
      }, { home: at.home });
      expect(code).toBe(0);
      expect(io.err).toBe('');
      const reply = JSON.parse(replies[0]!) as Record<string, any>;
      const listed = JSON.parse(reply.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
    } finally {
      at.cleanup();
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('a seat on two registered teams refuses, and --session names one', async () => {
    const at = place();
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-other-')));
    const lobby = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-lobby-')));
    try {
      mkdirSync(join(other, '.agents'));
      writeFileSync(join(other, '.agents', 'team.yaml'), teamText(['lead', 'worker'], 'other'));
      const otherId = teamIdOf(other);
      upsertTeam(at.home, otherId, {
        project: 'beta',
        session: 'other',
        root: other,
        roster: [{ agent: 'agt_0000000000a1', seat: 'lead', role: 'coordinator' }],
      });
      const ambiguous = testIo(lobby);
      const refused = await runMcpServe({ seat: 'lead', session: undefined }, ambiguous, {
        lines: (async function* () {
          // no lines
        })(),
        write: () => {},
      }, { home: at.home });
      expect(refused).toBe(2);
      expect(ambiguous.err).toContain('seat "lead" is on 2 registered teams');
      expect(ambiguous.err).toContain(teamIdOf(at.root));
      expect(ambiguous.err).toContain(otherId);
      expect(ambiguous.err).toContain('pass --file to say which');

      // --session narrows the two holders to the one that serves this session.
      signed(at, 'lead', LEAD_ID, 'for lead');
      const narrowed = testIo(lobby, seatCaller('lead'));
      const replies: string[] = [];
      const served = await runMcpServe({ seat: 'lead', session: SESSION }, narrowed, {
        lines: (async function* () {
          yield call('1', 'inbox_check');
        })(),
        write: (line) => replies.push(line),
      }, { home: at.home });
      expect(served).toBe(0);
      expect(narrowed.err).toBe('');
      const reply = JSON.parse(replies[0]!) as Record<string, any>;
      const listed = JSON.parse(reply.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
    } finally {
      at.cleanup();
      rmSync(other, { recursive: true, force: true });
      rmSync(lobby, { recursive: true, force: true });
    }
  });

  test('an explicit team file that cannot be read refuses, even where the folder has one', async () => {
    const at = place();
    try {
      const io = testIo(at.root);
      const code = await runMcpServe({ seat: 'lead', session: SESSION, file: join(at.root, 'missing.yaml') }, io, {
        lines: (async function* () {
          // no lines
        })(),
        write: () => {},
      }, { home: at.home });
      expect(code).toBe(2);
      expect(io.err).toContain('missing.yaml');
    } finally {
      at.cleanup();
    }
  });

  test('an explicit launch file wins over a different team file in the folder', async () => {
    const at = place();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-other-')));
    try {
      mkdirSync(join(elsewhere, '.agents'));
      writeFileSync(join(elsewhere, '.agents', 'team.yaml'), teamText(['lead', 'worker'], 'other'));
      signed(at, 'lead', LEAD_ID, 'for lead');
      const io = testIo(elsewhere, seatCaller('lead'));
      const replies: string[] = [];
      const code = await runMcpServe({ seat: 'lead', session: SESSION, file: join(at.root, '.agents', 'team.yaml') }, io, {
        lines: (async function* () {
          yield call('1', 'inbox_check');
        })(),
        write: (line) => replies.push(line),
      }, { home: at.home });
      expect(code).toBe(0);
      const reply = JSON.parse(replies[0]!) as Record<string, any>;
      const listed = JSON.parse(reply.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
    } finally {
      at.cleanup();
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('an empty or directory explicit file refuses even where the folder has a team file', async () => {
    const at = place();
    try {
      for (const file of ['', at.root]) {
        const io = testIo(at.root);
        const code = await runMcpServe({ seat: 'lead', session: SESSION, file }, io, {
          lines: (async function* () {
            // no lines
          })(),
          write: () => {},
        }, { home: at.home });
        expect(code).toBe(2);
        expect(io.err).toContain('could not be read');
      }
    } finally {
      at.cleanup();
    }
  });

  test('an undeclared seat, a wrong session, or no seat at all refuses to start', async () => {
    const at = place();
    try {
      for (const [seat, session, needle] of [
        ['ghost', SESSION, 'declares no seat'],
        ['lead', 'other', "session is"],
        [undefined, SESSION, '--seat <seat> is required'],
      ] as const) {
        const io = testIo(at.root);
        // The launch's own file: an undeclared seat and a wrong session are the file's refusals.
        const file = join(at.root, '.agents', 'team.yaml');
        const code = await runMcpServe({ seat, session, file }, io, {
          lines: (async function* () {
            // no lines
          })(),
          write: () => {},
        }, { home: at.home });
        expect(code).toBe(2);
        expect(io.err).toContain(needle);
      }
    } finally {
      at.cleanup();
    }
  });

  test('a seat sees its own inbox and never another seat’s', async () => {
    const at = place();
    try {
      const leadPath = signed(at, 'lead', LEAD_ID, 'for lead');
      signed(at, 'worker', WORKER_ID, 'for worker');
      const { replies } = await preloaded(at.root, at.home, [call('1', 'inbox_check'), call('2', 'inbox_read', { id: WORKER_ID })]);
      expect(replies).toHaveLength(2);
      const listed = JSON.parse(replies[0]!.result.content[0].text) as { unread: { id: string; bytes: number }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
      expect(listed.unread[0]!.bytes).toBe(Buffer.byteLength(readFileSync(leadPath, 'utf8')));
      expect(replies[1]!.result.isError).toBe(true);
      expect(replies[1]!.result.content[0].text).toContain('no message');
      expect(existsSync(receiptPath(at.dropDir('worker'), WORKER_ID))).toBe(false);
      expect(existsSync(receiptPath(at.dropDir('lead'), WORKER_ID))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('a read writes its receipt before the body leaves, and the message then leaves the list', async () => {
    const at = place();
    try {
      signed(at, 'lead', LEAD_ID, 'the body');
      const { replies } = await preloaded(at.root, at.home, [call('1', 'inbox_read', { id: LEAD_ID }), call('2', 'inbox_check')]);
      expect(replies[0]!.result).toEqual({ content: [{ type: 'text', text: '[attributed sender: worker]\n\nthe body' }] });
      const receipt = readReceipt(at, 'lead', LEAD_ID);
      expect(receipt.payload).toMatchObject({
        kind: 'receipt',
        status: 'read',
        id: LEAD_ID,
        to: 'lead',
        root: realpathSync(at.root),
        session: SESSION,
      });
      const listed = JSON.parse(replies[1]!.result.content[0].text) as { unread: unknown[] };
      expect(listed.unread).toEqual([]);
      // The record itself is untouched: the inbox marks, it never moves or rewrites the file.
      expect(recordBody(join(at.dropDir('lead'), LEAD_ID))).toBe('the body');
    } finally {
      at.cleanup();
    }
  });

  test('an id is a UUID and never a path, and a symlinked drop is not served', async () => {
    const at = place();
    try {
      signed(at, 'lead', LEAD_ID, 'real');
      const outside = join(at.root, 'outside');
      writeFileSync(outside, 'target', { mode: 0o600 });
      symlinkSync(outside, join(at.dropDir('lead'), WORKER_ID));
      const outsideReceipt = join(at.root, 'outside.read');
      symlinkSync(outsideReceipt, receiptPath(at.dropDir('lead'), LEAD_ID + ''));
      const { replies } = await preloaded(at.root, at.home, [
        call('1', 'inbox_read', { id: `../../worker/${WORKER_ID}` }),
        call('2', 'inbox_read', { id: LEAD_ID }),
        call('3', 'inbox_check'),
      ]);
      expect(replies[0]!.result.isError).toBe(true);
      expect(replies[1]!.result.isError).toBe(true);
      expect(replies[1]!.result.content[0].text).toContain('not a file');
      const listed = JSON.parse(replies[2]!.result.content[0].text) as { unread: { id: string }[] };
      // The link at the receipt's name was never signed by the message key, so it proves nothing:
      // the message is still waiting, and nothing was written through the link.
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
      expect(existsSync(outsideReceipt)).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('tool faults are results, parse errors and unknown methods are protocol errors', async () => {
    const at = place();
    try {
      const { replies } = await preloaded(at.root, at.home, [
        'not json',
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'nope' }),
        call('3', 'frobnicate'),
        call('4', 'inbox_read'),
      ]);
      expect(replies[0]).toMatchObject({ id: null, error: { code: -32700 } });
      expect(replies[1]).toMatchObject({ id: 2, error: { code: -32601 } });
      expect(replies[2]!.result.isError).toBe(true);
      expect(replies[3]!.result.isError).toBe(true);
    } finally {
      at.cleanup();
    }
  });

  test('a process the state cannot place as the served seat is refused, before it serves a line', async () => {
    const at = place();
    try {
      const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
      // The launch's own registration names the file; the child inherits the machine's home, so
      // only that file can place it without reading a real registry. Its parents are the test
      // runner's: whatever that walk places, it is not a seat on this fixture's recorded pane,
      // so the server refuses before it reads a line and without opening the inbox.
      const proc = Bun.spawn([process.execPath, cliEntry, 'mcp', 'serve', '--seat', 'lead', '--file', join(at.root, '.agents', 'team.yaml')], {
        cwd: at.root,
        // The child does not see the suite preload's setting unless it is passed on.
        env: { ...process.env, TEAM_CONFIG_SOURCE: 'file' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      await proc.stdin.end();
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(2);
      expect(stdout).toBe('');
      // Which reading the walk gets depends on the machine the suite runs on; every one of them
      // is a refusal that names the served seat, and none of them serves a line.
      expect(stderr.startsWith('team mcp serve: ')).toBe(true);
      expect(stderr).toContain('"lead"');
      expect(stderr).not.toContain('jsonrpc');
      expect(existsSync(listenerPath(at.dropDir('lead')))).toBe(false);
      expect(existsSync(join(at.root, '.agents', 'send-drops', SESSION, 'lead'))).toBe(false);
    } finally {
      at.cleanup();
    }
  }, 20_000);
});

describe('an inbox read serves only a record it verified', () => {
  test('a signed record returns its body, and the receipt is written', async () => {
    const at = place();
    try {
      signed(at, 'lead', LEAD_ID, 'the draft is ready');
      const { replies } = await preloaded(at.root, at.home, [call('1', 'inbox_read', { id: LEAD_ID })]);
      expect(replies[0]!.result.isError).toBeUndefined();
      expect(replies[0]!.result.content[0].text).toBe('[attributed sender: worker]\n\nthe draft is ready');
      const receipt = readReceipt(at, 'lead', LEAD_ID);
      expect(receipt.payload).toMatchObject({ kind: 'receipt', status: 'read', id: LEAD_ID, to: 'lead' });
    } finally {
      at.cleanup();
    }
  });

  test('a tampered record is refused with the reason, and no receipt is written', async () => {
    const at = place();
    try {
      const path = signed(at, 'lead', LEAD_ID, 'the body the sender wrote');
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { payload: { body: string }; signature: string };
      parsed.payload.body = 'the body a tamperer wants';
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
      const { replies } = await preloaded(at.root, at.home, [call('1', 'inbox_read', { id: LEAD_ID }), call('2', 'inbox_check')]);
      expect(replies[0]!.result.isError).toBe(true);
      expect(replies[0]!.result.content[0].text).toContain('does not verify');
      expect(replies[0]!.result.content[0].text).not.toContain('the body a tamperer wants');
      expect(existsSync(receiptPath(at.dropDir('lead'), LEAD_ID))).toBe(false);
      // Nothing was shown, so the message is still unread and the check still names it.
      const listed = JSON.parse(replies[1]!.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);

      // The owner hears the refusal as its rule and object — the id, the seat and the path —
      // and never either body: neither the sender's nor the tamperer's.
      const events = readEvents('acme', at.root, at.home);
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      const refused = events.events.filter((event) => event.payload.kind === 'record.invalid');
      expect(refused).toHaveLength(1);
      expect(refused[0]!.payload).toMatchObject({
        session: SESSION,
        rule: 'signature',
        seat: 'lead',
        subject: LEAD_ID,
        reason: join(at.dropDir('lead'), LEAD_ID),
      });
      const shown = JSON.stringify(refused[0]!.payload);
      expect(shown).not.toContain('the body the sender wrote');
      expect(shown).not.toContain('the body a tamperer wants');
    } finally {
      at.cleanup();
    }
  });

  test('an unsigned record is refused with the reason, and no receipt is written', async () => {
    const at = place();
    try {
      const path = signed(at, 'lead', UNSIGNED_ID, 'the body nobody signed');
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { payload: unknown; signature?: string };
      delete parsed.signature;
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
      const { replies } = await preloaded(at.root, at.home, [call('1', 'inbox_read', { id: UNSIGNED_ID }), call('2', 'inbox_check')]);
      expect(replies[0]!.result.isError).toBe(true);
      expect(replies[0]!.result.content[0].text).toContain('not a signed record');
      expect(replies[0]!.result.content[0].text).not.toContain('the body nobody signed');
      expect(existsSync(receiptPath(at.dropDir('lead'), UNSIGNED_ID))).toBe(false);
      const listed = JSON.parse(replies[1]!.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([UNSIGNED_ID]);

      // A file that is not a signed record is a shape refusal, and its body stays out.
      const events = readEvents('acme', at.root, at.home);
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      const refused = events.events.filter((event) => event.payload.kind === 'record.invalid');
      expect(refused).toHaveLength(1);
      expect(refused[0]!.payload).toMatchObject({
        session: SESSION,
        rule: 'shape',
        seat: 'lead',
        subject: UNSIGNED_ID,
        reason: join(at.dropDir('lead'), UNSIGNED_ID),
      });
      expect(JSON.stringify(refused[0]!.payload)).not.toContain('the body nobody signed');
    } finally {
      at.cleanup();
    }
  });

  test('a plain-text drop an earlier build wrote is not listed, served or raised', async () => {
    const at = place();
    try {
      // A signed record beside it proves the check still lists real mail; the old drop is the
      // plain text an earlier build wrote, under a name this build's sends would use.
      signed(at, 'lead', LEAD_ID, 'for lead');
      const legacyBody = 'from harness (harness@acme) — old mail, not a record\n';
      const path = drop(at.dropDir('lead'), LEGACY_ID, legacyBody);
      const { replies } = await preloaded(at.root, at.home, [
        call('1', 'inbox_check'),
        call('2', 'inbox_read', { id: LEGACY_ID }),
      ]);
      // The check omits it: listing it every turn would only invite a refused read.
      const listed = JSON.parse(replies[0]!.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
      // A read of it still answers the tool error, and leaves no receipt and no body.
      expect(replies[1]!.result.isError).toBe(true);
      expect(replies[1]!.result.content[0].text).toContain('is not a signed record');
      expect(replies[1]!.result.content[0].text).not.toContain('old mail');
      expect(existsSync(receiptPath(at.dropDir('lead'), LEGACY_ID))).toBe(false);
      // The file is left exactly where it is, byte for byte.
      expect(readFileSync(path, 'utf8')).toBe(legacyBody);
      // The owner hears no refusal: this is not a record anything could have admitted.
      const events = readEvents('acme', at.root, at.home);
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      expect(events.events.filter((event) => event.payload.kind === 'record.invalid')).toHaveLength(0);
    } finally {
      at.cleanup();
    }
  });

  test('a signed record broken into invalid JSON keeps its refusal and its owner event', async () => {
    const at = place();
    try {
      // A truncated record is not plain text an earlier build wrote: it starts as the record's
      // JSON object, so it keeps the strict shape refusal and the event that follows.
      const path = signed(at, 'lead', LEAD_ID, 'the body that was signed');
      writeFileSync(path, readFileSync(path, 'utf8').slice(0, 10), { mode: 0o600 });
      const { replies } = await preloaded(at.root, at.home, [
        call('1', 'inbox_check'),
        call('2', 'inbox_read', { id: LEAD_ID }),
      ]);
      const listed = JSON.parse(replies[0]!.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
      expect(replies[1]!.result.isError).toBe(true);
      expect(replies[1]!.result.content[0].text).toContain('is not a signed record');
      expect(existsSync(receiptPath(at.dropDir('lead'), LEAD_ID))).toBe(false);
      const events = readEvents('acme', at.root, at.home);
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      const refused = events.events.filter((event) => event.payload.kind === 'record.invalid');
      expect(refused).toHaveLength(1);
      expect(refused[0]!.payload).toMatchObject({
        session: SESSION,
        rule: 'shape',
        seat: 'lead',
        subject: LEAD_ID,
        reason: join(at.dropDir('lead'), LEAD_ID),
      });
    } finally {
      at.cleanup();
    }
  });
});

describe('team mcp invocation around serve', () => {
  test('serve needs --seat, takes no --json, and the two reports take no seat options', async () => {
    const at = place();
    try {
      const cases: [string[], string][] = [
        [['serve'], '--seat <seat> is required'],
        [['serve', '--seat', 'lead', '--json'], 'unknown option --json'],
        [['serve', '--seat', 'lead', 'extra'], 'unexpected "extra"'],
        [['status', '--seat', 'lead'], 'unknown option --seat'],
        [['doctor', '--session', SESSION], 'unknown option --session'],
      ];
      for (const [argv, needle] of cases) {
        const io = testIo(at.root);
        expect(await runMcp(argv, io)).toBe(2);
        // `--json` anywhere gives the structured error document, as it does for every mcp run.
        if (needle === 'unknown option --json') {
          expect(io.err).toBe('');
          expect(io.out).toContain('"id": "mcp.invocation"');
          expect(io.out).toContain('unknown option --json');
        } else {
          expect(io.err).toContain(needle);
        }
      }
      const usage = testIo(at.root);
      expect(await runMcp([], usage)).toBe(2);
      expect(usage.err).toContain('status, doctor or serve');
    } finally {
      at.cleanup();
    }
  });
});

describe('the serve is bound to the seat and launch it was started for', () => {
  /** A feed that closes at once: the refused starts below have nothing to answer, and anything
   *  written into `replies` is a line a refused server should never have produced. */
  function closed() {
    const feed = queue();
    feed.end();
    return feed;
  }

  test('another seat’s launch is refused before it serves, even with the launch’s own file and epoch', async () => {
    const at = place();
    try {
      // The two seats stand in one session and one team; only the process is worker's. The file
      // and epoch are exactly the ones lead's own launch line would carry.
      setClaim(at.root, SESSION, 'lead', EPOCH_ONE);
      signed(at, 'lead', LEAD_ID, 'the body lead has not read');
      const io = testIo(at.root, seatCaller('worker'));
      const feed = closed();
      const code = await runMcpServe(
        { seat: 'lead', session: SESSION, file: join(at.root, '.agents', 'team.yaml'), epoch: EPOCH_ONE },
        io,
        feed,
        { home: at.home },
      );
      expect(code).toBe(2);
      expect(io.out).toBe('');
      expect(io.err).toContain('this server serves seat "lead" in session "acme", and this call is placed as seat "worker"');
      // Nothing was listed or read: no line was answered, no listener exists, and the record is
      // still waiting exactly as the sender left it, with no receipt beside it.
      expect(feed.replies).toEqual([]);
      expect(existsSync(listenerPath(at.dropDir('lead')))).toBe(false);
      expect(existsSync(receiptPath(at.dropDir('lead'), LEAD_ID))).toBe(false);
      expect(readdirSync(at.dropDir('lead'))).toEqual([LEAD_ID]);
    } finally {
      at.cleanup();
    }
  });

  test('a caller placed as the seat in another session is refused, and opens no inbox', async () => {
    const at = place();
    try {
      // The state records lead in the team's session; this process stands as lead in another
      // session of the machine, and the server's own session is the team's.
      const io = testIo(at.root, seatCaller('lead', 'other'));
      const feed = closed();
      const code = await runMcpServe(
        { seat: 'lead', session: SESSION, file: join(at.root, '.agents', 'team.yaml') },
        io,
        feed,
        { home: at.home },
      );
      expect(code).toBe(2);
      expect(io.out).toBe('');
      expect(io.err).toContain('this server serves seat "lead" in session "acme", and this call is placed as seat "lead" in session "other"');
      expect(feed.replies).toEqual([]);
      expect(existsSync(join(at.root, '.agents', 'send-drops', SESSION, 'lead'))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('a caller placed on another pane than the state records is refused, and opens no inbox', async () => {
    const at = place();
    try {
      const io = testIo(at.root, { kind: 'seat', name: 'lead', pane: 'pane-elsewhere', session: SESSION });
      const feed = closed();
      const code = await runMcpServe(
        { seat: 'lead', session: SESSION, file: join(at.root, '.agents', 'team.yaml') },
        io,
        feed,
        { home: at.home },
      );
      expect(code).toBe(2);
      expect(io.out).toBe('');
      expect(io.err).toContain('the state records pane pane-lead for seat "lead" in session "acme", not the pane this server runs in');
      expect(feed.replies).toEqual([]);
      expect(existsSync(join(at.root, '.agents', 'send-drops', SESSION, 'lead'))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('a launch the state does not hold refuses before the inbox is opened', async () => {
    const at = place();
    try {
      const file = join(at.root, '.agents', 'team.yaml');
      const start = async (epoch: string | undefined, claim: string | null) => {
        setClaim(at.root, SESSION, 'lead', claim);
        const io = testIo(at.root, seatCaller('lead'));
        const feed = closed();
        const code = await runMcpServe({ seat: 'lead', session: SESSION, file, ...(epoch === undefined ? {} : { epoch }) }, io, feed, { home: at.home });
        return { code, io, feed };
      };
      const gone = await start(EPOCH_ONE, null);
      expect(gone.code).toBe(2);
      expect(gone.io.err).toContain(`--epoch ${JSON.stringify(EPOCH_ONE)} names a launch the seat's state no longer holds`);
      const unbound = await start(undefined, EPOCH_ONE);
      expect(unbound.code).toBe(2);
      expect(unbound.io.err).toContain('seat "lead" has a current brief claim and this server was started without its epoch');
      const moved = await start(EPOCH_ONE, EPOCH_TWO);
      expect(moved.code).toBe(2);
      expect(moved.io.err).toContain(`--epoch ${JSON.stringify(EPOCH_ONE)} is not the seat's current launch epoch`);
      expect([gone.feed.replies, unbound.feed.replies, moved.feed.replies]).toEqual([[], [], []]);
      expect(existsSync(join(at.root, '.agents', 'send-drops', SESSION, 'lead'))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('a launch that moves under a running server stops its lists and its receipts', async () => {
    const at = place();
    try {
      setClaim(at.root, SESSION, 'lead', EPOCH_ONE);
      signed(at, 'lead', LEAD_ID, 'the body lead has not read');
      const io = testIo(at.root, seatCaller('lead'));
      const feed = queue();
      const running = runMcpServe(
        { seat: 'lead', session: SESSION, file: join(at.root, '.agents', 'team.yaml'), epoch: EPOCH_ONE },
        io,
        feed,
        { home: at.home },
      );
      for (let wait = 0; wait < 200 && !existsSync(listenerPath(at.dropDir('lead'))); wait++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(existsSync(listenerPath(at.dropDir('lead')))).toBe(true);
      // The seat is relaunched: the claim names a new epoch while this process lives.
      setClaim(at.root, SESSION, 'lead', EPOCH_TWO);
      feed.push(call('1', 'inbox_check'));
      feed.push(call('2', 'inbox_read', { id: LEAD_ID }));
      for (let wait = 0; wait < 400 && feed.replies.length < 2; wait++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const replies = feed.replies.map((line) => JSON.parse(line) as Record<string, any>);
      expect(replies).toHaveLength(2);
      for (const reply of replies) {
        expect(reply.result.isError).toBe(true);
        expect(reply.result.content[0].text).toContain(`--epoch ${JSON.stringify(EPOCH_ONE)} is not the seat's current launch epoch`);
      }
      expect(existsSync(receiptPath(at.dropDir('lead'), LEAD_ID))).toBe(false);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });

  test('a claim written under a server started without an epoch stops it serving', async () => {
    const at = place();
    try {
      signed(at, 'lead', LEAD_ID, 'the body lead has not read');
      const io = testIo(at.root, seatCaller('lead'));
      const feed = queue();
      const running = runMcpServe({ seat: 'lead', session: SESSION, file: join(at.root, '.agents', 'team.yaml') }, io, feed, { home: at.home });
      for (let wait = 0; wait < 200 && !existsSync(listenerPath(at.dropDir('lead'))); wait++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      setClaim(at.root, SESSION, 'lead', EPOCH_ONE);
      feed.push(call('1', 'inbox_read', { id: LEAD_ID }));
      for (let wait = 0; wait < 400 && feed.replies.length < 1; wait++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const reply = JSON.parse(feed.replies[0]!) as Record<string, any>;
      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0].text).toContain('seat "lead" has a current brief claim and this server was started without its epoch');
      expect(existsSync(receiptPath(at.dropDir('lead'), LEAD_ID))).toBe(false);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });

  test('a seat the state stops recording is refused on its next call', async () => {
    const at = place();
    try {
      signed(at, 'lead', LEAD_ID, 'the body lead has not read');
      const io = testIo(at.root, seatCaller('lead'));
      const feed = queue();
      const running = runMcpServe({ seat: 'lead', session: SESSION, file: join(at.root, '.agents', 'team.yaml') }, io, feed, { home: at.home });
      for (let wait = 0; wait < 200 && !existsSync(listenerPath(at.dropDir('lead'))); wait++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // A lead takes the seat down: the state holds the other seat and no pane for this one.
      writeState(at.root, SESSION, ['worker']);
      feed.push(call('1', 'inbox_check'));
      for (let wait = 0; wait < 400 && feed.replies.length < 1; wait++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const reply = JSON.parse(feed.replies[0]!) as Record<string, any>;
      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0].text).toContain('the state records no pane for seat "lead" in session "acme"');
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });

  /** The team file with one seat's entry marked stopped, the way `team remove <seat> --keep`
   *  leaves it: the declaration stays, with the pane and claim the state records untouched. */
  function stopSeat(at: Place, name: string): void {
    const path = join(at.root, '.agents', 'team.yaml');
    const text = readFileSync(path, 'utf8');
    const index = text.indexOf(`    name: ${name}\n`);
    if (index < 0) throw new Error(`the fixture team file declares no seat ${name}`);
    const after = index + `    name: ${name}\n`.length;
    writeFileSync(path, `${text.slice(0, after)}    stopped: true\n${text.slice(after)}`);
  }

  test('a seat the team file marks stopped is refused at start, and opens no inbox', async () => {
    const at = place();
    try {
      signed(at, 'worker', WORKER_ID, 'the body worker has not read');
      // The state still records the worker's pane and claim: only the file's declaration says
      // the seat is stopped, and that is the word the serve must read.
      stopSeat(at, 'worker');
      const io = testIo(at.root, seatCaller('worker'));
      const feed = closed();
      const code = await runMcpServe({ seat: 'worker', session: SESSION, file: join(at.root, '.agents', 'team.yaml') }, io, feed, { home: at.home });
      expect(code).toBe(2);
      expect(io.out).toBe('');
      expect(io.err).toContain('the team file marks seat "worker" stopped');
      expect(feed.replies).toEqual([]);
      expect(existsSync(listenerPath(at.dropDir('worker')))).toBe(false);
      expect(existsSync(receiptPath(at.dropDir('worker'), WORKER_ID))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('a seat the team file marks stopped between two calls is refused on its next call', async () => {
    const at = place();
    try {
      signed(at, 'worker', WORKER_ID, 'the body worker has not read');
      const io = testIo(at.root, seatCaller('worker'));
      const feed = queue();
      const running = runMcpServe({ seat: 'worker', session: SESSION, file: join(at.root, '.agents', 'team.yaml') }, io, feed, { home: at.home });
      for (let wait = 0; wait < 200 && !existsSync(listenerPath(at.dropDir('worker'))); wait++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(existsSync(listenerPath(at.dropDir('worker')))).toBe(true);
      feed.push(call('1', 'inbox_check'));
      for (let wait = 0; wait < 400 && feed.replies.length < 1; wait++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // The check ran before the stop: it lists the record the sender left.
      const first = JSON.parse(feed.replies[0]!) as Record<string, any>;
      expect(first.result.isError).toBe(undefined);
      expect(JSON.stringify(first)).toContain(WORKER_ID);
      // A lead stops the seat while this server lives. The pane and the claim stay as they were;
      // only the file's declaration changes, and the next call must read it again.
      stopSeat(at, 'worker');
      feed.push(call('2', 'inbox_read', { id: WORKER_ID }));
      for (let wait = 0; wait < 400 && feed.replies.length < 2; wait++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const second = JSON.parse(feed.replies[1]!) as Record<string, any>;
      expect(second.result.isError).toBe(true);
      expect(second.result.content[0].text).toContain('the team file marks seat "worker" stopped');
      expect(existsSync(receiptPath(at.dropDir('worker'), WORKER_ID))).toBe(false);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });

  test('a seat the team file no longer declares is refused on its next call', async () => {
    const at = place();
    try {
      signed(at, 'worker', WORKER_ID, 'the body worker has not read');
      const io = testIo(at.root, seatCaller('worker'));
      const feed = queue();
      const running = runMcpServe({ seat: 'worker', session: SESSION, file: join(at.root, '.agents', 'team.yaml') }, io, feed, { home: at.home });
      for (let wait = 0; wait < 200 && !existsSync(listenerPath(at.dropDir('worker'))); wait++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // The lead drops the seat from the file, as `team remove <seat>` does: the declaration the
      // server was started for is gone, whatever the state still records.
      writeFileSync(join(at.root, '.agents', 'team.yaml'), teamText(['lead']));
      feed.push(call('1', 'inbox_read', { id: WORKER_ID }));
      for (let wait = 0; wait < 400 && feed.replies.length < 1; wait++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const reply = JSON.parse(feed.replies[0]!) as Record<string, any>;
      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0].text).toContain('the team file no longer declares seat "worker"');
      expect(existsSync(receiptPath(at.dropDir('worker'), WORKER_ID))).toBe(false);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });
});
