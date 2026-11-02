# The team inbox leg: routes, bounds and evidence

`team mcp serve` is the seat-side half of the mcp-inbox delivery leg. The seat's launch line
starts it with the seat's own CLI, the CLI calls `inbox_check` and `inbox_read`, and `inbox_read`
writes the receipt that says the message was read. This page is the runbook: which CLIs carry a
route in this build, what each registration writes, the bounds on every wait, and the evidence
rule behind the status words.

## Per-CLI routes, as measured

Every row was measured on this machine with the binary's own `--version` and `--help`; no owner
config file was opened. The rows were measured on 2026-10-18 except antigravity's, measured on
2026-11-02 in a scratch HOME, whose store was seeded with an unrelated entry and left holding it.

| CLI | Version measured | Route team uses | Written in the seat's folder | Registration surface quoted |
| --- | --- | --- | --- | --- |
| claude-code | 2.1.302 | none — it has the native leg | nothing | `claude mcp add ... -s, --scope <scope> (local, user, or project)` |
| codex | codex-cli 0.161.0 | two `-c` values on the launch line, naming `mcp_servers.team_inbox` | nothing | `-c, --config <key=value>` "Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`" |
| gemini | 0.64.0 | `gemini mcp add -s project team-inbox ...` | `.gemini/settings.json` | `-s, --scope <user\|project> (default: "project")` |
| cursor | 2026.10.16-e3cb207 | team merges the entry into `.cursor/mcp.json`; the launch line adds `--approve-mcps` | `.cursor/mcp.json` | `mcp login <identifier>` names ".cursor/mcp.json"; `--approve-mcps` "Automatically approve all MCP servers" |
| grok | 1.0.60 | `grok mcp add -s project team-inbox ...` | `.grok/config.toml` | `-s, --scope <user\|project>`; "project (./.grok/config.toml)" |
| antigravity/agy | 1.4.12 | `agy mcp add team-inbox-<session>-<seat>-<hash> ...`, one entry per seat in the CLI's user-level store | nothing | `agy mcp add [flags] <name> <commandOrUrl> [args...]`; no scope flag, and `--help` shows no per-run config route |
| muse | 1.4.10 | none — the drop leg | nothing | `muse init` scaffolds `AGENTS.md`; no workspace settings route in `--help` |
| jules | no MCP in `--help` | none — the drop leg | nothing | none |

A route the launch line carries writes no file. A route that is a file is written in the seat's
own folder, before the launch command runs, so the client starts with the server in place. The
team the registration serves is the team file the launch read, passed to the registration; a
file route runs `mcp add ... --file <path>`, and a launch-line route puts the same pair in the
server arguments it configures, because a seat whose folder is a lobby has no team file of its
own. With no launch file the registration reads the folder's own team file to name the session
and the epoch, and names no file to the server; that server resolves its team from the registry
record that holds the seat.

## What launch writes, and where it refuses

codex gets its registration from the launch line itself and nothing is written. gemini and grok
run their own `mcp add -s project` in the seat's folder, and team requires the file the command
claims to write to exist afterwards. cursor's file is written by team: the `team-inbox` entry is
merged into `.cursor/mcp.json`, every other server and key is kept, and the new text is written
beside the file and renamed over it at mode 0600. A file that is a link, not a regular file, not
JSON, not one object, or whose `mcpServers` is not an object is left exactly as it is and the
registration is refused.

An antigravity seat's launch runs `agy mcp add` and writes nothing into the seat's folder: the
entry lives in the CLI's user-level store (`$HOME/.gemini/config/mcp_config.json`, created on the
first add), which every team on the machine shares. The entry is named for the team and the seat —
`team-inbox-<session>-<seat>-<hash>`, in the characters the store accepts — so two seats never
overwrite each other; the hash of the exact pair keeps pairs that fold to the same readable part
(`red-team` with `writer`, `red` with `team-writer`) apart. On 1.4.12, measured in a scratch HOME:
a re-add replaced that entry and printed
`Added MCP server "<name>" (stdio)`; an unrelated `floor-committee` entry seeded in the store
survived both the add and the remove byte for byte; `agy mcp remove <name>` removed that one entry
and exited 0; removing a name the store did not hold exited 1 with
`Error: MCP server "<name>" not found`. `team down` and `team remove` run that remove for each seat
they close and nothing else; an exit 1 is the entry already gone only when stderr carries that
message for this seat's own name, and any other exit is reported on stderr while the seat's
teardown proceeds.

