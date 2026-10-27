---
created: 2026-10-19
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75); root-selection behavior unchanged at int/0.5.1 (8acb470b), where no part of the knowledge contract is built either
for: Memory (003) §10/§12; Runtime §10/§12 (the project root and its discovery)
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: the project root and project knowledge

## 1. Scope

The project root is the directory that holds the selected `team config`; this spec covers how a
command finds it, including a folder that is not a Git repository, and what changes there. It covers
the team file's `knowledge` section — the default folder, the explicit folder, the off form, their
validation, the historical approval observation and the automatic observation of the fixed default — and what a seat is
told of that knowledge at its start, with the scope that decides it. It leaves the team file's own
format to the launch spec, the project and team records to the registry spec, and the vault the
notes become to the memory text's commitments 13–16. The root walk, `init` outside Git,
`knowledge`, `scope` and `start_at` below are the contract of the accepted project-folder decision
of 2026-10-05 (called "the decision" from here); at v0.5.0 only the loader's plain-folder form and
the checkout selection are built, and §7 says exactly where the code stops.

## 2. Terms

- **project root:** the directory containing the selected team file; for a `--file` path, the folder
  that holds its `.agents/`, or the file's own folder when it sits elsewhere.
- **checkout:** a Git working tree. **main checkout:** the checkout Git reports for a subdirectory
  or a linked worktree through its common directory.
- **folder project:** a project whose root is not a Git repository.
- **knowledge:** the optional owner section of the team file that names the project's agent-notes
  folder. **default:** `<project root>/.agents/docs/`. **explicit:** the scalar or mapping `path`.
  **off:** `knowledge: false`, or either default form with no existing folder.
- **README:** the `README.md` of the resolved knowledge directory; the only file `team` names.
- **approval observation:** the historical record of what `team approve` showed and signed: absent,
  default or explicit, with the canonical directory and the visibility. `team approve` was removed
  at v0.5.0 (`team.approve-removed`, `src/cli.ts:59`); the observation survives in retained legacy
  records, and current authority over knowledge is the grant/create flow (OD-20261015-03), not an
  approving command.
- **automatic default change:** the fixed default appearing or disappearing under an absent key or
  a mapping with no `path`; class (c), informational, never gating a launch.
- **seat scope:** `full` (the default, hashing as a seat written before the key) or `public`.
- **visibility:** the project's `private` or `public`, and knowledge's `public` or `inherited`.
- **confinement:** the folders an explicit `knowledge` path may not resolve to, listed in rule 10.

## 3. Formats

### 3.1 The team file's `knowledge` section

It lives in the selected team file, `team config`. It is an owner section, beside `trust` and
`dialogs`, written by the owner; the historical `team approve` recorded the observation, while a
change today is authorized by the grant/create flow (OD-20261015-03).

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `knowledge` | `false`, a string, or a mapping | no | absent (the default form) | not built at v0.5.0 | the off switch, an explicit path, or a mapping |
| `knowledge.path` | string | no | `.agents/docs/` | not built at v0.5.0 | one existing directory: relative to the root, absolute, or one leading `~` for the owner |
| `knowledge.visibility` | `public` or `inherited` | no | `inherited` | not built at v0.5.0 | the one public marker |

Three spellings, from the decision:

```yaml
knowledge: ../project-docs
```

```yaml
knowledge: false # turn the default off
```

```yaml
knowledge:
  visibility: public # public | inherited; no path means the fixed default
```

An explicit path resolves relative to the project root; an absolute path is allowed; `~` is allowed
only as the first component and expands for the owner, and is not stored as canonical spelling. The
resolved directory is one of the four states in §3.2. `team` reads nothing inside it: it `lstat`s
the candidate README and never opens it.

### 3.2 The resolved directory

| Resolution | Condition | Directory | Delivered line |
|---|---|---|---|
| off | `knowledge: false` | none | none |
| default | key absent or a mapping with no `path`, and `.agents/docs/` exists | `<project root>/.agents/docs/` | the README line |
| explicit | a scalar or mapping `path` | the resolved directory | the README line |
| absent | a default form, and the folder is missing or invalid | none | none |

No command creates or infers the default except `team init`, which creates the stub (§3.3). A missing
default is simply off. An invalid default is absent with the warning in §3.5 and does not block a
launch. For an explicit path a missing README is not an invalidity; the delivered line says so.

