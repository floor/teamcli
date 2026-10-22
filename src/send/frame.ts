// The one frame the cross-session socket channel carries, and the line every frame ends with:
// where its receiver answers.
//
// A frame is transport, never the record: the signed copy lands in the receiver's folder first,
// and the frame is what its CLI shows. The reply line is built from the values that copy carries
// — the record's own sender, and the team the sending run stands in — so an answer is addressed
// to the seat that wrote, never to a name read off the body or guessed from a session. The owner
// is not a seat: an owner-origin line names the entity's declared `owner-reply-to` target, and a
// frame that cannot say where to answer is not dialed at all.

import { resolveOwnerReplyTo } from '../policy/owner-reply.ts';
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

/** Where an owner-origin frame's answer goes: the line, or the reason there is no address. */
export type FrameReply = { line: string } | { missing: string };

/**
 * The reply line a frame ends with. A seat-origin message names the signed sender in the team
 * this run stood in. The owner is the person's own terminal, not a seat `team send` can reach,
 * so an owner-origin message names the entity's `owner-reply-to` target — the floor's own
 * `orchestrator@floor` when it declares no other — and an entity that names none says so
 * rather than answering at an address no send resolves.
 */
export function frameReplyFor(home: string, root: string, from: string, team: string): FrameReply {
  if (from !== 'owner') return { line: replyLine(home, from, team) };
  const resolved = resolveOwnerReplyTo(root, home, null);
  if (!resolved.ok) {
    return { missing: `the owner's reply target is ${resolved.reason} (${resolved.why}), so the frame carries no reply address` };
  }
  return { line: `Reply with: team send ${resolved.target} "…"` };
}

/** The one frame this channel carries: `type:"user"`, the whole body, the reply line as its own
 *  last line when the seat has one, and the id. A person-pane seat gets no reply line — a person
 *  answers in their own client — and the id stays in `msg_id`, never in the content. */
export function frameFor(body: string, msgId: string, reply: string | null): string {
  const content = reply === null ? body : `${body}\n\n${reply}`;
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content }, msg_id: msgId })}\n`;
}
