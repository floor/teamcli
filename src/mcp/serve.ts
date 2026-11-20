import { carriedPointer, carrierDeliveryOf, recordDeliveredBody } from '../send/readable-wake.ts';
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
import { listenerKeyOf, newOfferToken, proveOffer } from '../comms/offer.ts';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { followBus, followBusRetrying, type BusFollow } from '../bus/follow.ts';
import { raiseRefusalEvent } from '../bus/refusals.ts';
import { callerAncestors, callerOf, callerVerdict, describeCaller, type SeatAtPane } from '../caller.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { LoadResult, TeamFile } from '../file/types.ts';
import type { Io } from '../io.ts';
import { isBriefEpoch } from '../launch/brief-id.ts';
import { currentBriefClaim, isGeneralBriefRecord } from '../launch/general-brief.ts';
import { registeredRootOf } from '../registry/teams.ts';
import { publishRecordRead } from '../send/read-receipt.ts';

import { alreadyReadSentence, readSealedRecord, recordAuthOfSealed, recordStampAt, settledReadOf, stampedSettled } from '../send/record.ts';
import { attributedBody, renderedIdentity } from '../send/sender-claim.ts';
import { bodyWithReaderLine, existingRecordIdsIn, takesReaderLine } from '../send/frame.ts';
import { messageKeyState } from '../store/keys.ts';
import { readState, type SeatState, type State } from '../state.ts';
import { buildIdentity, installIdentity, version } from '../version.ts';
import { agentList, paneProcesses, paneRootPid } from '../herdr.ts';
import { profileFor } from '../profiles/profile.ts';
import type { BuildIdentity, InstallIdentity } from '../version.ts';
import { admitChannelDelivery } from './channel-admit.ts';
import {
  CHANNEL_CAPABILITY,
  CHANNEL_INSTRUCTIONS,
  CHANNEL_METHOD,
  CHANNEL_PUSH_STATUS,
  CHANNEL_READ_BY,
  CHANNEL_IDLE_MS,
  CHANNEL_REDELIVER_MS,
  retireChannelAttempt,
  CHANNEL_SAFETY_MS,
  CHANNEL_TICK_MS,
  channelAborted,
  channelLaunchEnabled,
  channelNotified,
  channelPushHeld,
  markChannelNotified,
  recordChannelEmitted,
  recordChannelPush,
  withChannelCommit,
} from './channel.ts';
import {
  MESSAGE_ID,
  ensureInboxFolder,
  inboxFolderHeld,
  legacyDropAt,
  claimBindingIn,
  listUnread,
  inQueueOrder,
  messageNameOk,
  receiptHeld,
  readMessage,
  removeListener,
  writeListener,
  type BriefRead,
  type InboxListener,
} from './inbox.ts';
import { selfRunner } from './register.ts';
import { ACTOR_LEVEL } from '../queue/floor.ts';
import { exposeBody, exposurePointer } from '../queue/exposure.ts';
import { takeCopyNumber, wrapCopy } from '../queue/handover.ts';
import { channelOfferStartedGivenUp, channelOwnsSeat, claudeAdapterRoot, resendCandidates, resendPass } from '../queue/resend.ts';
import { queuePlaceOf } from '../queue/append.ts';
import { hostedCommit } from '../host/request-scope.ts';
import { heldAt } from '../held.ts';
import { seatListingDirs } from '../queue/mail-tree.ts';
import { seatFolderOf } from '../send/drop-folder.ts';

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

export type ServeOptions = {
  seat: string | undefined;
  session: string | undefined;
  file?: string;
  epoch?: string;
  /** The no-bus inbox pass interval. The command leaves it unset. A scene sets it longer than
   *  its own stretch, so only the folder watch can deliver inside that stretch. */
  fallbackMs?: number;
  /** The re-send scheduler's pass interval (E7b). The command leaves it unset (30 s). */
  redeliverMs?: number;
};

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
  /** Test seam. When set, replaces the completion-flag write. False means the handoff marker
   *  stays and no read receipt is written. */
  channelMark?: (dropDir: string, id: string) => boolean;
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
  /** The launch epoch this process is bound to. The replacement is started bound to exactly it,
   *  and marked as a replacement, so it never adopts a later launch's claim. */
  epoch?: string;
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
/** Set on a server started by `restartSelf`: it serves only the launch its parent was bound to. */
export const SERVE_REPLACEMENT_ENV = 'TEAMCLI_SERVE_REPLACEMENT';

/** The arguments without any `--epoch <value>` or `--epoch=<value>`. */
function withoutEpoch(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    if (word === '--epoch') {
      index += 1;
      continue;
    }
    if (word.startsWith('--epoch=')) continue;
    kept.push(word);
  }
  return kept;
}

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
    const args = withoutEpoch(process.argv.slice(2));
    hostedCommit('node:child_process.spawn');
    child = start(command, [entry, ...args, ...(hooks.epoch === undefined ? [] : ['--epoch', hooks.epoch])], {
      stdio: 'inherit',
      env: { ...process.env, [SERVE_REPLACEMENT_ENV]: '1' },
    });
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
  channelMark?: (dropDir: string, id: string) => boolean;
  /** This server's listener incarnation (`<pid>@<marker ts>`), when it serves the channel: the
   *  key its offers are pushed under and its token-ack log is filed by (src/comms/offer.ts). */
  listenerKey?: string;
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
      description: 'Acknowledge a channel message by the id and offer from its meta. Writes the same signed read receipt as `team ack`, with read_by channel. Call it in the same turn the notification arrives.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'the id from the channel notification meta' },
          offer: { type: 'string', description: 'the offer from the channel notification meta, when it carries one' },
        },
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

/** One channel notification: the message-display header, the signed body whole, then the reader
 *  line. The record's complete raw payload must carry this key's signature before any field is
 *  read: a tampered or unsupported record is shown nowhere, not even as a header. */
function channelPushOf(serving: Serving, id: string): { content: string; meta: Record<string, string> } | null {
  const dropDir = seatFolderOf(serving.dropDir, id);
  const looked = readSealedRecord(join(dropDir, id));
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
  // The sender's one identity (src/comms/identity.ts): the record's signed one, else the
  // registry's by id. No other name is handed to the renderer.
  const identity = renderedIdentity(payload.from, { record: payload, home: serving.home });
  const leadingClaim = /^from ([^\n]*?) — admitted by: ([^\n]*)\n\n?/;
  const envelope = leadingClaim.exec(payload.body);
  const knownEnvelope = envelope !== null
    && (envelope[1] === payload.from || envelope[1] === identity.name || envelope[1] === identity.address || (payload.from === 'owner' && envelope[1] === 'the owner'))
    && envelope[2] === payload.rule;
  const body = knownEnvelope ? payload.body.slice(envelope[0].length) : payload.body;
  // The renderer receives an empty body so it cannot parse a content line as sender/rule.
  const content = attributedBody('', payload.from, {
    record: { ...payload, rule: admitted.rule },
    home: serving.home,
    root: serving.root,
    rule: admitted.rule,
  }) + body;
  if (content.trim() === '') return null;
  // The reader line every socket frame ends with: the record's id, as `team reply` and `team ack`
  // take it. The meta carries the id too, but a client may show only the content, and a seat
  // that cannot see the id cannot answer on the thread.
  return {
    content: takesReaderLine(payload, false) ? bodyWithReaderLine(content, id, existingRecordIdsIn(dropDir)) : content,
    meta: { id, from: payload.from, seat: serving.seat, team: serving.project },
  };
}

