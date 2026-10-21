---
created: 2026-10-19
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75); the child Git environment and the commit checks are also absent at int/0.5.1 (8acb470b)
for: Runtime (chapters B, D, I, J)
public: not yet; staged for review and port
---

# Spec: operational safety

## 1. Scope

This spec carries the Runtime's operational safety rules from the archived team-file, dialog,
delegate, seat-account and agent-setup designs: how a temporary seat and a worktree end; the one
writer over dialog state and the recovery behind `team answer`; the Git environment a launched
child receives; and the author and committer checks over commits that claim a seat.

It separates what is built at v0.5.0 from what is not. Seat lifecycle, launch and the state
record are [launch](launch.md)'s; the watch's authority and its reports are
[seat-state-and-watch](seat-state-and-watch.md)'s; capability admission is
[grants](grants.md)'s. The declared account fields and the values they map to are
[accounts and gates](accounts-and-gates.md) §3.4's; this spec says when those values are set and
what is cleared, and repeats none of the mapping.

None of these rules contains a process. Every seat runs as the owner's OS user, so the end
condition, the lock and the clearing below are mistake guards, not a boundary against a hostile
process of the same user.

## 2. Terms

- **End condition**: either `result:<path>`, which holds when the named path exists, or
  `merged:<branch>`, which holds when the branch's own commits were non-empty at an earlier pass
  and are empty now. The path is relative to the project root and read lexically.
- **Own commits**: commits reachable from a branch head and not from `origin/<base>`, read from
  the branch's own history after a fetch that succeeded in the same pass.
- **Free**: the watch's reading that a seat may be closed without input: herdr's `idle` or `done`
  status, or an `idle` screen for a profile herdr cannot report faithfully, with no dialog,
  question, unsent composer or working turn — so an idle seat whose CLI is still alive is free.
  Only a temporary seat is held to this test; a worktree is not.
- **Worked**: the seat has been observed `working` at least once since its rules were delivered.
  Only a temporary seat is held to this test; a worktree is not.
- **Seat lock**: one exclusive lock per session and seat, held for a command span.
- **Manual marker**: the archived dialog design's prose word `manual-owner-control`; at v0.5.0
  the marker is stored as `waiting.manual: true` on the `waiting-owner` record
  ([launch](launch.md) §3.5).
- **Recovery record**: the `waiting.state` value `trust-sent-recovery`, written before an answer
  key is sent ([launch](launch.md) §3.5).
- **Declared seat account**: the `github.account`, `github.author_name`, `github.author_email` and
  `github.keychain` fields of [accounts and gates](accounts-and-gates.md) §3.4.

## 3. Formats

### 3.1 End conditions and their proof

`result:<path>` holds when the lexical path, resolved under the project root, exists.
`merged:<branch>` holds when the branch's own commits, read with the same fetch in the same pass,
were non-empty at an earlier pass and are empty now.

- A branch with no own commit is never merged, including a fast-forward-only update of the base
  branch. A branch committed and merged between two passes is reported as merged, not removed:
  the earlier non-empty reading is missing.
- A failed fetch, or a branch that vanished, removes nothing and closes nothing.
- A squash or rebase merge is not followed by history: its end is reported as not provable and
  nothing is removed.
- A temporary seat's condition is acted on only when the seat has been `working` at least once
  since its rules were delivered and is `free`, so a copy that never started work is not ended
  by its own creation and a seat that is not free is left as it is. A worktree is judged without
  either test (§3.3).

`--until` is validated lexically before anything is created. The archived requirement rejects an
absolute path, `~`, every `..` path segment and any symlink in the path; only a lexical
descendant of the project root is accepted and the link is not followed. At v0.5.0 the first
three are built and the symlink rejection is not: `src/end/until.ts:resultPathProblem` checks the
path as written, never stats it, and accepts a contained name that is a symlink, and the
existence test that follows it (`src/watch/end.ts:readEnd`) follows the link.

