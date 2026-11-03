// The message path's cascade (ADR zeus-message-path, D1): the walk a send makes is the owner's
// cascade, three leg classes tried in a fixed order, and it stops at the first leg taken. The
// signed record is stored before the walk begins, so the mailbox sits under all three classes:
// `channel` reaches the seat through its own live transport (the cross-session socket, Codex's
// native queue, a CLI's own session call, a headless resume, the development-channel push);
// the sender-posted `webhook` is the second class; `typed` is the one composer line; the drop
// leg is the mailbox's own ending and the last resort. The declared `delivery_order` still
// names the legs a seat accepts, but the order it walks them in is this one — a word placing
// the mailbox first no longer stores ahead of a wake, because the store has already happened.
//
// `mcp-inbox` is not a delivery leg in this build: the MCP inbox is the store's reader, the
// same records `team drops --read` reads, and a push from an MCP server is not a wake. A
// `delivery_order` that names it keeps the name (the catalogue still reads it), and the walk
// reads that word as unavailable: the leg is never attempted, and `team check` notes the word.
import type { DeliveryLeg } from '../settings/inherit.ts';

/** The class a leg belongs to in the owner's cascade. `unavailable` marks a name this build
 *  reads but never walks. */
export type LegClass = 'channel' | 'webhook' | 'typed' | 'mailbox' | 'unavailable';

/** The reason every walk gives for a leg this build reads but never walks. */
export const MCP_INBOX_UNAVAILABLE = 'not a delivery leg in this build; the inbox is the store\'s reader';

/**
 * A leg's class. `mcp-inbox` is `unavailable`: the word is still read from a policy, and the
 * walk says why it was not attempted. Every other name is one of the three classes or the
 * mailbox under them.
 */
export function legClassOf(leg: DeliveryLeg): LegClass {
  switch (leg) {
    case 'socket':
    case 'native':
    case 'headless-resume':
    case 'channel':
    case 'session':
      return 'channel';
    case 'typed':
      return 'typed';
    case 'drop':
      return 'mailbox';
    case 'mcp-inbox':
      return 'unavailable';
  }
}

/**
 * The order a send walks: the channel-class legs in the order the receiving seat declared
 * them, then the typed leg, then the mailbox. `mcp-inbox` words are left out — the caller
 * reports them as skipped, with {@link MCP_INBOX_UNAVAILABLE}. The function is stable for
 * the legs that are present: a declared `[native, socket]` is walked native then socket, and
 * a declared order with neither class keeps only the legs it names.
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

/** The words of an order this build reads but never walks, in the order declared. */
export function unavailableLegsOf(order: readonly DeliveryLeg[]): DeliveryLeg[] {
  return order.filter((leg) => legClassOf(leg) === 'unavailable');
}
