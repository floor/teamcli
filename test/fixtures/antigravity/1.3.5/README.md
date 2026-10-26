# Antigravity (agy) 1.3.5 terminal captures

Captured from the installed macOS Antigravity CLI with herdr 0.7.1, `pane read --source visible`,
in a scratch session created for the purpose and stopped afterwards. `agy --version` is 1.3.5.
The account line is `<account>` and the plan is `<plan>`. Directory paths are `<workspace>`.

- `trust.txt`: `agy` in a fresh untrusted temporary directory. `Do you trust the contents of
  this project?` with `> Yes, I trust this folder` and `↑/↓ Navigate · enter Confirm`.
  The model row is `Gemini 4 Argon · medium`.
- `idle.txt`: the same directory after Enter on the marked trust row. The footer is
  `Gemini 4 Argon · medium`.
- `working.txt`: `Generating...` while a reply is produced.
- `question.txt`: `Question 1/1:` with `alpha`, `beta`, and `Write-in...`. Escape dismissed it.
- `permission.txt`: `Requesting permission for:` `ls`, `> 1. Yes, run command`. Escape dismissed it.
- `exit.txt`: after `/exit`. `Resume with -c` and the shell prompt. The conversation id is
  `<session-id>`.
- `rules-line.txt`: the rules line, captured with herdr 0.7.1, `pane read --source visible`,
  in a scratch session created for the purpose and stopped afterwards. The pane's `stty size`
  was `23 53`. The line is the same neutral store path the 1.2.16 capture uses, typed with
  `pane send-text` and never sent. The box wraps it: the break after `Read` and the break
  after `your` each hide one space, and the break in the path hides nothing. Read `unsent`.
  One `pane send-keys` `ctrl+u` with that line in the box restored the idle prompt and
  `? for shortcuts`, and the CLI stayed up.

## Not produced

- `unsent`: not produced, the installed binary 1.4.0 is newer than this folder's 1.3.5, so a
  1.3.5 composer screen cannot be launched on this machine without downgrading. The capture
  waits for a refresh to the installed version, in a new version folder with its own
  `tested.to` bump.
