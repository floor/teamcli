# team doctor

Reads the machine and says what the team needs before it can run: whether this file is the one the
owner approved, whether herdr and each seat's CLI are installed, at the tested version and logged in,
whether each launch names the model the file says, whether a watch has run for the session, and what
each approved budget check reads right now. `up` and `add` refuse until the missing ones that block
them are done; the last line counts those.

## Synopsis

    team doctor [--session <name>] [--file <path>] [--login]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session to report on, instead of `team.session` |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml` |
| `--login` | — | the seats' CLIs' logins alone, one line per CLI, instead of the whole report; herdr, the session and the machine are not read |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| anyone, in any terminal | run the whole report, `--file` included: it writes nothing, whoever runs it and whatever file it reads |
| the owner | the same, and the budget checks' readings; any other caller gets the same report without them |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| nothing is missing; warnings do not change this | one line per finding, its level (`ok  `, `warn`, `MISS`, `--  `) first, then the count: `team doctor: nothing missing, 1 warning` | 0 |
| at least one `MISS` | the same report, then the count and how many of the missing ones block `up` and `add` | 1 |
| the invocation or the team file can't be read | `team doctor: <problem>`, with the usage for the invocation | 2 |

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

budgets:                       # owner-only; the checks run from the approved copy
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [check], check: .agents/openai-quota }

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

The account's check is a script of the owner's, hashed at approval; a fake one stands in here:

```file file=.agents/openai-quota exec=1
#!/bin/sh
echo "weekly 40% used"
```

```fixture
tools:
  codex: missing
```

Everything here is as it should be:

```console
$ team doctor ; echo "exit $?"
warn  the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
warn  claude-beacon: its name repeats "beacon"; the session already carries it
ok    the file is the one the owner approved (approval #1, 2026-10-04, key fe21ef6293de)
ok    the check for openai reads weekly 40% used
ok    herdr 0.7.1
--    session beacon is running
ok    claude 2.1.288
ok    claude-code: logged in
ok    the watch is running
ok    the lobby ~/.config/team/lobby: will be created at the first launch
team doctor: nothing missing, 2 warnings
exit 0
```

`--login` reads the logins alone — one line per CLI the file's seats use, said once — and no herdr,
session or machine:

```console
$ team doctor --login ; echo "exit $?"
ok    claude-code: logged in
team doctor: nothing missing, 0 warnings
exit 0
```

Rationale, behaviour, refusals and known limits: [docs/internal/doctor.md](../internal/doctor.md).
