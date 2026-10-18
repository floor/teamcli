# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0-rc.4] - 2026-10-18

The first release since 0.3.5, and the first on npm since it. The file in the clone is the
record: `team approve` is no longer a command, the commands read the file itself, and a seat
that is already running is written into this machine's registry so the rest can reach it by
name. A send says which channel it took; a team names the project
it sits in; each seat's state and the two sidebar lines beside it say what it is doing and where
that reading came from; and grants, delegates and holds put the owner's decisions where the
commands read them.

### Added

- **One output contract, and `team --about`.** Every command prints under one contract across its
  plain text, `--json` documents, `--help` usage and exit codes: a reading opens with
  `team <project>, session "<session>"` (or the project line), prints an uppercase-headered
  table, notes and any `difference:`/`repair:`/`who:` blocks, and closes with one summary line; an
  action prints its plan steps under `--dry-run` and one summary line. `--json` prints one
  document per command, its `schema` first (`team.<command>`, format 1) and a refusal as a
  `team.error` document carrying the contract's exit id and repair; the schemas are published
  under `schema/`. Output is quiet by default: stopped seats wait for `--all`, repeated notes
  collapse to one line with `(x<n>)`, the `what 0.5.0 must not pretend` block prints only in
  `team doctor` and `team --about`, and a deprecation warning only in `team check` and
  `team doctor`, with its repair. Colour reaches a terminal only — never `--json`, never under
  `NO_COLOR`. `team --about` prints the version, the licence, the docs link and the block; `watch`
  and `broker` keep their foreground loops and take no `--json`.

- **The registry, and `team register`.** The machine keeps records of the agents it has seen, the
  teams and the projects they sit in, under `~/.config/team/`. `team register <seat>` writes the
  record for one seat that is already running — a pane herdr places under that name, holding a
  CLI at the seat's prompt — so `team send`, `team seats`, `team watch` and `team down` can
  address it. It types nothing into the pane, and a pane change re-records the same agent rather
  than a second one: a record's identity is the file's seat under its team, never the pane.
  Records are appended, never deleted — a removed seat is marked ended and its history stays
  readable — and a record confers no right. The record also carries the seat's pane, which binds
  the sender: only a caller standing on the pane its own record names acts as that seat. A send
  reads its delivery pane live, by the seat's name, so a pane that closed or was reused since the
  record was written is never typed into; a claude-code seat's cross-session socket address is
  recorded for `team route`.

