# Output Contract (0.5.2)

Every `team` command in 0.5.2 follows one output contract across its human-readable plain text, its `--json` documents, its `--help` usage text, and its exit codes. The shared formatting, JSON envelope, and schema-publishing helpers live in `src/output/index.ts`, with test assertions in `test/helpers/output.ts`.

---

## 1. Command Scope and Structure Matrix

The CLI contract covers **50 command names** in `src/cli.ts` order: top-level `team`, the 48 subcommands in the `commands` table, and the hidden protocol entry `conformance-adapter`.

Every command falls into one of four surface shapes:

- **Reading commands** (`status`, `seats`, `list`, `check`, `doctor`, `commits`, `pr`, `release`, `usage`, `feed`, `messages`, `issues`, `plan`, `ask-show`, `drops`, `policy`, `sessions`, `mcp`, `projects`, `worktree list`, `proc list`, `send --list`): inspect state and print a context line (when team- or project-scoped), a headered table or structured findings list, optional collapsed notes, optional `difference:` / `repair:` / `who:` blocks, and one closing summary line.
- **Action commands** (`up`, `down`, `add`, `remove`, `restart`, `reload`, `register`, `answer`, `init`, `grant`, `delegate`, `revoke`, `worktree new|remove`, `send`, `reply`, `raise`, `route`, `next`, `lock`, `unlock`, `tempo`, `hold`, `pause`, `resume`, `policy set|unset`, `rename`, `proc add|clear`): mutate state or preview a mutation under `--dry-run`, printing a context or plan header, step lines (`+`, `!`, `  skip`) on `--dry-run`, and one closing action summary line (`dry run: nothing was run` on `--dry-run`).
- **Top-level CLI** (`team`): prints `--help`, `--version`, or `--about` (which prints the version, licence, docs link, and the `what 0.5.0 must not pretend` block).
- **Daemon / protocol surfaces** (`watch`, `broker`, `bus`, `conformance-adapter`): long-running foreground loops or wire-protocol adapters; human-readable startup/refusal lines follow the error contract on stderr, and `--json` is not used on the daemon loop itself.

### 1.1 Per-Command Output Matrix (All 50 Contract Commands)

In `src/cli.ts` command order (`contract/exit-codes.json` is authoritative for the exit rows and row IDs):

