// The one frame the cross-session socket channel carries, and the line every frame ends with:
// where its receiver answers.
//
// A frame is transport, never the record: the signed copy lands in the receiver's folder first,
// and the frame is what its CLI shows. The reply line is built from the values that copy carries
// — the record's own sender, and the team the sending run stands in — so an answer is addressed
// to the seat that wrote, never to a name read off the body or guessed from a session. A frame
// that cannot say where to answer is not dialed at all.

import { findTeam } from '../registry/teams.ts';

/** The team's own name — the team file's `project:` key — or the id no record names, the same
 *  spelling the registry itself addresses the team by. A registry that cannot answer is no
 *  name, and the id still resolves the team. */
function teamNameOf(home: string, team: string): string {
  try {
    return findTeam(home, team)?.project ?? team;
  } catch {
    return team;
  }
}

/** The line every socket frame ends with: the verified sender's address in the sending team. */
export function replyLine(home: string, sender: string, team: string): string {
  return `Reply with: team send ${sender}@${teamNameOf(home, team)} "…"`;
}

/** The one frame this channel carries: `type:"user"`, the whole body, the reply line as its own
 *  last line, and the id. `JSON.stringify` keeps multi-line text one line. */
export function frameFor(body: string, msgId: string, reply: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: `${body}\n\n${reply}` }, msg_id: msgId })}\n`;
}
