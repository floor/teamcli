// `team mcp serve`: one seat's inbox, spoken to its CLI as MCP over stdio.
//
// The server is started by the seat's own launch line, so the seat, session, team file and root
// are the launch's and never a tool argument's. It writes `.inbox-listener` into the seat's drop
// folder while it runs, serves two tools (`inbox_check`, `inbox_read`), and removes the marker
// when its stdin closes. A read verifies the record's signature with the message key before it
// shows the body, and writes `<id>.read.json` before the body is returned; that receipt is the
// only proof of delivery this leg has, and it means the message was read, not acted on.
//
// Nothing here is a push: MCP is client-pull, so the seat notices a message when it calls
// `inbox_check`. The drop-folder watch is the bounded fall-back, not this process.
//
// Spike branch only: with TEAM_SPIKE_CHANNEL=1 this process also answers the question whether
// Claude Code registers a stdio server whose initialize result declares
// `experimental['claude/channel']` and renders an unsolicited `notifications/claude/channel`.
// A push is emitted only for a signed record that arrives in the inbox after startup; the
// record stays for `inbox_read`, and a `<id>.channel-push.json` receipt records what TeamCLI
// wrote, because Claude Code acknowledges no channel notification. This is measurement code,
// not a product delivery path.
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { raiseRefusalEvent } from '../bus/refusals.ts';
import { loadTeamFile } from '../file/load.ts';
import type { Io } from '../io.ts';
import { isBriefEpoch } from '../launch/brief-id.ts';
import { currentBriefClaim } from '../launch/general-brief.ts';
import { readRecord, verifyRecord } from '../send/record.ts';
import { readState } from '../state.ts';
import { messageKeyState } from '../store/keys.ts';
import { buildIdentity, version } from '../version.ts';
import type { BuildIdentity } from '../version.ts';
import {
  ensureInboxFolder,
  inboxFolderHeld,
  legacyDropAt,
  listUnread,
  readMessage,
  removeListener,
  writeListener,
  type BriefRead,
  type InboxListener,
} from './inbox.ts';

/** The protocol version this server speaks when the client names one it does not know. */
export const PROTOCOL_VERSION = '2025-06-18';

/** The versions the server can answer in; the client's own is echoed when it is one of these. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2024-11-05', '2025-03-26', PROTOCOL_VERSION];

export const SERVER_NAME = 'team-inbox';

/** Spike only: the notification method Claude Code listens for once `claude/channel` is declared. */
export const CHANNEL_METHOD = 'notifications/claude/channel';

/** Spike only: the receipt this process writes beside a record when it emits that record's push.
 *  It is not a read receipt and never proves delivery; only `inbox_read` writes the signed
 *  `.read.json`. */
export const CHANNEL_PUSH_RECEIPT = 'channel-push';

/** One JSON-RPC message per line in each direction. Tests pass their own. */
export type ServeStreams = {
  lines: AsyncIterable<string>;
  write(line: string): void;
  close?(): void;
};

export type ServeOptions = { seat: string | undefined; session: string | undefined; file?: string; epoch?: string };

/** Where the server reads the message key, and the build it stamps on its listener marker. The
 *  launch uses the process's home; a test pins its own, so no read can reach the home of the
 *  machine running the suite, and may pin the build identity it asserts. */
export type ServeHost = { home: string; build?: BuildIdentity };

export const realServeHost: ServeHost = { home: homedir() };

type Serving = { project: string; seat: string; session: string; root: string; dropDir: string; home: string; brief?: BriefRead };
type RequestId = string | number | null;

/** The process's stdin and stdout, framed the way MCP's stdio transport reads them. */
export function processStreams(): ServeStreams {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  return {
    lines,
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    close: () => {
      lines.close();
    },
  };
}