/** The team's lead, for a clearance's authority (E7b); none when the team cannot be read. */
function leadOf(serving: { loadTeam?: () => { orchestrator?: string | null } | null }): { lead?: string } {
  try {
    const lead = serving.loadTeam?.()?.orchestrator;
    return typeof lead === 'string' && lead !== '' ? { lead } : {};
  } catch {
    return {};
  }
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
  options: { follow?: typeof followBus; fallbackMs?: number; safetyMs?: number; retryMinMs?: number; retryMaxMs?: number; redeliverMs?: number } = {},
): () => void {
  const seen = new Set<string>();
  let primed = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let namesTimer: ReturnType<typeof setInterval> | null = null;
  let pulse: ReturnType<typeof setTimeout> | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let redeliverTimer: ReturnType<typeof setInterval> | null = null;
  /** One watch per folder of the seat (src/queue/mail-tree.ts): the stamped one once it stands. */
  const folders = new Map<string, FSWatcher>();
  let subscription: BusFollow | null = null;
  /** Busy commits retried off the main wait. Five tries, then one logged give-up. The id stays
   *  unseen, so a later names pass tries it again once the lock is gone. */
  const retryCount = new Map<string, number>();
  const retryTimer = new Map<string, ReturnType<typeof setTimeout>>();
  const gaveUp = new Set<string>();
  const stop = (): void => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (namesTimer !== null) clearInterval(namesTimer);
    namesTimer = null;
    if (pulse !== null) clearTimeout(pulse);
    pulse = null;
    if (drainTimer !== null) clearTimeout(drainTimer);
    drainTimer = null;
    if (redeliverTimer !== null) clearInterval(redeliverTimer);
    redeliverTimer = null;
    for (const pending of retryTimer.values()) clearTimeout(pending);
    retryTimer.clear();
    for (const watcher of folders.values()) watcher.close();
    folders.clear();
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
  /** A busy lock is tried again on a timer, five times, then logged once. The id is not marked
   *  seen. The timer is the retry: the main thread does not wait. */
  const scheduleRetry = (id: string): void => {
    if (gaveUp.has(id) || retryTimer.has(id)) return;
    const n = (retryCount.get(id) ?? 0) + 1;
    retryCount.set(id, n);
    if (n > 5) {
      retryCount.delete(id);
      gaveUp.add(id);
      console.error(`team mcp serve: channel commit for ${id} stayed busy`);
      return;
    }
    const pending = setTimeout(() => {
      retryTimer.delete(id);
      if (stopped) return;
      pushOne(id);
    }, 20 * 2 ** (n - 1));
    retryTimer.set(id, pending);
  };
  /** One id, verified on its own: the signed record is read and checked, and pushed once. An id
   *  the server may no longer serve is remembered: the commit returns skip and this returns done,
   *  so it is not retried. `retry` means the commit lock was
   *  busy: the name stays unseen and the caller must not remember this mtime. `rejected` means
   *  the body is not a channel record: remember the name and mtime, and do not read it again. */
  const pushOne = (id: string): 'done' | 'retry' | 'rejected' => {
    if (seen.has(id)) return 'done';
    seen.add(id);
    // E7b revision 3: everything about this record sits in the seat folder of its own tree.
    const dropDir = seatFolderOf(serving.dropDir, id);
    if (legacyDropAt(join(dropDir, id))) return 'done';
    // An earlier server may have pushed this id before this one started, and a sender whose own
    // walk takes the message leaves a held marker at the same name: either marker says this id
    // is not to be pushed, and a second notification is a duplicate wake.
    if (channelPushHeld(dropDir, id) || channelNotified(dropDir, id) || channelAborted(dropDir, id)) return 'done';
    // A record the seat already read, or already replied to, is not a channel message again. A
    // stamped record is settled only by its recipient's confirmation (E7b, the strict rule).
    if (recordStampAt(dropDir, id) !== false) {
      const keyNow = messageKeyState(serving.home);
      if (keyNow.kind === 'key' && stampedSettled(dropDir, id, { to: serving.seat, root: serving.root, session: serving.session, ...leadOf(serving) }, keyNow.key)) return 'done';
    } else if (receiptHeld(
      dropDir,
      id,
      { to: serving.seat, root: serving.root, session: serving.session },
      serving.home,
      claimBindingIn(serving.root, serving.session, serving.seat, id),
    )) return 'done';
    const push = channelPushOf(serving, id);
    if (push === null) {
      // Not this seat's signed record. Remember the name and mtime once; a later write changes
      // the mtime and is read again. A busy lock is the case that must not be remembered.
      seen.delete(id);
      return 'rejected';
    }
    // The abort check, the reservation, the handoff marker, the notification write, and the
    // completion flag share one lock with the sender's fallback. The handoff marker is written
    // before the line. If the completion flag cannot be published, the sender sees that marker
    // and does not start another leg. The record stays unread until ack, inbox read, or reply.
    // A stream write still does not prove the client processed the line.
    let heldExposure: ReturnType<typeof exposeBody> | null = null;
    const committed = withChannelCommit(dropDir, id, () => {
      if (channelAborted(dropDir, id) || channelNotified(dropDir, id) || channelPushHeld(dropDir, id)) {
        return 'skip' as const;
      }
      // The seat can stop while the record is open. One re-check here, before the marker and
      // the notification. The record was already read above; this does not open it again.
      const staleNow = serving.alive?.();
      if (staleNow !== undefined && staleNow !== null) return 'skip' as const;
      // The exposure claim (rfc-event-comms §3, E6), immediately before the frame can carry the
      // body: on an active root only its creator pushes the body; any other push carries a pointer.
      const exposure = exposeBody({ dropDir: dropDir, root: serving.root, session: serving.session, seat: serving.seat, msgId: id }, 'channel', serving.home);
      heldExposure = exposure;
      if (exposure.kind === 'pointer') push.content = exposurePointer(id, queuePlaceOf(dropDir, id)?.seq ?? null);
      // A legacy body another carrier already handed over (a socket frame that won the race with
      // this arrival) is not pushed again: the notification is the ID-only wake asking the seat to
      // read the drop before acknowledging it. Stamped copies and owned exposures keep their paths.
      const carriedBefore = exposure.kind === 'legacy'
        && carrierDeliveryOf(dropDir, id, { to: serving.seat, root: serving.root, session: serving.session }, serving.home) !== null;
      if (carriedBefore) push.content = carriedPointer(id, serving.seat);
      // E7b: a stamped record's copy is numbered immediately before the line leaves; a history
      // that cannot be written sends nothing now, and the redelivery pass offers it again.
      // The Claude adapter §2.2: the copy carries a fresh offer token in its meta, kept beside the
      // copy's number with this listener's key. The token is the only thing an ack can prove by.
      let offer: string | null = null;
      if (recordStampAt(dropDir, id) === true) {
        offer = serving.listenerKey === undefined ? null : newOfferToken();
        const n = takeCopyNumber(dropDir, id, 'channel', Date.now(), offer === null || serving.listenerKey === undefined ? undefined : { token: offer, listener: serving.listenerKey });
        if (n === null) return 'skip' as const;
        push.content = wrapCopy(push.content, id, n);
      }
      const reserved = recordChannelPush(dropDir, {
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
      if (!reserved || channelAborted(dropDir, id)) return 'skip' as const;
      if (!recordChannelEmitted(dropDir, id, new Date().toISOString())) return 'skip' as const;
      // The push marker keeps the meta without the token: no reader of the marker sees it.
      write(JSON.stringify({ jsonrpc: '2.0', method: CHANNEL_METHOD, params: offer === null ? push : { content: push.content, meta: { ...push.meta, offer } } }));
      const marked = serving.channelMark
        ? serving.channelMark(dropDir, id)
        : markChannelNotified(dropDir, id);
      if (!marked) return 'uncertain' as const;
      // E3: the frame was written; the read is sealed through this hand-over's own claim only.
      const delivered = { dropDir: dropDir, id, root: serving.root, session: serving.session, seat: serving.seat, home: serving.home, via: 'channel' };
      if (exposure.kind === 'expose') exposure.settle('yes', (owner) => recordDeliveredBody({ ...delivered, owner }));
      else if (exposure.kind === 'legacy' && !carriedBefore) recordDeliveredBody(delivered);
      return 'pushed' as const;
    });
    // A commit that returned before the frame was written exposed nothing: give the claim back.
    if (committed === 'skip' && heldExposure !== null && (heldExposure as { kind: string }).kind === 'expose') {
      (heldExposure as Extract<ReturnType<typeof exposeBody>, { kind: 'expose' }>).settle('no', () => false);
    }
    if (committed === 'busy') {
      seen.delete(id);
      scheduleRetry(id);
      return 'retry';
    }
    gaveUp.delete(id);
    const pending = retryTimer.get(id);
    if (pending !== undefined) {
      clearTimeout(pending);
      retryTimer.delete(id);
    }
    retryCount.delete(id);
    return 'done';
  };
  /** Names already listed, with the mtime they had when they were first seen. A later pass
   *  lists the folder and stats each name; it parses only a name that is new or whose mtime
   *  changed. A seen file is never read again. A busy commit is not entered here. */
  const known = new Map<string, number>();
  /** An id-named file whose body is not a channel record, remembered with the mtime that was
   *  rejected. That pair is not read or verified again until the mtime changes. */
  const rejected = new Map<string, number>();
  /** Names waiting for one read. The value is the mtime, or -1 when this pass has not stated it.
   *  One name is read per turn so a flood of bad files cannot hold the loop. */
  const waiting = new Map<string, number>();
  /** Watch names that arrived while the prime listing was still running. They are parsed once
   *  the prime has finished, not folded into the names the prime already found. */
  const queued: string[] = [];
  const remember = (name: string, mtime: number, outcome: 'done' | 'retry' | 'rejected'): void => {
    if (outcome === 'rejected') rejected.set(name, mtime);
    if (outcome === 'done' || outcome === 'rejected') known.set(name, mtime);
  };
  const scheduleDrain = (): void => {
    if (drainTimer !== null || stopped || waiting.size === 0) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      if (stopped || halted()) return;
      const next = waiting.entries().next();
      if (next.done) return;
      const [name, listed] = next.value;
      waiting.delete(name);
      let mtime = listed;
      if (mtime < 0) {
        try {
          const stat = lstatSync(join(seatFolderOf(serving.dropDir, name), name));
          if (!stat.isFile()) {
            if (waiting.size > 0) scheduleDrain();
            return;
          }
          mtime = stat.mtimeMs;
        } catch {
          if (waiting.size > 0) scheduleDrain();
          return;
        }
      }
      if (known.get(name) !== mtime && rejected.get(name) !== mtime) {
        try {
          remember(name, mtime, pushOne(name));
        } catch {
          // A bad body that throws is still one rejection. It is not read again at this mtime.
          remember(name, mtime, 'rejected');
        }
      }
      if (waiting.size > 0) scheduleDrain();
    }, 0);
  };
  /** The whole inbox, by name: the startup prime remembers what is already there and pushes
   *  nothing, and every later pass parses only names that were not in that memory. */
  const tick = (): void => {
    if (halted()) return;
    // E7b revision 3: the seat's two folders are one inbox (a record lives in one of them).
    const entries: { folder: string; name: string }[] = [];
    for (const folder of seatListingDirs(serving.dropDir)) {
      try {
        for (const name of readdirSync(folder)) entries.push({ folder, name });
      } catch {
        // A folder that cannot be listed holds nothing this tick.
      }
    }
    const present = new Set<string>();
    const changed: { name: string; mtime: number }[] = [];
    for (const { folder: dropDir, name } of entries) {
      present.add(name);
      let mtime = 0;
      try {
        const stat = lstatSync(join(dropDir, name));
        if (!stat.isFile()) continue;
        mtime = stat.mtimeMs;
      } catch {
        continue;
      }
      const prior = known.get(name);
      if (prior === mtime) continue;
      // The prime remembers every name and pushes nothing. After that, a message is remembered
      // only once its push has settled, so a busy lock is tried again. Anything else is remembered
      // now and not parsed.
      if (!primed || !messageNameOk(name)) {
        known.set(name, mtime);
        continue;
      }
      changed.push({ name, mtime });
    }
    for (const name of known.keys()) {
      if (!present.has(name)) {
        known.delete(name);
        rejected.delete(name);
        waiting.delete(name);
      }
    }
    if (!primed) {
      primed = true;
      armFolder();
      return;
    }
    armFolder();
    for (const item of changed) {
      if (rejected.get(item.name) === item.mtime) {
        known.set(item.name, item.mtime);
        continue;
      }
      waiting.set(item.name, item.mtime);
    }
    scheduleDrain();
  };
  /** One named file from the folder watch. It is parsed only when it is new or its mtime
   *  changed. A rejected name and mtime is not read again. The rest of the inbox is not listed. */
  const noteFile = (name: string): void => {
    if (halted() || !messageNameOk(name)) return;
    let mtime = 0;
    try {
      const stat = lstatSync(join(seatFolderOf(serving.dropDir, name), name));
      if (!stat.isFile()) return;
      mtime = stat.mtimeMs;
    } catch {
      return;
    }
    if (known.get(name) === mtime || rejected.get(name) === mtime || waiting.get(name) === mtime) return;
    if (!primed) {
      if (!queued.includes(name)) queued.push(name);
      return;
    }
    // A named event is queued for one read. It does not wait for the idle pass, and it does
    // not read the body on this turn.
    waiting.set(name, mtime);
    scheduleDrain();
  };
  /** Names only: a readdir, and a queue of each message name not already known or rejected.
   *  Seen names are not stated and not parsed. The reads happen one per turn. */
  const namesPass = (): void => {
    if (halted() || !primed) return;
    const names: string[] = [];
    for (const folder of seatListingDirs(serving.dropDir)) {
      try {
        names.push(...readdirSync(folder));
      } catch {
        // A folder that cannot be listed adds no name this pass.
      }
    }
    for (const name of names) {
      if (known.has(name) || waiting.has(name)) continue;
      if (!messageNameOk(name)) {
        known.set(name, 0);
        continue;
      }
      waiting.set(name, -1);
    }
    scheduleDrain();
  };
  /** One burst may list the folder once. The watcher stays open, so an event that names a file
   *  still parses that file and does not wait for the listing. */
  const listBurst = (): void => {
    if (stopped || pulse !== null) return;
    pulse = setTimeout(() => {
      pulse = null;
      if (stopped) return;
      namesPass();
    }, 50);
  };
  /** One watch on the drop folder. An event that names a file parses that file at once. An event
   *  with no name lists the folder once, and the watch stays open. A watch that cannot start, or
   *  that later errors, does that same one listing and then arms again. */
  const armFolder = (): void => {
    if (stopped) return;
    for (const at of seatListingDirs(serving.dropDir)) {
      if (folders.has(at)) continue;
      if (at !== serving.dropDir && heldAt(at).kind !== 'folder') continue;
      armOne(at);
    }
  };
  const armOne = (at: string): void => {
    try {
      const watcher = watch(at, (_event, filename) => {
        if (stopped) return;
        const name = typeof filename === 'string' ? filename : '';
        if (name === '') {
          listBurst();
          return;
        }
        if (pulse !== null) {
          clearTimeout(pulse);
          pulse = null;
        }
        noteFile(name);
      });
      folders.set(at, watcher);
      watcher.on('error', () => {
        if (folders.get(at) === watcher) folders.delete(at);
        try {
          watcher.close();
        } catch {
          // The watch is already closed.
        }
        listBurst();
      });
    } catch {
      folders.delete(at);
    }
  };
  const every = (ms: number): void => {
    if (stopped) return;
    if (timer !== null) clearInterval(timer);
    timer = setInterval(tick, ms);
  };
  const namesEvery = (): void => {
    if (stopped) return;
    if (namesTimer !== null) clearInterval(namesTimer);
    namesTimer = setInterval(namesPass, CHANNEL_TICK_MS);
  };
  // The watch is open before the prime, so a file that lands during the listing is queued and
  // parsed once the prime finishes. The prime itself pushes nothing that was already there.
  armFolder();
  tick();
  const arrived = queued.splice(0);
  for (const name of arrived) noteFile(name);
  console.error('team mcp serve: channel primed');
  // Without a bus the folder watch pushes the file the event names as it lands. A names-only
  // listing on the short cadence parses only a name not seen before, so a drop the watcher did
  // not name is still delivered then. The whole folder, including mtime changes, is the slower pass.
  // With a bus, each `message.arrived` routed to this seat pushes its one record at once, and
  // the inbox is read whole only on the slow safety pass, for a sender that could not reach the bus.
  namesEvery();
  every(options.fallbackMs ?? CHANNEL_IDLE_MS);
  // rfc-event-comms E7b (R3.4): the one re-send scheduler (src/queue/resend.ts), run here for this
  // server's one seat, because only this process can write to the seat's session. It offers only
  // while the shared ownership rule gives the seat to this server (`channelOwnsSeat`: the seat's
  // resolved walk takes the channel, and this listener is the live level-3 channel server); the
  // watch offers otherwise. Each attempt is reserved durably and exclusively before it is
  // dispatched, so the watch and this server never dispatch one attempt twice. An offer retires
  // the record's channel attempt (any markers move into its history) and pushes the next numbered
  // copy.
  let resending = false;
  const ownsSeat = async (): Promise<boolean | 'given-up'> => {
    const team = serving.loadTeam();
    if (team === null) return false;
    const { permittedEventLegs } = await import('../commands/send.ts');
    const legs = permittedEventLegs({ dir: join(serving.root, '.agents'), root: serving.root, home: serving.home, session: serving.session, seat: serving.seat, team, now: () => new Date() });
    const declared = team.seats.find((one) => one.name === serving.seat);
    // The Claude adapter (§2.3): on an active root this server re-sends nothing of its own pushes.
    // Its push of each new arrival is the channel offer; an offer that stays unsettled for 90 s
    // makes the seat unproven, and the next attempt is the watch's pointer. The one exception is
    // an offer that never left: a send's channel leg that gave up before any push. That is
    // re-offered here on the channel, numbered, on the ordinary backoff (`givenUpOnly`).
    if (claudeAdapterRoot(declared?.cli ?? 'claude-code', serving.root, serving.home, declared?.webhook !== undefined)) return 'given-up';
    return channelOwnsSeat({ dropDir: serving.dropDir, root: serving.root, session: serving.session, seat: serving.seat, walkTakesChannel: legs.channel });
  };
  const redeliverPass = (): void => {
    if (halted() || resending) return;
    const keyNow = messageKeyState(serving.home);
    if (keyNow.kind !== 'key') return;
    resending = true;
    const base = { dropDir: serving.dropDir, context: { to: serving.seat, root: serving.root, session: serving.session, ...leadOf(serving) }, key: keyNow.key, agentsDir: join(serving.root, '.agents') };
    void (async () => {
      const owned = await ownsSeat();
      if (owned === false) return;
      const seat = owned === 'given-up' ? { ...base, admit: channelOfferStartedGivenUp } : base;
      if (resendCandidates(seat, Date.now()).length === 0) return;
      await resendPass(seat, Date.now(), async (name) => {
        const folder = seatFolderOf(serving.dropDir, name);
        if (!retireChannelAttempt(folder, name, Date.now())) return null;
        seen.delete(name);
        pushOne(name);
        return channelNotified(folder, name) ? 'channel' : null;
      }, 'channel');
    })().catch(() => undefined).finally(() => {
      resending = false;
    });
  };
  redeliverTimer = setInterval(redeliverPass, options.redeliverMs ?? CHANNEL_REDELIVER_MS);
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
    onDown: () => every(options.fallbackMs ?? CHANNEL_IDLE_MS),
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
  const dropDir = seatFolderOf(serving.dropDir, id);
  const looked = readSealedRecord(join(dropDir, id));
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
    dropDir: dropDir,
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
  // The Claude adapter §2.2: an ack carrying the offer of a channel copy this listener pushed
  // proves the channel reaches the session; any other ack settles and proves nothing.
  const offer = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).offer : undefined;
  if (serving.listenerKey !== undefined && offer !== undefined) proveOffer(dropDir, id, offer, serving.listenerKey, { root: serving.root, session: serving.session, seat: serving.seat, key: key.key });
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
    const unread = inQueueOrder(listUnread(
      serving.dropDir,
      { to: serving.seat, root: serving.root, session: serving.session, lead: serving.team.orchestrator },
      serving.home,
    ).filter((message) => !legacyDropAt(join(seatFolderOf(serving.dropDir, message.id), message.id))));
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
      if (read.served === 'already-served') {
        const key = messageKeyState(serving.home);
        if (key.kind === 'key') {
          const settled = settledReadOf(
            serving.dropDir,
            id,
            { to: serving.seat, root: serving.root, session: serving.session, lead: serving.team.orchestrator },
            key.key,
          );
          if (settled !== null) return toolText(alreadyReadSentence(id, settled.at, settled.readBy, serving.team.seats.map((one) => one.name)));
        }
      }
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
/** Why a placement failed: a state that cannot be read, a caller not placed yet (or a seat whose
 *  pane is not recorded yet), or a caller that is another seat or another launch's pane. */
