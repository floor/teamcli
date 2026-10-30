# team mcp

Reads the MCP bridge's local state — the helper under its install root, every bridge config in the
lobby, the seat guards beside them, and the public front the connector dials — and reports it
without touching it. `team mcp status` prints one table per leg and the state they add up to;
`team mcp doctor` turns the same surface into findings, each missing one with a one-line fix. Both
are read-only: nothing is written, no secret value is ever printed (a secret is named, never
shown), and no privileged command is run. The mutating side — `setup`, `enable`, `disable`, key
generation, certificate minting — is not in this build yet.

The third subcommand, `team mcp serve`, is the other direction: one seat's inbox, spoken to the
CLI that started it as a Model Context Protocol server over stdin and stdout. Its stdout carries
JSON-RPC lines only. It reads only that seat's own drop folder, writes one listener marker while
it runs, and writes one receipt per message it returns — the signed status receipt `team
messages` writes — and it never writes the message itself. A read parses the message's signed
record and verifies its signature with the checkout's message key before anything is shown: a
tampered or unsigned file is refused with a tool error and no receipt, so a receipt only ever
proves a read of a record the server authenticated.

When the seat's own launch carries the development-channels flag naming this server
(`--dangerously-load-development-channels server:team-inbox`), `serve` also declares the
`claude/channel` capability, gives its client one instruction — acknowledge the id from a channel
notification's meta in the same handling turn — and serves the `ack` tool beside `inbox_check` and
`inbox_read`. Each signed record that arrives after the server starts is pushed once as
`notifications/claude/channel`: the content opens with the message-display header and carries the
signed body, and the meta carries identifiers only (`id`, `from`, `seat`, `team`). The push is not
a read — the client acknowledges nothing at the transport — so the server writes
`<id>.channel-push.json` beside the record, mode 0600, as the proof that the notification was
written, and the sender's channel leg reads that marker. `ack` takes the id, verifies the record in
this inbox as the read tools do, and writes the same signed `<id>.read.json` receipt as `team ack`
with `read_by: channel`; an id this inbox does not hold, a client record and a general brief are
refused with a tool error and no receipt. A pushed record already holding a marker is never pushed
again, and a launch without the flag is the ordinary inbox server: no capability, no instructions,
no push and no `ack`.

A seat's launch registers the server with its CLI where a run measured a route. A codex seat's
launch line carries the registration itself — two `-c` values naming the server and this
install's runner, and no file written into the seat's folder; the team file the launch read is
named there too, in the server's own arguments. A gemini or grok seat's launch
runs that CLI's own `mcp add -s project` in the seat's folder, naming the same runner, and the
file the command writes is the CLI's own project settings (`.gemini/settings.json`,
`.grok/config.toml`). A cursor seat's launch merges the server into the seat's own
`.cursor/mcp.json` and carries `--approve-mcps`, so the CLI loads the server team registered
for it. The server names the seat it launched for;
the session it serves is the team file's the launch read — the file the launch resolved and passed
to the registration, which names it to the server too, so a seat whose folder is a lobby (it holds
no team file of its own) serves the same team as every other seat.
Where the seat's folder is a git work tree that does not ignore a file the registration would
write, team refuses to register: the seat stays on its drop and typed legs, and its line
carries the reason.

