# `team restart`: Design

## Summary

Restarting a seat today requires either `team remove <seat> && team add <seat>` (which edits `team config` twice and cannot be used to cycle a seat whose declaration stays in place) or `team down && team up` (which stops every other seat in the session).

`team restart` stops and relaunches seats in place without editing `team config`:

```
team restart <seat> [--abandon] [--dry-run] [--session <name>] [--file <path>]
team restart [--abandon] [--dry-run] [--session <name>] [--file <path>]
team restart --changed [--abandon] [--dry-run] [--session <name>] [--file <path>]
```

- **`team restart <seat>`** restarts a single declared seat in place.
- **`team restart`** stops the running team and launches it again under a single session lock.
- **`team restart --changed`** compares each active declared seat against the running session and restarts only the seats whose configuration changed or whose process is no longer running.
- `<seat>` and `--changed` are mutually exclusive (`exit 2`, `restart.usage`).

---

## Who May Run It

| Form | Owner (terminal outside herdr) | A lead seat — the orchestrator's, or a seat the record marks a lead (from its recorded pane) | Any other seat, unplaced pane, or detached run |
| --- | --- | --- | --- |
| `team restart <seat>` | Yes (`--abandon`, `--session`, `--file` allowed) | Yes, for another seat (`--abandon` allowed on non-lead seats that are not `working`; never `--session` or `--file`) | Refused (`restart.caller` or `restart.detached`, exit 1) |
| `team restart` | Yes | Refused (`restart.caller`, exit 1) | Refused (`restart.caller` or `restart.detached`, exit 1) |
| `team restart --changed` | Yes | Refused (`restart.caller`, exit 1) | Refused (`restart.caller` or `restart.detached`, exit 1) |

### Caller invariants for `team restart <seat>`

1. **Detached calls**: a run with no terminal (`caller.kind === 'owner-no-tty'`) is refused before reading any file (`restart.detached`, exit 1).
2. **Owner-only flags**: `--session` and `--file` are the owner's alone (`restart.session-owner`, `restart.file-owner`, exit 1). When a lead runs `team restart <seat>` from its lobby without `--file`, `launchedTeamFile` resolves the project's `team config`.
3. **Recorded pane verification**: a lead caller must run from the pane recorded for its seat in `.agents/state.json` (`standingOf(dir, session, caller)`). Missing or mismatched pane records are refused (`restart.caller`, exit 1).
4. **No self-restart from a seat**: a seat caller cannot restart its own recorded pane because closing the workspace kills the calling shell mid-command before the relaunch runs (`restart.self`, exit 1: ``team restart: the <seat> cannot restart its own recorded pane; another `leads` seat (or the owner) restarts it``).
5. **No seat-initiated `--abandon` on lead seats**: a seat caller may not pass `--abandon` when targeting the orchestrator's or the operator's seat (`restart.lead`, exit 1: `team restart: a seat caller does not abandon the orchestrator's or the operator's seat; this call is <caller>`).

---

## Target Seat Rules (One-Seat Form)

Given `<seat>`:

1. **Temporary copy (`restart.temporary`, exit 1)**: if `.agents/state.json` records `<seat>` with `temporary: true` and the seat is not declared in `team.seats`, `team restart` refuses:
   ```
   team restart: <seat> is a temporary copy; use team remove <seat> then team add --temporary --like <source>
   ```
2. **Unknown seat (`restart.unknown`, exit 1)**: if `<seat>` is not in `team.seats`, `team restart` refuses:
   ```
   team restart: <seat> is not a signed declared seat
   ```
3. **Parked or stopped seat (`restart.signed-off`, exit 1)**: if the declared seat has `parked: true` or `stopped: true`, `team restart` refuses:
   ```
   team restart: <seat> is signed off; the owner takes the sign-off off in the file and runs team up
   ```

---

## Pre-Close Facts and Stop Safety

### Process identity (`restart.replaced`)

Before typing an exit sequence or closing a live pane, `team restart` checks `seatProcessVerdict(recordedSeat, foreground)` against the pane's foreground processes:

- If the foreground process is neither the seat's CLI nor a shell (`verdict === 'replaced'` and `continuity === 'doubt'`), `team restart` refuses to touch the pane or launch a duplicate beside it (`restart.replaced`, exit 1):
  ```
  team restart: <seat> has a process in its old pane that is not the signed seat; left as it is
  ```
  The `--json` refusal's `repair` names `team restart <seat> --abandon` when herdr still names
  the seat on the recorded pane. With that flag the run closes the pane's workspace without
  typing into it — no exit text, no key, no draft — and relaunches the seat in a fresh
  workspace through its launcher. A `replaced` pane herdr does not name as this seat is refused
  with or without the flag.

### Safe states vs busy states

`downPlan` classifies the target seat's live pane into one of:

