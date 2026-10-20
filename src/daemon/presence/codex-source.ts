// The Codex presence source: one live WebSocket JSON-RPC connection to the app-server control
// socket, stream-first. It is the only presence transport for Codex seats; the daemon host owns
// starting, the step cadence, per-seat health and shutdown order.
//
// What was measured on this machine (codex-cli 0.161.0, running app-server 0.163.0) rather than
// recalled:
// - the WebSocket upgrade `GET /rpc`, the masked client frames and the unmasked server frames are
//   the transport already implemented by the repo's thread/read probe in
//   `src/send/push-adapters/codex-relay.ts`;
// - one scratch TUI turn on the shared daemon, with a second client that wrote exactly
//   `initialize` and `initialized`, received the bound thread's `thread/started`,
//   `thread/status/changed` `{type:'active', activeFlags:[]}` and `{type:'idle'}`, and
//   `thread/name/updated`. The bound thread id was named by every one of them. The same client
//   also received another thread's lifecycle frames, so delivery is broadcast and the exact
//   thread filter is mandatory.
// - `turn/started`, `turn/completed` and the waiting flags never appeared in that passive
//   capture; the probe never exercised a wait, so waiting-flag passive delivery is UNTESTED, not
//   shown to fail. They stay mapped if received, and never count as coverage.
//
// Consequently the source never polls. After a connect/reconnect it performs one read-only
// `thread/read` baseline and then trusts the stream: a quiet stream is healthy without an
// evidence-age expiry, and only a transport loss or the managed binding changing makes it
// unproven. A reconnect baseline requalifies current state; the gap stays explicit and missing
// transitions are never invented.
//
// Ordering assumption for the baseline race: responses and notifications on one socket are
// processed in receipt order, but a notification received after `thread/read` was written may
// describe a newer state than the snapshot the response carries. The source therefore counts
// applied bound-thread transitions; if any arrived after the read was sent, the baseline response
// only proves attachment and does NOT overwrite the newer stream state. This is deliberately
// conservative: a stale idle snapshot can never flip a working seat back to idle.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { resolveCodexDaemonPolicy, type CodexDaemonResolution } from '../../policy/codex-daemon.ts';
import { findAgent } from '../../registry/agents.ts';
import { recordedSeatSession } from '../../registry/resume.ts';
import { teamIdOf } from '../../registry/teams.ts';
import { readState } from '../../state.ts';
import {
  isPresenceBinding,
  type PresenceEvent,
} from './contract.ts';
import {
  presenceFromCodexNotification,
  stageCodexPresence,
  type CodexPresenceOutcome,
} from './codex-app-server.ts';
import { presencePaths, stagePresenceRecord } from './spool.ts';

export const CODEX_CONNECT_TIMEOUT_MS = 2_000;
export const CODEX_RETRY_MS = 5_000;

const MAX_SERVER_FRAME_BYTES = 1024 * 1024;
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const THREAD_TOKEN = /^\S+$/;

/** The seat's bound Codex thread and where its presence records live. */
export type CodexPresenceTarget = {
  /** The team file's folder (today `.agents`), never the checkout root. */
  stateDir: string;
  session: string;
  seat: string;
  /** The seat state's `presence_binding` at connect: `prs_<12 lowercase hex>`, compared whole. */
  binding: string;
  /** The thread the seat's managed session recorded; every applied frame must name it. */
  threadId: string;
  /** An explicit `unix:///abs/path.sock`; no `$CODEX_HOME` guess and no discovery. */
  endpoint: string;
};

export type CodexPresenceReason =
  | 'initializing'
  | 'baseline-failed'
  | 'transport-disconnected'
  | 'transport-error'
  | 'initialize-failed'
  | 'thread-read-failed'
  | 'thread-not-loaded'
  | 'system-error'
  | 'thread-closed'
  | 'binding-changed'
  | 'source-stopped';