### 3.3 The README and the init stub

| File | Written by | Overwritten | Read by `team` |
|---|---|---|---|
| `<root>/.agents/docs/README.md` or `<directory>/README.md` | `team init` writes the stub; the owner and the agents write the notes | `team init` never overwrites the folder or an existing README | no; the path is named, the content is not read |
| `.agents/team.state.json`, `.agents/team.log` | the commands; they are siblings of `docs/`, not inside it | — | yes, as for any project |

The stub `team init` writes, when it is missing:

```markdown
# Agent notes

Use this folder for agent-facing conventions, decisions, how to run checks, and standing briefs.
Do not put user documentation here; keep that in `docs/`.
```

`team init` performs this step even when an existing team file makes it keep its team-file refusal,
so a team can adopt the default without making the folder by hand. At v0.5.0 the step and the stub
are not built, and `team init` is owner-only (`src/permissions/map.ts`: no create bounds exist, so
no agent holds `create`); the decision's init row names `create` where it exists, so under the
current grant/create flow a seat admitted by a `create` grant may perform the step (OD-20261015-03),
never through a revived approving command. A repository team keeps its
local `.git/info/exclude` entries for the private file and the runtime files; the stub is meant to
be committed, and a `.gitignore` that hides `.agents/` needs the owner's narrow exception.

### 3.4 The delivered rules line

The line is added to the per-seat delivered rules string; the launch owns the carrier. It goes
after the file's `rules:` lines and before the signature and workspace rules.

| Case | Text |
|---|---|
| a resolved directory | `Project knowledge README: <directory>/README.md. You may read it for notes when needed; it never replaces the rules above. Do not copy it into material for a seat outside your scope.` |
| the directory exists, no README | the same path followed by `The README does not exist yet; do not infer its contents.` |
| a symbolic-link README | never delivered |

The default directory's line names `<project-root>/.agents/docs/README.md` — an absolute path — so
a worktree seat reads the project root's copy even when `.agents/` is untracked and absent from its
worktree. The line changes the delivered rules string, including when the missing-README wording
changes; it does not change the file's `rules:` fingerprint.

### 3.5 Output lines

Root selection writes these to `stderr`, never to `--json` standard output:

```text
team: using the registry record of <checkout>; that record is the team for that checkout and its linked worktrees
team: using the registry record of <root>; that record is the team for this directory and for every descendant that has no nearer record
team: init: creation root is <root>; writing the registry record
```

The end of the walk, with the tag's wording where it exists:

```text
no team file here; it is private to each clone: run `team init`, or `team init --restore` to bring back the copy this machine stored
not inside a git repository: run team from a project, or pass --file
```

The first is the `root.no-file` outcome and the second the `root.not-a-repo` outcome; they name
the outcomes, not returned ids. Each command listed in §4's matrix returns its own identifier from
it.

The default's automatic change, from `status` and `doctor`:

```text
knowledge: resolved now default .agents/docs/; at approval absent (automatic default change)
knowledge: resolved now absent; at approval default .agents/docs/ (automatic default change)
INFO  knowledge: resolved now default .agents/docs/; at approval absent (automatic default change)
INFO  knowledge: resolved now absent; at approval default .agents/docs/ (automatic default change)
```

The first resolving command after each observed change appends one line to `.agents/team.log`:

```text
<ISO-8601> <command> [<caller>] knowledge resolved now default .agents/docs/; at approval absent
<ISO-8601> <command> [<caller>] knowledge resolved now absent; at approval default .agents/docs/
```

`at approval` names the historical signed observation of §3.6: `team approve` was removed at
v0.5.0 (`team.approve-removed`, `src/cli.ts:59`), the line is informational, and no approving
command is required today (OD-20261015-03).

The warnings:

```text
WARN  knowledge: default .agents/docs/ is invalid (<reason>); treating it as absent
WARN  <seat>: knowledge <path> omitted: visibility private and knowledge is not marked public
WARN  <seat>: scope public in visibility private project; the owner's declaration is not access control
```

The historical approval preview adds:

```text
knowledge: .agents/docs/ (default; README <project-root>/.agents/docs/README.md; visibility inherited; full-scope seats, and public-scope seats because the project is public)
knowledge: <spelling> (explicit; README <absolute-path>/README.md; visibility public; full-scope seats, and public-scope seats because knowledge is marked public)
knowledge canonical: <path>
lead: start_at project (starts at the approved project root; its trust dialog is owner-only)
lead: scope full
<seat>: scope public (no private knowledge or private paths in rules/trust)
```

