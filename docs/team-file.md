# The team file

`team` reads one team file per clone: `.agents/team.yaml` under the project root, or the path
`--file` names. It is a documented subset of YAML, read by the library's own parser — maps, lists,
one-line `{ }` and `[ ]`, plain and quoted values, comments; anchors, aliases, merge keys, tags,
block scalars, a second document and duplicate keys are refused, with the line number. The JSON
Schema ships at `schema/team.schema.json`, and `team init` writes a
`# yaml-language-server: $schema=…` line so editors validate the file. The format is walked
below, by example; after it, this page documents the sections one by one.

With no `--file`, the file is `.agents/team.yaml` of the repository's main checkout, found
through git's common directory, so a run inside a linked worktree reads the main checkout's file;
a folder that is not a git repository is read from `.agents/team.yaml` in that folder only, not
from a parent, and a link at `.agents` or at the file is not followed.

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
  the watch's reports. `leads: true` on a seat is the same lead, spelled on the seat
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

The Cursor profile is tested with CLI 2026.10.01 to 2026.10.19 (`cursor-agent`). The 2026.10.19
capture is its ready screen, and its dialog and working shapes are those captured at 2026.10.16.

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
check, and this build acts on what [the commands](commands/README.md) read.

## `tasks`

Names the team's one task source. It is an owner section: only the owner writes it. Omitted, it
reads as `null` and `team issues` refuses rather than inventing a path.

```yaml
tasks:
  source: file
  path: .agents/tasks.yaml
```

or, for a tracker behind the owner's broker:

```yaml
tasks:
  source: linear
  linear:
    project: 01234567-89ab-cdef-0123-456789abcdef
    keychainService: team.linear.acme
  policy:
    omit: [description]
    transform:
      id: bare
```

- `source` is `file` or `linear`. A file source is the list the owner committed; a broker source
  is a tracker the owner's broker reads — the credential stays with the broker (`team broker`),
  and `team next` asks it over `.agents/broker.sock`. `team issues` lists a file source only.
- `path` is required for `source: file` and refused for `source: linear`. It is relative to the
  checkout and must stay inside it. An absolute path, a `~` path, or a `..` that leaves the
  checkout is refused: `tasks.path must stay inside the checkout`. The linear block is refused the
  other way: `tasks.linear is for source: linear`.
- `linear` is required for `source: linear`, with exactly `project` and `keychainService`. A
  missing half is `tasks.linear.project is required` or `tasks.linear.keychainService is
  required`.
- `policy` is for `source: linear` — for `source: file` it is refused with `tasks.policy is for a
  broker source; source: file has no broker`. It says which record fields cross the broker's
  boundary: `allow` names the set, `omit` removes from the default, the two are not used together
  (`tasks.policy: allow and omit are not used together`), and `id` and `title` are the record
  itself — `allow` must name both, `omit` must name neither. A name that is not a task field is
  `tasks.policy.allow lists "foo", not a task field` (likewise `omit`). With no `policy` the nine
  typed fields cross and `description` does not. `transform` has one defined value, `id: bare`:
  an id that arrives as its source URL crosses as its last `/`-separated segment. Anything else is
  `tasks.policy.transform: only id: bare is defined in this build`.
- `pull` is optional: `self` or `any`. Omitted, `team next` treats it as `self` and the parsed
  section does not gain the key. Any other value is `tasks.pull must be self or any`.
- `fallback` is optional: `file` or `id`. It orders records that have no priority. Omitted, those
  records keep file order. It does not reorder a record that has a priority. Any other value is
  `tasks.fallback must be file or id`.
- `cadence` is optional: a duration with its unit written, in `s`, `m` or `h`, such as `120s` or
  `10m`. Omitted, the parsed section does not gain the key, and no default is supplied.
  `cadence` is the pace `team next --wait` re-reads the source at. It governs nothing else: not
  the watch, not the lease. Zero is not a pause: a value that measures to zero, such as `0s` or
  `0.0m`, is `tasks.cadence must be greater than zero`. Any other value, including a quoted one,
  is `tasks.cadence needs a value with its unit (s, m, h), such as 120s or 10m`.
