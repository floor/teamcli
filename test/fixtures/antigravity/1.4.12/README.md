# Antigravity (agy) 1.4.12 terminal captures

Captured from live Antigravity CLI 1.4.12 panes on 2026-11-02 with the pane host's
`read --source visible` (plain), then sanitized: the account line is `<account>`, the plan is
`<plan>`, the workspace is `<workspace>`, and the transcript lines name no person, team or
folder. The frames keep their shape: the banner, the box's two rules, the input row and the
footer, at the widths the panes drew them.

- `idle.txt`: the empty idle box under a short transcript, the `? for shortcuts …
  Gemini 4 Argon · high` footer under the closing rule. It reads as `idle`.
- `idle-compacted.txt`: the same box under a long transcript closed by a `Conversation
  compacted` row (a labelled rule row, not the box's frame). It reads as `idle`.
- `working-synthetic.txt`: a turn in progress, `⣾  Reading file...` under the transcript and
  `esc to cancel … Gemini 4 Argon · high` under the box. It reads as `working`.
- `exit-completion-unsent.txt`: `/exit` typed at the idle box, never submitted: the box holds
  `/exit` between its rules, and the CLI's completion row `> /exit  Exit the CLI` sits below the
  closing rule. It reads as `unsent`, and the box holds `/exit` — never the empty idle prompt.

The three screens the typed wake reads back (empty idle box, box holding text, working row) are
pinned by `test/antigravity-typed-wake.test.ts`. The trigger line that test draws into the idle
box is synthetic; no frame here holds one.
