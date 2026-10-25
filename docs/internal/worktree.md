# `team worktree`: rationale and known limits

What moved off [the `team worktree` page](../commands/worktree.md): what the
subcommands read and write, how far the approved copy reaches, the behaviour behind the
lines they print, the refusals in their own words, and the known limits. The synopsis, the
flags, the caller table and the exit codes stay on the page. `list` prints every recorded
worktree in this state file — the same rows the limit counts — and writes nothing. A row
whose folder is gone names `team worktree remove <task>`, which drops that record and
prunes, and does not delete the branch.

## What new and remove do

Creates and removes a task worktree: a second checkout of the project on a branch of its own, where
one seat does one task. `new` cuts the branch from `workspace.base`, records the worktree in the
session's state and prints its action summary; `remove` deletes a worktree that holds nothing that would be
lost, and keeps its branch. The branch `remove` checks and names is the worktree's own, read from
`git worktree list --porcelain` — a branch renamed in place is still the one that must hold nothing
unpublished, and the record's branch is only a hint. A detached HEAD, or a folder the list does not
name, has no branch there; the record's branch stands for it then, as it always did.

## What it reads and writes

Reads the team file and this machine's approval store, the session's state
(`.agents/team.state.json`), and git: the base branch, the branch names, and the worktree itself.
With `--session`, the state of that session instead of `team.session`.

Every value the subcommands read from the file is the **approved copy's** while a verified
approval is in force, whatever the file says now and whether or not the fingerprints match:
`workspace` (mode, path, branch, base, setup and limit), `trust`, the caller rules (`orchestrator`
and `operator`), the session, the names a public project forbids, and the seats `--seat` may name.
An unapproved edit — a path moved, a setup command added, a trust pattern widened or narrowed, the
orchestrator or the operator changed, a seat added, removed, renamed or redefined — is never used.
A seat taken out of the file is still one until the owner approves that.

`project` is read from the file as it is now, not from the approved copy. It is not an owner
section, so renaming it needs no approval. `{repo}` in `workspace.path` is that current name, which
decides the folder `new` creates and the directory `workspace.setup` runs in.
It does not place a worktree outside the approved trust: the landing is still judged against the
approved `trust` patterns, and a landing outside them is refused before anything is created. A
rename that puts `{repo}` outside the file's own trust patterns makes the file invalid, so the
command never starts. A pattern wide enough to cover the new name (for example `../worktrees/*`)
keeps the new folder inside the approved trust.

When an owner section or a seat was added, removed or changed, the command prints one note on
stderr before its normal output and before a later refusal (the trust, the limit, an unapproved
seat):

    team worktree: using the stored workspace settings; the file has changed since that copy was stored

The exit code is the one the run itself has. The log line is unchanged: the note is not written to
`team.log`. A caller the approved copy does not allow is refused before the note, and nothing is
created. `project` itself is not this drift: a file that sets `session` and changes only `project`
prints no note. When `session` is omitted it follows the entity and the project name — the project
name alone when no entity is named — so a rename changes the session too. The live file is the
record, so the state lands under the new session name, and `{repo}` is the live name as well.

`--seat` is checked against the approved seats. The live seat list is read for one distinction: a
name the file declares and the stored copy does not gets `seat <name> is not in the stored
copy`; a name neither declares gets `--seat "<name>" names no declared seat`.

A verified record whose stored copy this version cannot read — empty, invalid, or otherwise — refuses
with `the stored copy can't be read`, whether or not the fingerprints match. A record whose `file`
is not a string never becomes a verified standing. The store refuses it first, and the command
prints that line unchanged: `the approval record cannot be read (... "file" is not a string)`.

Writes `.agents/team.log`, `.agents/team.state.json` (one record under the session: the folder, the
branch, the seat when `--seat` names one, and whether `workspace.setup` succeeded), and, with `new`,
the worktree itself and the branch it cuts.

The folder is `workspace.path` with `{repo}` and `{task}` filled; the branch is `workspace.branch`
with `{kind}` and `{task}` filled. `new` fetches the base's upstream when it has one, and starts from
the local base, with a note in the log, when it doesn't. Nothing is created when the fetch fails.
`remove` reads the branch from `git worktree list --porcelain` instead: the entry whose folder is
this worktree's, and its ref. `--branch` gives the name it must find there; any other name, the
detached state included, is refused with `--branch "<name>" does not name the branch this worktree
is on ("<branch>"); nothing was removed`. When the list names no branch — a detached HEAD — or does
not name the folder at all, the record's branch stands, as it did before this read existed.