- Any other key, including `backoff` and `quiet_hours`, is an unknown field.

The file at `path` is a YAML list of task records. `team issues` reads it. `team next` claims one
record from it, and claims one from a broker source's read the same way — the lease stays local
either way. Nothing in this build writes the file or the tracker.

## `seats`

Each seat names a model and how it is launched. `model` and `version` are required even when
the launch picks the model itself: for a CLI that chooses its own — or one whose screen names
no model — write the CLI's own name and version as the pair (`model: Jules`,
`version: "0.1.42"`) and mark the seat `model_from: launcher`, which tells `doctor` that the
launcher chooses it and checks the running seat instead of the launch line. The orchestrator
and the operator start in the project folder. Every other seat starts in the team's lobby. A lead already running in
either folder is left there. The fields are in
[the file format](#the-files-format). The sidebar has two lines:

- `label`, when the file writes one, is line 1, the workspace title. A seat expanded from
  `count` keeps that label on the first instance; each later instance appends `-<n>`, the same
  suffix the seat's name gets, so the lines differ (`desk`, `desk-2`).
- A seat with no written label is titled `<name> · <role>`. Count instances already have
  distinct names (`maker`, `maker-2`), so their lines differ too. The model is never line 1.
- Left out, the stored `label` stays the model and version in lowercase, as a file written that
  way has always read. That stored field stays in the seat's digest.
- `display` defaults to `model` and `version` (`Claude Opus 5.5`). It must contain the version
  as a token of its own when the file writes it. After launch, `up` and `add` set the pane's
  display_agent to `<display> <effort>` when the seat sets `effort`, and to `<display> default`
  when it does not. A CLI whose launcher takes no effort setting is the display alone —
  `Jules 0.1.42`, with no effort word and no `default`. The display stays the proper-case name,
  including a multi-word model (`DeepSeek V4.1 Flash`, `Gemini 3.8 Flash`). Herdr draws line 2
  as its status word, then ` · `, then that text (`done · Grok 4.7 high`,
  `idle · Opus 5.5 default`, `idle · Jules 0.1.42`). That is line 2.

While the seat runs, the watch paints both lines. Line 1 is the file's title. Line 2 takes the
running model and version the pane's screen shows when they differ from the file's, and the
effort word the screen shows; a screen this version cannot read, or one that shows no running
model, keeps the file's display — never the CLI's name. An effort word, once seen, stays until a
later screen shows a different one.

`effort` is optional. It is a known field: a file may set it, and a file that leaves it out
loads as before. The words a lab allows are [`src/profiles/efforts.json`](../src/profiles/efforts.json),
format 1, keyed by the seat's `vendor`. Each list is the words that lab's own CLI help printed.
A lab whose help or model list names none is left out of the file, and a vendor with no entry
accepts any effort.

A word outside its lab's list is a warning, and the warning names the words that lab allows.
It does not fail `team check` or `team up`. That is not a regression for a file
that already loaded: an unknown field is refused, so no such file contains `effort`. Left out,
the field is not stored on the seat, and the seat's digest is unchanged. Adding it, in
or out of the list, changes that digest, because the word is part of the seat.

Nothing in the launch line reads `effort`.

`nickname` is optional on a seat: the human name for it, such as `Ada`. It takes the same
characters as the seat's `name` — a letter or digit first, then letters, digits, `.`, `_` and
`-` — it must be unique in the team, and it must not be another seat's name. Either collision
would make one address name two seats, so a file that writes one is refused when it loads, and
`team register` and `team add` refuse it too (they load the file first). A nickname equal to its
own seat's name is not a collision: both spellings reach one seat. A counted entry may not carry
one: a nickname names one seat. It is not a capability — the role keeps the grants, and a nickname
confers nothing. It is part of the seat's digest, so writing or changing one needs a new approval,
and a file that writes none keeps every approval it had. The name is shown in `team seats` and
`team status --all` (the `NICKNAME` column, and the `nickname` field of their JSON) and in
`team send --list`.

A name's trailing digits are its number, read as a number rather than as text: `builder-9` sorts
before `builder-10` and `builder-100`, and the next free one is the next integer. Two seats of one
role whose names carry one number at different widths — `builder-1` and `builder-01` — are one seat
written twice, and the file is refused when it loads; `team add` and `team register` refuse it too,
because they load the file first.

`delivery_order` is optional on a seat: its own word on the order a send to it walks, described
[below](#delivery_order).

`human` is optional on a seat: `human: true` marks its pane as a person's. A send to it walks the
`drop` leg alone, whatever its delivery order or the default says — every other leg is skipped,
each one's reason recorded on the history line the send writes — so the message arrives in the
drop file and the pane is never touched. A human seat needs no `delivery_order`: `drop` is the
order whatever the seat's key says, and `team check` reports no difference for a word it writes.
The watch types no
retry there and no nudge: a held send's marker is given up on with the reason, and its message
waits in the drop file. `team send --wait` to such a seat writes the record on the `drop` leg with
nothing typed and awaits a reply record on the thread. The key is part of the seat's digest, and a file that marks no seat keeps every digest
it had.

`inbound` is optional on a seat: its own word on cross-session socket frames. `accept`
authorizes a send's `socket` leg for any launch; `hold` and `refuse` never let it dial — the
explicit opt-out — and an omitted key leaves the choice to the launch. A send always needs the
seat's own launch to declare `crossSessionInbound: accept`; with no `inbound` word, a seat
TeamCLI launched is authorized by that launch alone (its generated settings file carries the
attestation), while a session launched some other way is dialed only when the file says
`accept`. A frame the receiver's box holds at its dialog is recorded once as
`held (socket)`, and the walk falls through to the next route with the same message id; the
socket is not dialed again until the declaration the hold sat under is re-confirmed, by its
settings file being rewritten. The key is part of the seat's digest, and a file that writes none
keeps every digest it had; a word other than the three is refused under the seat.

`liveness` is optional on a seat: its own word on the three liveness windows —
`idle_lead_seconds`, `idle_owner_seconds` and `blind_after_seconds`, each a positive number of
seconds — and it applies to that seat alone. A seat tightens the windows in force and never
loosens one: a longer word is set aside where the thresholds resolve, the value in force standing.
(The blind window is the one a project may open again; a seat inside may close it, not open it
further.) Writing the map changes the seat's digest, because the word is part of the seat.
The levels above a seat declare their own words — the machine's `~/.config/team/settings.yaml`,
an entity's `entities.yaml` entry, a project's record — all under `liveness`, and the watch
section's `idle_first`, `idle_owner` and `blind_after` are the team's own, described in
[`team watch`](commands/watch.md).

## `delivery_order`

The order a send to this team's seats walks. It is not an owner section: writing or changing it
is an ordinary change, and a file that writes none reads as the default order.
Omitted, the general order is `mcp-inbox`, then `typed`, then `drop`; neither `native` nor
`headless-resume` is ever in that default. A Codex receiver with no declared order has an
implicit runtime queue first while its signed `codex-daemon` setting is on, then the typed wake,
then the inbox and remaining default legs. If that setting is off or unavailable, the typed wake
leads so an idle Codex inbox is not left unread. A declared `delivery_order` is followed as
written. Only a declared word can add `native` or `headless-resume` to the general order. A typed leg
that finds no live agent types nothing and
hands the send to the leg behind it, recording `typed: <reason>`; a walk reaches `drop` when
the legs before it did not take the send, or when the order puts `drop` before `typed`.

```yaml
delivery_order: [typed]
```

- The word is one or more of `socket`, `native`, `mcp-inbox`, `typed`, `drop` and
  `headless-resume`, each at most once, in the order a send tries them. A written key with no
  legs is `delivery_order needs at least one leg:
  socket, native, mcp-inbox, typed, drop, headless-resume` — the default order is the absence of
  the key. A word outside
  the six is `delivery_order "<word>" must be one of: socket, native, mcp-inbox, typed, drop, headless-resume`; a
  repeated one is `delivery_order names "<word>" twice`.
- The six legs: `socket` is this build's own frame on the receiving Claude session's
  cross-session socket, a signed copy written first, dialed only for a seat whose launch
  declares `crossSessionInbound: accept` — an `inbound: accept` here authorizes any launch, an
  explicit `hold` or `refuse` opts out, and with no word a seat TeamCLI launched is authorized
  by its launch; `native` is
  the sender's own
  cross-session SendMessage, recorded by the sender with `--confirm`;
  `mcp-inbox` is the seat's own MCP inbox, which takes the send only while a server serves it —
  a live `.inbox-listener` marker names the seat, session and root, and a walk with none records
  `mcp-inbox: no live inbox listener` and moves on; `typed` is the 0600 drop file and one
  composer trigger line; `drop` is the same 0600 drop file and nothing typed into the pane at
  all — no trigger line and no socket frame, its run ending `sent (unconfirmed)` until the seat's
  own read writes the receipt; `headless-resume` is the seat's own CLI resumed for one turn
  without a TUI pane, which no default names and this build cannot take yet, so a walk that
  reaches it records `headless-resume: this build carries no headless resume runtime` and moves
  on. `delivery_order: [drop]` takes the drop leg alone, for a receiver
  that watches its own drop folder and for a pane that must never receive typing; a seat the
  file marks `human` walks `drop` alone, whatever its order holds.
- The receiving seat's chain is read outermost first: the entity, the project's registry record,
  this file's key, then the seat's own key. No entity record carries an order in this build, so
  that level is always silent; the project's word is `delivery_order` beside `teams` in
  `projects.yaml`, written `[typed]` the same way. Each level may drop legs from the order in
  force or put the legs it keeps in a different order, and may add `native` or
  `headless-resume`, or place `socket` where the order in force lacks it: a word naming any
  other leg the order in force does not have is set aside, and the
  order in force stands. A word equal to the order in force is no word at all.
- A seat's word is written on the seat, and is part of the seat's digest — writing or changing
  it changes the digest, like every other field of the seat:

  ```yaml
  seats:
    - role: implementer
      name: helper
      cli: claude-code
      vendor: anthropic
      model: Claude Sonnet
      version: "5.5"
      launch: claude --model claude-sonnet-5-5
      delivery_order: [typed]
  ```

- What a walk does with each leg — a leg takes the send or is recorded as a failure and the next
  one is tried — is [team send](commands/send.md)'s. A `--wait` send walks the same order and
  then awaits a reply record on the thread.

## `sender_name`

How a sender from this team reads in TeamCLI's own headlines: the first line of a drop file
(`from <name> — admitted by: <rule>`), the `FROM` cells of [`team drops`](commands/drops.md) and
[`team messages`](commands/messages.md), the `SEAT` cell of [`team feed`](commands/feed.md), and
the display name a seat's own CLI session is launched with where the CLI takes one
(`claude`'s `--name`). It is not an owner section: writing or changing it is an ordinary change,
and a file that writes none reads as `auto`. It changes presentation only: every signed record
keeps the seat in `from` and the registry id in `from_id`, and the `--json` readings keep the
record's own fields.

The four words:

- `auto` — the sender's nickname inside its own team, and `seat@team` from another, because a
  nickname is unique only inside one team. A seat whose file writes no nickname reads as its seat
  name.
- `nickname` — the nickname wherever the sender is, or the seat name when the file writes none.
- `seat` — the seat name, always.
- `seat@team` — the address, `helper@labs`; the seat alone only when no team record names one.

```yaml
sender_name: nickname
```

- The word is one of `auto`, `nickname`, `seat` and `seat@team`. Any other word is
  `sender_name must be one of: auto, nickname, seat, seat@team`.
- The word in force is read nearest first: the reading seat's own `sender_name` key, then this
  file's key, then the project's record in `projects.yaml`, then `auto`. The reading team's word
  decides — for a send, the receiving team's file and seat — so one team's file decides how senders
  read to it. A seat's word is written on the seat and is part of its digest, like every other
  field of the seat:

  ```yaml
  seats:
    - role: implementer
      name: helper
      cli: claude-code
      vendor: anthropic
      model: Claude Sonnet
      version: "5.5"
      launch: claude --model claude-sonnet-5-5
      sender_name: seat@team
  ```

- A sender's team is resolved by the registry id first: the id names the roster line, and that
  line gives the nickname and the team's own name; a record's own team field answers only when no
  roster holds the id. A team no registry record holds is no answer, so the nickname — or the seat
  name when the file writes none — stands. A [history line](commands/feed.md) records the
  sender's team as the send wrote it, so a cross-team sender whose seat name another team also
  uses reads by its address in the feed when the registry holds that team; a line from a build
  that recorded none reads the plain seat name, never a guessed nickname.

## `grant`

Records the grant the owner gives the orchestrator's seat. It is an owner section: only the owner
writes it. Omitted, it reads as `null`.

```yaml
grant:
  session: acme          # the file's own session
  seat: lead             # the orchestrator's seat
  scope:                 # non-empty, distinct, order kept
    - up
    - down
    - approve
    - init
    - reload
```

- `session` is the team's own session: the `session` key, or `<entity>-<project>` when that key is
  omitted and the file names an entity (the project name alone when it names none). Any other value
  is `grant.session must be the file's session "<session>": "<written>"`.
- `seat` is the orchestrator's name, the one `coordinator:` or `leads: true` resolves. The
  operator's name, and any other name, is `grant.seat must name the orchestrator "<seat>":
  "<written>"`.
- `scope` names acts from the closed set `up`, `down`, `approve`, `init`, `reload` and `swap`. The
  list is non-empty, each act appears once, and the order is part of the value the owner writes.
  An empty list is `grant.scope must name at least one of: up, down, approve, init,
  reload, swap`. A repeated act is `grant.scope names "<act>" twice`. Any other word is
  `grant.scope must name up, down, approve, init, reload, swap: "<word>" is not one`.
- `swap` in `scope` admits the orchestrator's seat to `team remove <operator> --keep`: the swap
  of the operator's agent (`docs/commands/remove.md`). Never its own seat — a seat cannot close
  the pane its own call runs in — so the orchestrator's own swap stays the owner's or a
  delegate's whose entry lists `swap`. The grant itself stays an owner section.
- `approve` is accepted in `scope` and acts on nothing: `team approve` was removed, and the word
  stays so a file that already names it loads unchanged. A change to `grant` itself, and a
  change to any other owner section, stays the owner's.
- Any other key, including `path`, is an unknown field.
- `team up` admits the orchestrator's seat when the live file's `grant` lists `up`. The run is this
  folder's own file: `--session` and `--file` are refused, and the run does not relaunch or close
  the orchestrator's seat. `team down` admits that seat when the list includes `down`, and leaves
  the orchestrator's seat and the operator's seat running. `team reload <seat>` admits that
  seat when the list includes `reload`: one named seat, closed only at an idle prompt when its
  declared model or effort differs from the launch, then launched again. It does not name the
  caller's own seat. A file that omits `grant` keeps today's `down`.

## `delegates`

Names panes outside the team's session that may run some operational commands as a delegate of
this team file. It is an owner section: only the owner writes it. Omitted, it reads as `null`
and nothing is delegated.

```yaml
delegates:
  - pane: main/w1:p1        # <herdr session>/<pane id>, outside the team's session
    commands: [up, down]    # of up, down, add, remove, approve, swap: non-empty, distinct, order kept
  - pane: main/w2:p1
    commands: [add, remove]
```

- One to eight entries, each a map with exactly `pane` and `commands`; two entries naming one
  pane are refused.
- A pane is herdr's pane ID — `<session>/<pane id>`, such as `main/w1:p1` — one slash, no
  whitespace, matched on the whole string and case-sensitively. A pane closed and made again has
  a new ID, so delegation is off until the owner writes that new ID into the file.
- `commands` names at most one each of the six `up`, `down`, `add`, `remove`, `approve` and
  `swap`. `swap` admits `team remove <lead> --keep` and `team add <lead>` on the orchestrator's
  or the operator's seat — the swap of that seat's agent — and nothing else; `remove` never
  reaches a lead.
  Entry order and command order are part of the value the owner writes: a reorder is a change
  like any other.
- `approve` is accepted in `commands` and acts on nothing: `team approve` was removed, the word
  stays so a file that already names it loads unchanged, and `team check` prints a note above its
  findings asking for it to be dropped. Every other act reads the live file. A delegate's commands
  write the file's roster alone: the owner's sections — `delegates`, `budgets`, `limits`, identity,
  `trust`, the workspace, the operator and orchestrator — stay the owner's, and so does any
  section added later. A delegated act records one audit line naming the pane and what it did.
- A pane several teams' live files name is a delegate of each — the files do not see or
  limit one another — and in every one of them the owner-only sections stay the owner's, never
  a delegate's.
- A pane's own shell reaches that pane's grant when the pane's root process is among the
  caller's ancestors. `HERDR_PANE_ID` only names which pane to read; the pid is what places
  the caller. No such variable, a root that is not an ancestor, or a pane-root read that
  fails places nobody, as before. A command the grant does not list is still refused, and a
  pane no grant lists is refused by name: `it runs in pane <session>/<pane id>, which no grant lists`.
- Delegate placement is an accident guard, not a security boundary. The pane ancestry and
  herdr's pid vouch are forgeable by a hostile process of the same user, which this tool does
  not resist: it guards a mistaken agent, not a hostile one. Nothing in the grants or in
  `trust:` is changed by that.

## tempo

How fast the watch's waits run. It is an owner section. Omitted, it reads as `normal`.

```yaml
tempo: urgent
```

- `relaxed`, `normal` or `urgent`.
- `relaxed` doubles `idle_repeat`, `team_idle`, `nudge_wait`, `unsent_after` and
  `unread_after`, and doubles the idle window the liveness chain resolved (`idle_first`).
  `urgent` halves them, to the nearest second, and never below one second. `normal` leaves
  them as written.
- The idle window is scaled after the chain checks its word: the tempo is the owner's dial on
  the timing, so `relaxed` lengthens the resolved window without reading as a team loosening a
  liveness threshold, and `urgent` shortens it. `idle_owner` and `blind_after` are never scaled.
- An omitted `idle_repeat` stays off. `interval` is the pass rate and is not scaled, and
  neither are the quota marks, the check switches or the liveness windows `idle_owner` and
  `blind_after`.
- `relaxed` and `urgent` take effect on the next pass once a verified record of the file is in
  force; a file with no such record runs the default timings. A file that omits the key, and one
  that sets `normal`, leave every wait as written.

## watch.queue_dir

Optional directory containing one Markdown queue per seat, named `<seat>.md`. Set it to
the team's notes/queue directory. A relative path starts at the project root; absolute
paths and `~/` paths are also accepted. Omitting it disables queue reads.

`team status` shows each queue's depth and the directory's `linear-backlog.md` — its unclaimed
items, one that is unchecked and carries no `claimed:` or `done:` marker; `team watch` reports
idle workers with empty queues, and the unclaimed items left in that backlog, after
`watch.team_idle`. See [queue reports](commands/watch.md#queue-reports) for the task format and
unknown readings.
