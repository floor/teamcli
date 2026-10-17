# Codex 0.161.0 terminal captures

Captured from the installed macOS Codex CLI (`codex-cli 0.161.0`) with herdr 0.7.1,
`pane read --source visible --lines 200` (plain), in scratch sessions of my own with one
Codex pane, 54 by 23 — the size `up` creates. `idle.txt` was taken on 2026-10-08; the rest
of the baseline set was backfilled on 2026-10-17. The CLI was launched the way a seat is
launched, plus a pinned model so the status row is one the shipped profile reads:

`codex -a never -s danger-full-access --no-daemon --no-alt-screen -m gpt-5.6-terra -c check_for_update_on_startup=false`

The pinned model was accepted. The seated launch showed no trust dialog and no update
screen, and nothing was answered.

`pane read --source visible` returns the pane's screen with leading and trailing blank
rows trimmed. The readings below were taken from the returned text, as delivery reads it.

- `idle.txt`: the empty box at boot, read `idle`. The banner's workspace path is replaced by
  `<workspace>`; the line is not part of any box, so the shorter stand-in moves nothing.
  At this width the status row wraps: `weekly 9` stays on the status line and the next
  line is the ellipsis alone.
- `trust.txt`: a plain `codex --no-daemon` in the fresh throwaway, which is the launch that
  shows the folder question: `Trust this folder?` with the marked row
  `1. Trust and continue` and `enter continue · esc quit`. The question was captured first
  and then answered with `enter` (the marked row) only so the later stages could run in the
  same throwaway; the throwaway folder was removed on exit.
- `unsent.txt`: `Fix the failing test` typed into the idle composer with `pane send-text`
  and never sent, read `unsent` with the composer holding the text.
- `working.txt`: a turn against the prompt `Run the shell command sleep 20, then reply
  done.`, read `working` at `• Working (0s · esc to interrupt)`.
- `permission.txt`: `codex -a on-request -s danger-full-access --no-daemon --no-alt-screen
  -m gpt-5.6-terra -c check_for_update_on_startup=false`, with a temporary project-local
  `.codex/config.toml` and `.codex/rules/capture.rules` holding `prefix_rule` entries for
  `ls` and `/bin/ls`, `decision="prompt"`, and justification `Permission dialog capture`.
  The prompt asked for approval before listing anything; the dialog asks
  `Would you like to run the following command?` over `$ ls` and was dismissed with
  Escape. The command was never run. The config and rules files were staged from a scratch
  folder, copied into the throwaway, and removed with it; no owner configuration was
  written.
- `exit.txt`: after `/exit`, the pane back at its shell. The banner's session id is
  `<session-id>` and the workspace path is `<workspace>`, both padded to the width of the
  original. The prompt itself was not answered a second time.

## Not produced

- `question`: not produced — Codex has no interactive question widget in unattended or
  default mode. A screen that reads as one on this CLI is a dialog, and a dialog is never a
  vendor notice.