## Who may run it

The owner, the orchestrator's seat, and the operator's seat. The seat is that name's, in a session
this project's state records — the file's session, or one the state records the caller's pane in —
on the pane the state records for that name in that session: a seat of another session, or a pane
merely renamed to the orchestrator's or the operator's name, is refused — and so is a seat the state
records no pane for, or records on another pane than this call is on; those two refusals name the
seat and the repair. What that proves is placement, and no more: the state file is in the project,
and a process of the same user that writes its own pane there under the orchestrator's name, and
renames its pane, passes. The check guards a mistaken agent, not a hostile process running as the
same user.
`--file` and `--session` are the owner's alone, from a terminal outside herdr: a non-owner aiming
either is refused before the flagged file or session is read at all. `list`, `new` and `remove` refuse
the same way.

## What it prints

`list` prints the team's context line, its `TASK  BRANCH  PATH` table — a folder that is gone reads
`<path> (gone)` — the note line `note: limit <n> (workspace.limit)` and the count
`1 worktree` / `<n> worktrees`; it writes nothing. `new` prints the context line and
`worktree <task>: created at <path>`, and `remove` the context line and
`removed <task>; the branch <branch> is kept` — or, for a record whose folder was already gone,
`removed the record of <task>; its folder was already gone. No branch was deleted.`

Under `--json` each is one `team.worktree` v1 document on stdout, its `schema` tag first. `list`'s
carries `format`, `project`, `session`, `notice` (null), `worktrees` — one
`{ task, branch, path, session, seat, exists }` per record, `seat` null when none is recorded —
`notes` (the `limit` line) and `summary` (`{ worktrees }`). `new` and `remove` carry `format`,
`dry_run` (always false — neither has one), `status` (`created`, `removed`, or `record-gone` for a
folder that was already gone), `action_summary` (the line above), `project`, `session`, `action`
(`new` or `remove`), `task`, `branch` and `path`. A refusal under `--json` writes a `team.error`
v1 document on stdout instead — the refusal's own `id`, its `message` and `repair`, and no usage
text — and stderr stays empty. The exit code is the same as without `--json`.

## Refusals

