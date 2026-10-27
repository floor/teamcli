# team rename

Renames a seat in the team's configuration — or with `--renumber`, renumbers every numbered seat to match
the `seat_numbering` in force — and carries over the seat's identity and records across the team file,
the approval record, the state, the registry, herdr, and on-disk seat files.

## Synopsis

    team rename <seat> <new-seat> [--session <name>] [--file <path>] [--json]
    team rename --renumber [--dry-run] [--session <name>] [--file <path>] [--json]

## What it carries over

Renaming `<seat>` to `<new-seat>` moves the seat's name while keeping the same seat and agent identity:

- **Team file and approval record**: rewrites the seat declaration and every seat reference in the team's record (`coordinator`, `operator`, `like`, `delegates`, `grant`, `delivery_order`) and updates the stored approval record when one is in force.
- **Agent registry (`id`) and grants**: updates the seat's record in `~/.config/team/agents.yaml` and the team's roster in `~/.config/team/teams.yaml` while preserving its immutable `agt_…` agent id and `seat_…` handle, so standing grants and delegations keyed by agent id continue to apply.
- **Session state**: moves the seat's entry in `.agents/team.state.json` (`seats`, `retained_seats`, `swapping`, `worktrees`, `procs`, temporary `like` targets, and budget readings).
- **Herdr pane title**: renames the live agent in its recorded herdr pane (`pane <pane>`).
- **Task leases**: re-keys active task leases under `.agents/leases/<task>.json` held by the seat.
- **Send-drops and mailbox**: moves pending drop folders under `.agents/send-drops/` and mailbox records under `.agents/messages/<seat>/`, re-signing mailbox payloads and receipts for the new seat name when the message key is present.
- **Rules, queue, notes, and brief files**: renames `rules/<seat>.md`, `queue/<seat>.md`, `queues/<seat>.md`, and `notes/<seat>.md` in the project store and checkout, plus `briefs/<seat>-to-<other>.md` and `briefs/<other>-to-<seat>.md`.
- **General seat brief**: after the state's rename, delivers the seat under its new name a fresh claim — a new incarnation, runtime epoch, the brief's sha256 and the record's expected id — and its signed drop at that id. The old name's claim cannot serve the new name: the record it names carries the old `to`, so the delivery is fresh and the old claim is left where it was.
- **Message history**: rewrites `from` and `to` entries for the seat in `messages.jsonl`.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--renumber` | — | renumber every numbered seat (such as `builder-1` -> `builder-01`) to match the `seat_numbering` policy in force (`min_width`, `pad_char`, `separator`), leaving unnumbered single seats untouched |
| `--dry-run` | — | with `--renumber`, print the planned renames (`<from> -> <to> (dry run)`) without writing any file or state |
| `--session` | `<name>` | the herdr session, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | deprecated: a legacy team file to read instead of the team's registry record; the owner's alone |
| `--json` | — | print `{ "dryRun": boolean, "renames": [...] }` on stdout |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run `team rename` or `team rename --renumber` from a terminal outside herdr; `--session` and `--file` are the owner's alone |
| a seat holding `leads` (or the orchestrator when no role holds `leads`) | rename a seat or run `--renumber` in its own team from its recorded pane |
| a seat an active create-grant names by its own registry id | rename a seat in a team whose root sits under the granted paths before the grant expires |
| any other seat, or a shell outside herdr with no terminal | nothing: `team rename` refuses (`only the owner or \`leads\` renames a seat`) |

## Counted seats and the reserved name `lead`

- **Counted seats (`count > 1`)**: a seat expanded from a multi-seat declaration (`count: 2` or higher) cannot be renamed piecemeal (`"<seat>" is declared under "<declared>" with count <n> and cannot be renamed partially`), and `--renumber` skips counted declarations.
- **Reserved name `lead`**: `lead` is the built-in address for the seat holding the `leads` capability. When another seat holds `leads`, renaming a non-lead seat to `lead` (or giving it the nickname `lead`) is refused by team-file validation so the `lead` address stays unambiguous.

## Output and exit codes

| Outcome (`id`) | What is printed | Exit |
| --- | --- | --- |
| `rename.done` | `renamed <from> -> <to>: moved <items>` (or `<from> -> <to> (dry run)`, or `team rename: all numbered seats already match the seat numbering in force`, or the `--json` document) | 0 |
| `rename.refused` | `team rename: <reason>` — caller gate refused, seat not declared, target seat already exists, counted seat (`count > 1`), nickname clash, or owner-only flag from a non-owner | 1 |
| `rename.invalid` | `team rename: <problem>` — invalid new seat name, unreadable team file, or an edit that fails team-file validation (such as a `lead` conflict) | 2 |
| `rename.invocation` | `team rename: <problem>` followed by the usage — bad flag, `--dry-run` without `--renumber`, or missing/extra positional arguments | 2 |

Under `--json`, a run prints `{ "dryRun": false, "renames": [{ "from", "to", "agent", "moved" }] }` (or `{ "dryRun": true, "renames": [{ "from", "to" }] }` with `--renumber --dry-run`).

## Example

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

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
    name: builder-1
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: reviewer
    name: reviewer
    count: 2
    label: reviewer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```fixture
agents: all
```

`--renumber --dry-run` previews the zero-padded seat names under the default width-2 numbering without editing the file:

```console
$ team rename --renumber --dry-run ; echo "exit $?"
builder-1 -> builder-01 (dry run)
exit 0
```

Renaming `builder-1` updates the team's record, the session state, and the live pane in one step:

```console
$ team rename builder-1 builder-01 ; echo "exit $?"
renamed builder-1 -> builder-01: moved team config, .agents/team.state.json, pane w2:p1
exit 0
```

A seat expanded from `count: 2` cannot be renamed on its own:

```console
$ team rename reviewer-2 reviewer-main ; echo "exit $?"
team rename: "reviewer-2" is declared under "reviewer" with count 2 and cannot be renamed partially
exit 1
```
