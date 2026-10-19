// The general seat brief: what every seat of a team receives first, whatever its role or trade.
// The text is TeamCLI's built-in default, embedded in general-brief-text.ts the way the registered
// captures are — that module is generated from the accepted source by `scripts/brief.ts --write` —
// because the package ships dist/ only and must never read a documentation checkout at runtime.
// `team up` (and `add`, `restart`, `reload`) writes it into each seat's drop folder as a signed
// message record before the rules land, so it arrives through the drop leg and is never typed
// into a pane; the delivery is recorded in the session's state (`briefs`), which is what
// `team check` reads to name a seat that never got it. The id is derived from the text: the same
// brief has the same record in every seat's folder, and a reworded brief is a new message.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { recordFile, recordHolds, readRecord, signRecord, writeRecordOver, type RecordPayload } from '../send/record.ts';
import { emptySession, updateState } from '../state.ts';
import { GENERAL_BRIEF, GENERAL_BRIEF_SHA256 } from './general-brief-text.ts';

export { GENERAL_BRIEF, GENERAL_BRIEF_SHA256 };

/** The rule a launch record carries: the launch admits the record to every seat of its team. */
export const GENERAL_BRIEF_RULE = 'the launch delivers it to every seat of its team';

/** The sender a brief record names. It is not a seat and not the owner: a reply to the brief has
 *  no one to reach, and `team reply` says so rather than writing to a seat that does not exist. */
export const GENERAL_BRIEF_FROM = 'the launch';

/** The brief's record id: a lowercase UUID derived from the text, so the same brief has one id in
 *  every seat's folder and a record already at it is verified and kept. The bare brief is hashed
 *  exactly as it always was; a brief that also passes a handover on (a swap that cannot resume
 *  the old conversation) is hashed as the whole body it writes, so its id is that run's alone. */
export function generalBriefId(body: string = GENERAL_BRIEF): string {
  const hex = createHash('sha256').update(body).digest('hex').slice(0, 32).split('');
  // The version and variant nibbles of a name-derived UUID: any lowercase UUID is a valid record
  // id, and these keep the id inside RFC 4122's shape.
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  const id = hex.join('');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`;
}

/** The body a seat reads: the sender header every drop carries, then the brief. A handover file
 *  the predecessor wrote goes last, before anything else the seat is asked to do. */
export function generalBriefBody(handover?: string): string {
  const passed = handover === undefined ? '' : `\n\nBefore anything else, read the handover your predecessor wrote: ${handover}`;
  return `from ${GENERAL_BRIEF_FROM} — admitted by: ${GENERAL_BRIEF_RULE}\n\n${GENERAL_BRIEF}${passed}`;
}

/** The record the launch writes for one seat. `to_id` and `from_id` are null: the launch is not
 *  a registry seat, and the receiving seat's id is the registry's to add, not the drop's. */
export function generalBriefRecord(input: { to: string; root: string; session: string; at: string; handover?: string }): RecordPayload {
  const body = generalBriefBody(input.handover);
  const id = generalBriefId(input.handover === undefined ? GENERAL_BRIEF : body);
  return {
    kind: 'message',
    id,
    to: input.to,
    to_id: null,
    root: input.root,
    session: input.session,
    at: input.at,
    body,
    from: GENERAL_BRIEF_FROM,
    from_id: null,
    rule: GENERAL_BRIEF_RULE,
    thread: id,
  };
}

export type BriefDelivery =
  | { seat: string; ok: true; id: string; at: string; existing?: true }
  | { seat: string; ok: false; reason: string };

export type BriefDeliveryReport = {
  deliveries: BriefDelivery[];
  /** Why the state could not record the deliveries, when it could not. The drops are on disk. */
  recording?: string;
};

/**
 * Writes the brief into each named seat's drop folder and records the delivery in the session's
 * `briefs` map, one state write for the whole run. The name is derived from the text, so a file
 * already at it counts only when it is this brief and this checkout's message key signed it: a
 * planted or foreign file there is replaced through the signed record writer, and only a record
 * read back and verified is recorded as delivered. A name held by a link, a folder or a FIFO is
 * refused and never followed or replaced. A drop that cannot be written is reported for its
 * seat and does not stop the others: the launch is not the message, and `team check` names the
 * seat that has no verified record. The record's own time is the delivery's, so a re-run after
 * a lost state file records when the seat first received it, never the re-run's clock.
 */
export function deliverGeneralBrief(input: {
  dir: string;
  root: string;
  session: string;
  seats: readonly string[];
  home: string;
  at?: string;
  /** The handover file the old conversation wrote, passed on through the brief. */
  handover?: string;
}): BriefDeliveryReport {
  const at = input.at ?? new Date().toISOString();
  const deliveries: BriefDelivery[] = [];
  const recorded: Record<string, { id: string; at: string; handover?: string }> = {};
  for (const seat of input.seats) {
    const payload = generalBriefRecord({
      to: seat,
      root: input.root,
      session: input.session,
      at,
      ...(input.handover === undefined ? {} : { handover: input.handover }),
    });
    const dropDir = join(input.root, '.agents', 'send-drops', input.session, seat);
    const path = recordFile(dropDir, payload.id);
    // An existing record is left as it is; anything else at the name is replaced below, so the
    // seat never misses the brief because a file was planted at its derived id.
    const existing = recordHolds(path, payload, input.home);
    if (!existing) {
      let signed;
      try {
        signed = signRecord(payload, input.home);
      } catch {
        deliveries.push({ seat, ok: false, reason: 'no message key; the general brief was not delivered' });
        continue;
      }
      const written = writeRecordOver(dropDir, signed);
      if (!written.ok) {
        deliveries.push({ seat, ok: false, reason: written.reason });
        continue;
      }
      if (!recordHolds(written.path, payload, input.home)) {
        deliveries.push({ seat, ok: false, reason: 'the record written for the brief does not verify' });
        continue;
      }
    }
    // The record's own time is the delivery's: on a re-run it is the first run's. It is read
    // back after the write, so what the state records is what the seat will read.
    const read = readRecord(path, payload.id);
    const deliveredAt = read.ok && read.record !== null ? read.record.payload.at : at;
    recorded[seat] = {
      id: payload.id,
      at: deliveredAt,
      ...(input.handover === undefined ? {} : { handover: input.handover }),
    };
    deliveries.push({ seat, ok: true, id: payload.id, at: deliveredAt, ...(existing ? { existing: true } : {}) });
  }
  if (Object.keys(recorded).length === 0) return { deliveries };
  try {
    updateState(input.dir, (state) => {
      const current = (state.sessions[input.session] ??= emptySession());
      current.briefs = { ...current.briefs, ...recorded };
    });
  } catch (error) {
    return { deliveries, recording: error instanceof Error ? error.message : String(error) };
  }
  return { deliveries };
}
