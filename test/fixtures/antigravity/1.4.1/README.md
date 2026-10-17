# Antigravity (agy) 1.4.1 terminal captures

Captured from the installed macOS Antigravity CLI with herdr 0.7.1, `pane read --source visible`,
in a scratch session created for the purpose and stopped afterwards. `agy --version` is 1.4.1.
The account line is `<account>` and the plan is `<plan>`. Directory paths are `<workspace>`.

- `trust.txt`: `agy` in a fresh untrusted temporary directory. `Do you trust the contents of
  this project?` with `> Yes, I trust this folder`, `No, exit`, and `↑/↓ Navigate · enter Confirm`.
  Unlike 1.4.0, the model row `Gemini 4 Argon · medium` sits under the footer.
- `idle.txt`: the same directory after Enter on the marked trust row: the `Antigravity CLI 1.4.1`
  banner beside its mark, `<account>` / `Gemini 4 Argon (Medium)` / `<workspace>`, the box's two
  rules with `>` between them, and the `? for shortcuts` footer with the model row.
- `unsent.txt`: `Fix the failing test` typed into the box and never sent. The banner is redrawn
  under the mark, the account line carries the plan `(<plan>)`, and only the model row sits under
  the box's closing rule.
- `working.txt`: `Reply with exactly the word hello and nothing else.` sent, with
  `⢿  Generating...` under it and `esc to cancel ... Gemini 4 Argon · medium` as the footer.
  Captured with `agy --dangerously-skip-permissions`, the unattended launch.
- `question.txt`: the question tool's choice screen: `Question 1/1:` with `> 1. alpha`,
  `2. beta`, `3. Write-in...`, and `↑/↓ Navigate · enter Select · esc Skip`. Escape dismissed it.
- `permission.txt`: `Requesting permission for:` `ls` under `Run this command?`, with
  `> 1. Yes, run command`, the two always-allow rows and `4. No, cancel`, and `↑/↓ Navigate ·
  tab Amend · ctrl+g edit/expand` under them. Captured with bare `agy` (no unattended flag);
  Escape dismissed it.
- `exit.txt`: after `/exit`, the shell prompt and its status line (`main`, `3s`) below the last
  banner and empty box, and the shell's own prompt row. The pane reads as no CLI screen.
