# team register

Writes the record for one seat that is already running, without touching it. `up` and `add` write a
seat's record in the run that launched it: a seat someone else started — an earlier `team`, or a CLI
run by hand in a session this team owns — is a live pane no command may address. `team add` answers
`is already running`, and `team up` refuses the whole session as one whose agents this file's state
does not record. `register` verifies such a pane and writes the record `up` would have written for
it, so `team send`, `team seats`, `team watch` and `team down` can address the seat from then on.

What it verifies is what herdr and the pane say: that herdr places an agent under that name in the
session's own workspace, that the pane holds a process in front of the pane's own shell and that
the process is the one the seat's CLI profile names — the file's `cli` is the authority, herdr's
`argv0` for the pane (or the agent name herdr reports for it) the reading — and that the screen is
the seat at its prompt — `idle` or `working`. A
dialog, a CLI that has exited, another CLI in front, or a reading this version does not recognise
is not a seat to record. Nothing is typed into the pane, and no workspace is created, closed or
renamed.

What it does not write is what only a launch knows: the state's `model`, `version`, `effort` and
`launch_line` are what a launch declared, and a pane started by hand declares nothing this run can
read. The file's seat is the authority for the CLI, and herdr for the pane, the workspace and the
agent session.

## Synopsis

    team register <seat> [--session <name>] [--dry-run]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session the pane is verified in, instead of `team.session`; the owner's alone |
| `--dry-run` | — | verify the seat and print the line the real run would print, writing nothing |
| `--help`, `-h` | — | the usage, and exit 0 |

## What it reads and writes

Reads the team file, the session's record in `.agents/team.state.json`, herdr (the session's state
and its agents), the pane's processes, the pane's text through the seat's own CLI profile, and the
team registry's record of this team, for its roster.

Writes `.agents/team.state.json` — the seat's record: its id, `stage: ready`, the CLI, the pane, the
workspace, the process identity read from the pane, the agent session herdr reports, and the
session's launched-file pointer — `.agents/team.log`, the launched-pane pointer under the home
directory, and the registry's agent and roster for the seat, the address a cross-session send
reaches it at included: the pane's live session socket, read and recorded the way a launch records
it. A record that names another pane, or
no pane at all, is never overwritten from here: stopping the team and starting it again is the
owner's own act.

A run that finds the seat already recorded on that pane writes nothing — save one line: where the
registry holds a record of the team and its roster does not list the seat, the roster line is
written, exactly as a launch writes it. The roster is the seat's identity for the permission bridge
(`src/permissions/who.ts`): a seat the roster does not list has no record there whatever the file
declares, and every gate wired to the bridge refuses it what the file says it holds. A roster that
already lists the seat, and a team the registry holds no record of — the bridge reads the file's own
declaration then — are both left alone.

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr; `--session` is the owner's own |
| a run with no terminal | nothing, unless an active create-grant covers this project: `team register: only the owner runs this, from a terminal outside herdr` |
| a caller the file's `delegates` section names for `up` | run it: a delegate gate that passes admits the record write, exactly as it admits the launch that would have written it |
| the seat the file's `grant` names for `up` | run it: the grant gate that admits the owner's `team up` admits the record write, and `--session` is refused in the grant's words — the owner's flag |
| anyone else | nothing: `team register: only the owner, a delegate this file names for \`up\`, or the seat a grant names for it registers a running seat; this call is <caller>` |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the seat's record was written | `<seat>: registered — pane <pane>; nothing was launched` | 0 |
| the seat was already recorded on that pane | `<seat>: already registered — pane <pane>; nothing was written` | 0 |
| the seat was already recorded, and the team registry's roster does not list it | `<seat>: already registered — pane <pane>; the team registry's roster did not list it, and was written` | 0 |
| the seat was already recorded and the roster does not list it, under `--dry-run` | `<seat>: already registered — pane <pane>; the team registry's roster would be written` | 0 |
| `--dry-run` succeeded | `<seat>: would register — pane <pane>; nothing would be launched` | 0 |
| the run was refused | `team register: <reason>` | 1 |
| the invocation or the team file can't be read | `team register: <problem>`, with the usage for the invocation | 2 |

## Refusals

| Message | Exit |
| --- | --- |
| `team register: unknown option <option>` / `team register: a seat name is required` / `team register: unexpected "<word>"` (with the usage) | 2 |
| `team register: line <n>: <message>` / `team register: <message>` — the team file can't be read or parsed, or the folder is not inside a git repository | 2 |
| `team register: only the owner runs this, from a terminal outside herdr` | 1 |
| `team register: --session is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team register: --session is the owner's; the granted seat cannot use it` | 1 |
| `team register: only the owner, a delegate this file names for \`up\`, or the seat a grant names for it registers a running seat; this call is <caller>` | 1 |
| ``team register: only the owner or the approved delegate runs `up`; this call is <caller>`` — the file's `delegates` section decided, and refused | 1 |
| `team register: only the seat the grant names runs this: this call is <caller>` / ``team register: the grant does not list `up` `` / `team register: a grant needs a verified approval: <why>` — the file's `grant` decided, and refused | 1 |
| `team register: the file has no seat "<name>"` | 1 |
| `team register: <name> is stopped in this file; the owner clears \`stopped\` and starts the team` | 1 |
| `team register: session can't be "default", herdr's own session` | 1 |
| `team register: herdr doesn't answer` | 1 |
| `team register: session "<session>" is not running; run team up first` | 1 |
| `team register: session "<session>" was launched from <file>; a seat is registered into its own team's session` | 1 |
| `team register: no agent named <name> is running in session "<session>"; nothing was registered` | 1 |
| `team register: session "<session>" has <n> agents named <name>; registering one would guess` | 1 |
| ``team register: <name> is already recorded on pane <pane>, not on <pane>; the owner stops the team and starts it again (`team down`, then `team up`)`` | 1 |
| `team register: <name>: pane <pane> holds no process in front of its shell; nothing was registered` | 1 |
| `team register: <name>: pane <pane> holds no \`<cli>\` process; nothing was registered` | 1 |
| `team register: <name>: its pane is not the seat at its prompt (<reading>); nothing was registered` | 1 |

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

  - role: implementer
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```fixture
agents: [claude-beacon]
```

The implementer's seat is up — herdr lists it, its pane holds a CLI at its prompt — and this
project's state records nothing for it, so no `team` command may address it. `register` writes the
record, and the pane is not entered:

```console
$ team register claude-beacon --dry-run ; echo "exit $?"
claude-beacon: would register — pane w1:p1; nothing would be launched
exit 0
$ team register claude-beacon ; echo "exit $?"
claude-beacon: registered — pane w1:p1; nothing was launched
exit 0
```

The record names the pane herdr showed, so a second run has nothing left to write:

```console
$ team register claude-beacon ; echo "exit $?"
claude-beacon: already registered — pane w1:p1; nothing was written
exit 0
```

The seat is now `team send`'s and `team down`'s to address, and the implementer's seat is not the
owner: it registers no seat, its own included:

```console
$ team register claude-keeper ; echo "exit $?"
team register: no agent named claude-keeper is running in session "beacon"; nothing was registered
exit 1
```

```console caller=claude-beacon
$ team register claude-keeper ; echo "exit $?"
team register: only the owner, a delegate this file names for `up`, or the seat a grant names for it registers a running seat; this call is claude-beacon
exit 1
```

A name the file does not declare is refused before herdr is asked anything:

```console
$ team register scratch ; echo "exit $?"
team register: the file has no seat "scratch"
exit 1
```
