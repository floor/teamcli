# team tempo

Sets the team's tempo. `relaxed` doubles the watch's idle and nudge waits, `urgent` halves
them, and `normal` leaves them as written. The five waits stay as the file wrote them; the
word is what scales them, and `relaxed` or `urgent` takes effect when the file is approved.
The owner alone runs it, from a terminal outside herdr.

## Synopsis

    team tempo <word>

`<word>` is `relaxed`, `normal` or `urgent`.

## What it reads and writes

Reads the team file in the current folder. Writes one line, `tempo: <word>`, after `format:`
when the key is missing, or on the line that already names it. The rest of the file is left
as it is. A line that already says that word is not rewritten.

## Who may run it

| Caller | May |
| --- | --- |
| the owner, from a terminal outside herdr | set the word |
| a run with no terminal | nothing: `team tempo: only the owner runs this, from a terminal outside herdr` |
| a seat, or an agent-run CLI | nothing: `team tempo: only the owner runs tempo, from a terminal outside herdr; this call is <caller>` |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the word was written, or it was already that word | `tempo: <word>`. A written `relaxed` or `urgent` also says it takes effect when the file is approved | 0 |
| refused: not the owner | `team tempo: only the owner runs tempo, from a terminal outside herdr; this call is <caller>` | 1 |
| it can't run: a bad word, a missing word, or the team file can't be read | `team tempo: <problem>`, with the usage for a bad word | 2 |

## Example

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
```

The owner sets it:

```console
$ team tempo urgent ; echo "exit $?"
tempo: urgent
team tempo: it takes effect when the file is approved
exit 0
```

The same word again leaves the line:

```console
$ team tempo urgent ; echo "exit $?"
tempo: urgent
exit 0
```

A word the file does not know is the usage:

```console
$ team tempo faster ; echo "exit $?"
team tempo: "faster" must be relaxed, normal or urgent
Usage: team tempo <word>
exit 2
```

A seat can't run it:

```console caller=agent
$ team tempo urgent ; echo "exit $?"
team tempo: only the owner runs tempo, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr)
exit 1
```
