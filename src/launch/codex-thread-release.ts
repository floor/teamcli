// Releasing a Codex conversation another app-server still holds, before a relaunch resumes it.
//
// After a restart the conversation a Codex seat resumes can stay loaded in an app-server that is
// not the one the relaunched TUI attaches to: the seat's own previous managed endpoint (it is
// detached, so a terminal-host restart leaves it running), or Codex's shared app-server daemon
// (`~/.codex/app-server-control/app-server-control.sock`, started at boot), which a TUI the host
// resumed without `--remote` loads it into. Codex refuses a second app-server the same
// conversation: the TUI shows "This conversation is open in another app — Close it there and
// press R" and takes nothing (17 Nov: Hermes's relaunch on floor; sim-codex in the reboot
// simulation).
//
// The fix asks the app-servers one read-only question (`thread/loaded/list`) over the same
// WebSocket JSON-RPC the relay already speaks, and waits for the conversation to be free before
// the relaunch resumes it. No process is signalled, nothing is unloaded on another client's
// behalf, and the shared daemon other seats use keeps running.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { decodeServerWsFrames, encodeMaskedWsTextFrame, resolveCodexControlSocketPath } from '../send/push-adapters/codex-relay.ts';
import { readState } from '../state.ts';
import { stripSgr } from '../ansi.ts';

export type RpcCall = { method: string; params: Record<string, unknown> };
export type RpcReply = { ok: true; result: unknown } | { ok: false; error: string };

/** One JSON-RPC session: initialize, initialized, then each call in order, each answered before
 *  the next is sent. Replies are returned in call order; a refused call ends the session there.
 *  The whole session is bounded by `timeoutMs`. */
export type RpcSession = { ok: true; replies: RpcReply[] } | { ok: false; why: string; replies: RpcReply[]; absent?: true };

/** One JSON-RPC session (see above). `absent`: nothing listens at the socket (no file, or
 *  ECONNREFUSED / ENOENT on connect), which is the only failure that proves the app-server holds
 *  nothing. */
