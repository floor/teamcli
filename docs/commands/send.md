# team send

Writes one message to one seat. A plain send writes the message whole as one signed record, mode
0600, by renaming a temporary file into place, and walks the receiving seat's delivery order. No
leg types into a pane in this build: a message reaches its seat through an event adapter — the
channel push, a socket frame, the CLI's own runtime queue — through the seat's own MCP inbox, or
through its drop folder, and a seat no route can wake keeps it in the bus inbox with the command
saying so. The record is the message: it carries the body, the sender, the
rule that admitted the send, and the thread it belongs to, and its name is the send's id.
A record waiting in a seat's folder is answered with [team reply](reply.md), which writes the
answer as a record on the same thread, cites the record it answers, and publishes the seat's
signed read receipt beside it (ADR `zeus-message-path`, D3). A plain `team send` back to the
sender is an answer too: it marks the newest message that sender delivered this seat read
(`read_by: answered-by-send`), and only the newest — an older message from the same sender, a
message from anyone else, and one delivered after this send keep waiting. `team ack <id>` marks
a message read with no answer.
The body is never split across several writes. A seat whose CLI builds its own work item from
its screens — a profile with a compose module — still gets the record, but its compose path is
refused before anything is typed, so the seat reads the message through its inbox or its drop
folder like any other. The receiving seat's
delivery order names the legs it accepts: with no declaration it is `typed, drop`, and `socket`,
`native`, `headless-resume` and `session` join it only where a default below or a declared word
adds one; `channel` joins where the seat's server is serving. The order the walk tries them in is the owner's cascade (ADR
`zeus-message-path`, D1): the channel-class legs first — the seat's serving `channel` ahead of
them, then the ones the chain names, in its own order: `socket`, `native`, `headless-resume`,
`session` — then the sender-posted `webhook` where the seat declares an adapter row (no order
names it), then the `typed` leg where the seat's profile declares a typed wake, then the drop
leg. Each leg in turn either takes the send, which
ends the walk, or definitely cannot take it, which hands the send to the next leg and is recorded
as a failure — the history line names the channel the send went by and the legs that failed
before it. The retired `mcp-inbox` word never reaches the walk — the MCP inbox is the store's
reader, not a wake, so the word is dropped from the order before the walk runs — and `team
check` names the word for removal. The
walk filters typing legs out before it runs anything, so a `typed` word contributes no leg
wherever it stands in the order: where a declared order put it for a Claude seat, the seat's own
event adapters stand in its place — the live channel, then the socket its launch accepts — for a
Codex seat its runtime queue stands there while its `codex-daemon` policy is on, and for a CLI
that creates its own session its session call stands there. The drop leg ends the walk: a seat no
event adapter took keeps the message in its bus inbox, and the command says `queued, no event
adapter` on stderr.

The drop leg writes that same record and types nothing at all — no trigger line, no socket
frame, nothing read from a pane — so a receiver that watches its own drop folder finds the
message there. It is the cascade's last class and the order's own last word: the default order
names it, it is chosen alone with `delivery_order: [drop]`, and a human's seat walks it alone
unless it declares a webhook adapter, which is no pane route and is posted before it. Its console
line is `<seat>: queued, not woken (drop, <n> ms); <delivery>`, exit 0, with `via: drop` on the
history line: the record is the message, safely on disk, and no receipt has come back yet. Beside
the record the send leaves the marker `<id>.pending`, which says the drop leg left it. The seat's
own watcher reads it: at turn start its hook runs `team drops --read`,
which proves the record's signature, writes the signed receipt `<id>.read.json` beside it and
hands the body to the turn. A running `team watch` promotes the send on that receipt once — one
`delivered (read)` history line, the marker cleared, nothing typed. A record no watcher has read
when thirty minutes have passed is given up on with the file's path: the marker is cleared, the
watch says the send was not read, and the record stays in the folder — never typed, and never
called lost.

