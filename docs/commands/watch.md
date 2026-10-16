# team watch

Watches a running team. Every `watch.interval` seconds it reads the session — the seats, their
screens, the file, the approval, the machine — prints what is wrong, and removes a merged worktree
whose end holds. When a report is waiting, and an approval is in force, it types one fixed line
into an idle seat — the nudge — so that seat reads the log. It writes the seats' sidebar lines —
the workspace title from the file, and the display line from the file and the pane's screen; it
paints them on its first cycle and again when the title, the model or the effort changes.

## Synopsis

    team watch [--session <name>] [--file <path>] [--no-nudge] [--no-notify]

## Flags

| Flag | Meaning |
| --- | --- |
| `--session <name>` | the herdr session to watch, instead of `team.session` |
| `--file <path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--no-nudge` | the owner's. Type nothing into any pane: no report nudge and no message ring. The reports still go to the log, and a report for the owner is still a desktop notification |
| `--no-notify` | the owner's. No desktop notification for a report addressed to the operator. A report addressed to the owner is still notified, still written to the log, and still visible in `team status` |
| `--help`, `-h` | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| anyone, in any terminal | run one by hand: it prints the same lines as the watch `up` started, and Ctrl-C stops it and exits 0. Two watches must not fight over the same session, so a second one refuses |
| `up` | start one for the session as a background process, and record its pid. This is the one `team status` and `team doctor` look for. The watch `up` starts reads the project's own file from the project root and carries no flag |
| the owner | `--no-nudge` and `--no-notify` are the owner's: a seat that passed either would be holding the session's only watch with the nudge, or the notices, turned off. `--file` is the owner's alone too, so a non-owner aiming `--file` at another project is refused before that file is read |
| a run with no terminal | refused before the watch starts: `team watch: only the owner runs this, from a terminal outside herdr` |

## How a screen is read

A pane's screen is read by the profile's own expressions — the words a CLI paints for its idle
prompt, its working frame, its dialogs, its questions and the vendor notices it was captured on —
and the reading and the live-agent check are separate layers. A screen that reproduces a CLI's
complete idle frame (input row, status row and workspace line, in place) reads idle; the live-agent
check is the second layer. For Cursor the profile pins the status row's place: a line the row's
grammar matches is the row only when the workspace line sits directly below it, that line is the
pane's last non-blank one, and the input row sits above it within the captured distance — a
grammar-looking line anywhere else is ordinary text that names no row and no model. Grok rows are
the profile's exception — selected by their grammar wherever they sit — and every Grok row in the
captures carries exactly the two spaces that grammar spells.

## What it prints

Every line carries its time, and every line goes to `.agents/team.log` as well. A report is
printed when it starts, and again only after it has cleared: a seat that stays blocked, or a
machine that stays full, is said once, not every pass. One report, the seat's identity, in full:

`<seat> is no longer the process team launched (its session was restored, or its CLI was restarted)`
— the process in the seat's pane is not the one recorded when `team` launched it: the pane runs
no CLI, or a program `team` did not launch runs in it and the agent session herdr shows there is
not the one stored at launch. A pane the stored session came back on is the seat again and is not
reported; a seat with no record of its launch, or a pane herdr can't read, is not reported either.

## Refusals

| Message | Exit |
| --- | --- |
| `team watch: a watch already runs for the session "<session>" (pid <pid>)` | 1 |
| `team watch: --file is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team watch: --no-nudge and --no-notify are the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team watch: unknown option --x` / `team watch: unexpected "x"` (each with the usage) | 2 |
| `team watch: team.yaml line <n>: <message>` / `team watch: <message>` | 2 |

## Exit codes

- `0` — the watch ran, and stopped on Ctrl-C, a stop signal, or the end of its work. A seat that
  misbehaves is a report, not a failure; neither is herdr not answering.
- `1` — a watch already runs for the session. Or a caller that is not the owner aimed `--file`,
  or passed `--no-nudge` or `--no-notify`.
- `2` — the invocation, the team file or the state can't be read.

## Example

The four that can't be turned off — `attention`, `missing`, `model-drift` and `approval` — are
refused by the schema itself, with the line, and so is a name that is no check. A command that
reads such a file refuses it the same way, and the watch keeps the last copy that validated, with
the checks as the owner approved them.

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

watch:
  interval: 120s
  checks:
    attention: off
    disks: off

workspace:
  mode: shared

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```console
$ team up ; echo "exit $?"
team up: line 9: watch.checks can't turn off attention: attention, missing, model-drift, approval always run
team up: line 10: unknown check "disks" in watch.checks: the checks are missing, restored, model-drift, attention, provider-error, unsent, idle, extra, team-idle, approval, load, memory, disk, swap-free, swap-growth, budget
exit 2
```

Rationale, what it reads and writes, how a screen is read in full, what it types and what it
leaves alone, the other reports and nudge lines, the budgets, and the known limits:
[docs/internal/watch.md](../internal/watch.md).
