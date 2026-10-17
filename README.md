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

**Status: early, herdr only.** This build parses and validates the file, checks who is calling,
and holds every command `team --help` lists — from `team init`, `team up` and `team status` to
`team send`, `team seats`, `team register`, `team grant` and the work queue (`team issues`,
`team next`, `team plan`).

## What's new in 0.5.0

The first release since 0.3.5, and the first to ship on npm since it. The full list is in
[CHANGELOG.md](CHANGELOG.md).

- **A registry, and `team register`.** The machine records the agents, teams and projects it has
  seen, and a seat that is already running is written in — without a relaunch — so `team send`,
  `team seats`, `team watch` and `team down` can address it.
- **`team send`, and the channel it takes.** A plain send walks the receiving seat's delivery
<<<<<<< HEAD
  order — `native`, `mcp-inbox`, `typed`, then `drop` by default, and a level of that seat's chain
  may drop legs or reorder the ones it keeps, never add one. This build carries no mcp-inbox leg
  and makes no socket write, so the legs the walk keeps and cannot take are recorded `unavailable`
  and the send goes by the drop file and one trigger line — or, on a seat that opts into the
  `drop` leg, by the same drop file alone, with nothing typed into the pane. `--wait` is refused
  for every seat — a Claude
  Code seat's refusal names the native leg (`team route` and the caller's own `SendMessage`) that
  will carry a waited send, any other seat its own reason, and a Claude Code seat whose delivery
  order does not lead with the native leg is refused for that, naming the order in force — and
  nothing is written. A sender with its own cross-session tool takes the native channel — `team
  route <seat>` answers the address, and `team send --record <seat> --channel native --ms <n>`
  writes the delivery down. Every run ends in one word — `delivered`, `answered`, `held`,
=======
  order — `native`, `mcp-inbox`, `typed` by default, and a level of that seat's chain may drop
  legs or reorder the ones it keeps, never add one. This build carries no mcp-inbox leg and
  makes no socket write, so a send goes by the drop file and one trigger line unless the sender's
  own file declares Claude Code and the receiving seat is Claude's: `team send` then prints a
  native handoff — the exact target, the body and the `team send --confirm <id>` line — and the
  sender's own SendMessage carries the message, the confirm writing the one history line.
  `--wait` is refused for every seat — a Claude Code seat's refusal names the native leg
  (`team route` and the caller's own `SendMessage`) that will carry a waited send, any other seat
  its own reason, and a Claude Code seat whose delivery order does not lead with the native leg
  is refused for that, naming the order in force — and nothing is written. `team route` answers
  the address and the rule beside a handoff, and `team send --record <seat> --channel native
  --ms <n>` writes down a delivery made without one. Every run ends in one word — `delivered`, `answered`, `held`,
>>>>>>> d9c8698b (feat(send): hand the native leg to the sender and record it on --confirm)
  `not-submitted`, `timeout`, `unreachable` or `refused` — and the history `team feed` reads
  keeps the milliseconds, the channel it went by and the legs that failed. A seat its file marks
  `assistant: true` — one per file, never a seat with `count` — is its entity's assistant: the
  routing admits it to the entity's main coordinator, by its place in the chain and never by a
  role's name.
- **Projects.** A team names the project it sits in; `team projects` lists them, and
  `team status --project <name>` covers one project's teams.
- **Seat state, live.** `team seats` gives each seat a STATE and the SOURCE it was read from, a
  blind seat is called blind, and the pane's sidebar lines are the file's own text.
- **Grants and delegates, the owner's alone.** `team grant` records what a seat or a team may do
  — the team file's one grant by `--scope`, or a signed standing record by `--capabilities` — and
  `team delegate` records a pane outside the team; `team revoke` takes any of them back.
- **`team approve` is gone.** The file in the clone is the record, and `team up` admits from it.
- **`team check` is integrity, not authority.** It reads and reports — the differences, each with
  its repair — and grants nothing: a clean answer approves no change, starts no seat and gives no
  right.

## Install

Node 22 or later runs the built command.

```sh
npm install -g team       # or run it without installing: npx team
team --version            # 0.5.0
```

## The file is private to each clone

`team init` keeps `.agents/team.yaml` out of git through `.git/info/exclude`, never by editing
`.gitignore`: a public repository shouldn't carry its roster. A fresh clone therefore has no team
file. Run `team init` to write one, or `team init --restore` to bring back the copy this machine
stored, where it holds one. A file you receive from someone else is read as it stands; read it
before you run `team up`.

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
- `in_project` names the project this team sits in, by the project's display name, while `project:`
  keeps meaning the team's own name; `project_lead: true` beside it marks the team that leads that
  project — one team per project, and `team check` refuses a second. The project's record then
  carries the lead: the agent of the seat this file's `leads: true` marks as the team's lead,
  re-resolved on every launch, so a mark that moves in the file moves the record with it.
- `entity` names the entity this team belongs to: the level above its project that a setting, the
  lobby's `<entity>` folder and a lead pair's reach are read from, and the name that makes two
  teams one entity's when both files carry it.
- `lobby` names the folder every seat except a lead starts in: the file's own `lobby:` wins over
  the lobby the registry recorded for the session and over the defaults, and setting it records
  that lobby for the session. The `workspace.mode` bullet below states the whole resolution order.
- `coordinator` and `operator` name seats: the coordinator dispatches work, the operator receives
  the watch's reports and nudges. `leads: true` on a seat is the same lead, spelled on the seat
  the way `coordinator:` names it. `assistant: true` marks a seat as its entity's assistant — the
  one seat `team send` admits to its entity's main coordinator, by its place in the chain and
  never by a role's name. At most one seat of a file carries the mark, and never a seat with
  `count`; the entity's assistant is the first mark found walking its teams in chain order — the
  entity's own team first, then its other teams by team id, rosters in the order the file writes
  them — so an entity whose files mark none has no assistant.
- `identity.signature` is the rule `check` enforces: a template, where it must stand, and which
  commits are exempt. Commit signatures read `Agent: {display} · {role}`, pull request bodies
  `**Agent:** {display} · {role}`. Without `display`, the signature reads "model version"; with it,
  the lab's own spelling. `identity.since` skips an older history, `identity.humans` lists commit
  authors who don't sign, and `identity.forbidden` adds to the defaults — `^Claude-Session:` lines
  and session links are always refused.
- `seats[*].cli` picks the launch profile; `claude-code`, `codex`, `cursor`, `antigravity` and `grok` are available, and `team
  doctor` says what the others still need. `vendor`, `model` and `version` spell one seat's model.
  `account` names the budget account the seat spends when one lab has two; without it, the seat
  spends its `vendor`, and changing either is an edit only the owner makes.
- `launch` is the plain command, without approval flags: the profile adds them. It runs in the
  folder the seat starts in — the team's lobby, or the project folder for a lead — and `team` never
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
  checkout, with `path`, `base` and `setup`). Every seat except a lead starts in the team's lobby —
  the file's `lobby:` if it sets one, else the lobby the registry recorded for the session, else
  `<home>/.config/team/lobbies/<entity>` if it names `entity:`, else the machine-global
  `~/.config/team/lobby`. `trust` lists that lobby's entry — `~/…` under the home, absolute
  otherwise — along with the project root. `up` and `add` refuse a seat
  whose own folder is a protected checkout, and a legacy `trust` (project-relative patterns, or
  none) cannot launch until it is rewritten as those absolute paths.

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

