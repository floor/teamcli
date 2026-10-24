# team reload

Closes one running seat and launches it again when the team file's model, version or effort
differs from the model, version and effort recorded at its last launch — or when a seat that
takes its rules as a first message has a per-seat rules file that no longer holds the rules
text the live team file gives it. `team up` leaves a seat that is already ready as it is, so a
later edit of the model, the effort or the rules never reaches that seat. This command names
one seat and does only that swap. A seat the file marks `human: true` is refused before the launch
record is read: nothing is typed into it or launched over it; left as it is.

The close happens at an idle prompt. A seat that is working, a seat whose input box holds
unsent text, and a seat whose screen is not an idle prompt are left as they are: nothing is
closed and nothing is launched. A screen the profile cannot read is not an idle prompt
either, except that herdr's own status is the last word on it: a seat herdr reports idle or
done is closed without typing into it, and the line says the screen was not recognised and
what herdr reports; one herdr reports working keeps the refusal. A seat whose launch record
kept no model — one brought up before the record held one — still reloads: the model its
screen shows is read first, the team file's declared model and effort stand when the screen
names none, and the reading is said and recorded. A seat already running what that reading
declares, whose rules file (when it takes its rules in one) holds the live text, is recorded
in place with no close. The next launch that reaches an idle prompt writes the record, and a
later reload can read it.

A matching seat exits without closing anything and, as every path this command takes to a
seat, is handed the general seat brief first when its claim is missing or behind this build's; the
run writes no log line unless that delivery fails. A close that passes
is logged at that moment, before the workspace is closed. The owner's line names the seat
and `model`, `effort`, `rules`, or the words joined with `; ` — `model; effort`, `model;
rules`, `effort; rules`. A granted run names the granted seat, then the seat that was
reloaded, then the same difference.

## Synopsis

    team reload <seat> [--file <path>] [--json]
    team reload <seat> --client <grant-file> --key <client-key> [--team <team>] [--json]

## What it reads and writes

Reads the team file, the session's seat record and — for a seat that takes its rules as a
first message — its per-seat rules file. Writes that record again when the new launch reaches
its idle prompt: the model, the version, the effort word when the file sets one, and the
launch line. A relaunched message seat also has its rules file written again and the one line
pointing at it typed, as a fresh `up` does; an option seat's rules ride its launch line. A
seat that already matches is not written. A refusal is not written.

Before anything is typed into the seat, the run delivers the general seat brief to it as a
claim and a signed drop — the same first message `team up` gives every seat — and records the
claim in the session's `briefs`: its incarnation, the runtime epoch, the brief's sha256 and the
record's expected id, written before the drop at exactly that id. A relaunch path attributes the
seat, so it gets a fresh incarnation and epoch; the already-running path attributes nobody and
still delivers when this build's brief is ahead of the seat's claim, keeping the lifetime it
finds. A seat that already holds this brief's verified record is left as it is, and a name held
at the expected id by another file, a link or a folder is refused, never replaced or followed —
its recovery is [`team brief rollout --apply`](brief.md). A delivery that cannot be written is
said and logged without stopping the reload: `team check` names the seat with no current record,
and this command is its repair.

The log gains one line when the close happens; a run that does not close adds none, unless it
has a failed delivery to report.

## A client's reload

A client with no terminal that the owner signed a **manager** bundle grant for (see [Client grant bundles](../concepts/client-grant-bundles.md#the-manager-bundle)) reloads a seat of that
one team with `team reload <seat> --client <grant-file> --key <client-key>`. The grant is verified whole before
the caller and grant gates, and again under the grant lock before the first effect; it must carry `reload` and
name exactly this team. The run is never the owner's and takes no `--file`. It is logged as
`client-reload-authorized: …`; a refusal is `reload.client-refused` (exit 1).

## Who may run it

The owner at a terminal may name any seat, including the operator. A lead — a seat the map's
`leads` row admits, as for `restart` — may name another seat, standing on its own recorded
pane, with or without a grant in the file. A seat the file's grant names — the orchestrator —
may also name any other seat when the grant lists `reload`, and may not name its own seat:
closing that pane would end the caller. A grant the file carries is a second gate, as it is
for `down`: where the file carries one, its words are read even for a lead. The grant this
run reads is the live file's, like `up` and `down`: a file edited since the last record is
not a refusal. `--file` is the owner's. A delegate is not offered this command.

## Flags

| Flag | Meaning |
| --- | --- |
| `--file <path>` | The team file. The owner may name one. A granted seat may not. |
| `--client <grant-file>` | The client form: an owner-signed manager bundle grant that carries `reload`, see [A client's reload](#a-clients-reload). |
| `--key <client-key>` | The client's private key file; required with `--client`, refused without it. |
| `--team <team>` | With `--client`, the team the grant is for. |
| `--json` | the same outcome as one JSON document (`team.reload`) instead of the line |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the seat was closed and launched again | `team reload: <seat> reloaded` | 0 |
| the seat already runs what the file declares | `team reload: <seat> is already running what the file declares` | 0 |
| refused, or the relaunch did not reach ready | `team reload: <reason>` | 1 |
| it can't run: a bad option, or the team file can't be read | `team reload: <problem>`, with the usage for a bad option | 2 |

`--json` prints one `team.reload` document instead: `seat`, the new `pane`, the outcome as
`status` (`reloaded` or `same`), and the same closing line as `action_summary`. `notes` carries
the general-brief failure line when the delivery could not be written. A refusal under
`--json` prints the `team.error` document on stdout — its `id` is the contract row for that
refusal (`reload.absent`, `reload.working`, …) — and nothing on stderr.