An inherited and private folder instead says `visibility inherited; full-scope seats only because
the project is private and knowledge is not marked public`. The canonical line is printed only when
the spelling and the landing differ.

`team init` writes, on a new stub, to `stdout`:

```text
Wrote .agents/docs/README.md: an agent-notes stub; commit it to share it with clones and worktrees.
```

and, when the README already exists, to `stderr`:

```text
team init: .agents/docs/README.md exists already; left it unchanged.
```

A plain-folder `team init` also writes to `stderr`:

```text
WARN  init: no Git exclude file at this project root
```

The dispatch command's refusal is:

```text
dispatch.scope: <seat> has scope public; this brief is private
```

### 3.6 The historical approval record's observation

The historical signed approval record lives in the project's approval store; retained legacy
records are read as history: `team approve` was removed at v0.5.0 (`team.approve-removed`,
`src/cli.ts:59`), and current authority over knowledge and disclosure is the grant/create flow
(OD-20261015-03), never a new approval. A folder project is keyed by the canonical root path's
SHA-256 12-hex prefix, at `<home>/.config/team/<project>-<hash>`. The state and log stay beside the
file, at `.agents/team.state.json` and `.agents/team.log`.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| resolution | `absent`, `default`, `explicit` | yes | — | not built at v0.5.0 | what the owner saw and signed |
| directory | absolute canonical path | default and explicit | — | not built at v0.5.0 | the landing |
| visibility | `public`, `inherited` | yes | `inherited` | not built at v0.5.0 | the recorded declaration |
| suppressed | boolean | no | `false` | not built at v0.5.0 | `knowledge: false` turned the default off |

The field spellings are the registry's to fix (open point 2). The record keeps the observation; the
current resolution is recomputed from the file and the folder on every command.

## 4. Commands and options

The commands that read the team file share one root selection, but each keeps its own option
contract: the listed commands take `--file <path>`, while `team init` does not (its synopsis at
the tag is `team init [--restore] [--json]`), and `plan` and `feed` load the team file without
accepting `--file` either (`src/commands/plan.ts:114`, `src/commands/feed.ts:664`, both calling
`loadTeamFile(io.cwd, { home: sources.home })`). The area owns no command of its own: the behaviour
is the loader's, and the lines are the ones `status`, `doctor`, `init`, `check`, `worktree`, `add`,
`send` and `dispatch` already print or would print.

Root selection, from the invocation directory:

1. **A checkout file wins.** Ask Git for the invocation directory's checkout (the checkout itself,
   a subdirectory, or a linked worktree). When its main checkout has `team config`, that file
   is the root, and the rule 1 announcement goes to `stderr`.
2. **`init` creates.** For `team init` only, a discovered checkout's main checkout is the creation
   root even when it holds no team file; with no checkout, the invocation directory is. A parent
   team file never takes `init` over. When the creation root differs from the invocation directory,
   the rule 2 announcement goes to `stderr`.
3. **The lexical walk.** Otherwise, walk the invocation directory and its existing ancestors
   lexically, nearest first; the first `team config` wins. A symbolic-link candidate
   directory is searched for the file, and the walk then ends without continuing through its
   target; a file that exists only on a parent of that target is not selected. A missing candidate
   is not a root. The rule 3 announcement goes to `stderr`.
4. **Refusal.** With a checkout and no file, the `root.no-file` line; with no checkout and no file,
   the `root.not-a-repo` line.

The identifier each listed command returns on step 4, on each of the two lines; the matrix is
these commands' contract, and another loader consumer keeps its own:

| Command | With a checkout, no file | No checkout, no file |
|---|---|---|
| `add` | `add.file` (exit 2) | `add.not-a-repo` (exit 2) |
| `answer` | `answer.configuration` (exit 2) | `answer.configuration` (exit 2) |
| `check` | `check.file` (exit 2) | `check.not-a-repo` (exit 2) |
| `doctor` | `doctor.file` (exit 2) | `doctor.not-a-repo` (exit 2) |
| `down` | `down.file` (exit 2) | `down.not-a-repo` (exit 2) |
| `release` | `release.configuration` (exit 64) | `release.configuration` (exit 64) |
| `remove` | `remove.file` (exit 2) | `remove.not-a-repo` (exit 2) |
| `status` | `status.file` (exit 2) | `status.not-a-repo` (exit 2) |
| `up` | `up.file` (exit 2) | `up.not-a-repo` (exit 2) |
| `watch` | `watch.file` (exit 2) | `watch.not-a-repo` (exit 2) |
| `worktree` | `worktree.file` (exit 2) | `worktree.not-a-repo` (exit 2) |
| `init` | does not reach step 4: rule 2 creates | does not reach step 4: rule 2 creates |

`approve` has no row: the command was removed at v0.5.0 (`team.approve-removed`,
`src/cli.ts:59`), and neither `approve.file` nor `approve.not-a-repo` is a contract id at the tag.

A selected folder root's Git refusals are separate ids: `check.outside` (exit 2), the folder
declarations' `folder.git-required`, `worktree`'s `worktree.git-required` (exit 2), and `add`'s
`add.git-required` (exit 2) for `merged:<branch>` and `--worktree`. Release checks run unchanged
from a folder root: their tag read is remote.

## 5. Rules

1. **The selected root.** The project root **MUST** be the directory containing the selected team
   file; a `--file` path's root **MUST** be the folder that holds its `.agents/`, or the file's own
   folder when it sits elsewhere. *Source:* `src/file/load.ts` (`loadTeamFile`), at the tag.
   *Proof:* `test/load.test.ts` (the `--file` root case).

2. **Checkout selection.** Without `--file`, a command **MUST** first ask Git for the invocation
   directory's checkout, including a subdirectory and a linked worktree, and **MUST** select the
   main checkout's `team config` when it exists. *Source:* `src/file/load.ts` (`findRoot`).
   *Proof:* `test/load.test.ts` (the main-checkout, subfolder and linked-worktree cases).

3. **`init`'s creation root.** `team init` **MUST** use the discovered main checkout as its
   creation root when Git finds a checkout, even one with no team file; with no checkout it
   **MUST** create at the invocation directory; a parent team file **MUST NOT** take `init` over;
   and when the creation root differs from the invocation directory it **MUST** write the rule 2
   announcement to `stderr`. *Source:* the decision, § Root selection, step 2; not built at
   v0.5.0 — `team init` refuses outside a repository with `init.not-a-repo`
   (`src/commands/init.ts`). *Proof:* none at the tag.

