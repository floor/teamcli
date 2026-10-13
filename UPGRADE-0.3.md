# Upgrading to 0.3.0

For a team that is running under 0.2.1:

1. `team doctor`. It prints the whole `trust:` block to paste (the machine lobby, the project root, the folder
   your worktrees live in, each in absolute form), and names a model-family mismatch if a running seat shows
   one.
2. One edit of the team file: paste that block under `trust:`; correct `model:` and `version:` if step 1 named
   them.
3. `team approve`, **run alone**: it prints the file back and records it, and with `--confirm` it asks you
   to type the number of seats and reads the answer from your terminal. Pasted together with the next
   command, the leftover input refuses the approval and nothing is written.
4. `team up`.

That is one edit, one approval, one `up`, and the team is in force again. Read-only commands (`status`,
`doctor`) work throughout. Two exceptions:

- **Running seats stay where 0.2.1 started them until they are relaunched.** `up` skips each one and says what
  repairs it. The relaunch moves them into the new lobby and records their processes (a seat
  whose rules are delivered as a message also gets its rules file; a seat whose rules go on its launch line
  has none): `team down`, then `team up` for the whole team; or per seat `team remove <seat> --keep`, then
  `team add <seat>`. A coordinator or operator seat is only ever relaunched by `team down`, then `team up`.
  **Type them as two commands, the second only after the first has returned** (`team down && team up` is
  fine). `team down & team up`, with one ampersand, starts both at once: `up` runs while `down` is still
  stopping seats, and seats are left with the exit text unsent in their input box.
  A seat 0.2.1 recorded has no process identity: if its pane came back as a bare shell, or as another
  model, `up` does not relaunch it (it cannot prove the pane is that seat's), and `team remove <seat> --keep`
  refuses a screen the profile does not recognise — run `team remove <seat> --abandon`, or `team down --abandon`,
  then `team up`.
- **A stopped team has no screen for `doctor` to read**, so a file that names a model family its CLI doesn't
  run is only met at the first launch: that seat is left at launch with a line naming the fix; a second edit
  and a second `team approve` follow. The seat left at launch still sits in its pane, unnamed: close that pane
  by hand (in herdr; no `team` command does it), then run `team up`: it launches the seat again in a new pane
  and leaves the running seats as they are. Without that, `team up` refuses the session (``team up: session
  <name> has 1 agent this file's state doesn't record: `up` never touches a running team``). Don't reach
  for `team down` there: it stops your other seats and leaves that pane (`skip session <name>: not stopped, 1
  agent left in it`).

What else changes for you:

- **The lead's spelling moved.** Everything `team` prints now calls the seat that leads the
  **orchestrator**, and the new spelling in the file is `leads: true` on that seat's block. The
  `coordinator:` key is still read, exactly as before: it prints one notice per load
  (`` `coordinator:` is now `leads: true` on the lead's seat, and is still read ``), and
  `dialogs.trust: coordinator` is read beside `orchestrator` and `owner`. The notice is the only
  line either spelling gains: a keyed file and a marked file approve to the same record, so
  rewriting the key to the mark needs no new `team approve`.
- **`team init` writes the new spelling**: the seat is `role: orchestrator`, `name: orchestrator`,
  carries `leads: true`, and `operator:` names it. Its `cli:` line is the first of `claude-code`,
  `codex`, `cursor`, `antigravity` this machine is signed in to (a login check that cannot tell is
  not a yes; `claude-code` when none answers).
- **Your coordinator's commands.** If 0.2.1 recorded the coordinator's pane, `add`, `remove`, `worktree`,
  `down` and `answer` keep working from that pane. If it did not (a coordinator started by hand), they are
  refused with ``no pane is recorded for seat <name> in this session: the owner stops that seat and runs
  `team up` ``; the repair is yours: `team down`, then `team up`.
- **`--session` and `--file` on those commands are yours alone**, from a terminal outside herdr. From a
  coordinator's pane the line is
  `team <cmd>: --session is the owner's, from a terminal outside herdr; this call is unplaced (it runs under herdr)`
  (the same for `--file`). A coordinator needs neither: its session is read from where it sits.
- **If your worktrees live inside the project** (`workspace.path` under the project root): `up` refuses that,
  as 0.2.1 did; move `workspace.path` out first, then run `team doctor` again for the block.
- **The old `.lobby` folder** beside your worktrees: `doctor` says when it may be removed.
- **A seat that stops at a dialog during `up`**: with you at a terminal, `up` does not close it first. It
  prints `<seat> is waiting at trust: [o] open pane, [s] skip seat, [q] stop cleanly` and types nothing into
  the pane. `o` focuses the pane and asks again; `s` closes its workspace (`left out: skipped by owner`); `q`
  closes it and stops the rest of the run (`left out: stopped cleanly`). With no terminal, `up` does not ask:
  it closes the workspace without input (`left out: trust (no terminal for owner)`).

- **A dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch).** Nothing is written. A refusal it reaches is a change in behaviour.
- **`team check` is two commands now**: `team commits check <ref>` checks commits, and `team pr check <file>` checks a pull request's body alone, in a folder with no repository at all. Every old form is still read through 0.3.3, one notice line first; bare `team check` is reserved for the team's own check, which a later build brings.

How to tell it is done: `team doctor` ends `nothing missing` (notes about a placeholder version `"0"` may
remain), and `team status --json` shows each seat's `start_cwd` under `~/.config/team/lobby`. `team status`
shows each seat's screen (`idle`), and still counts a difference and exits 1 for a seat whose file says
version `"0"`: write the version `doctor` names (for example `"5.5"`) and run `team approve` to clear it.