export type CodexPresenceChannel = 'connecting' | 'connected' | 'unknown' | 'gone' | 'stopped';

/** Passive delivery measured for thread status changes only; the rest is untested, not failed. */
export type CodexPresenceCoverage = {
  statusChanged: 'measured';
  turnFrames: 'unproven';
  waitingFlags: 'unproven';
};

export type CodexPresenceSourceState = {
  seat: string;
  binding: string;
  threadId: string;
  channel: CodexPresenceChannel;
  reason: CodexPresenceReason | null;
  /** The WebSocket upgraded, initialize was answered and `initialized` was sent. */
  stream: 'uninitialized' | 'initialized' | 'lost';
  /** The connect/reconnect `thread/read`; never a periodic refresh. */
  baseline: 'pending' | 'read' | 'failed';
  /** The actual receipt instant of the last validated bound-thread observation. */
  evidenceAt: string | null;
  /** Alias of `evidenceAt` for the host adapter that already sampled that name. */
  lastRefreshAt: string | null;
  /** A transport loss after a successful baseline: transitions in that window are missing. */
  gap: boolean;
  events: number;
  ignored: number;
  otherThread: number;
  coverage: CodexPresenceCoverage;
};

export type CodexPresenceSource = {
  /** The seat this source speaks for, for a host that holds sources per seat. */
  readonly seat: string;
  /** Connect or reconnect when due; one socket, never a parallel attempt. */
  step(at: Date): Promise<CodexPresenceSourceState>;
  /** Read-only answer; never connects and never writes. */
  status(at: Date): CodexPresenceSourceState;
  /** Alias of `status`. */
  state(at: Date): CodexPresenceSourceState;
  /** Stops admissions synchronously, then resolves; idempotent. */
  close(): Promise<{ quiesced: true }>;
  /** Alias of `close`. */
  cancel(): Promise<{ quiesced: true }>;
};

export type CodexStartResult =
  | { kind: 'subscribed'; source: CodexPresenceSource }
  | { kind: 'refused'; why: string };

const COVERAGE: CodexPresenceCoverage = Object.freeze({
  statusChanged: 'measured',
  turnFrames: 'unproven',
  waitingFlags: 'unproven',
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isThreadToken = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && !value.startsWith('-') && THREAD_TOKEN.test(value);

/** `unix:///abs/path.sock` only; every other endpoint form is refused before any socket. */
export function codexSocketPath(endpoint: string): string | null {
  if (!endpoint.startsWith('unix://')) return null;
  const path = endpoint.slice('unix://'.length);
  if (!path.startsWith('/') || path.includes('\0')) return null;
  return path;
}

function generatedStatus(value: unknown): boolean {
  if (!isObject(value) || typeof value.type !== 'string') return false;
  if (value.type === 'notLoaded' || value.type === 'idle' || value.type === 'systemError') return true;
  if (value.type !== 'active') return false;
  const flags = value.activeFlags;
  return Array.isArray(flags) && flags.every((flag) => typeof flag === 'string');
}

function encodeMaskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask, masked]);
}

type Wire = {
  write(text: string): void;
  destroy(): void;
};

type WireHandlers = {
  onUpgrade(): void;
  onText(text: string): void;
  onLoss(reason: 'transport-disconnected' | 'transport-error'): void;
};

/** The measured upgrade and frame codec, shared with the repo's thread/read probe. It answers
 *  pings and reports a close or a protocol error once; the source owns every JSON-RPC word. */
