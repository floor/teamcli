// No pane messaging (0.5.9, the owner's absolute rule of 2026-10-31): no agent is ever reached by
// typing into its pane or prompt. Every message, wake, reminder, nudge, rules line and handover
// goes through the bus and a vendor's event adapter (the Claude development channel or hooks, an
// MCP inbox, a CLI's own runtime queue); a seat with no event path keeps the message in its bus
// inbox, and the sender is told `queued, no event adapter`. These are the chokepoints that used
// to type: each now refuses before touching the pane. Owner-initiated pane acts that are not
// messaging (starting a CLI in a pane, its exit keys, answering a permission dialog) are not here.
// test/no-pane-messaging.test.ts holds every messaging module to this.

export const NO_PANE_MESSAGING = 'typing into a seat\'s pane is never a delivery: messages go through the bus and an event adapter';
export const QUEUED_NO_EVENT_ADAPTER = 'queued, no event adapter';
/** Why a walk that had event legs still ended in the bus inbox. */
export const NO_EVENT_ADAPTER_TOOK_IT = 'no event adapter of this seat took it';

/** The line `team send` writes to stderr when the drop leg — the bus inbox, never a wake — takes
 *  a send. */
export function queuedLine(seat: string, why: string = NO_PANE_MESSAGING): string {
  return `team send: ${seat}: ${QUEUED_NO_EVENT_ADAPTER} (${why}); the message waits in its bus inbox\n`;
}

/** The delivery legs that type into a pane. They are never walked. The `native` leg is not one:
 *  it hands a pointer to a Codex seat's own runtime queue (or a Claude sender's SendMessage),
 *  an event adapter with nothing typed; the pane-typing trigger in src/send/native.ts refuses. */
export const TYPING_LEGS = ['typed'] as const;

export function isTypingLeg(leg: string): boolean {
  return (TYPING_LEGS as readonly string[]).includes(leg);
}

/** A pane writer that writes nothing: what every messaging path binds instead of herdr. */
export const refuseTyping = (): false => false;
