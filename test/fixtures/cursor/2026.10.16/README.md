# Cursor Agent 2026.10.16 terminal captures

Captured from the installed macOS `cursor-agent` CLI with herdr 0.7.1, `pane read --source visible --lines 200`
(plain), in a scratch session created for the purpose and stopped afterwards. `cursor-agent --version`
printed `2026.10.16-e3cb207`. Directory paths are `<workspace>`. The resume id is `<session-id>`.
The status row names the model that day's launch used: `Grok 4.7 256K High` and `Run Everything`.

- `trust.txt`: `cursor-agent` in a fresh untrusted directory. `Do you trust the contents of this
  directory?`, `▶ [a] Trust this workspace`, `[q] Quit` and the arrow-key footer. The dialog was
  answered with `a` only so the later screens in that throwaway could be taken.
- `idle.txt`: `cursor-agent --force --sandbox disabled` in that directory: the `Cursor Agent` /
  `v2026.10.16-e3cb207` header, the tip row, the box holding `→ Plan, search, build anything`, the
  status row, and the workspace line ending `· main`.
- `unsent.txt`: `Fix the failing test` typed into the box and never sent. The box was cleared with
  the CLI's own ctrl+u afterwards.
- `working.txt`: `Run sleep 15 now, then reply with only SLEEP_DONE.` sent, with `⠠⠜ Working`
  under the box and `→ Add a follow-up   ctrl+c to stop` on the prompt row.
- `question.txt`: the question tool's `Clarifying Questions` box: `Question 1 of 1`,
  `1. Which option do you want?`, `› [ ] Alpha`, `[ ] Beta`, `[ ] Other: (type to answer)`, and
  the `Space select` / `Esc to skip` footer. Escape dismissed it.
- `permission.txt`: `Run this command?` with `Not in allowlist: sleep`, `→ Run (once) (y)`,
  `Add Shell(sleep) to allowlist? (tab)`, `Run Everything (shift+tab)` and
  `Skip & tell the agent what to do instead (esc or n)`. Escape skipped it; the command was not run.
- `exit.txt`: after the sleep turn answered `SLEEP_DONE` and `/exit`: the settled box, the status
  row carrying the `· 6.2%` quota token, and `To resume this session:`. The pane wraps the resume
  line; the id is `<session-id>` and the row the id continued on is blanked.

All seven screens read as their kinds with the profile unchanged: trust, idle, unsent, working,
question, permission, and exit as `unknown`.