| # | Command | Surface | Context line | Table headers | Notes / diffs / summary | `--json` schema name | Schema file | Exit codes (contract rows) | `--help` exit line |
|---|---|---|---|---|---|---|---|---|---|
| 0 | `team` | top-level | `team <ver> — <desc>` on `--about` | — | `what 0.5.0 must not pretend:` on `--about` | `team.about` (on `--about --json`) | `schema/about.schema.json` | `0, 1, 2` (7 rows) | `Exits 0 on --help, --version, or --about, 1 when a command throws an uncaught error, 2 when no command or an unknown command is given.` |
| 1 | `check` | reading + `--repair` | `team <project>, session "<session>"` | — | `warning:` (deprecations), `note:`, `difference:`/`repair:`/`who:` (including set-aside `delivery_order` settings), `no differences` / `<n> difference` / `<n> differences[, <m> for the owner]` | `team.check` | `schema/check.schema.json` | `0, 1, 2` (13 rows) | `Exits 0 when nothing needs acting on, 1 when something does, 2 when the check can't run.` |
| 2 | `commits` | reading | — (repo range) | `COMMIT  STATUS  DETAIL` | per-commit refusal + repair + `who:`, summary count | `team.commits` | `schema/commits.schema.json` | `0, 1, 2` (15 rows) | `Exits 0 when every commit passes, 1 when one is refused, 2 when the check can't run.` |
| 3 | `doctor` | reading | `team <project>, session "<session>"` | — (findings lines `ok  `, `warn`, `MISS`, `note`; no header row) | `team doctor: …` summary + `what 0.5.0 must not pretend:` (omitted on `--login`) | `team.doctor` | `schema/doctor.schema.json` | `0, 1, 2` (6 rows) | `Exits 0 when nothing is missing, 1 when something is missing, 2 when the invocation or team file can't be read.` |
| 4 | `down` | action (`--dry-run`) | — (per-seat / session lines) | — (per-seat note lines, no table) | `+`/`!`/`  skip` plan steps; existing final line is `action_summary` | `team.down` | `schema/down.schema.json` | `0, 1, 2` (30 rows) | `Exits 0 when the session is down or the dry-run plan is printed, 1 when the stop is refused, 2 when the invocation, team file, or herdr can't be read.` |
| 5 | `drops` | reading (`--follow`, `--read`) | `team <project>, session "<session>"` | `FROM  PATH` | `<n> drop` / `<n> drops`; `--read` prints the record bodies | `team.drops` | `schema/drops.schema.json` | `0, 1, 2` (6 rows) | `Exits 0 when the folder is read, 1 when the caller is not a placed seat of this team, the team file can't be read, or the drop folder can't be read or a waiting message cannot be read, 2 when the invocation can't be read or this folder is neither a checkout nor a team root.` |
| 6 | `init` | action (no `--dry-run`) | — (pre-session, project-scoped) | — | existing `Wrote …` / restore line is `action_summary` | `team.init` | `schema/init.schema.json` | `0, 1, 2` (13 rows) | `Exits 0 when the team file is written or restored, 1 when init is refused, 2 when the invocation can't be read or this folder is not a git repository.` |
| 7 | `grant` | action (`--dry-run`) | — | — | plan steps on `--dry-run`; one action summary line | `team.grant` | `schema/grant.schema.json` | `0, 1, 2` (4 rows) | `Exits 0 when the grant is written or the dry-run plan is printed, 1 when it is refused, 2 when the invocation or team file is invalid.` |
| 8 | `delegate` | action (`--dry-run`) | `team <project>, session "<session>"` | — | plan steps on `--dry-run`; one action summary line | `team.delegate` | `schema/delegate.schema.json` | `0, 1, 2` (4 rows) | `Exits 0 when the delegate is written or the dry-run plan is printed, 1 when it is refused, 2 when the invocation or team file is invalid.` |
| 9 | `revoke` | action (`--dry-run`) | — | — | plan steps on `--dry-run`; one action summary line | `team.revoke` | `schema/revoke.schema.json` | `0, 1, 2` (4 rows) | `Exits 0 when the grant or delegate is revoked or the dry-run plan is printed, 1 when it is refused, 2 when the invocation or team file is invalid.` |
| 10 | `status` | reading (**pilot**) | `team <project>, session "<session>"` (or `project <name> …`) | `SEAT  STATE  MODEL  PANE  REACH` (or 11-col with `--all`) | `budgets:`, `note:`, `difference:`/`repair:`/`who:`, `no differences` / `<n> difference` / `<n> differences[, <m> for the owner]` | `team.status` / `team.status.project` | `schema/status.schema.json` | `0, 1, 2` (12 rows) | `Exits 0 when the session agrees with the file (or the project is listed), 1 when it differs or is refused, 2 when the invocation, team file, or herdr can't be read.` |
| 11 | `seats` | reading | `team <project>, session "<session>"` | `SEAT  ID  ROLE  CLI  MODEL  EFFORT  STATUS  STATE  SOURCE  LAST ACTIVE  PANE` | `<n> seat` / `<n> seats` summary (or existing table under `--watch`) | `team.seats` | `schema/seats.schema.json` | `0, 1, 2` (9 rows) | `Exits 0 when the seats are shown, 1 when an owner-only flag is refused, 2 when the invocation, team file, or herdr can't be read.` |
| 12 | `list` | reading | — (cross-session) | `TEAM  PROJECT  STATUS  SEATS  ACTIVITY  NOTE` (or `ENTITY  TEAM/SESSION  PROJECT  LOBBY  SEATS  DEFINED  APPROVED  RUNNING  SOURCE`, plus `--seats` sub-rows) | `<n> session` / `<n> sessions` summary | `team.list` | `schema/list.schema.json` | `0, 2` (4 rows) | `Exits 0 when the sessions are listed (including when none are running or herdr is down), 2 when the invocation can't be read.` |
| 13 | `up` | action (`--dry-run`) | — (per-seat `<seat>: ready` lines) | — (per-seat note lines, no table) | `+`/`!`/`  skip` plan steps; existing final line is `action_summary` | `team.up` | `schema/up.schema.json` | `0, 1, 2` (36 rows) | `Exits 0 when the team is ready or the dry-run plan is printed, 1 when launch is refused or fails, 2 when the invocation or team file can't be read.` |
| 14 | `watch` | daemon | `team <project>, session "<session>"` | — | foreground loop; refusals on stderr | — (daemon loop) | — | `0, 1, 2` (13 rows) | `Exits 0 when the watch starts or stops cleanly, 1 when it is refused or fails, 2 when the invocation or team file can't be read.` |
| 15 | `messages` | reading; reading (`--client`) | `team <project>, session "<session>"` | `ID  FROM  TO  SENT  STATUS` | `<n> message` / `<n> messages` summary; the client form adds one `ack:` line when `--ack` was given and carries `key_isolation` | `team.messages` / `team.messages.client` | `schema/messages.schema.json` / `schema/messages-client.schema.json` | `0, 1, 2` (17 rows) | `Exits 0 when the inbox is read (a client reading included), 1 when the caller, team file, message record, client request, grant, inbox or ack is refused, 2 when the invocation can't be read or this folder is not a git repository.` |
| 16 | `issues` | reading | `team <project>, session "<session>"` | `ID  STATE  ASSIGNEE  TITLE` | `<n> issue` / `<n> issues` summary | `team.issues` | `schema/issues.schema.json` | `0, 1, 2` (7 rows) | `Exits 0 when the issues are listed, 1 when the team file or issues file can't be read, 2 when the invocation can't be read or this folder is not a git repository.` |
| 17 | `sessions` | reading | — (machine-wide listing) | `SESSION  SEAT  TEAM  MODEL  STARTED  ENDED  WHY  COST` | `<n> session` / `<n> sessions`; `--by` groups under one heading per value | `team.sessions` | `schema/sessions.schema.json` | `0, 1, 2` (4 rows) | `Exits 0 when the records are listed, 1 when a session registry can't be read, 2 when the invocation can't be read.` |
| 18 | `next` | reading + action | `team <project>, session "<session>"` | — | claimed/open task + `action_summary` | `team.next` | `schema/next.schema.json` | `0, 1, 2` (14 rows) | `Exits 0 when a task is claimed, released, or none is open, 1 when the caller, policy, broker, or file is refused, 2 when the invocation can't be read or this folder is not a git repository.` |
| 19 | `plan` | reading | `team <project>, session "<session>"` | `STEP  STATE  OWNER  TITLE` | `<n> task` / `<n> tasks` summary | `team.plan` | `schema/plan.schema.json` | `0, 1, 2` (10 rows) | `Exits 0 when the plan is shown, 1 when the caller, broker, or file is refused, 2 when the invocation can't be read or this folder is not a git repository.` |
| 20 | `worktree` | reading + action | `team <project>, session "<session>"` | `TASK  BRANCH  PATH` (on `list`) | `<n> worktree` / `<n> worktrees` on `list`; `action_summary` on `new`/`remove` | `team.worktree` | `schema/worktree.schema.json` | `0, 1, 2` (54 rows) | `Exits 0 when the worktree is created, listed, or removed, 1 when the operation is refused or fails, 2 when the invocation or team file can't be read.` |
| 21 | `add` | action (`--dry-run`) | — (per-seat lines) | — (per-seat note lines, no table) | `+`/`!`/`  skip` plan steps; existing final line is `action_summary` | `team.add` | `schema/add.schema.json` | `0, 1, 2` (60 rows) | `Exits 0 when the seat is ready or the dry-run plan is printed, 1 when add is refused or launch fails, 2 when the invocation or team file can't be read.` |
| 22 | `answer` | action | `team <project>, session "<session>"` | — | `<seat>: answered trust (<folder>)` summary | `team.answer` | `schema/answer.schema.json` | `0, 1, 2` (21 rows) | `Exits 0 when the trust dialog is answered and the seat is ready, 1 when the answer is refused or does not complete, 2 when the invocation or team file can't be read.` |
| 23 | `ask-show` | reading | — | — | question body and verification summary | `team.ask-show` | `schema/ask-show.schema.json` | `0, 1, 2` (4 rows) | `Exits 0 when the question is printed, 1 when the marker does not verify, the ask has expired, or a file cannot be read, 2 when the invocation cannot be read.` |
| 24 | `pr` | reading | — | — | refusal + repair + `who:`, summary line | `team.pr` | `schema/pr.schema.json` | `0, 1, 2` (8 rows) | `Exits 0 when the body passes, 1 when it is refused, 2 when the check can't run.` |
| 25 | `register` | action (`--dry-run`) | — (`<seat>: registered — pane <pane>…`) | — | single `register` step on `--dry-run`; existing line is `action_summary` | `team.register` | `schema/register.schema.json` | `0, 1, 2` (26 rows) | `Exits 0 when the seat is registered (or already recorded, or on --dry-run), 1 when registration is refused, 2 when the invocation or team file can't be read.` |
| 26 | `reload` | action (no `--dry-run`) | — (`team reload: <seat> …`) | — | existing `team reload: …` line is `action_summary` | `team.reload` | `schema/reload.schema.json` | `0, 1, 2` (24 rows) | `Exits 0 when the seat is reloaded or already matches the file, 1 when reload is refused or relaunch fails, 2 when the invocation or team file can't be read.` |
| 27 | `remove` | action (no `--dry-run`) | — (`<seat>: stopped` / `removed <name>`) | — | existing `removed <name>` / `stopped <name>` line is `action_summary` | `team.remove` | `schema/remove.schema.json` | `0, 1, 2` (39 rows) | `Exits 0 when the seat is removed (or stopped for a swap), 1 when removal is refused or fails, 2 when the invocation or team file can't be read.` |
| 28 | `restart` | action (`--dry-run`) | — (`team restart: restarted <seat>…`) | — (pre-close check lines are notes, no table) | `+`/`!`/`  skip` plan steps; existing `team restart: …` line is `action_summary` | `team.restart` | `schema/restart.schema.json` | `0, 1, 2` (18 rows) | `Exits 0 when the seat is restarted or the dry-run plan is printed, 1 when restart is refused or fails, 2 when the invocation or team file can't be read.` |
| 29 | `send` | action (`--dry-run`) + `--list` | `team <project>, session "<session>"` | `SEAT  NICKNAME  ROLE  PROJECT  REACH` (on `--list`) | delivery outcome summary (`delivered`, `held`, etc.) | `team.send` / `team.send.list` | `schema/send.schema.json` | `0, 1, 2` (18 rows) | `Exits 0 when delivered, answered, listed, recorded, or resolved by --dry-run, 1 when held, not-submitted, timed out, unreachable, stopped, or refused, 2 when the invocation or team file can't be read.` |
| 30 | `reply` | action | `team <project>, session "<session>"` | — | one line: `<target>: replied` / `<thread>: closed` (`action_summary`) | `team.reply` | `schema/reply.schema.json` | `0, 1, 2` (5 rows) | `Exits 0 when the reply or the close is written, 1 when the reply is refused, a client record is not answered because client reply publication is not in this release, or no record holds <id>, 2 when the invocation or the team file can't be read.` |
| 31 | `route` | reading / `--dry-run` | `team <project>, session "<session>"` | — | resolved address / leg walk summary | `team.route` | `schema/route.schema.json` | `0, 1, 2` (7 rows) | `Exits 0 when the address is answered, 1 when the route is refused or cannot be recorded, 2 when the invocation or team file cannot be read.` |
| 32 | `feed` | reading | `team <project>, session "<session>"` | `TIME  KIND  SEAT  DETAIL` | `<n> event` / `<n> events` summary | `team.feed` | `schema/feed.schema.json` | `0, 1, 2` (5 rows) | `Exits 0 when the feed is printed, 1 when the history log or the presence event log can't be read, 2 when the invocation or team file can't be read.` |
| 33 | `release` | reading | `package <name>, version <ver>` | `CHECK  STATE  DETAIL` | `<n> check` / `<n> checks, <m> missing` summary | `team.release` | `schema/release.schema.json` | `0, 1, 2, 64` (5 rows) | `Exits 0 when every check passes, 1 when one is missing, 2 when one is unknown, 64 on a bad invocation or an invalid team file.` |
| 34 | `usage` | reading | — (cross-project store) | `ACCOUNT  WINDOW  LEFT  USED  RESETS  READ  SOURCE  STATE` (with `RESERVE` before `READ` only when a row has a reserve) | one `advice:` line, collapsed `note: … (x<n>)`, summary line; `--tree` adds a `quota` block and, under each team table, one line per seat window and one `cost` line per seat (`cost  $5.8` measured, or `cost  unknown` with its reason, never `0`) | `team.usage` | `schema/usage.schema.json` | `0, 2` (3 rows) | `Exits 0 when the report is printed, 2 when the invocation or store folder can't be read.` |
| 35 | `lock` | action | — (machine-scoped) | — | `action_summary` | `team.lock` | `schema/lock.schema.json` | `0, 1, 2` (5 rows) | `Exits 0 when the lock is taken, 1 when it is already held or cannot be written, 2 when the invocation or project can't be read.` |
| 36 | `tempo` | action | `team <project>, session "<session>"` | — | `action_summary` | `team.tempo` | `schema/tempo.schema.json` | `0, 1, 2` (8 rows) | `Exits 0 when the tempo is set or already matches, 1 when the caller is not the owner, 2 when the invocation, tempo word, or team file can't be read.` |
| 37 | `unlock` | action | — (machine-scoped) | — | `action_summary` | `team.unlock` | `schema/unlock.schema.json` | `0, 1, 2` (7 rows) | `Exits 0 when the lock is released, 1 when it is not held, held by someone else, or cannot be removed, 2 when the invocation or project can't be read.` |
| 38 | `hold` | action | `team <project>, session "<session>"` | — | `action_summary` | `team.hold` | `schema/hold.schema.json` | `0, 1, 2` (10 rows) | `Exits 0 when the hold is placed or released, 1 when it is refused or state I/O fails, 2 when the invocation or team file can't be read.` |
| 39 | `pause` | action | — (per-team summary; stop lines below) | — | `<pause line>` summary and one `stop <seat>: …` line each for one team | `team.pause` | `schema/pause.schema.json` | `0, 1, 2` (8 rows) | `Exits 0 when the team is paused, 1 when it is refused or state I/O fails, 2 when the invocation or team file can't be read.` |
| 40 | `resume` | action | — (per-team summary; stop lines below) | — | `resumed <project> (<pause line>)` and one `stop <seat>: …` line each for one team | `team.resume` | `schema/resume.schema.json` | `0, 1, 2` (8 rows) | `Exits 0 when the team resumes, 1 when it is refused or state I/O fails, 2 when the invocation or team file can't be read.` |
| 41 | `raise` | action (`--dry-run`) | `team <project>, session "<session>"` | — | `raise: <kind> delivered to the owner at once` / `raise: <kind> merged into the owner's record (×N)` (`action_summary`) | `team.raise` | `schema/raise.schema.json` | `0, 1, 2` (8 rows) | `Exits 0 when the line is delivered or merged into one already open, 1 when it is refused or the log or the owner's record can't be written, 2 when the invocation or team file can't be read.` |
| 42 | `broker` | daemon | `team <project>, session "<session>"` | — | foreground loop; refusals on stderr | — (daemon loop) | — | `0, 1, 2` (12 rows) | `Exits 0 when it stopped, 1 when it refused to start or lost its socket, 2 when the invocation can't be read or this folder is neither a checkout nor a team root.` |
| 43 | `bus` | daemon | — (stderr only) | — | foreground loop; `team bus: answering on .agents/bus.sock` / `team bus: stopped` on stderr | — (daemon loop) | — | `0, 1, 2` (5 rows) | `Exits 0 when it started and stopped cleanly, 1 when it refused to start or could not bind its socket, 2 when the invocation or team configuration can't be read.` |
| 44 | `mcp` | reading (`status` / `doctor`) | `mcp <lobby>` | `NAME  STATE  DETAIL` (one table per leg on `status`) | `state: …` / `<n> missing` summary | `team.mcp` | `schema/mcp.schema.json` | `0, 1, 2` (8 rows) | `Exits 0 when every observed leg is up (status) or nothing is missing (doctor), 1 when a leg is down, the bridge is not set up, or doctor finds something missing, 2 when the invocation can't be read.` |
| 45 | `proc` | reading (`list`) + action (`add`/`clear`) | `team <project>, session "<session>"` | `NAME  BY  SINCE  PID  NOTE` (on `list`) | `<n> process` / `<n> processes` on `list`; `action_summary` on `add`/`clear` | `team.proc` | `schema/proc.schema.json` | `0, 1, 2` (13 rows) | `Exits 0 when the process is recorded, listed, or cleared, 1 when the operation is refused, 2 when the invocation or team file can't be read.` |
| 46 | `projects` | reading | — (machine registry) | `ID  NAME  ENTITY  LEAD  TEAMS` | `<n> project` / `<n> projects` summary | `team.projects` | `schema/projects.schema.json` | `0, 1, 2` (3 rows) | `Exits 0 when the projects are listed, 1 when the project registry cannot be read, 2 when the invocation can't be read.` |
| 47 | `policy` | reading + action (`set`/`unset`, `--dry-run`) | `team <project>, session "<session>"` (` · seat <name>` with `--seat`) | `POLICY  VALUE  LEVEL  SETTER  EXPIRY  KIND` | `same as the team` when the `--seat` view has no difference from the team; `policy: set` / `would set` / `unset` / `would unset` summary | `team.policy` | `schema/policy.schema.json` | `0, 1, 2` (4 rows) | `Exits 0 when policies are listed, updated, or planned, 1 when refused, 2 when the invocation or team file is invalid.` |
| 48 | `rename` | action (`--renumber --dry-run`) | — (per-seat lines) | — | `from -> to` lines; the no-op run prints `team rename: all numbered seats already match the seat numbering in force` | — (`--json` prints a plain `{ dryRun, renames }`) | — | `0, 1, 2` (4 rows) | — (no `Exits` line in `--help`) |
| 49 | `conformance-adapter` | protocol (hidden) | — | — | wire protocol | — (protocol) | — | `0` (1 row) | Hidden protocol command (not in `commands` or `--help`); exits `0` when the protocol finishes. |

