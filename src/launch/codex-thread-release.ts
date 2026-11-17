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
export function codexRpcSession(socketPath: string, calls: RpcCall[], timeoutMs = 3000): Promise<{ ok: true; replies: RpcReply[] } | { ok: false; why: string; replies: RpcReply[] }> {
  const replies: RpcReply[] = [];
  if (!existsSync(socketPath)) return Promise.resolve({ ok: false, why: 'the app-server socket is not there', replies });
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    let buffer: Buffer = Buffer.alloc(0);
    let upgraded = false;
    let next = 0;
    let settled = false;
    const done = (value: { ok: true; replies: RpcReply[] } | { ok: false; why: string; replies: RpcReply[] }): void => {
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
    socket.on('error', (err: NodeJS.ErrnoException) => done({ ok: false, why: `the app-server socket failed (${err.code ?? 'error'})`, replies }));
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

function loadedIds(reply: RpcReply | undefined): string[] | null {
  if (reply === undefined || !reply.ok) return null;
  const data = (reply.result as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data.filter((id): id is string => typeof id === 'string') : null;
}

/** Whether one app-server lists the conversation as loaded. An app-server that cannot be
 *  reached, or gives no list, cannot hold it for a TUI to collide with: `unreachable`. */
export async function codexThreadLoaded(
  socketPath: string,
  threadId: string,
  rpc: typeof codexRpcSession = codexRpcSession,
): Promise<'loaded' | 'free' | 'unreachable'> {
  const read = await rpc(socketPath, [{ method: 'thread/loaded/list', params: {} }]);
  if (!read.ok) return 'unreachable';
  const ids = loadedIds(read.replies[0]);
  if (ids === null) return 'unreachable';
  return ids.includes(threadId) ? 'loaded' : 'free';
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
  for (;;) {
    let heldBy: string | null = null;
    for (const socket of input.sockets) {
      if ((await codexThreadLoaded(socket, input.threadId, input.rpc)) === 'loaded') { heldBy = socket; break; }
    }
    const waitedMs = now() - started;
    if (heldBy === null) return { free: true, waitedMs };
    if (waitedMs >= input.timeoutMs) return { free: false, heldBy, waitedMs };
    await sleep(input.pollMs);
  }
}

/** The Codex TUI's own screen for a conversation another app-server holds (codex-cli 0.167.0,
 *  captured in the reboot simulation): no composer, only retry, fork and exit keys. */
export function codexThreadLockedScreen(screen: string | null | undefined): boolean {
  if (screen == null) return false;
  // The shipped read is styled (`--format ansi`): the words are compared without their colours.
  const tail = stripSgr(screen).split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(-6).join('\n');
  return /This conversation is open in another app/.test(tail) && /⌃c\/q exit/.test(tail);
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
