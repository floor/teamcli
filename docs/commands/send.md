# team send

Writes one message to one seat. A plain send writes the message whole as one signed record, mode
0600, by renaming a temporary file into place, and — on the typed leg — types one short trigger
line that announces the message. The record is the message: it carries the body, the sender, the
rule that admitted the send, and the thread it belongs to, and its name is the send's id.
A record waiting in a seat's folder is answered with [team reply](reply.md), which writes the
answer as a record on the same thread and cites the record it answers.
The body is never split across several writes. A seat whose CLI builds its own work item from
its screens — a profile with a compose module — still gets the record, but the body is typed
through those screens and never becomes a trigger line; `delivered` there means the CLI printed
the line that creates the item. A compose seat's brief is typed for one repo: the repo of the
seat's own folder, read from `git remote get-url origin` there. The module proves the CLI's own
chooser collapsed on that repo before it types, and refuses with nothing typed when the CLI's
list does not hold it. The receiving seat's
delivery order decides the channel: with no declaration it is `mcp-inbox`, then `typed`, then
`drop`; `native` and `headless-resume` are never in that default, and only a declared word can
add either. Each leg in
turn either takes the send, which ends the walk, or
definitely cannot take it, which hands the send to the next leg and is recorded as a failure —
the history line names the channel the send went by and the legs that failed before it. A typed
leg that finds no live agent — no agent carries the seat's name in its session, or the session
cannot be read — types nothing and hands the send to the next leg, its reason recorded as
`typed: <reason>`; once it types, its own outcome is the send's.

The drop leg writes that same record and types nothing at all — no trigger line, no socket
frame, nothing read from a pane — so a receiver that watches its own drop folder finds the
message there. When no inbox listener serves the seat, the default order walks it after
`mcp-inbox`; it is chosen alone with `delivery_order: [drop]`, and a human's seat always walks
it alone. Its console line is `<seat>: sent (unconfirmed) (drop, <n> ms)`, exit 0, with
`via: drop` on the history line: the record is the message, safely on disk, and no receipt has
come back yet. Beside the record the send leaves the marker `<id>.pending`, which says the drop
leg left it. The seat's own watcher reads it: at turn start its hook runs `team drops --read`,
which proves the record's signature, writes the signed receipt `<id>.read.json` beside it and
hands the body to the turn. A running `team watch` promotes the send on that receipt once — one
`delivered (read)` history line, the marker cleared, nothing typed. A record no watcher has read
when thirty minutes have passed is given up on with the file's path: the marker is cleared, the
watch says the send was not read, and the record stays in the folder — never typed, and never
called lost.