## Synopsis

    team mcp status [--json]
    team mcp doctor [--json]
    team mcp serve --seat <seat> [--session <session>] [--file <path>]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--json` | — | the report as one `team.mcp` document (`format: 1`) instead of the lines; a run whose invocation can't be read writes the structured error document; `serve` takes no `--json` |
| `--seat` | a seat the team file declares | `serve` only, required: the seat whose inbox is served. The server is started by that seat's launch line, and this argument must name the seat it was started for |
| `--session` | the team's session | `serve` only: stamped on the listener and on every receipt; must be the team file's own session |
| `--file` | a team file | `serve` only: the team file the seat's launch read. A seat that starts in a lobby has no team file in its folder, so its registration names the launch's file and the server reads that instead |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| anyone, in any terminal | run `status` or `doctor`: both write nothing at all |
| a seat's own launch line | start `serve` for that seat; it writes only that seat's listener marker, one receipt per verified read in the seat's own drop folder, and — when it declares the channel — one push marker per record it notifies |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| `status`: every observed leg is up | the context line `mcp <lobby>`, then one `NAME  STATE  DETAIL` table per leg — helper, each bridge, the front, each guard — closing with `state: up` | 0 |
| `status`: a leg is down, or the lobby holds no bridge config at all | the same lines, with the `MISS` rows, closing with `state: down` or `state: not-set-up` | 1 |
| `doctor`: nothing missing | the context line, then one finding per line — the level, then the sentence — with a `fix:` line under each finding that has one, then `team mcp doctor: nothing missing, <n> warnings` (`0 warnings` when there are none) | 0 |
| `doctor`: at least one `MISS` | the same findings, and the closing count | 1 |
| `serve`: the client closed stdin | nothing on stderr; on stdout only the JSON-RPC replies the client's requests asked for — `initialize`, `ping`, `tools/list`, each tool call's result — and, when the server declares the channel, one `notifications/claude/channel` per record that arrived while it ran — then the process ends | 0 |
| `serve`: the invocation, the team placement or the inbox folder can't be read | `team mcp serve: <reason>` on stderr, nothing on stdout; the server never starts | 2 |
| the invocation can't be read: no subcommand, an unknown one, an option this build does not know | `team mcp: <reason>`, with the usage | 2 |

Both reports open on the context line naming the lobby whose bridge configs are read. `--json`
prints one document instead — `team.mcp` with `{format, lobby_dir, helper, bridges, guards,
front, state}` for `status` and `{format, lobby_dir, findings, missing, warnings}` for `doctor`.
A run that exits 2 writes the structured error document instead — `{error: {id, message,
repair}}` — and stderr stays empty; `error.id` is `mcp.invocation`.

Exits are documented in the usage: `Exits 0 when every observed leg is up (status), nothing is
missing (doctor), or the client closed the inbox server's stdin (serve), 1 when a leg is down, the
bridge is not set up, or doctor finds something missing, 2 when the invocation, the team placement
or the inbox folder can't be read.`

## Example

`status` prints one table per leg, and closes with the state the legs add up to:

```console
$ team mcp status ; echo "exit $?"
mcp ~/.config/team/lobby
helper  /usr/local/teamcli-helper
  NAME                STATE  DETAIL
  root                ok     0755, world-traversable
  keys                ok     0700, private (contents are the helper's own, not readable here)
  queue               ok     0700, private (contents are the helper's own, not readable here)
  state               ok     0700, private (contents are the helper's own, not readable here)
  sock/               ok     0750, excludes "other"
  bin/bun             ok     executable
  app/                ok     the bridge script is deployed
  helper-config.json  ok     0600, owner-held (its contents are not read here)
bridge  ~/.config/team/lobby/mcp-1
  NAME            STATE  DETAIL
  config          ok     0600, 827 bytes
  seats           ok     beacon -> seat-beacon-1 (seat-beacon-1)
  bridge process  ok     running
  signer socket   ok     ~/.config/team/lobby/mcp-1/signer.sock accepts connections
  mailbox         ok     2 outbound ready, 0 inbound ready
  last audit      ok     ws-open at 2026-10-04T08:55:00Z
front  https://mcp.example.test
  NAME             STATE  DETAIL
  mcp endpoint     ok     401, OAuth required (the front answers)
  connector        ok     401, enabled and token-gated (the route is bound)
  tls certificate  ok     valid for 90 more days (to 2027-01-02T09:00:00Z)
state: up
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/mcp.md](../internal/mcp.md),
and the inbox leg's per-CLI routes, bounds and evidence rule: [docs/internal/mcp-inbox.md](../internal/mcp-inbox.md).
