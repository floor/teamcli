# team send

Writes one message to one seat. A plain send writes the body whole to a drop file, mode 0600,
by renaming a temporary file into place, and types one short trigger line that names that file.
That is the path for every seat. The body is never typed, and it is never split across several
writes. `delivered` means herdr reported the seat `working` — or `done` or `blocked`, and not
the status read before Enter — after that one line and Enter, and the pane was not a dialog
this command already classifies: question, permission, trust, vendor notice, provider error, or
rate limit. A screen that is one of those is not reached. The report names the kind and the
drop path, and nothing further is pressed. The exit code of the typing commands is not the
evidence. On herdr 0.7.1 the working status is the pane hint `ctrl+c to stop` for cursor, a
spinner in the terminal title for codex, and the `esc to cancel` footer for agy. A cursor pane
narrow enough to wrap the hint can submit while herdr stays idle; that run is `unreachable`,
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
down: a run that ends `delivered`, `answered`, `held`, `timeout` or `unreachable` appends one line
to the project's message history, which [team feed](feed.md) reads. A reply's text is not written
down — it reaches this terminal and no file. The daily log keeps the seat and the sizes.

The outcome is always confirmed — one of `delivered`, `answered`, `held`, `timeout`, `unreachable`
or `refused` — printed and matched by the exit code, or written as one machine-readable document
with `--json`. `--list` sends nothing: it prints the file's addressable seats. Broadcast is not
in this build.

## Synopsis

    team send <seat> <message> [--wait] [--timeout <s>] [--json] [--dry-run]
    team send <seat> --file <path> [--wait] [--timeout <s>] [--json] [--dry-run]
    team send --list [--json]

`<seat>` names one seat of the team file — the same resolution `team status` uses. The message
is every remaining word, joined with single spaces; `--file` reads the whole body from a file
instead (and then takes no message words). A seat that has both a message and `--file` is a
usage error. `--timeout` is a whole number of seconds, 1 to 86,400, and is only meaningful with
`--wait`; without it a wait runs 120 seconds. `--json` prints one result document instead of
the lines — `{seat, status, exit, reply?, error?, ids}` — where `ids.sent` is the id of the
message this command composed and `ids.reply` the reply frame's own, when there is one.
`--dry-run` resolves the seat and names the channel. A plain dry run names the drop file. A
dry run of `--wait` to a Claude Code seat names the socket. It writes no drop file and types
nothing; it appends one line to `.agents/team.log`.

## What it reads and writes

Reads the team file, the caller's placement, and the herdr session's agents. A plain send
writes `.agents/send-drops/<session>/<seat>/<id>` (the file mode 0600), types one trigger line
into that seat's pane, reads the pane back before Enter to check the composer holds that line,
and reads it again after Enter. `send-drops`, the session directory, and the seat directory are
each mode 0700. This command never deletes a delivered drop file;
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

## Who may run it

The owner, or the orchestrator from its own seat, on the pane the project's state records for
it — the same check `team answer` makes, judged the same way. Every other caller is refused
before the seat is looked up. A run with no terminal is refused before `--list` as well:
`team send: only the owner runs this, from a terminal outside herdr`. For every other caller,
`--list` prints the file's roster and sends nothing, so it needs no caller check.

## Outcomes

| Outcome | Exit | Printed |
| --- | --- | --- |
| delivered | 0 | `<seat>: delivered` on stdout |
| answered | 0 | `<seat>: answered` and the reply on stdout |
| held | 1 | `team send: <seat>: held: <reason>` on stderr |
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
takes no Enter (`the composer read-back did not match the trigger`); a trigger the composer still
holds when herdr's status did not show the submission ends the run the same way (`the trigger
stayed unsent in the composer`), the line left in the composer.

`unreachable` is the seat not reached: no live agent of that name, a screen that is one of the
dialogs listed above, no socket file for a waited Claude Code seat, a connection that would not
take that frame, or a seat whose herdr status did not show the trigger was submitted and whose
composer no longer holds the trigger line. `timeout`
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
