---
created: 2026-10-18
updated: 2026-10-27
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: Runtime, chapters D and I (commitments 10, 11, 13, 14 and 26's state file)
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: launch, rules delivery and profiles

## 1. Scope

This spec covers how a seat is started and recorded: the rules text a seat is given and the three
ways it reaches the seat, the per-seat rules file and the one line that names it, the profile that
decides each CLI's launch line, exit, screens and rules mode, and the team state file the launch
writes beside the team file. It leaves the agent, team and project records to the registry spec,
the reading of a seat's state to the seat-state-and-watch spec, and the admission of the commands
that launch to the Kernel and to the grants spec. It says what the code at the tag does, in the
code's words.

## 2. Terms

- **rules**: the standing instructions a seat gets at launch; not a task.
- **delivery**: how the rules reach the seat — `option`, `message` or `prepend`.
- **rules file**: the file a message-delivered seat's rules are written to, in the project state
  folder.
- **rules line**: the one line typed into a message seat's pane, naming the rules file and the
  first twelve hex digits of its SHA-256.
- **profile**: the shipped description of one CLI's launch line, screen grammar, rules delivery
  and tested version range, keyed by the seat's `cli`.
- **tested range**: the two versions, both included, a profile was captured against.
- **state file**: `.agents/team.state.json` beside the team file, holding the session's seats,
  worktrees, watch, hold and the project's last readings.
- **stage**: a seat record's word — `launched`, `named` or `ready`.
- **waiting record**: the record a launch leaves when a seat stops at a dialog it never answers.
- **launched identity**: the pane's shell pid and the foreground pids the launch recorded after
  the idle prompt.
- **project state folder**: `.config/team/<project>-<hash>` under the owner's home, beside the
  approval store. `<project>` is the project name with every character outside `A-Za-z0-9._-`
  replaced by `_`. `<hash>` is the first twelve hexadecimal digits of SHA-256 of the root's
  canonical path, or of the path as given when it cannot be canonicalised (`src/store/store.ts`).

## 3. Formats

### 3.1 The rules text

The rules are one text, built in a fixed order. The first four are the tool's own, in these words:

1. `End every commit message and every pull request body with your signature, given below.`
2. `Never stop at a question: tell the orchestrator (<name>) in one line and keep working.`
3. ``Never run `team grant`, `team delegate` or `team revoke`, and never edit `trust:` in the team file.``
4. `In a protected checkout, never switch the branch, reset or commit.`

Then, in this order:

| Part | Written from |
|---|---|
| the profile's own rules | the profile's `standing_rules`, a safety line the CLI makes necessary; often empty |
| the file's rules | the team file's `rules` list |
| the signature lines | two lines, from the file's signature templates and the seat |
| the workspace lines | the protected checkouts, and the worktree or shared-folder line |

The signature lines:

- `Your signature in a commit message, <place>: <commit signature>`, where `<place>` is
  `as a trailer, in a last paragraph of its own that holds trailers only`, `as its last line`, or
  `on a line of its own`, from the file's `commits.position`.
- `Your signature in a pull request body, as its last line: <pull request signature>`.

The workspace lines:

- `Protected checkouts, relative to the project root: <path>, <path>` — only when the file names
  any.
- In worktree mode: `Work on the code in the worktree your brief names, never in the checkout you
  started in.` followed by ` Branches are named <pattern>.` when the file names one.
- In shared mode: `Change to <cwd> before any project work.` where `<cwd>` is the seat's folder
  resolved against the project root.

The whole text is the headline, one `- ` line per rule, and the delivery's closing line last:

    Rules for this session, from the team file:
    - <rule>
    ...
    <closing line>

A rule that equals the closing line is written once, as the closing line.

A team read from the registry (`team config`, the record under `~/.config/team/team-config/`)
uses the same text with two lines renamed. The headline is `Rules for this session, from the
team's registry config:`. The trust rule (item 3) is ``Never run `team grant`, `team delegate`
or `team revoke`, and never edit `trust:` with `team config`.`` A read of a real team.yaml —
`--file`, `team migrate`, and the file fallback when the registry holds no config record —
keeps the file wording above. A rules file that does not match is `its rules file differs from
the team file's rules` for a file read, and `its rules file differs from the team's registry
config` for a registry read.

### 3.2 The three deliveries

| Delivery | How the rules reach the seat | Closing line | Rules file | `state.rules` |
|---|---|---|---|---|
| `option` | embedded in the launch option the profile names (`--append-system-prompt` for claude-code, `--rules` for grok) | `These are standing rules, not a task.` | none | `option` |
| `message` | written to the rules file, and one line typed into the pane at an empty idle prompt | `These are standing rules, not a task: reply ready and wait for your brief.` | yes | `message`, or `undelivered` when the line was not typed |
| `prepend` | prepended to every brief a send types into the pane; there is no standing session to keep them | `These are standing rules for this session. The brief follows.` | none | `prepend` |

A first message is answered once, so its closing line asks for the ready reply; a launch option
stays in force on every later turn, so its closing line must not; prepended rules ride every
brief, so they say the brief follows. The delivery is the seat's profile's `rules`, defaulting to
`message`.

### 3.3 The seat's rules file

Path: `<project state folder>/rules/<seat name>.md`. The seat name must pass the team file's own
seat-name rule, and the file name must stay within 255 bytes; a name the file refuses gets no path
at all.

| What | Required |
|---|---|
| the state root, `.config/team` | a real directory of this user's; whatever mode the user keeps |
| the project state folder | a real directory of this user's, mode exactly `0700` |
| `rules/` | a real directory of this user's, mode exactly `0700` |
| the file | this user's regular file, mode exactly `0600` |

Writing: each level is checked with `lstat` and a missing level is made one at a time with an
explicit mode; the text lands through a temporary of an unpredictable name opened
`O_CREAT | O_EXCL | O_NOFOLLOW` at `0600` and renamed into place; the file is read back without
following a link and its SHA-256 compared with the hash the line carries. A link, a FIFO, another
owner or a wider mode is refused, never `chmod`'d or replaced.

The typed line:

    Read <absolute path> (sha256 <first 12 hex digits>): your standing rules for this session; reply ready and wait for your brief.

Example:

    Read <home>/.config/team/demo-3f9c2a8e1d7b/rules/implementer.md (sha256 5e1d0a9c4b2f): your standing rules for this session; reply ready and wait for your brief.

A path is typed only when every character is in `A B C ... Z a b c ... z 0 9 . _ / @ + -`; a path
holding whitespace or anything else is refused, never quoted or escaped. The line is read back row
by row — every visible character in order, a row break allowed to stand for at most one space or
nothing — and only then is Enter pressed, once. A box that already holds exactly the line is
verified and sent, never typed onto again. A box the run cannot verify is never cleared.

The refusals a message seat can meet, in the launch's words:

| Line | When |
|---|---|
| `<seat>: left out: rules not typed: the folder that would hold its rules file is <what>; the owner removes or repairs it, then runs up again` | a folder from the state root down to `rules/` is a link, not a directory, another user's, or `rules/` or the project folder is wider than `0700` |
| `<seat>: left out: rules not typed: its rules file's place holds <what>; the owner removes it, then runs up again` | the final name holds anything but this user's `0600` regular file |
| `<seat>: left out: rules not typed: its rules file did not read back as written; check the project state folder, then run up again` | the write landed and read back as another text |
| `<seat>: left out: rules not typed: its rules file could not be written; check the project state folder, then run up again` | any other write fault |
| `<seat>: left out: rules not typed: its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -; rename the seat or move the project, then run up again` | the path holds a character the read-back cannot prove |
| `<seat>: left out: rules typed, not sent: the rules file changed after it was written` | the before-Enter look found another text; Enter was not pressed |

`team status` and `team doctor` check a message seat's file against the live file's rules text and
print one finding each: `its rules file is missing`, `is a symbolic link`, `is not a regular file`,
`has mode <mode>, not 0600`, `is not owned by this user`, `cannot be read`, or `differs from the
team file's rules`; the repair is `team reload <seat>`, and no check ever rewrites the file.

### 3.4 The profile

Profiles ship with the tool, one per CLI, as `src/profiles/<cli>.yaml`; the loader parses each file
with its own parser, and `src/profiles/profile.schema.json` documents the shape the tests check the
shipped files against. The runtime does not load profiles through the schema. The launch-relevant
fields:

| Field | Type | Meaning |
|---|---|---|
| `format` | number | the profile file's format |
| `cli` | string | the key a seat's `cli` names |
| `binary` | string | the binary whose version is read, and the one herdr must see in the pane |
| `process_names` | string[] | the process names the caller check accepts |
| `tested.from`, `tested.to` | string | the tested range, both ends included |
| `unattended` | string[] | options that run the CLI without approvals |
| `rules` | `first-message` \| `prepend` \| `{ option: <flag> }` | the delivery: `first-message` reads as `message`, `{ option }` as `option` |
| `standing_rules` | string[] | rules for every seat of this CLI, over the file's |
| `login.check`, `login.hint` | string[] / string | the arguments that exit 0 only when logged in, and the login command |
| `exit` | string | the text typed at an idle prompt to exit; absent when the CLI exits by key |
| `exit_keys` | string[] | the keys that exit an idle CLI; empty when `exit` is used |
| `exit_clear`, `exit_confirm` | string | the one key that empties the box, and the one that confirms the CLI's exit question |
| `lobby_files` | string[] | the regular files the CLI may leave in its working folder |
| `startup_reads` | string[] | relative paths the CLI reads at start; a trailing `/` names a directory |
| `timeouts.idle`, `timeouts.exit` | duration | the waits for the idle prompt and for the pane's shell after exit |
| `models.option`, `models.ids` | string[] / rules | the model flag and the ids it maps to a model and version |
| `status_model` | rules | how a status line names the model |
| `quota` | patterns | account, window, used and reset readings |
| `screen` | stages | the CLI's dialog and prompt grammar: `unknown`, `trust`, `permission`, `question`, `exit_question`, `provider_error`, `rate_limit`, `working`, `composer` |
| `herdr_status` | `reliable` \| `unreliable` | whether herdr reports this CLI's status faithfully |

`startup_reads` is a YAML string list, not the loader's object form: each entry is a non-empty path
relative to the lobby, with no empty, `.` or `..` segment and no `*`, `?` or `[`; a trailing `/`
marks a directory, and the loader keeps `{ path, directory }` in memory. Writing an object into a
profile is refused (`src/profiles/profile.ts`).

The shipped profiles at the tag:

| CLI | Binary | Rules delivery | Tested |
|---|---|---|---|
| `claude-code` | `claude` | `option` (`--append-system-prompt`) | 2.1.288 to 2.1.302 |
| `codex` | `codex` | `message` | 0.157.0 to 0.161.0 |
| `cursor` | `cursor-agent` | `message` | 2026.10.01 to 2026.10.14 |
| `antigravity` | `agy` | `message` | 1.2.16 to 1.4.1 |
| `grok` | `grok` | `option` (`--rules`) | 1.0.50 to 1.0.52 |
| `gemini` | `gemini` | `message` | 0.64.0 to 0.64.0 |
| `muse` | `muse` | `message` | 1.4.9 to 1.4.9 |
| `jules` | `jules` | `prepend` | 0.1.42 to 0.1.42 |

A version against a profile's range reads `tested`, `older`, `newer` or `unread`; `team doctor`
warns for `older`, `newer` and `unread`, the last saying its version cannot be read. `team reload`
refuses `reload.untested` for `older` and `newer` only — naming the version, the range and that
its ready screen may not be recognised — and closes nothing. An `unread` version is not evidence
against the CLI: it is warned by `doctor` and passes that reload gate.

The owner's override file is `<project state folder>/overrides.yaml`. It may add dialog patterns
for `unknown`, `trust`, `permission` and `question`, and quota patterns; it cannot remove a
shipped pattern, and it cannot change a composer, a prompt, a footer, a launch line or the order
of the stages — anything else is refused with its line. An edit takes effect only once the
approved copy records the text; until then the approved copy stays in force, and a copy that
cannot be read leaves the shipped profiles.

### 3.5 The state file

Lives at `.agents/team.state.json`, beside the team file. A missing file is an empty state; a
file that is not valid JSON, or is not format 1, is an error that refuses — never silently
replaced.

| Field | Type | Meaning |
|---|---|---|
| `format` | `1` | the file's format |
| `last_valid` | `{ read_at, file }` | the last reading of the team file that verified, when the state records it |
| `budgets` | map | the project's last account readings, whatever session saw them |
| `spend` | map | the project's last spend readings |
| `hold` | `{ reason, by, at, until? }` | the team's hold; a hold past `until` reads as none |
| `expired_policies` | string[] | expired policy declarations already logged |
| `sessions` | map | one entry per herdr session |

A session entry:

| Field | Type | Meaning |
|---|---|---|
| `started` | `{ at, by }` | when and by whom the session was started |
| `seats` | map | the live seat records |
| `retained_seats` | map | `seat_<12 hex>` handles kept across `remove --keep`, `down` and `up`'s repair |
| `swapping` | map | a lead stopped for a replacement by `remove <lead> --keep`: who and when |
| `worktrees` | map | `{ path, branch, own_commits?, seat?, setup }` per worktree |
| `watch` | `{ pid?, heartbeat, pane?, workspace? }` | the watch's process, last pass, pane and workspace |
| `launched_file` | string | the team file the session was launched from |
| `watchdog` | `{ file, pane? }` | the team file a flagless watch may read, and the pane that may read it |
| `nudge` | `{ pending_since }` | declared in the state shape; no code at the tag writes or reads it |
| `procs` | map | the processes seats recorded with `team proc add` |

A seat record:

| Field | Type | Meaning |
|---|---|---|
| `id` | `seat_<12 hex>` | the stable seat handle, minted when the seat is first recorded |
| `stage` | `launched` \| `named` \| `ready` | how far the launch has come |
| `cli` | string | the CLI launched, so a stop uses it even if the file renamed it |
| `last_active` | ISO 8601 | the last ready, or the last time the seat was seen working |
| `pane`, `workspace` | string | herdr's pane and workspace |
| `start_cwd` | string | the folder the launch line ran in |
| `cli_version` | string | the version the CLI printed |
| `rules` | `option` \| `message` \| `prepend` \| `undelivered` | how the rules were delivered |
| `worked` | boolean | whether the seat has been seen working |
| `launched` | `{ shell, cli: number[] }` | the launched identity: the pane's shell pid and the CLI's pids |
| `agent_session` | string | the agent session herdr reported at idle, for continuity |
| `model`, `version` | string | what the launch declared |
| `effort` | string | the effort word the launch set, when it set one |
| `launch_line` | string | the launch line as it ran |
| `temporary` | `{ like, until, task?, own_commits? }` | a temporary seat's terms |
| `waiting` | `{ state, classification, manual?, sentAt?, version?, folder? }` | a seat left at a dialog |

The waiting state is `waiting-owner` or `trust-sent-recovery`; its classification is one of the
closed list `trust`, `permission`, `question`, `provider error`, `rate limit`, `vendor notice`,
`login`, `unknown`, `unsent`, `timeout`, and anything else that enters the file reads `unknown`.

Every write holds `.agents/team.lock` and goes through a temporary file. The log is
`.agents/team.log`: one cleaned line per change — when, which command, by whom, what — rotated at
one megabyte with three kept; a log write that fails is dropped.

### 3.6 The launch's JSON document

`team up --json` writes one `team.up` v1 document on stdout, its `schema` tag first: `format`,
`dry_run`, `status` (`dry-run`, or `ready` on a real run), `action_summary`, `project`, `session`,
`seats` (every name the file carries, once) and `notes`. A dry run's `plan` holds one
`{ step, seat?, detail, prefix? }` per plan line, a run step prefixed `+` and a skip `skip`; a
warning leads as `{ step: "warning", prefix: "!" }` when there is one. A refusal writes one
`team.error` v1 document instead — its `id`, `message`, `repair` and, where it carries one,
`rule` — with stderr empty and the same exit code as without `--json`.

### 3.7 The lobby the launch uses

A team's seats start and wait in one lobby, chosen in this order:

1. the file's explicit `lobby:` entry, which is the owner's own declaration and is re-recorded
   each time it is read;
2. else the lobby the registry recorded for the session, which is kept: editing the file's
   `entity:` never moves a recorded lobby;
3. else the entity's own lobby, one folder per entity under the tool's configuration folder;
4. else the machine-global lobby of the releases before entities.

The lobby gate admits the lobby only when every component it reaches is a real directory of this
user, with no symbolic link on the way, and the lobby itself has mode exactly `0700`. An
ancestor's mode is not tested; only the lobby's is. The seat's
CLI trust record is written in the lobby before the seat's workspace exists, so the launch meets
no folder-trust dialog there. A lobby the gate refuses ends the launch for every seat with
`up.lobby`.

*Source:* `src/file/sections/lobby.ts` (the `lobby:` entry), `src/lobby/recorded.ts` (the recorded
map), `src/lobby/gate.ts` (the gate), `src/launch/pretrust.ts` (the trust record written first).
*Proof:* `test/commands/lobby.test.ts`, `test/lobby-recorded-acceptance.test.ts`,
`test/check-lobby-recorded.test.ts`, `test/launch/pretrust.test.ts`.

## 4. Commands and options

    team up [--dry-run] [--serial] [--session <name>] [--file <path>] [--json]
    team add <name> [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>] [--json]
    team add --temporary --like <seat> --until <result:path|merged:branch> [--worktree <task>] [--model <model>] [--effort <effort>] [--dry-run] [--session <name>] [--file <path>] [--json]
    team restart <seat> [--abandon] [--dry-run] [--session <name>] [--file <path>] [--json]
    team reload <seat> [--file <path>] [--json]
    team down [--dry-run] [--wait] [--abandon] [--session <name>] [--file <path>] [--json]
    team remove <name> [--keep] [--abandon] [--session <name>] [--file <path>] [--json]

`team down --wait` gives a working seat up to 120 seconds to stop before the command proceeds
(`WAIT_SECONDS`, `src/commands/down.ts`).

`team up`'s exit ids at the tag: `up.ready` and `up.dry-run` (0); `up.agents`, `up.clear`,
`up.delegate`, `up.delegate-approval`, `up.delegate-command`, `up.delegate-evidence`,
`up.delegate-flag`, `up.delegate-placement`, `up.deny`, `up.detached`, `up.doctor`,
`up.grant-another-pane`, `up.grant-approval`, `up.grant-caller`, `up.grant-flag`,
`up.grant-no-pane`, `up.grant-scope`, `up.herdr`, `up.lobby`, `up.machine`, `up.never-approved`,
`up.no-launch`, `up.not-owner`, `up.pending`, `up.placement`, `up.run-lock`, `up.server`,
`up.stopped`, `up.unknown`, `up.watch` (1); `up.file`, `up.file-invalid`, `up.invocation`,
`up.not-a-repo` (2). The other launch commands' ids are the exit-codes registry's.

## 5. Rules

1. **A launch records what it started, in the state beside the file.** `up` MUST start the
   session, run each seat's launch line in its folder, wait for the idle prompt, name the pane,
   record the process identity, deliver the rules, write the state, the log and the registry,
   paint the sidebar and start the watch. A refusal before the first step MUST launch nothing.
   *Source:* `src/launch/plan.ts`, `src/launch/execute.ts`, `src/launch/agent.ts`. *Proof:*
   `test/launch/launch.test.ts`.
2. **The rules text's order is fixed.** The tool's four MUST come first, then the profile's,
   the file's, the seat's signature and the workspace's; the closing line MUST be last and a file
   rule equal to it MUST be written once. *Source:* `src/launch/rules.ts` (`seatRules`,
   `rulesText`). *Proof:* `test/launch/launch.test.ts`, `test/launch/rules-file.test.ts`.
3. **The delivery is the profile's choice.** A seat's rules MUST travel as `option`, `message` or
   `prepend` as its profile says, and a seat with no profile MUST default to `message`. *Source:*
   `src/launch/rules.ts` (`rulesOf`), `src/profiles/profile.ts` (`rulesMode`). *Proof:*
   `test/profile-launch.test.ts`, `test/launch/rules-file.test.ts`.
4. **A message seat's rules file is written whole, or nothing is typed.** The path MUST be built
   from the project's own state folder; every folder MUST be a real directory of this user's at
   its required mode; the file MUST be this user's `0600` regular file, written through an
   exclusive no-follow temporary and proved by a read-back hash. *Source:*
   `src/launch/rules-file.ts` (`rulesFilePath`, `writeRulesFile`). *Proof:*
   `test/launch/rules-file.test.ts`.
5. **The typed line names the file and its hash, and Enter follows the read-back alone.** A path
   MUST be refused, never quoted, unless it is in the typeable characters; the line MUST be read
   back row by row before every Enter; a key the CLI did not take MUST be retried, never
   re-typed, at most the measured number of tries while the box still reads back as the line; a
   box the run cannot verify MUST NOT be cleared. *Source:*
   `src/launch/rules-file.ts` (`rulesLine`, `typeablePath`, `rulesFileHolds`),
   `src/launch/deliver.ts` (`deliverRules`), `src/launch/execute.ts`. *Proof:*
   `test/launch/launch.test.ts`, `test/agy-rules-readback-boundaries.test.ts`,
   `test/launch/codex.test.ts`.
6. **A profile is data the tool ships and validates.** Each profile MUST name its CLI, binary,
   tested range and rules delivery, and MUST be read by the loader's own parser; the JSON Schema
   MUST remain the documented shape the tests check the shipped profiles against; a CLI with no
   profile MUST NOT launch. *Source:* `src/profiles/profile.ts` (`loadShipped`, `launchOf`,
   `rulesOf`), `src/profiles/profile.schema.json`. *Proof:* `test/profile-schema.test.ts`,
   `test/profile-launch.test.ts`.
7. **Outside its tested range, a CLI is read at launch only if its screens are recognised.** A
   version `older`, `newer` or `unread` MUST be warned by `doctor`; `reload` MUST refuse
   `reload.untested` for `older` and `newer` only and close nothing; an `unread` version alone
   MUST NOT refuse the reload. *Source:* `src/profiles/profile.ts` (`versionVerdict`),
   `src/commands/doctor.ts`, `src/commands/reload.ts`. *Proof:* `test/launch/launch.test.ts`
   (the version verdicts), `test/commands/doctor-models.test.ts` (the warnings),
   `test/exit-codes.test.ts` (the `reload.untested` scene).
8. **The owner's overrides MAY add, never remove or change.** An override MUST be limited to
   dialog and quota patterns; anything else MUST be refused with its line; an edit MUST take
   effect only once the approved copy records it. *Source:* `src/profiles/overrides.ts`.
   *Proof:* `test/overrides-approval.test.ts`.
9. **A seat's stage and rules word are recorded by the launch.** A record MUST carry
   `launched`, `named` or `ready`, and `option`, `message`, `prepend` or `undelivered`; a record
   reached `ready` only after the idle prompt appeared. *Source:* `src/state.ts` (`SeatState`),
   `src/launch/execute.ts`. *Proof:* `test/state.test.ts`, `test/launch/launch.test.ts`.
10. **A dialog at launch is never answered.** The launch MUST NOT answer the dialog or type into
    it. The owner at a terminal is asked; a delegated or terminal-less run takes the close path.
    A kept seat MUST be left out with its classification and a `waiting-owner` record, and its
    workspace MUST be kept. A close path MAY close the workspace without input only when the
    seat's identity and ownership are proved; the record MUST then be dropped and the close said.
    A refused or failed close MUST preserve the waiting record. *Source:*
    `src/launch/progress.ts` (`CLASSIFICATIONS`), `src/launch/execute.ts` (`atDialog`),
    `src/state.ts` (`SeatState.waiting`). *Proof:* `test/launch/pause.test.ts`,
    `test/launch/progress.test.ts`, `test/launch/launch.test.ts` (the closed-without-input
    cases).
11. **The launched identity is pids, never a command line.** The launch MUST record the pane's
    shell pid and the CLI's foreground pids after the idle prompt; a pane whose shell is in front
    with no CLI MUST read `gone`; a pane fronting a program the record does not name MUST read
    `replaced`, and is the seat again only when herdr names the seat there and the agent session
    is the one stored at launch. *Source:* `src/launch/identity.ts` (`LaunchedIdentity`,
    `seatProcessVerdict`, `replacedSeat`). *Proof:* `test/launch/identity.test.ts`.
12. **The state file is written by the tool alone, whole or not at all.** Every write MUST hold
    the team's lock and go through a temporary file; a missing file MUST read as empty; an
    unreadable or wrong-format file MUST refuse, never be replaced silently. *Source:*
    `src/state.ts` (`readState`, `writeAtomic`, `LOCK_FILE`). *Proof:* `test/state.test.ts`,
    `test/unsigned-state-boundaries.test.ts`.
13. **A seat record the file no longer declares is read past.** Only a temporary seat's record
    MUST stand without a file declaration; `team check --repair` MAY drop the rest. *Source:*
    `src/state.ts` (`seatOfFile`). *Proof:* `test/state-departed-seats.test.ts`.

## 6. Registries

**`operations`** (the commands this area owns, by gate):

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `up` | the owner, or `leads` for its own team | 0.5.0 | `src/permissions/map.ts` | the `start` row |
| `down` | the owner, or `leads` for its own team | 0.5.0 | `src/permissions/map.ts` | the `stop` row; the owner may always stop |
| `restart` | the owner, or `leads` for its own team | 0.5.0 | `src/permissions/map.ts` | the `start` row for one seat |
| `reload` | the owner, or `leads` for its own team | 0.5.0 | `src/permissions/map.ts` | the `start` row for a running seat |
| `add` | the owner alone | 0.5.0 | `src/permissions/map.ts` | where no `agree` or `grant` holders stand |
| `remove` | the owner, or `leads` for its own team | 0.5.0 | `src/permissions/map.ts` | a seat holding `grant`, `agree` or `leads` stands only by the owner |

**`exit-codes`** (the `team up` rows):

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `up.ready` | the launch finished | 0.5.0 | `contract/exit-codes.json` | exit 0 |
| `up.dry-run` | the plan, or the refusal a real run would give | 0.5.0 | `contract/exit-codes.json` | exit 0 |
| `up.deny` | deny | 0.5.0 | `contract/exit-codes.json` | exit 1; a refused real run answers this one word |
| `up.detached` | a run with no terminal | 0.5.0 | `contract/exit-codes.json` | exit 1 |
| `up.machine` | the machine is over a launch limit | 0.5.0 | `contract/exit-codes.json` | exit 1 |
| `up.run-lock` | another session-mutating run holds the session | 0.5.0 | `contract/exit-codes.json` | exit 1 |
| `up.lobby` | the lobby could not be created | 0.5.0 | `contract/exit-codes.json` | exit 1 |
| `up.pending` | a seat was left short of ready | 0.5.0 | `contract/exit-codes.json` | exit 1 |
| `up.watch` | the watch did not start | 0.5.0 | `contract/exit-codes.json` | exit 1 |
| `up.file` | the team file can't be read | 0.5.0 | `contract/exit-codes.json` | exit 2 |
| `up.file-invalid` | the team file can't be parsed | 0.5.0 | `contract/exit-codes.json` | exit 2 |
| `up.invocation` | the invocation can't be read | 0.5.0 | `contract/exit-codes.json` | exit 2 |
| `up.not-a-repo` | not inside a git repository | 0.5.0 | `contract/exit-codes.json` | exit 2 |

The full set, `up.agents` to `up.unknown` included, is the `up` rows of `contract/exit-codes.json`.

**`cli-ranges`** (the shipped profiles):

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `claude-code` | binary `claude`; 2.1.288 to 2.1.302 | 0.5.0 | `src/profiles/claude-code.yaml` | rules as an option |
| `codex` | binary `codex`; 0.157.0 to 0.161.0 | 0.5.0 | `src/profiles/codex.yaml` | rules as a first message |
| `cursor` | binary `cursor-agent`; 2026.10.01 to 2026.10.14 | 0.5.0 | `src/profiles/cursor.yaml` | rules as a first message |
| `antigravity` | binary `agy`; 1.2.16 to 1.4.1 | 0.5.0 | `src/profiles/antigravity.yaml` | rules as a first message |
| `grok` | binary `grok`; 1.0.50 to 1.0.52 | 0.5.0 | `src/profiles/grok.yaml` | rules as an option |
| `gemini` | binary `gemini`; 0.64.0 to 0.64.0 | 0.5.0 | `src/profiles/gemini.yaml` | rules as a first message |
| `muse` | binary `muse`; 1.4.9 to 1.4.9 | 0.5.0 | `src/profiles/muse.yaml` | rules as a first message |
| `jules` | binary `jules`; 0.1.42 to 0.1.42 | 0.5.0 | `src/profiles/jules.yaml` | rules prepended to each brief |

## 7. Open points

- **Eight profiles ship, seven are named.** The Runtime text's must-not-pretend line names seven
  CLIs with a profile; the tag ships eight, `jules` beside them, whose rules are prepended
  because its TUI keeps no standing session.
- **No launcher registry.** A profile's launch line is the file's text, checked where it will
  start; the `launcher` reference a text names is declared and never resolved.
- **No hash-pinned start command.** The launch line is recorded as it ran; the per-seat digest of
  prompt, instructions, environment and permissions that a text names is not built.
- **The state's `budgets` and `spend` are the budget text's.** This spec records their place in
  the file and leaves their reading, marks and staleness to the budgets spec.
- **`last_valid` is a remembered valid reading, not an approval.** `currentTeam` records the text
  of a file that loaded, and when an existing file no longer validates it returns the remembered
  copy with a notice naming the copy's date (`src/file/current.ts`). A missing file does not take
  that fallback. Only the commands that must keep working read this way — `status`, `watch` and
  `down`; the commands that launch or change anything load the live file and refuse an invalid
  one. The remembered text proves that it validated once and is not an approval record.
- **A message seat's rules are the live file's, never the approved copy's.** Both the folder and
  the text follow the live file: the delivery helper ignores its standing-copy arguments and
  derives the path from the live project's name (`src/launch/rules-file.ts`), and `up` passes the
  live project to the writer (`src/commands/up.ts`). A project rename therefore moves the path
  with the file; the approved copy is not consulted.
- **CLI extension contracts (0002).** Waits for the CLI extension contracts spec: the screen
  grammar, the composer-region safety floor, the restricted portable patterns, the staged
  escape hatch and cross-implementation conformance.

## Revision log

- **Draft** (the Runtime text's writer, 2026-10-18): lifted from the Runtime's chapters D and I;
  read at the tag.
- **Draft, amended** (the Runtime text's writer, 2026-10-18): a second read against the tag
  corrected eight points — the rules path follows the live file; the remembered-valid fallback is
  described; `startup_reads` is a YAML string list; the loader's parser, not the schema, enforces;
  `reload` refuses only `older` and `newer`; the dialog's prompt, keep and safe-close outcomes are
  separated; the lobby's exact mode check is its own; and the store folder's hash and
  project-name sanitiser are given.