### 1.2 Context Line

Team-scoped reading commands that open with a multi-row table or findings block (`status`, `seats`, `check`, `doctor`, `messages`, `issues`, `feed`, `plan`, `drops`, `policy`, `raise`, `reply`, `worktree list`, `proc list`, `send --list`) print a single context line (`contextLine(project, session)`):

```text
team <project>, session "<session>"
```

- **`init` and `register`**:
  - `init` is project-scoped and runs before a team or session exists: it prints **no** `team <project>, session "<session>"` context line, and its `--json` envelope has `file`, `status` (`"wrote"` | `"restored"`), `notes`, and `action_summary` (with no `session`).
  - `register` acts on a seat record in a session, and its single-line plain output (`<seat>: registered — pane <pane>; nothing was launched` / `already registered…` / `would register…`) is already self-identifying; it does **not** prepend a separate context line in plain text, while `team.register` `--json` carries `project` and `session`.

Every project-scoped reading (`team status --project <name>`) opens with `projectContextLine(project)`:

```text
project <name>  <id>  entity <entity>  lead <lead>
```

When `project.entity` is `null`, the `entity <entity>` segment is omitted (`project <name>  <id>  lead <lead>`). When `project.id` or `project.lead` is `null` or `undefined`, it renders as `-` (`lead -`). All interpolated values are cleaned with `plainLine` first.

