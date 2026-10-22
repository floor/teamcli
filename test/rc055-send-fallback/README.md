# Independent coverage: quota-out reader state and the socket-refused typed fallback

Author: tester-2 (independent of builder-4's product branch).
Base: builder-4's pushed head `a37ae86f8462ceedbc06f5d977066a777ec2f7d1`
(`feat/rc055-b4-quota-out-state`, PR #650 lineage). These rows cover behavior already on that
head; they are coverage-only, not red-first evidence for a new fix. The wall row is also
measured red at the pre-fix source `2f056c6b1871006453dd6e37122cf6ff924c02e1`, where no
quota-out preflight exists.

## Rows

`acceptance.test.ts`:

1. **Walled receiver refuses before the socket leg is dialed.** A retained wall capture
   (`../fixtures/claude-code/rate-limit.txt`, read in place) over an accepting Claude receiver
   refuses with `send.refused`, `quota out on <account>`, the displayed reset and
   `nothing was sent`; no frame is dialed, no key is typed, no record is written.
2. **An unreadable receiver pane is no wall.** The send rides the socket
   (`delivered (socket)`): the named gap is not a safe outcome and not a refusal.
3. **Only the receiver's pane is read.** A wall on the caller's own pane does not hold the
   send; the receiver's pane is the one read.
4. **The transport refusal is recorded, and the typed leg carries the send.** `channel` is
   `typed`, the action summary carries `typed, socket <reason>` and `trigger taken, no read
   receipt yet`, the delivery array records the socket attempt's reason then the typed leg,
   the trigger is typed once, and the team log names the fallback.
5. **A frame past the measured limit is refused before any dial** (1,048,576 characters), and
   the typed leg takes the send with the limit sentence in the outcome.
6. **A session started before its declaration is skipped** (socket mtime older than the
   generated settings file), with the exact skip sentence in the outcome.
7. **Control: an accepted frame delivers on the socket and types nothing** (`channel: socket`).

## Fixtures

Synthetic scene state only: the team file and state come from the repository's
`test/send-native-fixtures.ts`; the wall frame is the repository's retained capture, read in
place and never copied; the sockets are empty files this file writes. No live session, CLI
home, pane or credential is read.

## Measured runs (2026-10-22)

- At `2f056c6b1` (pre-fix), fresh worktree: `bun install` exit 0; the suite is 6 pass / 1
  fail / 38 expects — the walled-receiver row reads exit 0 instead of 1, because no
  quota-out preflight exists there.
- At `a37ae86f8` (builder-4's head), fresh worktree: `bun install` exit 0;
  `bun run typecheck` exit 0; the suite is 7 pass / 0 fail / 47 expects, exit 0.