function connectWire(socketPath: string, handlers: WireHandlers): Wire {
  const socket = createConnection({ path: socketPath });
  const secKey = randomBytes(16).toString('base64');
  const expectedAccept = createHash('sha1')
    .update(`${secKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  let buffer: Buffer = Buffer.alloc(0);
  let upgraded = false;
  let lost = false;

  const lose = (reason: 'transport-disconnected' | 'transport-error'): void => {
    if (lost) return;
    lost = true;
    socket.destroy();
    handlers.onLoss(reason);
  };

  socket.on('connect', () => {
    socket.write(
      [
        'GET /rpc HTTP/1.1',
        'Host: localhost',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${secKey}`,
        '',
        '',
      ].join('\r\n'),
    );
  });
  socket.on('error', () => lose('transport-error'));
  socket.on('close', () => lose('transport-disconnected'));
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buffer.length > MAX_HANDSHAKE_BYTES) lose('transport-error');
        return;
      }
      const headerText = buffer.subarray(0, headerEnd).toString('utf8');
      buffer = buffer.subarray(headerEnd + 4);
      const accept = /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(headerText)?.[1];
      if (!/^HTTP\/1\.1 101\b/i.test(headerText) || accept !== expectedAccept) {
        lose('transport-error');
        return;
      }
      upgraded = true;
      handlers.onUpgrade();
    }
    let offset = 0;
    while (offset + 2 <= buffer.length) {
      const first = buffer[offset]!;
      const second = buffer[offset + 1]!;
      if ((second & 0x80) !== 0) {
        lose('transport-error');
        return;
      }
      const opcode = first & 0x0f;
      let payloadLen = second & 0x7f;
      let headerLen = 2;
      if (payloadLen === 126) {
        if (offset + 4 > buffer.length) break;
        payloadLen = buffer.readUInt16BE(offset + 2);
        headerLen = 4;
      } else if (payloadLen === 127) {
        if (offset + 10 > buffer.length) break;
        const bigLen = buffer.readBigUInt64BE(offset + 2);
        if (bigLen > BigInt(MAX_SERVER_FRAME_BYTES)) {
          lose('transport-error');
          return;
        }
        payloadLen = Number(bigLen);
        headerLen = 10;
      }
      if (payloadLen > MAX_SERVER_FRAME_BYTES) {
        lose('transport-error');
        return;
      }
      if (offset + headerLen + payloadLen > buffer.length) break;
      const payload = buffer.subarray(offset + headerLen, offset + headerLen + payloadLen);
      offset += headerLen + payloadLen;
      if (opcode === 0x1) {
        handlers.onText(payload.toString('utf8'));
      } else if (opcode === 0x9) {
        socket.write(encodeMaskedFrame(0xa, payload));
      } else if (opcode === 0x8) {
        lose('transport-disconnected');
        return;
      }
    }
    buffer = buffer.subarray(offset);
  });

  return {
    write(text: string): void {
      if (!socket.destroyed) socket.write(encodeMaskedFrame(0x1, Buffer.from(text, 'utf8')));
    },
    destroy(): void {
      lost = true;
      socket.destroy();
    },
  };
}

type Internals = {
  target: CodexPresenceTarget;
  stateDir: string;
  socketPath: string;
  sink: (notification: unknown) => CodexPresenceOutcome;
  now: () => Date;
  connectTimeoutMs: number;
  retryMs: number;

  wired: Wire | null;
  generation: number;
  attempt: Promise<CodexPresenceSourceState> | null;
  phase: 'idle' | 'connecting' | 'streaming' | 'lost' | 'terminal';
  nextAttemptAt: number;
  closed: boolean;
  admissions: boolean;

  upgraded: boolean;
  initializedSent: boolean;
  readOutstanding: boolean;
  readSeq: number;
  streamSeq: number;
  hadBaseline: boolean;
  lastApplied: PresenceEvent | null;
  timer: ReturnType<typeof setTimeout> | null;
  settle: (() => void) | null;

  state: CodexPresenceSourceState;
};

const ACTIVE = new Set<string>();

function snapshotOf(input: Internals): CodexPresenceSourceState {
  return {
    ...input.state,
    coverage: { ...input.state.coverage },
  };
}

function keyOf(target: CodexPresenceTarget): string {
  return [target.stateDir, target.session, target.seat, target.binding, target.threadId, target.endpoint].join('\0');
}

