# team send

Writes one message to one seat. A plain send writes the body whole to a drop file, mode 0600,
by renaming a temporary file into place, and types one short trigger line that names that file.
That is the path for every seat. The body is never typed, and it is never split across several
writes. `delivered` means herdr reported the seat `working` — or `done` or `blocked`, and not
the status read before Enter — after that one line and Enter, or the transcript shows the drop
being read (a CLI's status can lag while it works), the line had left the seat's input box, and
the pane was not a dialog this command already classifies: question, permission, trust, vendor notice, provider error, or
rate limit. A screen that is one of those is not reached. The report names the kind and the
drop path, and nothing further is pressed. The exit code of the typing commands is not the
evidence. On herdr 0.7.1 the working status is the pane hint `ctrl+c to stop` for cursor, a
spinner in the terminal title for codex, and the `esc to cancel` footer for agy. A cursor pane
narrow enough to wrap the hint can submit while herdr stays idle; that run is `not-submitted`,
not a silent success.

`team send --wait` to a Claude Code seat writes one frame on the cross-session socket, because
the reply listener needs that frame. A successful write says the frame was sent on the socket,
not that it was delivered. The command opens a listener at its own `cc-socks/<pid>.sock` — the
address the receiving session derives from the connection, the one it names as the message's
`from` — before the frame is written, so an answer that comes at once finds it standing, and
then blocks until a reply line arrives or the window closes. The wait's outcome is `answered`
when the reply came back. No reply within the window says the frame was sent and that a seat
which does not accept messages from other sessions holds the frame until a person lets it
through. A reply the replying harness stamped with its attribution wrapper
(`<cross-session-message …>`) is printed as the body inside it. A listener that cannot be
opened — a live listener already at that address, or a leftover file that cannot be removed —
is a refusal: nothing is sent. `--wait` to any other seat is refused and nothing is written; a dry
run of it names the drop channel instead. This build does not carry that seat's reply.

The socket frame is a measured observation of Claude Code 2.1.295, not a stable API: JSON
lines, one frame per line, a first-line deadline of 30,000 ms, and a buffer limit of 1,048,576
characters. A frame over that limit is refused, never truncated. The message's body is written
down: a run that ends `delivered`, `answered`, `held`, `not-submitted`, `timeout` or `unreachable` appends one line
to the project's message history, which [team feed](feed.md) reads. A reply's text is not written
down — it reaches this terminal and no file. The daily log keeps the seat and the sizes.

The outcome is always confirmed — one of `delivered`, `answered`, `held`, `not-submitted`, `timeout`,
`unreachable` or `refused` — printed and matched by the exit code, or written as one machine-readable document
with `--json`. `--list` sends nothing: it prints the file's addressable seats. Broadcast is not
in this build. Any seat's shell can run it — agy, grok, codex or claude — and it is the only path
by which one agent types into another seat's pane: agents do not send keys through herdr.

## Synopsis

    team send <target> <message> [--wait] [--timeout <s>] [--json] [--dry-run]
    team send <target> --file <path> [--wait] [--timeout <s>] [--json] [--dry-run]
    team send --list [--json]

`<target>` names whom to reach: a seat of the caller's own team, or one of the registry forms
under `Addressing` below. The message
is every remaining word, joined with single spaces; `--file` reads the whole body from a file
instead (and then takes no message words). A seat that has both a message and `--file` is a
usage error. `--timeout` is a whole number of seconds, 1 to 86,400, and is only meaningful with
`--wait`; without it a wait runs 120 seconds. `--json` prints one result document instead of
the lines — `{seat, status, exit, reply?, error?, ids}` — where `ids.sent` is the id of the
message this command composed and `ids.reply` the reply frame's own, when there is one.
`--dry-run` resolves the seat and names the channel. A plain dry run names the drop file. A
dry run of `--wait` to a Claude Code seat names the socket. It writes no drop file and types
nothing; it appends one line to `.agents/team.log`.

## Addressing

| Target | Names |
| --- | --- |
| `agt_<12 hex>` | one agent by its id, from the agent registry |
| `<seat>@<team>` | a seat in a named team; `<team>` is a team id, a project or a session |
| `<seat>` | a seat of the caller's own team: its registry record when one holds it, the team file's declaration otherwise |

The registries — `~/.config/team/agents/<id>.yaml` and `~/.config/team/teams.yaml` — are the
address. The live herdr read is the fallback for a record that carries no pane yet, by the seat's
name in the record's session. A plain seat the registry cannot answer keeps the declared-seat
path: the caller's team file and its placement rules. A spec that names nobody is refused, and
the refusal names what was not found. A target in another team is reached directly, and its drop
lands under that team's own `.agents`. An agent's id is assigned once and never reused; its name
is display only ([the registries](../concepts/registry.md)).

## What it reads and writes

Reads the team file, the caller's placement, the agent registry, and the herdr session's
agents. A plain send writes `.agents/send-drops/<session>/<seat>/<id>` (the file mode 0600),
types one trigger line into that seat's pane, reads the pane back before Enter to check the
composer holds that line, and reads it again after Enter. `send-drops`, the session directory,
and the seat directory are each mode 0700. This command never deletes a delivered drop file;
the owner removes `.agents/send-drops` when those messages are no longer needed. `--wait` to a
Claude Code seat reads the processes of the seat's pane and the socket file's presence in
`cc-socks` instead of writing a drop file. The socket is the first of the pane's processes —
the foreground processes first, then the shell — with a file at `<sockets dir>/<pid>.sock`.
The command holds the seat's lock (`<state dir>/seat-locks/<session>/<seat>`) around the write,
so a launch of the same seat cannot act beside it and two sends cannot type into one pane at
once; a `--wait` send holds it until the reply or the timeout, because the outstanding request
is the thing the lock serializes. The wait listens at this process's own
`<sockets dir>/<pid>.sock` and removes it when the send ends. It writes one line to
`.agents/team.log` — two for a waited send, the socket write and then the reply or the timeout —
and appends the message's body to the project's message history
([team feed](feed.md)). The daily log keeps the seat and the size; the history keeps the
message.

## Who may send to whom

Send is denied by default: a caller reaches exactly the targets below, and anything else is
refused before the seat is looked up. A seat the registry holds no record for has no identity to
admit by, and is refused; `up` and `add` register a seat when they first launch it. A run with no
terminal is refused before `--list` as well: `team send: only the owner runs this, from a terminal
outside herdr`. For every other caller, `--list` prints the file's roster and sends nothing, so it
needs no caller check.

| Caller | May send to |
| --- | --- |
| the owner | any agent |
| an orchestrator | an orchestrator, in any team |
| an assistant seat | its entity's main coordinator |
| any seat | its own team's orchestrator |
| a caller an owner-signed grant names for `send` | what the grant names |

An orchestrator has no other reach: a send to a seat of its own team is refused like any other
pair the table does not list, and needs an owner-signed grant naming it.

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

## The sender header

Every drop file opens with a header, written before the body: the sender's agent id, and the reach
above or the grant that admitted the send. A seat's header names it — its agent id, its name and
its seat; the owner's reads `from the owner`. A waited send's frame opens the same way, and so
does the body the message history keeps. The receiver reads who sent a message and why that sender
was let through; the drop record carries the sender's id from day one.

## Outcomes

| Outcome | Exit | Printed |
| --- | --- | --- |
| delivered | 0 | `<seat>: delivered` on stdout |
| answered | 0 | `<seat>: answered` and the reply on stdout |
| held | 1 | `team send: <seat>: held: <reason>` on stderr |
| not-submitted | 1 | `team send: <seat>: not-submitted: <reason>` on stderr, naming what the box holds |
| listed | 0 | one `<name>  <cli>  <role>` line per seat on stdout |
| timeout | 1 | `team send: <seat>: timeout: sent, no reply within <s>s; a seat which does not accept messages from other sessions holds the frame until a person lets it through` on stderr |
| unreachable | 1 | `team send: <seat>: unreachable: <reason>` on stderr |
| refused | 1 | `team send: refused: <reason>` on stderr |
| usage | 2 | `team send: <message>` and the usage on stderr |
| configuration | 2 | `team send: <message>` on stderr |

`held` is nothing sent: the message is safely on disk, the run exits 1, and the reason it prints
says what held it. A pane whose composer already holds unsent text is left alone before the run
types anything (`the composer already holds unsent text`). The trigger line is what the composer
is read back for: before Enter the run checks the composer holds it, and a composer that does not
takes no Enter (`the composer read-back did not match the trigger`); the trigger line is the
only text a second Enter is ever pressed for.

`not-submitted` is a line typed and never taken: the message is on disk, the run exits 1, and the reason names the Enters
pressed and what the input box holds (`the box holds "…"`, `the box is empty`, or `the box could
not be read`); `--json` carries the same text as `box`, `null` when the box could not be read. The
box is read with its styling (`herdr pane read --format ansi`), and faint text — a suggestion or a
placeholder — counts as an empty box: it is never waited on, never cleared and never a reason for
an Enter. After Enter the run verifies two things: the trigger has left the box, and either herdr reports
the seat working (or a `done` or `blocked` that is new) or the transcript shows the drop being
read — a row that names the drop's id and is not the echo of the trigger line, such as `Explored 1
file (<id>)`. herdr's status can lag or stay idle while a CLI works, so a box that has cleared is
waited on for up to 20 seconds in all before the run gives up. A try that shows neither is followed by a
re-read, and another Enter goes only to a box that still holds exactly the trigger line — never
to an empty one, to one that holds something else, or to a dialog — at most three Enters in all,
waiting 1, 3 and then 9 seconds for the seat to show it. A box that cannot be read keeps the first
Enter and is judged by herdr's status alone, and no other Enter goes to it. A seat that was already
working before Enter proves nothing by its status, and a status that moved under a dialog counts
for nothing: only the transcript can show that seat took this line. An unverified send writes one line to
`team.log` for the orchestrator.

`unreachable` is the seat not reached: no live agent of that name, a screen that is one of the
dialogs listed above, no socket file for a waited Claude Code seat, a connection that would not
take that frame, or a pane that would not take the trigger. `timeout`
is a waited frame written on the socket and no reply inside the window. `refused` is nothing
being sent on purpose: an unknown seat (the file's seats are named), `--wait` to a seat that is
not Claude Code, a frame over the socket limit, a trigger longer than the measured line, a
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

A plain send, Claude Code included, is a drop file and one trigger. `delivered` is herdr reporting the seat working:

```console
$ team send claude-keeper "the gate is green" ; echo "exit $?"
claude-keeper: delivered
exit 0
```

With `--wait`, the send blocks for the seat's reply and prints it:

```console reply="the gate is green"
$ team send claude-keeper "is the gate green?" --wait ; echo "exit $?"
claude-keeper: answered
the gate is green
exit 0
```

A seat that does not answer within the window is a `timeout`. The frame was sent on the socket, and the report says so:

```console
$ team send claude-keeper "hello" --wait --timeout 1 ; echo "exit $?"
team send: claude-keeper: timeout: sent, no reply within 1s; a seat which does not accept messages from other sessions holds the frame until a person lets it through
exit 1
```

`--list` prints the addressable seats — the same roster `team status` reads — and sends
nothing:

```console
$ team send --list ; echo "exit $?"
claude-keeper  claude-code  coordinator
gpt-reviewer  codex  reviewer
exit 0
```

With `--json`, every outcome is one document on stdout:

```console
$ team send --list --json ; echo "exit $?"
{"seat":null,"status":"listed","exit":0,"ids":{"sent":null,"reply":null},"seats":[{"name":"claude-keeper","cli":"claude-code","role":"coordinator","stopped":false},{"name":"gpt-reviewer","cli":"codex","role":"reviewer","stopped":false}]}
exit 0
```

An answered send's document carries the reply and both ids — `ids.sent` is the frame this
command composed, `ids.reply` the reply frame's own id:

```json
{"seat":"claude-keeper","status":"answered","exit":0,"reply":"the gate is green","ids":{"sent":"<uuid>","reply":"<uuid>"}}
```

A name the file does not carry is refused, and the file's seats are named:

```console
$ team send nobody "hello" ; echo "exit $?"
team send: refused: nobody: it is not a declared seat; the file's seats are claude-keeper, gpt-reviewer
exit 1
```

A native-CLI seat is a drop file and one trigger. `delivered` is herdr reporting the seat working:

```console
$ team send gpt-reviewer "hello" ; echo "exit $?"
gpt-reviewer: delivered
exit 0
```

`--wait` on that seat is refused, and nothing is written. This build does not carry the reply.

```console
$ team send gpt-reviewer "hello" --wait ; echo "exit $?"
team send: refused: gpt-reviewer runs codex: this build confirms that a native CLI submitted and does not carry its reply; nothing was sent
exit 1
```

`--dry-run` names the channel. It writes no drop file and types nothing; it appends one line to `.agents/team.log`:

```console
$ team send gpt-reviewer "hello" --dry-run ; echo "exit $?"
gpt-reviewer: dry-run: codex via a 0600 drop file and one trigger line; nothing was written
exit 0
```
