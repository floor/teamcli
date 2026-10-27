# team swap

The entity's model rule says which labs may run on which seats (Policies rule 10). A seat whose
team file declares a vendor the rule forbids is out of rule, and a swap is its way back: the seat
takes the model fields of a donor seat of the entity that already runs an allowed model, and keeps
its own name, role, nickname, place and account. The recipe is copied from a seat, never invented;
a public team draws no recipe from a private one, and a donor from the same team — and, within
that, the same CLI — comes first.

The queue is the project's, beside the hold and the pause. A queued swap never interrupts a
working seat: it runs at the seat's boundary — quiet, no turn, no dialog, no lease and no work drop
— or, once the wait has passed, at the next pause between two turns. A broken seat, and a swap the
owner forced, runs at once. `team swap` shows the queue; `--rule` lists every breach of the rule
in the entity's teams with the donor each recipe came from; `queue` puts a swap in the queue;
`now` is the owner's force, which runs the sweep at once; `--run` carries out every queued swap
that is due now; `cancel` takes a swap out of the queue. `team status` prints each queued swap as
a `note:` line, and `team next` refuses a claim for the seat a swap waits on.

## Synopsis

    team swap [--file <path>] [--json]
    team swap --rule [--file <path>] [--json]
    team swap queue <seat> [--to <target>] [--file <path>] [--json]
    team swap now <seat> [--file <path>] [--json]
    team swap --run [--file <path>] [--json]
    team swap cancel <seat> [--file <path>] [--json]

A `<target>` is `<cli>:<model>`, and the recipe is copied from a seat of the entity that already
runs it.

## What it reads and writes

Reads the team file in the current folder, the entity policy source under
`<home>/.config/team/entities.yaml`, the team records of the entity in the registry, and the state
beside the team file. Writes one `swaps` record at the top level of the state:

    {
      "format": 1,
      "swaps": {
        "claude-keeper": {
          "from": {
            "cli": "claude-code",
            "vendor": "anthropic",
            "model": "Claude Opus",
            "version": "5.5",
            "display": "Claude Opus 5.5"
          },
          "to": {
            "cli": "claude-code",
            "vendor": "deepseek",
            "model": "DeepSeek Flash",
            "version": "4.0",
            "display": "DeepSeek Flash 4.0",
            "launch": "claude --model deepseek-flash"
          },
          "reason": "model-rule",
          "queuedAt": "2026-10-04T09:00:00.000Z",
          "deadline": "2026-10-04T09:30:00.000Z",
          "waitFor": "the seat's boundary (quiet, no turn, no dialog, no lease, no work drop)",
          "rule": "*=!anthropic"
        }
      },
      "sessions": {}
    }

`from` and `to` are the file's words at queue time; `to` also carries the launch line and the
optional model fields a recipe brought. The wait is the resolved `swap-wait-seconds` policy, in
seconds — 1800 when no level sets one — and `deadline` is `queuedAt` plus that wait. A forced swap
carries `forced: { "by": ..., "at": ... }`; a swap the owner started from nothing carries
`"reason": "owner"`. A hand-edited record that is not the record this command writes is dropped
when the state is read, so it is never printed by any reader.

A run — `--run`, or the sweep `now` starts — writes the recipe into the seat's own declaration,
ends the recorded session with reason `swap`, stops the old pane and launches the seat in a fresh
workspace from the new declaration. The conversation resumes when the CLI stays the same and keeps
sessions and a session id is recorded; otherwise the old conversation is asked, at its boundary,
to write a handover the new one reads. Once the pane is ready the run reads the model back: the
profile's own reading first, then the launch wrapper's `· API Usage Billing` banner. A screen that
shows neither is reported as `read-back: unread`, and unread never claims a match. The record is
removed once the pane is ready, the file's declaration was written and the read-back agrees or is
unread; a declaration write that failed or a different model is reported as a failed swap, and the
record stands for the next pass. `now` writes `forced` before it runs the record: when the run
cannot start — herdr cannot be read, a busy turn, a refused stop — the exit code reports the run's
own failure and the forced record stays in the queue for the watch or a later `--run`; the refusal
is not a rollback.

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | everything, including `now`, `--run` and `--file` |
| the orchestrator's or the operator's seat, on the pane the state records for it | queue, `--run` and cancel, and the views |
| any other seat of the team, on the pane the state records for it | the view and `--rule` |
| any other caller, or a seat whose pane the state does not record | nothing: the view says `team swap: this team is not yours to read`; queue, `--run` and cancel name the placement |
| a run with no terminal | `now` alone refuses it: `team swap: only the owner runs this, from a terminal outside herdr or its own seat` |