A `merged:` value is validated with Git's ref-name rule: `git check-ref-format --branch` must
print the name back unchanged, and a value beginning `-` is rejected before Git is asked. The
name is passed to `git rev-list` and `git diff` after `--end-of-options`; a bare `--` would make
it a path.

### 3.2 Temporary seats

One command starts a temporary seat:
`team add --temporary --like <seat> --until <result:path|merged:branch>`. There is no copy-start
or copy-stop pair; `team remove <temporary-name>` is the stop. `team restart` refuses a temporary
seat and names that pair instead.

The name is the liked seat's name, `-tmp`, and the next free seat number under the
`seat-numbering` setting's width and separator (`worker-tmp-01` at the shipped default); a name
running in the session or listed by herdr holds its number too. The state record at
`sessions[<session>].seats[<copy>]` carries `temporary: { like, until, task?, own_commits? }`,
plus the ordinary pane, workspace, launched identity and stage. The team file is unchanged.

The archived contract further refuses a copy of a seat that is signed off, parked or stopped —
signed off stays off — and has the form consume the signed ceilings `limits.seats`,
`limits.temporary` and `limits.vendors.<vendor>`, never a seat `count`. None of that refusal is
built at v0.5.0. `temporarySeat` (`src/commands/add.ts:1053–1086`) selects the liked seat from
the loaded team file and sets `stopped: false`, so a source whose record is `stopped` (the
sign-off `team restart` names) or `parked` is copied. The ceilings come from `ceilingsOf(team)`
(`add.ts:404`), which reads the live `team.limits` (`src/approve/approval.ts:21`), not the
signed approval's stored snapshot. §7 records the divergence.

The watch judges the recorded end and reports it once. It writes `own_commits` back when the
proof first turns non-empty. The archived contract is that the watch closes the copy when the
validated end holds and the seat has `worked` and is `free`, as session end and `down` do, and a
later `up` never recreates it. At v0.5.0 that close is not built: the watch reports the end and
then says `${name}: its record is not an approved seat; left as it is (the owner cleans it: team
remove ${name} --abandon)`, so the owner's `team remove` is the stop at the tag.

### 3.3 Worktrees

The team file's `workspace.remove` is `on-merge` (the default) or `manual`. A worktree record in
the session state carries `path`, `branch`, `own_commits?`, `seat?` and `setup`. Its end is
`merged:<branch>` under §3.1's proof, with the same rule that no own commit means never merged.

`team worktree remove` refuses rather than guesses, in this order:

| Refusal | Result id | When |
|---|---|---|
| invalid task name | `worktree.remove-task` | the task name is not a valid task name |
| no record | `worktree.missing` | no worktree of that name is recorded |
| another session | `worktree.elsewhere` | the record belongs to a different session; nothing was removed |
| occupied | `worktree.occupied` | a seat is recorded in the worktree; `team remove` that seat first |
| unreadable | `worktree.unreadable` | the worktree cannot be read |
| dirty | `worktree.dirty` | uncommitted or untracked files are present |
| path mismatch | `worktree.remove-failed` | the recorded path is not the path `workspace.path` resolves to; nothing was removed |
| wrong branch | `worktree.remove-branch` | `--branch` names a branch other than the one the worktree is on; nothing was removed |
| unpublished | `worktree.unpublished` | the branch has commits on no remote branch |
| removal failed | `worktree.remove-failed` | `git worktree remove` itself failed; nothing was removed |

A recorded folder that is already gone is not a refusal: the check sits after
`worktree.occupied` and before `worktree.unreadable`, and the command runs `git worktree prune`,
deletes the state record and exits 0 with `worktree.record-gone`, deleting no branch.

A successful removal says it kept the branch; the branch is never deleted. Ignored files in the
worktree are deleted with it, as the command's own usage line says.

