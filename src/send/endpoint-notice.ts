// One signed notice when a Codex endpoint is not listening. A later send to the same blocked
// endpoint does not write another, until a send finds that endpoint listening again and is
// enqueued. Restoring the team does not clear that mark. The notice reaches the lead through
// the drop readers. Channel admission does not name this principal: the signature is the shared
// home key, and it proves only that a seat wrote the record.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { dropMessage } from './native.ts';
import { signRecord } from './record.ts';

/** The principal a runtime notice is signed as. Drop readers print it. Channel admission does not. */
export const RUNTIME_FROM = 'runtime';

/** The rule on every runtime notice to the lead, including a blocked Codex endpoint. */
export const RUNTIME_RULE = "the team's unread-message report";

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
  if (input.lead === '' || input.lead === input.seat) return false;
  const mark = blockedMark(input.root, input.session, input.seat);
  if (existsSync(mark)) return false;
  try {
    const id = randomUUID();
    const leadDir = join(input.root, '.agents', 'send-drops', input.session, input.lead);
    const signed = signRecord({
      kind: 'message',
      id,
      to: input.lead,
      to_id: null,
      root: realpathSync(input.root),
      session: input.session,
      at: input.at,
      body: endpointBlockedLine(input.seat, input.reason),
      from: RUNTIME_FROM,
      from_id: null,
      rule: RUNTIME_RULE,
      thread: id,
    }, input.home);
    dropMessage(leadDir, id, `${JSON.stringify(signed, null, 2)}\n`);
    mkdirSync(dirname(mark), { recursive: true, mode: 0o700 });
    writeFileSync(mark, `${input.at}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
