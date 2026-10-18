# Upgrading to 0.5.0

For a team running under 0.3.5, or under one of the 0.4.x builds between them.

The install leaves your team as it is: the file stays byte for byte what it was, the 0.3.5 key,
approval record and log stay where they are, and the upgraded build reads all of it without
asking for a new approval. Silence about approval is that survival — no command below warns that
the approval is missing or has changed, and that silence is correct.

What changed is the step after editing the file. Approval is gone: the live file in your clone is
the record, `team check` reads it against what is running, and `team up` admits from it.

1. **`team check`**. It reads the file, the state, herdr, the registries and the agents' records,
   and reports the differences alone, each with its repair. What it finds depends on what is
   running; with the team not started yet, it answers:

   ```
   difference: orchestrator is in the file and is not running
     repair: team up
     who: the owner
   1 difference, 1 for the owner
   ```

   It exits 1 while a difference stands, and it carries the warnings for the deprecated keys
   listed below.
2. **`team doctor`**. It checks this machine against the file and names what is missing; a ready
   machine ends `team doctor: nothing missing` (a warning count may follow). Its closing block,
   `what 0.5.0 must not pretend`, is the plainest statement of what these controls are and are
   not — it says in as many words that only the owner grants rights and adds seats.
3. **`team up --dry-run`**. The plan is built from your file unchanged — its launch command,
   model, cwd and session — with no approval step and no legacy refusal. One change from 0.3.5
   shows here: the seat's workspace is created in the project, and its pane label reads
   `orchestrator · orchestrator` (0.3.5 used the lobby and `claude opus 0`). The plan's standing
   rules no longer name commands this build does not have.
   <!-- recheck at rc.6: the launch rules drop `team approve` -->
4. **`team up`**. The file in your clone is the record, so nothing is approved by hand any more.
   Running seats keep working as they are; relaunch one with `team restart <seat>`, or the team —
   `team down`, then `team up`, typed as two commands, the second only after the first has
   returned — when you want it on this build.
5. **`team seats`** and **`team status`**. Both read the upgraded team without asking anything:
   `seats` lists the old seat with its role, CLI and model, and `status` shows the same one
   difference as `team check`, with its `repair: team up`, until the team is up.

## `team approve` is gone

The command is not in the CLI. A typed `team approve` gets a line of its own saying the command
is gone, not the generic unknown-command answer, and exits 2.
<!-- recheck at rc.6: confirm the typed-approve wording -->
`team --help` carries no `approve` line. A fresh `team init` ends by naming `team up` as the next
command.
<!-- recheck at rc.6: confirm the init line -->

`team up` admits from the live file now: edit the file in your clone, then run `up` — or `add`,
`remove`, `down`, `restart`; each reads the file itself. A script that guarded on `team approve`
can drop that call.

