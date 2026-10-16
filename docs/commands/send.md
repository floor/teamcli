# team send

Writes one message to one seat: the body whole to a drop file (mode 0600) and one short trigger line that names that file — the
body is never typed. `--wait` to a Claude Code seat writes one frame on the cross-session socket instead, and blocks for the
reply. The outcome is always confirmed — one of `delivered`, `answered`, `held`, `timeout`, `unreachable` or `refused` — printed
and matched by the exit code, or written as one machine-readable document with `--json`. A run that ends `delivered`, `answered`,
`held`, `timeout` or `unreachable` appends one line to the project's message history, which [team feed](feed.md) reads; a reply's
text is not written down.

## Synopsis

    team send <seat> <message> | --file <path> [--wait] [--timeout <s>] [--json] [--dry-run]
    team send --list [--json]

`<seat>` names one seat of the team file — the same resolution `team status` uses. The message is every remaining word, joined
with single spaces. `--json` prints one result document instead of the lines: `{seat, status, exit, reply?, error?, ids}`.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--wait`, `--timeout` | —, `<s>` | wait for the seat's reply on the socket; a Claude Code seat only — the window is a whole number of seconds, 1 to 86,400, 120 seconds without it |
| `--file` | `<path>` | read the whole body from a file instead (and then takes no message words); with a message too it is a usage error |
| `--json` | — | one result document on stdout instead of the lines |
| `--dry-run` | — | resolve the seat and name the channel; writes no drop file and types nothing, and appends one line to `.agents/team.log` |
| `--list` | — | print one `<name>  <cli>  <role>` line per addressable seat; send nothing |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

The owner, or the orchestrator from its own seat, on the pane the project's state records for it — the same check `team answer`
makes. Every other caller is refused before the seat is looked up; a run with no terminal is refused before `--list` as well:
`team send: only the owner runs this, from a terminal outside herdr`. `--list` prints the file's roster and sends nothing.

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
| usage, configuration | 2 | `team send: <message>` on stderr, with the usage too for a usage error |

`held` is nothing sent: the message is safely on disk, the run exits 1, and the reason it prints says what held it. `unreachable`
is the seat not reached; `timeout` is a waited frame written on the socket and no reply inside the window; `refused` is nothing
being sent on purpose.

## Example

A plain send is a drop file and one trigger; with `--wait`, the run blocks for the reply and prints it:

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

```console reply="the gate is green"
$ team send claude-keeper "the gate is green" ; echo "exit $?"
claude-keeper: delivered
exit 0
$ team send claude-keeper "is the gate green?" --wait ; echo "exit $?"
claude-keeper: answered
the gate is green
exit 0
```

Rationale, the drop file and the socket frame, what it reads and writes, every reason behind the outcomes, the other shapes, the dry
run, that broadcast is not in this build, and the known limits: [docs/internal/send.md](../internal/send.md).
