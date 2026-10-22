# Muse Code 1.4.11 screens

These frames were taken from running Muse Code 1.4.11 panes (herdr 0.7.1, `pane read --source
visible`). `idle.txt` and `rules-line-unsent.txt` were read-only captures under the owner's
authorization; no keys were typed into those panes. `typed-before-enter.txt` was captured in a
scratch Muse session created for the measurement, with a line typed into that session's own
pane. The raw frames stay out of the repository; only these sanitized copies are kept.

Sanitization: the project paths the footers name were replaced by `~/fixture/project` in the
authorized frames and by `/p/t/b5-muse-capture/ws` in the scratch frame, and the rules line's
home path and team folder by `/Users/example/.config/team/demo-3f9c2a8e1d7b` (authorized) and
`/home/owner/.config/team/demo-3f9c2a8e1d7b` (scratch, a synthetic home); every other byte,
including the prompt glyph `❯`, the `Voice input` box borders, blank rows and spacing, is the
captures' own.

- `idle.txt`: the ready screen. The header reads `Muse Code 1.4.11`, then the skills line. The
  composer's opening rule is `── Voice input (⌥ + v to start) ──…`, 187 columns wide, the empty
  input row is `❯`, the closing rule is the same 187 columns, and the footer is
  `  muse-wonder-full-1.0 · high · ~/fixture/project · YOLO`. The sanitized file is 1205 bytes,
  SHA256 `2b65f29329e5dd35d747687a5412163b4735c2597bf3b57cec5ba89977cf4d27`.
- `rules-line-unsent.txt`: the box after Enter on the authorized 1.4.11 pane: the key inserted a
  typed newline instead of submitting, so the box draws the rules line and then one empty row,
  inside the box, before the closing rule. The line is still there and the line is not submitted.
  The launcher's own shell rows above the banner are left out of the copy. The sanitized file is
  1374 bytes, SHA256 `7cb09f1ad7719d9a6e7e9aa0c67cf29514f19bd2d835846ea05f0f1a873fe615`; the raw
  capture was 1660 bytes, SHA256
  `93ecdf65b8ba2cfcf8881c61bdf65f4416328cab90f437a0af0b93f8db0e47b1`.
- `typed-before-enter.txt`: the box before Enter in a scratch Muse 1.4.11 session (echo provider),
  a rules line typed into its own pane and no key pressed yet: the line's wrapped rows under the
  input row, and nothing between them and the closing rule. The launcher's own shell rows above
  the banner are left out. The sanitized file is 561 bytes, SHA256
  `c0ccb996658479a0fbdc54d88ca01ee3ce33493371ca5b38bd6f6a9ba8473801`.

The pair is the point: the pre-Enter box draws the line alone, and a trailing empty row appears
only after a newline is typed into the box. One Enter on the pre-Enter box submits the line; on
a box that already drew the newline, one more Enter submits the same line as the one message it
is (measured in the same scratch session: `alpha line`, shift+enter, Enter — the transcript
shows `❯ alpha line` once, then the reply, and the box is empty).

herdr 0.7.1 does not report this CLI's agent status: its `agent list` carried the pane with no
`agent` type and `agent_status: "unknown"` while Muse sat at this ready box. `muse.yaml` therefore
declares `herdr_status: unreliable`, and the rules delivery reads the seat's own screen there.

## Constructed (synthetic)

These files are derived from `idle.txt` for the tests; nothing in them was read from a live pane.

- `working-synthetic.txt`: `idle.txt` with a `◇ Thinking (1s · esc to interrupt)` row added above
  the box — the working shape of the 1.4.9 capture, not captured on 1.4.11.
- `unsent-synthetic.txt`: `idle.txt` with a rules line typed into the box and one continuation row
  at the box's own column — the unsent shape of the 1.4.9 capture, not captured on 1.4.11.
- `placeholder-synthetic.txt`: `idle.txt` with the input row replaced by the grey prompt hint
  `❯ Tab queues or steers while a run is active`. The hint row itself was confirmed on a running
  1.4.11 pane; the frame around it is constructed here, and a full authorized capture of that
  screen replaces this file as it stands.
- `ambiguous-synthetic.txt`: the banner, skills line and footer with the composer box removed: an
  idle-looking screen that is not the ready box, expected to read `unknown`.