The approved copy is gone with it. Every command reads the live file, and
[`team check`](https://github.com/floor/teamcli/blob/main/docs/commands/check.md) is integrity,
not authority: it reads the file, the state,
herdr, the registries and the agents' records, and reports the differences alone, each with its
repair — a reading of whether the records agree, never a grant. No approval, no launch and no
right follows from a clean answer, and the check writes nothing at all, for every caller, the
owner included.

## Grants replace approval

`grant`, `delegate` and `revoke` are in the command list where 0.3.5 had approval and trust. The
owner runs them from a terminal outside herdr — no seat can. Where 0.3.5 answered trust dialogs,
the replacement is the grant `team check` prints in its repair:
`team grant @team --capabilities dialogs.trust`; `team revoke` ends it. A right given to a team
or a seat stands until it is revoked and may carry an end date; the `what 0.5.0 must not pretend`
block in `team doctor` is the honest list of what those rights are not.

## The file itself

The file stays at `format: 1`, and the install does not rewrite it — header comment and schema
URL included. Only a file that `team init` writes now carries the new schema URL
(`floor/teamcli/v0.5.0` where 0.3.5 wrote `floor/team/v0.3.5`); no command reads it. A file
written by 0.3.5's own `init` already has `leads: true` and absolute trust entries, so a team that
never hand-edited its file has nothing to change here. The deprecated keys, and what to do with
each, are next.

## Messages you may meet, and what to do

Every finding `team check` prints carries its `repair:` on the same line, and every refusal names
its way out. These are the messages an upgrade produces most often; each has its what-to-do here
as well.

- **`` `dialogs:` is deprecated and grants nothing ``** (`team check` warns, once; `team doctor`
  notes it too). <!-- recheck at rc.6: doctor's dialogs note lands with the fix --> Remove
  `dialogs:` from the file. Trust answering is the owner's grant now: `team grant @team
  --capabilities dialogs.trust` turns it on and `team revoke` ends it.
- **`` `coordinator:` is now `leads: true` on the lead's seat, and is still read ``**
  (`team check` warns, with the repair; `team doctor` warns without it). Set `leads: true` on
  the lead's seat and remove `coordinator:` from the file. A seat's `role:` string —
  `coordinator`, `orchestrator` — is a label and stays as written; the lead is the seat
  `leads: true` marks.
- **`budgets.marks replaces watch.quota_marks`** (`team check` warns). Remove the old
  `watch.quota_marks` key and keep `budgets.marks`.
- **``team check: `team check` is now `team commits check`, and is still read through 0.3.3``**
  (on stderr; `team check --pr` says the same for `team pr check`). The invocation still runs,
  but the name is going: change the call in your scripts to `team commits check` — or
  `team pr check` for the pull-request half.
- **`seat "lead" does not hold leads …`** (`team check` notes). A file written before this
  release may declare a seat named `lead`. It still loads and answers its bare name, and
  `lead@<team>` now addresses the seat marked `leads: true`. Run `team rename lead <new-name>`
  to give it another name, before adding a seat or nickname called `lead` — that is refused.
- **`team status: this team is not yours to read`** (stderr, nothing on stdout, exit 2). The full
  read is the owner's at a terminal, a seat of that team on the pane the state records for it, a
  pane the file's `delegates` name, or a create-grant's holder whose record covers the root.
  A script or a CI job that parsed `team status` must handle exit 2 now.
- **`! up would refuse: …` then `! to unblock: …`** (a dry run says the same; a real run that
  denies prints `deny` and exits 1). Run the command the `to unblock` line names: it is the
  owner's run of this folder, the file's delegate entry, or the verified grant that admits the
  caller.
- **``! up would refuse: the file is legacy: migrate trust to absolute paths including the lobby …``**
  (`team up`; the dry run says the same). Paste the block the message prints into the file. It
  spells the lobby `~/.config/team/lobby` and gives the project's absolute path where the 0.3.5
  file said `.`:

  ```
  trust:
    - ~/.config/team/lobby
    - /absolute/path/to/your/project
  ```
- **`! add would refuse: …` then `! to unblock: …`** (`team add`). Same reading: the unblock line
  names what admits the add. A delegate adds only a seat the file already declares, exactly as
  written; any other add is the owner's.
- **`team send: <seat>: unreachable: <seat> is stopped`** (exit 1). The receiving file marks the
  seat `stopped: true`; nothing is typed into it. The owner brings it back with
  `team add <seat>`, which clears the mark, or edits the file.
- **`team send: … no agent record on this machine, so no rule admits the send …`**. The sender is
  running where the registry never recorded it. Run `team up`, or `team register <seat>` from
  the pane the seat already runs in, then send again.
- **`team send: … --wait …` refused.** Send without `--wait`. A Claude Code sender with its own
  cross-session tool takes the native leg instead: `team route <seat>` answers the address, and
  `team send --record <seat> --channel native --ms <n>` writes the delivery down.
- **A `team check` finding.** Each line carries its `repair:`; run it. The owner's
  `team check --repair` settles the leftovers the file alone can settle — the state's records a
  changed file no longer declares, a drifted sidebar label — and prints one `repaired:` line per
  write. It never starts, stops or relaunches a seat, and it waits on the live read.
- **`team doctor` names something missing.** Follow its line; a ready machine ends `team doctor:
  nothing missing` (a warning count may follow).

## Caller gates are strict now

The file decides who may do what, a grant cannot widen its own entry, and `--file` and `--session`
stay the owner's, from a terminal outside herdr.

- **`team add`** — the owner, the file's delegate, or a caller an active create-grant names by
  its own registry agent id or its team's registry id. A delegate adds only a seat the file
  already declares, exactly as written; a different stanza is the owner's: an add that would
  write the file — clearing `stopped: true` — is refused for everyone else.
- **`team up`** — the owner or the team's lead seat, or a delegate entry naming `up`; a verified
  grant admits the orchestrator's seat where the map's row does not.
- **`team down`, `team restart` and `team remove`** — the owner, or the orchestrator's seat — and
  any seat the record marks a lead (the map's `leads`) — acting on another seat, never its own.
  `down` and `remove` also admit the file's delegate whose entry carries them; `restart`
  is not delegable. An operator the record does not mark a lead loses these unless a delegate
  entry carries `down` or `remove`.
- **`team grant`, `team delegate` and `team revoke`** — the owner alone, from a terminal outside
  herdr, at both seat level and team level.

## A send says how it ended, and takes the channel it names

[`team send`](https://github.com/floor/teamcli/blob/main/docs/commands/send.md) writes the body
whole to a mode-0600 drop file and types one
short trigger line — for every seat, Claude Code's included; the body is never split. A seat
whose CLI builds its own work item from its screens (a profile with a compose module) still gets
the drop file, and the body is typed through those screens instead of a trigger line. Every run ends in one word: `delivered`, `answered`, `held`, `not-submitted`, `timeout`,
`unreachable` or `refused`. No path opens a cross-session socket in this build: `--wait` is
refused for every seat and nothing is written — a Claude Code seat's refusal names the native leg
(`team route` and the caller's own `SendMessage`) that will carry a waited send, and any other seat
gets its own reason.

A delivery can also be the sender's own, through the native channel:
[`team route <seat>`](https://github.com/floor/teamcli/blob/main/docs/commands/route.md) answers
the address, the sender (a Claude Code seat, with its own cross-session tool) delivers itself, and
`team send --record <seat> --channel native --ms <n>` writes that delivery down — one history
line, `via native`, the body not passing through this CLI.

A held or not-submitted send is retried by a running watch: the pending record beside the drop
file is delivered on a later pass when the pane is idle or done and its composer is free, bounded
to three tries within thirty minutes. A give-up names the sender and the recipient, says why,
points at the drop file while it is still there, and asks the sender to send it again.

Who may send to whom is a rule table: a seat to its own team's orchestrator, a team's leads to its
own seats, a lead to another team's lead inside the same entity — cross-entity refused — an
owner-signed grant last — and a seat the file marks `assistant: true` is admitted to its entity's
main coordinator.

## What else is new

The registry and `team register` (a seat that is already running is written in without a relaunch),
projects, the live seat state in `team seats` and the sidebar labels beside each pane, and the work
queue. The output is one contract now, with `--json` documents whose `schema` field comes first
and refusals that carry the exit id and the repair — a script that parsed the plain text should
be checked, and `team --about` prints the version, the licence and the docs link. The full list is
in [CHANGELOG.md](https://github.com/floor/teamcli/blob/main/CHANGELOG.md), and the grouped summary
in the README's "What's new in 0.5.0".

How to tell it is done: `team doctor` ends `team doctor: nothing missing` (a warning count may
follow), and `team check` closes its report with `no differences` — or names the count, and how
many of them are the owner's.
