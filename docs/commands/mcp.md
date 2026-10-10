# team mcp

Reads the MCP bridge's local state — the helper under its install root, every bridge config in the
lobby, the seat guards beside them, and the public front the connector dials — and reports it
without touching it. `team mcp status` prints one table per leg and the state they add up to;
`team mcp doctor` turns the same surface into findings, each missing one with a one-line fix, the
way [team doctor](doctor.md) does. Both are read-only: nothing is written, no secret value is ever
printed (a secret is named, never shown — presence, modes and sizes at most), and no privileged
command is run. A repair only the owner can make is marked `[owner]` and printed, never run. The
mutating side — `setup`, `enable`, `disable`, key generation, certificate minting — is not in this
build yet; `doctor` points at the bring-up runbook for it.

## Synopsis

    team mcp status [--json]
    team mcp doctor [--json]

## What it reads and writes

The lobby folder (`~/.config/team/lobby`): each subfolder holding a `bridge.json`, each holding a
`guard.json`, and, beside a bridge config, its `seat-reply-config.json` when one is there. A
bridge config is parsed with the same checks the bridge's own loader runs — version 1, a bare
`wss://` host URL, 32-byte tokens, one to four relay keys, one to thirty-two seats with unique
aliases, absolute socket, mailbox and audit paths — and a guard config with the seat guard's own
rules (no private key material, lowercase aliases, absolute paths). It reads the helper at
`/usr/local/teamcli-helper`: the root's and folders' modes, the pinned `bin/bun`, the deployed
bridge script, and `helper-config.json`'s mode — that file's contents are never read. It makes one
connect probe of the signer socket (the socket destroys an idle connection itself, so the probe
changes nothing), counts the mailbox's ready files, reads the last audit line, and sends two HTTP
requests to the front — `https://<host>/mcp` and the connector route with the WebSocket upgrade
headers — and reads the front's TLS certificate without sending a request. One `pgrep` looks for
the bridge process whose command line names the config it belongs to. It writes nothing.

## Who may run it

Anyone, in any terminal. Both subcommands write nothing at all, whoever runs them.

## Flags

| Flag | Meaning |
| --- | --- |
| `--json` | the report as one JSON document (`format: 1`) instead of the tables |
| `--help`, `-h` | the usage, and exit 0 |

## What it prints

`status` prints one section per leg — helper, each bridge, the front, each guard — with a state
column, and closes with the state the legs add up to: `up` when every observed leg is up, `down`
when one is not, and `not-set-up` when the lobby holds no bridge config at all. The level column
is the same one every report uses:

| Level | Meaning |
| --- | --- |
| `ok  ` | as it should be |
| `warn` | worth knowing |
| `MISS` | a leg is down; `status` exits 1 |
| `--  ` | neither: a note |

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


`--json` prints the same report as one document: the helper rows, each bridge's config, seats,
process, socket, mailbox and last audit entry, the guard reports, and the front's two statuses and
certificate dates. Token values, key material and the helper config's contents are not in it
either — fields are named, never filled:

```console
$ team mcp status --json ; echo "exit $?"
{
  "format": 1,
  "lobby_dir": "~/.config/team/lobby",
  "helper": {
    "root": "/usr/local/teamcli-helper",
    "present": true,
    "rows": [
      {
        "name": "root",
        "state": "ok  ",
        "detail": "0755, world-traversable"
      },
      {
        "name": "keys",
        "state": "ok  ",
        "detail": "0700, private (contents are the helper's own, not readable here)"
      },
      {
        "name": "queue",
        "state": "ok  ",
        "detail": "0700, private (contents are the helper's own, not readable here)"
      },
      {
        "name": "state",
        "state": "ok  ",
        "detail": "0700, private (contents are the helper's own, not readable here)"
      },
      {
        "name": "sock/",
        "state": "ok  ",
        "detail": "0750, excludes \"other\""
      },
      {
        "name": "bin/bun",
        "state": "ok  ",
        "detail": "executable"
      },
      {
        "name": "app/",
        "state": "ok  ",
        "detail": "the bridge script is deployed"
      },
      {
        "name": "helper-config.json",
        "state": "ok  ",
        "detail": "0600, owner-held (its contents are not read here)"
      }
    ]
  },
  "bridges": [
    {
      "dir": "~/.config/team/lobby/mcp-1",
      "config": "ok",
      "problem": null,
      "wss_url": "wss://mcp.example.test/connector",
      "seats": [
        {
          "alias": "beacon",
          "route": "seat-beacon-1",
          "key_id": "seat-beacon-1"
        }
      ],
      "signer_socket": {
        "path": "~/.config/team/lobby/mcp-1/signer.sock",
        "state": "ok"
      },
      "bridge_process": "up",
      "mailbox": {
        "outbound_ready": 2,
        "inbound_ready": 0
      },
      "inbox_outbox": null,
      "audit": {
        "path": "~/.config/team/lobby/mcp-1/audit.jsonl",
        "last": {
          "ts": "2026-10-04T08:55:00Z",
          "event": "ws-open"
        }
      }
    }
  ],
  "guards": [],
  "front": {
    "origin": "https://mcp.example.test",
    "mcp_status": 401,
    "connector_status": 401,
    "tls_valid_to": "2027-01-02T09:00:00Z",
    "tls_authorized": true
  },
  "state": "up"
}
exit 0
```


