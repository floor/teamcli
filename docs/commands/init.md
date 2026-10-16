# team init

Writes the team file: a skeleton for this project, or with `--restore` the copy of
`.agents/team.yaml` you last approved on this machine. It also lists the team file and its runtime
files in `.git/info/exclude`, so git never sees them and a fresh clone never carries them. The owner
runs it, from a terminal outside herdr; a create-grant's `runner` admits a caller outside herdr as
well. A file that already exists is never overwritten.

`--from-archive <folder>` is the third source: the team file one of [team archive](archive.md)'s
archives holds, written verbatim. The folder's manifest and the file it hashes are checked first,
and nothing else in the archive is restored: the state and the queues stay where they are.

## Synopsis

    team init [--restore] [--from-archive <folder>]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--restore` | — | write the copy of the team file this machine last approved, instead of a skeleton |
| `--from-archive` | `<folder>` | write the team file the archive at that folder holds, instead of a skeleton; `--restore` and this are two sources for the one file, and one of them is passed |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | run it |
| a caller outside herdr whose ancestry names a create-grant's `runner` | run it, on the paths that record covers and before it expires; `--restore` and `--from-archive` are not granted |
| a run with no terminal | nothing, unless a create-grant's `runner` names the caller: `team init: only the owner runs this, from a terminal outside herdr` |
| a seat, or an agent-run CLI a runner record does not name | nothing: `team init: only the owner runs init, from a terminal outside herdr; this call is <caller>` |

## A create-grant's runner

A create-grant — a record in `~/.config/team/grants/` — admits a caller outside herdr, with or
without a terminal, when its `runner` field (or `runners: [<name>, …]` for several) names one of
the caller's parent processes. The name is the base name of what `ps -o comm=` prints for it:

```text
agent: gemini-beacon
paths:
  - ~/Code/beacon
expires: "2026-10-17T00:00:00Z"
runner: gemini
```

That caller runs `init` — the skeleton, never `--restore` — on a folder under `paths`, before
`expires`. Every other case keeps its refusal: a name that is not in the ancestry, an expired
record, a folder outside the covered paths or one reached through a `..` segment or a symlink, and
a record with no `runner`. A caller under herdr is never admitted this way, and the owner needs no
record.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| a skeleton was written, or the approved copy was restored | `Wrote .agents/team.yaml: a skeleton with one seat. Edit it, then run the seats.` | 0 |
| the team file was restored from an archive | `Restored .agents/team.yaml from an archive. The archive is <project>'s, taken at <root> on <moment> by <caller>.` and, when it holds more, `It also holds team.state.json and send-drops (2 files); a restore writes the team file alone.` | 0 |
| refused: not the owner, the file is tracked or already there, there is nothing to restore, or the archive was refused | `team init: <reason>` | 1 |
| it can't run: not inside a git repository, or a bad option | `team init: <problem>`, with the usage for a bad option | 2 |
| both sources were passed | `team init: --restore and --from-archive are two sources for the one file: pass one of them.` | 2 |

## Example

A seat can't run it:

```console caller=agent
$ team init ; echo "exit $?"
team init: only the owner runs init, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr)
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
receives one and approves it themselves.
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/init.md](../internal/init.md).