export type PlacementMiss = 'unreadable' | 'unplaced' | 'no-pane' | 'another-pane' | 'other-seat';

export function placementOf(io: Io, stateDir: string, session: string, name: string): { ok: true } | { ok: false; why: string; kind: PlacementMiss } {
  let sessions: State['sessions'];
  try {
    sessions = readState(stateDir).sessions;
  } catch (error) {
    return { ok: false, kind: 'unreadable', why: `the team state cannot be read, so this server cannot prove its caller: ${(error as Error).message}` };
  }
  if (sessions[session] === undefined) {
    return { ok: false, kind: 'no-pane', why: `the team state records no session ${JSON.stringify(session)}, so this server cannot prove which seat started it` };
  }
  const seats = sessions[session]?.seats ?? {};
  const caller = callerOf(io, session, { seatAtPane: (pane) => seatAtPaneOf(seats, pane) });
  const verdict = callerVerdict(caller, name, { session, recordedPane: sessions[session]?.seats?.[name]?.pane });
  if (verdict.kind === 'ok') return { ok: true };
  // The caller is placed in the served session under this seat's name: the pane is what does not
  // match. A record with no pane proves no placement at all, and another pane is the seat
  // restarted elsewhere while this process lives.
  if (verdict.kind === 'no-pane') {
    return { ok: false, kind: 'no-pane', why: `the state records no pane for seat ${JSON.stringify(name)} in session ${JSON.stringify(session)}, so this server cannot prove the pane it was started on; a lead stops that seat and runs \`team up\`` };
  }
  if (verdict.kind === 'another-pane') {
    return { ok: false, kind: 'another-pane', why: `the state records pane ${verdict.recordedPane} for seat ${JSON.stringify(name)} in session ${JSON.stringify(session)}, not the pane this server runs in; a lead stops the team and starts it again` };
  }
  if (caller.kind === 'seat') {
    // A seat caller is refused for another name, or the same name placed in another session; the
    // sentence names the session when it is the difference, so the refusal is not read as a pane
    // fault.
    const placedIn = caller.session !== undefined && caller.session !== session ? ` in session ${JSON.stringify(caller.session)}` : '';
    return { ok: false, kind: 'other-seat', why: `this server serves seat ${JSON.stringify(name)} in session ${JSON.stringify(session)}, and this call is placed as seat ${JSON.stringify(caller.name)}${placedIn}` };
  }
  return { ok: false, kind: 'unplaced', why: `this server serves seat ${JSON.stringify(name)} and starts inside that seat's own process; this call is ${describeCaller(caller)}` };
}