When another command holds the seat's lock, the send is queued rather than refused: the seat's
drop leg, or the typed leg that would have typed into it, writes the signed record and its
`<id>.pending` marker without that lock, types nothing and dials nothing, and answers
`<seat>: queued (receiver busy) (<leg>, <n> ms; id <id>); <delivery>`, exit 0. The id on that line
is the id the delivery keeps, and the marker is the one the watch already carries — a marker an
older build's inbox leg left is taken after its fallback window, and a `drop` marker waits for
the seat's own watcher read — so the queue ends in the retry's or the watcher's own word, with
its own history line beside the acceptance the send wrote, and the message is never delivered
twice. A queued send is an acceptance, never a delivery: no receipt is claimed, and nothing says
`delivered` until one comes back.
A walk reaches `drop` when the legs before it did not take the send — a socket frame was not
taken, the runtime queue was not there, or the adapter did not take the post — because the
cascade always closes on the mailbox: a word that places `drop` first still stores after every
wake the order names. A level of the receiving seat's own chain — entity, project, team, seat —
may drop legs from the order or put the legs it keeps in a different order, and may add `native`,
`socket`, `headless-resume` or `session`: a word naming any other leg the order in force does not
have is set aside and the order in force stands. An `mcp-inbox` word declares nothing: it is
dropped from the order as a retired alias, never a set-aside, and the legs beside it keep their
word. The words are read from the receiving seat's own files: the team file's
`delivery_order` key and the seat's, and the registry project's record for the project the team
sits in ([the team file](../team-file.md#delivery_order)). A team file that writes a word with no
leg, an unknown leg, or a leg twice is refused when the file is read.

A second word on the same chain decides what the send leaves behind: `messaging.store`, read from
the entity's and the project's signed records, the team file's `messaging` map and the seat's own
([the team file](../team-file.md#messagingstore)). The shipped `first` writes the signed record
into the seat's folder before any leg wakes it and keeps it there. `parallel` starts that same
write beside the first waking leg and ends the send only when both settled, so a frame the
receiver took while its copy could not be written is `sent (unconfirmed)`, never `delivered`.
`none` keeps no copy at all: the walk is narrowed to the legs that carry the body themselves —
`socket` and `session` — every other leg the order names is set aside with its reason (a runtime
queue or a headless resume only hands the seat a pointer to the stored copy, which nothing
writes under `none`), and an order left with no body-carrying leg refuses before anything is
written. A socket frame under `none` carries the signed record's exact bytes in its `record`
field: they are signed, never stored, and a receiver verifies them with the same key check it
applies to the folder copy. What the copy would have carried is given up — the retry, the unread
re-wake, the read receipt and the `queued, not woken` flag — and a send to a seat marked
`human: true` is refused, because a person's pane is reached by the stored copy alone. Only the
entity or the project may loosen the word toward `none`; the team and the seat may always tighten
it back toward `first`, and `team check` notes every seat whose chain declares `none`.

A receiving Claude session's `socket` leg is the one implied default outside a declared word:
with no level of its chain declaring an order, a seat whose own launch declares
`crossSessionInbound: accept` is walked `socket` first, then the default order. For a seat
TeamCLI launched, that launch setting is the authorization on its own and the team file needs no
`inbound` line; a session launched some other way is dialed only when its team file also says
`inbound: accept`. An explicit team-file `hold` or `refuse` always keeps the socket out — the
documented opt-out — and a launch that says `hold`, `refuse` or nothing is never dialed. A frame
the socket takes ends `delivered (socket)` at the frame: the send never waits on the receiving
box, so a frame that then sits at that box's held-message dialog is not the sender's to see. The
daemon's presence pass looks at the receiving seat's pane after a socket delivery and, when the
frame is at its dialog, writes one `held` line for that id — its fields are the signed record's —
and marks the socket held; that seat's socket is not dialed again until the declaration the hold
sat under is re-confirmed, by its settings file being rewritten. The hold's mark lives under the
receiving team's state folder, outside the seat's drop folder, so its reader never sees it as a
message.

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
socket does not take it — types nothing: the trigger is refused before the pane, and the watch
says the message waits in the bus inbox. The history line records the redelivery
as `failed: redelivered: channel unconfirmed`. The marker carries that word, so no later pass can
redeliver the same push again, and an acknowledged record is never touched: a receipt that lands
after the redelivery settles the marker as read and types nothing more. A wait that sees no marker
inside its two seconds wrote a record nothing pushed: the marker is cleared and the walk moves on
with `failed: channel: no push receipt within <n> ms`, because this leg took nothing and no later
pass may redeliver a send whose own run is still walking the order.

The `session` leg is another implied default outside a declared word, and it belongs to a
receiving CLI whose profile declares its own session call: where a word declares `typed`, the
session call stands at that word instead, and with no level of its chain declaring
an order, the walk runs the CLI's own session-creating call first, in the seat's own folder, with
the whole body — the rules, the sender header and the message — as ONE argument after the
profile's own words, never through a shell string. When the folder's `origin` names a repository,
`--repo <owner>/<repo>` follows the profile's words and the body comes last. Nothing is typed
and no pane is read. The send is delivered only when the CLI printed its own session line with an
id: the console says `<seat>: delivered (session <id>)` (exit 0, `via: session`), and the
history line records the id as `session`. Every other ending — the CLI could not run, exited
non-zero, or exited 0 without its session line — records `session: <reason>` among the failed
legs and hands the send to the leg behind it. A seat whose CLI declares no session call records
`session: <cli> has no session-creating command in this build` and moves on. The send never pulls
the remote session's result: that is the operator's own call, `team worktree pull <task>
--remote-session <id>`, which runs the CLI's own pull into the worktree it belongs in
([team worktree](worktree.md)).

A public-only seat — its CLI's profile declares `public_only: true`, as a hosted CLI's does, or
the team file marks the seat — never receives the team's rules: no rules text is prepended to its
body. Its body is read against the machine's private lists, the names and phrases files the
pre-push gate reads, before the session call. A body that matches a rule is a leg that did not
take the send: the failed leg reads `session: the body matches a private rule (names entry 1); no
session was created` (source, class and ordinal — never the text), the walk falls through to the
leg behind it, and the message still lands in the seat's own drop folder. A list that is present
and cannot be read refuses the body the same way; a machine with neither list has nothing
configured to protect, and the send proceeds.

The repository travels with the body: the CLI clones `owner/repo` from the forge, so a private
one would hand the service the code the brief is about. Before the session call, the repository
the seat's folder names as its `origin` is proven public by one credential-free read of the
forge's own record — no header of any kind, no redirect followed, and only a 200 that marks the
repository public counts (`src/send/repo-visibility.ts`). A repository that is not public, a read
that cannot be made, and a folder that names no repository all refuse the leg the same way a
private-list hit does — `session: the target repository owner/repo is not public; no session was
created`, `session: the target repository owner/repo could not be read for visibility; no session
was created`, or `session: the seat's folder names no repository, so the session's target cannot
be proved public; no session was created` — and the walk falls through to the leg behind it, so
the message still lands locally. A read the walk cannot make must not pass a message.

A listener that runs another install is no route for the channel: the marker names the version,
the entry build and the packed commit the server started from, and a listener of another install
cannot take a record this build signs, so the channel is not counted as a route for this send and
the walk goes on to its other legs. A walk that wakes the seat itself leaves the channel-held
marker first, so the stale server cannot push the same record after it. The serving inbox
compares the install under it with the one it started from on every channel tick and after each
tool call; when they differ it removes its marker, starts the installed entry with the same
arguments and this process's stdio, and exits. A stale channel listener is still a running old
server and would push the record after the sender's own wake, so a sender whose walk holds a
waking leg — socket or native — writes a marker with `kind: "channel-held"` at the push
marker's own name, `<id>.channel-push.json`, before its record. Any marker-aware serving server
skips an id that already holds a marker — a build older than this rule cannot honor it — and the
send's own wait never reads the held marker as a push: only the server's `channel-push` marker
ends it as `sent (channel)`. The watch's retry reserves the same name before its wake — before the
socket redelivery, and again before the trigger it would type, which this build refuses —
whichever listener is there. That is the point: an
install can change between any check and the wake, so the name is held before the wake rather than
after a verdict that could already be stale. A seat whose launch no longer names the channel still
reserves while a listener started with the flag is alive, read from `.inbox-listener`; the marker
must name this seat, this session and this root, and its pid must be live. That fallback is one
process deep: the marker is last-writer-wins, so a newer non-channel server hides an older channel
server still running, and the older one can display the record once after the wake — a duplicate
notice, never a second record or id and never a second valid read receipt. A server started after
the record arrived pushes nothing, so a dead marker leaves no push to race. The retry's hold is not
cleaned up: a wake the seat never takes — the retry types nothing and its marker is given up at
the retry window's bound, or the pane never frees — leaves the channel push held too, and delivery falls to the record's own
read (`inbox_check`, the turn-start drop read, or `team messages`). The record stays in the inbox
throughout, so a held name never withholds the message.

The `mcp-inbox` word is retired — no longer a leg: the MCP inbox is the store's reader —
the same signed records the drop leg leaves, read by `team drops --read`, by the inbox server's
own read tool or by `team messages` — and a reader is not a wake. A word that still names it is
read as an alias and dropped from the order, never an error: no leg is attempted, the report
carries nothing for it, and `team check` says `delivery_order [...] names mcp-inbox, which is no
longer a leg; remove it` once per team and per seat. A record an older build left beside the drop
says which leg left it, and a seat that reads one leaves the same signed receipt the drop leg's
reader does. The
`native` leg is a call the sender's own process makes or the receiving seat's own runtime queue,
never a frame this walk writes. A Codex receiver's queue takes the send
only when its `codex-daemon` policy is on, a trusted runtime session is bound to the seat, and
the queue answers the bounded live readiness probe — the policy alone does not admit it. For a
Claude receiver, a walk from the owner, or from a sender whose own file does not declare
`cli: claude-code`, records the leg `unavailable`; a sender whose own file does declare it gets
[the native handoff](#the-native-channel) instead — one pending record, the exact target, the
body and the `--confirm` line — and makes the call itself.
The typed leg is the profile-gated typed wake: only a profile that declares `typed_wake` — the
shipped `antigravity`, `codex`, `cursor`, `grok` and `muse` profiles do — lets the walk reach it; a `typed` word in any other
profile's order is set aside before any leg runs, and the seat's own event adapters stand in its
place, so a send no adapter takes ends at the drop leg with the record in the bus inbox. The drop
leg never types: there the run ends `queued, not woken` once the signed record and its marker are
in place, and no box, status or transcript is read.

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
the default says: every other leg — a channel push, a socket frame, the native route, a typed
wake — is skipped, each one's reason recorded on the history line, and the message arrives in
the record with the pane never touched and no frame sent. Its one exception is the sender-posted
`webhook`: an adapter row is no pane route, so a person with one keeps it where the cascade puts
it, before the drop file.
`--wait` is allowed for such a seat: the record is written on its `drop` leg, nothing is typed,
and the run awaits a reply record on the thread. The watch types no retry or
nudge into a human's pane either: a held send's marker is given up on with the reason, and its
message waits in the record. A caller that reaches the send daemon directly is refused at its
queue for such a seat: no trigger is typed, no frame is sent, and no worker is started.

`team send --wait` writes the signed message record through the receiving seat's delivery walk —
its event legs, its webhook adapter or its `drop` folder; for a seat marked `human: true`, its
webhook adapter and drop alone — and then awaits the first verified reply record on the thread
([team reply](reply.md)) until the
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
down: a run that ends `delivered`, `delivered (read)`, `delivered (typed wake)`, `sent
(unconfirmed)`, `answered`, `held`, `queued (receiver busy)`, `not-submitted`, `timeout` or
`unreachable` appends one line
to the project's message history, which [team feed](feed.md) reads. The daily log keeps the seat and the sizes.

The outcome is always one of `delivered` (or `delivered (read)`, or `delivered (typed wake)`),
`sent (unconfirmed)`, `queued, not woken`, `answered`, `held`, `queued (receiver busy)`, `not-submitted`, `timeout`,
`unreachable` or `refused` — printed and matched by the exit code, or written as one machine-readable document
with `--json`. `--list` sends nothing: it prints the addressable seats — the file's own roster,
each seat's human name as its `@<nickname>` address (the name a seat signed standing where the
file's word did), and the seats of the other teams of the
caller's entity, each of those as `<seat>@<team>` (a human name there as `<nickname>@<team>`).
Broadcast is not in this build. Any seat's shell can run it — agy, grok, codex or claude — and it
never types into another seat's pane: agents do not send keys through herdr.

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
made: `the seat's own MCP inbox, falling back to a 0600 drop file, with nothing typed into the
pane` for a plain send today, the native handoff
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
it (`<id>.<status>.json`), and the status is read from those receipts, never edited. No leg types
into that seat's pane except a profile's declared typed wake, which types into an empty idle box
alone; the drop leg itself reads nothing back and presses no Enter. `send-drops`, the session
directory, and the seat directory are each mode
0700. This command never deletes a delivered record; the owner removes `.agents/send-drops` when
those messages are no longer needed. A native handoff types nothing and writes no trigger: it
writes the same signed record into the seat's folder and one pending record to the caller's own
project state (`<config dir>/team/<project>-<hash>/pending/<id>.json`, mode 0600, a temporary
file renamed into place), and `--confirm` takes that record before it writes the one history
line and then clears it. A waited send writes the signed record through the receiving seat's
delivery walk, releases the seat lock, and watches `<root>/.agents/send-drops/<session>/*/` for
the first verified reply record on the thread (`payload.thread === record.thread`).
The command holds the seat's lock (`<state dir>/seat-locks/<session>/<seat>`) for the deliveries
its drop leg makes, so a launch of the same seat cannot act beside one of them and no two of them
run at once. When the lock is held, those legs queue the send instead: they write the
signed record and its `<id>.pending` marker without the lock (above), an acceptance and never a
delivery. It writes one line to `.agents/team.log` — a refusal writes its own line there — and
appends the message's body to the project's message history ([team feed](feed.md)) when a send
completes. The history line names the channel the send went by, when one took it (`via`), and the
legs of the walk that definitely could not take it (`failed`, each as `<leg>: <reason>` — `native`
is recorded `unavailable` there when neither the receiving runtime's queue nor the handoff takes
the send; the retired `mcp-inbox` word names no leg and appears in no failure list). The line
also carries `thread`, the first message's id, and `in-reply-to` when the message
answers one, so [team feed](feed.md) reads a thread's status from the receipts beside its
records. The daily log keeps the seat and the size; the history keeps the message.

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
| an assistant seat | its entity's lead coordinator |
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
same folder the standing create-grants live in), naming the pair it admits and when it stops.
[`team grant --send`](grant.md) writes it, signed with the owner's approval key:

```json
{
  "send": { "from": "builder-1@labs", "to": "orchestrator@floor" },
  "expires": "2026-10-17T00:00:00Z",
  "signature": "9f2c…"
}
```

`from` is the sender's agent id, `seat@team` or `session/seat`. `to` is the receiver in the same
spellings, a bare seat (the sender's own team's), or the reserved `orchestrator@<entity>`: the lead
seat of a team of the sender's own entity, resolved at the target's team, and never a team of
another entity. The file's stem is the record's name; the send's header and dry run print it.

The record is read only once the rules above have refused, and it admits the send only when its
`from` names the caller's own agent record — a grant naming another agent never admits this
caller — its `to` names the receiver, and `expires` is still ahead. A record that fails any of
those, or a symbolic link, is not a grant: the send is refused as if the folder were empty. A
record that names the pair but is not signed by the owner — an unsigned record from an earlier
build, or one whose signature does not verify — refuses the send with `send.grant-invalid` (exit
1) and does not fall back to the other reasons: the refusal names the record and prints the exact
`team grant --send` line that recreates it signed, with a reserved or over-long name printed as a
safe stem and a legacy offset expiry printed at the same instant in canonical UTC, so the line
runs as printed. `team send --dry-run` shows the same refusal
and, when a signed record admits the pair, names it in the preview line.

## The client send

`team send --client` is the one send a client grant admits. The grant is the owner's, the request
is signed with the client's own key, and the destination is the entity's orchestrator —
`orchestrator@floor` is the only address this build admits. The request id is used once, and the
drop is written under the grant lock after the grant, the key, the registry binding and the
request's target are read again. The record keeps the client's own principal: `from` is
`client:grok-bot`, `from_id` is null, and `from_client` carries the client id and the grant id.

Writing that drop is the message: the record already waits in the seat's bus inbox. The same
signed record is then carried through the coordinator seat's resolved delivery order, restricted
to the legs a live receiver can take — the cross-session socket and the typed word, which the
walk refuses before it types — so a seat in the middle of a turn can take the message. With no
declared order the walk is the socket when the seat's launch declares `crossSessionInbound:
accept`, then the refused typed leg. A level that declares an order is walked as written; its
`drop`, `native` and `headless-resume` words add nothing, because the drop the grant wrote is
already the durable copy and the other two belong to the seat's own runtime; a retired
`mcp-inbox` word is dropped before this walk, so it names nothing here.

Every leg keeps its ordinary pane-safety checks. A human's pane is never dialed or typed into, a
bare shell is never typed into, and a held frame keeps the socket out until the seat's
declaration is re-confirmed. No leg writes a second record: each write accepts the record at the
same id, and a frame the socket takes writes no receipt — only the seat writes a read receipt, so
the record stays unread until the seat's own read, and the watch re-wakes it like any other
message. The frame
opens with the claim marked unverified, `[unverified sender: claimed <caller>]` on its own line —
nothing attests the caller yet — then names its sender `Message from Grok Bot (owner)`, with the
owner's reply target as its reply line, so the receiving seat reads a person's message and not a
seat address. The walk's ending
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
that cannot resolve the recipient's live pane or its socket falls back like any
other miss — the remaining legs of the recipient's order, then its drop folder — and the history
line names `native: <reason>` among the failed legs; a pending record
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
>   message by another path. Fall back to plain `team send <seat> <message>` only on a definite
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
that header, so the sender's own call carries it too. A socket frame opens with the sender's
identity line and then the signed body with that header, and the body the message history keeps
carries it too. The receiver reads who sent a message and why that sender
was let through; the record carries the sender's ids from day one.

Two internal senders are named by reserved words instead of a seat: the watch's own direct-work
sends read `from the watch — admitted by: the watch's direct-work authority`, and the machine
daemon's reminder sends read `from the daemon — admitted by: the daemon's reminder authority`.
Neither carries an agent id, and neither may address the owner. A reminder's sender is not a
seat, so a recipient cannot reply to `daemon`.

## The message-display wake line

A channel push announces a message with a header the `message-display` policy renders, and the
wake line a watch builds for an unread message renders the same header. The policy is a signed,
enforced setting at the entity and team
levels and has no team file field: the entity's default stands until a team writes its own value,
and the team's value
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
| `{id}` | reserved for the record's id; this build leaves it empty, and a socket frame carries the id in its `msg_id` and in its reader line |

Every field is data: control characters, escape sequences and line breaks are neutralised, so a
rendered header is one printable line. A body line that forges a sender header stays summary
text and never becomes the header.

The line a typed wake carries is the rendered header, one space, and a sentence naming the
seat's fastest read path: the receiving profile's `read_hint` when it declares one — a profile
whose seats carry an MCP inbox names the inbox tool, `Read it with: call inbox_check now.`,
because the typed line never carries the id `inbox_read` takes — and the shipped
`Read it with: team drops --read.` otherwise. The whole line is one printable line of at most 80
characters; the sentence is kept whole and the header gives way to it. The template cannot remove
the sentence — an agent seat always learns where to read the signed record — and no sentence
carries the message's id except one: a socket delivery's single re-wake says `ack <id> or reply`,
naming the message its frame carried, because either act settles that exact record (ADR
`zeus-message-path`, D3).

A socket frame is not a message-display line. The frame an agent seat receives opens with the
unverified-claim banner `[unverified sender: claimed <caller>]` — nothing attests the caller yet,
so every frame is marked — then a blank line, the sender's identity line,
`Message from <name> (<seat>@<team>)` — the nickname the registry holds, the name the seat's
written label carries before the middle dot, or its seat name, with no summary and no rule — then
a blank line, the signed body with its own `from … — admitted by: …` header, and the reader line
ADR `zeus-message-path`, D3 pins:
`Answer with team reply <id> "…" (this marks it read), or team ack <id> if no answer is needed.`
The id is the record's own and appears once; `team reply <id>` answers and marks it read,
`team ack <id>` marks it read with no answer. The line is the same for every sender, the owner
included, and carries no address — no entity or owner-reply target is resolved for it. An
ordinary send never frames a human's seat: a
`human: true` seat walks the drop leg alone, so no frame is dialed for it.

A running watch builds the same header for the oldest waiting message; in this build the ring
stops before the pane, so the line is built and never typed. It builds none when nothing waits.

## Outcomes

Every run that reads a team file opens on stdout with one context line,
`team <project>, session "<session>"`, before the outcome line or table; a refused run prints its
line on stderr and has none.

A line that ends without a delivery — `sent (channel)`, every `sent (unconfirmed)`,
`queued, not woken`, `queued (receiver busy)` — carries the receiving seat's delivery class in plain words after the
leg's own parenthetical, so `unconfirmed` is never the whole answer to whether the seat will read
the message:

```
woken through its event adapter                        an event adapter wakes the seat
woken through its runtime queue                        the runtime holds the message between turns
queued; its webhook fires when the bus takes it        the seat's webhook adapter is its only route, and the send's own post took nothing: a failed post says so beside these words, and the released record is the bus's and the seat's pull's to take
queued; <seat> reads it at its next turn, and nothing here gives it one (pull-only)
                                                       the seat reads its inbox when it takes a turn
queued; nothing wakes <seat> while it is idle; a person or a restart must give it a turn
                                                       a seat with no route at all
queued; nothing wakes <seat> while it is idle except a send-time typed wake and the watch's typed retry once a message passes its unread window, into an empty composer; a person or a restart must give it a turn
                                                       a seat with no route but the typed wake its profile declares, with the watch's retry on
queued; nothing wakes <seat> while it is idle except a send-time typed wake into an empty composer; a person or a restart must give it a turn
                                                       the same, for a seat whose file turns `watch_wake` off
queued; <seat> has no way to be woken while idle       a person
```

A send that reached for the typed wake inserts what the wake saw after `queued; `, before the
class's own words: `the typed wake failed (<reason>)` when the send attempted it and it did not
deliver, `the typed wake did not run (<reason>)` when the send stopped before the attempt — no
live agent carried the seat's name, its pane could not be told apart, it was back at its shell,
or the trigger outgrew the measured line.

`<delivery>` below stands for one of those sentences. It is read from the seat's launch as
the send runs — the watched endpoint, the channel, the seat's webhook adapter, the socket
route the send itself admits (its cross-session declaration, the team file's own `inbound` word,
and the address the seat's launch recorded that still stands), the watcher — and a delivered
line has none, because the delivery itself is the answer. A webhook-only route reads as queued
unless the send's own post settles: a post the adapter took replaces these words with
`webhook delivered (<n> ms)`, one whose answer was not read replaces them with
`webhook delivery unknown: <reason>`, and a post that provably failed leaves them standing beside
`webhook not delivered: <reason>`. The send's own post is bound at three seconds by default — the
`webhook-sender-deadline-ms` policy in force for the receiving team, whose word is a whole number
of milliseconds from 500 to 10000 and whose shorter value is the tighter one — so a person's
command never waits out the bus's budget: a post that outlives the bound is `unknown`, never a
failure, and the claim keeps its place. The request is not aborted at that bound. The command
returns and the process exits; the same request runs on in a detached process, to the policy
max, ten seconds. A 2xx in that window appends a new history line for the same id,
`delivered (late)` via webhook with its milliseconds, and files `webhook.posted` under
`<id>:webhook.posted:late`; the earlier unknown line stays. A non-2xx files `failed` under that
same late id and leaves the claim `sent`, so nothing posts it again. A continuation that is
killed leaves the claim `sent`. The bound leaves the post off the critical path: the
record is already durable and staged for the bus and the seat's pull. The bus carries the same
arrival after the send returns, so a post the send did not make is still the bus's to report. A
fallback whose walk proved the receiving session has no dialable socket lowers the class the
line reports: it never claims a wake the attempt just disproved.

Every line that ends a send names the message id its steps are filed under: a trailing
` (id <id>)` on the last line, or the id in the line's own words where it already carries one —
the queued answer's `(…; id <id>)`, the handoff's `team send --confirm <id>`. A run that wrote no
record (a refusal before it, a dry run, the roster) names none, and the rows below quote the
wording without the trailing tail. The id is the key to `team trace <id>`, which prints that
message's signed steps in order.

| Outcome | Exit | Printed |
| --- | --- | --- |
| delivered | 0 | `<seat>: delivered` on stdout; `<seat>: delivered (socket)` when the receiver's socket took the frame, reported at the frame with no look at the box; or `<seat>: delivered (native, <n> ms)` when a `--confirm` run finds the handoff's nonce in the recipient's transcript |
| delivered (webhook) | 0 | `<seat>: delivered (webhook, <n> ms)` on stdout, for the sender-posted webhook leg: the seat's adapter answered 2xx to the signed record this run posted, which is the leg's whole proof, and the history records `delivered` with `via: webhook`; an adapter's 2xx is not a read receipt, so this is never `delivered (read)` |
| delivered (read) | 0 | `<seat>: delivered (read)` on stdout, for a signed read receipt — the mcp-inbox's `inbox_read` receipt, the channel's ack, the drop leg's watcher read, a reply's `read` (`read_by: reply`), or the seat's own later answer send (`read_by: answered-by-send`): the seat read the message, which is not a claim that it acted on it |
| delivered (typed wake) | 0 | `<seat>: delivered (typed wake)` on stdout, for the profile-gated typed wake: the signed drop record was written under the seat lock, the one-line trigger was typed into the seat's composer and Enter pressed, and the profile's working screen appeared after that Enter; the trigger is the seat reading the drop at its next turn, never the body |
| sent (channel) | 0 | `<seat>: sent (channel) (<n> ms); <delivery>` on stdout, for the channel leg: the seat's own inbox server wrote the push notification and its `<id>.channel-push.json` marker, and the record's pending marker waits for the seat's signed receipt; the client acknowledges nothing at the transport, so this line is never a read |
| sent (unconfirmed) | 0 | `<seat>: sent (unconfirmed) (webhook, <n> ms); webhook delivery unknown: <reason>` on stdout, for the sender-posted webhook leg whose answer was never read: the post may have been taken, the history records `via: webhook` with `sent (unconfirmed)`, and the claim keeps its place so no later pass posts the same record again |
| queued, not woken | 0 | `<seat>: queued, not woken (drop, <n> ms); <delivery>` on stdout, for the drop leg: the message is the signed 0600 record and its `<id>.pending` marker in the seat's drop folder, no receipt has come back yet, and nothing was typed — the seat's delivery class is pull-only or none, so nothing on the sender's side wakes it and the words say so; the seat's own read promotes it to `delivered (read)` later |
| queued (receiver busy) | 0 | `<seat>: queued (receiver busy) (<leg>, <n> ms; id <id>); <delivery>` on stdout, when another command holds the seat's lock: the leg named on the line wrote the signed record and its marker without typing, and the delivery follows when the seat is free — the id is the one it keeps |
| answered | 0 | `<seat>: answered` and the reply on stdout |
| held | 1 | `team send: <seat>: held: <reason>` on stderr — a hold the walk itself sees; a socket frame that later sits at the receiving dialog is the daemon's to record, and the send has already ended `delivered (socket)` |
| not-submitted | 1 | `team send: <seat>: not-submitted: <reason>` on stderr — no send ends here in this build, which types nothing into a seat; the outcome stays in the vocabulary |
| listed | 0 | a `SEAT  NICKNAME  ROLE  PROJECT  REACH` table, one row per seat, then `<n> seat` or `<n> seats` on stdout; `NICKNAME` is `-` without one, `@<nickname>` for the file's own seats and `<nickname>@<team>` for another team's, the word a seat signed standing where the file's word does, and a seat of another team of the same entity reads `<seat>@<team>` in `SEAT` |
| recorded | 0 | `<seat>: recorded (native, <n> ms)` on stdout, for a `--record` run |
| native | 0 | `<seat>: native: nothing was sent; make the call with your own SendMessage, then record it`, then the `to:` target, the body and the `team send --confirm <id>` line, on stdout, for a handoff |
| sent (unconfirmed) | 0 | `<seat>: sent (unconfirmed) (native, <n> ms); <delivery>` on stdout, when `--confirm` runs before the recipient's transcript shows the handoff's nonce; the class is read from the seat's recorded launch, so a handoff confirmed after that launch went away still says how the seat would be woken now |
| timeout | 1 | `team send: <seat>: timeout: sent, no reply on the thread within <s>s; the thread stays open` on stderr |
| unreachable | 1 | `team send: <seat>: unreachable: <reason>` on stderr |
| refused | 1 | `team send: refused: <reason>` on stderr |
| usage | 2 | `team send: <message>` and the usage on stderr |
| configuration | 2 | `team send: <message>` on stderr |

A running watch retries a message a send left pending once the seat is idle: it reads the drop,
the screen and the seat's status, and its wake attempt types nothing in this build — the trigger
is refused before the pane — so a marker ends on a receipt or at the retry window's bound. A retry
never types into a pane back at its shell — the seat's CLI has exited, so it is given up with
`the seat is back at its shell; nothing was typed` and the record stays. A marker an older
build left on the `mcp-inbox` leg is not retried before its window: a receipt promotes it once
the seat's client reads it — one `delivered (read)` history line, nothing typed — and a message
still unread when the ten-minute fallback window ends is handed to the same retry, whose attempt
types nothing, and thirty minutes after the send its marker is given up with `the retry window
passed`.
A message the `drop` leg left is never retried, on that schedule or any other: its marker waits
for the seat's own signed receipt, and thirty minutes after the send it is given up on with the
drop file's path, so a message no watcher read is never silently lost. A marker that records a
taken line is never retried either: a running watch reads the transcript and the status on its
later passes for the sign that it acted on it. A sign confirms the delivery silently; a seat that
sits free for a minute past the send, or a record thirty minutes old, with no sign at all, is said
once — `<seat>: a send from <sender> was taken but never acted on`, with the record's path —
and one more history line keeps it. Even then the line is never typed again.

Under `--json` the same outcomes are one document: the action surface for a send, the roster
document for `--list`, and the structured error document for an exit 1 or 2 — `error.id` is the
outcome's own (`send.refused`, `send.not-submitted`, …), `error.message` the text the plain run
prints without its `team send: ` prefix, and `error.repair` a way out when there is one. Exit
codes are the outcome's: 0 when delivered, delivered (read), delivered (typed wake), sent
(unconfirmed), queued (receiver busy), answered, listed, recorded, or resolved by
`--dry-run`, 1 when held, not-submitted, timed out, unreachable, stopped, or refused, 2 when the
invocation or team file can't be read.

`answered` and `timeout` belong to `--wait` on the thread: `answered` when a verified reply
record on the thread arrives within the window, and `timeout` when the window closes with no
reply on the thread (leaving the thread open).

`held` is nothing typed and nothing further dialed: the message is safely on disk, the run exits
1, and the reason it prints says what held it. A socket frame that ends at the receiving box's
held-message dialog is not a hold this run reports — the send ended `delivered (socket)` when the
frame was taken, and the daemon's presence pass records the hold afterwards, once for that id,
and marks the socket held. Nothing is typed into the blocked box while the dialog stands.

One hold writes nothing at all. When the recipient has a signed registry record and its pane
names a model or version other than the record's, the run is `held` before the body is read and
before any leg is walked, with `model drift: <recorded> vs <running>`: nothing is written on
either side — no signed record, marker, drop or draft — and nothing is typed or dialed; the hold
itself is one `team.log` line. No watch retry owns it, because there is no drop to retry. The way
out is to repair the seat: `team restart <seat>` relaunches it through the launch line its
registry record keeps, under the restart's own rules (the restart is the owner's or a lead's to
run, and a seat mid-turn is not interrupted), and the sender sends again.

Unsent text is the seat's own, and no send touches it. The typed wake is the only leg that types,
and it types only into a box it read twice as the empty idle prompt: a box holding unsent text
gets no line and no Enter, and nothing is copied off, cleared or pasted into. The message waits
in the record, and the seat reads it on its own turn.

`not-submitted` is a line typed and never taken. No send ends here in this build: the shipped
profiles walk no compose screen, and a typed wake that typed without confirming leaves the
message to the bus instead of ending the send here. The outcome
stays in the contract and in [the exit-code reference](../reference/exit-codes.md); the walk's
endings are the ones above — `delivered`, `delivered (read)`, `delivered (typed wake)`, `sent
(unconfirmed)`, `sent (channel)`, `queued (receiver busy)`, `answered`, `held`, `timeout`,
`unreachable` and `refused`.

`unreachable` is the seat not reached: a walk that ran out of legs prints `no leg of its delivery
order took the send` with the legs that failed — a client send's walk, whose grant walks no drop
leg, is the one walk in this command that can end so. `timeout` is a waited send whose record was
written and whose window closed with no reply record on the thread; the thread stays open.
`refused` is nothing being sent on purpose: an unknown seat (the file's seats are named), a frame
over the socket limit, or a caller that may not send.

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

A plain send walks the default order — the seat's own inbox, then the `typed` word the walk
filters out, then its drop folder. No server serves this seat's inbox, so the signed record lands
in its drop folder, the command says on stderr that the message waits in the bus inbox, and the
line carries the seat's delivery class. The seat's own read hands it the message and writes its
receipt, which a running watch records as one `delivered (read)` history line.

```console
$ team send claude-keeper "the gate is green" ; echo "exit $?"
team send: claude-keeper: queued, no event adapter (typing into a seat's pane is never a delivery: messages go through the bus and an event adapter); the message waits in its bus inbox
team beacon, session "beacon"
claude-keeper: queued, not woken (drop, 0 ms); queued; claude-keeper reads it at its next turn, and nothing here gives it one (pull-only) (id <id>)
exit 0
```

Two seats of one team whose lines both write `role: operator` write to each other — the one rule
a role's own word decides, and it never crosses teams. The send is admitted, delivered and logged
like any other:

```console caller=operator-a
$ team send operator-b "the handover is ready" ; echo "exit $?"
team send: operator-b: queued, no event adapter (typing into a seat's pane is never a delivery: messages go through the bus and an event adapter); the message waits in its bus inbox
team beacon, session "beacon"
operator-b: queued, not woken (drop, 0 ms); queued; operator-b reads it at its next turn, and nothing here gives it one (pull-only) (id <id>)
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
claude-scribe: delivered (native, 0 ms) (id 22222222-2222-4222-8222-222222222222)
exit 0
$ team send --confirm 22222222-2222-4222-8222-222222222222 ; echo "exit $?"
team send: refused: 22222222-2222-4222-8222-222222222222: no pending native record holds that id; nothing was recorded
exit 1
```

`--wait` writes the record on the seat's delivery walk and waits on the thread for the first
verified reply record:

```console reply="the gate is green"
$ team send claude-keeper "is the gate green?" --wait ; echo "exit $?"
team send: claude-keeper: queued, no event adapter (typing into a seat's pane is never a delivery: messages go through the bus and an event adapter); the message waits in its bus inbox
team beacon, session "beacon"
claude-keeper: answered (id 44444444-4444-4444-8444-444444444444)
the gate is green
exit 0
```

A dry run of the same send names the walk and writes nothing:

```console
$ team send claude-keeper "is the gate green?" --wait --dry-run ; echo "exit $?"
team beacon, session "beacon"
claude-keeper: dry-run: claude-code via a 0600 drop file with nothing typed into the pane; nothing was written
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

A native-CLI seat whose inbox no server serves takes the send in its drop folder: the signed
record lands there, the command says on stderr that the message waits in the bus inbox, and its
own read hands it the message. The receipt it writes is what the watch promotes:

```console
$ team send gpt-reviewer "hello" ; echo "exit $?"
team send: gpt-reviewer: queued, no event adapter (no event adapter of this seat took it); the message waits in its bus inbox
team beacon, session "beacon"
gpt-reviewer: queued, not woken (drop, 0 ms); queued; the typed wake failed (the send host binds no pane writer; nothing was typed); gpt-reviewer reads it at its next turn, and nothing here gives it one (pull-only) (id <id>)
exit 0
```

`--wait` on any seat waits on the thread for a reply record; when the window closes with no reply,
it exits 1 and leaves the thread open:

```console
$ team send gpt-reviewer "hello" --wait --timeout 5 ; echo "exit $?"
team send: gpt-reviewer: queued, no event adapter (no event adapter of this seat took it); the message waits in its bus inbox
team send: gpt-reviewer: timeout: sent, no reply on the thread within 5s; the thread stays open (id <id>)
exit 1
```

`--dry-run` names the channel. It writes no record, types nothing and appends no line to `.agents/team.log`:

```console
$ team send gpt-reviewer "hello" --dry-run ; echo "exit $?"
team beacon, session "beacon"
gpt-reviewer: dry-run: codex via its native runtime queue, falling back to a 0600 drop file and one trigger line; nothing was written
exit 0
```