## Flags

| Flag | Meaning |
| --- | --- |
| `--rule` | list every breach of the entity's model rule, with the donor each recipe came from |
| `--to <target>` | with `queue`: take the recipe from a seat running `<cli>:<model>`, instead of the rule's own proposal |
| `<seat>` | the seat to queue, force or cancel; required by `queue`, `now` and `cancel` |
| `--run` | carry out every queued swap that is due now; `--json` prints one result per seat |
| `--file <path>` | the team file to read; the owner's alone |
| `--json` | emit a `team.swap` v1 JSON document (`schema/swap.schema.json`) on `stdout` |
| `--help`, `-h` | the usage, and exit 0 |

## Refusals

| Message | Exit |
| --- | --- |
| `team swap: <how the invocation is malformed>` (with the usage) | 2 |
| `team swap: <why the team file did not load>` | 2 |
| `team swap: team config is invalid, so a swap cannot write the new declaration or launch from it` | 2 |
| `team swap: this team is not yours to read` | 1 |
| `team swap: only the owner forces a swap; this call is <caller>` | 1 |
| `team swap: only the owner runs this, from a terminal outside herdr or its own seat` | 1 |
| `team swap: only the owner, the orchestrator or the operator queues, runs or cancels a swap; this call is <caller>` | 1 |
| `team swap: no pane is recorded for seat <name> in this session: a lead stops that seat and runs \`team up\`` | 1 |
| `team swap: the state records pane <recorded> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)` | 1 |
| `team swap: no seat "<name>" is declared in <project>` | 1 |
| `team swap: <seat> waits on no swap` | 1 |
| `team swap: <why the entity's model rule cannot be read, or that none is declared>` | 1 |
| `team swap: <seat> declares a model the rule allows; there is nothing to swap to` | 1 |
| `team swap: no seat of the entity this team may copy from runs <cli>:<model>` | 1 |
| `team swap: <why no recipe is available for this seat>` | 1 |
| `team swap: herdr cannot be read, so the forced swap cannot run now` | 1 |
| `team swap: herdr cannot be read, so no swap can be run now` | 1 |
| `team swap: <seat>: <why the run was refused>` | 1 |
| `team swap: <seat>: read-back: mismatch — the file declares <expected>, the screen shows <shown>; the swap failed` | 1 |
| `team swap: the state cannot be written: <why>` | 1 |

## Exit codes

- `0` — the queue or the rule listing was shown; a swap was queued, forced or cancelled; or a run
  carried out what was due, whether or not one was due.
- `1` — it was refused: the caller may not do this, the rule or the wait cannot be read, no recipe
  is available, no such seat, no swap waits, herdr cannot be read so a run cannot start, a due
  swap failed or read back a different model, or the state can't be read or written.
- `2` — the invocation can't be read, or the team file can't.

## Example

```fixture
approved: false
herdr: running
agents: all
watch: none
```

```yaml file=.agents/team.yaml
format: 1
project: beacon
entity: lab
operator: claude-keeper

trust:
  - ~/.config/team/lobbies/lab
  - ~/Code/beacon

workspace:
  mode: shared
seats:
  - role: project coordinator
    name: claude-keeper
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "4.0"
    launch: claude --model deepseek-flash
```

The owner sets the entity rule that refuses this lab, and the listing names the breach and the
donor its recipe comes from:

```console
$ team policy set entity model-rule '*=!anthropic' ; echo "exit $?"
policy: set model-rule=*=!anthropic at entity (lab)
exit 0
$ team swap --rule ; echo "exit $?"
rule: *=!anthropic (entity lab)
beacon/claude-keeper: role project coordinator, vendor anthropic -> claude-code DeepSeek Flash 4.0 from beacon/worker
exit 0
```

A queue request waits for the boundary, the default thirty minutes at most:

```console
$ team swap ; echo "exit $?"
swap: beacon (entity lab)
nothing queued
exit 0
$ team swap queue claude-keeper ; echo "exit $?"
swap queued: claude-keeper: anthropic Claude Opus 5.5 -> deepseek DeepSeek Flash 4.0 (the entity model rule), queued 2026-10-04T09:00:00.000Z, waits for the seat's boundary (quiet, no turn, no dialog, no lease, no work drop), runs by 2026-10-04T09:30:00.000Z
exit 0
$ team swap ; echo "exit $?"
swap: beacon (entity lab)
claude-keeper: anthropic Claude Opus 5.5 -> deepseek DeepSeek Flash 4.0 (the entity model rule), queued 2026-10-04T09:00:00.000Z, waits for the seat's boundary (quiet, no turn, no dialog, no lease, no work drop), runs by 2026-10-04T09:30:00.000Z
exit 0
```

The orchestrator's seat queues on the pane the state records for it, and only the owner forces a
swap:

```console caller=claude-keeper
$ team swap queue claude-keeper ; echo "exit $?"
swap queued: claude-keeper: anthropic Claude Opus 5.5 -> deepseek DeepSeek Flash 4.0 (the entity model rule), queued 2026-10-04T09:00:00.000Z, waits for the seat's boundary (quiet, no turn, no dialog, no lease, no work drop), runs by 2026-10-04T09:30:00.000Z
exit 0
$ team swap now worker ; echo "exit $?"
team swap: only the owner forces a swap; this call is claude-keeper
exit 1
```

The owner forces the swap while the seat is mid-turn: the force stands and the swap stays queued,
because a working seat is never interrupted. A cancel takes it out of the queue:

```console screens="claude-keeper=working"
$ team swap now claude-keeper ; echo "exit $?"
swap forced: claude-keeper: anthropic Claude Opus 5.5 -> deepseek DeepSeek Flash 4.0 (the entity model rule), queued 2026-10-04T09:00:00.000Z, forced by owner at 2026-10-04T09:00:00.000Z
claude-keeper: stays queued (claude-keeper is working; left as it is; the queue stands)
exit 0
$ team swap cancel claude-keeper ; echo "exit $?"
swap cancelled: claude-keeper
exit 0
```

At its boundary the seat is swapped: the old pane is stopped, the file takes the recipe, the seat
launches from it, and the new screen is read back:

```console
$ team swap queue claude-keeper ; echo "exit $?"
swap queued: claude-keeper: anthropic Claude Opus 5.5 -> deepseek DeepSeek Flash 4.0 (the entity model rule), queued 2026-10-04T09:00:00.000Z, waits for the seat's boundary (quiet, no turn, no dialog, no lease, no work drop), runs by 2026-10-04T09:30:00.000Z
exit 0
$ team swap --run ; echo "exit $?"
claude-keeper: input box: empty
claude-keeper: turn: not working (free)
claude-keeper: context: workspace close ends the pane; relaunch runs "claude --model deepseek-flash" in a new workspace without passing the old transcript
claude-keeper: stopped
claude-keeper: ready
claude-keeper: its screen doesn't show a model this version knows; not checked
swapped: claude-keeper in w3:p1 (read-back unread)
exit 0
$ team swap ; echo "exit $?"
swap: beacon (entity lab)
nothing queued
exit 0
```

A seat the rule allows has nothing to swap to, nothing waits once the queue is empty, and a run
with nothing due is no work:

```console
$ team swap queue worker ; echo "exit $?"
team swap: worker declares a model the rule allows; there is nothing to swap to
exit 1
$ team swap cancel worker ; echo "exit $?"
team swap: worker waits on no swap
exit 1
$ team swap --run ; echo "exit $?"
exit 0
```
