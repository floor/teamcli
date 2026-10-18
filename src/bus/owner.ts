// Owner delivery (RFC 002 Amendment 01 §4.5): what the policy routes to the owner is delivered by
// the Runtime itself — the machine notification the watch raises and the owner's own tool's inbox,
// with no seat in the path. The inbox is the mailbox `team messages` already reads: one signed
// record under `.agents/messages/owner/`, written here, so his list is one list and the liaison
// connector reads the same records. Nothing here waits on a seat, and a held or unreachable seat
// silences neither the notification nor the record.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { TeamFile } from '../file/types.ts';
import { messageFile, type MessagePayload } from '../commands/messages.ts';
import { teamIdOf } from '../registry/teams.ts';
import { type Json, messageKeyOf, MESSAGE_DOMAIN, signDomain } from '../store/keys.ts';
import {
  isOwnerAtOnce,
  leadSeatsOf,
  recipientsForEvent,
  type EventKind,
  type SeatRecipientResolver,
  type TeamRoutingRoles,
} from './kinds.ts';
import type { EventPayload } from './log.ts';
import type { RoutingChain } from './routing.ts';
import { readSeatResolver } from './seats.ts';

/** The mailbox the owner's own `team messages` run reads. `owner` is the seat-equivalent name the
 *  bus already knows (Amendment 01 §4.4). */
export const OWNER_MAILBOX = 'owner';

/** The writer the record names: the Runtime, never a seat. */
export const OWNER_RECORD_FROM = 'runtime';

/** The shape `ownerDigestId` writes. A digest is a summary of events already delivered, not a
 *  message: it must never raise `message.arrived` or be batched into a later digest. */
const OWNER_DIGEST_ID = /^digest-[0-9a-f]{16}$/;

/** Whether a record is one of the Runtime's own owner delivery summaries. The writer is part of
 *  the identity: a message a seat happens to name `digest-…` still names its seat as `from`, so it
 *  stays a message. */
export function isOwnerDigestRecord(id: unknown, from?: unknown): boolean {
  return typeof id === 'string' && from === OWNER_RECORD_FROM && OWNER_DIGEST_ID.test(id);
}

const MAX_OWNER_LINE = 500;

export type OwnerDeliveryInput = {
  root: string;
  session: string;
  team: TeamFile;
  /** Without a home the record cannot be signed; the notification still goes. */
  home?: string;
  notify: (text: string) => void;
  now?: () => Date;
  /** Texts the watch has already told the owner this process (its own reports): the same words
   *  must not be a second notice. */
  alreadyTold?: (text: string) => boolean;
  /** The routing chain in force. The release defaults are the fold's base, always. */
  chain?: RoutingChain;
  /** The owner's immediacy list in force; the setting's release default when the policy layer
   *  supplies none (see `OWNER_AT_ONCE_SETTING` in `./kinds.ts`). */
  atOnceKinds?: readonly EventKind[];
};

export type OwnerDeliveryOutcome = {
  addressed: boolean;
  notified: boolean;
  recorded: boolean;
  error?: string;
};

/** Delivers owner-routed events for one pass of the watch. */
export class OwnerDelivery {
  private readonly input: OwnerDeliveryInput;
  private readonly now: () => Date;
  private readonly resolveSeat: SeatRecipientResolver | undefined;
  /** Routine owner events of this pass: batched into one summary record at `flush`. */
  private routine: { event: EventPayload; text: string }[] = [];

  constructor(input: OwnerDeliveryInput) {
    this.input = input;
    this.now = input.now ?? (() => new Date());
    this.resolveSeat = input.home === undefined ? undefined : readSeatResolver(input.home, teamIdOf(input.root));
  }

  /** Delivers one verified event. An event on the owner's immediacy list rings and lands as its
   *  own record; everything else waits in the pass's batch for `flush` (§10). Returns whether the
   *  event was addressed to the owner, so the caller can tell a delivery from an event the owner
   *  is not in. */
  onEvent(event: EventPayload): OwnerDeliveryOutcome {
    if (!isOwnerAddressed(event, this.input.team, this.input.chain, this.resolveSeat)) {
      return { addressed: false, notified: false, recorded: false };
    }
    // The Runtime's own summaries of earlier deliveries are not news: a rescan of the mailbox (or
    // a replay of a log that still carries them) must not batch a digest into a digest of itself.
    if (isOwnerDigestRecord(event.record_id, event.from)) {
      return { addressed: true, notified: false, recorded: false };
    }
    const text = ownerDeliveryText(event);
    if (!this.atOnce(event)) {
      this.routine.push({ event, text });
      return { addressed: true, notified: false, recorded: false };
    }

    const id = ownerRecordId(event);
    const path = this.input.home === undefined ? undefined : messageFile(this.input.root, OWNER_MAILBOX, id);
    const recordedBefore = path !== undefined && existsSync(path);

    // The record's presence is the delivery's own memory: a watch restarted from cursor 0 reads
    // old events again and must not ring the owner a second time for them.
    let notified = false;
    if (!recordedBefore && !(this.input.alreadyTold?.(text) ?? false)) {
      this.input.notify(text);
      notified = true;
    }

    if (path === undefined) return { addressed: true, notified, recorded: false };
    if (recordedBefore) return { addressed: true, notified, recorded: true };
    const written = this.record(id, text, event.session);
    return { addressed: true, notified, recorded: written.ok, ...(written.ok ? {} : { error: written.error }) };
  }