- `free` — idle at its prompt with an empty input box and verified process identity.
- `exited` — the CLI has already exited and the pane is back at a bare shell.
- `gone` — no live pane in the session carries the seat.
- Busy states: `working`, `unsent`, `permission`, `question`, `exit-question`, `trust`, `error`, and `unknown` — except that an unread screen on a seat herdr itself reports `idle` or `done` is not busy: it is advice, and the workspace is closed without typing into it:
  ```
  <seat>: screen: not recognised; herdr reports it <status>; the workspace is closed without typing into it
  ```

Without `--abandon`:
- `free`, `exited`, and `gone` are stopped outright.
- `unsent` on a seat herdr reports `idle` or `done`, whose CLI's profile carries an `input` block,
  is stopped after its text is copied: the box is read at once, the copy is written under the
  state folder, and the text is pasted back into the new pane's box (see **Unsent text: copy,
  close, paste back** below).
- Every other busy state is refused before touching the pane (`restart.busy`, exit 1):
  ```
  team restart: <seat> is <state>; left as it is
  ```
- `unsent` keeps that refusal where a faithful copy cannot be made — a CLI whose profile has no
  `input` block, a seat herdr reports mid-turn, a box behind a fold marker or a paste chip, a box
  drawn over more than one row (where a soft wrap cannot be told from a newline), or a
  box whose rows cannot be read. The box's own reason follows the box words where there is one,
  and the owner's two ways out are named:
  ```
  team restart: <seat> holds unsent text in its input box <reason>; left as it is (the owner clears it in its pane, or team restart <seat> --abandon closes it)
  ```
  A CLI with no measured input keys keeps the plain words: `team restart: <seat> holds unsent
  text in its input box; left as it is`.

### Unsent text: copy, close, paste back

An idle seat holding unsent text is restarted, not refused. The run, in order:

1. Reads the box with its styling and captures its row — the same capture a delivery makes: a
   fold marker, a paste chip, a box drawn over more than one row (a soft wrap and a newline draw
   alike, so the rows cannot be copied faithfully), and a box whose rows cannot be read are
   refused, never guessed.
2. Writes the text to `<state dir>/restart-drafts/<session>/<seat>.draft` (0600, its folders
   `0700`) under the session run lock, before anything is closed. An identical copy already
   there is reused; one holding different text is an earlier run's and is never overwritten — the
   restart is refused and both stay as they are.
3. Prints the pre-close facts with the copy's path:
   ```
   <seat>: input box: holds unsent text, copied to <path> and pasted back once the new pane is ready
   <seat>: turn: not working (unsent)
   <seat>: context: workspace close ends the pane; relaunch runs "<launch>" in a new workspace without passing the old transcript
   ```
4. Closes the old workspace without typing into it — the copied text is what waits for the new
   pane, so no exit sequence is typed over it — and relaunches as usual.
