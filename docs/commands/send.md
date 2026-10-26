# team send

Sends one message to one seat of your team.

## Usage

    team send <seat> <message>
    team send <seat> --file <path>
    team send <seat> <message> --wait
    team send --list

## What it does

`team send` writes your message as one signed record in the receiving seat's folder, then lets
the seat know it has mail. It tries the seat's own inbox first, then a short line typed into its
pane, then the folder alone. The seat reads the message with `team messages` and answers with
`team reply`. `--wait` waits for that answer and prints it.

## Examples

```yaml file=.agents/team.yaml hidden=1
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

Send a message:

```console
$ team send claude-keeper "the gate is green" ; echo "exit $?"
team beacon, session "beacon"
claude-keeper: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)
exit 0
```

Ask a question and wait for the answer:

```console reply="the gate is green"
$ team send claude-keeper "is the gate green?" --wait ; echo "exit $?"
team beacon, session "beacon"
claude-keeper: answered
the gate is green
exit 0
```

List the seats you can reach:

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

## Options

| Option | Meaning |
| --- | --- |
| `--file <path>` | read the message from a file (`-` for standard input) |
| `--brief <path>` | send a brief file as the message |
| `--subject <text>` | a one-line subject shown with the message |
| `--wait` | wait for the seat's reply and print it |
| `--timeout <s>` | how long `--wait` waits, in seconds (default 120) |
| `--list` | list the seats you can send to |
| `--dry-run` | show how the message would be delivered, and send nothing |
| `--json` | print the result as JSON |

## Who can run it

Any seat of the team and the owner; a seat may only write to the seats its team's rules allow.

## See also

[team reply](reply.md) · [team messages](messages.md) · [team drops](drops.md) ·
[team status](status.md)
