// The message path's cascade (ADR message-path, D1): the walk a send makes is the owner's
// cascade, three leg classes tried in a fixed order, and it stops at the first leg taken. The
// signed record is stored before the walk begins, so the mailbox sits under all three classes:
// `channel` reaches the seat through its own live transport (the cross-session socket, Codex's
// native queue, a CLI's own session call, a headless resume, the development-channel push);
// the sender-posted `webhook` is the second class; `typed` is the one composer line; the drop
// leg is the mailbox's own ending and the last resort. The declared `delivery_order` still
// names the legs a seat accepts, but the order it walks them in is this one — a word placing
// the mailbox first no longer stores ahead of a wake, because the store has already happened.
//
// `mcp-inbox` is a retired name, no longer a leg: the MCP inbox is the store's reader, the
// same records `team drops --read` reads, and a push from an MCP server is not a wake. A
// `delivery_order` that still names it keeps the word in the file, and the word is dropped
// from the order before the walk (`src/settings/inherit.ts`) — never an error, never attempted,
// and `team check` names it for removal.
import type { DeliveryLeg } from '../settings/inherit.ts';

/** The class a leg belongs to in the owner's cascade. */
export type LegClass = 'channel' | 'webhook' | 'typed' | 'mailbox';

/** A leg of the walk itself: every word a `delivery_order` can name, and the sender-posted
 *  webhook. No order names the webhook — the receiving seat's adapter row decides whether the
 *  leg exists — but the walk and its report name it like any other leg. */
export type WalkLeg = DeliveryLeg | 'webhook';

/**
 * A leg's class. The webhook is the second class, standing between the channel-class legs and
 * the typed leg; every other name is one of the three classes or the mailbox under them.
 */
export function legClassOf(leg: WalkLeg): LegClass {
  switch (leg) {
    case 'socket':
    case 'native':
    case 'headless-resume':
    case 'channel':
    case 'session':
      return 'channel';
    case 'webhook':
      return 'webhook';
    case 'typed':
      return 'typed';
    case 'drop':
      return 'mailbox';
  }
}

/**
 * The order a send walks: the channel-class legs in the order the receiving seat declared
 * them, then the typed leg, then the mailbox. The function is stable for the legs that are
 * present: a declared `[native, socket]` is walked native then socket, and a declared order
 * with neither class keeps only the legs it names.
 */
export function cascadeOrder(order: readonly DeliveryLeg[]): DeliveryLeg[] {
  const out: DeliveryLeg[] = [];
  for (const cls of ['channel', 'typed', 'mailbox'] as const) {
    for (const leg of order) {
      if (legClassOf(leg) === cls && !out.includes(leg)) out.push(leg);
    }
  }
  return out;
}

/**
 * The walk a send makes when the receiving seat configures a webhook adapter: the channel-class
 * legs in declared order, the sender-posted webhook, then the typed leg, then the mailbox —
 * {@link cascadeOrder}'s list with the webhook inserted after the last channel-class leg. No
 * order names the webhook, so `webhook` is the seat's adapter row, and a seat without one gets
 * exactly {@link cascadeOrder}'s list.
 */
export function cascadeWalk(order: readonly DeliveryLeg[], webhook: boolean): WalkLeg[] {
  const legs: WalkLeg[] = [...cascadeOrder(order)];
  if (!webhook) return legs;
  const at = legs.findIndex((leg) => legClassOf(leg) !== 'channel');
  legs.splice(at < 0 ? legs.length : at, 0, 'webhook');
  return legs;
}
