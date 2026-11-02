// A public-only seat's brief never reaches a service this machine does not run.
//
// A CLI profile says so when its sessions live on a hosted service (Jules), and a team file may
// mark one seat the same way. Two things follow for a send to such a seat. The team's rules are
// never prepended to the brief: the rules are the team's own text, written for seats on this
// machine, and a public service reads the whole body it is handed. And the body is read against
// the machine's private lists before the CLI's session call: a hit is a route that did not take
// the send — the walk falls through to the leg behind it, so the message still lands locally —
// and the reason names the rule by its source, class and ordinal, never the matched text.
//
// The list read is the pre-push gate's own (`src/check/private-names.ts`), with the diff scope:
// text that leaves the machine. A list that is absent is no list — the machine has nothing
// configured to protect, and every send would otherwise refuse on every machine but this one. A
// list that is there and cannot be read refuses the body: a configured guard that cannot look
// must not pass a message.
import {
  defaultPrivateListPaths,
  readPrivateList,
  scanPrivateLines,
  type PrivateLineHit,
  type PrivateSource,
} from '../check/private-names.ts';

/** The two external private lists a public-only body is read against. */
export interface PrivateListPaths {
  names: string;
  phrases: string;
}

/** The parts of a profile and a seat the guard reads: the profile's word is always present (false
 *  when it says nothing), and a seat's mark is only ever `true` — the parser omits the key a file
 *  writes as false. */
type ProfileWord = { publicOnly: boolean };
type SeatMark = { publicOnly?: true };

/** True when the receiving seat is public-only: its profile says so, or the team file marks it.
 *  A seat's word can only add the guard — `public_only: false` reads as absent when the team file
 *  is parsed, so the profile's word stands. */
export function isPublicOnly(profile: ProfileWord | null | undefined, seat: SeatMark | undefined): boolean {
  return profile?.publicOnly === true || seat?.publicOnly === true;
}

export type PublicBodyScan =
  | { ok: true; rules: number }
  | { ok: false; why: string };

/** One hit as the send names it: where the rule came from, and which entry — never the text. */
function ruleName(hit: PrivateLineHit): string {
  const className = hit.className === undefined ? '' : ` class ${hit.className}`;
  return `${hit.origin}${className} entry ${String(hit.ordinal)}`;
}

/**
 * Reads a whole outgoing body against the two lists. The first hit is the one named; the body is
 * supplied as its own lines, so a hit is reported by entry and line and the matched text never
 * leaves the scanner. Left out, the lists are the machine's default paths.
 */
export function scanPublicBody(body: string, lists: PrivateListPaths | undefined): PublicBodyScan {
  const paths = lists ?? defaultPrivateListPaths();
  const sources: PrivateSource[] = [];
  for (const [label, path] of [['names', paths.names], ['phrases', paths.phrases]] as const) {
    const read = readPrivateList(path, label);
    if ('problem' in read) return { ok: false, why: `the body cannot be checked against the private lists (${read.problem})` };
    if ('missing' in read) continue;
    sources.push(read.source);
  }
  if (sources.length === 0) return { ok: true, rules: 0 };
  const scan = scanPrivateLines(body.split('\n'), sources);
  if ('problem' in scan) return { ok: false, why: `the body cannot be checked against the private lists (${scan.problem})` };
  const hit = scan.hits[0];
  if (hit !== undefined) return { ok: false, why: `the body matches a private rule (${ruleName(hit)})` };
  return { ok: true, rules: scan.rules };
}