function writeDiagnostic(input: Internals): void {
  const paths = presencePaths(input.stateDir, input.target.session, input.target.seat);
  if (paths === null) return;
  try {
    mkdirSync(paths.root, { recursive: true });
    const body = JSON.stringify({
      v: 1,
      session: input.target.session,
      seat: input.target.seat,
      binding: input.target.binding,
      threadId: input.target.threadId,
      channel: input.state.channel,
      reason: input.state.reason,
      updatedAt: input.now().toISOString(),
      evidenceAt: input.state.evidenceAt,
    });
    const temp = join(paths.root, `.source.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(temp, `${body}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, join(paths.root, 'source.json'));
  } catch {
    // A diagnostic write is never allowed to disturb the stream or the spool.
  }
}

function settleAttempt(input: Internals): void {
  if (input.timer !== null) {
    clearTimeout(input.timer);
    input.timer = null;
  }
  const settle = input.settle;
  input.settle = null;
  input.attempt = null;
  settle?.();
}

function stopAdmissions(input: Internals, reason: CodexPresenceReason): void {
  if (input.closed) return;
  input.admissions = false;
  input.generation += 1;
  if (input.wired !== null) {
    const wire = input.wired;
    input.wired = null;
    wire.destroy();
  }
  input.phase = 'lost';
  input.state.channel = 'unknown';
  input.state.reason = reason;
  input.state.stream = input.initializedSent ? 'lost' : 'uninitialized';
  input.state.gap = input.state.gap || input.hadBaseline;
  writeDiagnostic(input);
  settleAttempt(input);
}

/** The seat's current managed binding must still be the one this source was started for. A
 *  mismatch (or a state this process cannot read) stops admissions before any late frame can be
 *  read as this incarnation's. */
function bindingCurrent(input: Internals): boolean {
  let binding: unknown;
  try {
    binding = readState(input.stateDir).sessions[input.target.session]?.seats[input.target.seat]?.presence_binding;
  } catch {
    stopAdmissions(input, 'binding-changed');
    return false;
  }
  if (binding !== input.target.binding) {
    stopAdmissions(input, 'binding-changed');
    return false;
  }
  return true;
}

function stageEvent(input: Internals, event: PresenceEvent, raw: string, receipt: Date): void {
  if (input.closed || !input.admissions) return;
  if (!bindingCurrent(input)) return;
  if (event === input.lastApplied) return;
  const staged = stagePresenceRecord(input.stateDir, {
    session: input.target.session,
    seat: input.target.seat,
    binding: input.target.binding,
    source: 'runtime-event',
    event,
    raw,
    ts: receipt.toISOString(),
  });
  if (staged.kind === 'staged') {
    input.state.events += 1;
    input.lastApplied = event;
  } else {
    input.state.ignored += 1;
  }
}

function failAttempt(input: Internals, reason: CodexPresenceReason): void {
  if (input.closed) return;
  input.phase = 'lost';
  input.state.channel = 'unknown';
  input.state.reason = reason;
  input.state.stream = input.initializedSent ? 'lost' : 'uninitialized';
  if (input.readOutstanding) input.state.baseline = 'failed';
  input.state.gap = input.state.gap || input.hadBaseline;
  input.nextAttemptAt = input.now().getTime() + input.retryMs;
  if (input.wired !== null) {
    const wire = input.wired;
    input.wired = null;
    wire.destroy();
  }
  writeDiagnostic(input);
  settleAttempt(input);
}