The written config names this install's runner — the executable and its entry script — so the
server starts whether or not `team` is on the PATH.

Nothing team writes may land in a file the project tracks. Before writing or running `mcp add`,
team asks git in the seat's folder: a folder that is not a work tree is the seat's own and is
allowed; one inside a work tree must have the target ignored. A target the project does not
ignore is refused, and nothing is written — including a file force-added to the index while
`.gitignore` names its directory, which `git check-ignore` reports as not ignored. A repository
with no work tree is refused the same way.

A refused registration leaves the seat on its drop leg and the seat's line carries the
reason, prefixed `the team inbox was not registered: ` — for example `its project does not ignore
.cursor/mcp.json`, `` `gemini mcp add` exited 1 ``, or `.gemini/settings.json was not written`.
The seat still launches.

## The server serves only its own launch

The server a registration starts is bound to the seat and launch it was started for, not only to
the folder it reads. Before it opens the inbox, `serve` proves that the process the CLI started is
the seat `--seat` names: the caller must place as that seat — the same reading every command makes
of its caller — on the pane the team's state records for it, in the team's own session. A
process started with another seat's file, seat or session is refused even when it carries that
seat's launch epoch, and so is a seat the state records on another pane or with no pane. The
seat's current claim is the launch's other half: when the state holds one, `--epoch` must name
that claim's epoch; when there is none, the server must carry no epoch. Both proofs run again on
every tool call and every channel push, so a seat stopped, moved or relaunched under a running
server is served nothing by it — no list, no body, no receipt — and no push marker is written.
The refusal sentences are listed in [mcp.md](./mcp.md).

## The bounds

Every wait on the leg is bounded.

| Bound | Value | What it does |
| --- | --- | --- |
| listen-or-skip | the `.inbox-listener` marker names a live pid | no live server is a definite failure; the walk moves on and records `mcp-inbox: no live inbox listener` |
| `INBOX_GRACE_MS` | 2000 ms | how long `team send` waits for a receipt after writing the drop |
| `INBOX_FALLBACK_MS` | 10 minutes | how long the watch leaves an unread inbox drop to the seat's own client before its first fall-back pass; the retry types nothing, and the marker runs to `PENDING_MAX_AGE_MS` |
| `PENDING_MAX_TRIES` | 3 | typed retries once the fall-through starts — never spent in a build that types nothing into a seat |
| `PENDING_MAX_AGE_MS` | 30 minutes | the marker's whole life, from the send |
| `CHANNEL_TICK_MS` | 250 ms | how often a serving inbox looks for a record it has not pushed yet |
| `CHANNEL_PUSH_GRACE_MS` | 2000 ms | how long `team send` waits for the server's push marker after writing the record |
| `CHANNEL_CONFIRM_MS` | 3 minutes | how long a push waits for its signed read receipt before the one redelivery |

