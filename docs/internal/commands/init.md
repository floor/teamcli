# team init: full reference

The complete behaviour of `team init`: every flag, refusal, outcome and exit code. The
short page is [docs/commands/init.md](../../commands/init.md). Every example here runs in `bun test`.

Writes a new team into the registry: a skeleton record for this project, at
`~/.config/team/team-config/<team id>.json`, or with `--restore` the copy this machine stored. It
never writes `.agents/team.yaml`. Edit the team afterwards with [`team config`](../../commands/config.md). It also
lists the team's runtime files in `.git/info/exclude`, so git never sees them. The owner runs it,
from a terminal outside herdr; a seat whose own registry record an active create-grant names may
run it as well. A team that already exists is never overwritten.

On the legacy `file` source (`team-config.source: file`, deprecated and kept for tests and
snapshots), it writes `.agents/team.yaml` instead, and the examples below show that source.

`--from-archive <folder>` is the third source: the team file one of [team archive](../../commands/archive.md)'s
archives holds, written verbatim. The folder's manifest and the file it hashes are checked first,
and nothing else in the archive is restored: the state and the queues stay where they are.

## Synopsis

    team init [--restore] [--from-archive <folder>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--restore` | — | write the copy of the team file this machine stored, instead of a skeleton |
| `--from-archive` | `<folder>` | write the team file the archive at that folder holds, instead of a skeleton; `--restore` and this are two sources for the one file, and one of them is passed |
| `--json` | — | the same outcome as one JSON document (`team.init`) instead of the line |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | run it |
| a seat an active create-grant names by its own registry id | run it, on the paths that record covers and before it expires; `--restore` and `--from-archive` are not granted |
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
| the team file was restored from an archive | `Restored .agents/team.yaml from an archive. The archive is <project>'s, taken at <root> on <moment> by <caller>.` and, when it holds more, `It also holds team.state.json and send-drops (2 files); a restore writes the team file alone.` | 0 |
| refused: not the owner, the file is tracked or already there, there is nothing to restore, the stored copy no longer validates, or the archive was refused | `team init: <reason>` | 1 |
| it can't run: not inside a git repository, or a bad option | `team init: <problem>`, with the usage for a bad option | 2 |
| both sources were passed | `team init: --restore and --from-archive are two sources for the one file: pass one of them` | 2 |

Every plain run prints the privacy paragraph after that line, a blank line between: `The team
file is private to this clone: it is listed in .git/info/exclude, never in .gitignore, so git
doesn't see it and a fresh clone doesn't carry it. A collaborator writes their own, or receives
one and uses it as their own.`

`--json` prints one `team.init` document instead: `file` (`.agents/team.yaml`), `restored`
(`false` for a skeleton, `true` for the stored copy or an archive's file), the outcome as `status` (`wrote` or
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

The other source is an archive: its `team.yaml` and the manifest that hashes it, the state and the
queues beside them, and nothing else:

```file file=backups/beacon-2026-10-04/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - .
  - ../worktrees/beacon/*

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

```file file=backups/beacon-2026-10-04/team.state.json
{
  "format": 1,
  "sessions": {
    "beacon": {
      "seats": {
        "claude-beacon": { "stage": "ready", "pane": "w1:p1" }
      }
    }
  }
}
```

```file file=backups/beacon-2026-10-04/send-drops/beacon/claude-beacon/9c1f2ab4-77d1-4e02-9a3c-2f5e0c8b1d44
the gate is green
```

```file file=backups/beacon-2026-10-04/send-drops/beacon/claude-beacon/b7e0d3a9-5c48-4f17-8a2e-6d1b0c4f9e21
the two flaky tests are mine; I keep working on them
```

```file file=backups/beacon-2026-10-04/manifest.json
{
  "format": 1,
  "kind": "teamcli-archive",
  "project": "beacon",
  "session": "beacon",
  "root": "~/Code/beacon",
  "stampedAt": "2026-10-04T09:00:00.000Z",
  "by": "owner",
  "teamcli": "0.4.15",
  "team": { "sha256": "ff7b1b2233656c02dd298d9e261b7c04a7e539dffc599e40fb3a34563eccb3c1", "bytes": 547 },
  "state": { "sha256": "5dc76cee440716fe3a4e773059fab17c8049aa98326d801ecfd19c7cf4bff53d", "bytes": 149 },
  "drops": { "files": 2, "seats": { "beacon/claude-beacon": 2 } }
}
```

```console
$ team init --from-archive backups/beacon-2026-10-04 ; echo "exit $?"
Restored .agents/team.yaml from an archive. The archive is beacon's, taken at ~/Code/beacon on 2026-10-04T09:00:00.000Z by owner. It also holds team.state.json and send-drops (2 files); a restore writes the team file alone.

The team file is private to this clone: it is listed in .git/info/exclude, never in .gitignore,
so git doesn't see it and a fresh clone doesn't carry it. A collaborator writes their own, or
receives one and uses it as their own.
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/init.md](../init.md).
