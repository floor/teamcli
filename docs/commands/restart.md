# team restart

Restarts one declared seat in place without editing the team's configuration: prints the seat's input-box,
turn and context facts, asks a free seat to exit and waits for its pane to return to its shell,
closes its workspace, and launches the seat again in a fresh workspace. A seat that is busy —
working, blocked at a prompt, at its own exit question, or holding unsent text — is left as it is
unless `--abandon` is given. Unsent text is the exception: an idle seat holding it is restarted,
its text copied under the state folder before the close and pasted back into the new pane's box
as soon as the seat's prompt is ready. An unsent box is copied only when it draws one row: a box
drawn over more than one row cannot be told from a one-line draft the composer word-wrapped, so
it is left as it is rather than pasted back with a break the person never typed. Where the CLI
has no measured input
keys, or the box cannot be copied faithfully (behind a paste chip, over more than one drawn row,
a row the reader cannot read),
the seat is left as it is. A screen the profile does not recognise is advice, not a block: when
herdr reports the seat idle or done, the workspace is closed without typing into it, and the run
says the screen was not read. A seat whose profile says herdr cannot report it
(`herdr_status: unreliable`) is free when its own screen reads idle, and it is stopped on its
profile's exit key there.

Before anything is typed into the relaunched seat, the run delivers the general seat brief: the
session's `briefs` records a fresh incarnation and runtime epoch, the brief's sha256 and the
record's expected id, and the signed drop is posted at exactly that id. The relaunch's turn-start
reader names the claim's epoch (`team drops --read --epoch <run_id>`), so the process that just
stopped — a reader started under the old epoch — cannot satisfy the new claim. The run also
delivers to every other live or human declared seat, without touching their panes. A name held at
the expected id by another file, a link or a folder is
refused, never replaced or followed — [`team brief rollout --apply`](brief.md) recovers that
delivery at the claim's next attempt. A delivery that cannot be written is said and logged, and
the restart goes on; [`team check`](check.md) names the seat.

A restarted seat's fresh workspace sits at the sidebar's end; the automatic order pass then
runs on its own when the out-of-order tail is idle, or this command's answer carries its one
hint line — [`team order`](order.md) says how the pass decides, and how the sidebar policy's
manage word silences it.

## After a restore

The team a restart reads is proven by one of three authorities, in order: the team this session
was launched from, when the record names one; the team this folder holds; and the team the
registry records for this session. Only when none of them declares the seat is it refused as
undeclared. A fallback says so once, naming the place it read:

    note: <seat> is not in the team this session was launched from; reading the team this folder holds (<path>)
    note: <seat> is not in the team this session was launched from; reading the team registered for session <session> (<root>)

The note is on stderr in a real run, `! ` on stdout in a dry run, and `notes` in `--json`. A
`--file` names one file and never falls back; a team that fails to load keeps the configuration
refusal it always gave. For the registry authority, a `--session` must be carried by exactly one
record: two records carrying it prove nothing and the seat is refused as before, while a lone
record that cannot be read keeps the load refusal. With no session to name, the caller's own
placement narrows the candidates, and the record alone never picks a team.