4. **The lexical walk.** Otherwise, a command **MUST** walk the invocation directory and its
   existing ancestors lexically, nearest first, and **MUST** select the first
   `team config`. A symbolic-link candidate **MUST** be searched for the file, and the walk
   **MUST** then end without continuing through its target; a missing candidate is not a root.
   When rule 3 chooses the root, the rule 3 announcement **MUST** go to `stderr`, and no
   announcement may reach `--json` standard output. *Source:* the decision, § Root selection, step
   3. The tag stops earlier: it reads `team config` in the invocation directory only, and
   never in a parent (`src/file/load.ts`, `plainFolderTeam`). *Proof of the tag's narrower rule:*
   `test/load.test.ts` (a folder with no Git; a parent folder's file is not found) and
   `test/commands/plain-folder.test.ts`.

5. **The end of the walk.** With a checkout and no file, a command **MUST** emit the `root.no-file`
   line; with no checkout and no file, the `root.not-a-repo` line. Each command listed in §4's
   matrix **MUST** return its own identifier from it; `answer` and `release` **MUST** keep their
   folded ids; `init` **MUST NOT** emit either line. *Source:* `src/file/load.ts` (`NOT_A_REPO`,
   `LINK_NOT_FOLLOWED`) and the no-file message, at the tag; the outcome names and the matrix are
   the decision's, § Root selection, step 4. *Proof:* `test/load.test.ts` and
   `test/no-file-offer.test.ts`.

6. **A folder without Git.** A folder root **MUST** select `workspace.mode: shared` only, and its
   effective `workspace.protected` list **MUST** be empty. A folder file **MUST** reject
   `workspace.mode: worktree`, a worktree seat, and any declared `workspace.protected` with
   `folder.git-required`. *Source:* the decision, § Git-dependent operations, not built at
   v0.5.0 — `src/file/sections/workspace.ts` defaults to `worktree` and to `protected: ['.']`, and
   the loader does not refuse either for a plain folder. *Proof:* none at the tag.

7. **Git-dependent operations in a folder team.** `check` **MUST** refuse a selected root that is
   not a repository with `check.outside` before reading commits, even from a member repository's
   `cwd`. `worktree` **MUST** refuse with `worktree.git-required`; `add`'s `merged:<branch>` and
   `--worktree` **MUST** refuse with `add.git-required`. Release checks **MAY** run from a folder
   root, because their tag read is remote. *Source:* the decision, § Git-dependent operations; not
   built at v0.5.0. *Proof:* none at the tag.

8. **The historical approval's identity, and the state beside the file.** A folder project's
   retained approval record **MUST** be keyed in the approval store by its canonical root path's
   SHA-256 12-hex prefix, at `<home>/.config/team/<project>-<hash>`; a repository approval **MUST
   NOT** be migrated or reused for it; moving or renaming the folder **MUST** be a new project,
   and a retained record **MUST NOT** be reused for it — admission today is the grant/create flow
   (OD-20261015-03), never a new approval. The state and the log **MUST** stay beside the file, at
   `.agents/team.state.json` and `.agents/team.log`. *Source:* `src/store/store.ts`, `src/state.ts`,
   `src/log.ts`, at the tag. *Proof:* `test/commands/plain-folder.test.ts`.

9. **The knowledge resolution.** `knowledge` **MUST** resolve to one of the four states in §3.2:
   off, the existing default, the explicit directory, or absent. An absent key and a mapping with
   no `path` **MUST** resolve identically to the fixed default, and the mapping's visibility alone
   is recorded; `knowledge: false` **MUST** be the explicit off switch; a default folder **MUST
   NOT** be created or inferred by any command except `team init`, which **MUST** create the
   missing stub of §3.3 even when it keeps its team-file refusal — at v0.5.0 `init` is owner-only
   (`src/permissions/map.ts`), and the decision's init row names `create` where it exists, so a
   seat admitted by the current grant/create flow may perform it (OD-20261015-03; the stub itself
   is not built at the tag); `team` **MUST NOT** read anything inside the resolved directory.
   *Source:* the decision, § Knowledge; not built at v0.5.0 — there is no
   `knowledge` section (`src/file/sections/index.ts`), and validation refuses unknown top-level
   fields. *Proof:* none at the tag.

10. **An explicit path's validity.** An explicit scalar or mapping `path` **MUST** be one existing
    directory, resolved relative to the root, absolute, or with `~` as its first component for the
    owner. It **MUST NOT** be a file, a symbolic link (or have a symbolic-link component), a glob,
    a missing directory, or have a symbolic-link README; a non-link README is not required for
    validity. It **MUST NOT** be the project root, its parent or any ancestor, the lobby or
    anything under it, a configured worktree landing or anything under it, the per-user team
    configuration folder or anything under it, or any project's approval-store directory.
    `knowledge: .` **MUST** be refused and `..` **MUST** be refused. Every refusal is
    `knowledge.invalid`, exit 2. *Source:* the decision, § Knowledge; not built at v0.5.0.
    *Proof:* none at the tag.

11. **Invalid default forms.** Under an absent key or a mapping with no `path`, a file, a symbolic
    link (or a symbolic-link component) or a symbolic-link README at the fixed name **MUST** be
    treated as absent, with `WARN  knowledge: default .agents/docs/ is invalid (<reason>);
    treating it as absent`; a missing directory **MUST** remain the ordinary off case. Neither
    **MUST** block a launch, and no seat may receive the path. *Source:* the decision, §
    Knowledge; not built at v0.5.0. *Proof:* none at the tag.

12. **Knowledge disclosure and change authority.** A change to `knowledge` (a mapping with no
    `path` included) or `knowledge.visibility`, to the project `visibility`, to `start_at`, or to
    an effective seat scope **MUST** be authorized through the current grant/create flow
    (OD-20261015-03) before a launch or an owner-authorized mutation; no approving command is
    required, and `team approve` does not exist at v0.5.0 (`team.approve-removed`,
    `src/cli.ts:59`). A retained historical approval record is the observation §3.6 describes: it
    **MUST** be read as history and compared for the automatic default observation of rule 13, and
    it **MUST NOT** be revived as a gate or made a precondition of a launch. Adding or removing an
    explicit `scope: full` **MUST NOT** require a new authorization, because it hashes as the
    omitted scope. A retained record with no keys **MUST** compare unchanged when no default
    directory resolves. *Source:* the decision, § Approval, validation, and output, read with
    OD-20261015-03 and `src/cli.ts` at the tag; not built at v0.5.0 — neither `knowledge` nor seat
    `scope`/`start_at` exists in the team file's sections or seats. *Proof:* none at the tag.

13. **The automatic default observation.** Under an absent key or a mapping with no `path`, the
    fixed default appearing or disappearing **MUST** be class (c): informational, never gating a
    launch or an owner command. The first resolving command after each observed change **MUST**
    record it once in `.agents/team.log`; `status` and `doctor` **MUST** show the resolved-now line
    only while the fresh resolution differs from the historical signed observation (§3.6); a
    create–launch–delete round trip **MUST** clear both displayed lines without an approval or
    other authorization; the log line **MUST NOT** authorize anything. An explicit path in a
    retained observation **MUST** be unaffected when the default appears or disappears.
    *Source:* the decision, § Knowledge and § Approval, validation, and output; not built at
    v0.5.0. *Proof:* none at the tag.

14. **The README's delivery.** For an allowed seat, the exact line in §3.4 **MUST** be added after
    the file's `rules:` lines and before the signature and workspace rules; an explicit directory
    **MUST** substitute its absolute `<directory>/README.md`; a missing README **MUST** append `The
    README does not exist yet; do not infer its contents.`; a symbolic-link README **MUST NOT** be
    delivered. The insertion **MUST** change the per-seat delivered rules string, and **MUST NOT**
    change the file's `rules:` fingerprint. *Source:* the insertion point is `src/launch/rules.ts`
    at the tag; the line and its position are the decision's, § Rules delivery. *Proof:* none for
    the knowledge line at the tag; `test/launch/rules-file.test.ts` proves the carrier.

15. **Seat scope.** A seat's `scope` **MUST** be `full` (the default; omitted and explicit `full`
    hash identically) or `public`. No vendor, model, CLI, profile, account or launch string **MAY**
    infer it. A public seat **MUST** be given no private knowledge: the four cases are fixed — a
    public project gives the line whether knowledge is inherited or marked public; a private
    project gives it only when knowledge is marked `public`, and otherwise omits the line with the
    owner's warning. Scope **MUST NOT** make a knowledge `cwd`, a worktree, an external `cwd` or a
    trust answer available. Unknown or non-string scope is `seat.scope`. *Source:* the decision, §
    Seat data scope; not built at v0.5.0 — seats carry no `scope` field (`src/file/sections/
    seats.ts`). *Proof:* none at the tag.

