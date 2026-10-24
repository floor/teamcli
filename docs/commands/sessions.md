# team sessions

Lists the sessions TeamCLI recorded for each seat: one append-only record per CLI session,
written by the launch and stop commands themselves — `up`, `add`, `restart`, `reload`, `down`
and `remove` — and never from an agent's word. The listing reads every team on this machine, so
it runs anywhere and needs no team file. It records what the launching command knew: a field no
command measured is absent, and its cost prints as `unknown`, never as zero.

`team resume` — reading a record back into a launch — is not part of this release.

## Synopsis

    team sessions [<seat>] [--by <model|team|entity>] [--json]
    team sessions [<seat>] --client <grant-file> --key <client-key> [--team <team>] [--by <model|team|entity>] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--client` | `<grant-file>` | the client form: an owner-signed manager bundle grant that carries `sessions`; it lists the records of that one team and not the other teams on this machine. A refusal is `sessions.client-refused` (exit 1) |
| `--key` | `<client-key>` | the client's private key file; required with `--client` |
| `--team` | `<team>` | with `--client`, the team the grant is for |
| `--by` | `model`, `team` or `entity` | group the listing under one heading per value instead of one table |
| `--json` | — | print a JSON document (`format: 1`, `by`, `seat`, `sessions`), each record whole |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

Anyone on the machine. It reads: it writes nothing, needs no team file, and has no seat gate.

## Columns

| Column | Meaning |
| --- | --- |
| SESSION | the record's id, `ses_` and 12 hex characters, minted by the launching command |
| SEAT | the seat name the session ran for |
| TEAM | the team's own name (`project:` in its file) |
| MODEL | the model the file declared for the seat, or `-` when none was recorded |
| STARTED | the launch's time, UTC to the minute |
| ENDED | the stop's time, or `-` while the record has no end |
| WHY | the end reason: `swap`, `restart`, `crash`, `owner-stop` or `quota`; `-` while open |
| COST | the cost the record holds, marked `(estimated)` when TeamCLI estimated it, or `unknown` |

The other record fields — the CLI and lab, the version and effort, the account, the herdr
session, pane and workspace, the CLI session id and whether the CLI can resume it, the previous
and next session of the seat, tokens, and links to commits, PRs and releases — are carried whole
in `--json` and absent when the launching command could not know them.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| records matched | `<n> session` or `<n> sessions`, then the table above (one table per `--by` value, with a `model:`, `team:` or `entity:` heading) | 0 |
| no record matched | `0 sessions` | 0 |
| a session registry can't be read | `team sessions: <reason>` (with `--json`, a `team.error` document) | 1 |
| the invocation can't be read | `team sessions: <problem>`, with the usage (with `--json`, a `team.error` document) | 2 |

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
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
```

```fixture
sessions:
  - seat: claude-keeper
    started: 2026-10-04T07:40:00Z
    ended: 2026-10-04T08:10:00Z
    reason: restart
    cli_session: 2f6d1c1a-6f3b-4b4e-9d4a-1f0f0a2a9b7c
    cost: { amount: 0.42, currency: USD, source: measured }
  - seat: claude-beacon
    started: 2026-10-04T07:45:00Z
    cli_session: 9a3b5c7d-1e2f-4a6b-8c0d-2e4f6a8b0c1d
  - seat: claude-keeper
    started: 2026-10-04T08:10:30Z
    ended: 2026-10-04T08:55:00Z
    reason: owner-stop
    cli_session: 4c5d6e7f-8a9b-4c0d-9e1f-2a3b4c5d6e7f
    tokens: { in: 18400, out: 2100, cached: 9600, source: measured }
    cost: { amount: 0.10, currency: USD, source: estimated }
```

```console
$ team sessions ; echo "exit $?"
3 sessions
  SESSION           SEAT           TEAM    MODEL          STARTED            ENDED              WHY         COST
  ses_000000000001  claude-keeper  beacon  Claude Opus    2026-10-04 07:40Z  2026-10-04 08:10Z  restart     0.42 USD
  ses_000000000002  claude-beacon  beacon  Claude Sonnet  2026-10-04 07:45Z  -                  -           unknown
  ses_000000000003  claude-keeper  beacon  Claude Opus    2026-10-04 08:10Z  2026-10-04 08:55Z  owner-stop  0.1 USD (estimated)
exit 0
```

One seat's records alone, with `--by model` grouping the listing when several models are in play:

```console
$ team sessions claude-keeper --by model ; echo "exit $?"
2 sessions
model: Claude Opus
  SESSION           SEAT           TEAM    MODEL        STARTED            ENDED              WHY         COST
  ses_000000000001  claude-keeper  beacon  Claude Opus  2026-10-04 07:40Z  2026-10-04 08:10Z  restart     0.42 USD
  ses_000000000003  claude-keeper  beacon  Claude Opus  2026-10-04 08:10Z  2026-10-04 08:55Z  owner-stop  0.1 USD (estimated)
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/sessions.md](../internal/sessions.md).
