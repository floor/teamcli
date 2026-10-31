# Socket delivery read receipts and the accepted-frame header

Independent, test-only coverage for the 0.5.4-rc.5 hotfix: an accepted socket frame
delivers a message, and a delivery must not become a second wake. The signed read receipt
is the one proof of a read, so accepting a frame writes it at once; a frame the receiver's
box held proves nothing and keeps the watch's ordinary retry.

Started from the exact pre-fix source `8b04ddb81e068c6d997bca405ae8954e9c8a80f5`. The
scenes are written here and built on the suite's existing temporary-world fixtures; none
of the product branch's fixtures are used. No live session, socket or owner home is
touched: the send host's transport is a fake, and the pane is a string.

## Scenes

`fixtures.ts` builds a temporary team whose lead declares `crossSessionInbound: accept`,
with the launch declaration written just before the socket its pane exposes. `book()` is
one pane read by both the send's held-dialog probe and the watch's unread pass. The owner
scenes declare an entity (`floor`) so an owner-origin frame has its shipped reply target;
the seat scenes register `helper` on the team's roster with a nickname, or with none.

`acceptance.test.ts` covers five rows:

1. An accepted socket frame writes `<id>.read.json` beside the record: mode `0600`,
   `status: "read"`, `read_by: "socket delivery"`, the record's id, bare seat, root and
   session, and a payload the checkout's message key verifies. The record's own receipts
   derive `read` and the reader's unread list is empty.
2. The accepted record is not served again by `team drops --read`, is absent from the
   watch's ring list (`listUnacked`), is not typed at past the unread window, and is not
   reported at twice the window; no report drop appears.
3. A held frame writes no receipt and leaves the record unread and ringable; the unread
   pass types nothing before the window, exactly one retry line after it, and nothing on a
   later pass. The retry is a typed line, not a read: no receipt appears behind it. This
   row is green at the pre-fix source by design — it pins the behavior the hotfix keeps.
4. An accepted frame from a seat with nickname `Bea` opens with exactly
   `Message from Bea (helper@acme): a note`, alone on its first line, then one
   blank line, then the unchanged record body. The header is display only: the
   signed record keeps its own `from Bea — admitted by: …` line and its bytes
   never carry the display header.
5. With no nickname on the roster, the same frame opens with
   `Message from helper (helper@acme): a note`.

## Contract pinned

The product branch's answers, at the strings level:

- Receipt: new optional `read_by` on the receipt payload, exact value `socket delivery`;
  the whole payload is still signed under the receipt domain, and a receipt whose
  `read_by` was stripped or changed does not verify. Written by the existing write-once,
  `0600` receipt writer, only on the accepted branch, after the held-dialog read. A
  receipt write that fails does not fail the send: the record simply stays unread.
- Frame header: the receiving team's `message-display` header, rendered with the sender's
  nickname, its written label name, or the seat name; the record's signed sender and team
  in `<seat>@<team>`, and the body's first content line as the summary. Under the shipped
  template the first line reads `Message from <name> (<seat>@<team>): <summary>`, alone on
  its line and with no admitted-by suffix. The frame keeps its shape: header, blank line,
  record body (which keeps its own attribution line), blank line, the existing reply line.
  Owner and watch frames follow the same rule (`Message from owner (owner@<team>): …`,
  `Message from watch (watch@<team>): …`). The typed wake line and the sender-line setting
  are unchanged.

## Running

```
bun test test/socket-read-receipt/acceptance.test.ts
bun run typecheck
```

At the pre-fix source the file is red-first by design: typecheck exits 0; four rows fail
and the held-preservation row passes (1 pass, 4 fail, 24 expects). The red rows are the
receipt and header rows; row 2 fails first on the ring list, because the acceptance wrote
no receipt. Run the file at the hotfix head to confirm all five pass.
