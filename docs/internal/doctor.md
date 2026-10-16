# `team doctor`: rationale and known limits

What moved off [the `team doctor` page](../commands/doctor.md): what the run reads and
writes, how each line of the report is read, the behaviour behind the levels, the refusals in
their own words, and the known limits. The synopsis, the flags, the caller table and the exit
codes stay on the page.

## What the run does: the report and the machine it reads

Reads the machine and says what the team needs before it can run: whether herdr and each seat's CLI
are installed, at the tested version and logged in,
whether each launch names the model the file says — and, when it names none, what checks the model
the seat really runs — whether each seat's launch line can run in the folder the seat starts in,
whether a watch has run for the session, and what each approved budget check reads right now. `up`
and `add` refuse until the missing ones that block them are done; the last line counts those.

## What it reads and writes

Reads the team file (or the one `--file` names) and its warnings, this machine's approval store, the
session's state (`.agents/team.state.json`, for the watch's heartbeat), herdr's version and whether
the session is running, and, for each CLI a seat uses, `<binary> --version` and its login check. A
launch line is read the way `team` splits it — the first word that isn't a variable assignment, and
the arguments written `./…`, `../…` or `~/…` — and each is looked for where the line will run: the
folder the seat starts in, which for a seat that works in worktrees is the lobby, never a launcher
run to find out. The first word is checked before the rest is read: a line whose program is missing
is a `MISS` whatever follows it, and a first word that is one fully quoted literal — `"claude"`,
`'zcash'` — is checked with the quotes removed, the way a shell would run it, the quotes printed
back with the word; a quoted `"~/x"` is a pathname with a literal `~`, not the home. A program
written as a path is read the way main's launcher check read it — it must be there and executable,
not merely there. A line with a word that quotes or substitutes text is left alone and reported as
not checked, never refused — the first word is the one exception, and only when it is a fully quoted
literal, read above. A relative argument is a note, never a refusal — its meaning is not knowable
and the command may create the path — with one exception: the first word is `sh`, `bash` or `zsh`
(by name or by path), its first argument is the script, not an option (an argument starting with `-`),
and that relative path is found from the project root and not from the seat's start folder (an
option-bearing line such as `zsh -x ../x` is a note, not a refusal); the shell cannot start without
it and is a `MISS`. The owner's `doctor` also
runs each approved account's check command once, the way the watch runs it; the command's raw output
is parsed and dropped, never shown. The machine's own swap is read for the one check a reading can
show this machine cannot pass — `swap_free_min` above what the machine has in total (macOS's
`vm.swapusage`, Linux's `/proc/meminfo`). It writes nothing.

## Who may run it

Anyone, in any terminal. It needs no approval of its own — reporting on the approval is its work.
The budget checks run only for the owner, whose approvals they are; any other caller gets the same
report without the readings. `--file` may be aimed by any caller: `doctor` writes nothing at all,
whoever runs it and whatever file it reads.

## What it prints

One line per finding, the level first, then two spaces:

    warn  claude-beacon: its name repeats "beacon"; the session already carries it
    warn  claude-beacon: the launch starts Claude Opus 5.5, the file says Claude Sonnet 5.5
    note  codex-scribe: the model is chosen by its launcher; checked on the running seat
    MISS  install `codex`: it is not on the PATH (codex: codex-scribe)
    note  session beacon is running

| Level | Meaning |
| --- | --- |
| `ok  ` | as it should be |
| `warn` | worth knowing; `up` and `add` go ahead |
| `MISS` | a reason to refuse: something has to be installed or logged in first, or a record the machine cannot verify |
| `note` | neither: a note, like whether the session is running |

The findings come in order: the file's own warnings — each deprecated key among them, with the
repair `team check` prints — one warning per seat whose name or label
repeats the project or the session (the session already carries it; the warning never refuses the
file), the approval — no line when there is no record or the record verifies, and one `MISS` with the case when the record is legacy (`approved before records were signed`) or refused — a `note` when another folder for this root still holds an approval, naming that folder and leaving it in place — the override file when it is not the approved copy or cannot be parsed (a
missing line either way: `up` and `add` refuse, and the approved copy stays in force — or the
shipped profiles, when nothing was approved), each account whose `check`
command is unapproved, or no longer matches the file hashed at approval (a warning either way: that
account reads unknown, and `up` and `add` still
run), the budget checks, then each seat of the live file whose rules travel as a first
message: its file in the project state folder — missing, a symbolic link, not a regular file,
wider than `0600`, not the owner's, unreadable, or holding something other than the rules text the
live file gives it — is one `warn` (`codex-scribe: its rules file differs from the team file's
rules; run team reload codex-scribe`), never a rewrite: the file is written at a delivery, and a
delivery happens only at a launch — which `up` skips for a ready seat, so the line names
`team reload`, which closes the ready seat and launches the file's line. herdr, one CLI at a
time (its version, its login, then each of its seats' launchers and models), one line per seat whose launch
line can't run where the seat starts (the `MISS` names the start folder, the program that is missing
or not executable, and when the same file resolves from the project root, its path to write
instead; a line only said to be unchecked, or a relative path that exists nowhere yet, is a `note`
note — `not checked: the command may create it`), one note per seat the state records from a launch
that predates the process identity — `note  <seat>: launched before team recorded its process; run
\`team register <seat>\` to record its process` — the registration being what completes the record
(the seat's id and the pane's process identity, nothing relaunched). A record whose launch wrote
the pane's process but not the seat's id draws the sibling note — `note  <seat>: launched before
team recorded its id; run \`team register <seat>\` to record it` — the id being the one `team seats`
shows as `-`. A lead's own seat — the
orchestrator or the operator — draws neither note: it is the seat reading this line, and a
whole-team restart is never the repair — one note per live seat
whose file still carries the placeholder `version: "0"` `init` writes, saying what it runs and the
one edit that pins it (or a warning when the model family differs, so the one edit covers both) — the watch, and the
`trust` note. A seat the file
stops is left out of the CLI findings and the launch lines. A CLI outside its tested range keeps its
`warn` and says what that means: its screens are untested with this version, and a seat that isn't
read at launch is left out, never typed into (herdr's version line says just where it sits — herdr
has no screens). The last line counts them, and — the same rule `up` and `add` refuse on — says
how many of the missing ones block those commands, when any do:

    team doctor: nothing missing, 1 warning
    team doctor: 2 missing, 0 warnings: 2 of them block `up` and `add`

The `trust` note is the one finding that carries a whole block. A file whose `trust` still holds the
relative entries an earlier release wrote — or none at all — is told every absolute entry the next
`up` will require, as a block to paste under `trust:`: the lobby, the project root, the folder
`workspace.path` places worktrees in, each seat's start folder when it sits outside the project, and
every entry the owner added by hand, kept in absolute form. One line after the entries says which
key of the file each one comes from and which old entry it replaces, and nothing the block lists
widens what the old file trusted. An entry a rule of `trust` refuses — a folder that would cover the
home, or the lobby and the approval store — is never suggested: one line names the key that forces
it and leaves the choice of folder to the owner. The note is told only while the file really is
legacy; once the absolute entries are written, the approval finding carries the next step.

A seat's model is judged by what can check it, and a launch that names none is judged by two
questions. First, does the launch run the CLI's own binary, bare: the first word that is not a
variable assignment is the binary's own name, with no path, wrapper or shell in front of it —
`claude` and `VAR=1 claude` do; `/opt/x/claude`, `env claude`, `npx claude` and `zsh -c claude` run
another program, whose choices are not the CLI's own. Second, can the CLI's screen name the model
the file declares — asked with the same rules `status` reads the running seat's model with, so a
model another maker spells may be unread on it. Both yes, and nothing prints: `status` and the
watch read the model off the running seat's screen and flag a seat that runs something else.
Either no, and one warning names what the owner can do:

    warn  <seat>: the launch runs <first>, not <binary>, and names no model: if the launcher chooses the model, say so with model_from: launcher
    warn  <seat>: no model flag, and this version can't read <declared> on this CLI's screen: nothing checks that it runs it
    warn  <seat>: the launch names no model this version knows; the file says <declared>

The first is a launch that runs another program; the second, the CLI's own binary under a screen
that cannot name the declared model, so nothing would flag a seat that runs something else; the
third, a CLI this version knows to start on its last-used model. A seat may say outright that its
launcher chooses the model, with `model_from: launcher`: the owner wrote the key and approved it,
and the finding is a note — `note  <seat>: the model is chosen by its launcher; checked on the
running seat`, or, when the screen cannot name the declared model, `note  <seat>: the model is
chosen by its launcher (declared in the file); this version can't read <declared> on this CLI's
screen, so nothing checks it`. A real multi-vendor file may still warn; every one of these lines
names what the owner can do. The model the file declares is spelled by the seat's `display` in
every line that names it.

The placeholder `version: "0"` a fresh `init` writes before the owner fills the release number no
longer stops a seat's first launch — the launch compares the model family only — so a seat that
runs despite it is said as information: `note  <seat>: runs Claude Opus 5.5; the file's version "0"
is the placeholder init writes — write "5.5" into the file. The note is
said only for a live seat whose screen names a model of the family the file declares; a seat on
another family keeps the launch's own line. No other spelling is the placeholder: `version: "0.0"`
stops the launch as any mismatch would. Nothing is lost by it — a "0" never pinned a release — and
pinning the number is one edit of the live file.

A seat the state records waiting at **trust** gets one line of its own. A fresh read of its pane
must show the recorded trust dialog — the same reading `team answer` checks, and the reason the
line moves to `warn` when it does not:

    note  claude-beacon: waiting for owner at trust
    warn  claude-beacon: waiting at trust; its pane can't be read
    warn  claude-beacon: waiting at trust; the pane is not the trust dialog
    warn  claude-beacon: waiting at trust; this version has no trust answer
    warn  claude-beacon: waiting at trust; the folder is not the lobby

Every `warn` is a `warn` and never a `MISS`: it blocks `team answer` and every key `team` could
send, and leaves the owner's own path through `team up` open. A seat in `trust-sent-recovery` is a
`warn` with its repair — `warn  <seat>: trust sent; recovery required; a lead runs team up` —
and the line never claims a trust dialog is still on screen. A seat waiting at any other
classification prints nothing new here: [team status](status.md) carries it.

The key's fingerprint is the first twelve hex digits of the signing key's public half. What it
proves is narrow: an owner who noted it sees a *replaced* key — a process that only reads the
key changes nothing `team` shows. `team` computes it, and a seat could also replace `team`.

The budget checks run from the approved `budgets` copy, the way the watch runs them: the approved
command's file, hashed again before it runs, with the watch's timeout. A check that was changed
after its approval never runs — the warning above says so. One line per account that names a
check: the reading it gave (`ok  `), or that its output broke the contract, or that it failed or
timed out (both `warn`: that account reads unknown; neither changes the exit code). The command's
raw output is never shown, logged or written anywhere, and a reading is reported, not stored. A
caller who is not the owner runs no check: one line says so, and everything else is as the
owner's. An account nothing can read — its `sources` name the status line but no seat's CLI
ships a quota pattern for it — has a warning of its own: `no pattern can read this account`. An
account read only by a check is fine.

`--login` reads the logins alone: one line per CLI the file's seats use, in the order the seats first
name them, then the same last line. A login check that passed is `ok  `; one that failed is `MISS`,
with the command that logs in; a CLI that can't be asked — one with no login check, or no launch
profile in this version — is `note`.

`--jules` reads the Jules CLI's own steps alone, the same way, and never signs in. Whether the CLI is
on the PATH comes first: not there is one `MISS` naming `npm install -g @google/jules`, and nothing
further is read — there is no binary to run. Then the one call `jules remote list --repo` answers
the login and the GitHub link together: a refusal or a non-zero status is one `MISS` naming `jules
login` — the refusal is repeated, never parsed, so which half is missing is the CLI's own line to
say, and the first line it printed stands after the `MISS` when it printed one — and the repository
is not asked about. An answer lists the connected repositories in `owner/repo` lines; the project's
own is read
from its `origin` remote (`git -C <root> remote get-url origin`, github.com only) and looked for in
them. Absent is a `MISS` naming `https://jules.google.com`; an origin that cannot be read as a
github repository is a note, never a guess, and the login line stands on its own. A `--jules`
finding never reaches a launch — `up` and `add` run the full report, which does not read Jules — so
its summary prints no block clause.

A watch that has not run, or whose heartbeat is old, is `MISS` here but not a reason for `up` to
refuse: `up` starts the watch itself. A recorded pane the session no longer has is `MISS` too.
This miss is not a reason for `up` to refuse.

Under `--json` the run writes one `team.doctor` v1 document on stdout, its `schema` tag first:
`format`, `project`, `session`, `login_only`, every finding as `{ level, text, blocks_launch }` —
the same levels and lines the plain report prints, with `blocks_launch` the `up`/`add` rule — and
`summary` with `missing`, `warnings` and `blockers`, the plain closing line's own figures, plus
`must_not_pretend` (with each plain sentence and its Kernel `ref` when not `--login`). An invocation
or file refusal under `--json` writes a
`team.error` v1 document on stdout instead — `id` `doctor.invocation`, `doctor.not-a-repo`,
`doctor.file` or `doctor.file-invalid`, its `message` and a null `repair` — and stderr stays
empty. The exit code is the same as without `--json`.

## Refusals

| Message | Exit |
| --- | --- |
| `team doctor: unknown option --x` / `team doctor: unexpected "x"` / `team doctor: --session needs a value` (each with the usage) | 2 |
| `team doctor: --login and --jules answer different questions; ask one at a time` (with the usage) | 2 |
| `team doctor: line <n>: <message>` / `team doctor: <message>` | 2 |

## Examples, moved here whole

The examples below are the page's own, moved here whole, in the order they stood in. The
first console is also on [the `team doctor` page](../commands/doctor.md); the rest stand only in
this note and are not executed by any test — `test/docs.test.ts` reads `docs/commands/` alone.

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

The lobby line is the same closed-tree check the launch's gate runs, over the same set of declared
files (every shipped profile's together, so the report says of the lobby exactly what a launch
would). When the lobby already exists it reads `verified`, and one line follows for each declared
file the folder holds, naming the profile it belongs to — the folder is shared by every team on
the machine, so a file another team's CLI left is named with whose it is:

```console
ok    the lobby ~/.config/team/lobby: verified
ok    the lobby ~/.config/team/lobby: .claude/scheduled_tasks.lock is claude-code's
```

The machine's own swap is read for one case only: the check in force — the 2GB default, or the
file's own `swap_free_min` — asks for more free swap than this reading says the machine has in
total. One warning names both figures and the repair, the key to write and the approval a change
needs, and it speaks of the reading it was made from: on macOS the total moves with pressure, so a
later reading can show a different one:

```console machine="small-swap"
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
warn  the machine check asks for 2.0 GB free swap; at this reading the machine has 1.0 GB in total, so this reading cannot meet it; set `machine.swap_free_min` to a figure this machine can keep
team doctor: nothing missing, 3 warnings
what 0.5.0 must not pretend:
  The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.
  A right given to a team or a seat stands until it is revoked, and may carry an end date; a seat cannot lend a right to another seat for a task and take it back when the task is done.
  Three ways of sharing control are not built yet — a grant co-signed by a second person, a seat approving an identical copy of another seat, and an agent creating a team within pre-set limits — so only the owner grants rights and adds seats.
  Four things are not checked yet: which project files a seat may see, acting under an account the owner holds — GitHub, Linear, email — using the broker, and deploying a release.
  Apart from one lead seat per team and no seat starting with two exclusive rights, nothing else about how a team is put together is enforced: no limit on how many seats hold a right, no rule that a change is merged by a different seat from the one that wrote it, and no rule that a reviewer comes from another lab.
exit 0
```

A check that merely fails right now — the machine has the swap in total, and not enough of it
free at this moment — prints nothing of this: the watch's `swap-free` check reports it as its own
finding. The line above is only for the case the file can fix, and it describes the reading it
came from: on macOS the total moves with pressure, so it promises nothing about a later reading.
The total is read on macOS from `sysctl -n vm.swapusage`, and on Linux from `/proc/meminfo`'s
`SwapTotal`; a machine with no swap at all is not this case — nothing here guesses one, and free
swap does not refuse a launch.

A CLI outside the range this version was tested with keeps its warning and says what that means —
herdr's own version line says only where it sits, for the same reason:

```console tools="claude-code=old"
$ team doctor ; echo "exit $?"
team beacon, session "beacon"
warn  the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
warn  claude-beacon: its name repeats "beacon"; the session already carries it
ok    the check for openai reads weekly 40% used
ok    herdr 0.7.1
note  session beacon is running
warn  claude 2.1.200 is older than the tested 2.1.288: its screens are untested with this version; a seat that isn't read at launch is left out, never typed into
ok    claude-code: logged in
ok    the watch is running
ok    the lobby ~/.config/team/lobby: will be created at the first launch
team doctor: nothing missing, 3 warnings
what 0.5.0 must not pretend:
  The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.
  A right given to a team or a seat stands until it is revoked, and may carry an end date; a seat cannot lend a right to another seat for a task and take it back when the task is done.
  Three ways of sharing control are not built yet — a grant co-signed by a second person, a seat approving an identical copy of another seat, and an agent creating a team within pre-set limits — so only the owner grants rights and adds seats.
  Four things are not checked yet: which project files a seat may see, acting under an account the owner holds — GitHub, Linear, email — using the broker, and deploying a release.
  Apart from one lead seat per team and no seat starting with two exclusive rights, nothing else about how a team is put together is enforced: no limit on how many seats hold a right, no rule that a change is merged by a different seat from the one that wrote it, and no rule that a reviewer comes from another lab.
exit 0
```

A seat's `doctor` runs no check — only the owner's approvals may run them — and one line says so;
everything else is as the owner's:

```console caller=claude-beacon
$ team doctor ; echo "exit $?"
team beacon, session "beacon"
warn  the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
warn  claude-beacon: its name repeats "beacon"; the session already carries it
note  the budget checks were not run: only the owner runs them
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

A seat on a CLI that is not installed needs the file approved again, since it is new, and the CLI
installed:

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

  - role: researcher
    name: codex-scribe
    label: researcher
    cli: codex
    vendor: openai
    model: GPT Codex
    version: "5"
    launch: codex --model gpt-5-codex
```

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
MISS  install `codex`: it is not on the PATH (codex: codex-scribe)
ok    the watch is running
ok    the lobby ~/.config/team/lobby: will be created at the first launch
team doctor: 1 missing, 2 warnings: 1 of them block `up` and `add`
what 0.5.0 must not pretend:
  The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.
  A right given to a team or a seat stands until it is revoked, and may carry an end date; a seat cannot lend a right to another seat for a task and take it back when the task is done.
  Three ways of sharing control are not built yet — a grant co-signed by a second person, a seat approving an identical copy of another seat, and an agent creating a team within pre-set limits — so only the owner grants rights and adds seats.
  Four things are not checked yet: which project files a seat may see, acting under an account the owner holds — GitHub, Linear, email — using the broker, and deploying a release.
  Apart from one lead seat per team and no seat starting with two exclusive rights, nothing else about how a team is put together is enforced: no limit on how many seats hold a right, no rule that a change is merged by a different seat from the one that wrote it, and no rule that a reviewer comes from another lab.
exit 1
```

A launch that names another model than the file does is a warning, not a refusal — `up` starts what
the launch says:

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
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: researcher
    name: codex-scribe
    label: researcher
    cli: codex
    vendor: openai
    model: GPT Codex
    version: "5"
    launch: codex --model gpt-5-codex
```

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
warn  claude-beacon: the launch starts Claude Opus 5.5, the file says Claude Sonnet 5.5
MISS  install `codex`: it is not on the PATH (codex: codex-scribe)
ok    the watch is running
ok    the lobby ~/.config/team/lobby: will be created at the first launch
team doctor: 1 missing, 3 warnings: 1 of them block `up` and `add`
what 0.5.0 must not pretend:
  The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.
  A right given to a team or a seat stands until it is revoked, and may carry an end date; a seat cannot lend a right to another seat for a task and take it back when the task is done.
  Three ways of sharing control are not built yet — a grant co-signed by a second person, a seat approving an identical copy of another seat, and an agent creating a team within pre-set limits — so only the owner grants rights and adds seats.
  Four things are not checked yet: which project files a seat may see, acting under an account the owner holds — GitHub, Linear, email — using the broker, and deploying a release.
  Apart from one lead seat per team and no seat starting with two exclusive rights, nothing else about how a team is put together is enforced: no limit on how many seats hold a right, no rule that a change is merged by a different seat from the one that wrote it, and no rule that a reviewer comes from another lab.
exit 1
```

A launch that names no model is not warned for its own sake: what the seat really runs is read off
its screen by `status` and the watch, and `doctor` says only what that reading cannot cover. Here
one seat launches through a wrapper script and gets the warning, with the repair in it; the other
starts the CLI's own binary bare, under a screen that can name the model the file declares, and
prints nothing at all:

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

  - role: researcher
    name: codex-scribe
    label: researcher
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: team-codex          # the wrapper picks the model and runs codex

  - role: implementer
    name: codex-reader
    label: implementer
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
```

```console tools="codex=fine"
$ team doctor ; echo "exit $?"
team beacon, session "beacon"
warn  the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
warn  claude-beacon: its name repeats "beacon"; the session already carries it
ok    the check for openai reads weekly 40% used
ok    herdr 0.7.1
note  session beacon is running
ok    claude 2.1.288
ok    claude-code: logged in
ok    codex 0.157.0
ok    codex: logged in
warn  codex-scribe: the launch runs team-codex, not codex, and names no model: if the launcher chooses the model, say so with model_from: launcher
ok    the watch is running
ok    the lobby ~/.config/team/lobby: will be created at the first launch
team doctor: nothing missing, 3 warnings
what 0.5.0 must not pretend:
  The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.
  A right given to a team or a seat stands until it is revoked, and may carry an end date; a seat cannot lend a right to another seat for a task and take it back when the task is done.
  Three ways of sharing control are not built yet — a grant co-signed by a second person, a seat approving an identical copy of another seat, and an agent creating a team within pre-set limits — so only the owner grants rights and adds seats.
  Four things are not checked yet: which project files a seat may see, acting under an account the owner holds — GitHub, Linear, email — using the broker, and deploying a release.
  Apart from one lead seat per team and no seat starting with two exclusive rights, nothing else about how a team is put together is enforced: no limit on how many seats hold a right, no rule that a change is merged by a different seat from the one that wrote it, and no rule that a reviewer comes from another lab.
exit 0
```

The wrapper is told by the launch line's first words: none of them is the CLI's own binary, so the
line runs something whose choices are not the CLI's own — but when the owner says so, with
`model_from: launcher` on the seat, the same launch is a note instead, saying what really checks
the model:

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

  - role: researcher
    name: codex-scribe
    label: researcher
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: team-codex          # the wrapper picks the model and runs codex
    model_from: launcher

  - role: implementer
    name: codex-reader
    label: implementer
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
```

```console tools="codex=fine"
$ team doctor ; echo "exit $?"
team beacon, session "beacon"
warn  the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
warn  claude-beacon: its name repeats "beacon"; the session already carries it
ok    the check for openai reads weekly 40% used
ok    herdr 0.7.1
note  session beacon is running
ok    claude 2.1.288
ok    claude-code: logged in
ok    codex 0.157.0
ok    codex: logged in
note  codex-scribe: the model is chosen by its launcher; checked on the running seat
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

`model_from: launcher` wins over the launch line's shape, whatever the shape is; the key is part of
the seat's approval, as any seat key is. When the CLI's screen cannot name the declared model, the
note says that instead — nothing checks the model, whatever the launcher does with it.

`--login` answers the one question that needs no herdr, no session and no machine — which CLIs have
an account to run under. Two seats share a CLI, so it is said once:

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

  - role: researcher
    name: codex-scribe
    label: researcher
    cli: codex
    vendor: openai
    model: GPT Codex
    version: "5"
    launch: codex --model gpt-5-codex
```

```console tools="codex=logged-out"
$ team doctor --login ; echo "exit $?"
ok    claude-code: logged in
MISS  log in to codex: `codex login`
team doctor: 1 missing, 0 warnings: 1 of them block `up` and `add`
exit 1
```

`--jules` names the first step the Jules CLI is missing. The machine this was written on has no
Jules CLI, so one line names the install and nothing else is read:

```console
$ team doctor --jules ; echo "exit $?"
MISS  install the Jules CLI: `npm install -g @google/jules` — the owner's step
team doctor: 1 missing, 0 warnings
exit 1
```

With the CLI installed, logged in and the repository connected, two `ok  ` lines stand in its
place — `jules: logged in, with GitHub linked` and `jules: <owner>/<repo> is connected` — and the
summary reads `team doctor: nothing missing, 0 warnings`.

A check that was edited after its approval never runs: the file on disk no longer hashes to what
the owner approved, and the account reads unknown. The file
itself is back to the approved one here; only the script changed:

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

```file file=.agents/openai-quota exec=1
#!/bin/sh
echo "weekly 99% used"
```

```console
$ team doctor ; echo "exit $?"
team beacon, session "beacon"
warn  the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read
warn  claude-beacon: its name repeats "beacon"; the session already carries it
warn  the check for openai changed after approval and was not run; that account reads unknown
ok    herdr 0.7.1
note  session beacon is running
ok    claude 2.1.288
ok    claude-code: logged in
ok    the watch is running
ok    the lobby ~/.config/team/lobby: will be created at the first launch
team doctor: nothing missing, 3 warnings
what 0.5.0 must not pretend:
  The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.
  A right given to a team or a seat stands until it is revoked, and may carry an end date; a seat cannot lend a right to another seat for a task and take it back when the task is done.
  Three ways of sharing control are not built yet — a grant co-signed by a second person, a seat approving an identical copy of another seat, and an agent creating a team within pre-set limits — so only the owner grants rights and adds seats.
  Four things are not checked yet: which project files a seat may see, acting under an account the owner holds — GitHub, Linear, email — using the broker, and deploying a release.
  Apart from one lead seat per team and no seat starting with two exclusive rights, nothing else about how a team is put together is enforced: no limit on how many seats hold a right, no rule that a change is merged by a different seat from the one that wrote it, and no rule that a reviewer comes from another lab.
exit 0
```

An option it doesn't know stops it before it reads anything:

```console
$ team doctor --nope ; echo "exit $?"
team doctor: unknown option --nope
Usage: team doctor [--session <name>] [--file <path>] [--login] [--json]
Exits 0 when nothing is missing, 1 when something is missing, 2 when the invocation or team file can't be read.
exit 2
```
