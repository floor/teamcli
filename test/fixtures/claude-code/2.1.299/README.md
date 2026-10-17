# Claude Code 2.1.299 terminal captures

Captured from the installed macOS Claude Code CLI with herdr 0.7.1, `pane read --source visible`,
in a scratch session created for the purpose and stopped afterwards. `claude --version` printed
`2.1.299 (Claude Code)`. Directory paths are `<workspace>`. The resume id is `<session-id>`.

- `trust.txt`: `claude` in a fresh directory. `Quick safety check:`, the marked row `No, exit`,
  then `Yes, I trust this folder`, and `Enter to confirm · Esc to cancel`. Enter was not sent
  on this pane.
- `idle.txt`: after the throwaway was trusted, with bypass permissions. The suggestion is
  `Try "refactor <filepath>"` and the footer names `Opus 4.8`.
- `working.txt`: `✽ Mustering… (0s · thinking with high effort)` during a reply.
- `question.txt`: `Which name would you like to use?` with `1. alpha`, `2. beta`, and
  `Enter to select · ↑/↓ to navigate · Esc to cancel`. Escape dismissed it.
- `permission.txt`: `claude --permission-mode manual`. `Do you want to create synthetic-note.txt?`
  with `1. Yes` and `Esc to cancel · Tab to amend`. Escape dismissed it; the file was not created.
- `exit.txt`: after `/exit`. `Resume this session with:`.

## Not produced

- `unsent`: not produced, the installed binary 2.1.302 is newer than this folder's 2.1.299,
  so a 2.1.299 composer screen cannot be launched on this machine without downgrading. The
  capture waits for a refresh to the installed version, in a new version folder with its own
  `tested.to` bump.