The Claude Code profile is tested with CLI 2.1.288 to 2.1.302 (`claude`).

The Codex profile is tested with CLI 0.157.0 to 0.161.0. Its status line is read for a weekly figure
(`weekly N% left`) when the pane is wide enough to show the number; a cut line is not a figure.
It adds `-a never -s danger-full-access`
for unattended execution, plus `--no-daemon --no-alt-screen` for the captured pane mode,
and checks login with `codex login status`. Rules go as a first message
only at an empty idle prompt; delivery is recorded after Codex starts working with the input
empty again. Nothing writes a lab's config or an `AGENTS.md`. `/exit` is sent only to a free
seat. Update and workspace-trust screens are reported and closed without input; the owner
handles them before relaunching. Other unrecognised layouts stay unknown.

The Antigravity profile is tested with CLI 1.2.16 to 1.4.2 (`agy`). It adds `--dangerously-skip-permissions`
for unattended execution, and checks authentication with `agy models`. Rules go as a first message
only at an empty idle prompt; delivery is recorded after the CLI starts working with the composer
empty again. Nothing writes a lab's config or an `AGENTS.md`. `/exit` is sent only to a free
seat. Workspace-trust screens are reported and closed without input; the owner trusts the folder
before relaunching. Other unrecognised layouts stay unknown.