function applyBaseline(
  input: Internals,
  status: Record<string, unknown>,
  receipt: Date,
): void {
  input.state.baseline = 'read';
  input.state.stream = 'initialized';
  input.hadBaseline = true;
  input.readOutstanding = false;
  input.state.evidenceAt = receipt.toISOString();
  input.state.lastRefreshAt = input.state.evidenceAt;
  if (!bindingCurrent(input)) return;

  // A bound transition already received after this read was written is newer than the snapshot;
  // the response proves attachment but must not overwrite it.
  const newerStream = input.streamSeq !== input.readSeq;
  if (newerStream) {
    input.state.channel = 'connected';
    input.state.reason = null;
    input.phase = 'streaming';
    writeDiagnostic(input);
    settleAttempt(input);
    return;
  }

  const mapped = presenceFromCodexNotification(
    { method: 'thread/status/changed', params: { threadId: input.target.threadId, status } },
    input.target.threadId,
  );
  if (mapped.kind === 'event') {
    stageEvent(input, mapped.event, mapped.raw, receipt);
    // Staging may have stopped admissions (the managed binding changed under us); nothing after
    // that point may report this incarnation as healthy.
    if (input.closed || !input.admissions) return;
    input.state.channel = 'connected';
    input.state.reason = null;
    input.phase = 'streaming';
  } else {
    input.state.channel = 'unknown';
    input.state.reason = status.type === 'notLoaded' ? 'thread-not-loaded' : 'system-error';
    input.phase = 'streaming';
  }
  writeDiagnostic(input);
  settleAttempt(input);
}

function applyBoundNotification(
  input: Internals,
  notification: Record<string, unknown>,
  receipt: Date,
): void {
  if (input.closed || !input.admissions) return;
  const method = notification.method;
  if (typeof method !== 'string') {
    input.state.ignored += 1;
    return;
  }
  const params = notification.params;

  if (method === 'thread/closed') {
    if (isObject(params) && params.threadId === input.target.threadId) {
      if (input.state.channel !== 'gone') {
        stageEvent(input, 'session-end', 'thread/closed', receipt);
        if (input.closed || !input.admissions) return;
        input.state.evidenceAt = receipt.toISOString();
        input.state.lastRefreshAt = input.state.evidenceAt;
        input.state.channel = 'gone';
        input.state.reason = 'thread-closed';
        input.phase = 'terminal';
        input.admissions = false;
        input.generation += 1;
        if (input.wired !== null) {
          const wire = input.wired;
          input.wired = null;
          wire.destroy();
        }
        writeDiagnostic(input);
        settleAttempt(input);
      }
      return;
    }
    if (isObject(params) && typeof params.threadId === 'string') {
      input.state.otherThread += 1;
      return;
    }
    input.state.ignored += 1;
    return;
  }

  const reading = presenceFromCodexNotification(notification, input.target.threadId);
  if (reading.kind === 'other-thread') {
    input.state.otherThread += 1;
    return;
  }
  if (reading.kind === 'ignored') {
    input.state.ignored += 1;
    return;
  }

  if (!bindingCurrent(input)) return;
  input.streamSeq += 1;
  input.state.evidenceAt = receipt.toISOString();
  input.state.lastRefreshAt = input.state.evidenceAt;
  if (input.initializedSent) {
    input.state.channel = 'connected';
    input.state.reason = null;
    input.phase = 'streaming';
  }
  if (reading.event === input.lastApplied) {
    writeDiagnostic(input);
    return;
  }
  const outcome = input.sink(notification);
  if (outcome.kind === 'staged') {
    input.state.events += 1;
    input.lastApplied = reading.event;
  } else if (outcome.kind === 'ignored' || outcome.kind === 'refused') {
    input.state.ignored += 1;
  } else if (outcome.kind === 'other-thread') {
    input.state.otherThread += 1;
  }
  writeDiagnostic(input);
}

