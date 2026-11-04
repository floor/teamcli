// The one frame the cross-session socket channel carries, and the line every frame ends with:
// how its receiver answers, and how it says it read the message without answering.
//
// A frame is normally transport, never the record: the signed copy lands in the receiver's folder
// first, and the frame is what its CLI shows. Under `messaging.store: none` there is no stored
// copy, so the frame carries the signed record's bytes itself (`record`) — signed, never stored —
// and a reader verifies those bytes with `carriedRecordOf` exactly as it would have verified the
// file in the drop folder.
// and the frame is what its CLI shows. The reader line names the message id — the same id the
// frame carries in `msg_id` — because an answering seat runs `team reply <id>` and a seat that
// needs no answer runs `team ack <id>`, and both acts write the seat's own signed read receipt.
// An earlier build kept the id out of the content; ADR D3 supersedes that: the line cannot tell
// a reader what to run without it, and the id is no secret. The line is one line, the same for
// every sender — the owner included — because both commands address the record by id, never by
// the sender's name.

/**
 * The line every socket frame ends with. It names the message id twice — once for the answer
 * that marks the message read, once for the acknowledgement that needs no answer — so a reader
 * who saw the frame can settle it with the record they were given. One line, exactly:
 * `Answer with team reply <id> "…" (this marks it read), or team ack <id> if no answer is needed.`
 */
export function readerLine(msgId: string): string {
  return `Answer with team reply ${msgId} "…" (this marks it read), or team ack ${msgId} if no answer is needed.`;
}

/** The one frame this channel carries: `type:"user"`, the whole body, the reader line as its own
 *  last line when the seat has one, and the id. A person-pane seat gets no reader line — a person
 *  answers in their own client — and the id stays in `msg_id` beside the line's own copy. */
export function frameFor(body: string, msgId: string, reply: string | null, carried?: string): string {
  const content = reply === null ? body : `${body}\n\n${reply}`;
  const frame: { type: 'user'; message: { role: 'user'; content: string }; msg_id: string; record?: string } = {
    type: 'user',
    message: { role: 'user', content },
    msg_id: msgId,
  };
  if (carried !== undefined) frame.record = carried;
  return `${JSON.stringify(frame)}\n`;
}