A seat the terminal host restored is re-tied by [`team up`](up.md#a-seat-the-terminal-host-restored),
not restarted; [`team check`](check.md#seats-the-terminal-host-restored) names that repair for
the panes it finds. A pane whose name the host cleared is not restart's to take: restart treats a
restored process as the same seat only while the host still names the seat on its recorded pane,
and `--abandon` replaces what is in that pane only under the same name.

## Synopsis

    team restart <seat> [--abandon] [--fresh] [--resume <cli-session-id>] [--dry-run] [--session <name>] [--file <path>] [--json]
    team restart <seat> --client <grant-file> --key <client-key> [--team <team>] [--dry-run] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--abandon` | — | close the workspace of a stuck seat without typing into its pane, and replace a `replaced` pane herdr still names as the seat; a seat caller cannot abandon a `working` seat or a lead seat |
| `--fresh` | — | start a new conversation instead of resuming the recorded one; a launch line that itself names a conversation is refused, and a seat mid-turn is left as it is |
| `--resume` | `<cli-session-id>` | pin which recorded conversation of the seat to resume instead of the latest; refused for a foreign or unbound id, or beside `--fresh` or `--abandon` |
| `--dry-run` | — | check the seat and print the stop and launch plan without touching the session |
| `--session` | `<name>` | the herdr session, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | deprecated: a legacy team file to read instead of the team's registry record; the owner's alone |
| `--client` | `<grant-file>` | the client form: an owner-signed manager bundle grant that carries `restart`, see [A client's restart](#a-clients-restart) |
| `--key` | `<client-key>` | the client's private key file; required with `--client`, refused without it |
| `--team` | `<team>` | with `--client`, the team the grant is for, so the run can be made from outside its folder |
| `--json` | — | one `team.restart` document instead of the working lines; a refusal is the `team.error` document on stdout, with stderr empty |
| `--help`, `-h` | — | the usage, and exit 0 |

## A client's restart

A client with no terminal that the owner signed a **manager** bundle grant for (see [Client grant bundles](../concepts/client-grant-bundles.md#the-manager-bundle)) restarts a seat of that
one team with `team restart <seat> --client <grant-file> --key <client-key>`. The grant is verified whole before
any gate, and again under the grant lock before the first effect; it must carry `restart` and name exactly this
team. The run is the second door past the placement and who-may-run-it gates, never the owner's: `--abandon`,
`--fresh`, `--file` and `--session` are refused with `--client` (exit 2), and the run is logged as
`client-restart-authorized: …`. A refusal is `restart.client-refused` (exit 1). Every other refusal of a restart
(a seat that is not declared, signed off, working, a human's pane) stands.

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr; `--session` and `--file` are the owner's own |
| a run with no terminal | nothing: ``team restart: only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane`` |
| the orchestrator's seat — and any seat the record marks a lead: the map's `leads` | restart another declared seat; never its own recorded pane, never `--abandon` on the orchestrator's or the operator's seat, and never `--abandon` on a `working` seat |
| the entity's main orchestrator: the lead seat of the team whose project is the entity itself | restart any declared seat of the entity's teams, as that team's own lead does — the proof is its head team's record, live file and recorded pane, never its seat name; it still never restarts a seat on the pane this call stands on |

A seat the record stops (`stopped: true`, as `team remove --keep` leaves one) is signed off: `team up` keeps
leaving it out, and the owner, a `leads` seat of that seat's own team, or the entity's main orchestrator
standing as that team's lead brings it back with `team restart <seat>`, which clears the mark in the same
write that records the launch, then relaunches it. A launch that does not reach ready puts the mark back, so
a failed restart leaves the seat stopped.

The main orchestrator's proof is read whole from its head team's own records: that team's registry record
must name the entity as both its project and its entity, its live file must still name that entity and
resolve its lead — the legacy `coordinator:` key or `leads: true` on the seat, either spelling — and the
caller must be placed on that lead's recorded pane in that team's own session. A head team whose live file
cannot be read, a record naming another entity, or a caller the placement does not put on that recorded pane
proves nothing, and the run is judged by this team's map alone. This proof never falls back to a roster
`leads` mark: send admission accepts one, a restart's reach does not.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the seat was restarted | the three pre-close facts, `<seat>: stopped`, the launch record, `<seat>: unsent text pasted back` when the box held unsent text, and `team restart: restarted <seat>; pane <old-pane> -> <new-pane>` | 0 |
| the seat was restarted on a managed Codex endpoint that held exactly one thread | the same lines, with no `pull-only`; the log says `<seat>: its Codex endpoint holds thread <id>; bound as the seat's session` | 0 |
| the seat was restarted, and its native route cannot address it | the same lines, with the closing one ending `; pull-only: <reason>` — no agent record binds the seat, or, for a CLI whose runtime is addressed by the conversation it holds, no conversation is proven; the seat stands, and only pull reaches it | 0 |

The conversation a managed Codex seat's runtime queue is addressed by belongs to the endpoint its
launch started, not to the pane: a fresh pane reports no thread, and the launch starts a new
conversation. After the new pane is ready, the restart therefore asks that recorded endpoint which
threads it holds and, when exactly one is loaded, binds it as the seat's conversation in both the
seat state and its agent record. It never waits for the pane to report the thread. The endpoint is
read only when it is provably the seat's own: recorded under the seat's current presence
incarnation at the socket path that incarnation's launch owns, and not recorded by any other live
seat — an endpoint belonging to another seat, or one two seats both name, is not read at all. Both
records are then written only while they still show the incarnation, endpoint, thread and agent
record the read was made against: a seat that relaunched in between keeps its own records, and a
conversation another writer recorded — or cleared — first is never replaced. An endpoint that holds no thread yet,
holds more than one, or does not answer proves nothing: the records are left as they were, the
closing line says `pull-only`, and the log names what the read proved instead
(`<seat>: no thread was bound from its Codex endpoint (<reason>)`).
| `--dry-run` succeeded | the stop line and the launch plan | 0 |
| the run was refused, or the seat was left behind | `team restart: <reason>` | 1 |
| the invocation or the team file can't be read | `team restart: <problem>` and the usage | 2 |

`--json` prints one `team.restart` document instead: `project`, `session`, `seat`, the new `pane`,
the working lines (the pre-close facts and the stop's own lines) as collapsed `notes`, and the
closing line as `action_summary`; `dry_run` is `false` and `status` is `ready`, and `pull_only`
carries the reason when the seat's native route cannot address it — no agent record binding it,
or no recorded conversation for a CLI whose runtime is addressed by one. With `--dry-run` it
prints the plan as `plan` — the stop step first, then one step per launch plan line, `prefix` `+`,
`!` or `skip` — with `dry_run` `true` and `status` `dry-run`. A refusal under `--json` prints the
`team.error` document on stdout — its `id` is the contract row for that refusal (`restart.unknown`,
`restart.caller`, …) — and nothing on stderr.

## Example

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

workspace:
  mode: shared

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: claude-reviewer
    label: reviewer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

```fixture
agents: all
```

A seat mid-turn is not interrupted — its work would be lost — and `restart` says which state it was
in. If the pane host restored the process under a new pid, `restart` treats it as the same seat only
when herdr still names that seat on the recorded pane and the live conversation id matches the
agent registry's recorded `reach.agent_session`. The registry record is the proof on its own: a
state file written before the id was recorded is no bar to recognizing the seat, and no bar to
resuming it either. The seat is then relaunched with that recorded conversation through its
launch line — Claude Code as `--resume <id>`, Codex as its own subcommand, `codex … resume
<id>`, Antigravity as `--conversation=<id>` appended to the seat's launch line, Grok as
`-r <id>` appended to the seat's launch line. A line that runs the CLI inside a quoted script
takes the resume inside that script, where the CLI reads it; a word after the closing quote
never reaches it. A CLI with no measured resume form is left as it is unless the caller starts a new
conversation with `--fresh` or abandons the recorded one with `--abandon`; a state that names
another id is relaunched without one, and a
conversation that differs or cannot be read remains refused (`<seat> has a process in its old
pane that is not the signed seat; left as it is`, exit 1).

The pre-close context line says what happens to that conversation: when the launch carries it, the
line names the line the relaunch runs and says it resumes the recorded conversation `<id>`; when it
carries none, the line says why — no recorded conversation, the refusal's own reason, a resume
dropped before the launch, or the caller's `--fresh` or `--abandon`.

`--fresh` asks for a new conversation: the recorded one is not resumed, the launch runs without a
resume argument, and the id the new pane reports becomes the seat's recorded conversation, so the
next default restart resumes it. A `leads` seat runs it as it runs any restart, and the caller is
not asked anything first. It decides the conversation only: a working seat, a stuck pane and every
other pane refusal stand exactly as they do for a plain restart, and `--abandon` remains the flag
that replaces a stuck pane.

A launch line that itself names a conversation — another id, `--last`, or a resume with no id —
is never run: the repair is refused before the stop, and neither `--fresh` nor `--abandon` starts
it fresh either, because that line would run the same selection. Clear the selection from the
seat's launch line for a fresh start.

That refusal's `--json` `repair` names `team restart <seat> --abandon` when herdr still names
the seat on the recorded pane. With the flag the run closes that pane's workspace without typing
into it — the conversation there is not this run's to answer — and launches the seat again in a
fresh workspace. A pane herdr does not name as the seat is refused with or without the flag.

```console screens="claude-beacon=working"
$ team restart claude-beacon ; echo "exit $?"
team restart: claude-beacon is working; left as it is
exit 1
```

Design and behaviour: [docs/design/restart.md](../design/restart.md).