The Jules profile is tested with CLI 0.1.42 to 0.1.42 (`jules`). Its ready screen is the session
table, whose input line reads ` > Search sessions or type / to use`; its task box asks
`What do you want Jules to work on?`. The TUI has no standing session, so rules are prepended to
every brief, and a brief is typed through the CLI's own screens — `/`, the repo chooser, the task
box, the create confirmation — with the CLI's `Session created:` line as the delivery proof. A send
names only the repo of the seat's own folder: the module proves the chooser collapsed on it before
it types, and refuses when the account's list does not hold it. One `ctrl+c` at the table quits,
and the profile sends no other exit key; it never sends the table's `ctrl+d` delete, and the rules
every jules seat receives carry `Never delete a Jules session.` herdr reports a jules pane as no
agent, and its status unknown, so the profile says `herdr_status: unreliable`: readiness is read
from the screen, a pane herdr has not listed is named by its own process, and `down`, `restart`
and `remove` treat the idle table as free where they would otherwise wait on a word herdr cannot
give. Status, check and the watch read the seat's state from the same screen: its idle table is
idle, a running turn is working, and only a screen the profile cannot read is unknown.

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
measures, not the seat's. A `check` command is resolved to a file and hashed in the record
this machine keeps. A change to that file leaves that account's check unapproved: it is
not run, and the account reads unknown. The rest of the file still runs. `watch.quota_marks` is still read, with a warning, until you move it to
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
reads unknown. The file names the command the check runs. Bun has to be on
`PATH` when the check runs.

More fields exist — `tools`, `trust`, `machine`, `limits`, `watch`, `visibility` and
`releases` — and the comments `team init` writes name them; validation refuses what it cannot
check, and this build acts on what the commands below read.

## Commands