/** How long `mcp serve` re-proves its caller's placement at start, and the pause between reads.
 *  A seat's CLI starts its MCP servers during boot, before herdr has detected an agent in the
 *  pane and before the launch's own naming step reaches it. The start reads again on this pace
 *  for this long, and past it only while the client stays connected (`proveWhileServing`);
 *  `alive()` re-proves with a single reading on every use and never waits. */
export const SERVE_PLACEMENT_WAIT_MS = 5000;
const SERVE_PLACEMENT_POLL_MS = 250;
/** How many times the start reads a team file it could not read before it answers the handshake
 *  (2 x 250 ms: a file caught mid-write, not a wait the handshake can feel). */
const TEAM_READ_RETRIES = 2;
/** Past the start bound, while the seat's own recorded pane still has no herdr name and the
 *  client is still connected, the placement is read again at this slower pace. */
export const SERVE_PLACEMENT_SLOW_POLL_MS = 2000;

/** The pane the state records for a seat, or undefined when the state cannot be read or records
 *  none; the start's wait is only for a pane this says the server runs in. */
function recordedPaneOf(stateDir: string, session: string, name: string): string | undefined {
  try {
    return readState(stateDir).sessions[session]?.seats?.[name]?.pane;
  } catch {
    return undefined;
  }
}

