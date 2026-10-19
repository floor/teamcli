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
`now` is the owner's force; `cancel` takes a swap out of the queue. `team status` prints each
queued swap as a `note:` line, and `team next` refuses a claim for the seat a swap waits on.

## Synopsis

    team swap [--file <path>] [--json]
    team swap --rule [--file <path>] [--json]
    team swap queue <seat> [--to <target>] [--file <path>] [--json]
    team swap now <seat> [--file <path>] [--json]
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

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | everything, including `now` and `--file` |
| the orchestrator's or the operator's seat, on the pane the state records for it | queue and cancel, and the views |
| any other seat of the team, on the pane the state records for it | the view and `--rule` |
| any other caller, or a seat whose pane the state does not record | nothing: the view says `team swap: this team is not yours to read`; queue and cancel name the placement |
| a run with no terminal | `now` alone refuses it: `team swap: only the owner runs this, from a terminal outside herdr or its own seat` |

## Flags

| Flag | Meaning |
| --- | --- |
| `--rule` | list every breach of the entity's model rule, with the donor each recipe came from |
| `--to <target>` | with `queue`: take the recipe from a seat running `<cli>:<model>`, instead of the rule's own proposal |
| `<seat>` | the seat to queue, force or cancel; required by `queue`, `now` and `cancel` |
| `--file <path>` | the team file to read; the owner's alone |
| `--json` | emit a `team.swap` v1 JSON document (`schema/swap.schema.json`) on `stdout` |
| `--help`, `-h` | the usage, and exit 0 |

## Refusals

| Message | Exit |
| --- | --- |
| `team swap: <how the invocation is malformed>` (with the usage) | 2 |
| `team swap: <why the team file did not load>` | 2 |
| `team swap: this team is not yours to read` | 1 |
| `team swap: only the owner forces a swap; this call is <caller>` | 1 |
| `team swap: only the owner runs this, from a terminal outside herdr or its own seat` | 1 |
| `team swap: only the owner, the orchestrator or the operator queues or cancels a swap; this call is <caller>` | 1 |
| `team swap: no pane is recorded for seat <name> in this session: a lead stops that seat and runs \`team up\`` | 1 |
| `team swap: the state records pane <recorded> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)` | 1 |
| `team swap: no seat "<name>" is declared in <project>` | 1 |
| `team swap: <seat> waits on no swap` | 1 |
| `team swap: <why the entity's model rule cannot be read, or that none is declared>` | 1 |
| `team swap: <seat> declares a model the rule allows; there is nothing to swap to` | 1 |
| `team swap: no seat of the entity this team may copy from runs <cli>:<model>` | 1 |
| `team swap: <why no recipe is available for this seat>` | 1 |
| `team swap: the state cannot be written: <why>` | 1 |

## Exit codes

- `0` — the queue or the rule listing was shown, or a swap was queued, forced or cancelled.
- `1` — it was refused: the caller may not do this, the rule or the wait cannot be read, no recipe
  is available, no such seat, no swap waits, or the state can't be read or written.
- `2` — the invocation can't be read, or the team file can't.

## Example

```fixture
approved: false
herdr: none
agents: none
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

The owner forces it, and a cancel takes it out of the queue:

```console
$ team swap now claude-keeper ; echo "exit $?"
swap forced: claude-keeper: anthropic Claude Opus 5.5 -> deepseek DeepSeek Flash 4.0 (the entity model rule), queued 2026-10-04T09:00:00.000Z, forced by owner at 2026-10-04T09:00:00.000Z
exit 0
$ team swap cancel claude-keeper ; echo "exit $?"
swap cancelled: claude-keeper
exit 0
```

A seat the rule allows has nothing to swap to, and nothing waits once the queue is empty:

```console
$ team swap queue worker ; echo "exit $?"
team swap: worker declares a model the rule allows; there is nothing to swap to
exit 1
$ team swap cancel worker ; echo "exit $?"
team swap: worker waits on no swap
exit 1
```

The orchestrator's seat queues nothing without the pane the state records for it, and only the
owner forces a swap:

```console caller=claude-keeper
$ team swap queue claude-keeper ; echo "exit $?"
team swap: no pane is recorded for seat claude-keeper in this session: a lead stops that seat and runs `team up`
exit 1
$ team swap now worker ; echo "exit $?"
team swap: only the owner forces a swap; this call is claude-keeper
exit 1
```
