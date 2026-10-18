# team send

Writes one message to one seat. A plain send writes the body whole to a drop file, mode 0600,
by renaming a temporary file into place, and types one short trigger line that names that file.
The body is never split across several writes. A seat whose CLI builds its own work item from
its screens — a profile with a compose module — still gets the drop file, but the body is typed
through those screens and never becomes a trigger line; `delivered` there means the CLI printed
the line that creates the item. A compose seat's brief is typed for one repo: the repo of the
seat's own folder, read from `git remote get-url origin` there. The module proves the CLI's own
chooser collapsed on that repo before it types, and refuses with nothing typed when the CLI's
list does not hold it. The receiving seat's
delivery order decides the channel: `native`, `mcp-inbox`, `typed`, then `drop` when no level of
the seat's chain declares one. Each leg in turn either takes the send, which ends the walk, or
definitely cannot take it, which hands the send to the next leg and is recorded as a failure —
the history line names the channel the send went by and the legs that failed before it. The
typed leg is terminal: the drop file and one trigger line, the only channel a send of this build
can go by.

The drop leg writes that same drop file and types nothing at all — no trigger line, no socket
frame, nothing read from a pane — so a receiver that watches its own drop folder finds the
message there. It is chosen with `delivery_order: [drop]`, or by putting `drop` first in the
order, and its console line is `delivered (dropped)` with `via: drop` on the history line.
Because the typed leg is terminal, a walk reaches `drop` only when it comes before `typed` or
`typed` is left out. A level of the receiving seat's own chain — entity, project, team, seat — may drop legs
from the order or put the legs it keeps in a different order, and may never add one: a word
naming a leg the order in force does not have is set aside and the order in force stands. The
words are read from the receiving seat's own files: the team file's `delivery_order` key and the
seat's, and the registry project's record for the project the team sits in ([the team
file](../team-file.md#delivery_order)). A team file that writes a word with no leg, an unknown
leg, or a leg twice is refused when the file is read. This build carries no `mcp-inbox` leg and makes no socket write — a frame can land at a
busy session's held-message dialog, where the box is blocked — so a walk that keeps `mcp-inbox`
records it `unavailable`, and a Claude Code seat's walk records its `native` leg the same way.
`--wait`, which rides that frame, is refused until the native leg ships. `delivered` means the
line had left the seat's input box after that one line and Enter — either herdr reported the seat
`working` (or `done` or `blocked`, and not the status read before Enter), or the transcript shows
the drop being read (a CLI's status can lag while it works) — and the pane was not a dialog this
command already classifies: question, permission, trust, vendor notice, provider error, or
rate limit. A box that cleared with no status or transcript evidence inside the window is
`delivered (taken, not yet confirmed)`: the seat took the line, and the transcript or the status
is read for the sign that it acted on it — a taken line is never typed again. A screen that is
one of those dialogs is not reached. The report names the kind and the drop path, and nothing
further is pressed. The exit code of the typing commands is not the evidence. On herdr 0.7.1 the
working status is the pane hint `ctrl+c to stop` for cursor, a spinner in the terminal title for
codex, and the `esc to cancel` footer for agy. A cursor pane narrow enough to wrap the hint can
submit while herdr stays idle; that run is delivered as taken, never a failed send. The drop leg
never types: there `delivered` means the 0600 drop file is in place, and no box, status or
transcript is read.

A seat the team file marks `human: true` walks no typing leg at all: the typed trigger and the
native frame are skipped, each one's reason recorded on the history line, and the walk falls to the
drop leg — added to the walk when the order in force leaves it out — so the message still arrives
in the drop file and the pane is never touched. With no leg left the send refuses, naming why.
`--wait` is refused for such a seat, since it rides the native leg. The watch types no retry or
nudge into a human's pane either: a held send's marker is given up on with the reason, and its
message waits in the drop file.

`team send --wait` needs the native leg — the team route that carries the call and the caller's
own `SendMessage` that carries the reply — and this build does not ship it. A waited send is
refused before anything is written: no frame, no reply listener, no drop file, nothing typed
into the pane. The refusal names the leg, and it is the same sentence wherever the wait was
asked from — the CLI, or an older caller asking the send daemon for one:

    claude-keeper: --wait needs the native leg (team route + your own SendMessage), which this build does not carry; nothing was sent

A waited send also needs the native leg first in the seat's delivery order — the frame the reply
listener stands beside is that leg — so a `--wait` whose order leads elsewhere is refused too,
naming the order in force:

    claude-keeper: --wait needs the native leg first, and its delivery order is typed; nothing was sent

`--wait` to any other seat is refused as well, with that seat's own reason, and nothing is
written; a waited Claude Code send's dry run prints its refusal as a `dry-run:` line, and a
native-CLI seat's `--wait --dry-run` is the real run's refusal itself — the same sentence and
exit 1 — since neither run writes anything.

The socket frame — the channel the native leg will carry — is a measured observation of Claude Code 2.1.295, not a stable API: JSON
lines, one frame per line, a first-line deadline of 30,000 ms, and a buffer limit of 1,048,576
characters. A frame over that limit is refused, never truncated. The message's body is written
down: a run that ends `delivered`, `answered`, `held`, `not-submitted`, `timeout` or `unreachable` appends one line
to the project's message history, which [team feed](feed.md) reads. A reply's text is not written
down — it reaches this terminal and no file. The daily log keeps the seat and the sizes.

The outcome is always one of `delivered`, `answered`, `held`, `not-submitted`, `timeout`,
`unreachable` or `refused` — printed and matched by the exit code, or written as one machine-readable document
with `--json`. `--list` sends nothing: it prints the addressable seats — the file's own roster,
each seat's human name as its `@<nickname>` address, and the seats of the other teams of the
caller's entity, each of those as `<seat>@<team>` (a human name there as `<nickname>@<team>`).
Broadcast is not in this build. Any seat's shell can run it — agy, grok, codex or claude — and it is the only path
by which one agent types into another seat's pane: agents do not send keys through herdr.

`team send --record <seat> --channel native --ms <n>` is the native channel's other half: the
sender delivered with its own cross-session tool, and this writes that delivery down. Nothing is
delivered here — no drop file, no frame, no pane — and no socket is opened or dialed; the one
effect is one history line, `outcome: delivered` with `via: native`, carrying the span the sender
measured itself in `--ms`. The recipient's record and admission are judged exactly as a plain
send's, so a recorded delivery is never a way around the rules — only around the transport;
`--channel` takes `native` only, `--wait` and `--timeout` are refused beside it, and the body is
optional: given, it is recorded verbatim, and without it the line says the text did not pass
through this CLI. Exit 0 prints `<seat>: recorded (native, <n> ms)` (`status: recorded`), and a
record that cannot be written is a refusal, because nothing is claimed to have been delivered.
[team route](route.md) answers the address such a delivery uses, and the rules item that wires a
seat to it is under [The native channel](#the-native-channel) below.

## Synopsis

    team send <target> <message> [--wait] [--timeout <s>] [--json] [--dry-run]
    team send <target> --file <path> [--wait] [--timeout <s>] [--json] [--dry-run]
    team send --record <seat> --channel native --ms <N> [<message>] [--json] [--dry-run]
    team send --record <seat> --channel native --ms <N> --file <path> [--json] [--dry-run]
    team send --list [--json]

`<target>` names whom to reach: a seat of the caller's own team, or one of the registry forms
under `Addressing` below. The message
is every remaining word, joined with single spaces; `--file` reads the whole body from a file
instead (and then takes no message words). A seat that has both a message and `--file` is a
usage error. `--timeout` is a whole number of seconds, 1 to 86,400, and is only meaningful with
`--wait`; without it a wait would run 120 seconds — a waited send is refused, so the window is
never read. `--json` prints one document instead of the lines: the action surface and the outcome in one —
`{format, dry_run, status, action_summary, project, session, seat, channel, ids, reply?, plan?}` —
where `ids.sent` is the id of the message this command composed and `ids.reply` the reply
frame's own, when there is one; `channel` is the leg that took it, `null` on a dry run, and
`plan` is the dry run's own step. `--list` prints its own document —
`{format, project, session, seats, summary}`. A run that exits 1 or 2 writes the structured
error document instead — `{error: {id, message, repair}}` — and stderr stays empty.
`--dry-run` resolves the seat and names the channel its walk would take — the first leg this
build can actually walk, none it cannot — a drop file and one trigger line for every plain send
of this build, since the socket write is skipped; a waited Claude Code send is named as the
refusal it is, and a waited send whose order leads elsewhere as that refusal. A `--wait` to a
native-CLI seat is refused as the real run is, with the same sentence and exit 1. It
writes no drop file, types nothing and appends no line to `.agents/team.log`: a dry run
writes nothing, and the log records writes.

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
agents. A plain send writes `.agents/send-drops/<session>/<seat>/<id>` (the file mode 0600),
types one trigger line into that seat's pane, reads the pane back before Enter to check the
composer holds that line, and reads it again after Enter. `send-drops`, the session directory,
and the seat directory are each mode 0700. This command never deletes a delivered drop file;
the owner removes `.agents/send-drops` when those messages are no longer needed. A waited send
is refused before any of this: while the socket is not the channel, no run reads the registry's
recorded address, looks for a socket file at `<sockets dir>/<pid>.sock`, or stands a reply
listener at this process's own — the refusal returns before the seat's pane, drop folder or
socket is touched.
The command holds the seat's lock (`<state dir>/seat-locks/<session>/<seat>`) around a plain
send's write, so a launch of the same seat cannot act beside it and two sends cannot type into
one pane at once; a refused waited send holds nothing, because it returns before the lock. It
writes one line to `.agents/team.log` — a refusal writes its own line there — and appends the
message's body to the project's message history
([team feed](feed.md)) when a send completes. The history line names the channel the send went by,
when one took it (`via`), and the legs of the walk that definitely could not take it (`failed`,
each as `<leg>: <reason>` — `native` and `mcp-inbox` are recorded `unavailable` there in this
build). The daily log keeps the
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
admits runs this, from a terminal outside herdr or its own pane`. For every other caller, `--list`
prints the file's roster and the seats of its entity's other teams, and sends nothing, so it needs
no caller check.

| Caller | May send to |
| --- | --- |
| the owner | any agent |
| an orchestrator | an orchestrator of its own team or entity |
| a team's orchestrator or operator | any seat of its own team |
| an assistant seat | its entity's main coordinator |
| any seat | its own team's orchestrator |
| a caller an owner-signed grant names for `send` | what the grant names |

A team's leads brief its own seats directly; another team's seats are reached through that team's
orchestrator, or by an owner-signed grant naming the pair.

An assistant seat is the seat its file marks `assistant: true` — a place in the chain and a
capability, never a role's name: the entity's assistant is the first mark found walking its teams
in chain order, the entity's own team first and then its other teams by team id, so an entity
whose files mark none has no assistant for the rule to admit.

Which seat leads a team — the seat these rules call its orchestrator — is read the same way: the
lead the file declares, by the `leads: true` mark or the legacy `coordinator:` key a 0.3.5/0.4
file still writes, carried onto the record's roster line as `leads: true`; a registry written
before the mark existed is answered from the file. A role word names nothing on its own, in any
language: a seat called `orchestrator`, or one whose role is written `coordinator`, leads nothing
without one of those two places.

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

## The native channel

When the recipient's CLI carries the cross-session channel, a sender can deliver with its own tool
rather than this command's typed trigger or socket frame: [team route](route.md) admits the pair
and answers the session to address, the sender calls its own SendMessage, and `--record` writes
the delivery down. A team's `rules:` carries this as one item, quoted here for the owner to paste —
no team file ships with it, and this repository never writes one:

> - Deliver to another seat natively when `team route <seat>` admits the pair and answers
>   `native yes` — route first, then your own cross-session SendMessage to the session the answer
>   prints, then write the delivery down with `team send --record <seat> --channel native --ms <n>`
>   — and fall back to plain `team send <seat> <message>` only on a definite failure, the route
>   refused, the seat not Claude's, or your SendMessage call itself failed or reported no such
>   session; a call that returned delivered the message, so record it native and never send it
>   again however long an answer takes, and a delivery is recorded exactly once, by the path that
>   delivered it.

Only a definite failure falls back: a missing, slow or absent answer is not a delivery signal, and
the plain send that does fall back builds admission from the same records `route` judges with, so
it cannot deliver what a refusal refused.

## The sender header

Every drop file opens with a header, written before the body: the sender's agent id, and the reach
above or the grant that admitted the send. A seat's header names it — its agent id, its name and
its seat; the owner's reads `from the owner`. A sender the registry holds no record for is spelled
as the file's seat instead of an id — `from the file's seat <seat> (no registry record yet) —
admitted by: <rule>` — so a receiver reads why the id is absent. A waited send's frame opens the
same way, and so
does the body the message history keeps. The receiver reads who sent a message and why that sender
was let through; the drop record carries the sender's id from day one.

## Outcomes

Every run that reads a team file opens on stdout with one context line,
`team <project>, session "<session>"`, before the outcome line or table; a refused run prints its
line on stderr and has none.

| Outcome | Exit | Printed |
| --- | --- | --- |
| delivered | 0 | `<seat>: delivered` on stdout, or `<seat>: delivered (taken, not yet confirmed)` when the box cleared before the seat showed it acted |
| answered | 0 | `<seat>: answered` and the reply on stdout |
| held | 1 | `team send: <seat>: held: <reason>` on stderr, or `held (socket)` when the socket's frame is what the dialog keeps |
| not-submitted | 1 | `team send: <seat>: not-submitted: <reason>` on stderr, naming what the box holds |
| listed | 0 | a `SEAT  NICKNAME  ROLE  PROJECT  REACH` table, one row per seat, then `<n> seat` or `<n> seats` on stdout; `NICKNAME` is `-` without one, `@<nickname>` for the file's own seats and `<nickname>@<team>` for another team's, and a seat of another team of the same entity reads `<seat>@<team>` in `SEAT` |
| recorded | 0 | `<seat>: recorded (native, <n> ms)` on stdout, for a `--record` run |
| timeout | 1 | `team send: <seat>: timeout: sent, no reply within <s>s; a seat which does not accept messages from other sessions holds the frame until a person lets it through` on stderr |
| unreachable | 1 | `team send: <seat>: unreachable: <reason>` on stderr |
| refused | 1 | `team send: refused: <reason>` on stderr |
| usage | 2 | `team send: <message>` and the usage on stderr |
| configuration | 2 | `team send: <message>` on stderr |

A running watch retries a `held`, `not-submitted` or dialog-stopped send once the seat is idle,
up to three tries in thirty minutes; the line the send printed tells the sender so, and a retry
that stops says where the message is. A retry never types into a pane back at its shell — the
seat's CLI has exited, so it is given up with `the seat is back at its shell; nothing was typed`
and the drop file stays. A `delivered (taken, not yet confirmed)` send is never
retried: the seat took the line, and a running watch reads the transcript and the status on its
later passes for the sign that it acted on it. A sign confirms the delivery silently; a seat that
sits free for a minute past the send, or a record thirty minutes old, with no sign at all, is said
once — `<seat>: a send from <sender> was taken but never acted on`, with the drop file's path —
and one more history line keeps it. Even then the line is never typed again.

Under `--json` the same outcomes are one document: the action surface for a send, the roster
document for `--list`, and the structured error document for an exit 1 or 2 — `error.id` is the
outcome's own (`send.refused`, `send.not-submitted`, …), `error.message` the text the plain run
prints without its `team send: ` prefix, and `error.repair` a way out when there is one. Exit
codes are the outcome's: 0 when delivered, answered, listed, recorded, or resolved by
`--dry-run`, 1 when held, not-submitted, timed out, unreachable, stopped, or refused, 2 when the
invocation or team file can't be read.

Three of these rows are the native leg's: `answered`, `held (socket)` and `timeout` belong to
the socket frame, and a waited send is refused before one exists, so no run of this build reaches
them. The rows and their vocabulary stay for the leg's return.

`held` is nothing sent: the message is safely on disk — or, on the socket's path, in the frame the
receiving session's held-message dialog keeps for a person to let through — the run exits 1, and
the reason it prints says what held it. A socket write the dialog keeps is `held (socket)`, and
nothing is typed into the blocked box while the dialog stands. A pane whose composer already holds unsent text is left alone before the run
types anything (`the composer already holds unsent text`). The trigger line is what the composer
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
delivered as `taken, not yet confirmed`. A box that cannot be read keeps the first Enter and is
judged by herdr's status alone, and no other Enter goes to it: with no evidence and no box to
show the line left, that run is `not-submitted`. A seat that was already working before Enter
proves nothing by its status, and a status that moved under a dialog counts for nothing: only the
transcript can show that seat took this line. An unverified send writes one line to `team.log`
for the orchestrator.

`unreachable` is the seat not reached: no live agent of that name, a screen that is one of the
dialogs listed above, the held-message dialog — the sentence on a screen with no live composer to
read — no socket file for a waited Claude Code seat, a connection that would not
take that frame, or a pane that would not take the trigger — the socket reasons return with the
leg — and a walk that ran out of legs is unreachable too, printing `no leg of its delivery order
took the send` with the legs that failed. `timeout`
is a waited frame written on the socket and no reply inside the window. `refused` is nothing
being sent on purpose: an unknown seat (the file's seats are named), any `--wait` — the native
leg's absence for a Claude Code seat, the same absence, with that seat's own reason, for
every other, and a delivery order that does not lead with the native leg — a frame over the
socket limit, a trigger longer than the measured line, a
reply listener that could not be opened, a lock another command holds, or a caller that may not
send.

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
```

A plain send is a drop file and one trigger line, and the outcome is the plain word.

```console
$ team send claude-keeper "the gate is green" ; echo "exit $?"
team beacon, session "beacon"
claude-keeper: delivered
exit 0
```

`--wait` is refused until the native leg — the team route and the caller's own `SendMessage` — ships, and nothing is written:

```console
$ team send claude-keeper "is the gate green?" --wait ; echo "exit $?"
team send: refused: claude-keeper: --wait needs the native leg (team route + your own SendMessage), which this build does not carry; nothing was sent
exit 1
```

A dry run of the same send prints that refusal and writes nothing either:

```console
$ team send claude-keeper "is the gate green?" --wait --dry-run ; echo "exit $?"
team beacon, session "beacon"
claude-keeper: dry-run: claude-code --wait needs the native leg (team route + your own SendMessage), which this build does not carry; nothing was sent
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
2 seats
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
    }
  ],
  "summary": "2 seats"
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
    "message": "refused: claude-keeper: --wait needs the native leg (team route + your own SendMessage), which this build does not carry; nothing was sent",
    "repair": null
  }
}
```

A name the file does not carry is refused, and the file's seats are named:

```console
$ team send nobody "hello" ; echo "exit $?"
team send: refused: nobody: it is not a declared seat; the file's seats are claude-keeper, gpt-reviewer
exit 1
```

A native-CLI seat is a drop file and one trigger. `delivered` is the seat taking that trigger:
herdr reporting the seat working, the transcript showing the drop read, or the trigger having
left the box with its confirmation still to come (`taken, not yet confirmed`):

```console
$ team send gpt-reviewer "hello" ; echo "exit $?"
team beacon, session "beacon"
gpt-reviewer: delivered
exit 0
```

`--wait` on that seat is refused, and nothing is written. This build does not carry the reply.

```console
$ team send gpt-reviewer "hello" --wait ; echo "exit $?"
team send: refused: gpt-reviewer runs codex: this build confirms that a native CLI submitted and does not carry its reply; nothing was sent
exit 1
```

`--dry-run` names the channel. It writes no drop file, types nothing and appends no line to `.agents/team.log`:

```console
$ team send gpt-reviewer "hello" --dry-run ; echo "exit $?"
team beacon, session "beacon"
gpt-reviewer: dry-run: codex via a 0600 drop file and one trigger line; nothing was written
exit 0
```