/** A scene's clock and sleep for the start placement wait. `now` is the clock. Production
 *  passes neither, and the wait uses `Date.now` and a real timeout. */
export type PlacementClock = {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Whether the seat's current launch is this server's own: the CLI pids the state records for the
 * seat's launch include one of this process's live ancestors. A launch records the CLI it
 * started, and a relaunch records a new one, so an earlier launch's server — or a replacement it
 * spawned that has left that CLI's tree — never matches a later launch. Null when the state
 * records no launched CLI for the seat (an older record, or one not written yet), or cannot be
 * read: nothing is proven either way.
 */
export function ownsCurrentLaunch(io: Pick<Io, 'callerSources'>, stateDir: string, session: string, name: string): boolean | null {
  let pids: readonly number[] | undefined;
  try {
    pids = readState(stateDir).sessions[session]?.seats?.[name]?.launched?.cli;
  } catch {
    return null;
  }
  if (pids === undefined || pids.length === 0) return null;
  const ancestors = callerAncestors(io);
  if (ancestors === null || ancestors.length === 0) return false;
  const live = new Set(ancestors.map((one) => one.pid));
  return pids.some((pid) => live.has(pid));
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
  deps: PlacementClock = {},
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

/** What `proveWhileServing` hands back: the placement proven, with the client's next line still
 *  owed to the serving loop, or the refusal the start answers with. */
/** One reading of what the start may do: serve (with what it proved), wait and read again, or
 *  refuse for good. */
export type StartReading<T = true> = { ok: true; value: T } | {
  ok: false;
  wait: boolean;
  why: string;
  /** A wait that ends with this refusal once the start has waited this long (from the first
   *  reading). Absent: the wait lasts while the client stays connected. Once a reading carries
   *  a bound, the start keeps that deadline through every later waiting refusal. */
  waitBoundMs?: number;
  /** The restored-pane window's lineage proof: once a reading carries it, the start re-reads it
   *  before it binds, and a miss (null is proven) refuses instead of binding. */
  lineage?: () => string | null;
};

/** How long a server under herdr waits for a placement it cannot place yet when its process
 *  carries no pane variable. After a machine restart
 *  herdr restores a lead's Claude pane and resumes the conversation itself: the CLI starts its
 *  MCP servers before herdr has detected an agent in the pane, the restored process can carry no
 *  pane variable, and the record may still name the pane from before the restart until the
 *  restore re-ties it. Claude Code never starts a stdio server again once it has closed, so a
 *  refusal there left the seat's team-inbox failed until a manual /mcp reconnect (jedi, vlist and
 *  material, 2026-11-16, both restarts; the agent was named about two minutes later). The wait
 *  serves nothing meanwhile — every tool call refuses with the reason — and the proof is the same
 *  placement as before: only the time it is waited for changes. */
export const SERVE_RESTORED_PLACEMENT_WAIT_MS = 10 * 60_000;
/** Past the first minute of a bounded wait, the placement is read at this pace. */
export const SERVE_PLACEMENT_BACKOFF_POLL_MS = 5000;

/**
 * Why this server is not the restored seat CLI's own child in the pane the seat's record names,
 * or null when it is. The pids decide, never a variable: herdr is among the ancestors; the
 * server's direct parent is a live process named as the seat CLI's profile names it; that CLI is
 * one of the recorded pane's foreground processes; herdr's root for the pane is above it; and,
 * when herdr reports the pane's conversation and the record holds one, the two are the same. A
 * sibling or background job under the pane's shell, a process in another pane and a caller
 * outside herdr all fail it. Read when the restored-pane wait opens and again before it binds.
 * The parent is read live (`readAncestors` re-checks the parent pid), so a reused pid of an
 * exited CLI is not this server's parent.
 */
export function restoredLineageMiss(
  io: Io,
  stateDir: string,
  session: string,
  name: string,
  recorded: string,
  cliNames: readonly string[],
): string | null {
  const sources = io.callerSources?.(session);
  const ancestors = sources ? sources.ancestors() : callerAncestors(io);
  if (ancestors === null || ancestors.length === 0) return 'its parent processes cannot be read';
  if (!ancestors.some((one) => one.name === 'herdr')) return 'it does not run under herdr';
  const parent = ancestors[0]!;
  if (cliNames.length === 0 || !cliNames.includes(parent.name)) {
    return `its parent process is not the seat's CLI (${cliNames.join(', ') || 'the CLI names no process'})`;
  }
  const root = sources ? sources.paneRootPid(recorded) : paneRootPid(recorded, session);
  if (root === null || !ancestors.slice(1).some((one) => one.pid === root)) return `its CLI does not run in pane ${recorded}`;
  const processes = sources ? (sources.paneProcesses?.(recorded) ?? null) : paneProcesses(recorded, session);
  if (processes === null || !processes.foreground.includes(parent.pid)) {
    return `its CLI is not the foreground process of pane ${recorded}`;
  }
  let recordedConversation: string | undefined;
  try {
    recordedConversation = readState(stateDir).sessions[session]?.seats?.[name]?.agent_session;
  } catch {
    return 'the team state cannot be read';
  }
  if (recordedConversation !== undefined && recordedConversation !== '') {
    const agents = sources ? sources.agents() : agentList(session);
    const live = agents ? agents.find((one) => one.pane === recorded)?.session : undefined;
    if (live !== undefined && live !== recordedConversation) return `pane ${recorded} runs another conversation than the seat's record`;
  }
  return null;
}

/**
 * The placement alone, as a start reading. A state that cannot be read yet is waited for. A
 * caller herdr has not named yet, or a seat whose pane the state does not record yet (a restart
 * rewriting it), is waited for only from inside a herdr pane that is the seat's recorded one or
 * while none is recorded. A caller placed as another seat, in another launch's pane, or outside
 * herdr is foreign and refused.
 */
export function placementReading(
  io: Io,
  stateDir: string,
  session: string,
  name: string,
  /** The seat CLI's process names; without them the restored-pane window never opens. */
  cliNames: readonly string[] = [],
): StartReading {
  const verdict = placementOf(io, stateDir, session, name);
  if (verdict.ok) return { ok: true, value: true };
  if (verdict.kind === 'unreadable') return { ok: false, wait: true, why: verdict.why };
  if (verdict.kind === 'other-seat' || verdict.kind === 'another-pane') return { ok: false, wait: false, why: verdict.why };
  const pane = io.env.HERDR_PANE_ID;
  const recorded = recordedPaneOf(stateDir, session, name);
  const wait = pane !== undefined && pane !== '' && (recorded === undefined || recorded === pane);
  if (wait) return { ok: false, wait, why: verdict.why };
  // A caller herdr has not named, with no pane variable, whose process runs in the pane the seat's
  // record names (herdr's root for that pane is its ancestor): the restored-pane window (the state
  // named the same pane both times, so only a missing variable explains the refusal there). It is
  // waited for, bounded, and proven by the same placement. A variable that names another pane than
  // the record's, a process in another pane, and a caller outside herdr are refused at once.
  if ((pane === undefined || pane === '') && recorded !== undefined
    && restoredLineageMiss(io, stateDir, session, name, recorded, cliNames) === null) {
    return {
      ok: false, wait: true, why: verdict.why, waitBoundMs: SERVE_RESTORED_PLACEMENT_WAIT_MS,
      lineage: () => restoredLineageMiss(io, stateDir, session, name, recorded, cliNames),
    };
  }
  return { ok: false, wait: false, why: verdict.why };
}

type ServingProof<T = true> =
  | {
    ok: true;
    /** What the admission proved. */
    value: T;
    /** The first line the serving loop reads: one that already arrived, the read still
     *  outstanding, or a new read. Nothing is asked of the input until it is called. */
    first: () => Promise<IteratorResult<string>>;
    /** How long the placement took to prove, from the first reading. */
    waitedMs: number;
  }
  | { ok: false; why: string };

/**
 * The start placement, read while the client is served. A seat's CLI starts its MCP servers
 * during boot, and after a machine restart herdr can restore the pane before it names the agent
 * in it: the placement then cannot be proven for longer than the client waits for its handshake,
 * and a server that refused there was never started again for the whole session.
 *
 * The first reading is taken before any line is served, and its refusal rules are
 * `placementAtStart`'s: a refusal is answered at once, with nothing served, unless the
 * environment names the pane the seat's record holds. In that one case the lines that arrive are
 * answered by `pending` — a serving whose every tool call refuses with the reason, and which
 * opens no inbox, writes no receipt and pushes nothing — while the placement is read again
 * (every 250 ms for the first 5 s, then every 2 s) for as long as the client stays connected, so
 * the inbox opens as soon as herdr names the pane. A wait whose record stops naming that pane
 * ends at once, and so does one whose client has gone; the last refusal is returned.
 */
export async function proveWhileServing<T = true>(input: {
  /** One reading of the start's admission: proven, worth waiting for, or refused. Absent: the
   *  placement of `name` alone, read from `io` and `stateDir`. */
  check?: () => StartReading<T>;
  io: Io;
  stateDir: string;
  session: string;
  name: string;
  lines: AsyncIterator<string>;
  write: (line: string) => void;
  /** Answers the lines that arrive before the placement is proven. */
  pending: (line: string) => string | null;
  /** Told the latest refusal, so the pending serving can say why it serves nothing yet. */
  onRefusal?: (why: string) => void;
  deps?: PlacementClock;
}): Promise<ServingProof<T>> {
  const deps = input.deps ?? {};
  // The poll timer is cleared when the wait ends, so a process whose client has gone ends at once
  // instead of waiting it out.
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { pollTimer = setTimeout(resolve, ms); }));
  const clearPoll = (): void => {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  };
  const now = deps.now ?? Date.now;
  // No line is asked for until the first refusal is one this wait may serve through: a refused
  // start leaves the input exactly as it found it. One read is outstanding at a time, and it is
  // observed by exactly one handler, which wakes the current wait: a quiet client and a long wait
  // attach nothing more per reading.
  let next: Promise<IteratorResult<string>> | null = null;
  let arrived: { result: IteratorResult<string> } | { error: unknown } | null = null;
  let wake: (() => void) | null = null;
  const ask = (): void => {
    const read = input.lines.next();
    next = read;
    read.then(
      (result) => {
        arrived = { result };
        wake?.();
      },
      (error: unknown) => {
        arrived = { error };
        wake?.();
      },
    );
  };
  let ended = false;
  /** Answers the lines that arrive until `tick` settles, or until the input ends. */
  const serveUntil = async (tick: Promise<void>): Promise<void> => {
    let ticked = false;
    let active = true;
    // A tick from a wait that has already returned wakes nothing.
    void tick.then(() => {
      ticked = true;
      if (active) wake?.();
    });
    if (next === null) ask();
    try {
      await answerUntilTick(() => ticked);
    } finally {
      active = false;
    }
  };
  /** The loop of one wait: answer each line that arrives, until the tick or the input's end. */
  const answerUntilTick = async (tickedNow: () => boolean): Promise<void> => {
    for (;;) {
      if (ended) return;
      if (arrived === null && !tickedNow()) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
      const got = arrived as { result: IteratorResult<string> } | { error: unknown } | null;
      if (got === null) {
        if (tickedNow()) return;
        continue;
      }
      arrived = null;
      if ('error' in got) throw got.error;
      if (got.result.done === true) {
        ended = true;
        continue;
      }
      const reply = input.pending(got.result.value);
      if (reply !== null) input.write(reply);
      ask();
    }
  };
  const check = input.check ?? ((): StartReading<T> => placementReading(input.io, input.stateDir, input.session, input.name) as StartReading<T>);
  try {
    return await readUntilProven(check);
  } finally {
    clearPoll();
  }
  async function readUntilProven(check: () => StartReading<T>): Promise<ServingProof<T>> {
  const start = now();
  // The restored-pane window, once entered, holds for the rest of the start: its deadline ends
  // every later wait whatever the refusal becomes, and its lineage is proven again at the bind.
  let deadline: number | null = null;
  let lineage: (() => string | null) | null = null;
  for (;;) {
    const verdict = check();
    if (verdict.ok && lineage !== null) {
      const miss = lineage();
      if (miss !== null) {
        const why = `this server waited as the restored seat's own CLI child and is no longer proven as one: ${miss}`;
        input.onRefusal?.(why);
        return { ok: false, why };
      }
    }
    if (verdict.ok) {
      // A line that already arrived is handed on as it came; otherwise the outstanding read, which
      // its one handler already observes; otherwise a read started only when the loop asks.
      const held = arrived as { result: IteratorResult<string> } | { error: unknown } | null;
      const outstanding = next as Promise<IteratorResult<string>> | null;
      const first = held !== null
        ? () => ('error' in held ? Promise.reject(held.error) : Promise.resolve(held.result))
        : outstanding !== null
          ? () => outstanding
          : () => input.lines.next();
      return { ok: true, first, waitedMs: now() - start, value: verdict.value };
    }
    input.onRefusal?.(verdict.why);
    if (!verdict.wait) return { ok: false, why: verdict.why };
    // A client that has gone is waited for by no one: the last refusal is returned at once.
    if (ended) return { ok: false, why: verdict.why };
    const elapsed = now() - start;
    if (verdict.waitBoundMs !== undefined && deadline === null) deadline = start + verdict.waitBoundMs;
    if (verdict.lineage !== undefined && lineage === null) lineage = verdict.lineage;
    if (deadline !== null && now() >= deadline) return { ok: false, why: verdict.why };
    const pace = elapsed < SERVE_PLACEMENT_WAIT_MS
      ? SERVE_PLACEMENT_POLL_MS
      : deadline !== null && elapsed >= 60_000 ? SERVE_PLACEMENT_BACKOFF_POLL_MS : SERVE_PLACEMENT_SLOW_POLL_MS;
    await serveUntil(sleep(pace));
  }
  }
}

