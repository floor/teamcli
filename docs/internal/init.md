# `team init`: rationale and known limits

What moved off [the `team init` page](../commands/init.md): what the run reads and writes,
the skeleton and its `trust:` block, the behaviour behind the lines it prints, the refusals in
their own words, and the known limits. The synopsis, the flags, the caller table and the exit
codes stay on the page.

## What the run does: the skeleton, the restore, the exclude lines

Writes the team file: a skeleton for this project, or the copy of `.agents/team.yaml` this machine
stored. It also lists the team file and its runtime files in `.git/info/exclude`,
so git never sees them and a fresh clone never carries them.

## What it reads and writes

Reads the git repository (`findRoot`, `HEAD`, the git common directory) and, with `--restore`, the
user-level store (`~/.config/team/<project>-<hash>/approved.yaml`).

Writes `.agents/team.yaml`, adds the missing lines to `<git common dir>/info/exclude`, and appends
one line to `.agents/team.log`:

    .agents/team.yaml
    .agents/team.state.json
    .agents/team.log*
    .agents/team.lock
    .agents/seat-locks
    .agents/messages/
    .agents/send-drops/
    .agents/leases/
    .agents/hooks/
    .agents/seat-state/
    .agents/broker.sock
    .agents/broker.sock.lock
    .agents/broker.sock.lock.takeover
    .agents/broker.sock.lock.*.new
    .agents/bus.sock
    .agents/bus.sock.lock
    .agents/bus.sock.lock.takeover
    .agents/bus.sock.lock.*.new

The skeleton is validated before it is written. Its `trust:` block names the machine lobby and this checkout:

    trust:
      - ~/.config/team/lobby
      - <the project root, as an absolute path>

An entry names a folder of the team's own; it is never a folder that contains the project, the home, or `team`'s own folders.

A file that already exists is never overwritten,
and no history is ever rewritten. The skeleton begins with a `# yaml-language-server: $schema=…` line so editors validate it against the package schema in `schema/team.schema.json`.
That line names the schema of the release that wrote the file — the tag `v` plus the version
`team --version` prints — so it never follows a moving branch.

## Who may run it

The owner, from a terminal outside herdr. A seat or an agent-run CLI is refused with the caller
named. A run with no terminal is refused with one sentence, before the repository is read.

## What it prints

`Wrote .agents/team.yaml: a skeleton with one seat. Edit it, then run team up.`, or
`Restored .agents/team.yaml from the copy this machine stored.`, followed by the
privacy paragraph: the file is private to this clone, listed in `.git/info/exclude` and never in
`.gitignore`, so git doesn't see it and a fresh clone doesn't carry it; a collaborator writes
their own, or receives one and uses it as their own.

Under `--json` the run writes one `team.init` v1 document on stdout, its `schema` tag first:
`format`, `dry_run` (always false), `status` (`wrote`, or `restored`), `action_summary` — the
closing line above — `file` (`.agents/team.yaml`), `restored`, and `notes`; the privacy paragraph
is plain prose and has no field. A refusal under `--json` writes a `team.error` v1 document on
stdout instead — the refusal's own `id`, its `message` and `repair` — and stderr stays empty. The
exit code is the same as without `--json`.

## Refusals

