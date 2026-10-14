# team mcp

Reads the MCP bridge's local state — the helper under its install root, every bridge config in the
lobby, the seat guards beside them, and the public front the connector dials — and reports it
without touching it. `team mcp status` prints one table per leg and the state they add up to;
`team mcp doctor` turns the same surface into findings, each missing one with a one-line fix. Both
are read-only: nothing is written, no secret value is ever printed (a secret is named, never
shown), and no privileged command is run. The mutating side — `setup`, `enable`, `disable`, key
generation, certificate minting — is not in this build yet.

## Synopsis

    team mcp status [--json]
    team mcp doctor [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--json` | — | the report as one JSON document (`format: 1`) instead of the tables |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| anyone, in any terminal | run either subcommand: both write nothing at all |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| `status`: every observed leg is up | one section per leg — helper, each bridge, the front, each guard — with a state column, closing with `state: up` | 0 |
| `status`: a leg is down, or the lobby holds no bridge config at all | the same sections, with the `MISS` rows, closing with `state: down` or `state: not-set-up` | 1 |
| `doctor`: nothing missing | one finding per line — the level, then the sentence — with a `fix:` line under each finding that has one, then `team mcp doctor: nothing missing, <n> warnings` (`0 warnings` when there are none) | 0 |
| `doctor`: at least one `MISS` | the same findings, and the closing count | 1 |
| the invocation can't be read: no subcommand, an unknown one, an option this build does not know | `team mcp: <reason>`, with the usage | 2 |

## Example

`status` prints one section per leg, and closes with the state the legs add up to:

```console
$ team mcp status ; echo "exit $?"
helper  /usr/local/teamcli-helper
  root                ok    0755, world-traversable
  keys                ok    0700, private (contents are the helper's own, not readable here)
  queue               ok    0700, private (contents are the helper's own, not readable here)
  state               ok    0700, private (contents are the helper's own, not readable here)
  sock/               ok    0750, excludes "other"
  bin/bun             ok    executable
  app/                ok    the bridge script is deployed
  helper-config.json  ok    0600, owner-held (its contents are not read here)
bridge  ~/.config/team/lobby/mcp-1
  config          ok    0600, 827 bytes
  seats           ok    beacon -> seat-beacon-1 (seat-beacon-1)
  bridge process  ok    running
  signer socket   ok    ~/.config/team/lobby/mcp-1/signer.sock accepts connections
  mailbox         ok    2 outbound ready, 0 inbound ready
  last audit      ok    ws-open at 2026-10-04T08:55:00Z
front  https://mcp.example.test
  mcp endpoint     ok    401, OAuth required (the front answers)
  connector        ok    401, enabled and token-gated (the route is bound)
  tls certificate  ok    valid for 90 more days (to 2027-01-02T09:00:00Z)
state: up
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/mcp.md](../internal/mcp.md).
