// One signed notice when a Codex endpoint is not listening. A later send to the same blocked
// endpoint does not write another, until a send finds that endpoint listening again and is
// enqueued. Restoring the team does not clear that mark. The notice reaches the lead through
// the drop readers. Channel admission does not name this principal: the signature is the shared
// home key, and it proves only that a seat wrote the record.
import { hostedCommit } from '../host/request-scope.ts';
import { randomUUID } from 'node:crypto';
import { readStateFile, writeStateFile } from '../file-write.ts';
import { existsSync } from 'node:fs';
import { mkdirSync, unlinkSync } from '../host/guarded-fs.ts';
import { join, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { dropMessage } from './native.ts';
import { readRecord, sameFolder, signRecord, verifyRecord, type RecordPayload } from './record.ts';
import { messageKeyState } from '../store/keys.ts';
import { ensureFoldersBelow } from './history.ts';

/** The principal a runtime notice is signed as. Drop readers print it. Channel admission does not. */
export const RUNTIME_FROM = 'runtime';

/** The rule on every runtime notice to the lead, including a blocked Codex endpoint. */
export const RUNTIME_RULE = "the team's unread-message report";

/** The shared signed lead-notice path. A stable id makes a retry find the first notice. */
export function writeRuntimeNotice(input: {
  home: string; root: string; session: string; lead: string; id: string; body: string; at: string;
  prepareOnly?: boolean;
}): { ok: true; payload: RecordPayload; existing: boolean } | { ok: false; reason: string } {
  hostedCommit('writeRuntimeNotice');
  try {
    const payload: RecordPayload = {
      kind: 'message', id: input.id, to: input.lead, to_id: null,
      root: realpathSync(input.root), session: input.session, at: input.at,
      body: input.body, from: RUNTIME_FROM, from_id: null, rule: RUNTIME_RULE, thread: input.id,
    };
    const leadDir = join(input.root, '.agents', 'send-drops', input.session, input.lead);
    const problem = ensureFoldersBelow(payload.root, [join('.agents', 'send-drops', input.session, input.lead)]);
    if (problem !== null) return { ok: false, reason: problem };
    const existing = readRecord(join(leadDir, input.id), input.id);
    if (!existing.ok) return existing;
    if (existing.record !== null) {
      const key = messageKeyState(input.home);
      const found = existing.record.payload;
      if (key.kind !== 'key' || !verifyRecord(existing.record, key.key) || found.to !== input.lead
        || found.session !== input.session || !sameFolder(found.root, payload.root)) {
        return { ok: false, reason: 'the existing lead notice does not verify for this recipient' };
      }
      return { ok: true, payload: found, existing: true };
    }
    if (input.prepareOnly === true) return { ok: true, payload, existing: false };
    const signed = signRecord(payload, input.home);
    dropMessage(leadDir, input.id, `${JSON.stringify(signed, null, 2)}\n`);
    return { ok: true, payload, existing: false };
  } catch {
    return { ok: false, reason: 'the signed lead notice could not be written' };
  }
}

/** The one line a missing Codex socket prints, to the sender and to the lead. */
export function endpointBlockedLine(seat: string, reason: string): string {
  return `${seat}: blocked, its Codex endpoint is not listening; the message is in its bus inbox; team up restores the endpoint (${reason})`;
}

function blockedMark(root: string, session: string, seat: string): string {
  return join(root, '.agents', 'endpoint-blocked', session, seat);
}

/** Forgets a blocked endpoint, so the next time it is down one notice can be written again. */
export function clearEndpointBlocked(root: string, session: string, seat: string): void {
  const path = blockedMark(root, session, seat);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // A mark that cannot be cleared keeps the last notice standing.
  }
}

/** Writes the lead's notice the first time this endpoint is blocked. A mark already standing
 *  for this seat means the notice was written and the endpoint has not recovered, so nothing
 *  is written. A lead write that fails leaves the seat's own record where it is. */
export function writeEndpointBlockedNotice(input: {
  home: string;
  root: string;
  session: string;
  lead: string;
  seat: string;
  reason: string;
  at: string;
}): boolean {
  hostedCommit('writeEndpointBlockedNotice');
  if (input.lead === '' || input.lead === input.seat) return false;
  const mark = blockedMark(input.root, input.session, input.seat);
  try {
    mkdirSync(dirname(mark), { recursive: true, mode: 0o700 });
    if (readStateFile(mark, 4096, input.root) !== null) return false;
    const id = randomUUID();
    const notice = writeRuntimeNotice({ ...input, id, body: endpointBlockedLine(input.seat, input.reason) });
    if (!notice.ok) return false;
    writeStateFile(mark, `${input.at}\n`, { root: input.root });
    return true;
  } catch {
    return false;
  }
}
