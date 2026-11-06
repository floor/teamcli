// A refusal reason in the status feed is the seat's own word. The reader and the lead's
// view quote it and say the seat reported it. Neither surface presents that word as a finding.
import { SEAT_NAME } from '../file/sections/seats.ts';

/** How many characters of the seat's reason a line keeps. The rest is marked cut, outside the quotes. */
export const REASON_CAP = 200;

/** A seat id: the team file's seat name, at most 64 characters. A longer or looser word is not shown. */
function isSeatId(seat: string): boolean {
  return seat.length <= 64 && SEAT_NAME.test(seat);
}

/** DEL, C1, the Unicode line and paragraph separators, and the bidi controls. */
function hidden(code: number): boolean {
  if (code === 0x7f) return true;
  if (code >= 0x80 && code <= 0x9f) return true;
  if (code === 0x2028 || code === 0x2029) return true;
  if (code === 0x61c || code === 0x200e || code === 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return false;
}

/** One quoted reason. C0 controls, DEL, C1, line separators and bidi controls are `\\u` escapes. */
function quoteReason(text: string): string {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === '"' || char === '\\') {
      out += `\\${char}`;
      continue;
    }
    if (code <= 0x1f || hidden(code)) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += char;
  }
  out += '"';
  return out;
}

/** The line both surfaces show. An invalid seat name is not interpolated. A long reason is cut. */
export function reportedBySeat(seat: string, reason: string): string {
  const who = isSeatId(seat) ? seat : 'a seat';
  const points = Array.from(reason);
  const cut = points.length > REASON_CAP;
  const kept = (cut ? points.slice(0, REASON_CAP) : points).join('');
  return `${who} reported ${quoteReason(kept)}${cut ? ' [cut]' : ''}`;
}

/** The status-feed reader's line for one refusal reason. */
export function statusReaderReason(seat: string, reason: string): string {
  return reportedBySeat(seat, reason);
}

/** The lead's view of the same reason. It uses the reader's line, not a second wording. */
export function statusLeadReason(seat: string, reason: string): string {
  return reportedBySeat(seat, reason);
}
