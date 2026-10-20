// Refusal events (owner at-once): `record.invalid` and `security.refused`.
//
// A command that refuses work raises one of these two events so the owner hears the rule that
// was broken rather than a silence. The event names the rule and the object — a record id, a
// seat, a path — and never the tampered or refused content: the producer hands this module the
// names only, and nothing here reads a body.
//
// Owner delivery has its own path (`src/bus/owner.ts`): the watch routes the event to `owner`,
// rings the machine notification and writes one signed record in the owner's mailbox. Both
// kinds are on the owner's immediacy list, so neither waits for a digest.
//
// A refusal loop must not flood the owner. The record id is deterministic per rule, object and
// dedupe window (`REFUSAL_DEDUPE_SECONDS`), so the event log's own `(kind, record_id, session)`
// dedupe holds one event per window while every occurrence still writes one `.agents/team.log`
// line — the occurrences are counted in the log, and the owner reads one event.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { logLine } from '../log.ts';
import { appendEvent } from './log.ts';

/** One refusal per rule and object within this window; a repeat is counted, not repeated. */
export const REFUSAL_DEDUPE_SECONDS = 60 * 60;

export type RefusalEventKind = 'record.invalid' | 'security.refused';

/** The object a refusal names. `id` is the record id or the target seat, `seat` the seat the
 *  refusal concerns, and `path` where the record stands. No field ever carries a body. */
export type RefusalObject = {
  id?: string;
  seat?: string;
  path?: string;
};

export type RaiseRefusalInput = {
  project: string;
  root: string;
  home: string;
  session: string;
  kind: RefusalEventKind;
  /** The rule that refused: `signature`, `seat`, `session`, `root`, `shape`, `key`,
   *  `placement` or `admission`. */
  rule: string;
  object: RefusalObject;
  now?: Date;
};

/** The event's deterministic id: kind, rule and object inside one window bucket. Two calls in
 *  the same window with the same rule and object name the same event; the next window's call
 *  names a new one. */
export function refusalRecordId(kind: RefusalEventKind, rule: string, object: RefusalObject, at: Date): string {
  const digest = createHash('sha256')
    .update([kind, rule, object.id ?? '', object.seat ?? '', object.path ?? ''].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
  const bucket = Math.floor(at.getTime() / 1000 / REFUSAL_DEDUPE_SECONDS);
  return `${kind}-${rule}-${digest}-${String(bucket)}`;
}

/** Raises one refusal event, best effort: a refusal's own printed answer and exit never depend
 *  on the log or the mailbox being writable. Returns true when this call wrote a new event, and
 *  false when the event already stood for this window (or could not be written). */
export function raiseRefusalEvent(input: RaiseRefusalInput): boolean {
  const at = input.now ?? new Date();
  const recordId = refusalRecordId(input.kind, input.rule, input.object, at);
  const objectText = [input.object.id, input.object.seat, input.object.path].filter((part) => part !== undefined && part !== '').join(' ');
  let raised = false;
  let duplicate = false;
  try {
    const appended = appendEvent(input.project, input.root, input.home, {
      ts: at.toISOString(),
      kind: input.kind,
      session: input.session,
      record_id: recordId,
      rule: input.rule,
      ...(input.object.seat !== undefined ? { seat: input.object.seat } : {}),
      ...(input.object.id !== undefined ? { subject: input.object.id } : {}),
      ...(input.object.path !== undefined ? { reason: input.object.path } : {}),
    });
    raised = appended.ok && !appended.duplicate;
    duplicate = appended.ok && appended.duplicate;
  } catch {
    // The refusal stands whatever the store answers; the log line below is the fallback.
  }
  logLine(
    join(input.root, '.agents'),
    'refusal',
    input.object.seat ?? 'runtime',
    `${input.kind} ${input.rule}${objectText === '' ? '' : ` ${objectText}`}${duplicate ? ' (already raised this window)' : ''}`,
    at,
  );
  return raised;
}