When another command holds the seat's lock, the send is queued rather than refused: the reachable
legs — `mcp-inbox`, `typed` and `drop` — write the signed record and its `<id>.pending` marker
without that lock, type nothing and dial nothing, and answer
`<seat>: queued (receiver busy) (<leg>, <n> ms; id <id>)`, exit 0. The id on that line is the id
the delivery keeps, and the marker is the one the watch already delivers — the typed retry for a
typed marker, the inbox window's fallback for an `mcp-inbox` one, and the seat's own watcher read
for the `drop` leg's — so the queue ends in the retry's or the watcher's own word, with its own
history line beside the acceptance the send wrote, and the message is never delivered twice. A queued send is an acceptance, never a delivery: no receipt is
claimed, and nothing says `delivered` until one comes back. A compose seat has no queued leg —
nothing on the watch's side walks its screens — so its held lock stays a refusal, and its line
says the send was not queued and to run it again when the seat is free.
A walk reaches `drop` when the legs before it did not take the send — the inbox had no live
listener and the typed leg found no live agent — or when the order puts `drop` before `typed`. A level of the receiving seat's own chain — entity, project, team, seat — may drop legs
from the order or put the legs it keeps in a different order, and may add only `native`, the
sender's own frame: a word naming any other leg the order in force does not have is set aside
and the order in force stands. The
words are read from the receiving seat's own files: the team file's `delivery_order` key and the
seat's, and the registry project's record for the project the team sits in ([the team
file](../team-file.md#delivery_order)). A team file that writes a word with no leg, an unknown
leg, or a leg twice is refused when the file is read.

A receiving Claude session's `socket` leg is the one implied default outside a declared word:
with no level of its chain declaring an order, a seat whose own launch declares
`crossSessionInbound: accept` is walked `socket` first, then the default order. For a seat
TeamCLI launched, that launch setting is the authorization on its own and the team file needs no
`inbound` line; a session launched some other way is dialed only when its team file also says
`inbound: accept`. An explicit team-file `hold` or `refuse` always keeps the socket out — the
documented opt-out — and a launch that says `hold`, `refuse` or nothing is never dialed. A frame
the receiver's box holds at its
dialog ends `held (socket)`: the signed record is already on disk, the walk falls through to the
next route with the same message id, and that seat's socket is not dialed again until the
declaration the hold sat under is re-confirmed, by its settings file being rewritten. The
hold's mark lives under the receiving team's state folder, outside the seat's drop folder, so
its reader never sees it as a message.

The `channel` leg is the second implied default outside a declared word, and the only one that is
never a declared word: with no level of the receiving seat's chain declaring an order, a Claude
Code seat whose own launch carries the development-channels flag naming the team server
(`--dangerously-load-development-channels server:team-inbox`) and whose live `.inbox-listener`
marker says `channel` is walked `channel` first, then whatever the rest of the order would have
been. The seat's own inbox server pushes one notification per record that arrives after it starts:
its content opens with the message-display header and carries the signed body whole, and its meta
names only identifiers — the message id, the sender, the seat and the team. The client draws its
own `← <server>: <summary>` wrapper over that notification, naming the server that pushed it, with
content too long for the pane elided; the wrapper is display, never part of the message. Nothing
is typed and no pane is read. The sender waits two seconds for the marker the server leaves beside
the record, `<id>.channel-push.json`; a marker for that id ends the walk `sent (channel)` (exit 0,
`via: channel`), and the `<id>.pending` marker beside the record says `leg: channel`. `sent
(channel)` claims only that the notification was written: the client acknowledges nothing at the
transport, so the push is not a read. The seat's handling turn calls the server's `ack` tool with
the id from the notification's meta, which writes the same signed `<id>.read.json` receipt as
`team ack`, with `read_by: channel`; a watch promotes that receipt once to `delivered (read)`,
clears the marker and types nothing.

A pushed message still without a signed receipt three minutes after the push is redelivered
exactly once: the watch writes `redelivered: channel unconfirmed` onto the marker before either
attempt, dials the seat's socket when the receiver accepts a frame, and otherwise — or when the
socket does not take it — types the ordinary trigger line. The history line records the redelivery
as `failed: redelivered: channel unconfirmed`. The marker carries that word, so no later pass can
redeliver the same push again, and an acknowledged record is never touched: a receipt that lands
after the redelivery settles the marker as read and types nothing more. A wait that sees no marker
inside its two seconds wrote a record nothing pushed: the marker is cleared and the walk moves on
with `failed: channel: no push receipt within <n> ms`, because this leg took nothing and no later
pass may redeliver a send whose own run is still walking the order.

A listener that runs another install is no route for the channel or the `mcp-inbox` leg: the
marker names the version, the entry build and the packed commit the server started from, and a
listener of another install cannot take a record this build signs, so the channel is not walked
and the `mcp-inbox` leg records `mcp-inbox: <the stale reason>` and moves on. The serving inbox
compares the install under it with the one it started from on every channel tick and after each
tool call; when they differ it removes its marker, starts the installed entry with the same
arguments and this process's stdio, and exits. A stale channel listener is still a running old
server and would push the record after the sender's own wake, so a sender whose walk holds a
waking leg — socket, native or typed — writes a marker with `kind: "channel-held"` at the push
marker's own name, `<id>.channel-push.json`, before its record. Any marker-aware serving server
skips an id that already holds a marker — a build older than this rule cannot honor it — and the
send's own wait never reads the held marker as a push: only the server's `channel-push` marker
ends it as `sent (channel)`. The watch's retry reserves the same name before its wake — on the
socket leg first, and again at the typed leg — whichever listener is there. That is the point: an
install can change between any check and the wake, so the name is held before the wake rather than
after a verdict that could already be stale. A seat whose launch no longer names the channel still
reserves while a listener started with the flag is alive, read from `.inbox-listener`; the marker
must name this seat, this session and this root, and its pid must be live. That fallback is one
process deep: the marker is last-writer-wins, so a newer non-channel server hides an older channel
server still running, and the older one can display the record once after the wake — a duplicate
notice, never a second record or id and never a second valid read receipt. A server started after
the record arrived pushes nothing, so a dead marker leaves no push to race. The retry's hold is not
cleaned up: a wake the seat never takes — the typed line is not submitted and the retry gives up,
or the pane never frees — leaves the channel push held too, and delivery falls to the record's own
read (`inbox_check`, the turn-start drop read, or `team messages`). The record stays in the inbox
throughout, so a held name never withholds the message.

The `mcp-inbox` leg writes the message whole into the seat's own inbox —
`<root>/.agents/send-drops/<session>/<seat>`, the same 0600 record the typed leg would leave —
and types nothing. It takes the send only when a server is serving that inbox: a marker
`.inbox-listener` beside the message names this seat, this session and this root, and its pid is
still running. A marker that is absent, malformed, dead, or names another seat, session or root
is no listener: the leg is recorded `mcp-inbox: no live inbox listener` and the walk moves on. A
live listener gets the message and a short wait — two seconds — for the receipt its `inbox_read`
call leaves at `<id>.read.json`. The receipt is `delivered (read)`: the seat read the message, and
the words claim nothing about what it did with it. A wait that ends without the receipt is
`sent (unconfirmed)`, exit 0 — the record is the message, safely on disk, and the walk ends rather
than typing into a pane the inbox was chosen over. A record beside the drop says which leg left
it. A receipt that lands after the sender has gone is promoted by the watch — one
`delivered (read)` history line, nothing typed — and a message still unread ten minutes after
the send is the fallback the wait promised: the watch types its trigger line, and that history
line's `sent (unconfirmed)` carries `failed: mcp-inbox: no receipt within 10m`. Ten minutes is the window
the native leg allows for a confirmation, so a live inbox never delays a message longer than the
frame path does. This build makes no socket write — a frame can land at a
busy session's held-message dialog, where the box is blocked — so a walk that reaches `native`
records it `unavailable`. The native leg is a call the sender's own process makes, so a walk
from the owner, or from a sender whose own file does not declare `cli: claude-code`, records it
`unavailable` too; a sender whose own file does declare it gets [the native
handoff](#the-native-channel) instead — one pending record, the exact target, the body and the
`--confirm` line — and makes the call itself. The typed leg types the rendered
`message-display` header and the fixed hint `Read it with: team drops --read.` — one printable
line of at most 80 characters, asking for the seat's own drop read, whose first act is the
signed read receipt beside the drop — and a receipt that verifies inside the window is
`delivered (read)`, the one word that line earns. Without one, a typed send ends `sent
(unconfirmed)` when the line has left
the seat's input box after that one trigger line and Enter — either herdr reported the seat
`working` (or `done` or `blocked`, and not the status read before Enter), or the transcript shows
the drop being read (a CLI's status can lag while it works) — and the pane was not a dialog this
command already classifies: question, permission, trust, vendor notice, provider error, or rate
limit. The console line carries
`trigger taken, no read receipt yet`, and the history line records the leg `typed` with the same
note: the trigger was sent, and no signed receipt has come back, so the message is never called
read. A box that cleared with no status or transcript evidence inside the window is also
`sent (unconfirmed)`, with the same note: the seat took the line, and the transcript or the
status is read for the sign that it acted on it — a taken line is never typed again. A screen
that is one of those dialogs is not reached. The report names the kind and the drop path, and
nothing further is pressed. The exit code of the typing commands is not the evidence. On herdr
0.7.1 the working status is the pane hint `ctrl+c to stop` for cursor, a spinner in the terminal
title for codex, and the `esc to cancel` footer for agy. A cursor pane narrow enough to wrap the
hint can submit while herdr stays idle; that run is reported sent as taken, never a failed send.
The drop leg never types: there the run ends `sent (unconfirmed)` once the signed record and its
marker are in place, and no box, status or transcript is read.

A seat whose live screen is its provider's usage wall is refused before the walk: no leg is
tried, no drop file or record is written, no socket frame is sent and nothing is typed, whether
or not the host still reports the seat working — a wall the screen proves holds on its own. The
line is `team send: refused: <seat>: quota out on <account>, resets at <time>; nothing was sent`
(exit 1, `send.refused`), with the reset exactly as the screen words it — `resets in <span>` for
a span — or `the screen names no reset time` when it words none. The wall is read only where
the CLI draws it, in the block directly above the composer: a sentence quoted inside a turn, or
one the pane has scrolled past, is not the wall, and the send walks its legs as ever. A pane
whose composer cannot be read falls back to the whole window, so a wall already held stays
held. The send daemon takes the same read at its queue: a walled seat is answered `refused`
with that detail, and no drop is staged and no worker started.

A seat the team file marks `human: true` walks the drop leg alone, whatever its delivery order or
the default says: every other leg — the typed trigger, the native frame, the seat's own inbox — is
skipped, each one's reason recorded on the history line, and the message arrives in the record
with the pane never touched and no frame sent.
`--wait` is allowed for such a seat: the record is written on its `drop` leg, nothing is typed,
and the run awaits a reply record on the thread. The watch types no retry or
nudge into a human's pane either: a held send's marker is given up on with the reason, and its
message waits in the record. A caller that reaches the send daemon directly is refused at its
queue for such a seat: no trigger is typed, no frame is sent, and no worker is started.

`team send --wait` writes the signed message record through the receiving seat's delivery walk —
its `mcp-inbox`, `drop` or `typed` leg, or `drop` alone when the seat is marked `human: true` —
and then awaits the first verified reply record on the thread ([team reply](reply.md)) until the
`--timeout` window (120 seconds by default, 1 to 86,400) closes. A reply record that arrives on
the thread inside the window ends the run `answered` (exit 0), printing `<seat>: answered` and
the reply's body on stdout, and writes the `replied` receipt beside the sent record. When the
window closes with no reply on the thread, the run ends `timeout` (exit 1):

    team send: claude-keeper: timeout: sent, no reply on the thread within 120s; the thread stays open

The thread stays open on a timeout, so a late `team reply <id> <text>` after the window still
lands on the thread and moves the record's status once to `replied`.

The socket frame — the channel the native leg will carry — is a measured observation of Claude Code 2.1.295, not a stable API: JSON
lines, one frame per line, a first-line deadline of 30,000 ms, and a buffer limit of 1,048,576
characters. A frame over that limit is refused, never truncated. The message's body is written
down: a run that ends `delivered`, `delivered (read)`, `sent (unconfirmed)`, `answered`, `held`,
`queued (receiver busy)`, `not-submitted`, `timeout` or `unreachable` appends one line
to the project's message history, which [team feed](feed.md) reads. The daily log keeps the seat and the sizes.

The outcome is always one of `delivered` (or `delivered (read)`), `sent (unconfirmed)`,
`answered`, `held`, `queued (receiver busy)`, `not-submitted`, `timeout`,
`unreachable` or `refused` — printed and matched by the exit code, or written as one machine-readable document
with `--json`. `--list` sends nothing: it prints the addressable seats — the file's own roster,
each seat's human name as its `@<nickname>` address (the name a seat signed standing where the
file's word did), and the seats of the other teams of the
caller's entity, each of those as `<seat>@<team>` (a human name there as `<nickname>@<team>`).
Broadcast is not in this build. Any seat's shell can run it — agy, grok, codex or claude — and it is the only path
by which one agent types into another seat's pane: agents do not send keys through herdr.

`team send --record <seat> --channel native --ms <n>` writes down a native delivery made without
a handoff — a sender that dialed the address itself, or a caller of an older CLI: it delivered
with its own cross-session tool, and this writes that delivery down. Nothing is
delivered here — no record, no frame, no pane — and no socket is opened or dialed; the one
effect is one history line, `outcome: delivered` with `via: native`, carrying the span the sender
measured itself in `--ms`. The recipient's record and admission are judged exactly as a plain
send's, so a recorded delivery is never a way around the rules — only around the transport;
`--channel` takes `native` only, `--wait` and `--timeout` are refused beside it, and the body is
optional: given, it is recorded verbatim, and without it the line says the text did not pass
through this CLI. Exit 0 prints `<seat>: recorded (native, <n> ms)` (`status: recorded`), and a
record that cannot be written is a refusal, because nothing is claimed to have been delivered.
[The native channel](#the-native-channel) below is the one-step path a sender of this build
takes — the handoff, its exact target and the `--confirm` line that records it; [team
route](route.md) answers the address and the rule beside it.

## Synopsis

    team send <target> <message> [--subject <text>] [--wait] [--timeout <s>] [--json] [--dry-run]
    team send <target> --file <path> [--subject <text>] [--wait] [--timeout <s>] [--json] [--dry-run]
    team send <target> --brief <path> [--subject <text>] [--wait] [--timeout <s>] [--json] [--dry-run]
    team send --confirm <id> [--json] [--dry-run]
    team send --record <seat> --channel native --ms <N> [<message>] [--json] [--dry-run]
    team send --record <seat> --channel native --ms <N> --file <path> [--json] [--dry-run]
    team send --list [--json]

`<target>` names whom to reach: a seat of the caller's own team, or one of the registry forms
under `Addressing` below. The message
is every remaining word, joined with single spaces; `--file` reads the whole body from a file
instead (and then takes no message words), and `--file -` reads it from standard input. A seat
that has both a message and `--file` is a usage error. A command-bearing or multiline body —
code, a log, a brief — is safest from a file or a pipe: the shell can rewrite an inline
message, while a single-quoted argument is passed through unchanged. `--brief <path>` is the
same read for a draft brief (`--brief -` reads standard input too): the whole file becomes the
body, and it takes neither message words nor `--file` beside it — either pairing is a usage
error. A body, inline or read, that is nothing but a path to a `.md` file under a `briefs/`
folder is a pointer, not a brief: the send warns on stderr, naming the pointer and asking for
the brief itself — with `--brief <file>` or its text in the body — and still sends exactly what
it was given. A prose body that merely mentions such a path draws no warning. A multiline body
that looks like terminal output — two or more lines starting with a check mark or a bracketed
number — is warned about on stderr and sent unchanged. `--subject <text>` writes one display
line beside the body: it fills the `{subject}` slot of the `message-display` template ([the
message-display wake line](#the-message-display-wake-line)) and never stands in for `{summary}`,
which is always the body's own first content line. The subject is sanitised like every other
display field, a blank word is no subject at all, and it is not part of the body the receiver
reads. `--brief` reads
the receiving team's `brief-transport` before it writes anything: `file` and `message` both send
the whole body as an ordinary send, while `memory` refuses the send (exit `send.brief-memory`,
1) — no drop, no state or history line, no fallback — because no runtime in this build proves
that transport keeps nothing on disk. An ordinary send that names no brief never reads the policy. `--timeout` is a
whole number of seconds, 1 to 86,400, and is only meaningful with
`--wait`; without it a wait runs 120 seconds. `--json` prints one document instead of the lines: the action surface and the outcome in one —
`{format, dry_run, status, action_summary, project, session, seat, channel, ids, thread?, reply?, plan?, delivery?}` —
where `ids.sent` is the id of the message this command composed and `ids.reply` the reply
record's own, when there is one (`thread` is the thread id on an answered wait); `channel` is the leg that took it, `null` on a dry run, and
`plan` is the dry run's own step; a handoff's document also carries the exact `to:` target, the
`confirm` line and the body the sender's own call carries. `delivery` is the resolved walk's
legs, in order: a real send marks each `attempted` (its transport was reached, with a `reason`
when the transport did not take the send), `queued` (the seat's lock is another command's, so the
leg stored the record and its marker for the delivery that follows when the seat is free),
`skipped` (a rule kept it out, with the `reason`),
`refused` (a rule ended the walk, with the `reason`) or leaves it `not-reached` (the walk ended
before it), and a Claude receiver whose files keep the implied socket default out gets a
`skipped` socket entry naming the word that did. `--list` prints its own document —
`{format, project, session, seats, summary}`. A run that exits 1 or 2 writes the structured
error document instead — `{error: {id, message, repair}}` — and stderr stays empty; a send that
resolved its walk carries the same `delivery` list on that document.
`--dry-run` resolves the seat and names the channel its walk would take — the first leg it can
walk and the fallbacks behind it, in order, with `native` left out while no socket write is
made: `the seat's own MCP inbox, falling back to a 0600 drop file and one trigger line, then a
0600 drop file, with nothing typed into the pane` for a plain send today, the native handoff
then that chain for a sender whose own file declares Claude Code and a receiver whose order
adds `native`, and only an order that keeps no leg this build can walk prints `no leg of its
delivery order this build can walk`. Under `--json`, its `delivery` lists every leg of the walk
as `candidate` (with `eligible: true`) or `skipped` (with `eligible: false` and the `reason`),
including the implied socket leg a Claude receiver's files do not let the walk dial, so an
omitted socket always carries its reason. It
writes no record, dials no socket, types nothing and appends no line to `.agents/team.log`: a
dry run writes nothing, and the log records writes.

## A client's bundle send

`team send --client <grant-file> --key <client-key> <seat>@<team> <text>` is also the send of a
**bundle grant** that carries `send` (`team grant --client <id> --team <team> --bundle operator
--seat <seats>`, see [Client grant bundles](../concepts/client-grant-bundles.md)). The address is a
seat the owner's signed list names, at the one team the grant binds; any other seat, the operator's
seat, a human seat, a seat the team's approved `clients:` list no longer admits, or another team is
refused. The drop is the same signed record a one-seat client send writes. The request id is used
once. `client-send-authorized: grant <cg_id> client <client-id> team <project> seat <seat> drop
<id> request <rid>` (or `client-send-refused: …`) goes to `<root>/.agents/team.log`. An observer
bundle does not carry `send` and is refused.

## Addressing

| Target | Names |
| --- | --- |
| `agt_<12 hex>` | one agent by its id, from the agent registry |
| `<seat>@<team>` | a seat in a named team — whoever its registry record holds now; `<team>` is a team id, a project or a session |
| `<nickname>@<team>` | the seat that human name belongs to, in a named team — a nickname confers nothing: its seat talks and is judged by its own record |
| `lead@<team>` | the team's lead: the seat its file names as lead — the `leads: true` mark, or the legacy `coordinator:` key a 0.3.5/0.4 file still writes — never a seat merely named `lead`, and never a role's word. A team the file and the roster name no lead of is refused — there is no one to deliver to; a roster marking two leads is refused naming both |
| `@<nickname>` | the seat carrying that human name: the caller's team first, then the other teams of the caller's entity (from a folder that is no team, every team the registry holds). Exactly one match sends; several are refused, each named by the `<nickname>@<team>` spelling that picks it; none is refused, pointing at `team send --list` |
| `<seat>` or `<nickname>` | a seat of the caller's own team, by its name or its human name. From a folder that is no team, a bare name is refused with the forms that need none — never a `team init` suggestion |

A role is never an address: `coordinator@api` names nobody even when a seat of that team holds
the role `coordinator`. Every form resolves to one seat's registry record before any rule runs,
and the admission rule judges that record's seat — a nickname added or removed never changes who
may reach whom. A spec that two entries answer — one seat's name and another seat's nickname of
the same team — is refused naming both and sending nothing. A `lead@<team>` naming a roster that
marks two leads is refused the same way. A roster that marks none is read from the team's file,
whose `leads` mark or legacy `coordinator:` key names its lead; only a team whose file names no
lead either is refused, because there is no one to deliver to, and the refusal names both
repairs: `team send --list` to name a seat, or `leads` on one seat to give the team a lead.

`lead` is reserved for that address. A file written before 0.5.0 may still declare a seat of the
name: it loads, answers its bare name in its own team, and `team check` notes it — its repair is
`team rename lead <new-name>` — while `lead@<team>` always reaches the seat its file names as
lead. No new seat and no nickname may take the word.

A nickname is unique inside its team, and two teams may share one: `@<nickname>` asks the
caller's own team first and then the entity's other teams, and a name more than one of them
answers is refused with each address that would pick one. A `<seat>@<team>` or
`<nickname>@<team>` resolves through the named team's roster only; when the roster has no line
for it, the agent records are asked by the same seat name, so a registry whose roster has not
caught up still addresses the seat.

A seat's signed `nickname` ([team settings](settings.md)) stands where the roster's projection of
the file's word did, for every address above and for the `--list` row: the word the record
replaced addresses nobody, and a record that does not verify signs no word, so the file's own word
keeps addressing the seat.

The registries — `~/.config/team/agents/<id>.yaml` and `~/.config/team/teams.yaml` — are the
address. The live herdr read is the fallback for a record that carries no pane yet, by the seat's
name in the record's session. A plain seat the registry cannot answer keeps the declared-seat
path: the caller's team file and its placement rules. A spec that names nobody is refused, and
the refusal names what was not found. A target in another team is reached directly, and its drop
lands under that team's own `.agents` — full addresses work from any folder, a folder that is no
team included; only a bare name needs one. `--list` prints a target in another team in the same
spelling, `<seat>@<team>`, for every seat the registry holds there, and a human name as
`@<nickname>` in the file's own roster and `<nickname>@<team>` in another's. A listed row parses
as it stands; whether this caller may send to it is the admission rule's answer, judged when the send
runs. An agent's id is assigned once and never reused; its name is display only
([the registries](../concepts/registry.md)).

A history line keeps the address beside the seat it resolved to: when the caller wrote a form
rather than the seat's own name — a `@<nickname>`, a `<nickname>@<team>`, `lead@<team>`, an agent id — the
line adds `spec`, the address exactly as written, and `resolved`, the seat's registry id
(`agt_…`). `to` is the seat either way. A plain seat of the caller's own team names itself, and
its line carries no `spec`.

## What it reads and writes

Reads the team file, the caller's placement, the agent registry, and the herdr session's
agents. A plain send writes `.agents/send-drops/<session>/<seat>/<id>` (the file mode 0600): one
signed record, carrying the body, both registry ids, the admitting rule and the thread; the
receiver's `team drops --read` or its inbox's `inbox_read` writes a signed status receipt beside
it (`<id>.<status>.json`), and the status is read from those receipts, never edited. A send whose
walk reaches the typed leg types one trigger line into that seat's pane, reads the pane back
before Enter to check the composer holds that line, and reads it again after Enter. `send-drops`, the session directory, and the seat directory are each mode
0700. This command never deletes a delivered record; the owner removes `.agents/send-drops` when
those messages are no longer needed. A native handoff types nothing and writes no trigger: it
writes the same signed record into the seat's folder and one pending record to the caller's own
project state (`<config dir>/team/<project>-<hash>/pending/<id>.json`, mode 0600, a temporary
file renamed into place), and `--confirm` takes that record before it writes the one history
line and then clears it. A waited send writes the signed record through the receiving seat's
delivery walk, releases the seat lock, and watches `<root>/.agents/send-drops/<session>/*/` for
the first verified reply record on the thread (`payload.thread === record.thread`).
The command holds the seat's lock (`<state dir>/seat-locks/<session>/<seat>`) around a
send's write, so a launch of the same seat cannot act beside it and two sends cannot type into
one pane at once. It
writes one line to `.agents/team.log` — a refusal writes its own line there — and appends the
message's body to the project's message history
([team feed](feed.md)) when a send completes. The history line names the channel the send went by,
when one took it (`via`), and the legs of the walk that definitely could not take it (`failed`,
each as `<leg>: <reason>` — `native` is recorded `unavailable` there in this build unless the
handoff takes the send, and `mcp-inbox` `no live inbox listener` when no server is serving the
seat's inbox). The line also carries `thread`, the first message's id, and `in-reply-to` when
the message answers one, so [team feed](feed.md) reads a thread's status from the receipts
beside its records. The daily log keeps the
seat and the size; the
history keeps the message.

## Who may send to whom

Send is denied by default: a caller reaches exactly the targets below, and anything else is
refused before the seat is looked up. A seat the registry holds no record for is judged as the
seat the live file declares for it, so the rules above reach it by that seat's name and role — the
bootstrap a seat herdr placed, before `up` or `add` first recorded it, still needs — and nothing
else does: a target in another team, and an owner-signed grant, both wait for its record. `up` and
`add` register a seat when they first launch it. A run with no
terminal is refused before `--list` as well: `team send: only the owner or a seat the send admission
admits runs this, from a terminal outside herdr or its own pane`. `--request` records the send for
the owner seat instead, and `--approval` runs the signed answer once; an always rule for `team-send`
covering this folder admits it with no request. The owner answers on the owner page. For every other caller, `--list`
prints the file's roster and the seats of its entity's other teams, and sends nothing, so it needs
no caller check.

| Caller | May send to |
| --- | --- |
| the owner | any agent |
| an orchestrator | an orchestrator of its own team or entity |
| a team's orchestrator or operator | any seat of its own team |
| a seat whose line writes `role: operator` | another such seat of its own team |
| an assistant seat | its entity's main coordinator |
| any seat | its own team's orchestrator |
| a caller an owner-signed grant names for `send` | what the grant names |

A team's leads brief its own seats directly; another team's seats are reached through that team's
orchestrator, or by an owner-signed grant naming the pair.

The operator pair is the one rule that reads a role's word: two seats of one team whose file
writes `role: operator` on their lines may write to each other, and to each other only. It is not
the operator place above — that place is a seat the file names, and reaches every seat of its team
on its own — and the word is no lead, no assistant and no reach anywhere else. The pair never
crosses teams: another team's operator is reached through that team's orchestrator or a grant. A
send between them is admitted, written down and logged exactly as any other: the header names the
rule and the history line lands in the receiving team's store.

An assistant seat is the seat its file marks `assistant: true` — a place in the chain and a
capability, never a role's name: the entity's assistant is the first mark found walking its teams
in chain order, the entity's own team first and then its other teams by team id, so an entity
whose files mark none has no assistant for the rule to admit.

Which seat leads a team — the seat these rules call its orchestrator — is read the same way: the
lead the file declares, by the `leads: true` mark or the legacy `coordinator:` key a 0.3.5/0.4
file still writes, carried onto the record's roster line as `leads: true`; a registry written
before the mark existed is answered from the file. A role word admits nothing else, in any
language: a seat called `orchestrator`, or one whose role is written `coordinator`, leads nothing
without one of those two places — the operator pair above is the one decision a role's own word
makes.

An owner-signed grant is a record in the owner's grants folder (`~/.config/team/grants/`, the
same folder the standing create-grants live in), naming the pair it admits and when it stops:

```text
send:
  from: builder-1@labs      # the sender: its agent id, seat@team or session/seat
  to: lead@teamcli          # the receiver, in the same spellings; a bare seat is the sender's own team's
expires: "2026-10-17T00:00:00Z"
```

The record is read only once the rules above have refused, and it admits the send only when its
`from` names the caller's own agent record — a grant naming another agent never admits this
caller — its `to` names the receiver, and `expires` is still ahead. A record that fails any of
those, or a symbolic link, is not a grant: the send is refused as if the folder were empty.

## The client send

`team send --client` is the one send a client grant admits. The grant is the owner's, the request
is signed with the client's own key, and the destination is the entity's orchestrator —
`orchestrator@floor` is the only address this build admits. The request id is used once, and the
drop is written under the grant lock after the grant, the key, the registry binding and the
request's target are read again. The record keeps the client's own principal: `from` is
`client:grok-bot`, `from_id` is null, and `from_client` carries the client id and the grant id.

Writing that drop is the message. The same signed record is then carried through the coordinator
seat's resolved delivery order, restricted to the legs a client grant has — its own inbox channel,
the cross-session socket, and the typed trigger — so a seat in the middle of a turn can take the
message. With no declared order the walk is that order: channel, then socket when the seat's
launch declares `crossSessionInbound: accept`, then typed. A level that declares an order is
walked as written. The drop, native and headless-resume legs are never walked here: the drop the
grant wrote is already the durable copy, and the other two belong to the seat's own runtime.

Every leg keeps its ordinary pane-safety checks. A human's pane is never dialed or typed into, a
bare shell is never typed into, and a held frame keeps the socket out until the seat's
declaration is re-confirmed. No leg writes a second record: each write accepts the record at the
same id, and a frame the socket takes writes its one signed read receipt beside it. The frame
names its sender `Message from Grok Bot (owner)`, with the owner's reply target as its reply
line, so the receiving seat reads a person's message and not a seat address. The walk's ending
never changes the invocation: the drop is on disk, the confirmation already printed, and the
client's two streams carry only their own lines. A leg's reason is recorded in the receiving
team's log and history.

The client's side of a thread — reading the seat's answers — is
[`team messages`](messages.md) `--client`.

## The native channel

When the recipient's CLI carries the cross-session channel and the sender's own file declares
`cli: claude-code`, `team send` turns the native leg into a handoff, so a native send is one call
and its receipt, never a separate record the sender has to remember: the run resolves the
recipient live, admits the pair exactly as a plain send's is admitted, writes the message down as
one pending record, and prints the exact `to:` target the sender's own SendMessage takes, the
body that call carries, and the one line that records the delivery. The sender makes the call,
then runs the printed `team send --confirm <id>`; that writes the one history line (`outcome:
delivered`, `via: native`, the span from the handoff to the confirm) and clears the record.
Nothing was delivered by the handoff itself, so it exits 0 with status `native`, and the confirm
is the receipt. A confirm is judged as the handoff was: the pair, the body and the address are
the record's own, only the sender that printed it may confirm it, and the record is taken before
the line is written, so a second confirm finds none. The confirm reads the visible 40 lines of
the recipient's pane for the handoff's nonce (`nv-<8 hex>`): when that window shows the nonce it
records `delivered`, and when the nonce is absent — or has already scrolled off that 40-line
window — it records `sent (unconfirmed)`. A handoff that goes unconfirmed past ten minutes is
expired by a running `team watch` on the sender's team, which claims the pending record and walks
the remaining legs of the recipient's `delivery_order` (`native: unconfirmed after 10m`); without
a running watch, an unconfirmed record does not fall back and is swept after 24 hours. A handoff
that cannot resolve the recipient's live pane or its socket falls back to the typed drop like any
other miss, and the history line names `native: <reason>` among the failed legs; a pending record
that cannot be written is a refusal, so an unrecorded native send is never the easy path.

[team route](route.md) answers the same pair's rule and the recipient's live pane, and records
that it handed the address out. Its `session` line is the herdr session the seat runs in — never
a SendMessage target: the target is the `to:` line the handoff prints, the socket path in the
form the cross-session tool takes.

A team's `rules:` carries the handoff as one item, quoted here for the owner to paste — no team
file ships with it, and this repository never writes one:

> - Deliver to another seat natively when `team send <seat> <message>` answers with a native
>   handoff: make your own cross-session SendMessage to the `to:` line it prints, with the body
>   it prints, then run the `team send --confirm <id>` line it prints — and never also send that
>   message by the typed path. Fall back to plain `team send <seat> <message>` only on a definite
>   failure, the handoff refused, the seat not Claude's, or your SendMessage call itself failed or
>   reported no such session; a call that returned delivered the message, so confirm it and never
>   send it again however long an answer takes, and a delivery is recorded exactly once, by the
>   path that delivered it.

Only a definite failure falls back: a missing, slow or absent answer is not a delivery signal, and
the plain send that does fall back builds admission from the same records `team send` judges with,
so it cannot deliver what a refusal refused.

## The sender header

Every record's body opens with a header, and the record's payload carries the same facts apart:
the sender's seat and its agent id, and the reach above or the grant that admitted the send. The
header itself carries no id: it names the sender as the receiving team's
[`sender_name`](../team-file.md#sender_name) word asks — the nickname inside its own team, and
`seat@team` from another under the default — and the owner's reads `from the owner`. A sender the
registry holds no record for is spelled as the file's seat instead — `from the file's seat <name>
(no registry record yet) — admitted by: <rule>` — so a receiver reads why the id is absent. A handoff prints the body with
that header, so the sender's own call carries it too. A waited send's frame opens the
same way, and so
does the body the message history keeps. The receiver reads who sent a message and why that sender
was let through; the record carries the sender's ids from day one.

## The message-display wake line

A message a typed leg or a watch announces opens with a header the `message-display` policy
renders. The policy is a signed, enforced setting at the entity and team levels and has no team
file field: the entity's default stands until a team writes its own value, and the team's value
wins. The shipped default is

    Message from {name} ({seat}@{team}): {summary}

A template may carry seven placeholders and no others; a value naming any other word is refused
when it is saved, and the refusal names the placeholder:

| Placeholder | What it renders |
| --- | --- |
| `{name}` | the seat's nickname, or its seat name when the file holds no nickname — a header is never hollow |
| `{seat}` | the seat's own name |
| `{team}` | the team's name |
| `{subject}` | the sender's [`--subject`](#synopsis) line, sanitised like every field; empty when none was written |
| `{summary}` | the body's first content line, sanitised and then cut at 80 characters — never paraphrased, and never the subject |
| `{age}` | how long the message has waited: seconds, minutes, hours or days |
| `{id}` | reserved for the record's id; this build's typed lines and frames leave it empty, because the id travels in the socket frame's `msg_id` only |

Every field is data: control characters, escape sequences and line breaks are neutralised, so a
rendered header is one printable line. A body line that forges a sender header stays summary
text and never becomes the header.

On an agent seat the typed wake is the rendered header, one space, and the fixed sentence
`Read it with: team drops --read.` The whole typed line is one printable line of at most 100
characters; the hint is kept whole and the header gives way to it. The template cannot remove
the hint — an agent seat always learns where to read the signed record — and the message's id
is not in the line.

The socket frame an agent seat receives carries the rendered header, the full body, and the
fixed reply line, `Reply with: team send <address> "…"`. A person-pane seat's frame carries the
header and the body and neither the reply line nor the read hint: a person answers in the
client, and the line is never shown to an agent.

A running watch uses the same header to ring for the oldest waiting message, and it does not
ring when nothing waits.

## Outcomes

Every run that reads a team file opens on stdout with one context line,
`team <project>, session "<session>"`, before the outcome line or table; a refused run prints its
line on stderr and has none.

| Outcome | Exit | Printed |
| --- | --- | --- |
| delivered | 0 | `<seat>: delivered` on stdout, or `<seat>: delivered (native, <n> ms)` when a `--confirm` run finds the handoff's nonce in the recipient's transcript |
| delivered (read) | 0 | `<seat>: delivered (read)` on stdout, for a signed read receipt — the mcp-inbox leg's, the channel's ack, the typed leg's own `team drops --read`, or the drop leg's watcher read: the seat read the message, which is not a claim that it acted on it |
| sent (channel) | 0 | `<seat>: sent (channel) (<n> ms)` on stdout, for the channel leg: the seat's own inbox server wrote the push notification and its `<id>.channel-push.json` marker, and the record's pending marker waits for the seat's signed receipt; the client acknowledges nothing at the transport, so this line is never a read |
| sent (unconfirmed) | 0 | `<seat>: sent (unconfirmed) (mcp-inbox, <n> ms)` on stdout, for the mcp-inbox leg: the message is the signed 0600 record in the seat's inbox, no receipt came back inside the grace, and nothing was typed |
| sent (unconfirmed) | 0 | `<seat>: sent (unconfirmed) (drop, <n> ms)` on stdout, for the drop leg: the message is the signed 0600 record and its `<id>.pending` marker in the seat's drop folder, no receipt has come back yet, and nothing was typed; the seat's own read promotes it to `delivered (read)` later |
| sent (unconfirmed) | 0 | `<seat>: sent (unconfirmed) (typed, <n> ms; trigger taken, no read receipt yet)` on stdout, for the typed leg: the trigger line left the seat's input box, and no signed receipt has come back, so the message is not called read |
| queued (receiver busy) | 0 | `<seat>: queued (receiver busy) (<leg>, <n> ms; id <id>)` on stdout, when another command holds the seat's lock: the leg named on the line wrote the signed record and its marker without typing, and the delivery follows when the seat is free — the id is the one it keeps |
| answered | 0 | `<seat>: answered` and the reply on stdout |
| held | 1 | `team send: <seat>: held: <reason>` on stderr, or `held (socket)` when the socket's frame is what the dialog keeps |
| not-submitted | 1 | `team send: <seat>: not-submitted: <reason>` on stderr, naming what the box holds |
| listed | 0 | a `SEAT  NICKNAME  ROLE  PROJECT  REACH` table, one row per seat, then `<n> seat` or `<n> seats` on stdout; `NICKNAME` is `-` without one, `@<nickname>` for the file's own seats and `<nickname>@<team>` for another team's, the word a seat signed standing where the file's word does, and a seat of another team of the same entity reads `<seat>@<team>` in `SEAT` |
| recorded | 0 | `<seat>: recorded (native, <n> ms)` on stdout, for a `--record` run |
| native | 0 | `<seat>: native: nothing was sent; make the call with your own SendMessage, then record it`, then the `to:` target, the body and the `team send --confirm <id>` line, on stdout, for a handoff |
| sent (unconfirmed) | 0 | `<seat>: sent (unconfirmed) (native, <n> ms)` on stdout, when `--confirm` runs before the recipient's transcript shows the handoff's nonce |
| timeout | 1 | `team send: <seat>: timeout: sent, no reply on the thread within <s>s; the thread stays open` on stderr |
| unreachable | 1 | `team send: <seat>: unreachable: <reason>` on stderr |
| refused | 1 | `team send: refused: <reason>` on stderr |
| usage | 2 | `team send: <message>` and the usage on stderr |
| configuration | 2 | `team send: <message>` on stderr |

A running watch retries a `held`, `not-submitted` or dialog-stopped send once the seat is idle,
up to three tries in thirty minutes; the line the send printed tells the sender so, and a retry
that stops says where the message is. A retry never types into a pane back at its shell — the
seat's CLI has exited, so it is given up with `the seat is back at its shell; nothing was typed`
and the record stays. A message the `mcp-inbox` leg left is not retried on that
schedule: a receipt promotes it once the seat's client reads it — one `delivered (read)` history
line, nothing typed — and a message still unread when the ten-minute fallback window ends is
handed to the same retry, which types its trigger and says on the history line which leg's wait
ended (`failed: mcp-inbox: no receipt within 10m`). A message the `drop` leg left is never
typed, on that schedule or any other: its marker waits for the seat's own signed receipt, and
thirty minutes after the send it is given up on with the drop file's path, so a message no
watcher read is never silently lost. A typed `sent (unconfirmed)` send is never retried: the
seat took the trigger line, and a running watch reads the transcript and the status on its later
passes for the sign that it acted on it. A sign confirms the delivery silently; a seat that
sits free for a minute past the send, or a record thirty minutes old, with no sign at all, is said
once — `<seat>: a send from <sender> was taken but never acted on`, with the record's path —
and one more history line keeps it. Even then the line is never typed again.

Under `--json` the same outcomes are one document: the action surface for a send, the roster
document for `--list`, and the structured error document for an exit 1 or 2 — `error.id` is the
outcome's own (`send.refused`, `send.not-submitted`, …), `error.message` the text the plain run
prints without its `team send: ` prefix, and `error.repair` a way out when there is one. Exit
codes are the outcome's: 0 when delivered, delivered (read), sent (unconfirmed), queued
(receiver busy), answered, listed, recorded, or resolved by
`--dry-run`, 1 when held, not-submitted, timed out, unreachable, stopped, or refused, 2 when the
invocation or team file can't be read.

`answered` and `timeout` belong to `--wait` on the thread: `answered` when a verified reply
record on the thread arrives within the window, and `timeout` when the window closes with no
reply on the thread (leaving the thread open). `held (socket)` stays for the socket write's
return.

`held` is nothing sent: the message is safely on disk — or, on the socket's path, in the frame the
receiving session's held-message dialog keeps for a person to let through — the run exits 1, and
the reason it prints says what held it. A socket write the dialog keeps is `held (socket)`, and
nothing is typed into the blocked box while the dialog stands.

One hold writes nothing at all. When the recipient has a signed registry record and its pane
names a model or version other than the record's, the run is `held` before the body is read and
before any leg is walked, with `model drift: <recorded> vs <running>`: nothing is written on
either side — no signed record, marker, drop or draft — and nothing is typed or dialed; the hold
itself is one `team.log` line. No watch retry owns it, because there is no drop to retry. The way
out is to repair the seat: `team restart <seat>` relaunches it through the launch line its
registry record keeps, under the restart's own rules (the restart is the owner's or a lead's to
run, and a seat mid-turn is not interrupted), and the sender sends again.

Unsent text does not hold the delivery. When the CLI's profile carries a measured `input`
surface — clear keys, an optional
mid-turn key, bracketed paste — the text is copied beside the drop file (`<drop>.draft`), the box
is cleared with the profile's keys (the mid-turn key while the seat is working, never the
interrupt key), the trigger is typed and pressed Enter, and the text is pasted back exactly, its
row unchanged. A box drawn over more than one row is never copied: the composer word-wraps a long
line over continuation rows at the same indent a person's Enters draw, so the screen cannot tell
a soft wrap from a newline, and a wrap copied row by row would come back as line breaks the person
never typed. A copy already beside the drop holding different text is
never overwritten: the run holds and names it. Where the CLI has no measured keys, the box cannot
be copied faithfully (a fold marker, a paste chip, a box drawn over more than one row, a row the
reader cannot read), the mid-turn key
is missing, or the box will not empty, the run holds before typing anything (`the composer
already holds unsent text…`), and the reason says why. The run's receipt says where the text went
(`the unsent text was pasted back`, or `...; its copy is at <path>`), and a not-submitted run puts
the text back before saying so. A typed run that took the line puts it back too, even when the box empties only
after the Enter's 400 ms leave check — or when that one read fails: the restore is attempted
before the run reports the delivery, and a box that cannot be read then is given the paste's
two-second window first. The trigger line is what the composer
is read back for: before Enter the run checks the composer holds it, and a composer that does not
takes no Enter (`the composer read-back did not match the trigger`); the trigger line is the
only text a second Enter is ever pressed for.

`not-submitted` is a line typed and never taken: the message is on disk, the run exits 1, and the reason names the Enters
pressed and what the input box holds (`the box holds "…"`, `the box is empty`, or `the box could
not be read`); under `--json` those words travel in the error document's `message`. The
box is read with its styling (`herdr pane read --format ansi`), and faint text — a suggestion or a
placeholder — counts as an empty box: it is never waited on, never cleared and never a reason for
an Enter. After Enter the run verifies two things: the trigger has left the box, and either herdr reports
the seat working (or a `done` or `blocked` that is new) or the transcript shows the drop being
read — a row that names the drop's id and is not the echo of the trigger line, such as `Explored 1
file (<id>)`. herdr's status can lag or stay idle while a CLI works, so a box that has cleared is
waited on for up to 20 seconds in all before the run stops waiting. A try that shows neither is
followed by a re-read, and another Enter goes only to a box that still holds exactly the trigger
line — never to an empty one, to one that holds something else, or to a dialog — at most three
Enters in all, waiting 1, 3 and then 9 seconds for the seat to show it. After the last Enter the
box itself decides: a trigger still in it was not taken, and the run is `not-submitted`; a box
that no longer holds the trigger — empty, or holding other text — took the line, and the run is
`sent (unconfirmed)` with `trigger taken, no read receipt yet`. A box that cannot be read keeps
the first Enter and is judged by herdr's status alone, and no other Enter goes to it: with no
evidence and no box to show the line left, that run is `not-submitted`. A seat that was already
working before Enter
proves nothing by its status, and a status that moved under a dialog counts for nothing: only the
transcript can show that seat took this line. An unverified send writes one line to `team.log`
for the orchestrator.

`unreachable` is the seat not reached: no live agent of that name when no leg stands behind the
typed one, a screen that is one of the
dialogs listed above, the held-message dialog — the sentence on a screen with no live composer to
read — or a pane that would not take the trigger, and a walk that ran out of legs is unreachable
too, printing `no leg of its delivery order took the send` with the legs that failed. `timeout`
is a waited send whose record was written and whose window closed with no reply record on the
thread; the thread stays open. `refused` is nothing
being sent on purpose: an unknown seat (the file's seats are named), a frame over the
socket limit, a trigger longer than the measured line, a lock another command holds on a compose
seat (its walk has no queued leg), or a caller that may not send.

## Examples

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
    nickname: agamemnon
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: reviewer
    name: gpt-reviewer
    label: reviewer
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex -m gpt-6-sol

  - role: implementer
    name: claude-scribe
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    delivery_order: [native, typed]

  - role: operator
    name: operator-a
    label: operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: operator
    name: operator-b
    label: operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

A plain send walks the default order — the seat's own inbox, then the typed trigger, then its
drop folder. No server serves this seat's inbox, and its pane is free, so the signed record
lands in its drop folder and the trigger is typed over it; the seat's own read hands it the
message and writes its receipt, which a running watch records as one `delivered (read)` history
line. Until that receipt comes back the line is `sent (unconfirmed)` with `trigger taken, no
read receipt yet`.

```console
$ team send claude-keeper "the gate is green" ; echo "exit $?"
team beacon, session "beacon"
claude-keeper: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)
exit 0
```

Two seats of one team whose lines both write `role: operator` write to each other — the one rule
a role's own word decides, and it never crosses teams. The send is admitted, delivered and logged
like any other:

```console caller=operator-a
$ team send operator-b "the handover is ready" ; echo "exit $?"
team beacon, session "beacon"
operator-b: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)
exit 0
```

A sender whose own file declares Claude Code, to a receiver whose delivery order adds `native`
(`delivery_order: [native, typed]` on its seat), gets the record written and the native leg
handed back to it — the exact target, the body, and the one line that records the delivery.
The sender makes the call with its own SendMessage, then runs the printed line.

```console caller=claude-keeper
$ team send claude-scribe "the draft is ready for review" ; echo "exit $?"
team beacon, session "beacon"
claude-scribe: native: nothing was sent; make the call with your own SendMessage, then record it
to: uds:~/cc-socks/4200.sock
message:
from the file's seat claude-keeper (no registry record yet) — admitted by: an orchestrator or operator to a seat of its own team [nv-22222222]

the draft is ready for review
team send --confirm 22222222-2222-4222-8222-222222222222
exit 0
```

The confirm checks the recipient's transcript for the handoff's nonce (`nv-22222222`), writes the
one history line (`delivered` when the transcript shows the nonce, `sent (unconfirmed)` otherwise)
with the span from the handoff to the confirm, and clears the pending record. A second confirm
finds none:

```console caller=claude-keeper
$ team send --confirm 22222222-2222-4222-8222-222222222222 ; echo "exit $?"
team beacon, session "beacon"
claude-scribe: delivered (native, 0 ms)
exit 0
$ team send --confirm 22222222-2222-4222-8222-222222222222 ; echo "exit $?"
team send: refused: 22222222-2222-4222-8222-222222222222: no pending native record holds that id; nothing was recorded
exit 1
```

`--wait` writes the record on the seat's delivery walk and waits on the thread for the first
verified reply record:

```console reply="the gate is green"
$ team send claude-keeper "is the gate green?" --wait ; echo "exit $?"
team beacon, session "beacon"
claude-keeper: answered
the gate is green
exit 0
```

A dry run of the same send names the walk and writes nothing:

```console
$ team send claude-keeper "is the gate green?" --wait --dry-run ; echo "exit $?"
team beacon, session "beacon"
claude-keeper: dry-run: claude-code via the seat's own MCP inbox, falling back to a 0600 drop file and one trigger line, then a 0600 drop file, with nothing typed into the pane; nothing was written
exit 0
```

`--list` prints the addressable seats — the same roster `team status` reads — each with the
project its team sits in: the registry's grouping when the machine has one, the file's own
`project:` name otherwise. A seat whose file writes a `nickname:` carries that human name in
`NICKNAME` as its `@<nickname>` address, and `-` where it writes none.
The other teams of the file's entity follow, their seats spelled `<seat>@<team>` and their human
names `<nickname>@<team>`; this fixture world holds one team, so the rows below are the file's
own. It sends nothing:

```console
$ team send --list ; echo "exit $?"
team beacon, session "beacon"
  SEAT           NICKNAME    ROLE         PROJECT  REACH
  claude-keeper  @agamemnon  coordinator  beacon   socket
  gpt-reviewer   -           reviewer     beacon   typed
  claude-scribe  -           implementer  beacon   socket
  operator-a     -           operator     beacon   socket
  operator-b     -           operator     beacon   socket
5 seats
exit 0
```

With `--json`, every outcome is one document on stdout:

```console
$ team send --list --json ; echo "exit $?"
{
  "schema": {
    "name": "team.send.list",
    "version": 1
  },
  "format": 1,
  "project": "beacon",
  "session": "beacon",
  "seats": [
    {
      "name": "claude-keeper",
      "nickname": "@agamemnon",
      "cli": "claude-code",
      "role": "coordinator",
      "project": "beacon",
      "reach": "socket",
      "stopped": false
    },
    {
      "name": "gpt-reviewer",
      "nickname": null,
      "cli": "codex",
      "role": "reviewer",
      "project": "beacon",
      "reach": "typed",
      "stopped": false
    },
    {
      "name": "claude-scribe",
      "nickname": null,
      "cli": "claude-code",
      "role": "implementer",
      "project": "beacon",
      "reach": "socket",
      "stopped": false
    },
    {
      "name": "operator-a",
      "nickname": null,
      "cli": "claude-code",
      "role": "operator",
      "project": "beacon",
      "reach": "socket",
      "stopped": false
    },
    {
      "name": "operator-b",
      "nickname": null,
      "cli": "claude-code",
      "role": "operator",
      "project": "beacon",
      "reach": "socket",
      "stopped": false
    }
  ],
  "summary": "5 seats"
}
exit 0
```

A refused send's document carries the structured error, no ids and no reply:

```json
{
  "schema": {
    "name": "team.error",
    "version": 1
  },
  "error": {
    "id": "send.refused",
    "message": "refused: nobody: it is not a declared seat; the file's seats are claude-keeper, gpt-reviewer, claude-scribe, operator-a, operator-b",
    "repair": null
  }
}
```

A name the file does not carry is refused, and the file's seats are named:

```console
$ team send nobody "hello" ; echo "exit $?"
team send: refused: nobody: it is not a declared seat; the file's seats are claude-keeper, gpt-reviewer, claude-scribe, operator-a, operator-b
exit 1
```

A native-CLI seat whose inbox no server serves and whose pane is free takes the send in the
typed leg: the signed record lands in its drop folder and the trigger is typed over it, `sent
(unconfirmed)` with `trigger taken, no read receipt yet`. Its own read hands it the message, and
the receipt it writes is what the watch promotes:

```console
$ team send gpt-reviewer "hello" ; echo "exit $?"
team beacon, session "beacon"
gpt-reviewer: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)
exit 0
```

`--wait` on any seat waits on the thread for a reply record; when the window closes with no reply,
it exits 1 and leaves the thread open:

```console
$ team send gpt-reviewer "hello" --wait --timeout 5 ; echo "exit $?"
team send: gpt-reviewer: timeout: sent, no reply on the thread within 5s; the thread stays open
exit 1
```

`--dry-run` names the channel. It writes no record, types nothing and appends no line to `.agents/team.log`:

```console
$ team send gpt-reviewer "hello" --dry-run ; echo "exit $?"
team beacon, session "beacon"
gpt-reviewer: dry-run: codex via its native runtime queue, falling back to a 0600 drop file and one trigger line, then the seat's own MCP inbox, then a 0600 drop file, with nothing typed into the pane; nothing was written
exit 0
```