A send with no receipt in the grace prints `sent (unconfirmed)` with the receiving seat's
delivery class appended — `queued; <seat> reads it at its next turn, and nothing here gives it one
(pull-only)`, `queued; nothing wakes <seat> while it is idle; a person or a restart must give it a
turn` (or the typed-wake variant, `… except a send-time typed wake into an empty composer`),
`queued; <seat> has no way to be woken while idle`, `queued; its webhook fires when the bus takes
it`, `woken through its event adapter` or `woken through its runtime queue`, with `the typed wake
failed (<reason>)` or `the typed wake did not run (<reason>)` inserted after `queued; ` when the
send reached for the typed leg — keeps the drop and the marker, and ends the walk there: the
message is safe, and the seat's client may still read it. The watch promotes a receipt to one `delivered
(read)` history line and clears the marker, typing nothing. Past `INBOX_FALLBACK_MS` the watch's
retry pass looks at the marker again, but the retry types nothing in this build
(`src/send/no-pane-messaging.ts`): it can promote a receipt that has arrived and deliver nothing
else. A marker addressed to a human seat is given up on the next pass with `the pane is a
human's, and nothing is typed into it`; one on a seat back at its shell with `the seat is back at
its shell; nothing was typed`; otherwise the marker runs to `PENDING_MAX_AGE_MS`, where it is
given up as `the retry window passed`. A receipt that arrives before that bound is still
`delivered (read)`, and one the retry itself promotes carries `mcp-inbox: no receipt within 10m`
as the history line's `failed` note. The same folder serves the `drop` leg, whose marker
says `leg: drop`: nothing ever types it — the seat's turn-start `team drops --read` writes the
same receipt — and past `PENDING_MAX_AGE_MS` with no receipt the watch gives up on the marker
with `no receipt within 30m` and the drop file's path. Nothing is typed into a pane on any of
these paths, and a drop that runs out of bounds is reported with its path rather than lost.

`team feed` shows one row per message: a later line for the same id — receipt, fall-back or taken
report — replaces the earlier outcome, and a `--follow` pass prints the update when it arrives.

## The channel, when the launch carries the flag

A seat's launch line may start its client with a development channel naming this server:
`--dangerously-load-development-channels server:team-inbox`. That flag is the whole eligibility
test on the server side. Only then does `serve` declare `experimental["claude/channel"]`, serve
the `ack` tool beside `inbox_check` and `inbox_read`, and give its client one instruction — call
`ack` with the id from a notification's meta in the same handling turn, before reading or acting
on the message. No `claude/channel/permission` capability is ever declared: this server asks the
person for nothing. A launch without the flag is the ordinary inbox server, with no capability,
no instructions, no push and no `ack`, and the listener marker it writes carries no `channel`
word.

Every signed record that arrives after the server primes is pushed once as
`notifications/claude/channel` with `{content, meta}`. Mail already waiting when the server starts
is left to `inbox_check`, so a fresh session starts quiet. The content opens with the
message-display header and carries the signed body whole; the meta carries identifiers only —
`{id, from, seat, team}`. A record a client wrote, the seat's own general brief, and a record that
does not verify with the home's message key are never pushed. After writing the notification the
server writes `<id>.channel-push.json` beside the record, whole, mode 0600, with `wx` so a second
write cannot replace it: `{v, kind: "channel-push", id, seat, session, root, at, meta,
content_sha256, status: "sent (channel)"}`. That marker is the proof the notification was written,
never the proof it was read, and a record already holding one is not pushed a second time.

The transport acknowledges nothing. T1's independent replay of a spike server measured only the
visible wrapper line, `← team: Message from Coordinator`, with that spike server named `team`; the
`ack` call is the only channel receipt. `ack` takes the id from the meta and writes the signed
read receipt `team ack` writes — `{status: "read", read_by: "channel"}` at `<id>.read.json`,
published with the same exclusive, no-clobber link as `inbox_read`. An id this inbox does not
hold, a record addressed to another seat, session or checkout, a record a client wrote, the
general brief, a record that does not verify, and a receipt name held by a file that does not
verify for this message are each a tool error with no receipt. A verifying receipt already at the
name means the message was already acknowledged: the call answers `{acknowledged, written:
false}` and no receipt is rewritten, so `ack`, `inbox_read` and `team ack` all find the same
evidence.

`team send` walks the channel first only when the seat declares no order, the receiver's CLI is
claude-code, the launch carries the flag naming this server, and the seat's live listener marker
says `channel: true`. It writes the signed record and waits `CHANNEL_PUSH_GRACE_MS` for the push
marker; the marker present ends the walk as `sent (channel)` with the pending marker's
`leg: channel`. No marker clears that pending marker, records `channel: no push receipt within
<n> ms` in the history line's `failed`, and continues the walk to the next leg — the inbox server
still reads the record it holds. The watch promotes a signed receipt to one `delivered (read)`
line and types nothing; no receipt after `CHANNEL_CONFIRM_MS` is the one case it redelivers. It
redelivers exactly once, through the next leg — a socket frame when the seat's socket is
eligible; a socket the gate refuses goes to the ordinary retry, which asks for the trigger and
types nothing in this build, so the message waits in the inbox and the marker is given up at
`PENDING_MAX_AGE_MS` — and stamps the marker and the history line with `redelivered: channel
unconfirmed` before the attempt, so no later pass selects it again. A receipt that arrives after
the redelivery settles the message as `delivered (read)`; an acknowledged record is never touched
again, and no seat whose receipt exists is woken again.

The evidence rule above still holds: the push marker is not a read, and only the signed receipt at
`<id>.read.json` makes a channel delivery `delivered (read)`.

## An install under a running server

`serve` keeps the code it started with: installing a build under it neither reloads it nor ends
it. Two rules close that gap, one on each side.

The listener marker names the install the server started from — its `version`, its `build` (a
short digest of the entry module it loaded) and the packed `head` when the package carries one. A
sender of another version or another packed commit judges the marker stale and walks its next
leg, exactly as it does for a dead pid, and a marker that records no identity cannot vouch for
the server's code. The channel leg and the `mcp-inbox` leg both require a marker this build can
vouch for.

On every channel tick, and after each line its client writes, the server compares the install
under it — the version and packed commit the installed entry names — with the one it started
from. When they differ it stops its channel, closes its input, removes its marker and starts the
installed entry with the same arguments and this process's stdio, then exits 0 once the fresh
process reports that it started: the installed build reads the same stdin, so the calls that
arrive there next are answered by it. A line the old process had already read is not replayed.
When the installed entry cannot be started — the start call fails, or it reports an error on the
child after returning — the server says so on stderr and exits 1; the next launch starts the
installed build. A server started from a build before this one has none of this: it cannot learn
to reload, so restarting the seat's client is what moves it, and until then a sender of this
build protects the seat itself by holding the push name whenever its walk wakes the seat.

A sender that falls back from a stale channel listener has a second hazard: the old server still
watches the folder and would push the record after the sender's own wake. Before it writes the
record, when its walk holds a leg that wakes the seat (socket or native), the sender
writes a marker at the push marker's own name, `<id>.channel-push.json` — `{v, kind:
"channel-held", id, at, reason}`. Every marker-aware serving server treats a marker for the id
as a push already made and skips it; a build older than the marker rule cannot honor it, which is
the case the reload rule above exists for. The marker is not a push: the sender's wait reads
only the server's `channel-push` marker as delivery, and a wait that finds the held marker alone
has delivered nothing.

The watch's retry reserves the same name before its wake attempt — the socket frame — and
`retryOne` reserves again before the trigger it asks for, which this build refuses. It does not
ask whether the listener is stale:
an install, or a listener, can change between any check and the wake, so the name is held before
the wake rather than after a verdict that could be stale by the time the wake lands. The one
listener fact it reads is whether a channel-declaring server is running at all: a seat whose
current launch no longer names the channel still reserves while a live listener started with the
flag is alive, because that server can still push. The marker must name this seat, this session
and this root, and its pid must be live; a marker naming another inbox proves nothing and holds
nothing. The marker is one file and last-writer-wins: when a second server starts for the same
inbox it overwrites the first's marker, so a newer marker that declares no channel hides an older
channel server that is still running. This build has no per-seat singleton at server startup, so
the launch-drift reservation covers one serving process per inbox. With two servers the older
channel one is not covered and can still display the record after the wake — the same display
duplicate the in-flight tick produces, the full body appearing once more, never a second record
or id and never a second valid read receipt. A server started after the record arrived pushes
nothing — its first listing is marked seen — so a dead marker leaves no push to race. The record
stays in the inbox and `inbox_check`/`inbox_read` still serve it, so holding the name never
withholds the message.

The hold is permanent for the id, and nothing removes it. If the wake it precedes is never taken
— the retry types nothing in this build, a socket frame is refused and the pane never frees, or
the pass cannot wake at all — the name stays held, and no
marker-aware server pushes this record afterwards, including a tick a still-running server has yet
to make. Delivery then falls to the seat's own read: its turn-start drop read, `team messages`, or
`inbox_check`/`inbox_read`. That is the price of holding before the wake; removing the marker
after a wake that typed nothing would let a push land after the wake and reopen the duplicate the
reservation exists to stop.

One window remains, and it is a display duplicate, not a second message. A serving server writes
the notification before its push marker. A tick that has already passed its marker check before
the retry's write can therefore display the full body of the same id, and its own marker write
then fails on the held name. No second record is created and no second valid read receipt is
written: both are per id. So the claim is no second record or id, not at-most-once display. Two
serving processes for one inbox are not excluded — the listener marker is last-writer-wins and
each process's seen set is its own — so each live server can do that once; every later tick of
every process finds the name held.

## The evidence rule

The receipt is the only evidence this leg produces, and it is written by `inbox_read` before the
body is returned, once the record's signature has been checked against the checkout's message
key. It is the signed status receipt `team messages` writes — `{payload: {kind, status, id, to,
root, session, at}, signature}` at `<id>.read.json`, signed with the same message key — so one
module answers for the inbox, `team drops`, `team messages` and the watch, and each verifies the
receipt rather than trusting the file's presence. A file that is not a signed record, or whose
signature does not verify, is refused with a tool error and no receipt: a receipt never proves a
read of something the server could not authenticate. A plain-text drop an earlier build wrote is
one such file: `inbox_check` does not list it, and a read of it answers the same tool error and
writes no receipt, but it raises no refusal event to the owner — it is not a record anything could
have admitted, and listing it every turn would only repeat the refusal. A regular file that opens
as a record keeps both the refusal and the event, however it fails; a link, a FIFO or a directory
at a drop's name never reaches that read — the answer is a tool error with no receipt and no
refusal event. It says the seat *read* the message, not that it acted on it. So:

- a receipt is `delivered (read)`, in the console, the JSON, the history and `team feed`;
- no receipt is `sent (unconfirmed)`, with the drop kept;
- nothing on this leg is ever reported as acted on.

The receipt is the signed status receipt, and it is the per-id gate: `inbox_read` publishes it with
an exclusive, no-clobber `link` and flushes it with its folder before the body is returned. A
valid receipt at the name — a `read`, or the `replied` that came after one — means the message was
already served, so a second read adds nothing and no read moves a status backward. A file at the
read or replied receipt name that proves nothing for this message — unsigned, another message's,
another seat's, session's or checkout's — may hide a read that happened, so it is preserved and
the read returns no body; a name held by a link, a folder or a FIFO is refused the same way.
Nothing a read finds at a receipt name is ever replaced: a rival's receipt and a damaged one are
evidence, and neither is rewritten. Its signature is the procedural evidence, and nothing it says
is ever derived from pane text or a status.

## Checking a build

The behaviour is pinned by these suites, run with `bun test`:

- `test/mcp-inbox-server.test.ts` — the stdio server: tools, receipts, seat binding, refusals;
- `test/mcp-channel-server.test.ts` — the channel declaration, push and meta, the push marker and
  `ack`;
- `test/channel-leg.test.ts` — the send side's channel walk and the watch's one redelivery;
- `test/mcp-register.test.ts` — per-CLI routes, exact argv, the git rule, the file merge and its
  refusals;
- `test/launch/inbox-launch.test.ts` — registration happens before the launch command, and a
  refusal is detail under the seat's record;
- `test/send-delivery-order.test.ts` — the walk and its outcomes;
- `test/held-retry.test.ts` — promotion, fall-through and the bounds;
- `test/feed.test.ts` — one row per message.
