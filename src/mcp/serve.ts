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
// `<id>.channel-push.json` reservation beside it. Handoff is not a consumer read: the `ack` tool
// writes the signed read receipt with `read_by: channel` only when the client acknowledges the
// message. `inbox_read` and reply also settle it through their ordinary read paths. Without
// the flag, MCP is client-pull and the seat notices a message when it calls `inbox_check`, with
// the drop-folder watch as the bounded fall-back.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { followBus, followBusRetrying, type BusFollow } from '../bus/follow.ts';
import { raiseRefusalEvent } from '../bus/refusals.ts';
import { callerOf, callerVerdict, describeCaller, type SeatAtPane } from '../caller.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { LoadResult, TeamFile } from '../file/types.ts';
import type { Io } from '../io.ts';
import { isBriefEpoch } from '../launch/brief-id.ts';
import { currentBriefClaim, isGeneralBriefRecord } from '../launch/general-brief.ts';
import { registeredRootOf } from '../registry/teams.ts';
import { publishRecordRead } from '../send/read-receipt.ts';
import { namingFor, senderDisplayName } from '../send/names.ts';
import { readSealedRecord, recordAuthOfSealed } from '../send/record.ts';
import { attributedBody } from '../send/sender-claim.ts';
import { messageKeyState } from '../store/keys.ts';
import { readState, type SeatState, type State } from '../state.ts';
import { buildIdentity, installIdentity, version } from '../version.ts';
import type { BuildIdentity, InstallIdentity } from '../version.ts';
import { admitChannelDelivery } from './channel-admit.ts';
import {
  CHANNEL_CAPABILITY,
  CHANNEL_INSTRUCTIONS,
  CHANNEL_METHOD,
  CHANNEL_PUSH_STATUS,
  CHANNEL_READ_BY,
  CHANNEL_SAFETY_MS,
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
import { selfRunner } from './register.ts';

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
 *  machine running the suite, and may pin the build identity it asserts. `installed` is the
 *  identity on disk now: a server started before an install compares it with its own and starts a
 *  fresh process from the installed entry. When `build` is pinned without `installed`, the pinned
 *  identity is also the installed one — a scene that states its build never reloads on its own.
 *  `restart` stands in for the fresh process in a test; the launch starts the real one. */
export type ServeHost = {
  home: string;
  build?: BuildIdentity;
  installed?: () => InstallIdentity;
  restart?: (installed: InstallIdentity) => void;
};

export const realServeHost: ServeHost = { home: homedir() };

/** Whether the install on disk is still the one this process started from. The packed commit is
 *  compared as well as the version: a package rebuilt from another commit under the same version
 *  is another install, and its parsers are not this process's. */
function installChanged(running: BuildIdentity, onDisk: InstallIdentity): boolean {
  return running.version !== onDisk.version || (running.head ?? null) !== onDisk.head;
}

/** The signals a client's shutdown arrives as. The process waiting on a fresh server is the one
 *  a session or service manager stops, and the fresh server is the one that must receive it. */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/** Where shutdown signals are listened for. The launch passes none; a scene supplies a fake so it
 *  can deliver a signal without sending one to a real process. */
export type SignalWatch = {
  on: (signal: NodeJS.Signals, listener: () => void) => unknown;
  off: (signal: NodeJS.Signals, listener: () => void) => unknown;
};

/** The spawn and exit `restartSelf` uses. The launch passes none; a scene supplies them so it can
 *  drive the child's events without spawning a process or ending the suite. */
export type RestartHooks = {
  spawnChild?: typeof spawn;
  exit?: (code: number) => void;
  say?: (line: string) => void;
  signals?: SignalWatch;
};

/** Starts a fresh server from the entry this process loaded and leaves this one. The new process
 *  inherits the client's stdio, so it is the same MCP session; the listener marker is removed
 *  before this is called, and the fresh process writes its own. A stdin line the old process had
 *  already read is not replayed: the client's next call is the new process's first.
 *
 *  The old process stays the fresh one's parent until the fresh one exits. The serve proves its
 *  caller by its parent processes on every call, and a process whose parent has left is
 *  reparented: the fresh server's walk would no longer reach the seat's CLI, pane root and herdr,
 *  and it would be refused at start or on its next call. The parent link is the proof the kernel
 *  keeps — a handoff record could not stand in for it, because every seat on this home can read
 *  the key such a record would carry. This process reads nothing more and writes nothing; it
 *  leaves when the fresh server does, with that server's own exit code (1 when a signal ended
 *  it). A shutdown signal aimed at the client's session is carried to the fresh server, whose
 *  exit is then what ends this process.
 *
 *  A start that fails reports `error` on the child after `spawn` has already returned, so the
 *  failure cannot be caught around the call: this process leaves only after the child's `error`
 *  (exit 1) or its `exit` (its own code). A quiet exit 0 would end the client's session as if
 *  the fresh server had taken over. */
export function restartSelf(hooks: RestartHooks = {}): void {
  const start = hooks.spawnChild ?? spawn;
  const say = hooks.say ?? ((line: string) => process.stderr.write(line));
  // A replacement that never started has no code of its own to leave with: the failure is this
  // process's, and it leaves 1. A scene's `exit` sees the same call it always did.
  const failed = (): void => {
    say('team mcp serve: the fresh server could not start; the next launch reloads\n');
    if (hooks.exit) {
      hooks.exit(1);
      return;
    }
    // exit: team.mcp-serve-restart-failed
    process.exit(1);
  };
  const exit = hooks.exit ?? ((code: number): void => {
    if (code === 0) {
      // exit: team.mcp-serve-handed-over
      process.exit(0);
    }
    // exit: team.mcp-serve-replacement-ended
    process.exit(code);
  });
  const signals = hooks.signals ?? process;
  const { command, entry } = selfRunner();
  let child: ChildProcess;
  try {
    child = start(command, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
  } catch {
    failed();
    return;
  }
  // The client's shutdown is aimed at the server that serves it. This process carries the signal
  // to the fresh server instead of ending beside it, and then leaves with that server's result.
  const listening = SHUTDOWN_SIGNALS.map((signal) => {
    const forward = (): void => {
      try {
        child.kill(signal);
      } catch {
        // The fresh server is already gone; its exit or error is what ends this process.
      }
    };
    signals.on(signal, forward);
    return [signal, forward] as const;
  });
  const forget = (): void => {
    for (const [signal, forward] of listening) signals.off(signal, forward);
  };
  child.once('spawn', () => {
    // The fresh server's proof runs through this process, so this one must not leave first.
    child.once('exit', (code) => {
      forget();
      exit(code ?? 1);
    });
  });
  child.once('error', () => {
    forget();
    failed();
  });
}

type Serving = {
  project: string;
  seat: string;
  session: string;
  root: string;
  dropDir: string;
  home: string;
  team: TeamFile;
  /** The team file as it stands now; admission must not use the startup snapshot. */
  loadTeam: () => TeamFile | null;
  /** True when this seat's launch carries the development channel naming this server. */
  channel: boolean;
  brief?: BriefRead;
  /** Why this server no longer serves this seat, or null while it does. Every tool call and every
   *  channel push asks before it exposes a record or writes a receipt: a stopped, replaced or
   *  relaunched seat's left-over process is inert, not a second reader. */
  alive?: () => string | null;
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
      description: "List the messages waiting in this seat's inbox. Call it at the start and the end of every turn.",
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

/** One channel notification: the message-display header, then the signed body whole. The record's
 *  complete raw payload must carry this key's signature before any field is read: a tampered or
 *  unsupported record is shown nowhere, not even as a header. */
function channelPushOf(serving: Serving, id: string): { content: string; meta: Record<string, string> } | null {
  const looked = readSealedRecord(join(serving.dropDir, id));
  if (!looked.ok || looked.sealed === null) return null;
  const key = messageKeyState(serving.home);
  if (key.kind !== 'key') return null;
  const auth = recordAuthOfSealed(looked.sealed, key.key);
  if (auth.kind !== 'ok' || auth.value.payload.id !== id) return null;
  const payload = auth.value.payload;
  if (payload.to !== serving.seat || payload.session !== serving.session || !sameFolder(payload.root, serving.root)) return null;
  // A record a client wrote, and the seat's own general brief, are never channel messages: the
  // brief is served at the turn start under its claim, and an ack here would hold the receipt
  // name that reader needs.
  if (payload.from_client !== undefined || isGeneralBriefRecord(payload)) return null;
  const team = serving.loadTeam();
  if (team === null) return null;
  const admitted = admitChannelDelivery({
    payload,
    home: serving.home,
    root: serving.root,
    session: serving.session,
    seat: serving.seat,
    team,
  });
  if (!admitted.ok) return null;
  // Render authority independently of content. Only one known stored envelope may be folded:
  // nested headers are literal message text, including a worker quoting the owner's header.
  const displayName = payload.from === 'owner' ? 'the owner' : senderDisplayName(
    { seat: payload.from, id: payload.from_id },
    namingFor({ home: serving.home, root: serving.root, file: team }),
  );
  const leadingClaim = /^from ([^\n]*?) — admitted by: ([^\n]*)\n\n?/;
  const envelope = leadingClaim.exec(payload.body);
  const knownEnvelope = envelope !== null
    && (envelope[1] === payload.from || envelope[1] === displayName)
    && envelope[2] === payload.rule;
  const body = knownEnvelope ? payload.body.slice(envelope[0].length) : payload.body;
  // The renderer receives an empty body so it cannot parse a content line as sender/rule.
  const content = attributedBody('', payload.from, {
    record: { ...payload, rule: admitted.rule },
    home: serving.home,
    root: serving.root,
    rule: admitted.rule,
    displayName,
  }) + body;
  if (content.trim() === '') return null;
  return {
    content,
    meta: { id, from: payload.from, seat: serving.seat, team: serving.project },
  };
}

/**
 * Watches the inbox for signed records that arrive after this server starts, and writes one
 * channel notification per new record. Mail already waiting at startup is left to `inbox_check`,
 * so a fresh session starts quiet. Each push writes its `<id>.channel-push.json` marker before
 * the notification, as the id's exclusive reservation. A notification handed to stdio proves no
 * consumer read, so only an explicit `ack`, `inbox_read` or reply writes a signed read receipt.
 * An ignored notification stays unread and eligible for the watch's bounded recovery. The signed
 * record itself is never touched.
 *
 * `notice`, when given, is read at the top of every tick: true means this process has been found
 * to run an install that is no longer on disk, so it stops pushing and never writes another
 * notification.
 */
function watchChannel(
  serving: Serving,
  write: (line: string) => void,
  notice?: () => boolean,
  options: { follow?: typeof followBus; fallbackMs?: number; safetyMs?: number; retryMinMs?: number; retryMaxMs?: number } = {},
): () => void {
  const seen = new Set<string>();
  let primed = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let subscription: BusFollow | null = null;
  const stop = (): void => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    subscription?.close();
    subscription = null;
  };
  const halted = (): boolean => {
    if (stopped) return true;
    if (notice !== undefined && notice()) {
      stop();
      return true;
    }
    return false;
  };
  /** One id, verified on its own: the signed record is read and checked, and pushed once. An id
   *  the server may no longer serve is left unseen, so a transient reading is retried on the next
   *  tick and a server that lost its seat never pushes again. */
  const pushOne = (id: string): void => {
    if (seen.has(id)) return;
    const stale = serving.alive?.();
    if (stale !== undefined && stale !== null) return;
    seen.add(id);
    if (legacyDropAt(join(serving.dropDir, id))) return;
    // An earlier server may have pushed this id before this one started, and a sender whose own
    // walk takes the message leaves a held marker at the same name: either marker says this id
    // is not to be pushed, and a second notification is a duplicate wake.
    if (channelPushHeld(serving.dropDir, id)) return;
    const push = channelPushOf(serving, id);
    if (push === null) {
      // Not this seat's signed record yet (or never): a later read may still find it.
      seen.delete(id);
      return;
    }
    // The declaration is looked at again after the record verified and before the reservation:
    // a seat stopped, dropped or moved while its record was read pushes nothing and writes no
    // marker. The last look is before the notification itself; if it refuses there, the marker
    // stands (it is a reservation, not an exposure) and the body does not leave.
    const beforeMarker = serving.alive?.();
    if (beforeMarker !== undefined && beforeMarker !== null) return;
    // The marker is the reservation: it is written exclusively before the notification, so a
    // sender's held marker that lands after the check above wins the name and this server
    // never pushes the id; a marker this server cannot write means no push at all.
    const reserved = recordChannelPush(serving.dropDir, {
      v: 1,
      kind: 'channel-push',
      id,
      seat: serving.seat,
      session: serving.session,
      root: serving.root,
      at: new Date().toISOString(),
      meta: push.meta as { id: string; from: string; seat: string; team: string },
      content_sha256: createHash('sha256').update(push.content).digest('hex'),
      status: CHANNEL_PUSH_STATUS,
    });
    if (!reserved) return;
    // The body leaves here: the declaration is asked one last time, after the reservation, so a
    // seat that lost its place during the marker write receives no notification.
    const beforeWrite = serving.alive?.();
    if (beforeWrite !== undefined && beforeWrite !== null) return;
    // What the client receives is content and meta alone. The reservation suppresses another
    // channel wake; it cannot settle the message or suppress recovery without a consumer read.
    // The seat's signed read stays on ack, inbox_read and reply, and that receipt still carries
    // the launch epoch when the seat holds one.
    write(JSON.stringify({ jsonrpc: '2.0', method: CHANNEL_METHOD, params: push }));
  };
  /** The whole inbox, read and verified: the startup prime, the fallback poll without a bus, and
   *  the slow safety pass beside a live one. */
  const tick = (): void => {
    if (halted()) return;
    const unread = listUnread(
      serving.dropDir,
      { to: serving.seat, root: serving.root, session: serving.session, lead: serving.team.orchestrator },
      serving.home,
    );
    if (!primed) {
      for (const message of unread) seen.add(message.id);
      primed = true;
      return;
    }
    for (const message of unread) pushOne(message.id);
  };
  const every = (ms: number): void => {
    if (stopped) return;
    if (timer !== null) clearInterval(timer);
    timer = setInterval(tick, ms);
  };
  tick();
  // Without a bus the inbox is polled on the short tick, as before. With one, each
  // `message.arrived` routed to this seat pushes its one record at once, and the inbox is read
  // whole only on the slow safety pass, for a sender that could not reach the bus.
  every(options.fallbackMs ?? CHANNEL_TICK_MS);
  // A dropped or absent bus is dialled again with a doubling wait, so a seat that fell back to
  // its poll returns to events when the bus comes back, without a server restart.
  subscription = followBusRetrying(serving.root, { seat: serving.seat, kinds: ['message.arrived'], skipBacklog: true }, {
    onUp: () => {
      every(options.safetyMs ?? CHANNEL_SAFETY_MS);
      // Whatever arrived while the bus was away is read once now, not on the next safety pass.
      tick();
    },
    onEvent: (event) => {
      if (halted()) return;
      const payload = event.payload;
      if (payload.kind !== 'message.arrived' || payload.to !== serving.seat || payload.session !== serving.session) return;
      if (!MESSAGE_ID.test(payload.record_id)) return;
      pushOne(payload.record_id);
    },
    onDown: () => every(options.fallbackMs ?? CHANNEL_TICK_MS),
  }, {
    ...(options.follow === undefined ? {} : { follow: options.follow }),
    ...(options.retryMinMs === undefined ? {} : { minMs: options.retryMinMs }),
    ...(options.retryMaxMs === undefined ? {} : { maxMs: options.retryMaxMs }),
  });
  return stop;
}

/** The `ack` tool: the signed read receipt `team ack` writes, marked `read_by: channel`. */
function ackTool(args: unknown, serving: Serving): unknown {
  if (!serving.channel) return toolError('ack is served only by a channel inbox');
  const id = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).id : undefined;
  if (typeof id !== 'string' || !MESSAGE_ID.test(id)) return toolError('ack needs the message id from the notification meta');
  if (!inboxFolderHeld(serving.root, serving.session, serving.seat)) {
    return toolError('the inbox folder is not a real folder: a link or a file stands in its path');
  }
  const looked = readSealedRecord(join(serving.dropDir, id));
  if (!looked.ok || looked.sealed === null) return toolError(`no message ${id} is waiting in this inbox`);
  // The complete raw payload is authenticated before any field is read or any receipt written.
  const key = messageKeyState(serving.home);
  if (key.kind !== 'key') return toolError('no message key; nothing was acknowledged');
  const auth = recordAuthOfSealed(looked.sealed, key.key);
  if (auth.kind === 'shape') return toolError(`message ${id} is not a signed record`);
  if (auth.kind === 'tampered') return toolError(`message ${id} does not verify with this home's key`);
  if (auth.kind === 'unsupported') return toolError(`message ${id} is signed, and this version cannot read it: ${auth.reason}`);
  const payload = auth.value.payload;
  if (payload.id !== id) return toolError(`no message ${id} is waiting in this inbox`);
  if (payload.to !== serving.seat || payload.session !== serving.session || !sameFolder(payload.root, serving.root)) {
    return toolError(`message ${id} is not addressed to this inbox`);
  }
  if (payload.from_client !== undefined) return toolError(`message ${id} was written by a client; its read belongs to the client inbox`);
  if (isGeneralBriefRecord(payload)) return toolError(`message ${id} is the general seat brief; it is read by the seat's own turn-start reader`);
  // The record is verified now; the declaration is looked at again immediately before the receipt
  // is written, so a seat stopped while its record was being read acknowledges nothing.
  const staleNow = serving.alive?.();
  if (staleNow !== undefined && staleNow !== null) return toolError(staleNow);
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
    lead: serving.team.orchestrator,
    ...(serving.brief?.epoch === undefined ? {} : { epoch: serving.brief.epoch }),
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
  // A server that lost its seat, or whose launch was superseded, serves nothing: every tool —
  // list, read and receipt alike — refuses before it touches the inbox.
  const stale = serving.alive?.();
  if (stale !== undefined && stale !== null) return toolError(stale);
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
      { to: serving.seat, root: serving.root, session: serving.session, lead: serving.team.orchestrator },
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
      { dropDir: serving.dropDir, root: serving.root, seat: serving.seat, session: serving.session, lead: serving.team.orchestrator },
      id,
      serving.home,
      serving.brief,
      // Read again by the reader itself, after the record is verified and before its receipt is
      // written, and once more before the body is handed back: the declaration that was true
      // when the call started can change while a signed record is read.
      () => serving.alive?.() ?? null,
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
    case 'server/discover':
      // Not an MCP method. The spec answer for an unknown method is -32601 with
      // the sentence "Method not found".
      return failure(id, -32601, 'Method not found');
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * The root of the registered team that holds `seat`: the server's placement when no `--file` was
 * given. The folder the server started in says nothing about the team — a seat starts in a lobby,
 * which is not a work tree of any checkout — so the registry's roster is what names the team.
 * `--session` narrows between teams that hold the same seat name, and a lone holder is returned
 * even when its session differs, so the caller's own session check can name the difference.
 */
function registeredRoot(
  home: string,
  seat: string,
  session: string | undefined,
): { ok: true; root: string } | { ok: false; message: string } {
  const found = registeredRootOf(home, seat, session);
  if (found.ok) return found;
  switch (found.kind) {
    case 'unreadable':
      return { ok: false, message: `the team registry cannot be read: ${found.message}` };
    case 'none':
      return { ok: false, message: `no registered team holds seat ${JSON.stringify(seat)}; pass --file` };
    case 'ambiguous':
      return { ok: false, message: `seat ${JSON.stringify(seat)} is on ${String(found.ids.length)} registered teams (${found.ids.join(', ')}); pass --file to say which` };
  }
}

/** The one seat a session's records hold at `pane`, with the shell its launch anchored there.
 *  Null when none records the pane, or more than one does: an ambiguous pane proves nothing.
 *  The shell prefers the create-time `pane_shell`; a record written before it existed falls back
 *  to the launch identity's shell, which carries no start instant and stands at the named-pane
 *  strength (`placedAtRecordedPane` in caller.ts). Built from the same state read placement uses,
 *  so the proof and the refusal read one snapshot. */
function seatAtPaneOf(seats: Record<string, SeatState>, pane: string): SeatAtPane | null {
  const found: { name: string; seat: SeatState }[] = [];
  for (const [name, seat] of Object.entries(seats)) {
    if (seat.pane === pane) found.push({ name, seat });
  }
  if (found.length !== 1) return null;
  const { name, seat } = found[0]!;
  if (seat.pane_shell !== undefined) {
    return {
      name,
      shell: seat.pane_shell,
      from: 'create',
      ...(seat.pane_shell_start !== undefined ? { start: seat.pane_shell_start } : {}),
    };
  }
  const shell = seat.launched?.shell;
  return shell === undefined ? null : { name, shell, from: 'launched' };
}

/**
 * The state's own proof that the caller is the seat this server serves: the caller must place as
 * that seat, on the pane the state records for it in the team's session. The server is started by
 * the seat's launch line, so a process that passes another seat's arguments is refused before any
 * inbox is opened, and a seat stopped while its process survives is refused on its next call. The
 * team's session is the one read, never another session's: a seat the state records elsewhere is
 * not this server's seat, and the state's record for the served session is the only standing.
 * A pane herdr lists with no agent name yet — the window this server starts in — is placed by the
 * shell the seat's own record anchors there, through the sources read below.
 */
export function placementOf(io: Io, stateDir: string, session: string, name: string): { ok: true } | { ok: false; why: string } {
  let sessions: State['sessions'];
  try {
    sessions = readState(stateDir).sessions;
  } catch (error) {
    return { ok: false, why: `the team state cannot be read, so this server cannot prove its caller: ${(error as Error).message}` };
  }
  if (sessions[session] === undefined) {
    return { ok: false, why: `the team state records no session ${JSON.stringify(session)}, so this server cannot prove which seat started it` };
  }
  const seats = sessions[session]?.seats ?? {};
  const caller = callerOf(io, session, { seatAtPane: (pane) => seatAtPaneOf(seats, pane) });
  const verdict = callerVerdict(caller, name, { session, recordedPane: sessions[session]?.seats?.[name]?.pane });
  if (verdict.kind === 'ok') return { ok: true };
  // The caller is placed in the served session under this seat's name: the pane is what does not
  // match. A record with no pane proves no placement at all, and another pane is the seat
  // restarted elsewhere while this process lives.
  if (verdict.kind === 'no-pane') {
    return { ok: false, why: `the state records no pane for seat ${JSON.stringify(name)} in session ${JSON.stringify(session)}, so this server cannot prove the pane it was started on; a lead stops that seat and runs \`team up\`` };
  }
  if (verdict.kind === 'another-pane') {
    return { ok: false, why: `the state records pane ${verdict.recordedPane} for seat ${JSON.stringify(name)} in session ${JSON.stringify(session)}, not the pane this server runs in; a lead stops the team and starts it again` };
  }
  if (caller.kind === 'seat') {
    // A seat caller is refused for another name, or the same name placed in another session; the
    // sentence names the session when it is the difference, so the refusal is not read as a pane
    // fault.
    const placedIn = caller.session !== undefined && caller.session !== session ? ` in session ${JSON.stringify(caller.session)}` : '';
    return { ok: false, why: `this server serves seat ${JSON.stringify(name)} in session ${JSON.stringify(session)}, and this call is placed as seat ${JSON.stringify(caller.name)}${placedIn}` };
  }
  return { ok: false, why: `this server serves seat ${JSON.stringify(name)} and starts inside that seat's own process; this call is ${describeCaller(caller)}` };
}

/** How long `mcp serve` re-proves its caller's placement at start, and the pause between reads.
 *  A seat's CLI starts its MCP servers during boot, before herdr has detected an agent in the
 *  pane and before the launch's own naming step reaches it. The wait is bounded and happens
 *  once, at start; `alive()` re-proves with a single reading on every use and never waits. */
export const SERVE_PLACEMENT_WAIT_MS = 5000;
const SERVE_PLACEMENT_POLL_MS = 250;

/** The pane the state records for a seat, or undefined when the state cannot be read or records
 *  none; the start's wait is only for a pane this says the server runs in. */
function recordedPaneOf(stateDir: string, session: string, name: string): string | undefined {
  try {
    return readState(stateDir).sessions[session]?.seats?.[name]?.pane;
  } catch {
    return undefined;
  }
}

/**
 * The start placement, with its one bounded wait: the first refusal is answered at once unless
 * the environment names the pane the seat's record holds — the one case where the launch's own
 * name is still arriving. Then placement is re-proved every 250 ms for up to 5 s, and the last
 * refusal is the one returned. A wait whose record stops naming that pane ends at once: a seat
 * relaunched elsewhere is not this server's to wait for. `deps` lets a scene hand in its clock
 * and sleep, so the bound is measured without a real wait.
 */
export async function placementAtStart(
  io: Io,
  stateDir: string,
  session: string,
  name: string,
  deps: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<{ ok: true } | { ok: false; why: string }> {
  const first = placementOf(io, stateDir, session, name);
  if (first.ok) return first;
  const recorded = recordedPaneOf(stateDir, session, name);
  if (recorded === undefined || io.env.HERDR_PANE_ID !== recorded) return first;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + SERVE_PLACEMENT_WAIT_MS;
  let last: { ok: true } | { ok: false; why: string } = first;
  while (now() < deadline) {
    await sleep(SERVE_PLACEMENT_POLL_MS);
    if (io.env.HERDR_PANE_ID !== recordedPaneOf(stateDir, session, name)) return last;
    last = placementOf(io, stateDir, session, name);
    if (last.ok) return last;
  }
  return last;
}

/** The launch the seat's state names now: the current brief claim's epoch, no claim, or a state
 *  this server cannot read. */
type Generation = { kind: 'claim'; epoch: string } | { kind: 'none' } | { kind: 'unreadable'; message: string };

function generationOf(stateDir: string, session: string, name: string): Generation {
  try {
    const claim = currentBriefClaim(readState(stateDir).sessions[session]?.briefs?.[name]);
    return claim === null ? { kind: 'none' } : { kind: 'claim', epoch: claim.epoch };
  } catch (error) {
    return { kind: 'unreadable', message: (error as Error).message };
  }
}

/** Why a server started with `epoch` no longer belongs to the seat's launch, or null while it
 *  does. A server started without an epoch serves only while the seat has no current claim: the
 *  claim a relaunch writes makes every earlier server, and every server that named no delivery,
 *  stop serving that seat's inbox. */
function staleLaunch(generation: Generation, epoch: string | undefined, name: string): string | null {
  if (generation.kind === 'unreadable') {
    return `the team state cannot be read, so this server cannot prove the launch it belongs to: ${generation.message}`;
  }
  if (generation.kind === 'none') {
    return epoch === undefined
      ? null
      : `--epoch ${JSON.stringify(epoch)} names a launch the seat's state no longer holds; start the server from the seat's launch line`;
  }
  if (epoch === undefined) {
    return `seat ${JSON.stringify(name)} has a current brief claim and this server was started without its epoch; start the server from the seat's launch line`;
  }
  return epoch === generation.epoch
    ? null
    : `--epoch ${JSON.stringify(epoch)} is not the seat's current launch epoch; start the server from the seat's launch line`;
}

/**
 * Why the team file no longer declares the seat this server serves, or null while it does. The
 * file is read again at every use, never trusted as the snapshot the process started with: a seat
 * marked `stopped: true` while the process lives is one a lead took out of the team, and a file
 * that drops the seat, or now names another session, no longer declares it either.
 */
function declarationRefusal(team: TeamFile, session: string, name: string): string | null {
  if (team.session !== session) {
    return `the team file names session ${JSON.stringify(team.session)} now, not ${JSON.stringify(session)}; this server serves seat ${JSON.stringify(name)} in session ${JSON.stringify(session)}`;
  }
  const seat = team.seats.find((one) => one.name === name);
  if (seat === undefined) {
    return `the team file no longer declares seat ${JSON.stringify(name)}; a lead starts it again with \`team up\``;
  }
  if (seat.stopped) {
    return `the team file marks seat ${JSON.stringify(name)} stopped; a lead starts it again with \`team up\``;
  }
  return null;
}

/**
 * Runs the stdio server for one seat and returns the process exit code. The seat must be one the
 * team file declares, and `--session`, when given, must be the team's own session: the server
 * serves exactly one inbox. `--file` is the team file the seat's launch read: a seat that starts
 * in a lobby has no team file in its folder, so the registration names the launch's file and the
 * server reads that instead of its own folder. Without `--file` the team comes from the registry
 * record that holds the seat (narrowed by `--session`), never from the folder the server starts in.
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
  // A named file is the launch's own team file, read as given. Without one the team is the
  // registry's record for this seat: the folder the server starts in is a lobby for most seats,
  // and reading a team file from it would be reading the checkout's folder, not the seat's team.
  const registered = options.file === undefined ? registeredRoot(host.home, options.seat, options.session) : null;
  if (registered !== null && !registered.ok) return refuse(registered.message);
  const readTeam = (): LoadResult => readTeamConfig(registered === null ? io.cwd : registered.root, {
    ...(options.file === undefined ? {} : { file: options.file }),
    home: host.home,
  });
  const loaded = readTeam();
  if (!loaded.ok) return refuse(loaded.errors[0]?.message ?? 'the team file could not be read');
  const team = loaded.team;
  const session = options.session ?? team.session;
  if (session !== team.session) {
    return refuse(`the team's session is ${JSON.stringify(team.session)}, not ${JSON.stringify(session)}`);
  }
  const seat = team.seats.find((one) => one.name === options.seat);
  if (seat === undefined) return refuse(`the team file declares no seat ${JSON.stringify(options.seat)}`);
  // A seat the file marks stopped is not one this server may serve, whatever its launch does:
  // `team remove <seat> --keep` leaves the entry and its pane, and only the file's word says the
  // seat is out of the team.
  const stoppedNow = declarationRefusal(team, team.session, seat.name);
  if (stoppedNow !== null) return refuse(stoppedNow);
  // The server's own identity is the launch's, and the state has to prove it: the caller is this
  // seat on its recorded pane, and the epoch is the claim the state holds now. Both checks run
  // before the inbox folder or the listener is written, so a refused start leaves no trace.
  const stateDir = dirname(loaded.path);
  const placed = await placementAtStart(io, stateDir, team.session, seat.name);
  if (!placed.ok) return refuse(placed.why);
  const stale = staleLaunch(generationOf(stateDir, team.session, seat.name), options.epoch, seat.name);
  if (stale !== null) return refuse(stale);
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
    ...(build.head === null ? {} : { head: build.head }),
    ...(channel ? { channel: true as const } : {}),
  };
  if (!writeListener(dropDir, listener)) return refuse('the inbox listener marker could not be written');
  // A server keeps the code it started with, and an install neither reloads it nor ends it. The
  // installed identity is read from disk while this one serves: when it differs from the identity
  // in this process, the channel stops pushing and the process is replaced by one started from
  // the installed entry. A pinned build with no installed source is its own install, so a scene
  // that states a build never reloads unless it says how.
  const installedNow = host.installed ?? (host.build === undefined ? installIdentity : () => installIdentityOf(host.build as BuildIdentity));
  const restart = host.restart ?? (() => restartSelf());
  let installed: InstallIdentity | null = null;
  const notice = (): boolean => {
    if (installed !== null) return true;
    let onDisk: InstallIdentity;
    try {
      onDisk = installedNow();
    } catch {
      // An unreadable manifest proves nothing about the install; keep serving this one.
      return false;
    }
    if (!installChanged(build, onDisk)) return false;
    installed = onDisk;
    // End the read loop; the restart happens after the listener is removed. Closing here is what
    // lets the channel's own tick notice the install without waiting for a tool call.
    streams.close?.();
    return true;
  };
  // The launch's own brief is served under the claim its state holds. The epoch is the one the
  // registration was started with, when it has one: a server started before a relaunch serves
  // nothing of the claim that relaunch wrote, until the seat is launched again.
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
    loadTeam: () => {
      const file = readTeam();
      return file.ok ? file.team : null;
    },
    channel,
    brief,
    // Re-proved on every use, not only at start: the seat may be stopped, replaced or relaunched
    // while this process lives, and a launcher-written config that names it again must not make
    // the old process a reader of the new seat. The team file itself is read again: the
    // declaration this server serves is the file's current one, and a seat it has stopped or
    // dropped is no longer a seat this server may serve.
    alive: () => {
      const now = placementOf(io, stateDir, team.session, seat.name);
      if (!now.ok) return now.why;
      const staleLaunchNow = staleLaunch(generationOf(stateDir, team.session, seat.name), options.epoch, seat.name);
      if (staleLaunchNow !== null) return staleLaunchNow;
      const file = readTeam();
      if (!file.ok) {
        return `the team file cannot be read now, so this server cannot prove its seat is still declared: ${file.errors[0]?.message ?? 'the team file could not be read'}`;
      }
      return declarationRefusal(file.team, team.session, seat.name);
    },
  };
  const stopChannel = channel ? watchChannel(serving, streams.write, notice) : null;
  try {
    for await (const line of streams.lines) {
      const reply = handleLine(line, serving);
      if (reply !== null) streams.write(reply);
      // The call just answered ran this build's code; the next one runs the installed build's.
      if (notice()) break;
    }
  } finally {
    stopChannel?.();
    streams.close?.();
    removeListener(dropDir, process.pid);
  }
  if (installed !== null) restart(installed);
  // exit: mcp.serve-ended
  return 0;
}

/** The installed identity a pinned build stands for: its version and packed commit. */
function installIdentityOf(build: BuildIdentity): InstallIdentity {
  return { version: build.version, head: build.head };
}