export function codexRpcSession(socketPath: string, calls: RpcCall[], timeoutMs = 3000): Promise<RpcSession> {
  const replies: RpcReply[] = [];
  if (!existsSync(socketPath)) return Promise.resolve({ ok: false, why: 'the app-server socket is not there', replies, absent: true });
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    let buffer: Buffer = Buffer.alloc(0);
    let upgraded = false;
    let next = 0;
    let settled = false;
    const done = (value: RpcSession): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done({ ok: false, why: `no answer within ${String(timeoutMs)} ms`, replies }), timeoutMs);
    const send = (body: Record<string, unknown>): void => { socket.write(encodeMaskedWsTextFrame(JSON.stringify(body))); };
    const sendNext = (): void => {
      if (next >= calls.length) { done({ ok: true, replies }); return; }
      const call = calls[next]!;
      send({ id: `call-${String(next)}`, method: call.method, params: call.params });
    };
    socket.on('error', (err: NodeJS.ErrnoException) => done({
      ok: false,
      why: `the app-server socket failed (${err.code ?? 'error'})`,
      replies,
      ...(!upgraded && (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') ? { absent: true as const } : {}),
    }));
    socket.on('close', () => done({ ok: false, why: 'the app-server closed the connection', replies }));
    socket.on('connect', () => {
      socket.write(['GET /rpc HTTP/1.1', 'Host: localhost', 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${key}`, '', ''].join('\r\n'));
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 4);
        const got = /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(head)?.[1];
        if (!/^HTTP\/1\.1 101\b/i.test(head) || got !== accept) { done({ ok: false, why: 'the app-server refused the WebSocket upgrade', replies }); return; }
        upgraded = true;
        send({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'teamcli', title: null, version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null } } });
      }
      const decoded = decodeServerWsFrames(buffer);
      buffer = decoded.rest;
      if (decoded.error !== undefined) { done({ ok: false, why: decoded.error, replies }); return; }
      for (const raw of decoded.frames) {
        let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } | null };
        try { msg = JSON.parse(raw) as typeof msg; } catch { done({ ok: false, why: 'the app-server sent invalid JSON', replies }); return; }
        if (msg.id === 'initialize') {
          if (msg.error) { done({ ok: false, why: 'the app-server refused initialize', replies }); return; }
          send({ method: 'initialized' });
          sendNext();
          continue;
        }
        if (msg.id !== `call-${String(next)}`) continue; // a notification, or another client's id
        if (msg.error) {
          const text = typeof msg.error.message === 'string' ? msg.error.message : 'refused';
          replies.push({ ok: false, error: text });
          done({ ok: false, why: `${calls[next]!.method} refused: ${text}`, replies });
          return;
        }
        replies.push({ ok: true, result: msg.result });
        next += 1;
        sendNext();
      }
    });
  });
}

/** One page of `thread/loaded/list`: every member a string, the cursor a string or null.
 *  Anything else is not a reading. */
function loadedPage(reply: RpcReply | undefined): { ids: string[]; next: string | null } | null {
  if (reply === undefined || !reply.ok) return null;
  const result = reply.result as { data?: unknown; nextCursor?: unknown } | null;
  const data = result?.data;
  if (!Array.isArray(data) || !data.every((id) => typeof id === 'string')) return null;
  const next = result?.nextCursor;
  if (next !== undefined && next !== null && typeof next !== 'string') return null;
  return { ids: data as string[], next: typeof next === 'string' && next !== '' ? next : null };
}

/** One page's own bound. */
const RPC_TIMEOUT_MS = 3000;

/** The most pages one reading follows; a list longer than this is not read to its end. */
const MAX_PAGES = 50;

export type LoadedReading = 'loaded' | 'free' | 'absent' | { unknown: string };

/** Whether one app-server lists the conversation as loaded, every page read. `absent`: nothing
 *  listens there, so nothing is held. A failed, refused, malformed or unfinished reading is
 *  `unknown`, never free: the app-server may hold the conversation all the same. */
export async function codexThreadLoaded(
  socketPath: string,
  threadId: string,
  rpc: typeof codexRpcSession = codexRpcSession,
  /** Milliseconds left of the caller's whole bound: every page is capped by it, no page starts
   *  once it is spent, and a page that ends past it is no reading (review round 7). */
  remainingMs: () => number = () => RPC_TIMEOUT_MS,
): Promise<LoadedReading> {
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const left = remainingMs();
    if (left <= 0) return { unknown: 'the wait bound was spent before the list was read to its end' };
    const read = await rpc(socketPath, [{ method: 'thread/loaded/list', params: cursor === null ? {} : { cursor } }], Math.min(RPC_TIMEOUT_MS, left));
    if (remainingMs() < 0) return { unknown: 'the list was not read to its end within the wait bound' };
    if (!read.ok) return read.absent === true && page === 0 ? 'absent' : { unknown: read.why };
    const got = loadedPage(read.replies[0]);
    if (got === null) return { unknown: 'thread/loaded/list gave no valid list' };
    if (got.ids.includes(threadId)) return 'loaded';
    if (got.next === null) return 'free';
    cursor = got.next;
  }
  return { unknown: `thread/loaded/list did not end within ${String(MAX_PAGES)} pages` };
}

export type ThreadWait = { free: true; waitedMs: number } | { free: false; heldBy: string; waitedMs: number };

/**
 * Waits until no app-server among `sockets` lists the conversation as loaded. Read-only: the
 * app-servers are only asked `thread/loaded/list`. Measured on codex-cli 0.167.0 (17 Nov, the
 * reboot simulation's own endpoint): an app-server keeps a conversation loaded about sixty
 * seconds after its last client leaves, and a TUI resuming it from another app-server in that
 * window gets "This conversation is open in another app". Rejoining and unsubscribing does not
 * shorten it (measured: the same sixty seconds), so the wait is the release.
 */
export async function waitCodexThreadFree(input: {
  sockets: readonly string[];
  threadId: string;
  timeoutMs: number;
  pollMs: number;
  rpc?: typeof codexRpcSession;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ThreadWait> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((settle) => setTimeout(settle, ms)));
  const started = now();
  const remaining = (): number => input.timeoutMs - (now() - started);
  for (;;) {
    let heldBy: string | null = null;
    for (const socket of input.sockets) {
      const reading = await codexThreadLoaded(socket, input.threadId, input.rpc, remaining);
      if (reading === 'loaded') { heldBy = socket; break; }
      // Fail closed: a reading that is not established counts as holding it.
      if (typeof reading === 'object') { heldBy = `${socket} (unreadable: ${reading.unknown})`; break; }
    }
    const waitedMs = now() - started;
    if (heldBy === null) return { free: true, waitedMs };
    if (waitedMs >= input.timeoutMs) return { free: false, heldBy, waitedMs };
    await sleep(Math.min(input.pollMs, Math.max(0, remaining())));
    // The bound is spent: no further reading starts, and the last holder seen is the answer.
    if (remaining() <= 0) return { free: false, heldBy, waitedMs: now() - started };
  }
}

/** The four rows that close the Codex TUI's lock screen (codex-cli 0.167.0, captured in the
 *  reboot simulation), in order, as the last non-empty rows of the frame. */
const LOCK_ROWS: readonly RegExp[] = [
  /^■ This conversation is read-only or unavailable; no operation was sent\.$/u,
  /^🔒\s+This conversation is open in another app(?:\s+r to retry)?$/u,
  /^Close it there and press R to continue here\.$/u,
  /^r retry\s+f fork\s+←\/esc command center\s+⌃c\/q exit\s+⌃t transcript$/u,
];

/**
 * The Codex TUI's own screen for a conversation another app-server holds: the frame ends with
 * exactly the four lock rows, nothing below them, and no composer row (`›` at the start of a row)
 * anywhere after the transcript's last turn marker above them. A frame that only quotes the words
 * — inside a dialog, above a live composer, or in a draft — is not this screen.
 */
export function codexThreadLockedScreen(screen: string | null | undefined): boolean {
  if (screen == null) return false;
  // The shipped read is styled (`--format ansi`): the rows are compared without their colours.
  const rows = stripSgr(screen).split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (rows.length < LOCK_ROWS.length) return false;
  const tail = rows.slice(-LOCK_ROWS.length);
  if (!LOCK_ROWS.every((row, at) => row.test(tail[at]!))) return false;
  // No input box between the transcript and the lock rows: the rows above them up to the last
  // turn's own lines hold no composer prompt.
  const above = rows.slice(0, -LOCK_ROWS.length);
  const lastPrompt = above.map((row) => row.startsWith('›')).lastIndexOf(true);
  const lastOutput = above.map((row) => row.startsWith('•') || row.startsWith('Worked for') || row.startsWith('■')).lastIndexOf(true);
  return lastPrompt < lastOutput;
}

/** How long a Codex launch waits for its conversation to be released by another app-server
 *  (measured: about sixty seconds after its last client leaves), and how often it asks. */
export const CODEX_THREAD_WAIT_MS = 120_000;
export const CODEX_THREAD_POLL_MS = 3_000;

/**
 * The executor's `codexThreadFree` for one team: the app-servers a seat's conversation can still
 * be loaded in are Codex's shared daemon (a TUI the host resumed without `--remote` loads it
 * there) and the seat's own recorded endpoint (detached, so it outlives a terminal-host restart).
 */
export function codexThreadFreeFor(input: {
  home: string;
  dir: string;
  wait: (wait: { sockets: string[]; threadId: string }) => Promise<ThreadWait>;
}): (session: string, seat: string, threadId: string) => Promise<{ free: true } | { free: false; why: string }> {
  return async (session, seat, threadId) => {
    const sockets: string[] = [];
    const shared = resolveCodexControlSocketPath(input.home);
    if (shared !== null) sockets.push(shared);
    let url: unknown;
    try { url = readState(input.dir).sessions[session]?.seats[seat]?.codex_endpoint?.url; } catch { url = undefined; }
    const own = typeof url === 'string' ? resolveCodexControlSocketPath(input.home, url) : null;
    if (own !== null && !sockets.includes(own)) sockets.push(own);
    const waited = await input.wait({ sockets, threadId });
    return waited.free ? { free: true } : { free: false, why: `${waited.heldBy} still lists it after ${String(Math.round(waited.waitedMs / 1000))} s` };
  };
}

/** The shipped wait: real app-servers, the measured bounds. */
export function shippedCodexThreadWait(wait: { sockets: string[]; threadId: string }): Promise<ThreadWait> {
  return waitCodexThreadFree({ ...wait, timeoutMs: CODEX_THREAD_WAIT_MS, pollMs: CODEX_THREAD_POLL_MS });
}
