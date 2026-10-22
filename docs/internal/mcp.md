# `team mcp`: rationale and known limits

What moved off [the `team mcp` page](../commands/mcp.md): what the run reads and writes,
what each report prints, the behaviour behind the levels and the findings, the refusals in their
own words, and the known limits. The synopsis, the flags, the caller line and the exit codes stay
on the page.

## What the run does: the helper, the bridges, the front

Reads the MCP bridge's local state — the helper under its install root, every bridge config in the
lobby, the seat guards beside them, and the public front the connector dials — and reports it
without touching it. `team mcp status` prints one table per leg and the state they add up to;
`team mcp doctor` turns the same surface into findings, each missing one with a one-line fix, the
way [team doctor](doctor.md) does. Both are read-only: nothing is written, no secret value is ever
printed (a secret is named, never shown — presence, modes and sizes at most), and no privileged
command is run. A repair only the owner can make is marked `[owner]` and printed, never run. The
mutating side — `setup`, `enable`, `disable`, key generation, certificate minting — is not in this
build yet; `doctor` points at the bring-up runbook for it.

## `serve`: the seat's own inbox

`team mcp serve` is the other direction: one seat's inbox, spoken to the CLI that started it as an
MCP server over stdin and stdout — one JSON-RPC message per line in each direction. MCP is
client-pull, so the server answers and never pushes: two tools are served, `inbox_check` lists the
messages waiting in that seat's own drop folder, and `inbox_read` returns one of them. The seat
notices a message when its client calls `inbox_check`; nothing in this process wakes the client up.

The seat, the session and the project root are fixed at launch. `--seat` must name a seat the team
file declares, `--session` (when given) must be the team's own session, and the folder served is
`<root>/.agents/send-drops/<session>/<seat>` for that team. `--file` names the team file the
launch read; with no `--file` the server reads the team file of the folder it starts in, which a
seat launched into a lobby does not have. No tool argument can name another
seat's folder or a path: a message id must be a lowercase UUID (or the `unread-<uuid>` name a
build before 0.5.3 wrote for a lead's runtime report), and a string that is anything else never
reaches the filesystem.

