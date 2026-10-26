# Muse Code 1.4.11 ready box

One frame, taken read-only from a running Muse Code 1.4.11 pane (herdr 0.7.1, `pane read
--source visible`) under the owner's authorization. No keys were typed and no second frame was
taken. The raw frame stays out of the repository; only this sanitized copy is kept.

Sanitization: the project path the footer names was replaced by `~/fixture/project`; every other
byte, including the prompt glyph `❯`, the `Voice input` box border, blank rows and spacing, is
the capture's own. The sanitized file is 1205 bytes, SHA256
`2b65f29329e5dd35d747687a5412163b4735c2597bf3b57cec5ba89977cf4d27`.

- `idle.txt`: the ready screen. The header reads `Muse Code 1.4.11`, then the skills line. The
  composer's opening rule is `── Voice input (⌥ + v to start) ──…`, 187 columns wide, the empty
  input row is `❯`, the closing rule is the same 187 columns, and the footer is
  `  muse-wonder-full-1.0 · high · ~/fixture/project · YOLO`.

herdr 0.7.1 does not report this CLI's agent status: its `agent list` carried the pane with no
`agent` type and `agent_status: "unknown"` while Muse sat at this ready box. `muse.yaml` therefore
declares `herdr_status: unreliable`, and the rules delivery reads the seat's own screen there.

## Constructed (synthetic)

These files are derived from `idle.txt` for the tests; nothing in them was read from a live pane.

- `working-synthetic.txt`: `idle.txt` with a `◇ Thinking (1s · esc to interrupt)` row added above
  the box — the working shape of the 1.4.9 capture, not captured on 1.4.11.
- `unsent-synthetic.txt`: `idle.txt` with a rules line typed into the box and one continuation row
  at the box's own column — the unsent shape of the 1.4.9 capture, not captured on 1.4.11.
- `ambiguous-synthetic.txt`: the banner, skills line and footer with the composer box removed: an
  idle-looking screen that is not the ready box, expected to read `unknown`.

## Not produced

- `unsent`, `working`, `question`, `permission`, `trust`, `unknown`: not produced. The one real
  frame here was read from a running pane without typing a key, so no other screen was drawn;
  the synthetic files above are constructed, not captures.