`doctor` prints one finding per line, the level first, then two spaces, and a `fix:` line under
each finding that has one — the same shape as [team doctor](doctor.md). A finding a command can
repair is a command to run; one that needs the owner's shell or root is marked `[owner]` and names
what it would do, never running it. The last line counts the findings:

```console
$ team mcp doctor ; echo "exit $?"
ok    root: 0755, world-traversable
ok    keys: 0700, private (contents are the helper's own, not readable here)
ok    queue: 0700, private (contents are the helper's own, not readable here)
ok    state: 0700, private (contents are the helper's own, not readable here)
ok    sock/: 0750, excludes "other"
ok    signer socket: ~/.config/team/lobby/mcp-1/signer.sock accepts connections (0660)
ok    bin/bun: executable
ok    app/: the bridge script is deployed
ok    helper-config.json: 0600, owner-held (its contents are not read here)
ok    ~/.config/team/lobby/mcp-1: config: 0600, 827 bytes
ok    ~/.config/team/lobby/mcp-1: seats: beacon -> seat-beacon-1 (seat-beacon-1)
ok    ~/.config/team/lobby/mcp-1: bridge process: running
ok    ~/.config/team/lobby/mcp-1: signer socket: ~/.config/team/lobby/mcp-1/signer.sock accepts connections
ok    ~/.config/team/lobby/mcp-1: mailbox: 2 outbound ready, 0 inbound ready
ok    ~/.config/team/lobby/mcp-1: last audit: ws-open at 2026-10-04T08:55:00Z
team mcp doctor: nothing missing, 0 warnings
exit 0
```


A bridge that is not running is one `MISS` with the command that starts it, and the signer socket
— the helper's own, or the one a bridge config names — is probed on every run: a socket that
refuses connections says "restart the signer socket", and one that is registered but not there is
`MISS` too. The front is read the way a seat would reach it: a connector route answering 401 is
bound and token-gated, a 404 (or no answer) is `MISS` with the owner's tenant switch, and a
certificate closer than 30 days is a `warn`, closer than 7 a `MISS` with the renewal. A guard's
replay ledger's folder readable beyond the owner, and a reply answer folder that is not `0700`,
are `MISS` findings of their own: the guard blocks on them.

## Refusals

The two subcommands are required, and only they are known; anything else prints the usage and
exits 2 without reading the machine:

| Message | Exit |
| --- | --- |
| `team mcp: a subcommand is required: status or doctor` (with the usage) | 2 |
| `team mcp: unknown subcommand "nope"` (with the usage) | 2 |
| `team mcp: unexpected "x"` / `team mcp: unknown option --x` (each with the usage) | 2 |

```console
$ team mcp  ; echo "exit $?"
team mcp: a subcommand is required: status or doctor

Usage: team mcp status [--json]
       team mcp doctor [--json]
Read-only: reports the MCP bridge's state and diagnoses what is missing.
`status` exits 0 when every observed leg is up, 1 when one is down or the
bridge was never set up. `doctor` exits 0 when nothing is missing, 1 with
findings. Owner-gated fixes are marked [owner]. The mutating setup commands
(enable, disable, key generation) are not in this build yet.
exit 2
```


## Exit codes

- `0` — `status`: every observed leg is up. `doctor`: nothing missing.
- `1` — `status`: a leg is down, or no bridge config was found (`state: not-set-up`). `doctor`: at
  least one `MISS`.
- `2` — the invocation can't be read: no subcommand, an unknown one, an option this build does not
  know.