5. Once the new pane reaches `ready`, waits for herdr to report it `idle` or `done` and pastes the
   text back with a bracketed paste, reading the box back as the same row (a CLI that folds the
   paste is read by its paste chip's line count) for up to two seconds.
   - Read back: the copy is removed and the run prints `<seat>: unsent text pasted back`.
   - Not read back: the copy stays, and the run prints `<seat>: the unsent text could not be
     pasted back (<reason>); its copy is at <path>` and names it in the log. The seat still
     counts as restarted.
6. A failure before the new pane is ready keeps the copy too, and the refusal or failure names
   it (`; its unsent text is copied at <path>`). The copy is removed only after the text is read
   back in the new box.

`--abandon` stays what it was: it closes the workspace without typing and without a copy, since
abandoning is the owner saying the text may go. `--dry-run` names the copy the run would make.

With `--abandon`:
- **Owner**: any busy state (including `working`) is closed by closing the workspace directly without typing into the pane.
- **A lead**: a stuck non-working state (`unsent`, `permission`, `question`, `exit-question`, `trust`, `error`, `unknown`) is closed by closing the workspace without typing. If the seat is `working`, `--abandon` from a seat caller is refused (`restart.abandon-working`, exit 1):
  ```
  team restart: <seat> is working; a seat's --abandon leaves it (the owner's --abandon closes it)
  ```

### Three-fact block printed before closing a live pane

Whenever `team restart` closes a running or exited pane, it first prints three lines on stdout stating what is in the pane and what closing it entails:

```
<seat>: input box: empty | holds unsent text | holds unsent text, copied to <path> and pasted back once the new pane is ready | not read (the screen is not recognised)
<seat>: turn: not working (<state>) | mid-turn (working)
<seat>: context: workspace close ends the pane; relaunch runs "<launch>" in a new workspace without passing the old transcript
```

If graceful exit on a `free` seat fails to return the pane to its shell or close the workspace, `team restart` aborts (`restart.busy`, exit 1) and never launches a second copy beside the still-open pane.

---

## Launch Preflight and Relaunch

Before stopping the running seat, `team restart <seat>` checks everything needed to relaunch it so a preflight refusal leaves the running seat untouched:

1. **Session running**: the herdr session must be running (`restart.no-session`, exit 1; or `restart.herdr`, exit 1 if herdr does not answer).
2. **Launch profile and doctor**: `profileFor(seat.cli)` must exist and `doctorSeatChecks` must have no failure (`restart.not-ready`, exit 1).
3. **Machine and budget checks**: `checkMachine` and `checkSeatBudgets` (against the remaining running seats after excluding `<seat>`) must pass (`restart.not-ready`, exit 1).
4. **Lobby and workspace**: `ensureSeatLobby` prepares the seat's lobby directory when applicable.

Once the old pane is stopped and closed:

1. `upPlan` builds a single-seat launch plan for `<seat>` against an empty live agent list for that seat (with `watchAlreadyAlive: true` so the single-seat restart does not spawn a second watch).
2. `executePlan` creates the new workspace, runs the launch command, renames the herdr agent to `<seat>`, waits for the ready prompt, and delivers the role prompt.
3. On `ready` (or `recovery` at a folder-trust dialog):
   - Updates `.agents/state.json` (`state.seats[<seat>]`) with the new pane, workspace, launch timestamp, and process name.
   - Calls `noteLaunchedPane` so the lobby's `launched.json` maps the new pane to the team file.
   - Appends `<ISO-8601> restart [<caller>] restarted <seat>; pane <old-pane> -> <new-pane>` to `.agents/logs/team.log`.
   - Prints `team restart: restarted <seat>; pane <old-pane> -> <new-pane>` on stdout and exits `0` (`restart.ready`).
4. If the new launch fails to reach `ready` or `recovery`, `team restart` logs the failure and exits `1` (`restart.not-ready`).

---

## Whole-Team (`team restart`) and Changed-Seats (`team restart --changed`)

### Whole-team (`team restart`)

1. Owner-only from a terminal outside herdr.
2. Acquires `acquireRunLock(dir, session)` once for the entire stop-and-launch cycle.
3. Runs `downPlan` across all running seats and preflights `up` (`doctor`, machine limits, budgets). If any seat is busy (without `--abandon`) or preflight fails, refuses with exit `1` before stopping anything.
4. Prints the three-fact block for each live seat, stops all seats and the watch, then runs the full `upPlan` + `executePlan` wave launch.

### Changed-seats (`team restart --changed`)

1. Owner-only from a terminal outside herdr.
2. Compares each active declared seat (`!seat.stopped && !seat.parked`) against the live session and `.agents/state.json`:
   - **Liveness**: the seat has no live agent in herdr, or its pane is back at a bare shell.
   - **Launch line and model**: `seat.launch`, `seat.cli`, `seat.model`, or `seat.version` differs from the recorded launch state.
   - **Workspace**: resolved workspace path or branch differs from the live agent's `cwd` or recorded workspace.
   - **Prompt and environment digest**: SHA-256 digest of the resolved role prompt, `seat.instructions`, `seat.env`, `seat.permissions`, and `seat.mcp` differs from the digest recorded at launch.
3. Seats that match on every axis are left untouched. If no seat differs, prints `team restart: no seats changed` and exits `0`.
4. Preflights stop safety and launch readiness for every seat in the changed set before stopping any of them, then stops and relaunches only the changed seats.

---

## Exit Codes

| Code | ID | Meaning |
| --- | --- | --- |
| `0` | `restart.ready` | the seat was restarted in a new pane |
| `0` | `restart.dry-run` | the dry-run plan was printed and nothing was touched |
| `1` | `restart.abandon-working` | a seat caller passed `--abandon` on a working seat |
| `1` | `restart.busy` | the seat is busy and `--abandon` was not given, or graceful stop did not close the pane |
| `1` | `restart.caller` | the caller may not run `team restart` (or passed an owner-only flag) |
| `1` | `restart.detached` | a run with no terminal |
| `1` | `restart.herdr` | herdr does not answer |
| `1` | `restart.lead` | a seat caller passed `--abandon` for the orchestrator's or the operator's seat |
| `1` | `restart.no-session` | the herdr session is not running |
| `1` | `restart.not-ready` | preflight or launch did not produce a ready seat |
| `1` | `restart.replaced` | the old pane holds a process that is not the seat's CLI |
| `1` | `restart.run-lock` | another session-mutating run holds the session lock |
| `1` | `restart.self` | a seat caller tried to restart its own recorded pane |
| `1` | `restart.signed-off` | the seat is parked or stopped |
| `1` | `restart.temporary` | the seat is a temporary copy |
| `1` | `restart.unknown` | the seat is not a declared seat |
| `2` | `restart.configuration` | the team file cannot be read or validated, or the cwd is not a git repository |
| `2` | `restart.usage` | invalid flags or missing `<seat>` argument |

---

## Rollout Plan

1. **Step 1 (this PR)**: land `docs/design/restart.md` and the one-seat form `team restart <seat> [--abandon] [--dry-run] [--session <name>] [--file <path>]`, including reference docs, contract, exit codes, and tests.
2. **Step 2 (follow-up PR)**: record the per-seat launch digest in `.agents/state.json` on `up` / `add` / `restart`, and enable whole-team `team restart` and `team restart --changed`.