- **`team send`, and the channels a seat is reached on.** One message to one seat, ending in one
  confirmed outcome: `delivered`, `answered`, `held`, `not-submitted`, `timeout`, `unreachable`
  or `refused`. A send walks the receiving seat's delivery order — `native`, `mcp-inbox`, then
  `typed` when no level of the seat's chain changes it: the entity, the project's registry
  record, the team file's `delivery_order` and the seat's own each may drop a leg or reorder the
  ones it keeps, never add one — and this build carries no `mcp-inbox` leg and opens no socket,
  so every delivery it makes goes by the typed leg, and each leg the walk could not take is
  recorded `unavailable` on the history line. A plain send gives the seat the body whole in a
  mode-0600 drop file and types one short trigger line naming it — the body is never typed, and
  never split — for every seat, Claude Code's included: a socket write to a busy session can land
  at its held-message dialog, where the box is blocked, so no path opens a cross-session socket
  at all. `--wait`, which would ride one, is refused for every seat — a Claude Code seat's
  refusal names the native leg
  (`team route` and the caller's own `SendMessage`) that will carry a waited send, and any other
  seat gets its own reason — and nothing is written. A seat the receiving team file marks
  `stopped: true` is not addressed at all: the send, its dry run and `team route` refuse it as
  stopped, with its own exit id, before a drop file exists, a leg is walked or a history line is
  written.
  `--json`, `--file`, `--dry-run` and `--list` round it out. The native channel is the sender's
  own half: `team route <seat>` answers the address a delivery from the sender's cross-session
  tool uses — the recipient's agent id, session, CLI and pane, and its socket — and
  `team send --record <seat> --channel native --ms <n>` writes that delivery down, one
  `via native` history line, the body not passing through the CLI. A message's body is written
  down in the project's history, which `team feed` reads, with the send-to-outcome milliseconds
  and the path it took; the refusal for a seat no record covers names the command that writes
  one (`team up`, `team register <seat>`).
  A seat its file marks `assistant: true` — one per file, never a seat with `count` — is its
  entity's assistant, and the routing admits it to the entity's main coordinator: the first mark
  found walking the entity's teams in chain order, the entity's own team first and then its other
  teams by team id, never a role's name. Send is denied by default: the owner may send to any
  agent; an orchestrator to an orchestrator of its own team or of a team in its entity, never
  across entities; a team's orchestrator or operator to any seat of its own team; an assistant
  to its entity's main coordinator; any seat to its own team's orchestrator; and an owner-signed
  `send` grant to what it names.

- **The send grammar: `@<nickname>`, `<seat>@<team>`, `lead@<team>`.** One grammar answers
  `team send` and `team route`: an agent id (`agt_` and twelve hex), `@<nickname>`,
  `<seat>@<team>`, `<nickname>@<team>`, `lead@<team>`, or a bare seat or nickname of the caller's
  own team. `<team>` is a team's registry id, its project or its session, as the record spells
  it. `lead@<team>` reaches the seat its file marks `leads: true` — never a seat merely named
  `lead`, and never a role's name — and a team with no lead is refused, because there is no one
  to deliver to; a roster marking two leads refuses the address, naming both. A nickname is the
  file's `nickname:` line, unique inside its team and free to repeat across teams:
  `@<nickname>` asks the caller's own team first, then the other teams of its entity, and from a
  folder that is no team every team the registry holds. Exactly one match sends; several are
  refused, each named by the `<nickname>@<team>` spelling that picks it; none points at
  `team send --list`. A spec two roster entries answer — one seat's name and another seat's
  nickname of the same team — is refused naming both, before anything is typed. Every form
  resolves to one seat's registry record before admission runs, and admission judges that
  record's seat: a nickname added or removed never changes who may reach whom. A full address
  reaches another team from any folder — and from a folder that holds no team file, where that
  send is the owner's — the receiving team's file judges it, and the drop lands under that
  team's `.agents`; a bare name from a folder that is no team is refused with the forms that
  need none. `lead` is reserved from this release on: no new seat and no nickname takes the
  word, and a file written before it that declares a seat named `lead` still loads and answers
  its bare name, `team check` noting the repair `team rename lead <new-name>`. A history line
  keeps the address as written: where the caller wrote a form rather than the seat's name, it
  carries `spec` and `resolved` (`agt_…`), and `team send --list` prints each seat's `NICKNAME`
  — `-`, an `@<nickname>` in the file's own roster, a `<nickname>@<team>` in another's.

- **A held send is retried, not abandoned.** When a typed send leaves its drop because the
  seat's composer held text, the seat did not take the trigger, or a dialog was up — `held`,
  `not-submitted`, or an `unreachable` that is a dialog — send writes a pending record beside
  the drop, and a running watch delivers it on a later pass: only when the pane reads `idle` or
  `done`, its box is free or holds nothing but that send's own trigger line, and under the
  seat's lock, so a retry cannot interleave with a new send. A trigger line the failed send left
  unsent is submitted with the Enter and never typed over. The retry is bounded to three tries
  within thirty minutes; a delivered retry is written into the history, and a give-up names the
  sender and the recipient seat, says why, points at the drop while it is still there and asks
  the sender to send it again. A record whose drop file was moved or removed is given up on
  rather than typed, and the age bound is applied before the pane is looked for, so a vanished
  seat's record still ages out. The send's held, not-submitted and dialog lines name the drop
  and the retry — a dialog's reads `unreachable now (the screen reads <kind>); a running watch
  retries it when the seat is idle; the drop file is at <path>` — while a send through the
  daemon keeps no record a watch reads, so its not-submitted line promises no retry.

- **Projects.** Entity, then project, then team, then seat. A team names its project in its team
  file, a team that names none is its own project, and a team two projects name is refused by
  `team check`, naming both. `team projects` lists the registry's projects — immutable id,
  display name, entity, lead and teams; `team status --project <name>` covers every team of one
  project; `team send --list` shows each addressable seat's project. Settings inherit through
  the four levels — a lower level may tighten, and loosen only where the level above allows it —
  and the first project-level setting, `seats_cross_teams`, decides whether a seat may cross
  teams within its project. Within a project the project lead and its teams' leads are admitted
  to each other, by capability, never by a role's name.

- **The lobby, recorded per session.** A team's seats work in its lobby: the file's explicit
  `lobby:`, else the lobby the registry recorded for the session, else
  `~/.config/team/lobbies/<entity>` for a team that names an entity, else
  `~/.config/team/lobby`. The record keeps one entry per session — `up --session alt` records
  its own, and neither replaces another's — and once a session is recorded, editing the file's
  `entity:` never moves it; a record written before the map reads as one entry.

- **Seat state, and the words beside it.** `team seats` prints the seat registry: one row per
  seat with its stable handle (`seat_<12 hex>`), role, CLI, model, effort, status, state, source,
  last active time and pane; `--all` adds the stopped rows, and `--watch` refreshes the table
  every two seconds. STATE is the word — `working`, `idle`, `blocked`, `done`, `held`,
  `unreachable`, `unknown` — and SOURCE is where it was read: the pane's screen, the CLI's own
  hook files (`cli-hook`, valid 24 hours; a working reading carries the 120-second window),
  herdr's word, the seat's newest trace (a commit, an ack or a message) or its process; a seat
  no source has heard from past the blind threshold reads `unknown (blind)`, and counts as not
  working.
  `team status`'s rows end in the word a send would use — `socket` or `typed` — and
  `team status --all` prints the expanded columns. The pane's two sidebar lines — its workspace
  label and the display line under it — are the file's own text, re-applied from the file by
  `team register` without a relaunch, and `team check` reports one that reads as neither.

- **`team rename`, and the seat numbering.** `team rename <seat> <new-seat>` renames a seat in
  the live team file and carries what the old name held: the file's references to it — the
  `coordinator:` and `operator:` lines, a `grant:`'s `seat:` — the registry record under its
  agent id, the herdr agent's name, its task leases, pending send-drops, mailbox messages (a
  signature this machine can check is remade under the new name), its rules, queue and notes
  files, the state's records and the message history, so nothing is left addressed to a name no
  seat holds. Comments, order and every other seat stay as written: the edit is by the line,
  never a rewrite of the file. `team rename --renumber [--dry-run]` rewrites every numbered seat
  to the width and separator the `seat-numbering` setting in force asks for (`builder-1` →
  `builder-01`), leaves a name with no number plain and skips a seat written with `count`; a dry
  run prints each `from -> to (dry run)` and writes nothing. A seat number is read as a number,
  so a roster naming the same role and number twice — `builder-1` beside `builder-01` — is
  refused at load rather than left for an address to pick between. The owner or `leads` renames;
  a target already declared, a target another seat's nickname holds, a counted seat renamed
  partially and a name outside the seat grammar are each refused with the reason. A verified copy
  of the file this machine still holds is carried across the rename where the renamed digests
  match it, so a rename alone reports no drift.

- **Three more launch profiles.** `grok`, `gemini` and `muse` join `claude-code`, `codex`,
  `cursor` and `antigravity`, each with its own screen reading, unattended flags, login check
  where the CLI offers one, and tested range. The Claude Code profile is tested with CLI
  2.1.288 to 2.1.302. The Antigravity profile is tested with CLI 1.2.16 to 1.4.1.

- **Jules as a pane seat.** `jules` joins the profiles with its 0.1.42 CLI: a send to a jules seat
  still writes its drop file, and the body is typed through the CLI's own screens, so a new
  remote session on the seat's own repo is the delivery. A seat sends only to the repo of its own
  folder; when the account's repo list does not hold that repo, the send is refused with nothing
  typed rather than sent elsewhere. The profile never deletes a session: a turn is ended with
  `ctrl+c` alone, and every jules seat's rules carry `Never delete a Jules session.` herdr cannot
  report a jules pane's agent, so the profile declares `herdr_status: unreliable` and the screen
  is the reading — an idle session table is a free seat, a running card a working one — across
  `status`, `check`, `watch`, `list` and `down`.

- **Grants, and delegates, the owner's alone.** `team grant <seat> --scope <acts>` sets the team
  file's one grant — the seat the file's orchestrator marks, and the complete scope it may run; a
  later run replaces it exactly — and `team revoke grant` removes it. `team grant <seat|@team>
  --capabilities <cap,...>` writes a standing grant record in the shared grants folder — a seat
  resolved to its registered agent's id, `@team` to the project's team id — out of the closed
  vocabulary `write`, `read`, `review`, `gate`, `merge`, `deploy`, `act-as` and `use-broker`,
  with `--expires`, `--name` and an optional `--scope` of paths; a team grant never carries
  `grant`, `create`, `agree` or `leads`, and naming one is refused with the rule. The records
  are signed and read fresh at every use: a revoked or expired grant admits nothing, and
  revocation is its own appended record, never an edit of the grant — `team revoke <name>`
  appends it. `team delegate <session/pane> --commands <acts>` records one pane outside the
  team, up to eight, and `team revoke delegate` removes one. A create-grant — a record in
  `~/.config/team/grants/` naming its holder by registry identity, `agent:` an agent id (`agt_`
  …) or `team:` a registry team id, with the paths or entity it covers and its expiry — admits
  its holder to `init`, `up`, `add` and `remove` under those paths until the record expires.
  The holder is the caller's own registry record while it is running, placed by the session,
  pane and seat it stands as, and a team record admits an agent registered to that team; the
  owner, an agentless pane and an unplaced process have no registry record, so no record admits
  them. A record spelling a name, a seat, a pane, a session or a runner grants nothing, and one
  naming both `agent` and `team`, or no holder, is skipped with the rule. Every one of these is
  the owner's, from a terminal outside herdr, with a `--dry-run`, and none can widen its own
  entry.

- **The work queue.** `team issues` lists the typed records in the one file the team file names;
  `team next` claims one, held by a lease in this clone (`--mine`, `--release`, and `--wait` at
  the file's `tasks.cadence`); `team plan` prints the queue a claim would consider and claims
  nothing, a passed deadline marked `(overdue)` and never dropped or reordered; and `team broker`
  — the owner's foreground process, one per clone — holds the tracker credential and answers
  `team next` over a local socket, with the
  file's `tasks.policy` filtering every record before it crosses. A broker runs as the same OS
  principal as the seats: that is integrity, not authenticity, and it isolates nothing.

- **The rebuilt `team usage`.** `team usage` reads the machine rather than one project: every
  team it keeps a store for, the caller's own project among them whether or not it holds one, in
  one report — each account and window with what is left and used, when it was last read and from
  which source, its reserve and its state, under the account table and a closing line that counts
  the machine's teams, labs and accounts. Anyone may run it from any folder, and it changes
  nothing: no check runs, nothing is written, no credential, key or CLI session file is opened. It
  does read the seat panes herdr records and may run a CLI's own usage command where a seat runs
  one, bounded by a fifteen-second timeout. The owner at a terminal reads the machine's
  subscriptions and the caller's team, and `--all` adds every team's seat-to-account rows; every
  other caller reads the restricted view, a closed list built before anything prints. `--tree`
  adds the quota view between the account lines and the team tables — one block per lab and per
  account, each window with its margin and state — while the one `advice:` line, printed either
  way, names the accounts with headroom or where a walled seat should move. Shared machine
  subscriptions live once in `~/.config/team/accounts.yaml`, and `--json` carries the same report
  as one document, format 1.

- **Around the seats.** `team list` shows the herdr sessions on this machine — the running ones
  unless `--all`, `--seats` for the active breakdown, `--watch` to refresh every two seconds;
  `team feed` reads and follows the project's message history, `--all` merging every project on
  the machine; `team messages` verifies a waiting message, prints its body and writes the
  receipt; `team proc` keeps the processes the seats started as a register in the team's state;
  `team hold <reason>` places a note on the team's work (`--release` clears it) that `status` and
  `doctor` show; `team tempo`
  sets the watch's pace; `team lock` and `team unlock` take and release a named machine lock, so
  one heavy run holds it at a time; `team mcp status` and `team mcp doctor` read the MCP bridge's
  legs; `team ask-show` prints one signed ask; `team reload` and `team restart` bring a later
  model or effort edit to a seat already running; and `team worktree list` joins the worktree
  set.

- **`team check` is integrity, not authority.** It reads the file, the state, herdr, the
  registries and the agents' records, and reports the differences alone, each with its repair: a
  reading of whether the records agree, never a grant. No approval, no launch and no right
  follows from a clean answer. The owner's `--repair` is its one write: it drops the state's
  leftovers — a record for a seat the file no longer declares, with the pane it claims, and a
  session the state holds with no seat of the team in it — re-checks each against the state on
  disk, prints one `repaired:` line per drop and logs it. Herdr is not asked which records are
  leftovers: the state's own claims are the subject. The repair still waits on the live read, so a
  check whose herdr cannot answer drops nothing; a temporary seat is never a leftover, and neither
  is the file's own session or the one the run checks.

### Changed

- The file in the clone is the record: the commands read it, and `add`, `remove` and `down` keep
  going when no approval record exists. `team up` admits the owner or the team's lead seat; where
  that refuses, a `delegates` entry whose commands include `up` or a seat the file's verified
  `grant` names for `up`. Anyone else is told `deny` and exits 1, and a dry run says what the
  real one would (`! up would refuse:` with the reason, `! to unblock:` with the owner's run of
  this folder, then the plan).
- `team up` gains `--serial`, launching and waiting on one seat at a time, and a fresh
  orchestrator or operator seat starts in the project folder and every other seat in the team's
  lobby.
- The watch runs in a herdr workspace of its own, labelled `Watch · <project>`: `up` ends its
  plan by creating it and running the watch in its pane, and a bare `team watch` from the owner's
  terminal hands itself there and returns — a `--no-nudge` or `--no-notify` run stays in the
  caller's terminal. The state records the pane, the pid and the heartbeat; `team status` shows
  them, and `team check` flags a heartbeat older than two in-force cycles.
- `team down --wait` gives a working seat up to 120 seconds to come free and leaves one that
  never does running; an agent still in the session keeps it up, and a pane is closed only where
  the state records it for one seat.
- `team status` is gated like the other commands (`team status: this team is not yours to read`),
  prints a hold as its first note, and marks a rate-limited row `(rate limit on <account>, resets
  at <time>)`; its drift line reports the effort on its own when the model matches and only the
  effort differs (`<seat>: effort <seen>, file says <effort>`), and an effort the file never
  declares is never a drift. `team doctor` prints a hold line and cleans every line it prints of
  escape sequences and invisible characters.
- `team watch` nudges any idle seat, not the operator's alone, and announces a waiting message
  with `Team: run team messages`; it reports a seat stopped on its provider's connection error or
  at a rate limit, naming the account and the reset time, and types into neither screen; a
  temporary seat is left as it is for the owner to remove.
- `team add` takes `--model` and `--effort` (the owner's, on a declared seat) and starts a
  temporary seat from `--temporary --like <seat> --until <end>`; `team remove <lead> --keep` then
  `team add <lead>` replaces the agent on a lead's seat without stopping the team, and a removal
  by a caller other than the owner leaves the pane running, renamed `<name>-left`.
- `team list` shows the registry beside discovery: a registered team and its seats join the rows.
- `team worktree` gains `list` and `remove --branch <name>`, and reads the live file's workspace
  values. `team release check` warns when npm's `next` dist-tag points below `latest` and prints
  the exact `npm dist-tag add` command, without running it.

- `team check --repair` settles every finding the file alone can settle, in one owner-signed
  run: besides the state's leftovers, it re-records each seat an agent registered under dev
  mode, clearing the mark the way an owner's `team register <seat>` does, and sets herdr's
  drifted workspace label and display line back from the file through the same two writes
  `team register` makes. Each written line is printed as `repaired:` and logged as its phase
  finishes, and a sidebar write the session refuses prints the line it could not report. A
  model drift keeps its relaunch advice: the repair never starts, stops or relaunches a seat,
  and it stays owner-only. Under a governing dev-mode policy the check's rows still collapse to
  one quiet count, and `--repair` clears the marks behind it.

### Removed

- `team approve` is no longer a command: `team up` admits from the live file, and `add`, `remove`
  and `down` keep going when no approval record exists.

## [0.3.5] - 2026-10-07

A release about a seat whose screen nobody can read: a caller other than the owner can now let
it go on herdr's word alone, and `team status` and `team watch` say so instead of staying quiet.

### Added
- `team remove <name>` from a caller other than the owner: a seat herdr reports `idle` or `done`
  is taken out of the team without typing anything into it — the state record is dropped and the
  pane's agent is renamed best-effort to `<name>-left` (or `-left-2`, and so on), leaving the
  pane running for the owner to close. `--keep` marks it stopped with the same line instead. A
  seat herdr reports `working` is never taken out.

### Fixed
- `team status` marks the row when the profile cannot read the seat's screen: an idle or done
  seat reads `<state> (screen not recognised)`.
- `team watch` reports a quiet seat on an unrecognised screen instead of going silent.

## [0.3.4] - 2026-10-07

A release about reading a machine and reading a file: `team usage` reads every store this
machine holds into one report, under one resolved view — the owner at a terminal reads the full
one, every other caller the restricted one — and every line that carries a figure may carry its
pace; a pane the approved file names as a delegate may approve the ordinary changes, a roster or
a launch line or a rule, and can never approve a change to its own authority; and the credential
warning's path exemption is the filesystem's own verdict, so a path-shaped word that is not a
real directory warns.

### Added

- `team usage` reads the machine: every store this machine holds into one report, under one
  resolved view. The full view is the owner at a terminal; every other caller reads the
  restricted one, and a process with no terminal of its own is placed `owner-no-tty` and still
  reads the restricted view, closing the no-terminal forgery. The text and `--json` render from
  one document, so they cannot disagree, and nothing a read of another team produced crosses it:
  no name, no root, no rows, no problems in their own words — each family one fixed sentence,
  counted — no seat on another team's machine line, and no figure of an account the caller's own
  file does not name. `usage.outside` is gone: a run outside every project is a note and exit 0,
  and `usage.store` is the command's one refusal.
- Every stored reading may keep the point before it — the figure it replaced and the moment it
  last moved — and every `team usage` line that carries a figure may end with its pace:
  `pace <n>%/h`, used points per hour, signed, one decimal, or `pace not known` where the state
  holds no usable pair. A restricted line whose newest reading is another team's ends without
  one: that pace is withheld, and nothing stands in its place.
- `team approve` takes a delegate: a pane the approved file names in `delegates:` with `approve`
  among its commands may approve the ordinary changes — a seat's line, a rule — under a
  fail-closed allow-list judged before anything else is read. The `rules` section and the seat
  differences pass; every other owner section is refused by name (`this change needs the owner:
  <what changed>`), including any section a later version adds, so a delegate can never approve
  a change to its own authority — `delegates`, `limits`, `trust`, `budgets`, the workspace whose
  `setup` runs commands. An ordinary difference rejoins the owner's path — the same key guards,
  the same signed record, the same store, `--confirm` inert and no terminal read — and leaves
  one audit line in the log; the owner's run is untouched and approves anything.

### Fixed

- The credential warning's path exemption is the filesystem's verdict: an absolute-shaped word
  is exempt only when `lstat` says it is a real directory — fail closed on an absent path, a
  regular file, a symlink to a directory (`lstat`, never `stat`), or any error — so a credential
  in path clothing warns again, and the runner's real project directory stays quiet.

## [0.3.3] - 2026-10-07

A release about names and evidence: the bare `team check` reads the team itself and answers with
its differences, a ref's check moves to `team commits check` and a pull request's to
`team pr check`, the seat that leads is `leads: true` and its word is orchestrator, and
`team usage` reads one project's budgets and approvals back, read-only. The machine gate and the
watch leave their readings in the log, `doctor` and `status` say when the machine's total swap
sits under what the check asks, a refused run remembers nothing and a refused dry run exits as
the real run would, and the READMEs say plainly what the owner refusal is — and is not.

### Added

- `team check`, bare — every word `--session` or `--file`, or none at all — reads the team
  itself: the caller gate in its decided order, one screen pass over the panes the state records,
  and each difference with its repair. It is a read: it writes nothing, `remember` is false for
  every caller, and a caller the gate refuses gets one fixed sentence and nothing else.
- `team usage`: one project's block, read-only — the budgets in force as `status` prints its
  rows, the watch line, and a note where the state cannot be read; `--json` carries the same
  reading as one document. Every name it prints comes from the one approved copy in force, never
  the live file; a block whose file names no account prints the ruled sentence under its rows,
  and accounts the approval does not back print the tool's own why-line.
- `doctor` and `status` say when the machine's total swap sits under the figure the check asks:
  the figure, the total at this reading, that `team up` would refuse now, and the repair — set
  `machine.swap_free_min`, then run `team approve`.
- The machine gate and the watch leave their readings in the log: a machine refusal in `up` and
  `add` logs the line and the figures it was decided on, and a watch pass logs what it read at
  most once per ten minutes, `unread` where a figure was not taken.

### Changed

- The seat that leads is a field: `leads: true` on that seat, and the word for it is orchestrator
  in every text. The `coordinator:` key still selects it, printing one notice per file, and an
  approval over either spelling holds for both; `dialogs.trust` takes the new word too.
- `team check <ref>` becomes `team commits check <ref>`, and its `--pr <file>` half becomes
  `team pr check <file>`, which checks one pull request body alone and needs no repository; every
  printed line that names the command names the new one. The old spelling is read through 0.3.3,
  one notice line per half on stderr before the run's own bytes, the commits one first.
- The shipped examples lead on no single lab: the README's walkthrough says any CLI fits any
  role, and the example teams lead on cursor and codex.
- The READMEs say what the owner refusal is: a guard against a mistaken agent, not a guarantee
  against a hostile one — a seat that forges the owner's placement is a known limitation, being
  hardened.

### Fixed

- `team approve`: the paste guard reads the command's own terminal and answers three ways — only
  an input read empty lets the write through, a box waiting on input refuses
  (`approve.input-waiting`), and a terminal that cannot be read refuses apart
  (`approve.input-unreadable`) — and is proven under a real pty. The signing key is created only
  after every refusal has had its chance: a refused first approval writes no key, record,
  generation or log. A key that exists and cannot be read refuses before the question, not after
  it.
- A run refused before it acts remembers nothing: a dry run, a `down` that finds the session lock
  held, and a watch that finds one already running leave the state file as it was, and the caller
  gate answers before the file is remembered.
- A refused dry run exits as the real run would — the status and the exit id are that refusal's,
  and nothing is written; it returns a refusal only where the real run would refuse before doing
  anything, so the plan still exits 0 and the pages list the later failures it never takes.
- A log write that fails is dropped, never the command's exit or a watch pass: the log is
  evidence, never a decision.

## [0.3.2] - 2026-10-06

A release about repairs, found on the first day of 0.3.1: `down` and `remove` stop a seat and
clear what the stop leaves, a CLI's own exit question is answered in both the forms it draws
where its profile declares the key, every key follows a fresh check of the pane, a delegate can
start a team whose session is down, one run at a time takes a session, the lobby may hold the
files the shipped profiles declare, the watch's nudge waits for its text and is sent only as
the watch's own, `up` resumes its own interrupted launch, `status` shows no model it did not
verify, and a stop clears only the exit text it typed.

### Added

- `SECURITY.md`: how to report a weakness in private — the repository's security advisories,
  never a public issue, discussion or pull request — what to include, what we do, which
  versions get fixes, and what is not one.

### Fixed

- `down` and `remove` stop a seat: the exit text is typed into a box read empty and idle, read
  back, and only a box that reads back as exactly the typed text gets the Enter (0.3.0 and
  0.3.1 read the screen once, an instant after the typing, too early for the pane to have drawn
  the text, and never pressed it).
- A CLI's own exit question is answered where the profile declares a key for it, in both forms
  Claude Code draws — its second row "2. Stay", or "2. Move to background and exit" with
  "3. Stay" under the marked "1. Exit and stop tasks" — and never when the frame is anything
  else: the second choice is never what a stop sends. A profile that declares no key leaves
  the seat running, and the line says so.
- Every key the stop sends — and the watch's nudge — follows a fresh check of the pane taken
  after each wait: the CLI is the pane's foreground process and is not mid-turn, read again at
  the key, never reused from before the wait.
- `--abandon` closes a seat this run asked whose exit could not be typed or confirmed, and the
  line names that close.
- `down` clears the session it stopped itself: it waits until herdr lists the session stopped,
  deletes it, and the line reads `session <name>: stopped and cleared`. `up` clears a stopped
  session this team's state records, then starts it.
- A delegate can start a team whose session is down: a session that is not running has no seats
  to collide with, so the gate no longer reads "nothing listed" as "herdr does not answer".
- One `up`, `add`, `down` or `remove` runs at a time per session: the run takes the `.run` lock
  before its first effect, a second run is refused naming the pid that holds it (`up.run-lock`,
  `add.run-lock`, `down.run-lock`, `remove.run-lock`), and a lock left by a dead run is taken
  over by the next.
- The lobby's allowed files are the union of what the shipped profiles declare, whichever seats
  a run starts: one folder per machine, so another team's Claude Code lock
  (`.claude/scheduled_tasks.lock`) no longer blocks a team with no Claude Code seat, `up`, `add`
  and `doctor` read the one set, and `doctor` names the profile each declared file present
  belongs to.
- `up` resumes its own interrupted launch: a seat whose pane was made but never renamed — a run
  interrupted in between — is read as this team's half-finished seat and resumed, not refused
  as a stranger.
- `status` shows no model it did not verify: a row whose name does not match shows the model
  its screen names, or `(unread)`, never the model from the file.
- `down` and `remove` clear only the exit text they typed: a box holding other text is not
  typed onto, and a box already holding exactly this exit text is cleared with the profile's
  one key first, never sent.
- The watch's nudge waits for its text to be drawn, reads the box back and re-reads the pane
  before the Enter, and a box it finds already holding the line is sent only on the record of
  the same watch process's own typing — the same fixed line typed by a person, or found by a
  restarted watch, is never typed over, sent or cleared.

### Known limits

Unchanged by this release:

- `add` on a stopped session still asks for a manual clear: `herdr session delete <name>`.
- A delegate still cannot pass `--abandon`.
- A seat whose CLI has already exited (its pane holds a bare shell) is left by `team down` — the
  screen is not one the profile recognises — and closed by `team down --abandon`.
- A `team up` started within a second or two of a `team down` that left the session up can report a
  seat the down has just stopped as left at launch — `left out: its pane has been back at its shell
  for <n> s and shows no CLI prompt; left at launched`, and `run team up again to resume it` —
  running `team up` again starts it.
- `team approve` still asks its question.
- A delegated `up` never answers a trust dialog or a vendor notice: the seat is left out —
  reported, its workspace closed without input, nothing typed into the dialog — and the dialog
  is the owner's to answer.
- The lobby recheck cannot see a rewrite in place inside one filesystem timestamp tick that
  changes no size — every number it reads would be the same.
- The default machine check asks for 2 GB of free swap before a launch; under it, `up` refuses.
- A refused `team approve` run by an agent on a machine that has no signing key yet still makes
  the machine's signing key on its way to the refusal: the key folder and its key file are left
  behind, no approval is written and nothing is signed; fixed in 0.3.3.

## [0.3.1] - 2026-10-06

A release about delegation: a team's owner approves, once, which panes outside the team's own
session may run `up`, `down`, `add` and `remove` for that team, and every delegated run is
matched on session and pane id against a file that is exactly the approved one.

### Added

- **`delegates`**, a team-file section (owner section, one to eight entries): each entry names a
  pane — `<herdr session>/<pane id>`, matched whole and case-sensitively — and the operational
  commands of `up`, `down`, `add`, `remove` it may run. Entry order and command order are part
  of what the owner approves. A pane in the team's own session is refused at load, and so is
  `seat:` or any other key.
- The **delegate gate**: the four commands decide a delegated run in preflight order and refuse
  a caller that is not the approved pane, a command the entry does not list, prohibited flags, a
  file that is not exactly the approved one, or a pane that collides with a seat or with the
  team's session. A delegated run writes one line to the file's log naming the pane and the
  command, and the four commands' own delegate refusal ids are in the exit-code contract.
- `team approve` prints one `Delegate: pane <pane> may run <commands>.` line per entry, before
  the seat-count question.
- `docs/team-file.md`: the format page, with the `delegates` section.

### Known limits

Not in this release: `approve` by a delegate — never, approval is the owner's, and a `commands`
list naming `approve` is a load error; `--abandon` by a delegate — never; restarting a running
seat (needs a `team restart` that changes no file); status, doctor and their JSON for a delegate
— next.

## [0.3.0] - 2026-10-06

A release about setting a team up and upgrading it: one lobby per machine, signed approvals, a
caller gate bound to the pane the team recorded, a launch that reports one line per seat and waits
for its owner at a dialog, and, in the repository, the launcher package `@teamcli/cli`, published
in a later release. **Three changes are breaking; read UPGRADE-0.3.md before upgrading a running
team.**

### Changed

- **Breaking:** seats now start in a machine-wide lobby at `~/.config/team/lobby` instead of a
  `.lobby` folder beside the project's worktrees, and `trust:` entries must be absolute folders that
  include that lobby. A file from an earlier release still reads (`status`, `doctor`), but `team up`
  and `team add` refuse it until `trust:` is migrated and approved again; `team doctor` and
  `team up` print the whole block to paste.
- **Breaking:** approval records are signed per project and per machine. An approval made before
  this release is not in force until `team approve` runs once more; running seats aren't disturbed.
- **Breaking:** a coordinator or operator is the pane its own team's session records. From any other
  pane, or when the state records no pane for that seat, `add`, `remove`, `worktree`, `down` and
  `answer` are refused; the owner repairs it with `team down`, then `team up`. `--session` and
  `--file` on those commands are the owner's alone, from a terminal outside herdr, refused before
  anything is read.
- `status` and `doctor` read any team file without writing anything; `watch --file` is the owner's;
  a plain folder gets its watch.
- The rules reach a seat as one verified line that points at its rules file.
- The watch reports an idle seat once per idle period; `watch.idle_repeat` is off unless set.
- `team worktree` reads the approved copy of every value it uses.
- `up` refuses a launch line that can't run where its seat starts.
- `doctor` warns about a model-less launch only when nothing checks it; `status` gives a runnable
  repair order, the owner's repairs and unsent text.
- A file whose `version` is `"0"` (the placeholder `init` wrote) reads as unset; a wrong model
  family is still refused.

### Added

- `team up` reports one final record per seat, a vendor notice as a kind of its own, and cleaned
  output lines.
- `team up` no longer closes a seat that stops at a dialog: it keeps the workspace, records that the
  seat waits for its owner, and asks one key: `o` opens the pane, `s` skips the seat, `q` stops
  cleanly. `team` answers nothing and types nothing at a dialog. An owner with no terminal is never
  prompted.
- `team answer` and the `dialogs` policy: a coordinator may answer a trust dialog when the owner
  allows it.
- `team release check`, its `linear` and `activity` checks, and `--file` for it.
- Exit codes, documented and tested.
- `packages/teamcli`: the launcher package `@teamcli/cli` (the same tool, typed `teamcli`), in the
  repository and tested; it is not published with 0.3.0.

### Fixed

- A restored pane is its seat only while `team`'s own process is still in it; the repair is named.
- A trust close says the workspace was closed, a failed close is not announced as one, and a seat
  seen running and then gone is reported as such.
- Cursor: the idle box drawn inside a border is read; Cursor seats are read and checked whatever
  model they run.
- The pane-text sanitiser: BEL ends an OSC sequence only, in one linear pass.

### Known issues

- A team file at a non-default path: `up --file` starts no watch for it; start it by hand
  (`team watch --file <path>` from the owner's terminal). The line "watch: started" can be printed
  for a watch that then exits.
- **After a restart of the machine** (the multiplexer restores the panes; a CLI can come back as
  another model, or a pane as a bare shell): a seat launched by 0.3 is recognised as no longer the
  process `team` started, and `up` closes it without input and launches it again. **A seat still
  recorded by 0.2.1 (not relaunched since the upgrade) is not:** `up` leaves it ("already ready"),
  `remove` refuses a bare shell, and `status` names `team up` as a repair that does not work for it.
  What works: the owner's `team remove <seat> --abandon` (or `team down --abandon`), then `team up`.
  The upgrade's relaunch (`team down`, then `team up`) removes the case.
- `team down` that cannot confirm the exit text it typed leaves that text in the seat's input box;
  the next `down` skips the seat ("holds unsent text"). Clear the box by hand.
- The coordinator of a team whose file is not at the default path can run no team-changing command:
  it finds no file, and `--file` is the owner's. The owner runs them.
- A seat waiting at a permission prompt is reported by a running watch, to the owner; `team status`
  has no line for it.
- A seat that `up` leaves out because its screen's model family is not the file's ("left at
  launched, not named") keeps an unnamed pane; after the file is corrected and approved, the next
  `team up` refuses the session until that pane is closed by hand, and `team down` does not close
  it. This happens on a new 0.3 team too, not only after an upgrade.
- `--until` on the commands that take it is not validated.
- A seat stopped on its provider's error screen can read as idle or working.

### Not checked on a real session before the tag

Three things in this release were checked by tests and by runs in process on a test host, not on a
real herdr session. They are due on the owner's own upgrade.

- The caller gate from a coordinator's pane and from another pane (`add`, `remove`, `worktree`,
  `down` with no `--session`): covered by the caller and command tests; not typed in a real pane.
- A real trust dialog during `team up` (`o`, `s`, `q`): covered by the launch tests with an injected
  terminal; not answered on a real CLI.
- A seat left at launch for a model family its CLI doesn't run, the refusal of the next `team up`,
  the pane closed by hand, and `team up` again: run in process, where it ends with every seat ready;
  not on a real multiplexer.

## [0.2.1] - 2026-10-04

A safety patch: on Codex and Cursor the composer's input row is read only under the box's frame, so a
person's text can no longer be submitted together with `team`'s; and Antigravity's and Cursor's
dialogs are recognised as the permission or question they are.

### Security

- **In 0.2.0, and in every earlier release, on Codex and Cursor the composer's input row was the
  lowest row carrying the prompt glyph at the prompt column, wherever it sat.** A box drawing a
  person's text on one row and the glyph alone under it read idle: the person's text was not read,
  `team` typed under the glyph, the read-back held the typed text alone, and the Enter submitted the
  person's text together with the text `team` had typed. The input row is now read only under the
  box's frame, the blank run every capture draws directly above it: a second prompt row above or
  below the input, any other non-blank row pressed against the prompt from above, and a window that
  starts at or inside the box now read `unknown`, with no typing and no Enter, closing the limit
  the 0.2.0 section stated. What is not refused, and why: a prompt-shaped row across the blank frame
  is the transcript's echo of a message already sent — the real captures show both CLIs draw a
  person's later lines at the continuation column — so the empty input row under its frame still
  reads idle, and a seat between turns can still be dispatched to or nudged.

### Fixed

- Four Antigravity screens — the file-creation prompt, the file-edit prompt, the question screen and
  the "unsent comments" dialog — and two Cursor screens — the question box and the plan-mode
  approval — read `unknown`; they are now read as the permission or question they are. `team` typed
  into none of them before or after: `unknown`, permission and question all refuse typing alike.

## [0.2.0] - 2026-10-04

A feature release: the budgets table falls back per window and names the source each figure was
counted from; `team doctor` runs each account's approved budget check; `overrides.yaml` teaches a
shipped profile new dialog and quota patterns without waiting for a release; and every typing path
reads the input row from the captured frame and its prompt column, pressing Enter only when the box
reads back as exactly the typed text. Upgrade: a seat with no label is titled with its model and
version, and `team down` now clears the session it stopped.

### Security

- **In 0.1.2, a quota figure could be read off a pane the seat's CLI had already left.** herdr
  keeps a pane listed after the CLI exits, and a shell's last row is a last row by position, not a
  status row, so a status-shaped line under the recorded exit screen folded a figure into the
  readings and the watch saved it. A figure now reads only off a pane whose foreground processes
  still hold the seat's `cli`; a pane herdr can't list keeps its figure — not knowing is not proof
  the seat left.
- **In 0.1.2, a shell line containing a middot under a rule passed for Claude Code's status
  footer**, so a shell prompt could read as an idle composer when the box's top rule was out of the
  window. The footer rows are now anchored to Claude Code's own status rows, declared by the
  profile.
- **In 0.1.2, one indented line shaped like Claude Code's status row, or its mode row, under a rule
  below a shell prompt read as an idle composer.** A box whose top rule is out of the window is now
  recognised only by both rows, in order.
- **In 0.1.2, a Cursor seat with its follow-up queue on screen read idle or as holding unsent
  text**, so `down` could type `/exit` into a running seat and `remove` refused it as unsent. The
  queue's hint row under the empty composer belongs to the running turn; the profile now reads any
  spinner verb and that row (with nothing but chrome under it), so `down --wait` waits and `remove`
  says the seat is working.
- **In 0.1.2, delivery pressed Enter as soon as the composer read as unsent text, whatever the box
  actually held** — a fold marker whose hidden-row count could not be right, a box still holding a
  person's own text, and the typed text with one character changed all got the Enter, so text that
  was not the rules could be submitted as if `team` had sent it; the watch's nudge and the exit
  typed by `down` and `remove` pressed Enter on an unread box the same way. Every Enter now waits
  until the box reads back as exactly the text typed — folded or not, row for row — and a box whose
  wrap the profile's data cannot model gets no Enter at all: the wait ends in a refusal that reports
  the rules were not delivered, never an Enter on trust.
- **In 0.1.2 the composer's input row was the last row whose content began with a prompt glyph, and
  the fold frame ended on the first rule-looking row** — pre-existing holes, present in every
  release before this one too. A box holding a person's text and then a continuation row with only
  the CLI's prompt glyph read idle, the read-back held, and the Enter submitted the person's text
  with the team's; a rule row after the true tail still got the Enter. The input row is now read
  from the captured frame and its prompt column: for Claude Code and Antigravity, the box's first
  row under its opening rule; for Codex and Cursor, the column their captures draw the prompt at,
  where a continuation row as those CLIs draw it — indented — is content, so the person's text
  above it stays in the box. A row carrying the glyph at that exact column — a shape no capture
  shows those two CLIs drawing — is read as the input row, and a person's text left above it is not
  read. The box's fold is read the same way: its closing rule is the window's last rule row at the
  opening rule's own width, a rule-looking row anywhere else is a row of the box, and where the
  frame cannot be told the read fails closed and nothing is entered.
- **In 0.1.2 a two-rule frame was read without comparing its rules' widths** — pre-existing too,
  present in every release before this one. The composer's frame is read only when its two rules are
  one width, as every capture draws them: where a window's rules differ — a closing rule that is not
  the opening rule's own width — the box cannot be established, the read is unknown, and nothing is
  entered.

### Added

- `team doctor` runs each account's approved budget check once, for the owner only, and reports its
  reading, a broken output contract, a failure or a timeout; a check edited since approval is not
  run and is reported as changed. It also lists accounts no pattern or check can read. The check's
  raw output is never printed.
- `overrides.yaml`, beside the approval in `~/.config/team/<project>-<hash>`, may add dialog
  patterns and quota patterns to a shipped profile. `team approve` records it. Until then the
  approved copy stays in force, and `doctor` and `status` name the change.
- `schema/team.schema.json` describes the team file (draft 2020-12), assembled from the same
  section modules that validate it, with `schema:check` in CI keeping it current. The schema ships
  in the package, and a file `team init` writes now opens with a
  `# yaml-language-server: $schema=…` line pointing at this version's copy.
- `docs/reference/cli.md` is a generated CLI reference — every command, flag and positional, from
  the command definitions themselves — kept current by `contract:check`, with the same snapshot as
  data in `contract/cli.json`. Help text is unchanged.
- `bun run conformance` checks an implementation of screen reading and the YAML subset against the
  shared fixtures. `team conformance-adapter` is the TypeScript implementation of that protocol. It
  is not listed in `team --help`.
- `bun run coverage` prints the capture coverage matrix — for each CLI and screen kind, how many
  conformance fixtures are real captures, constructed, or with no provenance stated — and
  `coverage:check` keeps `contract/capture-coverage.json` current in CI, failing on a difference or
  any provenance problem. Only the fixture folder's README decides: a `capture` claim counts where
  the README lists the file under a heading that is not Constructed or Not produced.
- A profile may give a dialog pattern its own `ignore_case: true` beside its `match` — the flag
  reaching its `except` list too. Claude Code's trust question, spelled out in both cases letter
  class by letter class through 0.1.2, is now one line with the flag on it, and the "1. Yes" choice
  beside it stays matched as it is drawn. A composer's own patterns — `prompt`, `rule`, `footers`,
  the status line, the suffix — take strings; a flag written among them is refused at load with the
  key's name (`"prompt" cannot ignore case: only a dialog pattern may`).
- A profile may name a `screen_module` — a code module inside the package's profiles folder — for a
  CLI whose screens the data rules cannot express. Its predicates are combined with the data rules
  by OR for `working`, every dialog stage and `unknown`, so a hatch can only add caution, never
  remove it; a composer comes from data or from the hatch, never both, and a profile that carries
  both is refused when it loads. No shipped profile uses one. The guarantees cover what a hatch
  returns and what load accepts; a hatch is trusted package code, not a sandbox.

### Changed

- A seat with no label is titled with its model and version in lowercase (`claude opus 5.5`). A
  label written in the file is kept. Two seats may share a label — names are the only key — and an
  approval recorded by 0.1.1 or 0.1.2 stays valid while the file is unchanged since that approval.
- `team doctor` warns when a seat's name or label repeats the project or the session. The warning
  does not refuse the file.
- The budgets table names the source each figure was counted from and marks it `(fallback)` when
  that is not the first source the account names — `status line (fallback)` — and `status --json`
  carries the same `fallback` field on each budget row. The fallback is per window, not per
  account: a check that reported one window leaves the other window to the next source the account
  names.
- A stale figure with no known reset time reads unknown only while it could still matter: inside
  its reserve, or within the reserve again outside it. Beyond that it still counts, its row saying
  `last seen <age>` — the room the figure last held. It never refuses a launch.
- **`team down` now clears the herdr session it has itself just stopped**, its line reading
  `stopped and cleared`, so `up` after `down` starts the team again instead of refusing on the
  stopped session herdr keeps listed; where the clear does not happen the line names
  `herdr session delete <session>`. `up` never deletes a session: one it did not stop keeps the
  refusal.

### Fixed

- Claude Code's folder-trust dialog with unnumbered choices is read as a trust prompt, not a
  question.
- `team down` now stops a seat the file renamed after `up` launched it: the state records the CLI
  each seat was launched with, and `down` resolves the file's name first and the state's second,
  falling back to the seat a temporary seat is like. A state too old to say leaves the seat to its
  owner, named per seat with the command that closes it without typing.
- **A pattern's astral code point wrote five hex digits.** U+1F600 compiled as `ὠ` and a `0`, so an
  emoji or an astral range matched the wrong text; they now compile to the `\u{…}` form.
- **A `chrome` pattern could hide the unmarked second choice of a dialog.** The guard tested six
  sample lines, all of the first choice; it now tests the drawn shape — every mark or the indent,
  both numbered lines the safety floor reads, and the labels the profiles name.
- **A check's CRLF output read unknown.** `weekly 39% used\r\n` broke the contract on its line
  ending; each line now loses the trailing CR of a CRLF ending, and a CR anywhere else still breaks
  the contract.
- **A class mixing a complement shorthand with members was silently rewritten.** `[\D0-9]`
  compiled to `[\s\S]`; the positive class is now refused with the reason when the profile loads.
  `[^\S\n]` and a shorthand alone are unchanged.
- A temporary seat now follows the drift of the seat it is like, folding no figures until
  unapproved edits to the like-seat are approved.
- **An Antigravity seat's rules are delivered when agy folds the paste.** A long paste folds to
  `↑ N more lines` and the tail; the box is now read as folded, and Enter is pressed only when the
  visible tail rows and the hidden-row count are the ones the typed text renders to. A fold that
  doesn't match stays unsent.
- **A spend refusal rounded the figure it printed, into a contradiction with itself.** A reading of
  `4.996 USD` against a `5 USD` floor printed "5.00 USD, at or below its 5.00 USD floor"; the
  figure now prints as read — up to four decimals, the trailing zeros beyond the cents dropped,
  never fewer than two — in the refusal and the dry-run lines that reuse it, and a floor prints as
  the file wrote it.

## [0.1.2] - 2026-10-04

A safety release: 0.1.1 could type a nudge or an exit into the shell left after Claude Code exited,
and a seat could silence the watch's reports about itself. Upgrade.

### Security

- **In 0.1.1, a shell prompt left after Claude Code exited read as an idle composer**, so a nudge, a
  first message or an exit could be typed into a shell. A composer now reads idle only inside its
  own frame — the rule above the box or the status footer under it — and every typing path (the
  nudge, rules delivery, `down`'s and `remove`'s exit) also needs herdr to report the agent's
  process in the pane, read again immediately before the Enter.
- **In 0.1.1, parking or stopping a seat was not drift**, so a seat could silence its own idle
  reports by editing its entry in the file. Parking and stopping are now part of what the owner
  approves; `remove --keep` and `add` record the new digest when `stopped` is the only change, so
  those commands still leave that file approved, and an approval recorded before this stays valid
  while the file is unchanged since the approval.
- **In 0.1.1, `--no-notify` on the watch silenced a report addressed to the owner**, and any caller
  could run the session's only watch with it. Each report is now routed to the owner or the
  operator, and `--no-notify` drops only the operator's notice — the log line stays, and
  `team status` does not read the flag. The watch's own notices — the operator could not be
  nudged, herdr does not answer, the file cannot be read, a typed nudge was not sent, the watch
  stopped — are the owner's and survive the flag too. `--no-nudge` and `--no-notify` are the owner's.
- **In 0.1.1, a watch on a session other than the file's own saved its readings into the state a
  launch gate counts.** Such a watch now reads and reports as before, says so once, and saves no
  reading — budget or spend — so a session the file doesn't name can never decide a launch.

### Added

- A seat may name the budget account it spends, `account:`, when one vendor's two accounts are two
  buckets; without it a seat spends its `vendor`, and the choice is part of the seat's fingerprint,
  so the owner approves it. It must be a key of the file's `budgets.accounts` — a name the budgets
  don't hold is refused where it is — and an unapproved edit to it folds none of that seat's figures
  until the owner approves. A figure measuring the seat's vendor lands on the seat's own account,
  and a figure naming another account stays that account's, whichever seat's screen showed it.

### Changed

- While a `watch.checks` edit is unapproved, the approved list stays in force: nothing new is turned
  off, and an approved-off check stays off. Before, every check ran until the owner approved.
- **A seat could take the rules message for a task.** Every seat's rules text now ends with a line
  saying the rules are not a task. A first message closes with `These are standing rules, not a
  task: reply ready and wait for your brief.`; a launch option that stays in force on every later
  turn (claude-code's `--append-system-prompt`) closes with only `These are standing rules, not a
  task.` A team file whose own `rules:` already end with that line doesn't get it twice.
- A team whose seats were stopped by `remove --keep`, or parked by hand, since its last approval
  shows `seat X changed` for each after upgrading, and `up` and `add` refuse until the owner
  approves once.

### Fixed

- A greyed suggestion in a Claude Code input box is no longer read as text that was never sent:
  input text whose characters are all faint is the box's placeholder, and the seat reads idle. Text
  with any other styling reads as unsent text, and a line with no styling keeps the `Try "` rule.
- Cursor's running turn is the braille spinner, or the prompt line that ends in `ctrl+c to stop`.
  The same words quoted in the transcript are not a turn, and text typed on that prompt is unsent in
  the composer.
- A subscription check reading is kept in the state beside the screen readings, and `up`, `add` and
  `status` count it: a fresh check inside its reserve refuses a launch after the watch has exited, a
  stale one outside its reserve reads unknown, and the account's `sources` decide which reading counts.
- Budget readings are kept per project, not per herdr session: `up`, `add`, `status` and the watch
  read the one cache, so a figure one session saw counts for every session, and state files written
  before this change migrate as they are read — no reading is lost.
- A stale check reading inside its reserve keeps refusing until its known reset, as a stale screen
  reading does; an unconfirmed screen reading no longer hides a fresh check reading later in
  `sources`.
- A Claude question is the dialog's own last line. Prose that says "Esc to cancel", and a transcript
  of "1. Yes" / "2. No" above an empty box, stay idle.
- An Antigravity permission dialog whose rule line has scrolled out of the window (a long command)
  is still read as the dialog, and a Claude Code question with a line below its footer and no rule
  in the window is still read as a question.
- The watch folds its readings inside the state's own lock, so two watches of one project fold onto
  each other's figures instead of overwriting them.

## [0.1.1] - 2026-10-04

A safety release: 0.1.0 could type into a Codex permission dialog, and could read a quota figure a
seat wrote itself. Upgrade.

### Security

- **In 0.1.0, `team` could answer a Codex permission dialog.** With the status line pinned below
  the dialog, the screen read as unsent text, so rules delivery and the watch's nudge typed their
  text and Enter into it, accepting its first choice. The dialog is now read as the dialog: the
  safety floor's markers match without regard to case, and a rule's footer may sit above a
  `status-last` composer's pinned line. The dialog is reported and never answered, and rules
  delivery and the watch type nothing into it.
- **In 0.1.0, a seat could set its own quota figure** by printing or typing a line shaped like one,
  which could keep a launch from being refused. Quota figures are now read only from the status
  line's own row of a composer screen: a line printed into the transcript or typed into the input
  box is not read as one, a CLI whose composer shows no status line reads no figures at all, and a
  dialog, a question, a trust or an unknown screen reads none. A pane's owner can still draw a whole
  fake composer; a fresh `check` reading stays first, and a wrong figure can only refuse a launch or
  produce a report.

### Added

- A spend account's `floor` refuses a launch: the watch keeps the money each spend check reads in the
  state, and `up` and `add` refuse a seat whose account is at or below its floor. A reading that is
  missing, stale or in another currency than the floor's reads unknown, is said, and never refuses.

### Changed

- `bun run build` empties `dist/` first, so a file left by an older build can no longer end up in a
  packed or globally installed tarball.

## [0.1.0] - 2026-10-04

The first release: set up, change and watch a project's team of AI agents from one file,
`.agents/team.yaml`. Runs on Node 22 or later, with no runtime dependencies.

### Added

- The team file: a documented YAML subset with its own parser, validated field by field with line
  numbers, and a fictional example at `examples/team.yaml`. (#2, #11)
- `team init` and `team status`: write the skeleton file and keep it out of git through
  `.git/info/exclude`; print the file's seats against the running session, each difference with its
  repair; `--json` prints the same facts as one JSON document (`format: 1`) for scripts. (#3, #33)
- A seat whose own status line names another model than the file's is a status difference, with its
  repair; a model id the map doesn't know, or another maker's model run through Claude Code, is
  unread — a note, never a difference. (#30)
- `team approve`: record the file, its ceilings and its seats on this machine after a read-back and
  a typed seat count; `--show` prints the approved copy. (#4, #5)
- `team check`: check one commit, a range or a pull request body against the signature rule;
  forbidden lines and session links are refused by default; it runs on every pull request in this
  repository's CI, against the repository's own team file and the seats that sign its history.
  (#1, #8, #12)
- `team doctor`: check this machine for what the file needs — herdr, each CLI, login, launcher,
  model, watch heartbeat; `--login` checks read-only that each declared CLI is signed in, using each
  profile's login check, and answers no prompt. (#5, #33)
- `team watch`: report idle and blocked seats, unsent input and machine figures, and nudge the
  operator only into an empty idle prompt; `--no-nudge` and `--no-notify` turn those off. (#6, #7,
  #22)
- Linux: the caller check and the watch's load, memory and swap figures are read from `/proc`, so
  `team` answers there as on macOS. (#29)
- A stopped seat its owner starts by hand is watched like a parked one: prompts and unsent text are
  reported, its idle is not, and it is never read as an agent the file doesn't hold; parked and
  stopped follow RFC 0001. (#25)
- `team up` and `team down`: start and stop the session and its seats, each with its caller rule;
  staged launches, a wait for an empty idle prompt, trust and update screens read and never
  answered; `--dry-run` prints the plan and changes nothing. (#5, #13, #14)
- `team up` and `team add`: every `machine:` start limit — load, memory, disk, free swap and swap
  growth — is checked before each seat, and a breach refuses the launch, naming the figure and its
  limit; a `--dry-run` prints the refusal too. (#26)
- Launch profiles for `claude-code`, Codex, Antigravity and Cursor: approval flags added only at
  launch, rules delivered only into an empty idle prompt, screens read from recorded, sanitised
  fixtures; a Codex permission dialog is reported for its owner and never answered. (#16, #17,
  #18, #23, #24, #27)
- `team add` and `team remove`: start one declared or temporary seat; stop a seat, then take it out
  of the file — `--keep` leaves it stopped, `--abandon` is the owner's. (#19, #20)
- `team worktree new` and `team worktree remove`: create a task worktree from an up-to-date base, or
  remove its folder; a failed setup is kept and recorded, and the branch is never deleted. (#15)
- A README that covers the file by example and every command with who may run it. (#9)
- A page per command in `docs/commands`, every example run in CI. (#31)
- Codex's profile reads a weekly quota from its status line: `weekly N% left`, for the OpenAI account.
  A line cut short of the number is not a figure.
- `budgets` is an owner section: marks, freshness, and each account's reserve or floor. A `check`
  command is resolved and hashed at `team approve`. `watch.quota_marks` is read, with a warning.
  A changed check file leaves that account unknown; it does not refuse the rest of the file.
- A quota figure is kept per seat in the state file. The newest confirmed change counts. A first
  sight does not replace it, and a reading from before its reset is dropped.
- `team status` prints a budgets table, and the same rows in `--json`, when an account is named or
  a reading is stored. Unknown and stale are shown as such. A row inside its reserve says so even
  when the figure is still fresh.
- `team watch` reports a budget: each mark a window crosses, an account inside its reserve or floor
  (to the owner), and an account that reads unknown while seats run on it (to the operator). The
  accounts' check commands run in the watch loop, outside the pass: at most every `budgets.check_every`,
  ten seconds, an empty environment, and only when the approval covers them — their output is never
  logged. The core parses each seat's quota line, and a reading the pass saw is saved, so `status`,
  `up` and `add` count it. `watch.checks: { budget: off }` turns the report off.

### Changed

- The whole `watch` section is an owner section, its timings included: an edit to `interval`,
  `idle_first`, `idle_repeat`, `team_idle`, `nudge_wait` or `unsent_after` needs a new approval, and
  until the owner approves it the watch runs with the values of the approved copy — or with the
  defaults when nothing was approved. `watch.checks` keeps its own finer line inside the section.
  A timing a seat changed without an approval shows its difference at the next pass, for the owner
  to settle. A never-approved team runs on the defaults, whatever its file says.
- The whole `budgets` section is an owner section too, its accounts and marks included: an edit to
  a reserve, a floor, `stale_after`, `check_every` or the accounts needs a new approval, and until
  the owner approves it every reader — the watch's reports and its check cadence, the check
  commands' own run, `up`'s and `add`'s launch gate, and `status`'s table — runs with the values of
  the approved copy, or with the defaults (no accounts) when nothing was approved. A file never
  approved runs no check at all. An unapproved edit silences nothing and unblocks nothing.

### Fixed

- A seat that isn't `mode: shared` and works in worktrees starts in the lobby — the parent of
  `workspace.path` with `.lobby` beside the worktrees, inside `trust` and outside every protected
  checkout — never the project root, which holds the owner's uncommitted work; `up` and `add` make
  it once, refuse a lobby outside `trust` or inside a protected checkout, and refuse a seat the file
  aims at one. (#35)
- Claude Code's permission stage is the dialog itself: the question with its "Esc to cancel · Tab to amend"
  footer, or a Yes/No choice below the last rule. An idle seat that only quotes "Do you want to proceed?"
  stays idle.

[Unreleased]: https://github.com/floor/teamcli/compare/v0.3.5...HEAD
[0.3.5]: https://github.com/floor/teamcli/releases/tag/v0.3.5
[0.3.4]: https://github.com/floor/teamcli/releases/tag/v0.3.4
[0.3.3]: https://github.com/floor/teamcli/releases/tag/v0.3.3
[0.3.2]: https://github.com/floor/teamcli/releases/tag/v0.3.2
[0.3.1]: https://github.com/floor/teamcli/releases/tag/v0.3.1
[0.3.0]: https://github.com/floor/teamcli/releases/tag/v0.3.0
[0.2.1]: https://github.com/floor/teamcli/releases/tag/v0.2.1
[0.2.0]: https://github.com/floor/teamcli/releases/tag/v0.2.0
[0.1.2]: https://github.com/floor/teamcli/releases/tag/v0.1.2
[0.1.1]: https://github.com/floor/teamcli/releases/tag/v0.1.1
[0.1.0]: https://github.com/floor/teamcli/releases/tag/v0.1.0
