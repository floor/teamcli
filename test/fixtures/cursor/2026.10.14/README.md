# Cursor Agent 2026.10.14 terminal captures

Captured from the installed macOS `cursor-agent` CLI with herdr 0.7.1, `pane read --source visible`,
in a scratch session created for the purpose and stopped afterwards. `cursor-agent --version`
printed `2026.10.14-0f9edde`. Directory paths are `<workspace>`. The resume id is `<session-id>`.

- `trust.txt`: `cursor-agent` in a fresh git directory. `[a] Trust this workspace` and `[q] Quit`.
  The dialog was answered with `a` only so later screens in that throwaway could be taken.
- `idle.txt`: `cursor-agent --force --sandbox disabled` in that directory. The status row is
  `Grok 4.7 256K High` and `Run Everything`.
- `working.txt`: a `sleep` turn. `ctrl+c to stop` on the follow-up row, and `1 task`.
- `unsent.txt`: backfilled on 2026-10-17. `cursor-agent --force --sandbox disabled --trust`
  in a fresh git throwaway (`--trust` only skips the workspace question so the screen is the
  composer rather than the trust box), then `Fix the failing test` typed with
  `pane send-text` and never sent. The composer holds the text under `→`; the status row is
  `Grok 4.7 256K High` and `Run Everything`.
- `question.txt`: `Question 1 of 1` inside the box, `› [ ] alpha`, `Space select`, `Esc to skip`.
  Escape dismissed it.
- `permission.txt`: `Run this command?`, `Not in allowlist: sleep`, `→ Run (once) (y)`.
  The command was not run.
- `exit.txt`: after `/exit`. `To resume this session:`.