On `on-merge`, the watch removes a worktree only when the end holds, no seat is recorded in it,
and `remove` itself would not refuse; the judge applies no `worked` or `free` test, and the
removal is logged with caller `watch`. A failed removal says `worktree <task> was not removed`.
On `manual`, only the command removes. The watch never calls `add`, `approve` or `trust`.

### 3.4 Dialog state: one writer and the manual marker

One exclusive lock exists per session and seat at `<state dir>/seat-locks/<session>/<seat>`. The
lock's token is `<pid> <nonce>`, staged complete in a private temporary file and taken with a
hard link, so a partially written token is never observable. An existing link means held.

An unreadable or unparseable lock is held: it is never renamed or removed. A stale lock, whose
process id is dead, is taken over only by winning a second exclusive link on `<path>.steal` and
re-reading the token before the unlink. Release compares the whole token, so a lock taken over in
between is not released by its old holder.

Two commands contend for the same seat state. A launch that opens a dialog records the manual
marker under the seat lock before it focuses the pane; at v0.5.0 the marker is the boolean
`waiting.manual: true` on the `waiting-owner` record ([launch](launch.md) §3.5), while
`manual-owner-control` is the archived design's prose word. The marker is exclusive to that
launch invocation through renewed dialogs and timeouts. `team answer` refuses the marker and
leaves the pane to the owner.

A launch with no terminal of its own, and a delegated run, close a dialog without input: the
pane is closed, the seat is left out with its classification, the line
`<seat>: left out: <classification> (no terminal for owner)` is printed, and the command exits 1.
A waiting pane that vanished is never relaunched; the report is
`<seat>: left out: its waiting pane is gone`. The repair is `team remove <seat> --keep`, then
`team up`.

### 3.5 Answer locking and recovery

`team answer <seat> trust` presses only the recorded key. It holds the exclusive command-span
seat lock for the whole answer, takes two fresh reads of the pane, and compares the exact label,
version and folder on both. The folder must be the lobby on three readings: the screen's path,
the pane's own working folder, and the lobby's parent. `trust` is the only dialog word.

The refusal is named before anything is typed: the dialog policy is off (`answer.policy`); the
seat is not live or its record is not a declared seat (`answer.unverified`); the screen is
ambiguous (`answer.ambiguous`); or one of the folder, label, version and action checks differs
(`answer.folder`, `answer.label`, `answer.version`, `answer.action`).

Before the key is sent, the recovery record `trust-sent-recovery` is written. If the process
check fails before the send, the previous `waiting-owner` state is restored; a rollback that
fails keeps the recovery. After a send, a retry only observes: it never sends the key again. A
recovery stays recorded for the next answer to observe; it is not silently cleared.

### 3.6 The launched child's Git environment

The end state is that a launched seat's child process receives only its declared Git identity,
clears the inherited inputs that would otherwise carry the owner's identity, and never prints or
logs a value. Which fields supply which value, and the exact variable names, are
[accounts and gates](accounts-and-gates.md) §3.4's and are not repeated here.

The cleared end state also covers the forms Git can use to escape the declared identity: the
common SSH GitHub forms run the command `false` through cleared SSH inputs and
`core.sshCommand=false`; the owner's global and system Git configuration and inherited
config pairs are overridden or cleared; the stored `gh` variables and the inherited
`GITHUB_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GH_HOST` and `GH_CONFIG_DIR`
are cleared, with `GH_TOKEN` the intended preference. These are the archived seat-account
design's controls.