| Command | What it does | Who may run it |
| --- | --- | --- |
| `team init` | writes the skeleton `.agents/team.yaml` and adds it and its runtime files to `.git/info/exclude` | the owner |
| `team commits check <ref>` | checks one commit or a `a..b` range against the signature rule, `--since <ref>` skipping history already checked; exit 1 when one is refused | anyone; read only |
| `team pr check <file>` | checks a pull request's body against the signature rule (`-` reads stdin), needing no repository; exit 1 when it is refused | anyone; read only |
| `team doctor` | checks this machine for what the file needs: herdr, each CLI, login, launch line, model, watch heartbeat; `--login` checks only CLI sign-ins | anyone; read only |
| `team status` | prints the file's seats against the running session, each difference with its repair; `--json` outputs a stable JSON document (`format: 1`) for scripts; exit 1 when they differ | the owner, a seat of that team on its recorded pane, or a pane the live file's `delegates` names; `--file` and `--session` are the owner's; read only |
| `team list` | lists the herdr sessions on this machine, running ones by default; `--all` includes stopped sessions; `--json` prints a stable array, empty when there is nothing; an orphan session and an unreadable seat do not fail it | anyone, from any folder; read only |
| `team projects` | lists the registry's projects — each one's immutable id, display name, entity, lead by agent id and teams; `--json` prints the records as one document; a team that names no project reads as its own project | anyone, from any folder; read only |
| `team up` / `team down` | starts / stops the session and its seats | `up`: the owner or the team's lead seat, or a delegate entry naming `up`; a verified grant admits the orchestrator's seat where the map's row does not; `down`: the owner or the team's lead seat, or a delegate entry |
| `team hold <reason> [--until <time>]` / `team hold --release` | records a hold on the team's work in the team state, shown as the first `note:` in `team status` and a `--  ` line in `team doctor`; `--until` is a local `<HH:MM>` or an ISO 8601 instant, and a record past it reads as no hold at all; `--release` clears it; nothing else consults a hold in this build | the owner, the coordinator or the operator seat |
| `team watch` | watches the session, reports idle seats and nudges the operator; `--no-nudge` and `--no-notify` are the owner's and do not silence a report addressed to the owner | anyone, one per session; it types only a fixed line into an empty idle prompt: the report nudge, or `Team: run team messages` when a message is already waiting |
| `team tempo <word>` | sets the team's tempo to relaxed, normal or urgent, which scales the watch's idle and nudge waits; normal is the file with the key omitted | the owner |
| `team messages` | verifies a message that is already waiting, prints its body and writes the receipt; no command writes a message record — `team send` delivers to a seat's pane and drop file, not to this mailbox — and a report still leaves as the watch's nudge | anyone |
| `team send` | writes one message to one seat, confirming `delivered`, `answered`, `held`, `not-submitted`, `timeout`, `unreachable` or `refused`. A plain send walks the receiving seat's delivery order — `native`, `mcp-inbox`, `typed`, then `drop` by default, and a level of that seat's chain may drop legs or reorder the ones it keeps, never add one — and gives the seat the body in a mode-0600 drop file and one short trigger line — or, on a seat whose order leads with `drop`, that drop file alone with nothing typed — and `delivered` means herdr reported the seat working (or the transcript shows the drop read) and the trigger left the seat's input box, or, on the drop leg, the file is in place. This build carries no mcp-inbox leg and makes no socket write, so a send goes by the typed leg (or, when its order says so, the drop leg) unless the sender's own file declares Claude Code and the seat is Claude's, where `team send` prints a native handoff — the exact `to:` target, the body and the `team send --confirm <id>` line — for the sender's own SendMessage, and the legs whose absence the walk records are recorded `unavailable` on the history line. `--wait [--timeout <s>]` — the waited send that frame would carry — is refused for every seat: a Claude Code seat with `needs the native leg (team route + your own SendMessage)`, a native seat with its own reason, and any seat whose delivery order does not lead with the native leg, and nothing is written. `--json` prints one result document, `--file` reads the body from a file, `--dry-run` names the channel or the refusal, writes no drop file, and types nothing (it appends one team.log line), `--confirm <id>` writes the one history line a native handoff promised and clears its pending record, and `--list` prints the addressable seats, each with its project, and sends nothing. Broadcast is not in this build | the owner; an orchestrator to another orchestrator of its own entity; an orchestrator or operator to a seat of its own team; an assistant seat to its entity's coordinator; a seat to its own team's orchestrator; or an owner-signed `send` grant (`--list`: anyone) |
| `team issues` | lists the typed records in the one file the team file names. The source is a file the owner committed. A broker source is read by `team next`, never from here: this command connects to no broker, holds no tracker credential, and has no seat gate. The broker runs as the same OS principal as the seat: that is integrity, not authenticity, and this command does not isolate anything. `title` and `description` are the owner's text. They are not scrubbed. The list is file order. A priority is shown and does not reorder. A listing is not a claim and not the intake rule. `team plan` prints the takeable queue and claims nothing. `repos` and `needs` are shown when the file has them. They are not a grant, and they are not checked. The watch's ring is unchanged: `Team: run team messages` | anyone |
| `team next` | claims one record from the team's one task source, with a lease in this clone. The source is a file the owner committed, or a tracker the owner's broker reads. On a broker source, `team next` asks the broker; with no broker running it refuses and claims nothing. The broker holds the tracker credential; this command never reads it. The broker runs as the same OS principal as the seat: that is integrity, not authenticity, and this command does not isolate anything. A lease is a file in this clone. Two live leases in this clone do not cover one id. Another clone, and another machine, are outside that promise. An expired lease returns the record to the queue. Another seat may take it, and the work may be done twice. The file is the intake for a file source; for a broker source it is the tracker's read, with the team's policy deciding which fields cross. That is not the owner-set intake rule. `team plan` prints the takeable queue and claims nothing. `title` and `description` are the owner's text. They are not scrubbed. A record with `blocked-by`, `repos`, or `needs` is listed by `team issues` and is not taken. A deadline is printed and not read as a time. A missed deadline is not decided here. `--wait` re-reads the source every `tasks.cadence` while a pass finds nothing takeable; without `tasks.cadence` it refuses. The wait polls at a constant pace; a refused read ends it — back-off is not implemented. Releasing a lease records no progress. The watch's ring is unchanged: `Team: run team messages` | a seat of this team, on the pane the state records for it |
| `team plan` | prints the queue a claim would consider, in the order `team next` would consider it. A plan is a listing: it claims nothing and writes no lease, and a record another seat holds can still appear. The queue is this clone's view of one source read. A deadline the clock has passed is marked `(overdue)`; the mark decides nothing — an overdue record is still takeable and is never dropped, blocked, reordered or released by lateness, and an unparseable deadline is printed as written and unmarked. On a broker source it asks the broker the same read `team next` asks, and claims nothing. Writes nothing: no lease file, no renewal, no state write, no tracker write | a seat of this team, on the pane the state records for it |
| `team broker` | `team broker` holds the tracker credential and answers `team next` over a local socket — the one process that reads the key. Owner-run, in a foreground terminal, one per clone; the key is read from the macOS Keychain once, at start, and the team file's `tasks.policy` filters every record before it crosses. It reads the tracker and never writes it. | the owner |
| `team add <name>` | starts one declared seat, clearing a `stopped: true` mark the file carries; `--temporary --like <seat> --until <end>` starts a seat the file does not hold | the owner, or a delegate entry (same-copy seats only), or a caller an active create-grant names by registry id |
| `team register <seat>` | writes the record for a seat that is already running — a pane herdr places under that name, holding a CLI at the seat's prompt — so `team send`, `team seats`, `team watch` and `team down` can address it; it types nothing into the pane, and never overwrites a record that names another pane; `--dry-run` prints the line the real run would print and writes nothing | the owner or a seat of this team, a delegate the file names for `up`, or the seat a grant names for it |
| `team answer <seat> trust` | presses the one recorded key of a seat's folder-trust dialog, when a `dialogs.trust` team grant is in force; every check passes on two fresh reads of the pane, and anything else sends nothing | the owner, or the coordinator from its own seat |
| `team release check <package@version>` | checks one release's public npm and GitHub records: the version and its checksums, the tag, the release, the changelog entry; warns, without running it, when npm's `next` dist-tag points below `latest` | anyone; read only |
| `team remove <name>` | stops one seat, then takes it out of the file; `--keep` leaves it stopped; `--abandon` is the owner's, and types nothing | the owner or the team's lead seat, or a delegate entry; only the owner removes the orchestrator's or the operator's seat |
| `team worktree list` / `team worktree new <task>` / `team worktree remove <task>` | lists the recorded worktrees, creates one from an up-to-date base, or removes its folder; a failed setup is kept and recorded; the branch is never deleted; ignored files in the worktree are deleted with it; `list` writes nothing | the owner, the coordinator or the operator |