function toolList(): unknown[] {
  return [
    {
      name: 'inbox_check',
      description: "List the messages waiting in this seat's inbox. Call it at the start of every turn.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'inbox_read',
      description: "Read one message from this seat's inbox. The call marks it read.",
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'the id inbox_check returned' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];
}

function toolError(text: string): unknown {
  return { content: [{ type: 'text', text }], isError: true };
}

function toolText(text: string): unknown {
  return { content: [{ type: 'text', text }] };
}

function answer(id: RequestId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function failure(id: RequestId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/** The client's requested protocol version when this server knows it, else this server's own. */
function negotiate(params: unknown): string {
  if (typeof params === 'object' && params !== null) {
    const asked = (params as Record<string, unknown>).protocolVersion;
    if (typeof asked === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(asked)) return asked;
  }
  return PROTOCOL_VERSION;
}

/** Spike only: one channel notification, exactly the two parameter fields the reference names. */
export type ChannelPush = { content: string; meta: Record<string, string> };

/** Spike only: the body and sender of a signed record already in this inbox, verified without
 *  writing a read receipt. The record is left where it is; `inbox_read` is still the only read. */
export function channelSourceOf(serving: Serving, id: string): { body: string; from: string } | null {
  const looked = readRecord(join(serving.dropDir, id), id);
  if (!looked.ok || looked.record === null) return null;
  const payload = looked.record.payload;
  if (payload.to !== serving.seat || payload.session !== serving.session) return null;
  if (payload.root !== serving.root) return null;
  const key = messageKeyState(serving.home);
  if (key.kind !== 'key' || !verifyRecord(looked.record, key.key)) return null;
  return { body: payload.body, from: payload.from };
}

/** Spike only: the push a record would produce. Meta keys stay identifier-only (`from`, `seat`,
 *  `team`, `id`) as the channel reference requires; anything else is dropped by the client. */
export function channelPushOf(serving: Serving, id: string, team: string): ChannelPush | null {
  const source = channelSourceOf(serving, id);
  if (source === null) return null;
  return { content: source.body, meta: { from: source.from, seat: serving.seat, team, id } };
}

/** Spike only: watch the inbox for records that arrive after this server starts, and write one
 *  channel notification per new signed record. Mail already waiting at startup is left to
 *  `inbox_check`, so a fresh session starts quiet. Each push leaves the signed record untouched
 *  and writes the unconfirmed push receipt beside it. */
function watchChannel(serving: Serving, team: string, write: (line: string) => void): () => void {
  const seen = new Set<string>();
  let primed = false;
  const tick = (): void => {
    const unread = listUnread(
      serving.dropDir,
      { to: serving.seat, root: serving.root, session: serving.session },
      serving.home,
    );
    if (!primed) {
      for (const message of unread) seen.add(message.id);
      primed = true;
      return;
    }
    for (const message of unread) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      const push = channelPushOf(serving, message.id, team);
      if (push === null) continue;
      write(JSON.stringify({ jsonrpc: '2.0', method: CHANNEL_METHOD, params: push }));
      const receipt = {
        v: 1,
        kind: CHANNEL_PUSH_RECEIPT,
        id: message.id,
        seat: serving.seat,
        session: serving.session,
        root: serving.root,
        at: new Date().toISOString(),
        content_sha256: createHash('sha256').update(push.content).digest('hex'),
        meta: push.meta,
        status: 'sent (unconfirmed)',
        note: 'Claude Code acknowledges no channel notification; delivery is unproven',
      };
      try {
        writeFileSync(join(serving.dropDir, `${message.id}.${CHANNEL_PUSH_RECEIPT}.json`), `${JSON.stringify(receipt)}\n`, {
          mode: 0o600,
        });
      } catch {
        // The push already went out; a receipt the spike cannot write must not stop the server.
      }
    }
  };
  const timer = setInterval(tick, 250);
  tick();
  return () => clearInterval(timer);
}

/** One `tools/call` body. Tool faults are results with `isError`, not JSON-RPC errors. */
function callTool(params: unknown, serving: Serving): unknown {
  if (typeof params !== 'object' || params === null) return toolError('tools/call needs an object with a name');
  const named = params as Record<string, unknown>;
  const name = named.name;
  const args = named.arguments;
  if (name === 'inbox_check') {
    if (!inboxFolderHeld(serving.root, serving.session, serving.seat)) {
      return toolError('the inbox folder is not a real folder: a link or a file stands in its path');
    }
    // A plain-text drop an earlier build wrote is not a message this inbox can ever serve: listing
    // it every turn would only invite a refused `inbox_read` and the owner event that follows. The
    // file stays where it is; `team drops --read` still counts it as unserved.
    const unread = listUnread(
      serving.dropDir,
      { to: serving.seat, root: serving.root, session: serving.session },
      serving.home,
    ).filter((message) => !legacyDropAt(join(serving.dropDir, message.id)));
    return toolText(JSON.stringify({ unread }));
  }
  if (name === 'inbox_read') {
    const id = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).id : undefined;
    if (typeof id !== 'string') return toolError('inbox_read needs a string id');
    if (!inboxFolderHeld(serving.root, serving.session, serving.seat)) {
      return toolError('the inbox folder is not a real folder: a link or a file stands in its path');
    }
    const read = readMessage(
      { dropDir: serving.dropDir, root: serving.root, seat: serving.seat, session: serving.session },
      id,
      serving.home,
      serving.brief,
    );
    if (!read.ok) {
      // A drop an earlier build wrote is refused like any file that is not a record, but it is not
      // a record that could have been admitted: it is not raised to the owner. A record-shaped file
      // that fails — tampered, truncated or foreign — keeps its refusal and its event.
      const legacy = read.refusal?.rule === 'shape' && legacyDropAt(read.refusal.path);
      if (read.refusal !== undefined && !legacy) {
        // The owner hears the rule and the object, never the record's content.
        raiseRefusalEvent({
          project: serving.project,
          root: serving.root,
          home: serving.home,
          session: serving.session,
          kind: 'record.invalid',
          rule: read.refusal.rule,
          object: { id: read.refusal.id, seat: read.refusal.seat, path: read.refusal.path },
        });
      }
      return toolError(read.reason);
    }
    return toolText(read.body);
  }
  return toolError(`unknown tool ${JSON.stringify(String(name))}`);
}

/** One line in, at most one line out. Notifications and blank lines write nothing. */
export function handleLine(line: string, serving: Serving): string | null {
  const text = line.trim();
  if (text === '') return null;
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return failure(null, -32700, 'Parse error');
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return failure(null, -32600, 'Invalid Request');
  }
  const record = message as Record<string, unknown>;
  const hasId = 'id' in record;
  const rawId = record.id;
  const id: RequestId = typeof rawId === 'string' || typeof rawId === 'number' || rawId === null ? rawId : null;
  if (hasId && (typeof rawId !== 'string' && typeof rawId !== 'number' && rawId !== null)) {
    return failure(null, -32600, 'Invalid Request');
  }
  const method = record.method;
  if (typeof method !== 'string') return hasId ? failure(id, -32600, 'Invalid Request') : null;
  // A notification (no id): nothing the client asked to be answered. `notifications/initialized`
  // is the one every client sends after the handshake.
  if (!hasId) return null;
  switch (method) {
    case 'initialize':
      return answer(id, {
        protocolVersion: negotiate(record.params),
        capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
        serverInfo: { name: SERVER_NAME, version: version() },
      });
    case 'ping':
      return answer(id, {});
    case 'tools/list':
      return answer(id, { tools: toolList() });
    case 'tools/call':
      return answer(id, callTool(record.params, serving));
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Runs the stdio server for one seat and returns the process exit code. The seat must be one the
 * team file declares, and `--session`, when given, must be the team's own session: the server
 * serves exactly one inbox. `--file` is the team file the seat's launch read: a seat that starts
 * in a lobby has no team file in its folder, so the registration names the launch's file and the
 * server reads that instead of its own folder.
 */
export async function runMcpServe(
  options: ServeOptions,
  io: Io,
  streams: ServeStreams = processStreams(),
  host: ServeHost = realServeHost,
): Promise<number> {
  const refuse = (message: string): number => {
    io.stderr(`team mcp serve: ${message}\n`);
    // exit: mcp.serve-refused
    return 2;
  };
  if (options.seat === undefined || options.seat === '') return refuse('--seat <seat> is required');
  if (options.epoch !== undefined && !isBriefEpoch(options.epoch)) {
    return refuse(`--epoch ${JSON.stringify(options.epoch)} is not a runtime epoch`);
  }
  const loaded = loadTeamFile(io.cwd, { ...(options.file === undefined ? {} : { file: options.file }), home: host.home });
  if (!loaded.ok) return refuse(loaded.errors[0]?.message ?? 'the team file could not be read');
  const team = loaded.team;
  const session = options.session ?? team.session;
  if (session !== team.session) {
    return refuse(`the team's session is ${JSON.stringify(team.session)}, not ${JSON.stringify(session)}`);
  }
  const seat = team.seats.find((one) => one.name === options.seat);
  if (seat === undefined) return refuse(`the team file declares no seat ${JSON.stringify(options.seat)}`);
  const dropDir = ensureInboxFolder(loaded.root, team.session, seat.name);
  if (dropDir === null) {
    return refuse('the inbox folder is not a real folder: a link, a file or a failed write stands in its path');
  }
  const build = host.build ?? buildIdentity();
  const listener: InboxListener = {
    v: 1,
    seat: seat.name,
    session: team.session,
    root: loaded.root,
    cli: seat.cli,
    pid: process.pid,
    ts: new Date().toISOString(),
    version: build.version,
    build: build.build,
  };
  if (!writeListener(dropDir, listener)) return refuse('the inbox listener marker could not be written');
  // The launch's own brief is served under the claim its state holds. The epoch is the one the
  // registration was started with, when it has one: a server started before a relaunch serves
  // nothing of the claim that relaunch wrote, until the seat is launched again.
  const stateDir = dirname(loaded.path);
  const claimOf = () => {
    try {
      return currentBriefClaim(readState(stateDir).sessions[team.session]?.briefs?.[seat.name]);
    } catch {
      return null;
    }
  };
  const brief: BriefRead = { claim: claimOf, ...(options.epoch === undefined ? {} : { epoch: options.epoch }) };
  const serving: Serving = {
    project: team.project,
    seat: seat.name,
    session: team.session,
    root: loaded.root,
    dropDir,
    home: host.home,
    brief,
  };
  // Spike only: TEAM_SPIKE_FRAMES records every protocol line this server reads and writes, so
  // the capture is the server's own view of the handshake and the push.
  const frameFile = process.env.TEAM_SPIKE_FRAMES;
  const frame = (direction: 'IN' | 'OUT', line: string): void => {
    if (frameFile === undefined || frameFile === '') return;
    try {
      appendFileSync(frameFile, `${new Date().toISOString()} ${direction} ${line}\n`);
    } catch {
      // A frame log the spike cannot write must not stop the server.
    }
  };
  const write = (line: string): void => {
    frame('OUT', line);
    streams.write(line);
  };
  const stopChannel = process.env.TEAM_SPIKE_CHANNEL === '1' ? watchChannel(serving, team.project, write) : null;
  try {
    for await (const line of streams.lines) {
      frame('IN', line);
      const reply = handleLine(line, serving);
      if (reply !== null) write(reply);
    }
  } finally {
    stopChannel?.();
    streams.close?.();
    removeListener(dropDir, process.pid);
  }
  // exit: mcp.serve-ended
  return 0;
}