| Message | Exit |
| --- | --- |
| `team init: only the owner runs this, from a terminal outside herdr` — a run with no terminal | 1 |
| `team init: only the owner runs this, from a terminal outside herdr; this call is <caller>` | 1 |
| `team init: not inside a git repository` | 2 |
| `team init: .agents/team.yaml is tracked by git, and a team file is private. Untrack it, keeping the file:` … | 1 |
| `team init: .agents/team.yaml exists already; it is left as it is. Its lines in .git/info/exclude were checked, and added where missing.` | 1 |
| `team init: nothing to restore: no copy of a team file was stored for this folder on this machine. Run team init for a skeleton.` | 1 |
| `team init: nothing was restored: the record for this folder was approved before records were signed.` — the record was written by an earlier `team`; the same shape, with the case, for a record that does not verify | 1 |
| `team init: nothing was restored: no archive at <folder>: it holds no manifest.json` — and the same shape for a manifest that doesn't parse, is not a `teamcli-archive` of `format: 1`, names no team file, or is a folder without its `team.yaml` | 1 |
| `team init: nothing was restored: team.yaml in <folder> is not the file the manifest recorded: its sha256 is <got>, the manifest's is <recorded>` | 1 |
| `team init: nothing was written: the archived team file doesn't validate: <the validator's first message>` | 1 |
| `team init: --restore and --from-archive are two sources for the one file: pass one of them.` | 2 |
| `team init: unknown option --<name>` (with the usage) | 2 |

The tracked-file message names the repair:

    team init: .agents/team.yaml is tracked by git, and a team file is private. Untrack it, keeping the file:
      git rm --cached .agents/team.yaml
    then run team init again. History is not rewritten.

## Restoring from an archive

`--from-archive <folder>` reads a folder [team archive](../commands/archive.md) wrote — or one a
person kept elsewhere; the folder's name decides nothing. `<folder>` may be relative to the
caller's own folder. The run reads `<folder>/manifest.json` first: it must parse, be
`kind: teamcli-archive` and `format: 1`, and name a team file's sha256. Then it reads
`<folder>/team.yaml`, hashes the bytes it read — not the text it decoded, so the copy cannot be
re-encoded on the way — and refuses anything that does not match the manifest. The file is
validated as a team file, and written verbatim: a restore never edits the file it restores, and
the placement it was archived with is the owner's to repair.

Only the team file is restored. The archive's state and queues are named on stdout and left
alone: state records panes, worktrees and readings of the machine the archive was taken from.
The line printed names the archive's project, the root and moment it was taken, and the caller
that took it — all of them the manifest's fields, whatever the archive's writer put there. The
`teamcli` version the archive was written with stays in the manifest and the log line, never on
stdout: the printed sentence is the same on every release, which is why a page may pin it.

Neither `--restore` nor `--from-archive` is a create a create-grant's `runner` stands behind: a
granted caller gets the skeleton alone, as it did before this flag existed.

## Examples, moved here whole

The examples below are the page's own, moved here whole, in the order they stood in. The
first console is also on [the `team init` page](../commands/init.md); the rest stand only in this
note and are not executed by any test — `test/docs.test.ts` reads `docs/commands/` alone.

A seat can't run it:

```console caller=agent
$ team init ; echo "exit $?"
team init: only the owner runs this, from a terminal outside herdr; this call is unplaced (it is run by an agent (claude) outside herdr)
exit 1
```

With nothing stored on this machine yet, `--restore` has nothing to bring back:

```console
$ team init --restore ; echo "exit $?"
team init: nothing to restore: no copy of a team file was stored for this folder on this machine. Run team init for a skeleton.
exit 1
```

A fresh clone gets a skeleton, with the head commit in a comment so `check` can read a history the
team file knows nothing about yet:

```console
$ team init
Wrote .agents/team.yaml: a skeleton with one seat. Edit it, then run team up.

The team file is private to this clone: it is listed in .git/info/exclude, never in .gitignore,
so git doesn't see it and a fresh clone doesn't carry it. A collaborator writes their own, or
receives one and uses it as their own.
```

Running it again never touches the file:

```console
$ team init ; echo "exit $?"
team init: .agents/team.yaml exists already; it is left as it is. Its lines in .git/info/exclude were checked, and added where missing.
exit 1
```

A team file that git tracks is refused, because the file is the clone's, not the repository's:

```git
add -f .agents/team.yaml
```

```commit
Add the team file
```

```console
$ team init ; echo "exit $?"
team init: .agents/team.yaml is tracked by git, and a team file is private. Untrack it, keeping the file:
  git rm --cached .agents/team.yaml
then run team init again. History is not rewritten.
exit 1
```