| Message | Exit |
| --- | --- |
| `team worktree: a subcommand is required` / `unknown subcommand "x"` / `a task name is required` / `unexpected "x"` (each with the usage) | 2 |
| `team worktree: remove takes no --kind or --seat` (with the usage) | 2 |
| `team worktree: new takes no --branch` / `list takes no --branch` (with the usage) | 2 |
| `team worktree: line <n>: <message>` | 2 |
| `team worktree: --file is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team worktree: --session is the owner's, from a terminal outside herdr; this call is <caller>` | 1 |
| `team worktree: only the owner, the orchestrator or the operator runs it; this call is <caller>` | 1 |
| ``team worktree: no pane is recorded for seat <name> in this session: a lead stops that seat and runs `team up` `` | 1 |
| ``team worktree: the state records pane <pane> for seat <name> in this session, not the pane this call is on: a lead stops the team and starts it again (`team down`, then `team up`) `` | 1 |
| `team worktree: session can't be "default", herdr's own session` | 1 |
| ``team worktree: approved before records were signed`` — the record was written by an earlier `team`; the same line, with the case, for a record that does not verify | 1 |
| ``team worktree: the approval record cannot be read (<store>/approval.json: "file" is not a string)`` — the record's `file` is not a string; the store refuses it before this command reads a copy | 1 |
| ``team worktree: the stored copy can't be read `` — a verified record whose stored copy this version can't read, whether or not the fingerprints match | 1 |
| `team worktree: a task name is one segment of letters, digits, ".", "_" and "-", and it starts with a letter or a digit` | 1 |
| `team worktree: --kind: <the same, for the kind>` | 1 |
| `team worktree: workspace.mode is shared: this team keeps one checkout, so there is no task worktree to create` | 1 |
| `team worktree: workspace.path and workspace.base are required` | 1 |
| `team worktree: --kind is required: the branch pattern is "{kind}/{task}"` | 1 |
| `team worktree: --kind has nowhere to go: the branch pattern is "{task}"` | 1 |
| `team worktree: <folder> is outside the approved trust paths` | 1 |
| ``team worktree: seat <name> is not in the stored copy `` — a seat the file declares and the approved copy does not | 1 |
| `team worktree: --seat "x" names no declared seat` | 1 |
| `team worktree: "t" is already recorded` / `"t" is already recorded in session x` | 1 |
| `team worktree: the worktree limit is 8, and 8 are open (workspace.limit in the team file)` then one line per recorded worktree | 1 |
| `team worktree: <folder> already exists` / `branch <b> already exists` / `<remote>/<b> already exists` | 1 |
| `team worktree: "b" is not a branch name` | 1 |
| `team worktree: workspace.base "main" is not a branch here; nothing was created` | 1 |
| `team worktree: couldn't fetch <remote>: <first line>. Nothing was created.` | 1 |
| `team worktree: the worktree was not created: <first line of git's error>` | 1 |
| `team worktree: setup failed on command <n> of <m>; the worktree is kept and recorded as setup: failed` | 1 |
| `team worktree: no worktree named "t" is recorded` | 1 |
| `team worktree: "t" is recorded in session x, not in y; nothing was removed` | 1 |
| `team worktree: seat <name> is recorded in this worktree; team remove <name> first` | 1 |
| `team worktree: uncommitted or untracked files:` … the first twenty, one per line | 1 |
| `team worktree: the recorded path "<path>" is not "<folder>"; nothing was removed` — the state record's path is not `workspace.path` filled for the task | 1 |
| `team worktree: --branch "<name>" does not name the branch this worktree is on ("<branch>"); nothing was removed` — the branch read from `git worktree list --porcelain` (or, for a detached HEAD or an unnamed folder, the record's branch) is not the one given | 1 |
| `team worktree: commits on no remote branch:` … the first twenty, one per line | 1 |
| `team worktree: the worktree was not removed: <first line of git's error>` | 1 |

When `setup` fails, the created line is still printed on stdout before the refusal: the worktree is
kept, recorded as `setup: failed`, and the exit code is 1.

## Examples, moved here whole

The examples below are the page's own, moved here whole, in the order they stood in. The
first console is also on [the `team worktree` page](../commands/worktree.md); the rest stand only
in this note and are not executed by any test — `test/docs.test.ts` reads `docs/commands/` alone.

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon
  - ~/Code/worktrees/beacon

workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main

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

The project has a `main` for the branches to start from:

```commit
Sketch the layout
```

A seat that isn't the orchestrator or the operator can't create one:

```console caller=claude-beacon
$ team worktree new select-width --kind fix ; echo "exit $?"
team worktree: only the owner, the orchestrator or the operator runs it; this call is claude-beacon
exit 1
```

The branch pattern asks for a kind, so the command does:

```console
$ team worktree new select-width ; echo "exit $?"
team worktree: --kind is required: the branch pattern is "{kind}/{task}"
exit 1
```

The task name is one path segment, and nothing else:

```console
$ team worktree new "select width" --kind fix ; echo "exit $?"
team worktree: a task name is one segment of letters, digits, ".", "_" and "-", and it starts with a letter or a digit
exit 1
```

A good one creates the worktree and prints where it is:

```console
$ team worktree new select-width --kind fix
../worktrees/beacon/select-width
```

The same task can't be open twice:

```console
$ team worktree new select-width --kind fix ; echo "exit $?"
team worktree: "select-width" is already recorded
exit 1
```

A commit that lives only in the worktree keeps it in place:

```git
-C ../worktrees/beacon/select-width commit --allow-empty -m "Measure the pane"
```

```console
$ team worktree remove select-width ; echo "exit $?"
team worktree: commits on no remote branch:
  <sha> Measure the pane
exit 1
```

A worktree with nothing to lose goes, and its branch stays:

```console
$ team worktree new tidy-logs --kind chore
../worktrees/beacon/tidy-logs
```

```console
$ team worktree remove tidy-logs
removed tidy-logs; the branch chore/tidy-logs is kept
```

An edit to an owner-controlled value is not in effect until the owner approves it. Here the file has been changed
to `mode: shared` and a seat has been added, neither approved; the command says so once, and goes
on with the approved workspace:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - .
  - ../worktrees/beacon/*

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

  - role: implementer
    name: claude-later
    label: later
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```console
$ team worktree new read-back --kind fix ; echo "exit $?"
team worktree: using the stored workspace settings; the file has changed since that copy was stored
../worktrees/beacon/read-back
exit 0
```

The seat the file added is refused, because the approved copy doesn't declare it:

```console
$ team worktree new later-task --kind fix --seat claude-later ; echo "exit $?"
team worktree: using the stored workspace settings; the file has changed since that copy was stored
team worktree: seat claude-later is not in the stored copy
exit 1
```
