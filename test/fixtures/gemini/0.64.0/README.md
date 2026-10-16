# Gemini CLI (gemini) 0.64.0 terminal captures

Captured from the installed macOS Gemini CLI (`/opt/homebrew/bin/gemini`) with herdr 0.7.1,
`pane read --source visible`, in a scratch session created for the purpose and stopped
afterwards. `gemini --version` is `0.64.0`. The pane's `stty size` was `23 53`. Directory
paths are `<workspace>` and session ids are `<session-id>`.

- `trust.txt`: `gemini` in a fresh untrusted temporary directory. `Do you trust the files in
  this folder?` with `● 1. Trust folder (workspace)`, `2. Trust parent folder (scratch)`, and
  `3. Don't trust` inside a rounded box.
- `idle.txt`: `AGENT_UNATTENDED=1 gemini --approval-mode yolo -m gemini-3-pro` in the trusted
  directory. The composer box draws a top `▄` rule and a bottom `▀` rule around
  ` *   Type your message or @path/to/file`, and the two-line footer below shows
  `workspace (/directory)`, `sandbox`, and `/model` (`gemini-3-pro`).
- `unsent.txt`: `RULES_RECEIVED` typed in the composer box (` * RULES_RECEIVED`), not sent.
- `rules-line.txt`: the neutral rules line typed with `pane send-text` and never sent. The box
  wraps it across five rows (` * Read` and four continuation rows at column 3). One
  `pane send-keys` `ctrl+u` with that line in the box restored the idle prompt, and the CLI
  stayed up.
- `rules-accepted.txt`: after Enter on the rules line, showing the echoed box, `✦ Ready.`, and
  the idle composer below.
- `working.txt`: an active turn with the braille spinner row `⠼ Thinking... (esc to cancel, 1s)`
  above the composer box.
- `permission.txt`: `gemini -m gemini-3-pro` (without `--approval-mode yolo`) prompting on a
  file write (`? WriteFile  Writing to notes.txt`, `Apply this change?`, `● 1. Allow once`,
  `4. No, suggest changes (esc)`). Escape dismissed it; nothing was written.
- `question.txt`: the `ask_user` widget (`Answer Questions`, numbered choices, and
  `Enter to select · ↑/↓ to navigate · Esc to cancel`). Escape dismissed it.
- `rate-limit.txt`: the quota-exhausted dialog (`Usage limit reached for all Pro models.`,
  `Access resets at 2:10 PM GMT+2.`, `● 1. Keep trying`, `2. Stop`).
- `exit-typed.txt`: `/exit` typed (` * /exit`) with the slash completion row
  ` quit   Exit the cli` under the bottom rule, not sent.
- `exit.txt`: after Enter on `/exit`, showing the interaction summary,
  `To resume this session: gemini --resume <session-id>`, and the shell prompt.