function handleFrame(input: Internals, text: string, receipt: Date): void {
  if (input.closed || !input.admissions) return;
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    input.state.ignored += 1;
    return;
  }
  if (!isObject(message)) {
    input.state.ignored += 1;
    return;
  }
  const id = message.id;
  if (typeof id === 'string') {
    if (id === 'initialize') {
      if (message.error !== undefined && message.error !== null) {
        failAttempt(input, 'initialize-failed');
        return;
      }
      if (input.wired === null) return;
      const initialized = JSON.stringify({ method: 'initialized' });
      input.wired.write(initialized);
      input.initializedSent = true;
      input.state.stream = 'initialized';
      input.state.baseline = 'pending';
      input.readOutstanding = true;
      input.readSeq = input.streamSeq;
      input.wired.write(
        JSON.stringify({
          id: 'thread_read',
          method: 'thread/read',
          params: { threadId: input.target.threadId, includeTurns: false },
        }),
      );
      writeDiagnostic(input);
      return;
    }
    if (id === 'thread_read') {
      if (message.error !== undefined && message.error !== null) {
        failAttempt(input, 'thread-read-failed');
        return;
      }
      const result = message.result;
      const thread = isObject(result) && isObject(result.thread) ? result.thread : null;
      if (thread === null || thread.id !== input.target.threadId || !generatedStatus(thread.status)) {
        failAttempt(input, 'thread-read-failed');
        return;
      }
      applyBaseline(input, thread.status as Record<string, unknown>, receipt);
      return;
    }
    input.state.ignored += 1;
    return;
  }
  applyBoundNotification(input, message, receipt);
}

function startAttempt(input: Internals): Promise<CodexPresenceSourceState> {
  const gen = input.generation + 1;
  input.generation = gen;
  input.phase = 'connecting';
  input.upgraded = false;
  input.initializedSent = false;
  input.readOutstanding = false;
  input.readSeq = input.streamSeq;
  input.state.channel = 'connecting';
  input.state.reason = 'initializing';
  input.state.stream = 'uninitialized';
  input.state.baseline = 'pending';
  writeDiagnostic(input);

  const promise = new Promise<CodexPresenceSourceState>((resolve) => {
    input.settle = () => resolve(snapshotOf(input));
  });
  input.attempt = promise;

  const wire = connectWire(input.socketPath, {
    onUpgrade: () => {
      if (input.closed || gen !== input.generation) return;
      input.upgraded = true;
      const write = input.wired;
      if (write === null) return;
      write.write(
        JSON.stringify({
          id: 'initialize',
          method: 'initialize',
          params: {
            clientInfo: { name: 'teamcli', title: null, version: '0.1.0' },
            capabilities: {
              experimentalApi: true,
              requestAttestation: false,
              optOutNotificationMethods: null,
            },
          },
        }),
      );
    },
    onText: (text: string) => {
      if (input.closed || gen !== input.generation) return;
      handleFrame(input, text, input.now());
    },
    onLoss: (reason) => {
      if (input.closed || gen !== input.generation) return;
      if (input.phase === 'terminal' || input.state.channel === 'gone') return;
      input.phase = 'lost';
      input.state.channel = 'unknown';
      input.state.reason = reason;
      input.state.stream = input.initializedSent ? 'lost' : 'uninitialized';
      if (input.readOutstanding) input.state.baseline = 'failed';
      input.state.gap = input.state.gap || input.hadBaseline;
      input.nextAttemptAt = input.now().getTime() + input.retryMs;
      input.wired = null;
      writeDiagnostic(input);
      settleAttempt(input);
    },
  });
  input.wired = wire;
  input.timer = setTimeout(() => {
    if (input.closed || gen !== input.generation) return;
    failAttempt(input, input.initializedSent ? 'thread-read-failed' : 'transport-error');
  }, input.connectTimeoutMs);
  input.timer.unref?.();
  return promise;
}

/** Starts one presence source. Every refusal happens before any socket, and a duplicate
 *  `(seat, binding, thread, endpoint)` is refused until the first is closed. */
