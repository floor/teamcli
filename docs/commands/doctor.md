# team doctor

Reads the machine and says what the team needs before it can run: whether herdr and each seat's CLI
are installed, at the tested version and logged in,
whether each launch names the model the file says, whether a watch has run for the session, and what
each recorded budget check reads right now. `up` and `add` refuse until the missing ones that block
them are done; the last line counts those.

## Synopsis

    team doctor [--session <name>] [--file <path>] [--login] [--jules] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--session` | `<name>` | the herdr session to report on, instead of `team.session` |
| `--file` | `<path>` | deprecated: a legacy team file to read instead of the team's registry record |
| `--login` | — | the seats' CLIs' logins alone, one line per CLI, instead of the whole report; herdr, the session and the machine are not read |
| `--jules` | — | the Jules CLI's own steps alone — installed, logged in with GitHub linked, and this project's repository connected to it — instead of the whole report; herdr, the session, the machine and the seats' CLIs are not read |
| `--json` | — | the report as one JSON document on stdout |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| anyone, in any terminal | run the whole report, `--file` included: it writes nothing, whoever runs it and whatever file it reads |
| the owner | the same, and the budget checks' readings; any other caller gets the same report without them |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| nothing is missing; warnings do not change this | one line per finding, its level (`ok  `, `warn`, `MISS`, `note`) first, then the count: `team doctor: nothing missing, 1 warning` | 0 |
| at least one `MISS` | the same report, then the count — `team doctor: <n> missing, <w> warning` / `<w> warnings` — and `: <n> of them block \`up\` and \`add\`` when any missing one blocks | 1 |
| the invocation or the team file can't be read | `team doctor: <problem>`, with the usage for the invocation | 2 |

Every line it prints is cleaned first: escape sequences, control characters and invisible format
characters carried by the team file, a pane or a CLI's own output are removed, so a value can
never move the cursor, paint the terminal or open a second line.

A hold on the team ([team hold](hold.md)) is the last `note` line before the summary:
`hold: <reason>`, or `hold until <instant>: <reason>`, naming `team hold --release` as what clears
it. It is a note: the summary's counts do not move, and no exit changes. A hold past its `until`
reads as none, so a lapsed one is not printed.

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

budgets:                       # owner-only; the budgets in force are the live file's
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

The account's check is a script of the owner's, hashed in the record; a fake one stands in here:

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
team beacon, session "beacon"
warn  the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
warn  claude-beacon: its name repeats "beacon"; the session already carries it
ok    the check for openai reads weekly 40% used
ok    herdr 0.7.1
note  session beacon is running
ok    claude 2.1.288
ok    claude-code: logged in
ok    the watch is running
ok    the lobby ~/.config/team/lobby: will be created at the first launch
team doctor: nothing missing, 2 warnings
what 0.5.0 must not pretend:
  The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.
  A right given to a team or a seat stands until it is revoked, and may carry an end date; a seat cannot lend a right to another seat for a task and take it back when the task is done.
  Three ways of sharing control are not built yet — a grant co-signed by a second person, a seat approving an identical copy of another seat, and an agent creating a team within pre-set limits — so only the owner grants rights and adds seats.
  Four things are not checked yet: which project files a seat may see, acting under an account the owner holds — GitHub, Linear, email — using the broker, and deploying a release.
  Apart from one lead seat per team and no seat starting with two exclusive rights, nothing else about how a team is put together is enforced: no limit on how many seats hold a right, no rule that a change is merged by a different seat from the one that wrote it, and no rule that a reviewer comes from another lab.
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

`--jules` reads the Jules CLI's own three questions the same way — installed, logged in with GitHub
linked, and this project's repository connected to it — and no herdr, session, machine or seat CLI:

```console
$ team doctor --jules ; echo "exit $?"
ok    jules: logged in, with GitHub linked
ok    jules: floor/beacon is connected
team doctor: nothing missing, 0 warnings
exit 0
```

A missing step is named one at a time, in this order, and the run stops at the first one — each
the owner's step:

```
MISS  install the Jules CLI: `npm install -g @google/jules` — the owner's step
MISS  log in to Jules and link it to GitHub: `jules login` — the owner's step
MISS  connect floor/beacon to Jules: https://jules.google.com — the owner's step
```

The login and the GitHub link are one step: the refusal is repeated, never parsed, so which half is
missing is the CLI's own line to say — `jules login` settles both. The command runs nothing but its
two reads — `jules remote list --repo` and `git remote get-url origin` — and never signs in.
`--login` and `--jules` answer different questions and are asked one at a time; both at once is an
invocation error.

Rationale, behaviour, refusals and known limits: [docs/internal/doctor.md](../internal/doctor.md).