`inbox_read` writes `<id>.read.json` beside the message **before** it returns the body — a read that
cannot leave that receipt is refused, so the server never hands over a body it did not record. The
receipt is the signed status receipt `team messages` also writes: `{payload: {kind, status, id, to,
root, session, at}, signature}`, signed with the checkout's message key, so the inbox, `team
drops`, `team messages` and the watch all verify the same file rather than trusting its presence.
It is write-once per status for the message and context it verifies for — a signed receipt already
at the name that verifies for this message, seat, checkout and session is never rewritten, so a
second read adds nothing and a late read never lowers a receipt already on disk — while a regular
file at that name this key did not sign for this message is replaced by the signed receipt, so a
planted or stale file cannot keep a message at `sent` forever, and a name held by a link, a folder
or a FIFO is refused rather than replaced. That receipt is the whole evidence this leg produces, and it says the
seat *read* the message, not that it acted on it: the status a send can honestly report from it is
`delivered (read)`.

While it runs, the server keeps `.inbox-listener` in the seat's own drop folder — `{v, seat,
session, root, cli, pid, ts}` — and removes it at exit, but only while it still names this
process's pid. A server that died without cleaning up leaves the marker behind naming a dead pid,
which is how the send side can tell a live route from a stale one.

Nothing is ever written in another seat's folder, and no message is moved or rewritten: the drop
file is still the message, and the receipt is the only mark. A message that is a symbolic link is
not served, and a receipt path held by a link is refused rather than followed.

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
the bridge process whose command line names the config it belongs to. `status` and `doctor` write
nothing.

`serve` reads and writes only inside the one seat's own drop folder: it lists that folder and reads
one message file per `inbox_read`. It writes the listener marker there at start (0600, by atomic
rename), removes it at exit, and writes one receipt per read (0600, by atomic rename) before the
body leaves. It never touches another seat's folder, never follows a link and never rewrites or
deletes a message.

## Who may run it

Anyone, in any terminal, may run `status` and `doctor`: both write nothing at all. `serve` belongs
to the seat's own launch line: it serves exactly the inbox of the seat it names, and writes only
inside that seat's own drop folder.

## What it prints

`status` prints the context line naming the lobby, then one section per leg — helper, each bridge,
the front, each guard — each opening on a `NAME  STATE  DETAIL` header row and its own rows, and
closes with the state the legs add up to: `up` when every observed leg is up, `down` when one is
not, and `not-set-up` when the lobby holds no bridge config at all. The state column is the same
level vocabulary every report uses:

| Level | Meaning |
| --- | --- |
| `ok  ` | as it should be |
| `warn` | worth knowing |
| `MISS` | a leg is down; `status` exits 1 |
| `note` | neither: a note |

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


`--json` prints the same report as one `team.mcp` document with the `schema` tag first: the helper
rows, each bridge's config, seats, process, socket, mailbox and last audit entry, the guard
reports, the front's two statuses and certificate dates, and the state, for `status`; the same
findings and their two counts for `doctor`. Token values, key material and the helper config's
contents are not in it either — fields are named, never filled:

```console
$ team mcp status --json ; echo "exit $?"
{
  "schema": {
    "name": "team.mcp",
    "version": 1
  },
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


`doctor` prints the context line, then one finding per line, the level first, then two spaces, and
a `fix:` line under each finding that has one — the same shape as [team doctor](doctor.md). A
finding a command can repair is a command to run; one that needs the owner's shell or root is
marked `[owner]` and names what it would do, never running it. The last line counts the findings:

```console
$ team mcp doctor ; echo "exit $?"
mcp ~/.config/team/lobby
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

The three subcommands are required, and only they are known; anything else prints the usage and
exits 2 without reading the machine. Under `--json` the same refusal is one `team.error`
document on stdout — `error.id` `mcp.invocation`, `error.message` the sentence below without its
`team mcp: ` prefix, `error.repair` `null` — and stderr stays empty:

| Message | Exit |
| --- | --- |
| `team mcp: a subcommand is required: status, doctor or serve` (with the usage) | 2 |
| `team mcp: unknown subcommand "nope"` (with the usage) | 2 |
| `team mcp: unexpected "x"` / `team mcp: unknown option --x` (each with the usage) | 2 |
| `team mcp: --seat <seat> is required` / `team mcp: unknown option --json` (each with the usage) | 2 |

`serve` refuses to start, writing one line on stderr and nothing on stdout, when the placement
can't be read (the reason is the team file's own when it can't be read):

| Message | Exit |
| --- | --- |
| `team mcp serve: the team file declares no seat "ghost"` | 2 |
| `team mcp serve: the team's session is "acme", not "other"` | 2 |
| `team mcp serve: the inbox folder is not a real folder: a link, a file or a failed write stands in its path` | 2 |
| `team mcp serve: the inbox listener marker could not be written` | 2 |

A start refusal is `mcp.serve-refused`, not `mcp.invocation`; a clean end of stdin is
`mcp.serve-ended`. The folder path is checked again on every tool call, so a folder that becomes
a link after start makes the call fail (`isError: true`) instead of being followed.

```console
$ team mcp  ; echo "exit $?"
team mcp: a subcommand is required: status, doctor or serve

Usage: team mcp status [--json]
       team mcp doctor [--json]
       team mcp serve --seat <seat> [--session <session>] [--file <path>]
Read-only: reports the MCP bridge's state and diagnoses what is missing.
`status` prints one table per leg and the state they add up to; `doctor`
turns the same surface into findings, each missing one with a one-line fix.
Owner-gated fixes are marked [owner]. The mutating setup commands (enable,
disable, key generation) are not in this build yet. --json prints one
document instead of the lines: {format, lobby_dir, helper, bridges, guards,
front, state} for status, {format, lobby_dir, findings, missing, warnings}
for doctor. A run that exits 2 writes the structured error document instead
— {error: {id, message, repair}} — and stderr stays empty.

`serve` is the seat's inbox, for the CLI that started it: a stdio MCP
server with `inbox_check` and `inbox_read` over one seat's drop folder.
Its stdout carries JSON-RPC lines only. --seat is required; --session
defaults to the team's session and must match it. --file is the team file
the seat's launch read: a seat that starts in a lobby has none in its
folder, so its registration names the launch's file and the server reads
that. It exits 0 when stdin closes and 2 when the invocation or the team
placement can't be read.

Exits 0 when every observed leg is up (status) or nothing is missing (doctor),
1 when a leg is down, the bridge is not set up, or doctor finds something
missing, 2 when the invocation can't be read.
exit 2
```
