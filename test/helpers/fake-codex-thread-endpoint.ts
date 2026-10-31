// A fake Codex app-server on a real Unix socket, answering the one exchange the thread reader
// makes: `initialize`, `initialized`, then `thread/loaded/list`. The transport is a real
// websocket upgrade and real frames, so the production codec is exercised; only the app-server's
// answers are fixture. Frame shapes are the measured ones (`codex-cli 0.161.0`, 2026-11-01):
//
//   initialize            -> {"id":"initialize","result":{...}}
//   thread/loaded/list    -> {"id":"thread_loaded_list","result":{"data":[<id>...],"nextCursor":null}}
//
// A scene may instead answer an error or any raw result, so the reader's refusal paths are
// exercised against a server that really speaks the protocol.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

export type LoadedListAnswer =
  | { ids: string[]; nextCursor?: string | null }
  | { result: unknown }
  | { error: unknown };

export type FakeThreadEndpoint = {
  socketPath: string;
  /** The JSON-RPC words the reader sent, in order: `initialize`, `initialized`, `thread/loaded/list`. */
  requests: string[];
  close(): Promise<void>;
};

function serverFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function clientFrames(buffer: Buffer): { texts: string[]; rest: Buffer } {
  const texts: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset] as number;
    const second = buffer[offset + 1] as number;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLen = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    const maskLen = masked ? 4 : 0;
    const total = headerLen + maskLen + length;
    if (offset + total > buffer.length) break;
    const start = offset + headerLen + maskLen;
    if (opcode === 0x1) {
      if (masked) {
        const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
        const payload = Buffer.alloc(length);
        for (let i = 0; i < length; i += 1) payload[i] = (buffer[start + i] as number) ^ (mask[i % 4] as number);
        texts.push(payload.toString('utf8'));
      } else {
        texts.push(buffer.subarray(start, start + length).toString('utf8'));
      }
    }
    offset += total;
  }
  return { texts, rest: buffer.subarray(offset) };
}

/** Starts the fake endpoint listening at `socketPath` (its folder is created). */
export async function startFakeThreadEndpoint(
  socketPath: string,
  options: { answer: LoadedListAnswer },
): Promise<FakeThreadEndpoint> {
  const requests: string[] = [];
  const open = new Set<Socket>();
  const server: Server = createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => {});
    let buffer: Buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 4);
        const key = /^sec-websocket-key:\s*(\S+)\s*$/im.exec(head)?.[1];
        if (key === undefined) {
          socket.destroy();
          return;
        }
        const accept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        upgraded = true;
      }
      const decoded = clientFrames(buffer);
      buffer = decoded.rest;
      for (const raw of decoded.texts) {
        let msg: { id?: unknown; method?: unknown };
        try {
          msg = JSON.parse(raw) as typeof msg;
        } catch {
          continue;
        }
        if (typeof msg.method === 'string' && msg.id === undefined) {
          requests.push(msg.method);
          continue;
        }
        if (msg.id === 'initialize') {
          requests.push('initialize');
          socket.write(
            serverFrame(
              JSON.stringify({
                id: 'initialize',
                result: {
                  userAgent: 'fake-codex-app-server',
                  codexHome: '/synthetic/codex-home',
                  platformFamily: 'unix',
                  platformOs: 'synthetic',
                },
              }),
            ),
          );
        } else if (msg.id === 'thread_loaded_list') {
          requests.push('thread/loaded/list');
          const answer = options.answer;
          if ('error' in answer) {
            socket.write(serverFrame(JSON.stringify({ id: 'thread_loaded_list', error: answer.error })));
          } else if ('result' in answer) {
            socket.write(serverFrame(JSON.stringify({ id: 'thread_loaded_list', result: answer.result })));
          } else {
            socket.write(
              serverFrame(
                JSON.stringify({
                  id: 'thread_loaded_list',
                  result: {
                    data: answer.ids,
                    nextCursor: answer.nextCursor === undefined ? null : answer.nextCursor,
                  },
                }),
              ),
            );
          }
        }
      }
    });
  });
  mkdirSync(dirname(socketPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    requests,
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