export function codexPresenceFor(input: {
  target: CodexPresenceTarget;
  /** The host's verified signed `codex-daemon` resolution; off is refused here. */
  policy: 'on' | 'off';
  /** The host's presence-hosting gate, default off. */
  feature: boolean;
  sink?: (notification: unknown) => CodexPresenceOutcome;
  now?: () => Date;
  connectTimeoutMs?: number;
  retryMs?: number;
}): CodexStartResult {
  if (input.feature !== true) return { kind: 'refused', why: 'presence hosting is off' };
  if (input.policy !== 'on') return { kind: 'refused', why: 'the codex-daemon policy is off' };
  const target = input.target;
  if (presencePaths(target.stateDir, target.session, target.seat) === null) {
    return { kind: 'refused', why: 'the session or seat cannot name a presence folder' };
  }
  if (!isPresenceBinding(target.binding)) {
    return { kind: 'refused', why: 'the seat records no valid presence binding' };
  }
  if (!isThreadToken(target.threadId)) {
    return { kind: 'refused', why: 'the recorded session id is not one thread token' };
  }
  const socketPath = codexSocketPath(target.endpoint);
  if (socketPath === null) {
    return { kind: 'refused', why: 'the endpoint is not an explicit unix:/// absolute socket' };
  }
  const key = keyOf(target);
  if (ACTIVE.has(key)) {
    return { kind: 'refused', why: 'a source for this seat, binding, thread and endpoint is already open' };
  }
  ACTIVE.add(key);

  const now = input.now ?? (() => new Date());
  const internals: Internals = {
    target,
    stateDir: target.stateDir,
    socketPath,
    sink: input.sink ?? ((notification) => stageCodexPresence(
      {
        stateDir: target.stateDir,
        session: target.session,
        seat: target.seat,
        binding: target.binding,
        threadId: target.threadId,
      },
      notification,
    )),
    now,
    connectTimeoutMs: input.connectTimeoutMs ?? CODEX_CONNECT_TIMEOUT_MS,
    retryMs: input.retryMs ?? CODEX_RETRY_MS,
    wired: null,
    generation: 0,
    attempt: null,
    phase: 'idle',
    nextAttemptAt: 0,
    closed: false,
    admissions: true,
    upgraded: false,
    initializedSent: false,
    readOutstanding: false,
    readSeq: 0,
    streamSeq: 0,
    hadBaseline: false,
    lastApplied: null,
    timer: null,
    settle: null,
    state: {
      seat: target.seat,
      binding: target.binding,
      threadId: target.threadId,
      channel: 'connecting',
      reason: 'initializing',
      stream: 'uninitialized',
      baseline: 'pending',
      evidenceAt: null,
      lastRefreshAt: null,
      gap: false,
      events: 0,
      ignored: 0,
      otherThread: 0,
      coverage: { ...COVERAGE },
    },
  };

  const status = (): CodexPresenceSourceState => snapshotOf(internals);
  const step = (at: Date): Promise<CodexPresenceSourceState> => {
    if (internals.closed || !internals.admissions) return Promise.resolve(snapshotOf(internals));
    if (internals.attempt !== null) return internals.attempt;
    if (internals.wired !== null && internals.phase !== 'lost') return Promise.resolve(snapshotOf(internals));
    if (internals.phase === 'lost' && at.getTime() < internals.nextAttemptAt) {
      return Promise.resolve(snapshotOf(internals));
    }
    if (!bindingCurrent(internals)) return Promise.resolve(snapshotOf(internals));
    return startAttempt(internals);
  };

  const close = async (): Promise<{ quiesced: true }> => {
    // Synchronous first: no frame, baseline response or staged record can be admitted after this
    // line, even if a sibling source is still hung.
    if (!internals.closed) {
      internals.closed = true;
      internals.admissions = false;
      internals.generation += 1;
      if (internals.wired !== null) {
        const wire = internals.wired;
        internals.wired = null;
        wire.destroy();
      }
      if (internals.timer !== null) {
        clearTimeout(internals.timer);
        internals.timer = null;
      }
      if (internals.state.channel !== 'gone') {
        internals.state.channel = 'stopped';
        internals.state.reason = 'source-stopped';
      }
      internals.state.stream = internals.state.stream === 'initialized' ? 'lost' : internals.state.stream;
      writeDiagnostic(internals);
    }
    settleAttempt(internals);
    ACTIVE.delete(key);
    return { quiesced: true };
  };

  return {
    kind: 'subscribed',
    source: { seat: target.seat, step, status, state: status, close, cancel: close },
  };
}