/** The launch the seat's state names now: the current brief claim's epoch, a claim that holds no
 *  launch epoch, no claim, or a state this server cannot read. */
type Generation =
  | { kind: 'claim'; epoch: string; at: string }
  | { kind: 'unbound' }
  | { kind: 'none' }
  | { kind: 'unreadable'; message: string };

function generationOf(stateDir: string, session: string, name: string): Generation {
  try {
    const raw = readState(stateDir).sessions[session]?.briefs?.[name];
    const claim = currentBriefClaim(raw);
    if (claim !== null) return { kind: 'claim', epoch: claim.epoch, at: claim.at };
    // An older build, or a CLI change, can leave a claim with an id and a time and no launch
    // epoch. It is not a current claim, and it is not the absence of one.
    return raw === undefined ? { kind: 'none' } : { kind: 'unbound' };
  } catch (error) {
    return { kind: 'unreadable', message: (error as Error).message };
  }
}

/** Why a server bound to `epoch` no longer belongs to the seat's launch, or null while it does.
 *  A claim with no launch epoch is served: the seat still gets its inbox. A server that bound
 *  no epoch serves only while the seat has no current claim: the claim a relaunch writes makes
 *  every earlier server stop serving that seat's inbox. */
function staleLaunch(generation: Generation, epoch: string | undefined, name: string): string | null {
  if (generation.kind === 'unreadable') {
    return `the team state cannot be read, so this server cannot prove the launch it belongs to: ${generation.message}`;
  }
  if (generation.kind === 'unbound') return null;
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
  deps: PlacementClock = {},
): Promise<number> {
  const refuse = (message: string): number => {
    io.stderr(`team mcp serve: ${message}\n`);
    // The input is closed with every refusal: a reader left open on stdin keeps the process
    // alive, and the client then waits out its whole handshake timeout instead of seeing it end.
    streams.close?.();
    // exit: mcp.serve-refused
    return 2;
  };
  if (options.seat === undefined || options.seat === '') return refuse('--seat <seat> is required');
  if (options.epoch !== undefined && !isBriefEpoch(options.epoch)) {
    return refuse(`--epoch ${JSON.stringify(options.epoch)} is not a runtime epoch`);
  }
  const seatName = options.seat;
  const replacement = io.env[SERVE_REPLACEMENT_ENV] === '1';
  // The input's reader is taken before the first wait: a reader whose input ended while nothing
  // was iterating it would never report that end.
  const lines = streams.lines[Symbol.asyncIterator]();
  // A named file is the launch's own team file, read as given. Without one the team is the
  // registry's record for this seat: the folder the server starts in is a lobby for most seats,
  // and reading a team file from it would be reading the checkout's folder, not the seat's team.
  let registeredAt: string | null = null;
  const readTeam = (): LoadResult => readTeamConfig(registeredAt ?? io.cwd, {
    ...(options.file === undefined ? {} : { file: options.file }),
    home: host.home,
  });
  type Admitted = {
    loaded: Extract<LoadResult, { ok: true }>;
    team: TeamFile;
    seat: TeamFile['seats'][number];
    stateDir: string;
    boundEpoch: string | undefined;
  };
  /**
   * One reading of everything the start must prove, before the inbox is opened. Claude Code
   * does not start a stdio server again once it has left or timed out, so only a refusal that
   * no later reading can change ends the process: a seat this team does not declare, a session
   * that is not the team's, a stopped declaration, or a caller another launch's pane or no
   * herdr pane at all places. Everything else — an unreadable team file, registry or state, an
   * unnamed pane, a claim not written yet, an `--epoch` the launch line carried from an earlier
   * launch — is waited for while the client is answered.
   *
   * The launch this server serves is the seat's current claim when the launch line names it, or
   * when that claim was written before this process started (or within the start bound after
   * it): a process started after a claim is that launch's own, whatever epoch a registration
   * file left behind. A claim written later than that is a later launch's, and is never adopted.
   */
  const admit = (): StartReading<Admitted> => {
    if (options.file === undefined) {
      const registered = registeredRoot(host.home, seatName, options.session);
      if (!registered.ok) return { ok: false, wait: true, why: registered.message };
      registeredAt = registered.root;
    }
    const loaded = readTeam();
    if (!loaded.ok) return { ok: false, wait: true, why: loaded.errors[0]?.message ?? 'the team file could not be read' };
    const team = loaded.team;
    const session = options.session ?? team.session;
    if (session !== team.session) {
      return { ok: false, wait: false, why: `the team's session is ${JSON.stringify(team.session)}, not ${JSON.stringify(session)}` };
    }
    const seat = team.seats.find((one) => one.name === seatName);
    if (seat === undefined) return { ok: false, wait: false, why: `the team file declares no seat ${JSON.stringify(seatName)}` };
    // A seat the file marks stopped is not one this server may serve, whatever its launch does:
    // `team remove <seat> --keep` leaves the entry and its pane, and only the file's word says the
    // seat is out of the team.
    const stoppedNow = declarationRefusal(team, team.session, seat.name);
    if (stoppedNow !== null) return { ok: false, wait: false, why: stoppedNow };
    const stateDir = dirname(loaded.path);
    const placed = placementReading(io, stateDir, team.session, seat.name, profileFor(seat.cli)?.processNames ?? []);
    if (!placed.ok) return placed;
    const generation = generationOf(stateDir, team.session, seat.name);
    if (generation.kind === 'unreadable') {
      return { ok: false, wait: true, why: `the team state cannot be read, so this server cannot prove the launch it belongs to: ${generation.message}` };
    }
    if (generation.kind === 'unbound') return { ok: true, value: { loaded, team, seat, stateDir, boundEpoch: undefined } };
    if (generation.kind === 'none') {
      if (options.epoch === undefined) return { ok: true, value: { loaded, team, seat, stateDir, boundEpoch: undefined } };
      return { ok: false, wait: true, why: `--epoch ${JSON.stringify(options.epoch)} names a launch the seat's state no longer holds` };
    }
    if (options.epoch === generation.epoch) return { ok: true, value: { loaded, team, seat, stateDir, boundEpoch: generation.epoch } };
    // An epoch from an earlier launch, or none, binds the current claim only when that launch is
    // proven to be this server's own. A state that records no launched CLI proves nothing: a
    // server with no epoch keeps the binding it always had, and a stale epoch waits.
    // A replacement this server's own install restart started serves only the launch its parent
    // was bound to: its ancestry still holds the earlier launch's CLI, which proves nothing about
    // a later claim.
    const owns = replacement ? false : ownsCurrentLaunch(io, stateDir, team.session, seat.name);
    if (owns === true || (owns === null && options.epoch === undefined)) {
      return { ok: true, value: { loaded, team, seat, stateDir, boundEpoch: generation.epoch } };
    }
    return {
      ok: false,
      wait: true,
      why: options.epoch === undefined
        ? `seat ${JSON.stringify(seat.name)} has a current brief claim of a launch this server is not part of; it serves only its own launch`
        : `--epoch ${JSON.stringify(options.epoch)} is not the seat's current launch epoch, and this server is not part of the current launch`,
    };
  };
  // Before the start is proven, the handshake and the tool list are answered and every tool
  // call refuses with the reason: nothing reads the inbox, writes a receipt or pushes. The
  // channel capability is the declaration's word when the team file can be read at once.
  const readOnce = (): LoadResult => {
    if (options.file === undefined) {
      const registered = registeredRoot(host.home, seatName, options.session);
      if (registered.ok) registeredAt = registered.root;
    }
    return readTeam();
  };
  // The handshake declares the channel capability, and nothing renegotiates it later, so the
  // declaration's word is read before the first line is answered. A team file caught mid-write
  // is read again for a short bound; past it the handshake declares no channel.
  let firstRead = readOnce();
  const firstSleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let tries = 0; !firstRead.ok && tries < TEAM_READ_RETRIES; tries += 1) {
    await firstSleep(SERVE_PLACEMENT_POLL_MS);
    firstRead = readOnce();
  }
  const declaredFirst = firstRead.ok ? firstRead.team.seats.find((one) => one.name === seatName) : undefined;
  const pendingChannel = declaredFirst === undefined ? false : channelLaunchEnabled(declaredFirst.launch);
  let unplacedWhy = 'the start has not been read yet';
  const pendingTeam: TeamFile | null = firstRead.ok ? firstRead.team : null;
  const pending: Serving = {
    project: pendingTeam?.project ?? '',
    seat: seatName,
    session: pendingTeam?.session ?? options.session ?? '',
    root: firstRead.ok ? firstRead.root : io.cwd,
    dropDir: '',
    home: host.home,
    team: (pendingTeam ?? { seats: [] }) as TeamFile,
    loadTeam: () => null,
    channel: pendingChannel,
    alive: () => `this server has not proven its seat and launch yet, so it serves no inbox: ${unplacedWhy}`,
  };
  const placed = await proveWhileServing<Admitted>({
    check: admit,
    io,
    stateDir: '',
    session: '',
    name: seatName,
    lines,
    write: streams.write,
    pending: (line) => handleLine(line, pending),
    onRefusal: (why) => {
      unplacedWhy = why;
    },
    deps,
  });
  if (!placed.ok) return refuse(placed.why);
  const { loaded, team, seat, stateDir } = placed.value;
  // Mutable for one case only: a server bound to no claim takes the first claim of a launch
  // proven to be its own (see `alive` below).
  let boundEpoch = placed.value.boundEpoch;
  // The channel is the seat's own launch word: a line with the development-channels flag naming
  // this server. Nothing on the command line turns it on separately, and a marker without it is
  // an ordinary inbox the send walks past.
  // A channel the handshake did not declare is never started: the client was told of none.
  const channel = pendingChannel && channelLaunchEnabled(seat.launch);
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
    ...(build.head === null ? {} : { head: build.head }),
    ...(channel ? { channel: true as const } : {}),
    ...(boundEpoch === undefined ? {} : { epoch: boundEpoch }),
    level: ACTOR_LEVEL,
  };
  // A server keeps the code it started with, and an install neither reloads it nor ends it. The
  // installed identity is read from disk while this one serves: when it differs from the identity
  // in this process, the channel stops pushing and the process is replaced by one started from
  // the installed entry. A pinned build with no installed source is its own install, so a scene
  // that states a build never reloads unless it says how.
  const installedNow = host.installed ?? (host.build === undefined ? installIdentity : () => installIdentityOf(host.build as BuildIdentity));
  const restart = host.restart ?? (() => restartSelf(boundEpoch === undefined ? {} : { epoch: boundEpoch }));
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
  // The launch's own brief is served under the claim its state holds. The epoch is the one this
  // process bound at start: the registration's, or the current claim's when the launch line named
  // none. A server that bound none serves nothing of a claim a later relaunch writes, until the
  // seat is launched again.
  const claimOf = () => {
    try {
      return currentBriefClaim(readState(stateDir).sessions[team.session]?.briefs?.[seat.name]);
    } catch {
      return null;
    }
  };
  const brief: BriefRead = { claim: claimOf, ...(boundEpoch === undefined ? {} : { epoch: boundEpoch }) };
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
    ...(host.channelMark === undefined ? {} : { channelMark: host.channelMark }),
    ...(channel ? { listenerKey: listenerKeyOf(listener) } : {}),
    // Re-proved on every use, not only at start: the seat may be stopped, replaced or relaunched
    // while this process lives, and a launcher-written config that names it again must not make
    // the old process a reader of the new seat. The team file itself is read again: the
    // declaration this server serves is the file's current one, and a seat it has stopped or
    // dropped is no longer a seat this server may serve.
    alive: () => {
      const now = placementOf(io, stateDir, team.session, seat.name);
      if (!now.ok) return now.why;
      const generationNow = generationOf(stateDir, team.session, seat.name);
      // A server that bound no claim (it started before its launch wrote one) takes its own
      // launch's first claim, once that launch is proven to be its own; any other claim stays a
      // refusal, and a binding once taken is kept for the life of the process.
      if (boundEpoch === undefined && generationNow.kind === 'claim' && !replacement
        && ownsCurrentLaunch(io, stateDir, team.session, seat.name) === true) {
        boundEpoch = generationNow.epoch;
        brief.epoch = generationNow.epoch;
        writeListener(dropDir, { ...listener, epoch: generationNow.epoch });
      }
      const staleLaunchNow = staleLaunch(generationNow, boundEpoch, seat.name);
      if (staleLaunchNow !== null) return staleLaunchNow;
      const file = readTeam();
      if (!file.ok) {
        return `the team file cannot be read now, so this server cannot prove its seat is still declared: ${file.errors[0]?.message ?? 'the team file could not be read'}`;
      }
      return declarationRefusal(file.team, team.session, seat.name);
    },
  };
  const stopChannel = channel
    ? watchChannel(serving, streams.write, notice, {
      ...(options.fallbackMs === undefined ? {} : { fallbackMs: options.fallbackMs }),
      ...(options.redeliverMs === undefined ? {} : { redeliverMs: options.redeliverMs }),
    })
    : null;
  // The listener is published after the folder watch is armed, so a drop written when the
  // listener appears is a named event and is pushed at once. It does not land during the prime
  // and wait out the idle pass.
  if (!writeListener(dropDir, listener)) {
    stopChannel?.();
    return refuse('the inbox listener marker could not be written');
  }
  try {
    // The line the placement wait left owed is the first one served here.
    let next = placed.first();
    for (;;) {
      const result = await next;
      if (result.done === true) break;
      const reply = handleLine(result.value, serving);
      if (reply !== null) streams.write(reply);
      // The call just answered ran this build's code; the next one runs the installed build's.
      if (notice()) break;
      next = lines.next();
    }
  } finally {
    stopChannel?.();
    try {
      lines.return?.()?.catch(() => {
        // The input is closed below either way.
      });
    } catch {
      // The input is closed below either way.
    }
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
