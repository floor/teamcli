# Antigravity (agy) 1.4.0 terminal captures

Captured from the installed macOS Antigravity CLI with herdr 0.7.1, `pane read --source visible`,
in a scratch session created for the purpose and stopped afterwards. `agy --version` is 1.4.0.
The account line is `<account>` and the plan is `<plan>`. Directory paths are `<workspace>`.

- `trust.txt`: `agy` in a fresh untrusted temporary directory. `Do you trust the contents of
  this project?` with `> Yes, I trust this folder`, `No, exit`, and `↑/↓ Navigate · enter Confirm`.
  The same dialog 1.3.5 draws, in the 54x23 pane `up` creates.
- `idle.txt`: the same directory after Enter on the marked trust row: the `Antigravity CLI 1.4.0`
  banner, the box's two rules with `>` between them, and the `? for shortcuts` footer. Unlike
  1.3.5, the fresh idle footer carries no model row; the row appears once a turn has run.
- `unsent.txt`: `Fix the failing test` typed into the box and never sent. The banner gained
  `Gemini 4 Argon (Medium)`, and the model row `Gemini 4 Argon · medium` sits under the box's
  closing rule.
- `working.txt`: `Reply with exactly the word hello and nothing else.` sent, with
  `⡿  Generating...` under it and `esc to cancel ... Gemini 4 Argon · medium` as the footer.
  Captured with `agy --dangerously-skip-permissions`, the unattended launch.
- `question.txt`: the question tool's choice screen: `Question 1/1:` with `> 1. alpha`,
  `2. beta`, `3. Write-in...`, and `↑/↓ Navigate · enter Select · esc Skip`. Escape dismissed it.
- `permission.txt`: `Requesting permission for:` `ls` with `> 1. Yes, run command` and the three
  other rows, and `↑/↓ Navigate · tab Amend · ctrl+g edit/expand` under them. Captured with bare
  `agy` (no unattended flag); Escape dismissed it.
- `exit.txt`: after `/exit`, the shell prompt and its status line, with no CLI screen.