Each command has its own page in [docs/commands](https://github.com/floor/teamcli/tree/main/docs/commands): the synopsis, what it reads and
writes, who may run it, every flag, the refusals with their exact text, the exit codes, and examples
that `bun run ci` runs against a fixture team. [herdr as a team uses
it](https://github.com/floor/teamcli/blob/main/docs/reference/herdr.md) — the session, the
workspaces and panes a team lives in, and the two names a seat shows — is the reference beside them.

The owner is a terminal outside herdr with no agent process above it. `up` reads the
processes above the call and refuses a seat — or a script a seat runs — that makes it: a guard
against a mistaken agent, not a hostile one, so a seat that forges the owner's placement is a
known limitation, being hardened. With no `--file`, the file is `.agents/team.yaml` of
the repository's main checkout, found through git's common directory. A folder that is not a git
repository is read from `.agents/team.yaml` in that folder only, not from a parent, and a link at
`.agents` or at the file is not followed. Every command
that reads the file also takes `--file <path>` for a file other than `.agents/team.yaml`.

A pane outside the team's session can be an approved **delegate**: the file's `delegates` section
names panes — `<herdr session>/<pane id>` — and, per pane, which of `up`, `down`, `add`, `remove`
and `swap` it may run. `swap` is the word that admits `remove <lead> --keep` and `add <lead>` —
the replacement of the agent on the orchestrator's or the operator's seat — and `remove` alone
never admits a lead. The caller is matched on the session and pane id, never on a seat, a role or
an agent name. `up`, `down`, `add` and `remove` read the live file, and a command the entry does
not list, or a prohibited flag, is refused with the gate's own words and exit id; `--file` and
`--session` are refused outright. Every delegated run writes one line to the file's log naming the
pane and the command.

`team status --json` prints the facts `status` prints as one JSON document (`format: 1`) on stdout:
`project`, `session`, `rows` (`name`, `state`, `seat_state`, `seat_state_source`, `model`, `pane`; the two seat-state fields appear where a reading was found), `notes`, `differences` (`what`, `repair`), and `notice`.

`team doctor --login` checks read-only that each CLI in the file is signed in, using each profile's
existing login check command (`cursor-agent status`, `agy models`, `codex login status`, `claude auth status`, `grok models`).
It never answers prompts and performs no sign-in action.

`team up`, `team down`, `team add`, `team remove`, `team worktree new` and `team worktree remove`
run live. `team worktree list` prints the recorded worktrees and writes nothing. `up`, `down` and `add` take `--dry-run` to print every command they would run, and every
refusal, and change nothing.

## The live file is the record

The commands read the file in the clone. Edit it, then run team up. A record an earlier `team`
left on this machine is still checked where a command needs one that verifies. A legacy record is
refused with `approved before records were signed`. A record that does not verify is refused with
the case. A missing record is not a refusal. Approvals guard against mistakes, not against a hostile
process running as the owner. The watch keeps watching, and `status` keeps reporting.

## Your first team in five minutes

```sh
mkdir hello && cd hello && git init
team init                  # the owner: writes .agents/team.yaml, private to this clone
$EDITOR .agents/team.yaml  # name your seats — the example above is a working file; any CLI fits any role
team doctor                # what this machine still needs
team up --dry-run          # every command it would run, and every refusal
team up                    # the owner: starts the session and its seats
```

`team init` writes a skeleton, one seat and lots of comments; it prints how the file stays private,
and leaves your first commit as a commented `#   since:` line. Edit the file, then
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
team --version            # 0.5.0
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
folder under the system's temporary directory — the project, the record store and the fake seats'
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