  /** Writes the pass's routine owner events as one summary record, so the owner's list holds one
   *  batch rather than a notice per event. Called at the end of every pass. */
  flush(): OwnerDeliveryOutcome | undefined {
    if (this.routine.length === 0) return undefined;
    const batch = this.routine;
    this.routine = [];
    const id = ownerDigestId(batch.map((entry) => entry.event));
    if (this.input.home === undefined) return { addressed: true, notified: false, recorded: false };
    if (existsSync(messageFile(this.input.root, OWNER_MAILBOX, id))) {
      return { addressed: true, notified: false, recorded: true };
    }
    const body = `${String(batch.length)} event${batch.length === 1 ? '' : 's'}: ${batch.map((entry) => entry.text).join('; ')}`;
    const written = this.record(id, body, this.input.session);
    return { addressed: true, notified: false, recorded: written.ok, ...(written.ok ? {} : { error: written.error }) };
  }

  private atOnce(event: EventPayload): boolean {
    return isOwnerAtOnce(
      event.kind,
      {
        ...(event.seat === undefined ? {} : { seat: event.seat }),
        ...(event.prompt === undefined ? {} : { prompt: event.prompt }),
        leadSeats: leadSeatsOf(this.input.team),
      },
      this.input.atOnceKinds,
    );
  }

  private record(
    id: string,
    text: string,
    session: string,
  ): { ok: true } | { ok: false; error: string } {
    const home = this.input.home;
    if (home === undefined) return { ok: false, error: 'no home to sign the record with' };
    return writeRuntimeMailboxRecord({
      root: this.input.root,
      home,
      to: OWNER_MAILBOX,
      id,
      text,
      session,
      at: this.now().toISOString(),
    });
  }
}

export type RuntimeMailboxRecordInput = {
  root: string;
  home: string;
  /** The mailbox the record lands in: `owner`, or a seat's own name. */
  to: string;
  id: string;
  text: string;
  session: string;
  /** The instant the record carries; `new Date()` when absent. */
  at?: string;
};

/** Writes one signed message into a mailbox as the Runtime — the writer the owner's delivery
 *  path already used, shared so a command that speaks to the owner or the lead writes the same
 *  record (mode 0600, renamed into place). It writes unconditionally: the callers that must not
 *  repeat themselves check the mailbox first (`OwnerDelivery`), and a merge rewrites the one
 *  record it counts. */
export function writeRuntimeMailboxRecord(
  input: RuntimeMailboxRecordInput,
): { ok: true; path: string } | { ok: false; error: string } {
  const payload: MessagePayload = {
    kind: 'message',
    id: input.id,
    to: input.to,
    root: input.root,
    session: input.session,
    at: input.at ?? new Date().toISOString(),
    body: input.text,
    from: OWNER_RECORD_FROM,
  };
  let signature: string;
  try {
    signature = signDomain(MESSAGE_DOMAIN, payload as unknown as Json, messageKeyOf(input.home));
  } catch (error) {
    return { ok: false, error: `the message key could not be read: ${String(error)}` };
  }
  const path = messageFile(input.root, input.to, input.id);
  try {
    writePrivateAtomic(path, `${JSON.stringify({ payload, signature }, null, 2)}\n`);
  } catch (error) {
    return { ok: false, error: String(error) };
  }
  return { ok: true, path };
}

/** Whether the event is addressed to the owner: routed to `owner` by the policy in force, or
 *  addressed to `owner` by the raising side (the watch's owner-addressed reports, §4.5). */
export function isOwnerAddressed(
  event: EventPayload,
  team: TeamRoutingRoles,
  chain?: RoutingChain,
  resolveSeat?: SeatRecipientResolver,
): boolean {
  if (event.to === 'owner') return true;
  return recipientsForEvent(event, team, undefined, chain ?? [], resolveSeat).has('owner');
}

/** The one line the owner reads for an event. A watch report already says what it saw, so its own
 *  words are the delivery; any other event is described by its kind, the seat it concerns, and its
 *  detail. Whitespace is folded: the mailbox body is one line. */
export function ownerDeliveryText(event: EventPayload): string {
  if (event.to === 'owner' && event.reason !== undefined) return clip(event.reason);
  const where = event.seat === undefined ? '' : ` ${event.seat}`;
  const why = event.prompt ?? event.rule ?? event.reason;
  const detail = why === undefined ? '' : `: ${why}`;
  return clip(`${event.kind}${where}${detail}`);
}

/** The record id: deterministic per event, so a re-delivered event finds its record and is silent.
 *  `evt-<seq>-<12 hex>` fits the mailbox name rule (`[A-Za-z0-9._-]`, 81 characters at most). */
export function ownerRecordId(event: EventPayload): string {
  const digest = createHash('sha256')
    .update(`${event.kind}\u0000${event.record_id}\u0000${String(event.seq)}`)
    .digest('hex')
    .slice(0, 12);
  return `evt-${String(event.seq)}-${digest}`;
}

/** The summary record's id: its batch's own content, so a restart that re-reads and re-batches
 *  the same events finds the record already written and writes nothing. */
export function ownerDigestId(events: readonly EventPayload[]): string {
  const digest = createHash('sha256')
    .update(events.map((event) => ownerRecordId(event)).join('\u0000'))
    .digest('hex')
    .slice(0, 16);
  return `digest-${digest}`;
}

function clip(text: string): string {
  const folded = text.replace(/\s+/g, ' ').trim();
  return folded.length <= MAX_OWNER_LINE ? folded : `${folded.slice(0, MAX_OWNER_LINE - 1)}…`;
}

/** One record, mode 0600, written beside its mailbox as a temporary file and renamed into place,
 *  so a reader never sees half a record. */
function writePrivateAtomic(path: string, text: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temporary file is already gone; the rename's error is the report.
    }
    throw error;
  }
}
