// `team mcp serve`: one seat's inbox, spoken to its CLI as MCP over stdio.
//
// The server is started by the seat's own launch line, so the seat, session, team file and root
// are the launch's and never a tool argument's. It writes `.inbox-listener` into the seat's drop
// folder while it runs, serves two tools (`inbox_check`, `inbox_read`), and removes the marker
// when its stdin closes. A read verifies the record's signature with the message key before it
// shows the body, and writes `<id>.read.json` before the body is returned; that receipt is the
// only proof of delivery this leg has, and it means the message was read, not acted on.
//
// The one push is the development channel: when the launch carries the flag naming this server,
// the server declares `claude/channel`, pushes each new record as one notification, writes a
// `<id>.channel-push.json` marker beside it, and serves the `ack` tool — which writes the same
// signed read receipt, marked `read_by: channel`. Without the flag, MCP is client-pull and the
// seat notices a message when it calls `inbox_check`, with the drop-folder watch as the bounded
// fall-back.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { raiseRefusalEvent } from '../bus/refusals.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import type { Io } from '../io.ts';
import { isBriefEpoch } from '../launch/brief-id.ts';
import { currentBriefClaim, isGeneralBriefRecord } from '../launch/general-brief.ts';
import { publishRecordRead } from '../send/read-receipt.ts';
import { readRecord, verifyRecord } from '../send/record.ts';
import { wakeHead } from '../send/native.ts';
import { wakeTrigger } from '../send/wake.ts';
import { messageKeyState } from '../store/keys.ts';
import { readState } from '../state.ts';
import { buildIdentity, version } from '../version.ts';
import type { BuildIdentity } from '../version.ts';
import {
  CHANNEL_CAPABILITY,
  CHANNEL_INSTRUCTIONS,
  CHANNEL_METHOD,
  CHANNEL_PUSH_STATUS,
  CHANNEL_READ_BY,
  CHANNEL_TICK_MS,
  channelLaunchEnabled,
  channelPushHeld,
  recordChannelPush,
} from './channel.ts';
import {
  MESSAGE_ID,
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

type Serving = {
  project: string;
  seat: string;
  session: string;
  root: string;
  dropDir: string;
  home: string;
  team: TeamFile;
  /** True when this seat's launch carries the development channel naming this server. */
  channel: boolean;
  brief?: BriefRead;
};

/** Whether two roots are the same folder once links are resolved, as the inbox checks do. */
function sameFolder(left: string, right: string): boolean {
  const real = (at: string): string => {
    try {
      return realpathSync(at);
    } catch {
      return at;
    }
  };
  return real(left) === real(right);
}
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

function toolList(serving: Serving): unknown[] {
  const tools: unknown[] = [
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
  if (serving.channel) {
    tools.push({
      name: 'ack',
      description: 'Acknowledge a channel message by its meta id. Writes the same signed read receipt as `team ack`, with read_by channel. Call it in the same turn the notification arrives.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'the id from the channel notification meta' } },
        required: ['id'],
        additionalProperties: false,
      },
    });
  }
  return tools;
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

/** One channel notification: the message-display header, then the signed body whole. */
function channelPushOf(serving: Serving, id: string): { content: string; meta: Record<string, string> } | null {
  const looked = readRecord(join(serving.dropDir, id), id);
  if (!looked.ok || looked.record === null) return null;
  const payload = looked.record.payload;
  if (payload.to !== serving.seat || payload.session !== serving.session || !sameFolder(payload.root, serving.root)) return null;
  // A record a client wrote, and the seat's own general brief, are never channel messages: the
  // brief is served at the turn start under its claim, and an ack here would hold the receipt
  // name that reader needs.
  if (payload.from_client !== undefined || isGeneralBriefRecord(payload)) return null;
  const key = messageKeyState(serving.home);
  if (key.kind !== 'key' || !verifyRecord(looked.record, key.key)) return null;
  const sender = wakeTrigger(payload, serving.home, { root: serving.root, session: serving.session, team: serving.team });
  if (sender === null) return null;
  const header = wakeHead(sender);
  if (header === '') return null;
  return {
    content: `${header}\n\n${payload.body}`,
    meta: { id, from: payload.from, seat: serving.seat, team: serving.project },
  };
}

/**
 * Watches the inbox for signed records that arrive after this server starts, and writes one
 * channel notification per new record. Mail already waiting at startup is left to `inbox_check`,
 * so a fresh session starts quiet. Each push writes its `<id>.channel-push.json` marker after
 * the notification; the signed record is never touched, and only `ack` (or `inbox_read`) writes
 * a read receipt.
 */
function watchChannel(serving: Serving, write: (line: string) => void): () => void {
  const seen = new Set<string>();
  let primed = false;
  const tick = (): void => {
    const unread = listUnread(
      serving.dropDir,
      { to: serving.seat, root: serving.root, session: serving.session },
      serving.home,
    ).filter((message) => !legacyDropAt(join(serving.dropDir, message.id)));
    if (!primed) {
      for (const message of unread) seen.add(message.id);
      primed = true;
      return;
    }
    for (const message of unread) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      // An earlier server may have pushed this id before this one started; its marker is the
      // push, and a second notification is a duplicate wake.
      if (channelPushHeld(serving.dropDir, message.id)) continue;
      const push = channelPushOf(serving, message.id);
      if (push === null) continue;
      write(JSON.stringify({ jsonrpc: '2.0', method: CHANNEL_METHOD, params: push }));
      recordChannelPush(serving.dropDir, {
        v: 1,
        kind: 'channel-push',
        id: message.id,
        seat: serving.seat,
        session: serving.session,
        root: serving.root,
        at: new Date().toISOString(),
        meta: push.meta as { id: string; from: string; seat: string; team: string },
        content_sha256: createHash('sha256').update(push.content).digest('hex'),
        status: CHANNEL_PUSH_STATUS,
      });
    }
  };
  const timer = setInterval(tick, CHANNEL_TICK_MS);
  tick();
  return () => clearInterval(timer);
}

/** The `ack` tool: the signed read receipt `team ack` writes, marked `read_by: channel`. */
function ackTool(args: unknown, serving: Serving): unknown {
  if (!serving.channel) return toolError('ack is served only by a channel inbox');
  const id = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).id : undefined;
  if (typeof id !== 'string' || !MESSAGE_ID.test(id)) return toolError('ack needs the message id from the notification meta');
  if (!inboxFolderHeld(serving.root, serving.session, serving.seat)) {
    return toolError('the inbox folder is not a real folder: a link or a file stands in its path');
  }
  const looked = readRecord(join(serving.dropDir, id), id);
  if (!looked.ok || looked.record === null) return toolError(`no message ${id} is waiting in this inbox`);
  const payload = looked.record.payload;
  if (payload.to !== serving.seat || payload.session !== serving.session || !sameFolder(payload.root, serving.root)) {
    return toolError(`message ${id} is not addressed to this inbox`);
  }
  if (payload.from_client !== undefined) return toolError(`message ${id} was written by a client; its read belongs to the client inbox`);
  if (isGeneralBriefRecord(payload)) return toolError(`message ${id} is the general seat brief; it is read by the seat's own turn-start reader`);
  const key = messageKeyState(serving.home);
  if (key.kind !== 'key') return toolError('no message key; nothing was acknowledged');
  if (!verifyRecord(looked.record, key.key)) return toolError(`message ${id} does not verify with this home's key`);
  const outcome = publishRecordRead({
    dropDir: serving.dropDir,
    id,
    to: serving.seat,
    root: serving.root,
    session: serving.session,
    home: serving.home,
    key: key.key,
    at: new Date().toISOString(),
    readBy: CHANNEL_READ_BY,
  });
  if (outcome.kind === 'held') {
    return toolError(`${id}: not acknowledged: the ${outcome.status} receipt name is held by a file that does not verify for this message`);
  }
  if (outcome.kind === 'unwritten') {
    return toolError(`${id}: not acknowledged: the read receipt could not be written; call ack again`);
  }
  return toolText(JSON.stringify({ acknowledged: id, written: outcome.kind === 'published' }));
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
  if (name === 'ack') return ackTool(args, serving);
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
    case 'initialize': {
      // The channel capability is declared only when the seat's launch enabled it. No
      // `claude/channel/permission` is ever declared: this server asks the person for nothing.
      const capabilities: Record<string, unknown> = serving.channel
        ? { tools: {}, experimental: { [CHANNEL_CAPABILITY]: {} } }
        : { tools: {} };
      return answer(id, {
        protocolVersion: negotiate(record.params),
        capabilities,
        serverInfo: { name: SERVER_NAME, version: version() },
        ...(serving.channel ? { instructions: CHANNEL_INSTRUCTIONS } : {}),
      });
    }
    case 'ping':
      return answer(id, {});
    case 'tools/list':
      return answer(id, { tools: toolList(serving) });
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
  const loaded = readTeamConfig(io.cwd, { ...(options.file === undefined ? {} : { file: options.file }), home: host.home });
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
  // The channel is the seat's own launch word: a line with the development-channels flag naming
  // this server. Nothing on the command line turns it on separately, and a marker without it is
  // an ordinary inbox the send walks past.
  const channel = channelLaunchEnabled(seat.launch);
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
    ...(channel ? { channel: true as const } : {}),
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
    team,
    channel,
    brief,
  };
  const stopChannel = channel ? watchChannel(serving, streams.write) : null;
  try {
    for await (const line of streams.lines) {
      const reply = handleLine(line, serving);
      if (reply !== null) streams.write(reply);
    }
  } finally {
    stopChannel?.();
    streams.close?.();
    removeListener(dropDir, process.pid);
  }
  // exit: mcp.serve-ended
  return 0;
}