16. **The owner's warnings and the dispatch refusal.** `doctor` **MUST** add the owner-only
    omission warning when a public seat would have received the line but the folder is private and
    unmarked; it **MUST** also show the owner-only scope warning for a public seat in a private
    project; neither **MUST** refuse a launch. `status` **MUST** add a `scope` column, and `--json`
    a string `scope` per row, and **MUST** show the note only to the owner. The dispatch command
    **MUST** refuse a private brief for a public seat with exit 1 and `dispatch.scope: <seat> has
    scope public; this brief is private`, and **MUST** refuse an unclassified outside brief without
    printing its path. *Source:* the decision, § Private paths, delivery, and disclosure; not built
    at v0.5.0. *Proof:* none at the tag.

17. **The non-confidentiality boundary.** A knowledge declaration and a seat scope **MUST NOT** be
    treated as access control. Every process of the same OS user can read the team file (which
    names the knowledge path, every configured path and every seat's scope), the knowledge folder,
    the state file (whose `last_valid.file` stores the complete team-file text), the log, the rules
    files and `status`; scope changes what `team` says and routes, not what such a process can
    read. The fixed default appearing is a real exposure: a seat that can write the project can
    create `.agents/docs/` and its README, and the next launch names it to every allowed seat
    without an owner step; the fixed name prevents it naming another folder, and `knowledge:
    false` is the off switch. Real separation requires a separate OS identity or execution
    boundary and is not built. *Source:* `src/file/current.ts` (`last_valid.file`), `src/state.ts`
    and `src/log.ts` at the tag; the boundary is the decision's, § Safety boundary. *Proof:*
    `test/commands/plain-folder.test.ts` (the state and log beside the file).

## 6. Registries

The exit-codes registry gains these planned rows, and `root.no-file`/`root.not-a-repo` are line
labels, not ids:

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `knowledge.invalid` | an explicit `knowledge` path failed validation (exit 2) | planned | none | |
| `seat.scope` | a seat's `scope` is unknown or not a string | planned | none | |
| `folder.git-required` | a folder team declared a worktree or protected path | planned | none | |
| `check.outside` | the selected root is not a repository (exit 2) | planned | none | |
| `worktree.git-required` | `worktree` ran on a selected folder root (exit 2) | planned | none | |
| `add.git-required` | `merged:<branch>` or `--worktree` on a folder root (exit 2) | planned | none | |
| `dispatch.scope` | a private brief was refused for a public seat (exit 1) | planned | none | |

The step-4 matrix reuses the `*.file` and `*.not-a-repo` rows the exit-codes registry already
holds; this spec adds none of those.

The project record, its canonical root and the approval store belong to the registry spec
(`registry.md`); this spec contributes only the root's identity and the observation the historical
approval signed. The planned mapping to the decisions is:

| Area | Decided home | Decision |
|---|---|---|
| the project record, its canonical root and the approval store | the registry's pluggable storage adapter family — files, a database, a service | OD-20261018-08 |
| the state and the log beside the file | the same storage family, once the registry holds the project | OD-20261018-08 |
| the knowledge folder and its README | the entity's vault: raw sources, curated pages, an index and a log; one vault per entity | OD-20261018-10 |
| knowledge resolution and the README's delivery | the vault's pages chosen at a start; TeamCLI manages the vault through its commands | OD-20261018-11 |
| seat scope and the public marker | the vault's grants: read and write by scope, deny by default | OD-20261018-12 |
| the automatic default observation | the historical approval record, and the vault's operation log | OD-20261018-08; OD-20261018-10 |

Until the vault exists, the knowledge folder is a folder any seat reads directly, and §5's
boundary stands.

## 7. Open points

1. **What the tag builds.** Only the checkout selection and the invocation-directory plain-folder
   loader are built at v0.5.0; the ordered walk, `init` outside Git, `knowledge`, `scope`,
   `start_at` and every line in §3.5 beyond the tag's step-4 sentence are the decision's contract,
   not the code. The tag's root selection — the checkout selection and the invocation-directory
   plain-folder loader — is unchanged at int/0.5.1 (8acb470b), where none of the wider walk or the
   knowledge contract is built either.
2. **The historical approval record's field spellings.** §3.6 describes the observation by its four
   facts; whether they are four keys or another shape is the registry spec's to fix with the storage
   adapter.
3. **`start_at` and the trust dialog.** The decision's `start_at: project` exception and its
   owner-only trust dialog are recorded here only as a field of the historical observation; whether
   their rules belong in this spec or in the launch spec is open.
4. **The README after the vault.** Whether the delivered README stays a file at
   `.agents/docs/README.md` or becomes a vault page named at a start is decided in direction
   (OD-20261018-10 to -12) and not in form.
5. **A mapping with no `path`.** The decision treats it as the absent-key default with a recorded
   visibility; whether the file should also accept an empty mapping (`knowledge: {}`) as the same
   form is open.
6. **The release exception.** Release checks running from a folder root are approved and stated as
   a `MAY`; no code builds the folder root at the tag.
7. **The store and configuration paths.** The refusals naming the per-user team configuration
   folder and approval-store directories depend on paths the registry spec will own; rule 10
   states the boundary, not the spelling.

## Revision log

- **Draft** (the writer, 2026-10-19): lifted from the accepted project-folder decision of
  2026-10-05, read against v0.5.0 (52db9b75) and int/0.5.1 (8acb470b); the checkout selection and
  the tag's plain-folder loader are stated as the code, and the rest as the decision's contract;
  no private link. S2 review fold (writer, 2026-10-19): the signed observation is labelled
  historical and current authority is the grant/create flow (OD-20261015-03); `approve` loses its
  matrix row and its approval-based rules 8 and 12; the `--file` claim is limited to the commands
  that accept it (`plan` and `feed` do not); `init`'s stub exception is stated with its authority;
  the `knowledge.invalid` note no longer points at the exit-codes registry; and the int/0.5.1
  read-at line says root-selection behavior unchanged.
