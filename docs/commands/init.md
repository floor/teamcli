# team init

Writes the team file: a skeleton for this project, or with `--restore` the copy of
`.agents/team.yaml` you last approved on this machine. It also lists the team file and its runtime
files in `.git/info/exclude`, so git never sees them and a fresh clone never carries them. The owner
runs it, from a terminal outside herdr; a create-grant's `runner` admits a caller outside herdr as
well. A file that already exists is never overwritten.

## Synopsis

    team init [--restore]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--restore` | — | write the copy of the team file this machine last approved, instead of a skeleton |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | run it |
| a caller outside herdr whose ancestry names a create-grant's `runner` | run it, on the paths that record covers and before it expires; `--restore` is not granted |
| a run with no terminal | nothing, unless a create-grant's `runner` names the caller: `team init: only the owner runs this, from a terminal outside herdr` |
| a seat, or an agent-run CLI a runner record does not name | nothing: `team init: only the owner runs init, from a terminal outside herdr; this call is <caller>` |

## Who a create-grant admits

A create-grant is a record in `~/.config/team/grants/`, and two kinds of line name its callers.
Only a record that carries the first kind counts: a record with no line naming a **seat or pane
under herdr** — `agent`, `seat` or `pane` — is skipped, and admits nobody, its `runner` names or
not. The second kind, `runner` (or `runners: [<name>, …]` for several), names **callers outside
herdr**, so one record can admit both.

- **`agent`** (or `seat`, or `pane`) names a **seat or pane under herdr**: the caller running as
  that seat, or in that pane, is admitted. A record's `session` narrows a seat to one session; a
  **pane** is matched only when the record names the session too, a pane being unique only within
  it. `agent: <session>/<agent>` is the same record spelled on one line.
- **`runner`** (or `runners: [<name>, …]` for several) names a **caller outside herdr**, with or
  without a terminal: it is admitted when one of its parent processes carries that name — the base
  name of what `ps -o comm=` prints for it.

```text
agent: beacon-runner
session: dispatch
paths:
  - ~/Code/beacon
expires: "2026-10-17T00:00:00Z"
runner: gemini-beacon
```

That runner runs `init` — the skeleton, never `--restore` — on a folder under `paths`, before
`expires`. Every other case keeps its refusal: a name that is not in the ancestry, an expired
record, a folder outside the covered paths or one reached through a `..` segment or a symlink, and
a record with no `runner`. A caller under herdr is never admitted by `runner`: there, the seat or
pane it has to match is the record's `agent`. The owner needs no record.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| a skeleton was written, or the approved copy was restored | `Wrote .agents/team.yaml: a skeleton with one seat. Edit it, then run the seats.` | 0 |
| refused: not the owner, the file is tracked or already there, or there is nothing to restore | `team init: <reason>` | 1 |
| it can't run: not inside a git repository, or a bad option | `team init: <problem>`, with the usage for a bad option | 2 |

## Example

A seat can't run it:

```console caller=agent
$ team init ; echo "exit $?"
team init: only the owner runs init, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr)
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/init.md](../internal/init.md).
