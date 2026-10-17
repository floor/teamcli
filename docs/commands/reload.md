# team reload

Closes one running seat and launches it again when the team file's model, version or effort
differs from the model, version and effort recorded at its last launch. `team up` leaves a
seat that is already ready as it is, so a later edit of the model or the effort never
reaches that seat. This command names one seat and does only that swap.

The close happens at an idle prompt. A seat that is working, a seat whose input box holds
unsent text, and a seat whose screen is not an idle prompt are left as they are: nothing is
closed and nothing is launched. A seat whose launch was not recorded — one brought up before
the record existed — is refused the same way. The next launch that reaches an idle prompt
writes the record, and a later reload can read it.

A matching seat exits without closing anything and without a log line. A close that passes
is logged at that moment, before the workspace is closed. The owner's line names the seat
and `model`, `effort`, or `model; effort`. A granted run names the granted seat, then the
seat that was reloaded, then the same difference.

## Synopsis

    team reload <seat> [--file <path>] [--json]

## What it reads and writes

Reads the team file and the session's seat record. Writes that record again when the new
launch reaches its idle prompt: the model, the version, the effort word when the file sets
one, and the launch line. A seat that already matches is not written. A refusal is not written.

The log gains one line when the close happens, and no line when it does not.

## Who may run it

The owner at a terminal may name any seat, including the operator. A granted orchestrator
may name any other seat when the file's grant lists `reload`, and may not name its own
seat: closing that pane would end the caller. The grant this run reads is the live file's,
like `up` and `down`: a file edited since the last approval is not a refusal. `--file` is
the owner's. A delegate is not offered this command.

## Flags

| Flag | Meaning |
| --- | --- |
| `--file <path>` | The team file. The owner may name one. A granted seat may not. |
| `--json` | the same outcome as one JSON document (`team.reload`) instead of the line |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the seat was closed and launched again | `team reload: <seat> reloaded` | 0 |
| the seat already runs what the file declares | `team reload: <seat> is already running what the file declares` | 0 |
| refused, or the relaunch did not reach ready | `team reload: <reason>` | 1 |
| it can't run: a bad option, or the team file can't be read | `team reload: <problem>`, with the usage for a bad option | 2 |

`--json` prints one `team.reload` document instead: `seat`, the new `pane`, the outcome as
`status` (`reloaded` or `same`), and the same closing line as `action_summary`. A refusal under
`--json` prints the `team.error` document on stdout — its `id` is the contract row for that
refusal (`reload.absent`, `reload.working`, …) — and nothing on stderr.
