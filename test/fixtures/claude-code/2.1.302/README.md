# Claude Code 2.1.302 terminal captures

Captured from the installed macOS Claude Code CLI with herdr 0.7.1, `pane read --source visible`,
in a scratch session created for the purpose and stopped afterwards. `claude --version` printed
`2.1.302 (Claude Code)`. Directory paths are `<workspace>`. The resume id is `<session-id>`. The
styling was stripped, as in the 2.1.299 folder.

- `trust.txt`: `claude` in a fresh directory. `Quick safety check:` with the marked row `No, exit`
  and `Yes, I trust this folder` below it, and `Enter to confirm · Esc to cancel`. The screen was
  captured before any key was sent; Enter was then sent to confirm the marked row.
- `idle.txt`: after the throwaway was trusted, launched with bypass permissions. The suggestion is
  `Try "edit <filepath> to..."` and the footer reads `⏵⏵ bypass permissions on (shift+tab to
  cycle)`.
- `unsent.txt`: `Fix the failing test` typed into the composer and never sent.
- `working.txt`: `✢ Channeling… (7s · ↓ 2 tokens)` during a reply.
- `question.txt`: `Which name do you want to use?` with `1. alpha`, `2. beta`, `3. Type something.`,
  and `Enter to select · ↑/↓ to navigate · Esc to cancel`. Escape dismissed it.
- `permission.txt`: `claude --permission-mode manual`. `Do you want to create synthetic-note.txt?`
  with `1. Yes` and `Esc to cancel · Tab to amend`. Escape dismissed it; the file was not created.
- `exit.txt`: after `/exit`. `Resume this session with:` and `claude --resume <session-id>`.
- `held.txt`: captured the same way on 2026-10-18, newer binary (`claude --version` again
  `2.1.302`). An unattested frame was written to the idle session's own socket
  (`/tmp/cc-socks/<pid>.sock`), and the bypass-mode session held it: the transcript row naming the
  held message, then the dialog's title, sender, body and its two choices (`❯ Deny — drop it and
  tell the sender it was declined`, `Deliver this message to Claude`), with no composer under it.
  The sending pid is swapped for `<pid>` and the probe body for `HELLO`; nothing else changed.

## Not produced

Every baseline kind is captured at this version; `held.txt` is not a baseline kind but the
cross-session held-message dialog, captured with the rest.
