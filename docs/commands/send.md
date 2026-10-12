# team send

Writes one message to one seat. A Claude Code seat takes it on the cross-session message
socket — the channel that session exposes at the runtime temp folder's `cc-socks/<pid>.sock` —
and the command never types into that pane. One send is one JSON line on that socket, and
nothing comes back on the connection itself: `delivered` means the socket took the frame, not
that the seat's agent read it. The receiving session's own inbound policy decides when the frame
surfaces, and a session started without `crossSessionInbound: accept` holds a frame from an
unidentified sender until its owner lets it through.

A native CLI (codex, cursor, grok, antigravity) has no socket. The body is written whole to a
drop file, mode 0600, by renaming a temporary file into place, and the pane is given one short
trigger line that names that file. The body is never typed, and it is never split across several
writes. `delivered` there means herdr reported the seat `working` — or `done` or `blocked`, and
not the status read before Enter — after that one line and Enter. The exit code of the typing
commands is not that evidence, and the command does not read the pane. On herdr 0.7.1 that
status is the pane hint `ctrl+c to stop` for cursor, a spinner in the terminal title for codex,
and the `esc to cancel` footer for agy. A cursor pane narrow enough to wrap the hint can submit
while herdr stays idle; that run is `unreachable`, not a silent success. `--wait` is refused for
a native seat: this build does not carry its reply.

`--wait` asks for the seat's answer. The command opens a listener at its own
`cc-socks/<pid>.sock` — the address the receiving session derives from the connection, the one
it names as the message's `from` — before the frame is written, so an answer that comes at once
finds it standing, and then blocks until a reply line arrives or the window closes. The wait's
outcome is `answered` when the reply came back, `timeout` when it did not; a reply the replying
harness stamped with its attribution wrapper (`<cross-session-message …>`) is printed as the
body inside it. A listener that cannot be opened — a live listener already at that address, or
a leftover file that cannot be removed — is a refusal: nothing is sent.

The socket is a measured observation of Claude Code 2.1.295, not a stable API: JSON lines, one
frame per line, a first-line deadline of 30,000 ms, and a buffer limit of 1,048,576 characters.
A frame over that limit is refused, never truncated. Nothing of a message or its reply is
written down: the log keeps the seat and the sizes.

The outcome is always confirmed — one of `delivered`, `answered`, `timeout`, `unreachable` or
`refused` — printed and matched by the exit code, or written as one machine-readable document
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
the lines — `{seat, status, exit, reply?, error?, ids}` — where `ids.sent` is the composed
frame's id and `ids.reply` the reply frame's own, when there is one. `--dry-run` resolves the
seat and names the channel, and writes nothing.

## What it reads and writes

Reads the team file, the caller's placement, and the herdr session's agents. A Claude Code
seat also reads the processes of the seat's pane and the socket file's presence in `cc-socks`.
The socket is the first of the pane's processes — the foreground processes first, then the
shell — with a file at `<sockets dir>/<pid>.sock`. A native seat writes
`.agents/send-drops/<session>/<seat>/<id>` (the directory mode 0700, the file mode 0600) and
types one trigger line into that seat's pane. The command holds the seat's lock
(`<state dir>/seat-locks/<session>/<seat>`) around the write, so a launch of the same seat
cannot act beside it and two native sends cannot type into one pane at once; a `--wait` send
holds it until the reply or the timeout, because the outstanding request is the thing the lock
serializes. The wait listens at this process's own `<sockets dir>/<pid>.sock` and removes it
when the send ends. It writes one line to `.agents/team.log`. The log keeps the seat and the
size, never the message.

## Who may run it

The owner, or the orchestrator from its own seat, on the pane the project's state records for
it — the same check `team answer` makes, judged the same way. Every other caller is refused
before the seat is looked up. `--list` is the exception: it prints the file's roster and sends
nothing, so it needs no caller check.

## Outcomes

| Outcome | Exit | Printed |
| --- | --- | --- |
| delivered | 0 | `<seat>: delivered` on stdout |
| answered | 0 | `<seat>: answered` and the reply on stdout |
| listed | 0 | one `<name>  <cli>  <role>` line per seat on stdout |
| timeout | 1 | `team send: <seat>: timeout: delivered, but no reply within <s>s` on stderr |
| unreachable | 1 | `team send: <seat>: unreachable: <reason>` on stderr |
| refused | 1 | `team send: refused: <reason>` on stderr |
| usage | 2 | `team send: <message>` and the usage on stderr |
| configuration | 2 | `team send: <message>` on stderr |

`unreachable` is the seat's channel not confirming: no live agent of that name, no socket file
for the pane's processes, a connection that would not take the frame, or a native seat whose
herdr status did not show the trigger was submitted. `timeout` is the socket delivery landing
and the seat staying silent for the whole window. `refused` is nothing being sent on purpose:
an unknown seat (the file's seats are named), `--wait` to a native CLI, a frame over the socket
limit, a trigger longer than the measured line, a reply listener that could not be opened, a
lock another command holds, or a caller that may not send.

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

A message to a Claude Code seat goes out on its socket:

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

A seat that does not answer within the window is a `timeout` — the message was delivered all
the same:

```console
$ team send claude-keeper "hello" --wait --timeout 1 ; echo "exit $?"
team send: claude-keeper: timeout: delivered, but no reply within 1s
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

An answered send's document carries the reply and both frame ids — `ids.sent` is the frame this
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

`--dry-run` names the channel and writes nothing:

```console
$ team send gpt-reviewer "hello" --dry-run ; echo "exit $?"
gpt-reviewer: dry-run: codex via a 0600 drop file and one trigger line; nothing was written
exit 0
```