export type CodexTargetRead =
  | { kind: 'target'; target: CodexPresenceTarget }
  /** Native presence is not expected for this seat; a hook or screen fallback is the answer. */
  | { kind: 'skip'; why: string }
  /** Native presence is expected but cannot be attached; the host shows this seat unproven. */
  | { kind: 'unproven'; why: string };

/** Resolves one seat's explicit native target. No endpoint discovery, no thread guess: a Codex
 *  seat with a managed session but no explicit unix endpoint is `unproven`, not silently skipped. */
export function codexPresenceTarget(input: {
  enabled: boolean;
  home: string;
  stateDir: string;
  root: string;
  herdrSession: string;
  session: string;
  seat: { name: string; cli: string };
  endpoint: string | null;
  codexDaemon?: CodexDaemonResolution | 'on' | 'off';
  now?: Date;
}): CodexTargetRead {
  if (input.enabled !== true) return { kind: 'skip', why: 'presence hosting is off' };
  if (input.seat.cli !== 'codex') return { kind: 'skip', why: 'the seat is not a Codex seat' };
  if (presencePaths(input.stateDir, input.session, input.seat.name) === null) {
    return { kind: 'unproven', why: 'the session or seat cannot name a presence folder' };
  }
  let state;
  try {
    state = readState(input.stateDir);
  } catch {
    return { kind: 'unproven', why: 'the team state is unreadable; the managed binding cannot be verified' };
  }
  const seatState = state.sessions[input.session]?.seats[input.seat.name];

  const recorded = recordedSeatSession({
    home: input.home,
    root: input.root,
    herdrSession: input.herdrSession,
    seat: input.seat,
    state: seatState,
  });
  if (recorded.kind !== 'bound') {
    const agent = findAgent(input.home, {
      team: teamIdOf(input.root),
      seat: input.seat.name,
      seatHandle: seatState?.id ?? null,
    });
    const nativeExpected = agent !== null
      && agent.cli === 'codex'
      && typeof agent.reach.agent_session === 'string'
      && agent.reach.agent_session !== '';
    return nativeExpected
      ? { kind: 'unproven', why: recorded.why }
      : { kind: 'skip', why: recorded.why };
  }

  const given = input.codexDaemon;
  if (given === 'off') {
    return { kind: 'unproven', why: 'the signed codex-daemon policy is off for this seat' };
  }
  if (given !== 'on') {
    const resolution = given ?? resolveCodexDaemonPolicy({ home: input.home, root: input.root, now: input.now });
    if (!resolution.ok) {
      return { kind: 'unproven', why: `the codex-daemon policy is unreadable: ${resolution.why}` };
    }
    if (resolution.value !== 'on') {
      return { kind: 'unproven', why: 'the signed codex-daemon policy is off for this seat' };
    }
  }

  const binding = seatState?.presence_binding;
  if (!isPresenceBinding(binding)) {
    return { kind: 'unproven', why: 'the seat records no valid presence binding' };
  }
  const threadId = recorded.recorded.sessionId;
  if (!isThreadToken(threadId)) {
    return { kind: 'unproven', why: 'the recorded session id is not one thread token' };
  }
  if (input.endpoint === null || codexSocketPath(input.endpoint) === null) {
    return { kind: 'unproven', why: 'no explicit unix app-server endpoint was resolved for this seat' };
  }
  return {
    kind: 'target',
    target: {
      stateDir: input.stateDir,
      session: input.session,
      seat: input.seat.name,
      binding,
      threadId,
      endpoint: input.endpoint,
    },
  };
}
