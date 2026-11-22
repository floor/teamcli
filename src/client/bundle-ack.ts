// The one admission of an acknowledgement of a record a client wrote under a bundle grant.
//
// `team ack` and the channel server's `ack` tool both acknowledge such a record, and both run
// this gate: the grant's signed op list must carry `ack`, the record must be the client's own
// opening record, addressed to the seat the grant reaches in the one team and session it signs,
// and the acknowledging seat must be that recipient. The write itself runs under the client grant
// lock, after the grant and its recipient are proven again, so a revocation or a roster change
// appended while the caller waited is seen.
import { realpathSync } from 'node:fs';
import { resolveBundleSendTarget } from './bundles.ts';
import { activeClientUpGrant, clientAdmission, withClientGrantLock, type ClientUpGrantRecord } from './records.ts';
import type { RecordPayload } from '../send/record.ts';

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

export type BundleAckGate =
  | { ok: false; why: string }
  | {
    ok: true;
    /** Runs `write` under the client grant lock once the grant and its recipient hold again. */
    under: <T>(write: () => T) => { ok: true; value: T } | { ok: false; why: string };
  };

/** Admits `me` acknowledging `record` (its `from_client` names `origin`'s bundle grant) in the
 *  team checkout `root` and `session`. */
export function bundleAckGate(
  home: string,
  origin: { grant: ClientUpGrantRecord; signature: string },
  record: Pick<RecordPayload, 'id' | 'thread' | 'to' | 'to_id' | 'from_client'>,
  root: string,
  session: string,
  me: string,
  now: () => Date,
): BundleAckGate {
  const grant = origin.grant;
  const id = record.id;
  if (record.from_client === undefined || grant.clientId !== record.from_client.client_id) {
    return { ok: false, why: `this record names client "${record.from_client?.client_id ?? ''}" and its grant names "${grant.clientId}"; nothing was written` };
  }
  const admitted = clientAdmission(home, grant.clientId, grant.entity);
  if (!admitted.ok) return { ok: false, why: `${admitted.why}; nothing was written` };
  if (!grant.ops.includes('ack')) {
    return { ok: false, why: `the record's bundle grant ${grant.grantId} carries ${grant.ops.join(', ') || 'no op'}, not ack; only a bundle that carries ack admits this acknowledgement; nothing was written` };
  }
  if (record.thread !== record.id) {
    return { ok: false, why: `record ${id} answers another record; a client thread is the client's own opening record, and only it is acknowledged; nothing was written` };
  }
  if (record.to_id === null) {
    return { ok: false, why: `record ${id} carries no to_id; the seat the bundle grant reaches cannot be matched to it; nothing was written` };
  }
  const resolved = resolveBundleSendTarget(home, grant, record.to);
  if (!resolved.ok) return { ok: false, why: `the bundle grant's recipient cannot be resolved: ${resolved.why}; nothing was written` };
  const target = resolved.target;
  if (!samePath(target.teamRoot, root) || target.session !== session) {
    return { ok: false, why: `the bundle grant's recipient lives in another checkout or session than this record; nothing was written` };
  }
  if (record.to !== target.recipientSeat || record.to_id !== target.recipientId) {
    return { ok: false, why: `record ${id} is addressed to "${record.to}" (${record.to_id}), not to the recipient the bundle grant reaches, "${target.recipientSeat}" (${target.recipientId}); nothing was written` };
  }
  if (me !== target.recipientSeat) {
    return { ok: false, why: `seat ${me} is not the recipient of the client thread; only ${target.recipientSeat} acknowledges it; nothing was written` };
  }
  const under = <T>(write: () => T): { ok: true; value: T } | { ok: false; why: string } => {
    try {
      return withClientGrantLock(home, (): { ok: true; value: T } | { ok: false; why: string } => {
        const active = activeClientUpGrant(home, origin, now());
        // A revoked or expired grant ends what the client may do, not the seat's own reading of a
        // record the grant once admitted: the recipient was proven against the stored grant above,
        // and a read receipt grants nothing. Without it the record stayed unread for good, and
        // every reader that replays unread mail replayed it forever. A reply stays gated on an
        // active grant. Only an expiry or a revocation: a grant record that cannot be read or
        // verified now, or was replaced, still refuses. The recipient is proven again, so a roster
        // or session change while this call waited is still seen.
        if (!active.ok && active.kind === 'other') return { ok: false, why: `the originating grant ${grant.grantId} is not active: ${active.why}; nothing was written` };
        const fresh = resolveBundleSendTarget(home, active.ok ? active.grant : grant, record.to);
        if (!fresh.ok) return { ok: false, why: `the bundle grant's recipient can no longer be resolved: ${fresh.why}; nothing was written` };
        if (
          !samePath(fresh.target.teamRoot, root) ||
          fresh.target.session !== session ||
          fresh.target.recipientSeat !== me ||
          record.to_id !== fresh.target.recipientId
        ) {
          return { ok: false, why: 'the bundle grant\'s recipient changed while this call waited; nothing was written' };
        }
        return { ok: true, value: write() };
      });
    } catch (error) {
      return { ok: false, why: error instanceof Error ? `${error.message}; nothing was written` : 'the client grant lock could not be taken; nothing was written' };
    }
  };
  return { ok: true, under };
}
