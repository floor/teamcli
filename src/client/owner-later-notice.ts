// The later answer's one word to a team: when the owner puts off a card that names a blocked
// team, that team's lead is told once, in a plain signed note. The note says what wrote it — the
// owner page, the page the owner's own device answers — and claims nothing more: it is signed
// with the checkout's message key, which proves the note was not changed after it was written,
// not who the owner is. No admission rule is added or relaxed for it; a lead's readers show it as
// the owner page because that is the record's `from`, exactly as a seat's message names its seat.

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordDir } from '../commands/messages.ts';
import { findTeam } from '../registry/teams.ts';
import { recordTextOf, signRecord, type RecordPayload } from '../send/record.ts';

export type DeferralNotice = {
  /** One plain sentence the page shows the owner: who was told, or why no one was. */
  notice: string;
  /** Whether a note was written. A deferral stands either way. */
  wrote: boolean;
};

/**
 * Writes one note to the named team's lead that `requestId` is put off until `until`. Exactly one
 * note per call: the note's id is minted here and its file is written once, never replaced. A
 * team that cannot be resolved, or whose roster names no lead, keeps the deferral and says so.
 */
export function noteDeferral(
  home: string,
  args: { team: string | null; requestId: string; until: string; word: string; now: Date },
): DeferralNotice {
  if (args.team === null) return { notice: 'No note was left: no team is blocked yet by this card.', wrote: false };
  const team = findTeam(home, args.team);
  const lead = team?.roster.find((line) => line.leads === true);
  if (team === null || lead === undefined) {
    return { notice: `The deferral stands, but no lead was told: "${args.team}" is not a team whose lead this build can find.`, wrote: false };
  }
  const id = randomUUID();
  const body = `The owner page put off ${args.requestId} until ${args.until} (the owner answered "${args.word}"). Nothing was approved or denied, and nothing is needed from you until then.`;
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: lead.seat,
    to_id: lead.agent,
    root: team.root,
    session: team.session,
    at: args.now.toISOString(),
    body,
    from: 'owner page',
    from_id: null,
    rule: 'owner page',
    thread: id,
    message_kind: 'blocked',
  };
  const folder = recordDir(team.root, team.session, lead.seat);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, id), recordTextOf(signRecord(payload, home)), { flag: 'wx' });
  return { notice: `The lead of ${args.team} was told: ${args.requestId} waits until ${args.until}.`, wrote: true };
}