Today, at v0.5.0 and at int/0.5.1 (8acb470b), none of this is built: no code sets
`GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `GH_TOKEN` or `GIT_CONFIG_*` for a seat. The herdr server is
started detached in a clean environment whose allowlist is `HOME`, `USER`, `LOGNAME`, `PATH`,
`SHELL`, `TERM` and `LANG`, and it passes `SSH_AUTH_SOCK` when the owner has one. A seat launched
there therefore keeps the owner's SSH agent, and the owner's ambient Git configuration, and no
declared identity is injected.

### 3.7 Author and committer checks

`team check` applies an account rule to the selected commits. It is a consistency check, not
proof: a seat can set the author and committer fields itself. Selection follows `identity.since`:
unset excludes nothing; set excludes that commit and every commit reachable from it, leaving its
ancestors out of the selected range.

| Commit kind | Account rule |
|---|---|
| merge (more than one parent) | exempt |
| declared human (author email in `identity.humans`) | exempt entirely |
| trailer names an inheriting seat | author and committer name and email equal the declared seat account |
| trailer names an `identity: off` seat | no account comparison |
| trailer names no seat | no account comparison |
| squash, GitHub rebase merge, web edit, rewritten rebase | checked when the trailer names an inheriting seat |

A failure says `author is not the declared seat account` or
`committer is not the declared seat account`. The line names expected configuration, never a
token. `check` stays read-only and exits 1 on a finding.

At v0.5.0 this account rule is not built: `team check` runs its existing signature and forbidden
pattern checks but compares no author or committer against a declared seat account.

## 4. Commands and options

At the release tag, the exact synopsis lines from `contract/cli.json`:

```text
team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>] [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>] [--json]
team remove <name> [--keep] [--abandon] [--session <name>] [--file <path>] [--json]
team answer <seat> trust [--session <name>] [--file <path>] [--json]
team worktree new <task> [--kind <kind>] [--seat <name>] [--session <name>] [--file <path>] [--json]
team worktree list [--session <name>] [--file <path>] [--json]
team worktree remove <task> [--branch <name>] [--session <name>] [--file <path>] [--json]
```

There is no `team copy start` or `team copy stop`.

Result identifiers this spec asserts, all registered at v0.5.0:

| Group | Identifiers |
|---|---|
| temporary add | `add.no-like`, `add.until`, `add.result-absolute`, `add.result-exists`, `add.merged-base`, `add.branch-missing`, `add.worktree-missing`, `add.worktree-failed`, `add.temporary-flags` |
| answer | `answer.policy`, `answer.unverified`, `answer.ambiguous`, `answer.folder`, `answer.label`, `answer.version`, `answer.action`, `answer.recovery` |
| worktree | `worktree.remove-task`, `worktree.missing`, `worktree.elsewhere`, `worktree.occupied`, `worktree.record-gone`, `worktree.unreadable`, `worktree.dirty`, `worktree.unpublished`, `worktree.remove-branch`, `worktree.remove-failed` |

## 5. Rules

1. An end MUST be acted on only from its proof: own commits read after a fetch that succeeded in
   the same pass; a branch MUST never count as merged without an earlier non-empty reading; a
   failed fetch, a vanished branch or an unprovable squash or rebase MUST end nothing. A
   temporary seat MUST have been `working` once since rules delivery and MUST be `free`; a
   worktree MUST NOT be held to either test. Source: archived team-file design. Proof:
   `test/end.test.ts` and `test/commands/watch-close.test.ts` at v0.5.0.

2. `--until` MUST be validated lexically for every caller, the owner included. For `result:`, an
   absolute path, `~` and every `..` segment MUST be refused, and the archived requirement also
   refuses any symlink in the path and follows no link; at v0.5.0 that symlink refusal is not
   built (`resultPathProblem` never stats, and `readEnd`'s existence test follows the link). For
   `merged:`, Git's ref rule MUST be applied with `git check-ref-format --branch`, a leading `-`
   MUST be refused before Git is asked, and the name MUST be passed to `git rev-list` and
   `git diff` after `--end-of-options`, never after a bare `--`. Source: archived agent-setup
   design; code at v0.5.0. Proof: `test/end.test.ts` at v0.5.0 proves the lexical check and the
   acceptance of a contained symlink, not its rejection.

3. A temporary seat MUST be a state record with one start command and one stop command, a
   validated end and the liked seat's definition, and there MUST NOT be a copy lifecycle. The
   archived contract further requires that a copy of a signed-off, parked or stopped seat MUST be
   refused — signed off stays off — and that the form consume the signed ceilings `limits.seats`,
   `limits.temporary` and `limits.vendors.<vendor>`, never a seat `count`. Source: archived
   agent-setup design. At v0.5.0 the state-record form and the validated end are built
   (`test/commands/add.test.ts`); the refusal and the signed-ceiling authority are not:
   `temporarySeat` sets `stopped: false` and `ceilingsOf(team)` reads the live `team.limits`, so
   no tag test proves them. The watch's removal of a temporary seat is not built (rule 4).

4. The watch MUST close a temporary seat only when its validated end holds and the seat has
   `worked` and is `free`, and a later `up` MUST NOT recreate it. A worktree MUST be removed only
   on the proof, unoccupied, on `on-merge`, and when `remove` would not refuse, and its branch
   MUST NOT be deleted. Source: archived team-file and agent-setup designs. Proof at v0.5.0: the
   judge and report and the worktree rules are proven by `test/commands/worktree.test.ts`,
   `test/worktree-remove-refusals-boundaries.test.ts`, `test/commands/watch-close.test.ts` and
   `test/watch-workspace.test.ts`; the watch's removal of a temporary seat is not built (the
   owner's `team remove` is the stop at the tag).

5. One writer MUST hold a seat's dialog state: a complete token taken by hard link, a corrupt
   lock treated as held, a stale lock taken over only through the second link and a re-read, and
   the manual marker recorded under the lock before the pane is focused and refused by
   `team answer`. At v0.5.0 the marker is the boolean `waiting.manual: true` on the
   `waiting-owner` record ([launch](launch.md) §3.5); `manual-owner-control` is the archived
   prose word. Source: archived dialog design; code at v0.5.0. Proof:
   `test/launch/seat-lock.test.ts`, `test/launch/pause.test.ts` and `test/answer.test.ts` at
   v0.5.0.

6. An answer MUST hold the command-span lock, MUST check two fresh reads and the three folder
   readings, MUST write the recovery before the key, MUST restore the pre-send state when the
   send is refused, and MUST only observe after a send. Source: archived dialog design; code at
   v0.5.0. Proof: `test/answer.test.ts`, `test/close.test.ts` and
   `test/commands/watch-close.test.ts` at v0.5.0.

7. A launch with no terminal and a delegated run MUST close a dialog without input only through
   their named paths, MUST report the seat left out with its classification and MUST exit 1; a
   vanished waiting pane MUST NOT be relaunched. Source: archived dialog and delegate designs;
   code at v0.5.0. Proof: `test/close.test.ts` at v0.5.0.

8. **Not built at v0.5.0 or at int/0.5.1 (8acb470b).** A launched child MUST receive only its
   declared Git identity, the inherited identity inputs MUST be cleared, no value MUST be printed
   or logged, and the Git forms that would escape the identity MUST run `false`. Source: archived
   seat-account design; the accepted accounts amendment. Proof: none at either ref; the herdr
   server's clean-server environment and its `SSH_AUTH_SOCK` pass-through are the only built
   pieces.

9. **Not built at v0.5.0 or at int/0.5.1 (8acb470b).** `team check` MUST apply the account rule
   over selected commits: merges MUST be exempt, declared humans MUST be exempt, a trailer naming
   an inheriting seat MUST be compared against the declared account, an off seat or no seat MUST
   get no comparison, and squash and rewritten forms MUST be checked when the trailer names a
   seat; a failure MUST name configuration, never a token; the check MUST stay read-only and MUST
   exit 1 on a finding. Source: archived seat-account design. Proof: none.

## 6. Registries

- [Exit codes](registries/exit-codes.md): every identifier in §4 is a registered v0.5.0 row of
  the `answer`, `add` and `worktree` groups. This spec contributes no new row.
- [Operations](registries/operations.md): the commands' operations are their owning areas';
  this spec adds none.
- [CLI ranges](registries/cli-ranges.md): none.
- [Seat states and prompt kinds](registries/seat-states-and-prompt-kinds.md): this spec adds no
  row. The waiting record's `state` values (`waiting-owner`, `trust-sent-recovery`) and its
  `manual` field are [launch](launch.md) §3.5's, read here and not contributed again;
  `manual-owner-control` is the archived design's prose word and no row of it exists.

## 7. Open points

- The archived agent-setup design's temporary form accepts no `--worktree`; the shipped v0.5.0
  synopsis accepts one and points the copy's `cwd` at the worktree. This draft records the
  divergence and does not resolve it: the archive's signed-ceiling and end rules were written for
  a copy without a worktree.
- At v0.5.0 the archived temporary-seat refusal and ceiling authority are not built: a `stopped`
  (signed-off) or `parked` source is copied and the copy starts, and the ceilings come from the
  live `team.limits`, not from the approval's stored snapshot. Rule 3's signed-off and
  signed-ceiling clauses are the archived contract, not a built fact, and no tag test proves them.
- The archived `result:` symlink rejection is not built at v0.5.0 either: the lexical check never
  stats and the existence test follows a link, so a contained name that is a symlink is accepted.
  §3.1 and rule 2 say which part is built.
- At v0.5.0 the watch does not remove a temporary seat whose end holds; it reports and leaves the
  owner's `team remove` as the stop. Rule 4's close is the archived contract, not a built fact.
- The current accounts table's Git configuration clearing is four `GIT_CONFIG_COUNT` pairs; the
  archived seat-account design's control list also sets `core.sshCommand=false`. Whether the
  accepted table's four pairs are the whole end state or the fifth control is missing from the
  table is open for the accounts text's owner.
- The archived seat-account design's residual limits stand: a failed resolver leaves the owner's
  shell; a restored seat that TeamCLI did not launch is injected with nothing; a shell startup
  export, an agent CLI's own stored login, and same-user inspection are owner-accepted limits.
- Deferred as before: a separate OS user or sandbox per seat, per-seat accounts, a GitHub App
  token, commit signing, and other forges.
- The archived dialog design's deferred policy items are not settled here: permission-dialog
  policy beyond `trust`, vendor-notice handling, and trust-flag variants.
- Rules 8 and 9 have no proof; they need a built head and a measurement before this draft claims
  any Today row.

## Revision log

- **Draft** (2026-10-19): lifted the end conditions and worktree removal rules, the temporary-seat
  form and ceilings, the dialog-state lock and manual marker, the answer's checks and recovery,
  the child Git environment and the commit-account check from the archived team-file, dialog,
  delegate, seat-account and agent-setup designs; read `src/commands/add.ts`,
  `src/commands/worktree.ts`, `src/commands/watch.ts`, `src/commands/answer.ts`,
  `src/launch/seat-lock.ts`, `src/launch/plan.ts` and `src/herdr.ts` at v0.5.0, and the identity
  and commit checks again at int/0.5.1 (8acb470b). Built and not-built rules are separated; the
  identity mapping is linked, not repeated.
- **Review fold** (2026-10-19): split the archived `result:` symlink rejection from the built
  lexical check and named the gap in §3.1, rule 2 and §7; replaced bare `--` with
  `--end-of-options` and `check-ref-format --branch` for `merged:`; split the archived signed-off
  refusal and signed-ceiling authority from `temporarySeat`/`ceilingsOf(team)` in §3.2, rule 3
  and §7; restored the exact `worked` and `free` conditions of a temporary end and their absence
  from `judgeWorktree` in §2, §3.1, §3.3 and rules 1/4; added `worktree.remove-branch`, made
  `worktree.record-gone` an early exit-0 pruning branch and aligned `worktree.remove-failed` with
  `src/commands/worktree.ts`; recorded the manual marker as `waiting.manual: true` on the
  `waiting-owner` record in §2, §3.4, rule 5 and §6, pointing at launch.md §3.5; and added BCP 14
  MUST/MUST NOT keywords to rules 1–9.
