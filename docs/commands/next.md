# team next

Claims one record from the file the team file names, and holds it with a lease in this clone.
The answer is the context line, the record's block, and one closing summary line. A seat cannot
pull until `team up` has recorded its pane; the owner is refused, and so is a name that is not a
seat. The source is a file the owner committed, or a tracker the owner's broker reads — with no
broker running, `next` refuses and claims nothing.

A seat that waits on a queued model swap ([team swap](swap.md)) claims nothing either: the swap
runs at the seat's own boundary, so the seat takes no new task while it waits. The refusal is one
line naming the queued swap and the way out, and `--release` still runs — letting go of the lease
a seat holds is how a waiting seat stands down.

## Synopsis

    team next [--mine | --release] [--wait] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--mine` | — | a new take keeps only records whose `assignee` is the caller's seat name; a renewal is not filtered |
| `--release` | — | unlink the caller's lease and print `team next: released <id>`; records no progress, and a queued swap does not stop it |
| `--wait` | — | re-reads the source every `tasks.cadence` while a pass finds nothing takeable, until a record is taken, the wait is stopped, or a read breaks; without `tasks.cadence` it refuses; off unless set |
| `--json` | — | one `team.next` document on stdout instead of the context line and block; off unless set |
| `--help`, `-h` | — | the usage, and exit 0 |

`--mine` and `--release` together are refused, and no file is written. `--wait` and `--release` together are refused the same way, and so is `--wait` without `tasks.cadence` in the team file: the pace is always the team's own declared one. `--wait` and `--json` together are refused too — a wait prints its events as they happen, which is not one document — and that refusal is plain stderr with the usage, never a document.

## Who may run it

| Caller | May |
| --- | --- |
| a declared seat of this team, on the pane the state records for that seat | pull; any declared seat, not only the orchestrator |
| the owner, or a name that is not a seat | nothing: `team next: only a seat of this team pulls a task; this call is <caller>` |

A team that has never been started has no recorded pane, so a seat cannot pull until `team up` has
recorded one.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| a record was claimed, or the caller's live lease was renewed | the context line, the record's block (the `team issues` block, one record), and `team next: claimed <id>` | 0 |
| a lease was released, or there was nothing to take or to release | the context line and `team next: released <id>`, or `team next: nothing is takeable` / `team next: nothing is assigned to you` / `team next: nothing is held` | 0 |
| the wait ended on a stop signal, or a clock that did not advance | `team next: stopped waiting` | 0 |
| the seat waits on a queued swap | `team next: <seat> waits on a swap: <the queue's line>; nothing new is claimed until it runs or \`team swap cancel <seat>\`` | 1 |
| refused: not a seat on its recorded pane, the team file can't be read or its policy is refused, the task file is missing or not a list, nothing was taken and a record is not a task, or the broker path refused | `team next: <reason>`; under `--json`, a `team.error` document on stdout with `id` the contract row and `repair` the way out | 1 |
| the invocation can't be read, or this folder is neither a checkout nor a team root | `team next: <problem>`, with the usage for the invocation; under `--json`, a `team.error` document | 2 |

Under `--json` the command prints one `team.next` document: its `schema` tag first, then `format`, `dry_run` (`false`), `status` (the outcome word), `action` (`claim`, `release`, or `none`), `action_summary` (the same closing line the plain run prints), `project`, `session`, and `task` — the claimed record's `id` and `title`, or `null`. A claimed record prints its block only in the plain run; the document carries its id and title.

## Example

```yaml file=.agents/team.yaml
format: 1
project: beacon
entity: lab
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobbies/lab
  - ~/Code/beacon

workspace:
  mode: shared

tasks:
  source: file
  path: .agents/tasks.yaml

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
    name: worker
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "4.0"
    launch: claude --model deepseek-flash
```

```yaml file=.agents/tasks.yaml
- id: m1
  title: the task title
```

```console caller=claude-keeper
$ team next ; echo "exit $?"
team beacon, session "lab-beacon"
m1  the task title
team next: claimed m1
exit 0
```

The entity's rule refuses this lab, and the owner queues the seat's swap. The seat claims
nothing while the swap waits, and the line names the way out:

```console
$ team policy set entity model-rule '*=!anthropic' ; echo "exit $?"
policy: set model-rule=*=!anthropic at entity (lab)
exit 0
$ team swap queue claude-keeper ; echo "exit $?"
swap queued: claude-keeper: anthropic Claude Opus 5.5 -> deepseek DeepSeek Flash 4.0 (the entity model rule), queued 2026-10-04T09:00:00.000Z, waits for the seat's boundary (quiet, no turn, no dialog, no lease, no work drop), runs by 2026-10-04T09:30:00.000Z
exit 0
```

```console caller=claude-keeper
$ team next ; echo "exit $?"
team next: claude-keeper waits on a swap: claude-keeper: anthropic Claude Opus 5.5 -> deepseek DeepSeek Flash 4.0 (the entity model rule), queued 2026-10-04T09:00:00.000Z, waits for the seat's boundary (quiet, no turn, no dialog, no lease, no work drop), runs by 2026-10-04T09:30:00.000Z; nothing new is claimed until it runs or `team swap cancel claude-keeper`
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/next.md](../internal/next.md).
