# team

Ship with a team that never sleeps. Specialized agents, from any lab.

`team` is a small command-line tool with no runtime dependencies. You set the roster, the agents do
the work, and you stay the one who decides. A project's team lives in `.agents/team.yaml` — the
seats, the model each one runs, how each signs its work, the rules it follows, the folders it may
touch; `team init`, or an agent, writes it for you. Commands check that file against a machine, a
session and a history, then build and watch the team. It runs teams in [herdr](https://herdr.dev).

- **Any model, in any seat.** Put the right specialized agent — from any lab — on each role, and
  swap it without rewriting the team.
- **Safe by design.** A clear line between what agents decide and what only you can — the team moves
  fast inside its envelope and stops at the edge.
- **The watch tells you.** It watches the session, reports idle seats, and nudges the operator.

The project's name is TeamCLI; the package and the command are `team`. The site is
[teamcli.io](https://teamcli.io), and the founding text is
[RFC 000](https://github.com/floor/teamcli/discussions/147).

**Status: early, herdr only.** This build parses and
validates the file, checks who is calling, and holds `add`, `answer`, `approve`, `check`, `doctor`,
`down`, `init`, `list`, `release`, `remove`, `status`, `up`, `watch` and `worktree`.

## Install

Node 22 or later runs the built command.

```sh
npm install -g team       # or run it without installing: npx team
team --version            # 0.4.8
```

## The file is private to each clone

`team init` keeps `.agents/team.yaml` out of git through `.git/info/exclude`, never by editing
`.gitignore`: a public repository shouldn't carry its roster. A fresh clone therefore has no team
file. Run `team init` to write one, or `team init --restore` to bring back the copy you last
approved on this machine. A file you receive from someone else runs nothing until you approve it
yourself.

## The file's format

A documented subset of YAML, read by the library's own parser: maps, lists, one-line `{ }` and
`[ ]`, plain and quoted values, comments. Anchors, aliases, tags, block scalars, several documents
in one file and duplicate keys are refused, with the line number. The file starts with `format: 1`.
The package ships the JSON Schema at `schema/team.schema.json`, and `team init` writes a `# yaml-language-server: $schema=…` line at the top of the file so editors validate it.
By example:

```yaml
format: 1                     # the only format this version reads
project: hello
coordinator: coordinator      # the seat that dispatches work
operator: coordinator         # the seat the watch reports to

identity:
  signature:
    commits:
      position: trailer       # last-line | trailer | anywhere
      exempt: [merge]         # merge commits need no signature

rules:                        # lines added to every seat's rules at launch. Rules delivered as a launch
                              # option (claude-code, grok) close with "These are standing rules, not a task.";
                              # rules typed as a first message (codex, cursor, antigravity) close with
                              # "These are standing rules, not a task: reply ready and wait for your brief."
  - Run the tests your change touches, not the whole suite.

workspace:
  mode: shared                # shared | worktree: the default for every seat

seats:
  - role: coordinator
    name: coordinator
    cli: cursor               # the launch profile
    vendor: meridian          # the model's maker
    model: Meridian           # the model's name, without its version
    version: "1"              # the release alone, quoted
    launch: cursor-agent      # the model is chosen inside Cursor; no approval flags: the profile adds them

  - role: implementer
    name: implementer
    cli: codex
    vendor: openai
    account: openai-hello     # the seat's account, when one lab has two; absent, its lab
    model: GPT Sol
    version: "6"
    display: GPT-6 Sol        # the lab's spelling, for the signature
    launch: codex -m gpt-6-sol -c model_reasoning_effort=high
    parked: true              # running, and not reported while idle

  - role: implementer
    name: implementer-deepseek
    cli: claude-code          # DeepSeek's model, run by Claude Code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    display: DeepSeek V4.1 Flash
    launch: team-deepseek     # a launcher on the PATH, holding the account's key and endpoint
    model_from: launcher      # optional: says outright the launcher picks the model; doctor notes
                              # it and says what checks the model — here nothing can, Claude Code's
                              # screen never names DeepSeek's
    count: 2                  # implementer-deepseek and implementer-deepseek-2

  - role: reviewer
    name: reviewer
    cli: antigravity
    vendor: google
    model: Gemini
    version: "3"
    launch: agy
    stopped: true             # kept in the file; `up` doesn't start it

budgets:                      # the owner's: reserve or floor per account, marks, freshness
  accounts:
    openai-hello:             # the account implementer spends
      kind: subscription
      reserve: 10%            # refuse a launch on a figure inside it
      sources: [status_line]  # the figure comes off Codex's status line
```

- `session` names the herdr session and defaults to `project`; `--session` overrides it.
- `coordinator` and `operator` name seats: the coordinator dispatches work, the operator receives
  the watch's reports and nudges.
- `identity.signature` is the rule `check` enforces: a template, where it must stand, and which
  commits are exempt. Commit signatures read `Agent: {display} · {role}`, pull request bodies
  `**Agent:** {display} · {role}`. Without `display`, the signature reads "model version"; with it,
  the lab's own spelling. `identity.since` skips an older history, `identity.humans` lists commit
  authors who don't sign, and `identity.forbidden` adds to the defaults — `^Claude-Session:` lines
  and session links are always refused.
- `seats[*].cli` picks the launch profile; `claude-code`, `codex`, `cursor`, `antigravity` and `grok` are available, and `team
  doctor` says what the others still need. `vendor`, `model` and `version` spell one seat's model.
  `account` names the budget account the seat spends when one lab has two; without it, the seat
  spends its `vendor`, and changing either is an edit the owner re-approves.
- `launch` is the plain command, without approval flags: the profile adds them. It runs in the
  folder the seat starts in — `~/.config/team/lobby` — and `team` never
  rewrites it: `team doctor` checks its first word there — one fully quoted literal with its quotes
  removed, the way a shell would run it — and any relative argument. `up` and `add` leave a seat
  out, saying the same words, when the first word is missing there, or when the first word is a shell
  (`sh`, `bash`, `zsh`, by name or by path) whose first argument is the script, not an option, and that
  relative script path resolves from the project root and not from that folder (an option-bearing
  line such as `zsh -x ../x` is a note); every other relative argument, and a line that quotes or
  substitutes text, is reported as not checked, never refused.
  `count: 2` makes the
  numbered names; `parked` keeps a seat out of idle reports, `stopped` keeps it out of `up`.
- `workspace.mode` is `shared` (every seat in the project) or `worktree` (each task in its own
  checkout, with `path`, `base` and `setup`). Every seat starts in `~/.config/team/lobby`, which
  `trust` lists as an absolute path along with the project root. `up` and `add` refuse a seat
  whose own folder is a protected checkout, and a legacy `trust` (project-relative patterns, or
  none) cannot launch until it is rewritten as those absolute paths and approved.

### Naming seats

The herdr session carries the project, so a seat's name is its role: `coordinator`, `implementer`,
`reviewer`. When a role is used twice, the model is added: `implementer-deepseek`. `up` and `add`
title the workspace with the seat's written `label` when the file has one. A seat with no written
label is titled `<name> · <role>`. Seats expanded from `count` each get a distinct title: a written
label is kept on the first instance and later instances append `-<n>` (the same suffix as the name),
and a seat with no written label already has a distinct name (`implementer-deepseek`,
`implementer-deepseek-2`). The model is not the title. `display` (itself defaulting to the model
and version, `Claude Opus 5.5`), and ` · ` plus `effort` when the seat sets one (`Grok 4.7 · high`),
is the pane's second line, set after launch. Left out, the stored `label` stays the model and
version in lowercase.
`team doctor` warns, and does not refuse the file, when a name or a stored label repeats the
project or the session.

The Codex profile is tested with CLI 0.157.0 to 0.161.0. Its status line is read for a weekly figure
(`weekly N% left`) when the pane is wide enough to show the number; a cut line is not a figure.
It adds `-a never -s danger-full-access`
for unattended execution, plus `--no-daemon --no-alt-screen` for the captured pane mode,
and checks login with `codex login status`. Rules go as a first message
only at an empty idle prompt; delivery is recorded after Codex starts working with the input
empty again. Nothing writes a lab's config or an `AGENTS.md`. `/exit` is sent only to a free
seat. Update and workspace-trust screens are reported and closed without input; the owner
handles them before relaunching. Other unrecognised layouts stay unknown.

The Antigravity profile is tested with CLI 1.2.16 (`agy`). It adds `--dangerously-skip-permissions`
for unattended execution, and checks authentication with `agy models`. Rules go as a first message
only at an empty idle prompt; delivery is recorded after the CLI starts working with the composer
empty again. Nothing writes a lab's config or an `AGENTS.md`. `/exit` is sent only to a free
seat. Workspace-trust screens are reported and closed without input; the owner trusts the folder
before relaunching. Other unrecognised layouts stay unknown.

Launching a Cursor seat, like launching cursor-agent by hand, creates Cursor's own project record
under ~/.cursor/projects for that folder; team writes no trust (.workspace-trusted) and no Cursor
config.

A seat's model is read off its screen through the profile's `status_model` rules. Each rule declares
what it can name: `yields`, the closed list of exact model names its templates spell, and
`version_like`, the version shapes it can spell those names with — a regular expression anchored at
both ends, refused as the profile loads otherwise. A declaration is what `team doctor` checks a launch
against, and a test over the captured screens keeps it honest: every declared name and version shape
is read back through the real reader. A profile without the two keys loads as it always has and names
no model, so `team doctor` says the seat's model can't be checked and keeps its warning — the safe
direction. `overrides.yaml` adds dialog and quota patterns only, so it cannot change how a model is
read.

`budgets` is the owner's: marks (percent used), how long a figure stays fresh, and each
account's reserve or floor. An account's `shared` key is informational; `team` does not act
on it. A seat spends its own `account:` when the file names one, its `vendor`
when it doesn't, so one lab's two accounts are two buckets; a pattern names the account it
measures, not the seat's. A `check` command is resolved to a file and hashed when the
owner approves. A change to that file leaves that account's check unapproved: it is
not run, and the account reads unknown, until the owner approves again. The rest of
the file still runs. `watch.quota_marks` is still read, with a warning, until you move it to
`budgets.marks`. A figure first seen on one seat does not count until it changes or a
second seat shows the same number. It goes stale from the moment it last changed, and
the last readings are kept in the state file beside the team file. `team status` prints
them, one row per account and window, when there is an account or a stored reading.

`examples/checks/codex-quota` is a check for an openai account. It ships with the package: with a
global install it is at `$(npm root -g)/team/examples/checks/codex-quota`, and it is
[examples/checks/codex-quota](https://github.com/floor/teamcli/blob/main/examples/checks/codex-quota)
in the repository. It is a Bun script — the check needs Bun on `PATH`, whatever runs `team` — and
it uses only built-in file modules, so there is no package to install beside it. Copy it onto
`PATH` and name that command:

```yaml
openai:
  kind: subscription
  reserve: 10%
  sources: [check, status_line]
  check: codex-quota
```

`team` runs a check with an empty environment plus `PATH` and `HOME`, so a
`CODEX_HOME` set in the owner's shell never reaches the script. It reads
`~/.codex/sessions`. When Codex's home is somewhere else, install a two-line
wrapper and name the wrapper as the check:

```sh
#!/bin/sh
CODEX_HOME=/path/to/codex exec /path/to/codex-quota
```

The wrapper sets `CODEX_HOME` and execs this script. The script takes rollouts
newest first. The first that has a `token_count` primary window is the one used, and
at most ten files are opened. A new session that has not recorded a figure yet
does not hide the last one. The line's `at` is that event's own time, so an
older figure stays dated. It prints the primary window, and a second line when
that event's secondary window is a different length, such as
`session 21% used resets 3h at 1791091200` and
`weekly 39% used resets 114h4m at 1791091200`. The same length is not printed
twice. A secondary figure that cannot be written is left off. When the primary
figure cannot be written, nothing is printed. Five hours (`300` minutes) is
`session`, a day (`1440`) is `daily`, and a week (`10080`) is `weekly`. Any other
length, a figure over 100%, or no such rollout prints nothing, so the account
reads unknown. `team approve` records the command you named. Bun has to be on
`PATH` when the check runs.

More fields exist — `dialogs`, `tools`, `trust`, `machine`, `limits`, `watch`, `visibility` and
`releases` — and the comments `team init` writes name them; validation refuses what it cannot
check, and this build acts on what the commands below read.

## Commands

| Command | What it does | Who may run it |
| --- | --- | --- |
| `team init` | writes the skeleton `.agents/team.yaml` and adds it and its runtime files to `.git/info/exclude` | the owner |
| `team approve` | reads the whole file back for a last look, then records it, its ceilings and its seats on this machine; `--show` prints it; `--confirm` asks for the seat count before writing | the owner (`--show`: anyone) |
| `team commits check <ref>` | checks one commit or a `a..b` range against the signature rule, `--since <ref>` skipping history already checked; exit 1 when one is refused | anyone; read only |
| `team pr check <file>` | checks a pull request's body against the signature rule (`-` reads stdin), needing no repository; exit 1 when it is refused | anyone; read only |
| `team doctor` | checks this machine for what the file needs: herdr, each CLI, login, launch line, model, watch heartbeat; `--login` checks only CLI sign-ins | anyone; read only |
| `team status` | prints the file's seats against the running session, each difference with its repair; `--json` outputs a stable JSON document (`format: 1`) for scripts; exit 1 when they differ | the owner, a seat of that team on its recorded pane, or a pane the approved file names; `--file` and `--session` are the owner's; read only |
| `team list` | lists the herdr sessions on this machine, running ones by default; `--all` includes stopped sessions; `--json` prints a stable array, empty when there is nothing; an orphan session and an unreadable seat do not fail it | anyone, from any folder; read only |
| `team up` / `team down` | starts / stops the session and its seats | `up`: the owner; `down`: the owner, the coordinator or the operator seat |
| `team watch` | watches the session, reports idle seats and nudges the operator; `--no-nudge` and `--no-notify` are the owner's and do not silence a report addressed to the owner | anyone, one per session; it types only a fixed line into an empty idle prompt: the report nudge, or `Team: run team messages` when a message is already waiting |
| `team messages` | verifies a message that is already waiting, prints its body and writes the receipt; no command writes a message record — `team send` writes to a seat's cross-session socket, not to this mailbox — and a report still leaves as the watch's nudge | anyone |
| `team send` | writes one message to one seat, confirming `delivered`, `answered`, `timeout`, `unreachable` or `refused`. A Claude Code seat takes a frame on the cross-session socket; a native CLI (codex, cursor, grok, antigravity) gets the body in a mode-0600 drop file and one short trigger, and `delivered` means herdr reported the seat working. `--wait [--timeout <s>]` blocks for a Claude Code seat's reply (120 seconds by default) and is refused for a native seat. `--json` prints one result document, `--file` reads the body from a file, `--dry-run` names the channel, writes no drop file, and types nothing (it appends one team.log line), and `--list` prints the addressable seats and sends nothing. Broadcast is not in this build | the owner, or the coordinator from its own seat (`--list`: anyone) |
| `team issues` | lists the typed records in the one file the team file names. The source is a file the owner committed. A broker source is read by `team next`, never from here: this command connects to no broker, holds no tracker credential, and has no seat gate. The broker runs as the same OS principal as the seat: that is integrity, not authenticity, and this command does not isolate anything. `title` and `description` are the owner's text. They are not scrubbed. The list is file order. A priority is shown and does not reorder. A listing is not a claim and not the intake rule. `team plan` prints the takeable queue and claims nothing. `repos` and `needs` are shown when the file has them. They are not a grant, and they are not checked. The watch's ring is unchanged: `Team: run team messages` | anyone |
| `team next` | claims one record from the team's one task source, with a lease in this clone. The source is a file the owner committed, or a tracker the owner's broker reads. On a broker source, `team next` asks the broker; with no broker running it refuses and claims nothing. The broker holds the tracker credential; this command never reads it. The broker runs as the same OS principal as the seat: that is integrity, not authenticity, and this command does not isolate anything. A lease is a file in this clone. Two live leases in this clone do not cover one id. Another clone, and another machine, are outside that promise. An expired lease returns the record to the queue. Another seat may take it, and the work may be done twice. The file is the intake for a file source; for a broker source it is the tracker's read, with the team's policy deciding which fields cross. That is not the owner-set intake rule. `team plan` prints the takeable queue and claims nothing. `title` and `description` are the owner's text. They are not scrubbed. A record with `blocked-by`, `repos`, or `needs` is listed by `team issues` and is not taken. A deadline is printed and not read as a time. A missed deadline is not decided here. `--wait` re-reads the source every `tasks.cadence` while a pass finds nothing takeable; without `tasks.cadence` it refuses. The wait polls at a constant pace; a refused read ends it — back-off is not implemented. Releasing a lease records no progress. The watch's ring is unchanged: `Team: run team messages` | a seat of this team, on the pane the state records for it |
| `team plan` | prints the queue a claim would consider, in the order `team next` would consider it. A plan is a listing: it claims nothing and writes no lease, and a record another seat holds can still appear. The queue is this clone's view of one source read. A deadline the clock has passed is marked `(overdue)`; the mark decides nothing — an overdue record is still takeable and is never dropped, blocked, reordered or released by lateness, and an unparseable deadline is printed as written and unmarked. On a broker source it asks the broker the same read `team next` asks, and claims nothing. Writes nothing: no lease file, no renewal, no state write, no tracker write | a seat of this team, on the pane the state records for it |
| `team broker` | `team broker` holds the tracker credential and answers `team next` over a local socket — the one process that reads the key. Owner-run, in a foreground terminal, one per clone; the key is read from the macOS Keychain once, at start, and the team file's `tasks.policy` filters every record before it crosses. It reads the tracker and never writes it. | the owner |
| `team add <name>` | starts one declared seat, or puts one back from the approved copy; `--temporary --like <seat> --until <end>` starts a seat the file does not hold | the owner, the coordinator or the operator |
| `team answer <seat> trust` | presses the one recorded key of a seat's folder-trust dialog, when the file's `dialogs` policy allows it; every check passes on two fresh reads of the pane, and anything else sends nothing | the owner, or the coordinator from its own seat |
| `team release check <package@version>` | checks one release's public npm and GitHub records: the version and its checksums, the tag, the release, the changelog entry | anyone; read only |
| `team remove <name>` | stops one seat, then takes it out of the file; `--keep` leaves it stopped; `--abandon` is the owner's, and types nothing | the owner, the coordinator or the operator; only the owner removes the coordinator or the operator |
| `team worktree list` / `team worktree new <task>` / `team worktree remove <task>` | lists the recorded worktrees, creates one from an up-to-date base, or removes its folder; a failed setup is kept and recorded; the branch is never deleted; ignored files in the worktree are deleted with it; `list` writes nothing | the owner, the coordinator or the operator |

Each command has its own page in [docs/commands](https://github.com/floor/teamcli/tree/main/docs/commands): the synopsis, what it reads and
writes, who may run it, every flag, the refusals with their exact text, the exit codes, and examples
that `bun run ci` runs against a fixture team.

The owner is a terminal outside herdr with no agent process above it. `approve` and `up` read the
processes above the call and refuse a seat — or a script a seat runs — that makes it: a guard
against a mistaken agent, not a hostile one, so a seat that forges the owner's placement is a
known limitation, being hardened. With no `--file`, the file is `.agents/team.yaml` of
the repository's main checkout, found through git's common directory. A folder that is not a git
repository is read from `.agents/team.yaml` in that folder only, not from a parent, and a link at
`.agents` or at the file is not followed. Every command
that reads the file also takes `--file <path>` for a file other than `.agents/team.yaml`.

A pane outside the team's session can be an approved **delegate**: the file's `delegates` section
names panes — `<herdr session>/<pane id>` — and, per pane, which of `up`, `down`, `add`, `remove`
and `approve` it may run. The caller is matched on the session and pane id, never on a seat, a
role or an agent name. `up`, `down`, `add` and `remove` run only while the live file is exactly
the approved one — drift is refused — and a command the entry does not list, or a prohibited
flag, is refused with the gate's own words and exit id; `--file` and `--session` are refused
outright. Every delegated run writes one line to the file's log naming the pane and the command.
A delegated `approve` is for ordinary changes — the roster, a launch line, a rule — and never
for any other owner section: the guard is an allowlist, and `rules` is all it admits, so
`delegates` first, and `budgets`, `limits`, identity, `trust`, the workspace, the operator and
orchestrator sections, and any section a later version adds are refused with `this change
needs the owner`, judged against the approved copy before anything else is read, so a delegate
can never approve a widening of its own grant. `team approve` prints the section's entries as
`Delegate:` lines before anything is written.

`team status --json` prints the facts `status` prints as one JSON document (`format: 1`) on stdout:
`project`, `session`, `rows` (`name`, `state`, `model`, `pane`), `notes`, `differences` (`what`, `repair`), and `notice`.

`team doctor --login` checks read-only that each CLI in the file is signed in, using each profile's
existing login check command (`cursor-agent status`, `agy models`, `codex login status`, `claude auth status`, `grok models`).
It never answers prompts and performs no sign-in action.

`team up`, `team down`, `team add`, `team remove`, `team worktree new` and `team worktree remove`
run live. `team worktree list` prints the recorded worktrees and writes nothing. `up`, `down` and `add` take `--dry-run` to print every command they would run, and every
refusal, and change nothing.

## Approvals are signed

`team approve` writes the record signed: the approval, the stored copy of the file, the project
root and a per-project number, covered by one signature whose key lives outside the store, in
`~/.config/team-key`. Every command that needs an approval in force verifies the whole record
through one snapshot; a record changed after approval, signed for another root, or replayed from an
older number is not an approval, and the command says which case it was. Each approval moves the
number and prints it with the signing key's short fingerprint — `approval #4 for this project;
the last one was on 2026-10-04; key fe21ef6293de.` — and `team doctor` and `team status` show
the same three: the number, its date, the key.

Approvals guard against mistakes, not against a hostile process running as the owner. The
signature refuses a record changed by something that does not use the key; a process that can
read the key can re-sign any record at the number it already had, and nothing `team` shows will
differ. What a replaced key does change is the fingerprint: an owner who noted it sees the swap.
That is evidence, not prevention — `team` computes the fingerprint, and a seat can replace `team`
itself.

A record written by an earlier `team`, before records were signed, is refused by `up` and `add`
with `approved before records were signed: run \`team approve\` once`; the watch keeps watching,
`status` keeps reporting, `down` and `remove` keep working, and approving once replaces the record
with a signed one.

## Your first team in five minutes

```sh
mkdir hello && cd hello && git init
team init                  # the owner: writes .agents/team.yaml, private to this clone
$EDITOR .agents/team.yaml  # name your seats — the example above is a working file; any CLI fits any role
team approve               # the owner: read the file it prints, then record it (--confirm asks first)
team doctor                # what this machine still needs
team up --dry-run          # every command it would run, and every refusal
team up                    # the owner: starts the session and its seats
```

`team init` writes a skeleton, one seat and lots of comments; it prints how the file stays private,
and leaves your first commit as a commented `#   since:` line. `team approve` prints the whole file
back before it records anything — a terminal with input already waiting is refused, so no file
approves itself unnoticed, and `--confirm` asks you to type how many seats it holds first. Then
`doctor` says what is missing on this machine, `up --dry-run` shows every command the launch would
run — and `up` starts the team, from the owner's terminal outside herdr.

## Development

To run this tree's command from a clone instead of npm:

```sh
git clone https://github.com/floor/teamcli.git
cd team
bun install
bun run build
npm install -g .          # puts `team` on the PATH
team --version            # 0.4.8
```

Bun builds and tests the sources:

```sh
bun install
bun run typecheck
bun test
bun run build        # dist/, which runs on Node 22 or later
bun run ci           # what CI runs: typecheck, tests, build, then the built command, the
                     # conformance run, and the schema, contract, coverage and exit-code checks
```

Sources import each other with `.ts` extensions and use erasable syntax only, so Node can run them
directly; `tsc` writes `dist/` for the published command. CI runs the Linux test job (`test (ubuntu-latest)`)
and `team commits check` and `team pr check` on every pull request, against the team file the repository keeps at `.github/team.yaml`.
Before a merge, the author quotes their own full `bun run ci` run on the exact head in the pull request,
and at least one reviewer who is not the author runs `bun run ci` on a macOS machine on the exact head
under review, quoting its exit status and final line in their review; a review verdict without that quote
is not an approval. (At least one reviewer rather than every reviewer: one test reads the host process
table, which a sandboxed reviewer cannot do; a sandboxed reviewer quotes what failed and why, and the
unsandboxed run carries the evidence.) The hosted macOS job is read after each merge, running on every
push to `main`, nightly, and on manual dispatch; a red macOS run on `main` is fixed before anything else.

### The end-to-end run

`bun run e2e` drives the real commands — `status`, `watch` (one pass), `add --temporary --like`,
`remove` and `down` — against fake seats, in a herdr session of its own (`team-test-e2e`) that it
creates and always stops and deletes. A fake seat is `scripts/fake-seat.ts`: a pane that draws one
of the screens the commands classify, logs every byte typed at it, and leaves on `/exit` and Enter.
No model runs and nothing reaches the network. After each command the run checks its exit code, its
own output, the log lines it wrote to `.agents/team.log`, and the seat records in
`.agents/team.state.json`.

It is local only: CI has no herdr, so `bun run ci` does not run it. It refuses to start when herdr
is not on the PATH, when the machine is over its gate (load under 60, 25 % memory free, swap not
growing over a minute), or when a session named `team-test-e2e` already exists. It works in a fresh
folder under the system's temporary directory — the project, the approval store and the fake seats'
input logs — and prints that path; it never writes the owner's home. It reads the default herdr
session's agent list before and after, and fails when the count changes.

Every check prints a line; the run ends with `all N checks passed` or `M of N checks failed` and
exits 2 when it refused to start, 1 when a check failed. A failed step skips the steps after it,
and the session is stopped and deleted on every path.

## Releasing

The owner cuts a release by pushing a version tag: `git tag v0.2.0 && git push origin v0.2.0`. The
Release workflow (`.github/workflows/release.yml`) refuses a tag that isn't `package.json`'s
version or whose commit isn't on `main`, runs `bun run ci`, then publishes with npm trusted
publishing — the workflow's own identity, no token stored — and provenance. A version with a
hyphen (`0.2.0-next.1`) goes under the `next` dist-tag, any other under `latest`. Once npm has the
version, the same run creates the GitHub release from the `CHANGELOG.md` section for it, marked a
pre-release when the version is one. If the GitHub release step fails — a missing changelog
section, say — use "Re-run failed jobs": a full re-run goes back through `npm publish`, which
fails because that version is already on npm. A tag ruleset protecting `v*`, so that only the
owner creates version tags, is recommended.

The same workflow can be started by hand. That run is the Linux and macOS verify matrix through the
pack. npm publish and the GitHub release run only on a push of a `v*` tag.

Trusted publishing must be bound once, by the package owner, on npmjs.com: the package `team` →
Publishing → trusted publishers → GitHub Actions, naming `floor/teamcli` and the workflow file
`release.yml`; until then the workflow cannot publish.

## License

MIT
