# team init

Writes the team file: a skeleton for this project, or with `--restore` the copy of
`.agents/team.yaml` this machine stored. It also lists the team file and its runtime
files in `.git/info/exclude`, so git never sees them and a fresh clone never carries them. The owner
runs it, from a terminal outside herdr; a seat whose own registry record an active create-grant
names may run it as well. A file that already exists is never overwritten.

## Synopsis

    team init [--restore] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--restore` | — | write the copy of the team file this machine stored, instead of a skeleton |
| `--json` | — | the same outcome as one JSON document (`team.init`) instead of the line |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | run it |
| a seat an active create-grant names by its own registry id | run it, on the paths that record covers and before it expires; `--restore` is not granted |
| a run with no terminal | nothing: `team init: only the owner runs this, from a terminal outside herdr` — a caller outside herdr has no registry record, so no record admits it |
| a seat no record names, or an agent-run CLI with no registry record | nothing: `team init: only the owner runs this, from a terminal outside herdr; this call is <caller>` |

## A create-grant's seat

A create-grant — a record in `~/.config/team/grants/` — admits a seat whose own registry record the
record names. The holder is a registry agent id (`agt_` and twelve lowercase hex characters), or a
registry team id (twelve lowercase hex characters) for every seat of that team:

```text
agent: agt_0123456789ab
paths:
  - ~/Code/beacon
expires: "2026-10-17T00:00:00Z"
```

```text
team: abcd012345678
paths:
  - ~/Code/beacon
expires: "2026-10-17T00:00:00Z"
```

Admission matches the caller's own registry record id, and nothing else. A record that spells its
holder as a name, a seat, a pane, a session or a runner process grants nothing: the program skips
it, and the ordinary refusal stands. That seat runs `init` — the skeleton, never `--restore` — on a folder
under `paths`, before `expires`. Every other case keeps its refusal: an expired record, a folder
outside the covered paths or one reached through a `..` segment or a symlink, and a record naming
both an agent and a team. A caller outside herdr has no registry record, so no record admits it,
and the owner needs no record.

A record covers only the paths it names itself (`paths:`, or one `path:`). When it names an
`entity:` and no path, it covers the roots that entity declares in
`~/.config/team/entities.yaml`, the only roots the program knows — none is written into it:

```text
beacon:
  roots:
    - ~/Code/beacon
```

A record that names an entity with declared roots may narrow them, never widen them: a path
beside them is refused, and a record left covering nothing admits no caller, exactly as an empty
one does.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| a skeleton was written | `Wrote .agents/team.yaml: a skeleton with one seat. Edit it, then run team up.` | 0 |
| the stored copy was restored | `Restored .agents/team.yaml from the copy this machine stored.` | 0 |
| refused: not the owner, the file is tracked or already there, there is nothing to restore, or the stored copy no longer validates | `team init: <reason>` | 1 |
| it can't run: not inside a git repository, or a bad option | `team init: <problem>`, with the usage for a bad option | 2 |

Every plain run prints the privacy paragraph after that line, a blank line between: `The team
file is private to this clone: it is listed in .git/info/exclude, never in .gitignore, so git
doesn't see it and a fresh clone doesn't carry it. A collaborator writes their own, or receives
one and uses it as their own.`

`--json` prints one `team.init` document instead: `file` (`.agents/team.yaml`), `restored`
(`false` for a skeleton, `true` for the stored copy), the outcome as `status` (`wrote` or
`restored`), any collapsed notes, and the closing line as `action_summary`. A refusal under
`--json` prints the `team.error` document on stdout — its `id` is the contract row for that
refusal (`init.not-owner`, `init.exists`, …) — and nothing on stderr.

## Example

A seat can't run it:

```console caller=agent
$ team init ; echo "exit $?"
team init: only the owner runs this, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr)
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/init.md](../internal/init.md).
