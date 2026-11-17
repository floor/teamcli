# Codex 0.167.0 terminal captures

Captured on 2026-11-10 from the installed CLI: `codex --version` printed
`codex-cli 0.167.0`. Each screen came from my own scratch session of the terminal
host, read with `pane read --source visible --format ansi --lines 60`, at 119 by 40 (`stty size` printed `40 119`).
The scratch workspace was a fresh repository under the evidence folder; no tool ran
from a temporary folder. Workspace paths and session ids are padded placeholders.

## Captured

The first launch was `codex -m gpt-6.1-sol --no-alt-screen`.

- `trust.txt`: the fresh folder's trust dialog, before continuing into this synthetic workspace.
- `idle.txt`: the empty prompt with the status row and its warning tail.
- `unsent.txt`: the probe `Fix the failing test` typed but never submitted; Ctrl+U cleared it.
- `working.txt`: an active turn asked only to run `sleep 8` and reply; the working row stands above the prompt.
- `question.txt`: after `/plan`, a prompt requested a question with two greeting choices. The footer combines tab, enter and escape hints. Escape interrupted the turn and returned to the empty composer.
- `plan-approval.txt`: a proposed greeting plan drew choice descriptions on the same rows. Escape returned to the empty composer without implementing the plan.
- `permission.txt`: a separate launch, `codex -a on-request -s read-only -m gpt-6.1-sol --no-alt-screen`, requested `touch probe.txt`. The dialog was captured and dismissed with Escape; it was never approved.
- `exit.txt`: `/exit` returned to the workspace's shell without a confirmation question.

- `idle-unattended.txt`: `codex -a never -s danger-full-access --no-alt-screen -m gpt-6.1-sol` reached the empty prompt with its own permissions status.

The unattended launch was checked in this scratch session. An independent
synthetic CLI home ran `codex app-server --listen unix://<session-socket>`: its socket
appeared while its process remained running, then that process alone was stopped.
The CLI help runs list `-a never`, `-s danger-full-access`, `--no-alt-screen`,
`--no-daemon`, `--remote` and app-server `--listen`; no feature override was added.

## Not produced

- `confirmation`: no confirmation dialog appeared when clearing the draft, dismissing the question and plan with Escape, or exiting.
- `exit question`: `/exit` returned directly to the shell.

## thread-locked.txt (2026-11-17)

The Codex TUI after `codex resume <id>` when another app-server still held the conversation (`thread-locked.txt` plain, `thread-locked-ansi.txt` the styled `--format ansi` read the launch takes):
"This conversation is open in another app — Close it there and press R", with only retry, fork
and exit keys and no composer. Captured read-only (`herdr pane read --source visible`) from the
reboot simulation's own scratch seat; the transcript above the screen was replaced by one neutral
prompt line. Measured alongside it: an app-server keeps a conversation loaded about sixty
seconds after its last client leaves.
