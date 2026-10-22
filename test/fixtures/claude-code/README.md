# Claude Code screens

## Captured

- `completed-error-empty-box-atlas.txt`: Atlas's capture, 2026-10-22T03:01:25Z, from a seat on installed TeamCLI 0.5.4-rc.2 (source `4e50561d`). The turn printed `API Error: Connection lost mid-response. The response above may be incomplete.` and then ended; the empty composer under it has its opening rule carrying the seat's name in the run (`─…─ builder-7 ─`). The pane carries no CLI version marker, so the CLI's own version is unknown. Sanitized: the tool-result rows above the error and the account figures in the status row are synthetic or same-width neutrals; every decisive row (error, completion, update notice, box frame, footers) is the capture's bytes.

## Constructed

- `shell-prompt.txt`: constructed, not a capture. A few lines of shell output and a bare `❯ `, the shape of a zsh prompt after Claude Code has exited. Nothing here was read from a live pane.
- `rule-above.txt`: constructed. A long rule in the answer above the exit, then a bare `❯ `.
- `leftover-box.txt`: constructed. The box Claude left (rule, prompt, rule, status), then the shell's `❯ `.
- `output-under-rule.txt`: constructed. A bare `❯ `, a rule, and a line of output under the rule.
- `quoted-dialog.txt`: constructed. An idle box whose transcript above it quotes a dialog's
  words (`Do you want to proceed? 1. Yes`); the quote is prose and the box reads idle. Nothing
  here was read from a live pane.
- `scrolled-shortcuts.txt`: constructed. A box whose top rule has scrolled out of the window with only `  ? for shortcuts` under the closing rule. The shortcuts row alone without a model or permissions status row does not identify Claude's composer box and reads unknown.
- `trust-unnumbered.txt`: constructed, not a capture. The folder-trust dialog with unnumbered choices (from Claude Code 2.1.289's description), framed as the existing trust fixture.
- `provider-error.txt`: constructed, not a capture. The sentence a seat printed when the response stopped (`API Error: Connection lost mid-response. The response above may be incomplete.`) above an empty idle box. No capture shows a retry key.
- `rate-limit.txt`: constructed, not a capture. The quoted fragments of a 429 (`API Error: Request rejected (429)`, `Usage limit reached`, `Your limit will reset at`) on one line above an empty idle box. The middle the report omitted is not invented; the reset time is `11:00`.
- `shell-git-log.txt`: constructed, not a capture. A shell prompt, a closing rule, then a git log line containing `·`.
- `shell-right-prompt.txt`: constructed, not a capture. A shell prompt, a closing rule, then a zsh right-prompt segment containing `·`.
- `shell-shortcuts.txt`: constructed, not a capture. A shell prompt, a closing rule, then the exact line `? for shortcuts` alone.
- `shell-shortcuts-indented.txt`: constructed, not a capture. A shell prompt, a closing rule, then `  ? for shortcuts` with two leading spaces.
- `shell-status-only.txt`: constructed, not a capture. A shell prompt, a closing rule, then `  build · Opus 5 notes` (two leading spaces, a middot, and a model word).
- `shell-bypass-only.txt`: constructed, not a capture. A shell prompt, a closing rule, then `  bypass permissions`.
