// Reporting only: these facts never enqueue, retry, admit, or settle a message.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { appendStoreLine, readStoreLines } from './history.ts';
import { writeRuntimeNotice } from './endpoint-notice.ts';
import { isReadOrCleared, type RecordPayload } from './record.ts';
import { messageKeyState } from '../store/keys.ts';
import { storePath } from '../store/store.ts';

const REPORTS = 'held-send-reports.jsonl';
type Scope = { project: string; root: string; home: string; session: string; lead: string };
type HeldReport = {
  kind: 'held'; session: string; seat: string; id: string; reason: string; at: string; stored: boolean;
};
type Reports = { ok: true; entries: HeldReport[] } | { ok: false; reason: string };

/** Fold the existing guarded state stream, retaining one fact per held send. */
function reportsIn(input: Scope): Reports {
  const read = readStoreLines(storePath(input.project, input.root, input.home), REPORTS, input.home, 'held-send report');
  if (!read.ok) return read;
  const entries = new Map<string, HeldReport>();
  for (const line of read.lines) {
    if (line.trim() === '') continue;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; }
    catch { return { ok: false, reason: 'the held-send report contains an unreadable fact' }; }
    if (value === null || typeof value !== 'object') return { ok: false, reason: 'the held-send report contains an invalid fact' };
    if (typeof value.session !== 'string') return { ok: false, reason: 'the held-send report contains an invalid session' };
    if (value.session !== input.session) continue;
    if (value.kind === 'preflight-cleared' && typeof value.seat === 'string') {
      for (const [key, entry] of entries) {
        if (entry.seat === value.seat && !entry.stored) entries.delete(key);
      }
      continue;
    }
    if (value.kind !== 'held' || typeof value.seat !== 'string' || typeof value.id !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.seat) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.id)
      || typeof value.reason !== 'string' || typeof value.at !== 'string' || typeof value.stored !== 'boolean') {
      return { ok: false, reason: 'the held-send report contains an invalid fact' };
    }
    entries.set(`${value.seat}\0${value.id}`, {
      kind: 'held', session: value.session, seat: value.seat, id: value.id,
      reason: value.reason, at: value.at, stored: value.stored,
    });
  }
  const key = messageKeyState(input.home);
  return {
    ok: true,
    entries: [...entries.values()].filter((entry) => !entry.stored || key.kind !== 'key' || !isReadOrCleared(
      join(input.root, '.agents', 'send-drops', input.session, entry.seat), entry.id,
      { root: input.root, session: input.session, to: entry.seat, lead: input.lead }, key.key,
    )),
  };
}

/** Record a hold before notifying the lead; a failed write is returned to the sender. */
export function reportHeldSend(input: Scope & {
  seat: string; id: string; reason: string; at: string; stored: boolean;
  prepareOnly?: boolean;
}): { ok: true; count: number; notice: RecordPayload; existing: boolean } | { ok: false; reason: string } {
  const written = appendStoreLine(input.project, input.root, input.home, REPORTS, {
    kind: 'held', session: input.session, seat: input.seat, id: input.id,
    reason: input.reason, at: input.at, stored: input.stored,
  }, { rotate: false, label: 'held-send report' });
  if (!written.ok) return written;
  const reading = reportsIn(input);
  if (!reading.ok) return reading;
  const count = reading.entries.filter((entry) => entry.seat === input.seat).length;
  if (input.lead === '') return { ok: false, reason: 'the receiving team names no lead for the held-send notice' };
  // One notice per original id, including across a restart or a repeated daemon result.
  const hash = createHash('sha256').update(`${input.session}\0${input.seat}\0${input.id}`).digest('hex');
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const kept = input.stored ? 'the message is kept; no delivery is claimed' : 'the body was not read or kept; the sender must retry after repair';
  const notice = writeRuntimeNotice({
    ...input, id,
    body: `${input.seat}: ${String(count)} held send${count === 1 ? '' : 's'}; ${input.reason}; ${kept}`,
  });
  return notice.ok ? { ok: true, count, notice: notice.payload, existing: notice.existing } : notice;
}

/** Passing the same preflight ends its reporting episode, without claiming delivery. */
export function clearPreflightReports(input: Scope & { seat: string; at: string }): string | null {
  const reading = reportsIn(input);
  if (!reading.ok) return reading.reason;
  if (!reading.entries.some((entry) => entry.seat === input.seat && !entry.stored)) return null;
  const written = appendStoreLine(input.project, input.root, input.home, REPORTS, {
    kind: 'preflight-cleared', session: input.session, seat: input.seat, at: input.at,
  }, { rotate: false, label: 'held-send report' });
  return written.ok ? null : written.reason;
}

/** Counts share status's existing notes, so both text and structured output show the hold. */
export function heldSendNotes(input: Scope): string[] {
  const reading = reportsIn(input);
  if (!reading.ok) return [`held sends: count unknown (${reading.reason})`];
  const grouped = new Map<string, HeldReport[]>();
  for (const entry of reading.entries) {
    const group = grouped.get(entry.seat) ?? [];
    group.push(entry);
    grouped.set(entry.seat, group);
  }
  return [...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([seat, entries]) => {
    const reasons = [...new Set(entries.map((entry) => entry.reason))].join('; ');
    const unstored = entries.filter((entry) => !entry.stored).length;
    const retry = unstored === 0 ? '' : `; ${String(unstored)} bodies not kept, sender retry required`;
    return `${seat}: ${String(entries.length)} held send${entries.length === 1 ? '' : 's'} — ${reasons}${retry}`;
  });
}
