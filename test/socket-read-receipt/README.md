# Socket delivery and the accepted-frame header

Independent, test-only coverage for socket delivery honesty. An accepted socket frame
delivers a message, and a delivery is not a read: only the seat writes the signed read
receipt, verified against the message key — `inbox_read`, `team drops --read`, the CLI
hook's receipt, `team ack`, a `team reply` (which writes one beside its `replied`
receipt), or the seat's own `team send` back to the sender (ADR `zeus-message-path`, D3).
Acceptance therefore writes no receipt, and a record whose frame was taken but never read
stays unread — `team messages` lists it as unacked, the watch's unread pass re-wakes a
socket delivery once at the normal window and, when no seat read comes, the sender and
the lead are told at twice it. A frame the receiver's box held proves nothing and keeps
the watch's ordinary retry.

The scenes are written here and built on the suite's own temporary-world fixtures; none
of the product branch's fixtures are used. No live session, socket or owner home is
touched: the send host's transport is a fake, and the pane is a string.

## Scenes

`fixtures.ts` builds a temporary team whose lead declares `crossSessionInbound: accept`,
with the launch declaration written just before the socket its pane exposes. `book()` is
one pane read by both the send's held-dialog probe and the watch's unread pass. The owner
scenes declare an entity (`floor`) so the team's registry identity resolves like a real
team's; the frame itself needs no address from it. The seat scenes register `helper` on
the team's roster with a nickname, or with none.

`acceptance.test.ts` covers six rows:

1. An accepted socket frame writes no receipt: `<id>.read.json` is absent, the record's
   own receipts derive `sent`, and it stays in the reader's unread list.
2. The accepted record is listed as unacked by `team messages`; the seat's own
   `team drops --read` then serves the body and writes a receipt the message key
   verifies — `read` from that point on, and gone from the unread and unacked lists.
3. With no seat read, the unread pass wakes the record at the normal window like any
   other message; no pane messaging refuses the typed leg, so nothing is typed and no
   wake marker is spent. At twice the window the sender and the lead are told, and the
   reported marker is written.
4. A held frame writes no receipt and leaves the record unread and ringable; the unread
   pass types nothing before the window, nothing after it (the typed leg is refused), and
   nothing on a later pass. This row pins the behavior the frame acceptance leaves
   unchanged.
5. An accepted frame from a seat with nickname `Bea` opens with exactly
   `Message from Bea (helper@acme)`, alone on its first line, then one blank line, then
   the unchanged record body. The header is display only: the signed record keeps its own
   `from Bea — admitted by: …` line and its bytes never carry the display header.
6. With no nickname on the roster, the same frame opens with
   `Message from helper (helper@acme)`.

## Contract pinned

The product branch's answers, at the strings level:

- Delivery: `team send` writes one signed record and no receipt for an accepted frame.
  `delivered` (the history line, `via: socket`) means the frame was taken; only a
  verifying seat receipt makes the record `read`. A receipt write failure cannot occur on
  this path because no write is attempted.
- Read: the seat's own reader writes the write-once, `0600` receipt. `read_by` stays an
  optional signed field naming how: `channel` for the channel tool's acknowledgement,
  `reply` when a `team reply` wrote the read beside its `replied` receipt, and
  `answered-by-send` when the seat's own later `team send` to the sender settled the
  newest delivered-unread message it answers. A plain `team drops --read` writes none; a
  receipt whose `read_by` was stripped or changed does not verify, and a receipt an earlier
  build wrote naming `socket delivery` still verifies.
- Unread pass: a socket-delivered record is due like any other. No pane messaging refuses
  the typed leg, so the pass spends no wake marker; at twice the window
  `reportUnreadDrops` writes the sender report, the lead report and the reported marker.
- Frame header: `Message from <name> (<seat>@<team>)`, with no trailing colon, no summary,
  nothing else on the line and no admitted-by suffix. `<name>` is the sender's nickname as
  the naming rule resolves it, falling back to the seat name; `<seat>` is the record's
  signed sender; `<team>` is the sending team's project name. The frame keeps its shape:
  header, blank line, record body (which keeps its own attribution line), blank line, the
  reader line ADR `zeus-message-path`, D3 pins:
  `Answer with team reply <id> "…" (this marks it read), or team ack <id> if no answer is
  needed.` The id is the record's own, appears on the line once, and names both acts that
  settle it — `team reply <id>` answers and writes the seat's signed read, `team ack <id>`
  writes it with no answer. The line is the same for every sender, the owner included: it
  carries no address, so no entity or owner-reply target is resolved for the frame. Owner
  and watch frames follow the same rule (`Message from owner (owner@<team>)`,
  `Message from watch (watch@<team>)`). The typed wake line and the sender-line setting are
  unchanged.

## Running

```
bun test test/socket-read-receipt/acceptance.test.ts
bun run typecheck
```