**Home-relative paths in human output (`displayPath(text, home)`)**:
- Human-readable prose lines replace the user's `$HOME` prefix with `~` (e.g., `the lobby ~/.config/team/lobby`, `mcp ~/.config/team/lobbies/acme`, `+ record: <seat>: append the route to ~/.config/team/<project>-<id>/routes.jsonl`), while `--json` documents retain full absolute paths.
- **Exemption for exact `herdr` command lines in `--dry-run` plans**: literal command lines printed by a `--dry-run` plan (`+ herdr …`, such as `add`'s `--cwd <home>/.config/team/lobby`) stay literal because they are exact commands a user may copy and run.

### 1.3 Tables and Column Headers

Every tabular block prints an **uppercase column header row** above its data rows:

- **`team status` (default, 5 columns)**:

```text
  SEAT           STATE    MODEL            PANE   REACH
  claude-keeper  working  Claude Opus 5.5  w1:p1  socket
  codex-acme     idle     GPT Sol 6        w2:p1  typed
```

  - The fifth column is explicitly titled **`REACH`** (`socket` or `typed`), never an unlabelled trailing word.
  - Seats with `state === "stopped"` are omitted by default and shown only when `--all` is passed.
- **`team status --all` (11-column expanded registry table)**:

```text
  SEAT           ID                 ROLE         CLI          MODEL            EFFORT  STATUS   STATE  SOURCE   LAST ACTIVE  PANE
  claude-keeper  seat_0123456789ab  coordinator  claude-code  Claude Opus 5.5  max     working  working  cli    just now     w1:p1
```

  - Under `team status --all`, stopped seats are included in the 11-column table.
- **`team seats` (always 11 columns)**:
  - `team seats` always renders the 11-column registry table (`SEAT  ID  ROLE  CLI  MODEL  EFFORT  STATUS  STATE  SOURCE  LAST ACTIVE  PANE`) at column 0 (`indent: ''`).
  - Without `--all`, seats whose `status === "stopped"` are omitted; `team seats --all` includes stopped seats with their retained `id` and `last_active`.
- **Per-seat action records (`up`, `down`, `add`, `restart`) are notes/steps, not tables**:
  - Per-seat progress and pre-close lines in action commands (`<seat>: ready`, `<seat>: stopped`, `input box: …`, `turn: …`, `context: …`) are action step/note lines, **not** tables — they do **not** gain a `SEAT  STATE  PANE` uppercase header row. In `--json`, they populate the structured `seats` / `seat` / `checks` / `notes` fields.
- **Table alignment and indentation rules (`renderTable`, `formatTable`)**:
  - Columns are separated by **two spaces** (`  `), left-aligned, with trailing whitespace trimmed on every line.
  - Missing or inapplicable cells render as `-`.
  - Column widths are computed on `plainLine`-cleaned text *before* any ANSI styling is applied.
  - `spec.indent` defaults to `'  '` (two spaces, for tables nested under a context line or section heading such as `team status`). Top-level tables with no context line (such as `team seats`, `team list`, `team projects`) pass `indent: ''` so the table starts at column 0.

### 1.4 Severity Vocabulary (`team doctor`, `team mcp doctor`)

Diagnostic commands that inspect machine or bridge prerequisites use one closed four-level severity vocabulary (`SEVERITY_LEVELS` and `SEVERITY_LABELS` in `src/output/text.ts`), rendered via `renderFinding(finding, style, home)`:

| Level (`SeverityLevel`) | Printed label (`SEVERITY_LABELS[level]`) | Meaning | Blocks `up` / `add`? |
|---|---|---|---|
| `'ok'` | `ok  ` | Prerequisite is present, verified, or within the tested version range | No |
| `'warn'` | `warn` | Untested CLI version, missing model flag, rules drift, or file deprecation warning | No (exits `0` if no `miss`) |
| `'miss'` | `MISS` | Missing binary, not logged in, herdr unreachable, refused/legacy record, or stale watch | Yes (except watch findings, which `up` starts itself) |
| `'note'` | `note` | Informational state (session running/not running, login unchecked, active hold, `model_from: launcher`) | No |

### 1.5 Differences, Repairs, and `who`

Every difference reported in plain text (`status`, `check`, and any command reporting a state discrepancy) renders three lines via `renderDifference(diff, style)`:

```text
difference: <what>
  repair: <repair>
  who: <who>
```

The `who` value comes from the closed four-value vocabulary `DIFFERENCE_WHO_VALUES` (`src/output/text.ts`):

- `'the owner'`: only the machine owner at an interactive terminal may run the repair (`team init`, `team add` when gated owner-only, `team grant`, `team delegate`, `team revoke`, `team check --repair`, or any pane/file action marked `owner: true` or `approval: true`).
- `"the team's lead"`: the owner or the seat holding `leads: true` on the team (by the `leads` capability, never a role word) may run the repair (`team up`, `team down`, `team restart`, `team remove`, `team answer`, `team watch`, `team worktree`).
- `'a grant holder'`: the owner or a seat/team holding an active signed grant covering the capability or grant scope (`write`, `read`, `review`, `gate`, `merge`, `deploy`, `act-as`, `use-broker`, or grant scopes `reload`, `swap`, `approve`). A rules-drift difference names `team reload <seat>`: that command's map row is lead-admitted, so the row itself renders `who: the team's lead`, while a signed grant carrying the `reload` scope stands as the command's second door.
- `'any seat'`: any registered seat of the team (or the owner) may run the repair (`team register`, `team send`, or seat-record read surfaces `status`, `check`, `messages`, `feed`, `list`, `usage`, `next`).

**Set-aside `delivery_order` settings (`team check`, scene D4)**:
- When a `delivery_order` / delivery-order setting in `.agents/team.yaml` (at the team, role, or pair level) is set aside because it holds an illegal or empty word (leaving the inherited delivery order in force), `team check` reports it as a `difference:` naming the invalid setting and the standing inherited order, with `repair:` pointing to fixing the `delivery_order` value in `.agents/team.yaml` and `who: "the team's lead"` — the repair is a plain file edit that a lead may make, so the repair names no command and the map falls back to the lead.

**Deterministic resolution rule (`whoOfDifference(diff)` and `whoFromCommand(command)`)**:
The repair names the **first** authority tier that applies:
1. If `diff.who` is explicitly set on `OutputDifference`, return `diff.who`.
2. If `diff.owner === true`, `diff.approval === true`, `diff.repair.startsWith('the owner ')`, or `diff.repair === 'the live file is what the commands read'`, return `'the owner'`.
3. Strip any trailing ` (after: …)` annotation (which `orderAndAnnotateDifferences` appends when `diff.needs === 'approve'`, so `needs: 'approve'` never masks the repair's own command), take the repair's **chain** — its text before any `, or ` / `(or ` alternative; a verb phrase's own "or" ("clear or send it in the pane") stays on the chain — and extract **every** `team <command>` token on it. Map each command against `COMMAND_GATES` (`src/permissions/map.ts`) and `GRANT_SCOPES` (`src/file/types.ts`):
   - `COMMAND_GATES[command].kind === 'owner-only'` → `'the owner'`
   - `COMMAND_GATES[command].kind === 'owner-or-leads'`, `'pane-authority'`, or `'team-change'` → `"the team's lead"`
   - `COMMAND_GATES[command].kind === 'capability'` or `GRANT_SCOPES.includes(command)` → `'a grant holder'`
   - `COMMAND_GATES[command].kind === 'seat-record'`, `'owner-or-own-team'`, `'admission'`, or `'team-read'` → `'any seat'`
   - `COMMAND_GATES[command].kind === 'any-caller'`, `'seat-only'`, or `'leads-only'` — the rows 0.5.2 adds for the contract — → `"the team's lead"`, the fallback those words took before the map carried them; and so does a `team <word>` the map does not carry at all, prose like `team file` ("update the team file's model").

   The chain runs its legs in order, so the repair's `who` is the actor **every leg admits** — the narrowest of the four. An owner-only leg narrows the chain to `'the owner'`: `team remove <seat> --keep, then team add <seat>` is the owner's, because a lead runs the first leg and is refused at the second, leaving the repair half done. `'a grant holder'` and `"the team's lead"` are not comparable — the same seat need not hold both — so a chain mixing either with anything else is the owner's too. An "or" alternative is another way into the repair, not a leg: it does not narrow the chain. Where a repair has a lead-runnable alternative, print that alternative instead of the narrow chain, so the line names a command the lead can finish.

### 1.6 Closing Summary Line and Real Plurals (`pluralCount`)

Every command ends its plain-text reading or action with **one summary line** using real singular/plural words via `pluralCount(n, singular, plural?, options?)` (`src/output/text.ts`) — never `(s)`:

- **Readings with differences (`status`, `check`)** (`renderSummary(diffs)`):
  - When `differences === 0`: `no differences`
  - When `differences === 1` and `owner_differences === 0`: `1 difference`
  - When `differences > 1` and `owner_differences === 0`: `<n> differences`
  - When `differences > 0` and `owner_differences > 0`: `<n> difference, <m> for the owner` / `<n> differences, <m> for the owner`
  - Here `owner_differences` counts the differences whose resolved `who` is `'the owner'` — the same rule the rows print, chain narrowing included (`diff.owner === true`, `diff.approval === true`, an explicit `diff.who === 'the owner'`, a repair that starts `the owner `, the approval precondition, or a chain whose every leg admits the owner only).
- **`team doctor`**:
  - When `missing === 0`: `team doctor: nothing missing, <w> warning` / `<w> warnings`
  - When `missing > 0`: `team doctor: <n> missing, <w> warning` / `<w> warnings` (plus `: <b> of them block \`up\` and \`add\`` when `b > 0`), followed on full runs (not `--login`) by the `what 0.5.0 must not pretend:` block.
- **Counted table summaries (`seats`, `send --list`, `list`, `messages`, `issues`, `plan`, `feed`, `worktree list`, `projects`, `release check`, `mcp doctor`, `proc list`)**:
  - `pluralCount(n, singular)` formats `1 <singular>` for `1` and `<n> <plural>` for `0` or `n >= 2` (e.g., `0 seats`, `1 seat`, `4 seats`, `0 tasks`, `1 task`, `2 tasks`).
- **Action commands (`up`, `down`, `add`, `remove`, `restart`, `reload`, `register`, `grant`, `delegate`, `revoke`, `init`, `worktree`, `hold`, `tempo`, `lock`, `unlock`, `pause`, `resume`, `raise`, `reply`, `policy`, `proc`)** (`renderActionSummary(spec)`):
  - **Existing final outcome line counts as the summary line**: where an action command's existing final line already states the outcome (`team restart: restarted <seat>; pane <old> -> <new>`, `team reload: <seat> reloaded`, `removed <name>` / `stopped <name>`, `<seat>: registered — pane <pane>…`, `Wrote .agents/team.yaml: …`, `session <session>: stopped and cleared`, or `<seat>: ready`), **that line is the closing summary line** in plain text and populates `action_summary` in `--json`. Do **not** append a second summary line below an existing outcome line.
  - `--dry-run`: `dry run: nothing was run` (or the command's existing single-line `would register…` summary on `register --dry-run`).

---

## 2. Quiet by Default

1. **Hide stopped seats by default**:
   - In `team status` and `team seats`, seats whose state is `stopped` are omitted from default output and included only when `--all` is passed.
2. **Collapse repeated notes with a count (`collapseNotes`, `renderNotes`)**:
   - Notes preserve **first-seen order**.
   - **Default (`collapseNotes(notes)`)**: exact duplicate note strings repeated $n > 1$ times collapse into a single line with a trailing `(x<n>)` count:
     ```text
     note: this team's file declares no account, so nothing is counted (x17)
     ```
   - **Multi-seat grouping (`collapseNotes(notes, { groupSeats: true })`)**: when a command opts into multi-seat grouping, per-seat notes of the form `<seat>: <reason>` that share the same `<reason>` across $n > 1$ distinct seats collapse into `<seat1>, <seat2>: <reason> (<n> seats)`. Duplicate `(seat, reason)` pairs are deduplicated *before* grouping so a repeated seat note never turns `<reason>` into `<reason> (x2)` or prevents grouping.
   - **Reserved singleton prefixes (`RESERVED_NOTE_PREFIXES`)**: notes starting with `watch:`, `hold:`, `hold until `, or `proc <name>:` are never treated as seat names by `groupSeats: true`.
3. **`what 0.5.0 must not pretend` only in `team doctor` and `team --about`**:
   - The `NOT_PRETENDED` block (`src/permissions/must-not-pretend.ts`) and its first line (`INTEGRITY_NOT_AUTHORITY`: `The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.`) are printed in plain words (without Kernel terms) **only** in:
     1. `team doctor` (at the end of the full report; omitted under `team doctor --login`), and
     2. `team --about` (after `team <version> — <description>`, `licence: <license>`, and `docs: <homepage>`).
   - Under `--json` (`team doctor --json` on full runs and `team --about --json`), `must_not_pretend` carries each plain sentence (`text`) alongside its Kernel section reference (`ref`):
     | # | Plain sentence (`text` in `--json`, human output) | Kernel reference (`ref` in `--json`) |
     |---|---|---|
     | 1 | `The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.` | `Kernel §11, §12, §14` |
     | 2 | `A right given to a team or a seat stands until it is revoked, and may carry an end date; a seat cannot lend a right to another seat for a task and take it back when the task is done.` | `Kernel §7, §10, §14, §15 (standing grant vs lease; liveness walk)` |
     | 3 | `Three ways of sharing control are not built yet — a grant co-signed by a second person, a seat approving an identical copy of another seat, and an agent creating a team within pre-set limits — so only the owner grants rights and adds seats.` | ``Kernel §9, §10 (two-granter agreement, `agree`, `create`)`` |
     | 4 | `Four things are not checked yet: which project files a seat may see, acting under an account the owner holds — GitHub, Linear, email — using the broker, and deploying a release.` | ``Kernel §3, §14 (`read` scope, `act-as`, `use-broker`, `deploy`)`` |
     | 5 | `Apart from one lead seat per team and no seat starting with two exclusive rights, nothing else about how a team is put together is enforced: no limit on how many seats hold a right, no rule that a change is merged by a different seat from the one that wrote it, and no rule that a reviewer comes from another lab.` | `Kernel §5, §9 (cardinality, mutual exclusion, separation of duties, cross-lab review)` |
   - Routine operational commands (`team status` and `team check`) do **not** print `NOT_PRETENDED`, `INTEGRITY_NOT_AUTHORITY`, or `not known: work sent and unread…` on every invocation.
4. **Deprecation warnings only in `team check` (and `team doctor`), with the repair command (`formatDeprecationWarning`)**:
   - Schema/field deprecation warnings (such as `coordinator:` → `leads: true`) are emitted **only** in `team check` (and `team doctor`'s `warn` findings), never on stderr during `team status`, `team seats`, `team list`, `team usage`, or action commands.
   - Every deprecation warning uses `formatDeprecationWarning({ line, message, repair })`:
     ```text
     warning: the file, line 5: `coordinator:` is now `leads: true` on the lead's seat, and is still read; repair: set `leads: true` on the lead's seat and remove `coordinator:` from .agents/team.yaml
     ```

---

## 3. Terminal Colour (`ttyStyle` and `NO_COLOR`)

1. **TTY and `NO_COLOR` gate (`ttyStyle(source?, opts?)` in `src/output/tty.ts`)**:
   - ANSI escape sequences are emitted **only** when:
     - `--json` is **not** active (`opts?.json !== true` and `source.json !== true`),
     - `io.env.NO_COLOR` is `undefined` or `""` (per [no-color.org](https://no-color.org/)), and
     - the target stream is an interactive terminal (`io.stdoutIsTTY === true` when `opts?.stream ?? 'stdout'` is `'stdout'`, or `io.stderrIsTTY === true` when `opts?.stream === 'stderr'`).
   - Whenever any of those conditions is false, `ttyStyle` returns `PLAIN_STYLE` (`enabled: false`), where every styling method is an identity function returning the uncoloured string byte-for-byte.
2. **Single state/severity colour mapping (`style.styleState(state)`)**:
   - All state cells and diagnostic severity labels use `style.styleState(state)` in `src/output/tty.ts`:
     - **Bold** (`\x1b[1m…\x1b[22m`): table column header rows (`renderTable`).
     - **Green** (`\x1b[32m…\x1b[39m`): `'working'`, `'idle'`, `'done'`, `'ok'`, `'working, temporary'`, `'idle, temporary'`, `'done, temporary'`.
     - **Yellow** (`\x1b[33m…\x1b[39m`): `'warn'`, strings starting with `'waiting'`, `'trust sent'` or `'blocked: quota'`, strings containing `'(unsent text)'`, `'(rate limit'` or `'(screen not recognised)'`, and strings ending with `', parked'`.
     - **Red** (`\x1b[31m…\x1b[39m`): `'missing'`, `'wrong name'`, `'miss'`, `'MISS'`, strings starting with `'restored, not launched by team'`, and strings containing `'(blind)'`.
     - **Dim** (`\x1b[2m…\x1b[22m`): `'stopped'`, `'-'`, `'--'`.
   - In `renderDifference(diff, style)`, **only** the `difference:` label prefix is coloured red (`style.red('difference:')`); `<what>`, `  repair: <repair>`, and `  who: <who>` remain uncoloured plain text so repair commands can be copied without ANSI codes.
3. **Padding before styling**:
   - `renderTable` computes column widths and applies `.padEnd(width)` on `plainLine`-cleaned strings *before* calling `style.bold` or `spec.styleCell`, so `stripAnsi(coloured)` is always identical to the non-TTY output.

---

## 4. Exit Codes, Refusal Rules, and `--help`

1. **Authoritative contract (`contract/exit-codes.json`)**:
   - `contract/exit-codes.json` (622 rows across the 50 command names, verified by `bun scripts/exit-codes.ts --check` and `test/exit-codes.test.ts`) is the single source of truth.
   - Standard convention across commands:
     - `0`: work finished, reading agrees with the file, or `--dry-run` plan printed.
     - `1`: differences/findings found, caller/policy/lock gate refused, or runtime step failed.
     - `2`: bad CLI invocation (unknown flag, missing argument), unreadable/invalid `.agents/team.yaml`, not inside a git repository, or `herdr` unreachable (where the contract row specifies `2`).
   - **Documented contract exceptions (pinned in `contract/exit-codes.json`)**:
     - `release`: returns `0` (all checks pass), `1` (a check is missing), `2` (`release.unknown` — unknown check name), and `64` (`release.configuration`, `release.usage` — unreadable team file or bad invocation).
     - `list` and `usage`: return only `0` and `2` (no exit `1` rows).
     - `messages`, `issues`, `next`, `plan`, `broker`: put unreadable/invalid team file (`*.file`) on exit `1` and bad invocation / not-a-repo (`*.invocation`, `*.not-a-repo`) on exit `2`.
     - `check`, `status`, `seats`, `proc`: put `*.not-yours` (and `*.herdr` on `check`, `status`, `seats`, `down`) on exit `2`, whereas `add.caller`, `down.caller`, `answer.caller` and `add.effort` / `add.model` / `add.seat-name` / `add.locked` follow their respective `1` or `2` rows in `contract/exit-codes.json`.
2. **Permission gate rule IDs and unified owner-only refusal wording**:
   - **Preserving the resolver's rule ID (`PermissionRule` in `src/permissions/resolve.ts`)**: `gateVerdict` (`src/permissions/who.ts`) currently collapses `resolvePermission` / `resolveCaller` into `{ kind: 'refused' }`, dropping `decision.rule` (`'no-record'`, `'unreadable'`, `'unplaced'`, `'not-in-map'`, `'owner-only'`, `'owner-or-leads'`, `'owner-or-own-team'`, `'team-change'`, `'team-read'`, `'terminal'`, `'absent'`, `'outside-envelope'`, `'outside-scope'`, `'other-team'`, `'admission'`, `'pane-authority'`) and `decision.why`. Command gates that reject a caller must preserve `decision.rule` and `decision.why` from `resolveCaller` / `resolvePermission` so the CLI refusal names the rule and `--json` carries it on the error envelope (`error.rule`, or `error.id` when the gate row is the permission rule).
   - **Single canonical owner-only refusal wording**: across all owner-only commands and flags (`init`, `grant`, `revoke`, `delegate`, `tempo`, `--file`, `--session`, and `add`), use the single canonical sentence:
     - `only the owner runs this, from a terminal outside herdr; this call is <caller>`
     - When a command also admits a delegate standing grant (`add`, `down`, `remove`), use: `only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is <caller>` (replacing `add`'s divergent `runs it;` wording).
3. **Per-command `--help` exit line and `--json --help` precedence**:
   - Every command's `export const USAGE` in `src/commands/<command>.ts` must end with the `Exits …` footer sentence from the matrix in §1.1 (derived from `contract/exit-codes.json`).
   - **`--help` / `-h` under `--json`**: `--help` and `-h` always win before any command logic or `--json` mode. `team <command> --json --help` (in either flag order) prints the plain-text `USAGE` to `stdout` and exits `0`; it never emits a JSON document.
   - **AST constraint (`scripts/contract.ts`)**: `export const USAGE` in `src/commands/<command>.ts` **must** remain a single static string literal or no-substitution template literal (no `${…}` interpolation and no function calls) so `bun run contract:check` can extract it from the TypeScript AST. Use `formatHelpExits` only in tests or dynamic generators.

---

## 5. JSON Contract (`--json`)

### 5.1 Envelope and Schema Version (`jsonEnvelope`, `writeJson`)

Every command that supports `--json` writes a single UTF-8 JSON object (pretty-printed with 2-space indentation and a trailing `\n`) to `stdout` via `writeJson(io, schemaName, payload, version)`.

Every `--json` document carries a top-level `schema` tag as its first key (`jsonEnvelope` strips any accidental `schema` key from `payload` so the envelope's `schema` tag can never be overwritten):

```json
{
  "schema": {
    "name": "team.<command>",
    "version": 1
  }
}
```

- Sub-modes use dotted names: e.g., `team.status.project` for `team status --project <name> --json`, `team.send.list` for `team send --list --json`.
- **Field-name stability and scoping**:
  - Top-level envelope keys are stable: `schema`, `format`, `project`, `session`, `rows` / `seats` / `findings`, `notes`, `differences`, `summary` (object `{ differences, owner_differences }` on reading envelopes), `action_summary` (string on action envelopes), `notice`.
  - Per-command row shapes are scoped by `schema.name`:
    - In `team.status`, each item in `rows` carries `state` (the comparison phrase, e.g. `"working"`, `"missing"`, `"stopped"` under `--all`) plus `seat_state` and `seat_state_source` (from `src/labels/state.ts`, where a stopped seat under `--all` carries `seat_state: "done", seat_state_source: "process"`).
    - In `team.seats`, each item in `seats` carries `status` (the comparison phrase) plus `state` and `state_source`.

### 5.2 Reading Envelopes (`team.status` Pilot Example)

```json
{
  "schema": {
    "name": "team.status",
    "version": 1
  },
  "format": 1,
  "project": "beacon",
  "session": "beacon",
  "rows": [
    {
      "name": "claude-keeper",
      "state": "working",
      "model": "Claude Opus 5.5",
      "pane": "w1:p1",
      "seat_state": "working",
      "seat_state_source": "cli"
    }
  ],
  "notes": [
    "watch: pane w9:p1, pid 4242, last heartbeat 0s ago"
  ],
  "differences": [
    {
      "what": "claude-beacon is in the file and is not running",
      "repair": "team add claude-beacon",
      "who": "the owner"
    }
  ],
  "summary": {
    "differences": 1,
    "owner_differences": 0
  },
  "notice": null
}
```

### 5.3 Structured Errors Under `--json` (`jsonError`, `writeJsonError`)

When a command fails (exit code `1`, `2`, or `64`) while `--json` is passed, it writes a structured error envelope (`schema/error.schema.json`) to `stdout` via `writeJsonError(io, id, message, repair, version, rule, notice)` (with `stderr` empty) and exits with the contract exit code:

```json
{
  "schema": {
    "name": "team.error",
    "version": 1
  },
  "error": {
    "id": "add.caller",
    "message": "only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is seat codex-acme",
    "repair": "an approved delegate runs `team add …` from its own pane when .agents/team.yaml names one; otherwise the owner runs it from this folder, at a terminal outside herdr",
    "rule": "owner-only"
  }
}
```

- `error.id` is the `contract/exit-codes.json` identifier (e.g. `"status.herdr"`, `"add.caller"`).
- **Distinguishing `<cmd>.file` from `<cmd>.file-invalid` (`isParseError` in `src/file/load.ts`)**: `loadTeamFile` sets `line: 0` on missing-file and repo-locate errors (`p.line !== undefined` is always true). Always use `isParseError(p)` (`p.line > 0`) from `src/file/load.ts`: map `errors.some((p) => p.message.includes('not inside a git repository'))` to `<cmd>.not-a-repo`, `errors.some(isParseError)` to `<cmd>.file-invalid`, and otherwise `<cmd>.file`.
- **Every failure under `--json` is enveloped (`hasJsonFlag(argv)`, `writeJsonError`)**: commands detect JSON mode from raw `argv` before parsing via `hasJsonFlag(argv)` (`argv.some((arg) => arg === '--json' || arg.startsWith('--json='))` in `src/output/json.ts`). A command that takes value options passes their names (`hasJsonFlag(argv, ['file'])`): an option's value is taken as given, whatever it looks like, so a `--json` that is some option's value (`team commits check --file --json`, naming a file called `--json`) is a path and does not select the JSON output — the rule `docs/commands/release.md` documents. Whenever `hasJsonFlag(argv)` is `true` (apart from `--help` / `-h`, which wins before `--json`), **every** error or refusal — including an unknown option before `--json` (`team <cmd> --nope --json`), a malformed `--json=<value>` (`team <cmd> --json=1`), flag conflicts such as `--json --watch` (`<cmd>.invocation`), or `team check` invocations that mix `--json` with unknown flags or positional words (`const forTheTeam = hasJsonFlag(argv) || spelledForTheTeam(argv)` so `--json` never flips `team check` back to the old 0.3.3 spelling) — must write the `team.error` JSON envelope to `stdout` with `stderr` empty; never guard `if (json)` with `&& !watching` or rely solely on `args.flags.has('json')` after an early parser return.
- `error.message` is the human-readable failure text (without the leading `team <command>: ` prefix).
- `error.repair` is the actionable repair string, or `null` when no automated repair command applies.
- `error.rule` (optional `string | null`) carries the permission resolver's `PermissionRule` (`'no-record'`, `'unreadable'`, `'unplaced'`, `'not-in-map'`, `'owner-only'`, `'owner-or-leads'`, `'owner-or-own-team'`, `'team-change'`, `'team-read'`, `'terminal'`, `'absent'`, `'outside-envelope'`, `'outside-scope'`, `'other-team'`, `'admission'`, `'pane-authority'`) whenever a caller/permission gate refuses the command.
- `notice` (optional top-level `string | null` on `team.error`) carries the load's fallback notice (e.g. `'team.yaml is invalid …; using the copy of <date>'`) whenever a refusal is decided after `currentTeam` fell back to a stored copy.
- **`team up`'s `deny` path under `--json`**: `up`'s unplaced/untrusted `deny` refusal exists specifically to disclose nothing about the team or file. Under `--json`, it writes `{ "schema": { "name": "team.error", "version": 1 }, "error": { "id": "up.deny", "message": "deny", "repair": null, "rule": "no-record" } }` on `stdout` (`stderr` empty, exit `1`), disclosing no team, seat, or path details beyond `"deny"` and `"no-record"`.
- **`--dry-run` refusals under `--json`**: when a `--dry-run` call hits an exit-1 or exit-2 refusal, `--json` writes the `team.error` envelope using the **exact `contract/exit-codes.json` row ID** for that refusal site (e.g. `up.dry-…` or `add.dry-…` where a dedicated dry-run exit ID exists, or the shared refusal ID such as `add.caller` when `dry` and real runs share that `// exit:` marker). When `--dry-run` exits `0` and includes `! <cmd> would refuse: …` / `! to unblock: …` lines inside the plan, it emits the normal `team.<command>` envelope with `dry_run: true` and those `!` steps in `plan`.

### 5.4 Action Results and `--dry-run` Plans (`ActionResultBase`, `PlanStep`, `buildActionSchemaSpec`)

Every action command (`up`, `down`, `add`, `remove`, `restart`, `reload`, `register`, `answer`, `init`, `grant`, `delegate`, `revoke`, `worktree`, `send`, `route`, `next`, `lock`, `unlock`, `tempo`, `hold`, `pause`, `resume`, `raise`, `proc`) shares `ActionResultBase` (`src/output/json.ts`) and `buildActionSchemaSpec` (`src/output/schema.ts`):

```json
{
  "schema": {
    "name": "team.add",
    "version": 1
  },
  "format": 1,
  "dry_run": true,
  "status": "dry-run",
  "action_summary": "dry run: nothing was run",
  "project": "beacon",
  "session": "beacon",
  "seat": "claude-beacon",
  "plan": [
    {
      "step": "workspace",
      "seat": "claude-beacon",
      "detail": "create worktree at ../worktrees/beacon/claude-beacon",
      "prefix": "+"
    },
    {
      "step": "launch",
      "seat": "claude-beacon",
      "detail": "claude --model claude-opus-5-5",
      "prefix": "+"
    }
  ]
}
```

- **Required base fields on every action `--json` document**:
  - `schema`: `{ name: "team.<command>", version: 1 }`
  - `format`: `1`
  - `dry_run`: `boolean` (`true` when `--dry-run` was passed, `false` on a real run)
  - `status`: command outcome word (e.g. `"ready"`, `"stopped"`, `"idle"`, `"wrote"`, `"restored"`, `"done"`, `"delivered"`, `"dry-run"`)
  - `action_summary`: the single closing summary line (e.g. `"dry run: nothing was run"` on `--dry-run`)
- **Optional base fields**:
  - `project`: `string | null` (present on team-scoped actions)
  - `session`: `string | null` (present on session-scoped actions)
  - `plan`: `PlanStep[]` (`{ step: string, detail: string, seat?: string | null, prefix?: "+" | "!" | "skip" }`, present when `dry_run: true`)
  - `notice`: `string | null` (fallback notice, e.g. when `team.yaml` is invalid and the last copy that validated is used)
- **Commands without `--dry-run` (`remove`, `reload`, `init`)**:
  - `remove`, `reload`, and `init` do **not** take `--dry-run`; no `--dry-run` flag or `plan` array is added to them (`dry_run` is always `false`, and `plan` is omitted).
  - `register --dry-run` has no multi-step plan today; its `plan` array under `--dry-run --json` contains a single `PlanStep` (`{ step: "register", seat, detail, prefix: "+" }`) whose `detail` is the line the real run would print.
- **Per-action command fields**:
  - `up`, `down`: `seats: string[]` (or per-seat objects), `plan?: PlanStep[]`
  - `add`, `remove`, `restart`, `reload`, `register`, `answer`: `seat: string` (or seat object), `pane?: string | null`, `plan?: PlanStep[]`
  - `init`: `file: string` (or `path: string`), `restored: boolean` (no `session`)
  - `grant`, `delegate`, `revoke`: `target: string`, `capabilities?: string[]`, `scope?: string[]`, `commands?: string[]`, `plan?: PlanStep[]`
  - `worktree`: `action: "new" | "remove"`, `task: string`, `branch?: string`, `path?: string`
  - `send`, `route`: `seat: string`, `channel?: string | null`, `ids?: { sent: string | null, reply: string | null }`, `address?: string | null`
  - `next`: `action: "claim" | "release" | "none"`, `task: { id: string, title: string } | null`
  - `lock`, `unlock`, `tempo`, `hold`, `proc`: `target?: string`, `value?: string | null`

### 5.5 Published JSON Schemas (`schema/` and `scripts/schema.ts`)

1. Every command's `--json` schema is defined as a `CommandSchemaSpec` (or via `buildActionSchemaSpec`) in `src/output/schema.ts`, added to `COMMAND_OUTPUT_SCHEMAS`, and written to `schema/<command>.schema.json`.
2. **Registration workflow for every family**:
   - Add the command's `CommandSchemaSpec` to `COMMAND_OUTPUT_SCHEMAS` in `src/output/schema.ts`.
   - Run `bun scripts/schema.ts --write` to generate `schema/<command>.schema.json`.
   - Run `bun scripts/schema.ts` (or `bun run schema:check`) to verify `schema/team.schema.json` and all registered output schemas in `schema/` are current.
   - Assert in the command's test file that its `--json` output passes `assertMatchesOutputSchema(doc, <COMMAND>_OUTPUT_SCHEMA)`.

---

## 6. Shared Module (`src/output/`) and Test Helpers (`test/helpers/output.ts`)

Every command must import its formatting and JSON helpers from `src/output/index.ts` rather than hand-rolling table padding, note deduplication, difference formatting, or JSON envelopes.

### 6.1 Exported Signatures in `src/output/index.ts`

```ts
// TTY colour (src/output/tty.ts)
export type TtySource =
  | (Pick<Io, 'stdoutIsTTY' | 'stderrIsTTY' | 'env'> & { readonly json?: boolean })
  | boolean;
export interface TtyOptions {
  readonly stream?: 'stdout' | 'stderr';
  readonly json?: boolean;
}
export function ttyStyle(source?: TtySource, opts?: TtyOptions): TtyStyle;

// Context lines and tables (src/output/text.ts)
export function contextLine(project: string, session: string): string;
export function projectContextLine(project: {
  name: string;
  id?: string | null;
  entity: string | null;
  lead?: string | null;
}): string;
export interface TableSpec {
  headers: readonly string[];
  rows: readonly (readonly (string | null | undefined)[])[];
  indent?: string; // defaults to '  '; pass '' for a column-0 top-level table
  style?: TtyStyle;
  styleCell?: (padded: string, rawCleaned: string, rowIndex: number, colIndex: number, style: TtyStyle) => string;
}
export function renderTable(spec: TableSpec): string[];
export function formatTable(spec: TableSpec): string;

// Notes, differences, who, and reading summaries (src/output/text.ts)
export const RESERVED_NOTE_PREFIXES: ReadonlySet<string>;
export interface CollapseNotesOptions {
  readonly groupSeats?: boolean;
}
export function collapseNotes(notes: readonly string[], opts?: CollapseNotesOptions): string[];
export function renderNotes(notes: readonly string[], opts?: CollapseNotesOptions): string[];

export const DIFFERENCE_WHO_VALUES: readonly ['the owner', "the team's lead", 'a grant holder', 'any seat'];
export type DifferenceWho = (typeof DIFFERENCE_WHO_VALUES)[number];
export function whoFromCommand(command: string): DifferenceWho;
export function whoOfDifference(diff: OutputDifference): DifferenceWho;
export function renderDifference(diff: OutputDifference, style?: TtyStyle): string[];
export function renderDifferences(diffs: readonly OutputDifference[], style?: TtyStyle): string[];
export function summaryCounts(diffs: readonly OutputDifference[]): DifferenceSummaryCounts;
export function renderSummary(diffs: readonly OutputDifference[]): string;

// Severity vocabulary, deprecation warnings, action plans, and --help exits (src/output/text.ts)
export const SEVERITY_LEVELS: readonly ['ok', 'warn', 'miss', 'note'];
export const SEVERITY_LABELS: Readonly<Record<SeverityLevel, string>>;
export function renderFinding(finding: OutputFinding, style?: TtyStyle): string;
export function formatDeprecationWarning(warning: DeprecationWarning): string;
export function renderDeprecationWarnings(warnings: readonly DeprecationWarning[]): string[];
export function renderPlanStep(item: PlanStep): string;
export function renderDryRunPlan(header: string | null, steps: readonly PlanStep[]): string[];
export function renderActionSummary(spec: ActionSummarySpec | string): string;
export function formatHelpExits(exits: readonly HelpExitSpec[]): string;

// JSON envelopes and structured errors (src/output/json.ts)
export function toJsonDifference(diff: OutputDifference): JsonDifference;
export function jsonEnvelope<T extends Record<string, unknown>>(schemaName: string, payload: T, version?: number): JsonEnvelope<T>;
export function writeJson<T extends Record<string, unknown>>(io: Pick<Io, 'stdout'>, schemaName: string, payload: T, version?: number): void;
export function jsonError(id: string, message: string, repair?: string | null, version?: number, rule?: string | null, notice?: string | null): JsonErrorEnvelope;
export function writeJsonError(io: Pick<Io, 'stdout'>, id: string, message: string, repair?: string | null, version?: number, rule?: string | null, notice?: string | null): void;

// JSON Schema builder and registry (src/output/schema.ts)
export function buildActionSchemaSpec(spec: ActionSchemaSpec): CommandSchemaSpec;
export function buildCommandOutputSchema(spec: CommandSchemaSpec): JsonSchema;
export function renderCommandOutputSchema(spec: CommandSchemaSpec): string;
export function publishCommandOutputSchema(rootDir: string, spec: CommandSchemaSpec, mode?: 'write' | 'check'): { ok: boolean; path: string; message?: string };
export const COMMAND_OUTPUT_SCHEMAS: readonly CommandSchemaSpec[];
```

### 6.2 Test Helpers (`test/helpers/output.ts`) and Golden Strategy

```ts
export function stripAnsi(text: string): string;
export function assertNoAnsi(text: string): void;
export function assertGoldenOutput(actual: string, expected: string | readonly string[], opts?: { tty?: boolean }): void;
export function validateAgainstJsonSchema(value: unknown, schema: JsonSchema, path?: string): string[];
export function assertMatchesOutputSchema<T = Record<string, unknown>>(rawJson: string, spec: CommandSchemaSpec | JsonSchema): T;
export function assertJsonErrorShape(rawJson: string, expected?: { id?: string; messageContains?: string; repair?: string | null }): { schema: { name: string; version: number }; error: { id: string; message: string; repair: string | null } };
```

**Where command goldens live and how layout changes update them**:
1. **Executable command reference pages (`docs/commands/<command>.md`)**: `test/docs.test.ts` executes every fenced `console` block in `docs/commands/*.md` byte-for-byte against the live commands. Any change to a command's plain or `--json` output **must** update its `docs/commands/<command>.md` page (and any cross-referencing page, such as `docs/commands/proc.md` for `team status`) in the **same commit**.
2. **Unit and golden tests (`test/<command>.test.ts` and `test/commands/<command>.test.ts`)**: pin plain output with `assertGoldenOutput(out, [...])`, non-TTY ANSI absence with `assertNoAnsi(out)`, and `--json` conformance with `assertMatchesOutputSchema(out, <COMMAND>_OUTPUT_SCHEMA)`.

---

## 7. Migration Families: Pages and Tests Touched

To keep `bun test` (including `test/docs.test.ts`) green at every commit, each conversion family updates its command implementation, its `COMMAND_OUTPUT_SCHEMAS` entry (`bun scripts/schema.ts --write`), its `docs/commands/*.md` executable pages, and its test files together:

| Family | Commands | `docs/commands/*.md` pages touched | Primary test files touched |
|---|---|---|---|
| **Pilot (done in this branch)** | `team status`, `team --about`, `team doctor` (`NOT_PRETENDED` block) | `docs/commands/status.md`, `docs/commands/proc.md`, `docs/commands/doctor.md`, `docs/reference/cli.md` | `test/output.test.ts`, `test/status.test.ts`, `test/status-reach.test.ts`, `test/must-not-pretend.test.ts`, `test/projects-command.test.ts`, `test/commands/slice3.test.ts`, `test/commands/doctor-models.test.ts`, `test/cli.test.ts` |
| **Family 1 — Checks & Diagnostics** | `check` (including set-aside `delivery_order` difference, `who:`, deprecations, and removing `NOT_PRETENDED`/`not known:`), `doctor`, `commits`, `pr`, `release` | `docs/commands/check.md`, `docs/commands/doctor.md`, `docs/commands/commits.md`, `docs/commands/pr.md`, `docs/commands/release.md` | `test/must-not-pretend.test.ts`, `test/check.test.ts`, `test/commands/check-*.test.ts`, `test/commands/doctor-*.test.ts`, `test/commits.test.ts`, `test/pr.test.ts`, `test/release/*.test.ts` |
| **Family 2 — Views & Listings** | `seats`, `list`, `usage`, `projects`, `mcp`, `proc list` | `docs/commands/seats.md`, `docs/commands/list.md`, `docs/commands/usage.md`, `docs/commands/projects.md`, `docs/commands/mcp.md`, `docs/commands/proc.md` | `test/commands/seats.test.ts`, `test/list.test.ts`, `test/usage.test.ts`, `test/projects-command.test.ts`, `test/commands/mcp.test.ts`, `test/proc.test.ts` |
| **Family 3 — Session & Seat Actions** | `up`, `down`, `add`, `remove`, `restart`, `reload`, `register`, `answer`, `watch` | `docs/commands/up.md`, `docs/commands/down.md`, `docs/commands/add.md`, `docs/commands/remove.md`, `docs/commands/restart.md`, `docs/commands/reload.md`, `docs/commands/register.md`, `docs/commands/answer.md`, `docs/commands/watch.md` | `test/commands/up*.test.ts`, `test/commands/down*.test.ts`, `test/commands/add*.test.ts`, `test/commands/remove*.test.ts`, `test/restart.test.ts`, `test/reload*.test.ts`, `test/register*.test.ts`, `test/answer.test.ts`, `test/watch.test.ts` |
| **Family 4 — Authority & Setup Actions** | `init`, `grant`, `delegate`, `revoke`, `hold`, `tempo`, `lock`, `unlock` | `docs/commands/init.md`, `docs/commands/grant.md`, `docs/commands/delegate.md`, `docs/commands/revoke.md`, `docs/commands/hold.md`, `docs/commands/tempo.md`, `docs/commands/lock.md`, `docs/commands/unlock.md` | `test/init.test.ts`, `test/grant*.test.ts`, `test/delegate.test.ts`, `test/revoke.test.ts`, `test/hold.test.ts`, `test/tempo.test.ts`, `test/lock.test.ts` |
| **Family 5 — Messaging, Worktrees & Tasks** | `send`, `route`, `feed`, `messages`, `issues`, `next`, `plan`, `worktree`, `ask-show`, `broker` | `docs/commands/send.md`, `docs/commands/route.md`, `docs/commands/feed.md`, `docs/commands/messages.md`, `docs/commands/issues.md`, `docs/commands/next.md`, `docs/commands/plan.md`, `docs/commands/worktree.md`, `docs/commands/ask-show.md`, `docs/commands/broker.md` | `test/send.test.ts`, `test/route.test.ts`, `test/feed.test.ts`, `test/messages.test.ts`, `test/issues.test.ts`, `test/next.test.ts`, `test/plan.test.ts`, `test/worktree.test.ts`, `test/ask-show.test.ts`, `test/broker.test.ts` |
