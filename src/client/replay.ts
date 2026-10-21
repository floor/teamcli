// The claim that makes a client request id usable once. The id names a file created with O_EXCL
// under the receiving team's `.agents` tree before the drop is written, so two runs of one signed
// request cannot both take effect, and a run that crashed after claiming keeps the id claimed.
// A duplicate is refused; it is never turned into a silent success.

import { closeSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { CLIENT_REQUEST_ID_PATTERN } from './verify.ts';

const CLIENT_WORD_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `<root>/.agents/client-replay/<clientId>/<requestId>.json`. */
export function clientReplayFolder(root: string): string {
  return join(root, '.agents', 'client-replay');
}

export function clientReplayPath(root: string, clientId: string, requestId: string): string {
  return join(clientReplayFolder(root), clientId, `${requestId}.json`);
}

/**
 * Claims one request id for one client under `root`. Any file already at the id's name refuses
 * the claim — a completed effect or an attempt that stopped partway; the request id is spent
 * either way.
 */
export function claimClientRequest(
  root: string,
  clientId: string,
  requestId: string,
  at: Date,
): { ok: true; path: string } | { ok: false; why: string } {
  if (!CLIENT_WORD_PATTERN.test(clientId)) return { ok: false, why: `"${clientId}" is not a client id` };
  if (!CLIENT_REQUEST_ID_PATTERN.test(requestId)) {
    return { ok: false, why: `"${requestId}" is not a request id` };
  }
  const folder = join(clientReplayFolder(root), clientId);
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, why: `the replay folder "${folder}" cannot be created` };
  }
  const path = join(folder, `${requestId}.json`);
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      let held = 'another attempt';
      try {
        if (lstatSync(path).isSymbolicLink()) held = 'a symbolic link';
      } catch {}
      return { ok: false, why: `request "${requestId}" was already used for client "${clientId}" (${held} holds it); a request id is used once` };
    }
    return { ok: false, why: `the request claim "${path}" cannot be written (${code ?? 'unreadable'})` };
  }
  try {
    writeSync(fd, `${JSON.stringify({ client_id: clientId, request_id: requestId, at: at.toISOString() })}\n`);
  } finally {
    closeSync(fd);
  }
  return { ok: true, path };
}
