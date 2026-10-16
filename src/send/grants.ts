// The owner's standing send-grants: records in the same grants folder the entity create-grants
// live in (`~/.config/team/grants/`), whose `send` mapping names the pair it admits and whose
// `expires` says when it stops:
//
//   send:
//     from: builder-1@labs     # agent id, seat@team or session/seat
//     to: lead@teamcli         # the same spellings; a bare seat is the sender's own team's
//   expires: "2026-10-17T00:00:00Z"
//
// This module reads the folder and shapes the records; whether one admits a given pair — the
// sender's identity, the receiver, the clock — is `sendGrantFor` in `admit.ts`, a decision over
// records with no reads of its own.

import { homedir } from 'node:os';
import { readGrantRecords } from '../grant.ts';
import type { SendGrantRecord } from './admit.ts';

/** The send-grants the owner has standing: every record in the grants folder whose `send`
 *  mapping names a `from` and a `to` and whose expiry parses. A record missing any of the three
 *  is not a grant and is left out; the folder's own integrity (plain files, no symlinks) and the
 *  file shapes are `readGrantRecords`'. */
export function readSendGrants(home: string = homedir()): SendGrantRecord[] {
  const out: SendGrantRecord[] = [];
  for (const { stem, record } of readGrantRecords(home)) {
    const send = record.send;
    if (send === null || typeof send !== 'object' || Array.isArray(send)) continue;
    const pair = send as Record<string, unknown>;
    const from = typeof pair.from === 'string' ? pair.from.trim() : '';
    const to = typeof pair.to === 'string' ? pair.to.trim() : '';
    if (from === '' || to === '') continue;
    const rawExpires = record.expires ?? record.expiry ?? record.expires_at ?? record.expiresAt;
    if (typeof rawExpires !== 'string' || rawExpires.trim() === '') continue;
    const expires = rawExpires.trim();
    if (!Number.isFinite(Date.parse(expires))) continue;
    const named = typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : stem;
    out.push({ name: named, from, to, expires });
  }
  return out;
}
