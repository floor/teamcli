# `team sessions`: rationale and known limits

What moved off [the `team sessions` page](../commands/sessions.md): what the registry is, what
writes it and what it holds, the CLI session id, the crash rule, the order and grouping, the
refusals in their own words, and the known limits. The synopsis, the columns and the exit codes
stay on the page.

## The registry: one file, one event per line

Each project's machine state folder — `<home>/.config/team/<project>-<12 hex>`, the folder the
message history already uses — holds `sessions.jsonl`. The hash is of the checkout's root, so two
checkouts that declare the same `project:` keep separate registries; `team sessions` reads every
state folder on the machine, which is why it runs without a team file.

A line is one event: `start`, written when a pane takes a launch command, or `end`, written when
a stop command closes the session. The file is append-only and is never rotated — the records are
the point, not a log to trim. The listing folds the events: the first `start` for an id wins and
the first `end` wins. A line the reader can't parse is skipped and the rest still shows, so a
damaged tail never hides the records before it.

`start` holds what the launching command knew: the team's own name and entity, the seat and its
nickname, the CLI and lab, the declared model, version and effort, the account, the herdr
session, pane and workspace, the previous session of that seat, and the CLI session id when one
was set. `end` holds the reason, and — when something measured them — tokens and cost marked
`measured` or `estimated`, links to commits, PRs and releases, and the handover file.

## What writes a record

`up` and `add` write a start when the pane takes the launch line. `restart` writes an end with
reason `restart` before it relaunches, and the relaunch writes the new start. `reload` writes an
end with reason `swap` and the swapped-in seat's start. `down` and `remove` write an end with
reason `owner-stop` for every session they close (an `add` that retires a seat closes its record
the same way). Nothing is written from an agent's word: every line comes from the command that
launched or stopped a pane.

`crash` is written by the registry itself. A start that finds an open record for the same team,
herdr session and seat — from another pane, another CLI session, or a CLI that takes no session
id relaunched in its pane — closes it with reason `crash` and the note `a new launch found this
session open`. Two launches are one only when both carry the same defined CLI session id: for a
CLI that takes none, a relaunch is a new session, linked to its predecessor. A launch that
follows a repair the command made on purpose closes the old record as `swap` — a drift repair in
`up`, a `reload` — and the new record links back to it. Nothing else ends a record: a seat still
launched, named, or held at a dialog when `up`'s run ends keeps the open record its launch wrote,
and only a real stop or `down` closes it. `quota` is in the vocabulary with no writer in this
release.

Nothing in this release measures tokens, cost, links or handover: the fields are the record's
shape, and a field no command wrote is absent. The listing prints an absent cost as `unknown`,
never as zero — TeamCLI did not measure it, and zero would be a claim it never made.

## The CLI session id

Where a CLI accepts a session id at launch, TeamCLI sets one and records it. A Claude Code launch
line that does not already choose a session gets `--session-id <uuid>` appended; a line that
already carries `--session-id`, `--resume`/`-r`, or `--continue`/`-c` is left as the owner wrote
it, and an id the line spells is recorded. TeamCLI never reads the CLI's session files or its
state: the id is the one TeamCLI set, and `resumable` says only that the CLI keeps sessions to
resume. `team resume` — reading a record back into a launch — is the next release.

## Order, grouping, columns

Every folder matching the store-folder shape is read: `lobby` and `lobbies` are never stores, and
a symbolic link is never followed. Records are sorted by start time and then id. `<seat>` filters
by exact name. `--by model|team|entity` groups by the record's model (or `unknown model`), the
team name, or the entity (or `no entity`), with group names in ascending order and a blank line
between groups. STARTED and ENDED print the record's timestamps in UTC to the minute; COST
appends `(estimated)` when the record says so. `--json` carries each record whole; absent keys
stay absent.

## Refusals

```text
team sessions: the state folder path is not a directory
team sessions: another user's folder
team sessions: the state folder could not be read
team sessions: the session registry path is a directory
team sessions: the session registry path is not a regular file
team sessions: --by must be one of model, team, entity
team sessions: "m1" is not a seat name
team sessions: unexpected "extra"
```

A store the registry cannot read refuses the whole listing rather than answering with a partial
one: a listing that quietly dropped one project's records would read as "no sessions" for that
team. An empty registry is not a refusal: it prints `0 sessions` and exits 0. A malformed
invocation prints the usage and exits 2; with `--json` both refusals are a `team.error` document
carrying the id `sessions.read` or `sessions.invocation`.

## Known limits

- No command measures tokens or cost yet, so every record's COST prints `unknown` until one does.
  The field is shaped for a measured or estimated reading, never for zero.
- `quota` has no writer: a session ended by an exhausted quota closes as `owner-stop` in this
  release, whatever actually stopped it.
- A CLI that dies without a stop leaves its record open; it closes as `crash` only when the next
  launch finds it. Until then the listing shows it open, which is what TeamCLI knows.
- Only Claude Code takes a session id at launch in this release: for another CLI the id,
  `resumable` and `resume_until` stay absent.
- The registry records launches and stops; it does not probe a pane. It can't tell a working
  session from an idle one, and it is not a liveness check.
