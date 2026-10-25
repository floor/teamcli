# Codex 0.161.0 terminal captures

Captured from the installed macOS Codex CLI (`codex-cli 0.161.0`) on 2026-10-18 with
herdr 0.7.1, `pane read --source visible --lines 60` (plain), in a scratch session of
my own with one Codex pane per scene, 54 by 23 — the size `up` creates. The launch
pinned a model so the status row is one the shipped profile reads; nothing typed was
left from another scene.

The two launches are the person's own CLI's, not the seat's: no `-a never -s
danger-full-access --no-daemon --no-alt-screen` flags. That is the launch that draws
the chrome row under the status row — the shape that read `unknown` on a live seat —
and the dialog shapes are the same either way.

- `codex -m gpt-6.1-sol` in a folder that is not a git repository: `idle-hint.txt`,
  `unsent.txt`, `working.txt`, `exit-typed.txt`, `exit.txt`.
- `codex -a on-request -s read-only -m gpt-6.1-sol` with one prompt asking for
  `touch probe.txt`: `permission.txt`. The dialog was read and left unanswered; the
  read-only sandbox is the capture's own setting.
- `codex -m gpt-6.1-sol` in a subdirectory of a fresh git repository no trust decision
  named: `trust.txt`. The dialog was read and left unanswered; the pane was closed
  without answering it.

The `.codex` config files the 0.157.0 permission capture needed were not needed here:
`-a on-request -s read-only` makes a write ask on its own. No vendor configuration was
edited, no dialog was answered, and the update check was not overridden.

Workspace paths are replaced by `<workspace>`, the trust dialog's two paths by
`<project-worktree>` and `<repository-root>`, and the resume id by `<session-id>`.

- `idle.txt`: the empty box at boot, captured 2026-10-08, read `idle`. At 54 columns
  this build wraps the status row: `weekly 9` stays on the status line and the next
  line is the ellipsis alone.
- `idle-hint.txt`: the empty box on a plain launch, read `idle`. One chrome row sits
  under the status row — `← for agents · ? for shortcuts`. The status row is cut
  (`weekly 100…`). Read as `unknown` before the composer allowed that row.
- `unsent.txt`: the empty box after a line was typed, read `unsent`. Typing hides the
  chrome row; the status row is the pane's last line.
- `working.txt`: the turn after Enter, read `working`. `• Working (0s • esc to
  interrupt)` sits above the empty box, and the chrome row is back under the status
  row.
- `permission.txt`: the approval dialog for `touch probe.txt`, read `permission`. The
  dialog draws three choices, one more than 0.157.0's: `Yes, proceed`, `Yes, and don't
  ask again for commands that start …`, `No, and tell Codex what to do differently`.
- `trust.txt`: the folder-trust dialog, read `trust`. 0.161.0's way out is `2. Back to
  Agent Command Center` with `enter continue · esc back`, where 0.157.0 drew `2. Quit`
  and `enter continue · esc quit`.
- `exit-typed.txt`: `/exit` typed in the free box, read `unsent`; the menu row
  `› /exit  exit Codex` sits above the input row.
- `exit.txt`: the pane after Enter, read `unknown`. Codex asks no exit question; the
  shell is back with the task's own advice above it.
- `idle-wide-warning.txt`: supplied by Floor, not captured here — a sanitized 8-line frame
  from a wide pane running the observed build (`»` prompt). The status row is
  `GPT-6.1-Sol ultra · Context 100% left · weekly 94% left`, with the account's
  `⚠ 1 warning · f2 to view` right-aligned on the same row and no chrome row under it. It
  read `unknown` until the warning tail counted as the row's own end.

## Constructed

Nothing in these files was read from a live pane. Each is `idle-hint.txt` with its last
rows changed, as a seat's own screen draws them.

- `ready-context-used.txt`: the idle hint at 100% context, with the context shown used —
  `  GPT-6.1-Sol medium · Context 100% used` — and the chrome row under it. Read
  `unknown` before the profile exempted a status row ending `% used`; a seat up at this
  prompt was then reported not ready after a restart.
- `ready-context-used-bare.txt`: the same screen with no chrome row, the status row
  last.
- `near-context-used-typed.txt`: `› Ask Codex to do anything else` in the box, over the
  used status row. Not ready: the box holds text.
- `near-context-used-follower.txt`: the used status row with the seat's own row under
  it. Not a composer: a row that is not the pane's chrome means the row above it is
  not the status row.
- `near-context-used-nostatus.txt`: the idle hint with no status row. Not a composer:
  the profile declares no fallback.

The used variant is Codex's own: `strings` on the installed `codex-cli 0.161.0` prints
`Context `, `% left`, `Context `, `% used` beside the status-surface ids
`context-remaining` and `context-used`, so the context is drawn either way.

## Not produced

- `question`: not produced. Codex 0.161.0 asks none in its composer — the approval dialog
  above is the only question it draws — and the profile declares no question stage.
- `exit question`: not produced. 0.161.0 ends on `/exit` with no question; the profile
  declares no exit confirm.
