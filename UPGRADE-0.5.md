# Upgrading to 0.5.0

For a team running under 0.3.5, or under one of the 0.4.x builds between them.

1. `team doctor`. It checks this machine against the file and names whatever is missing.
2. `team up`. The file in your clone is the record, so nothing is approved by hand any more.
   Running seats keep working as they are; relaunch one with `team restart <seat>`, or the team —
   `team down`, then `team up`, typed as two commands, the second only after the first has
   returned — when you want it on this build.

## `team approve` is gone

The command is not in the CLI: `team approve` prints one line — `team approve was removed in
0.5.0: the live team file is the record, and nothing needs approving; see UPGRADE-0.5.md` — and
exits 2, and `team --help` carries no `approve` line. `team up` admits from the live file now: edit the
file in your clone, then run `up` — or `add`, `remove`, `down`, `restart`; each reads the file
itself. A script that guarded on `team approve` can drop that call.

The approved copy is gone with it. Every command reads the live file, and
[`team check`](https://github.com/floor/teamcli/blob/main/docs/commands/check.md) is integrity,
not authority: it reads the file, the state,
herdr, the registries and the agents' records, and reports the differences alone, each with its
repair — a reading of whether the records agree, never a grant. No approval, no launch and no
right follows from a clean answer, and the check writes nothing at all, for every caller, the
owner included.

## Caller gates are strict now

The file decides who may do what, a grant cannot widen its own entry, and `--file` and `--session`
stay the owner's, from a terminal outside herdr.

- **`team add`** — the owner, the file's delegate, or a caller an active create-grant names by
  its own registry agent id (`agt_` …) or its team's registry id. A delegate adds only a seat
  the file already declares, exactly as written; a different stanza is the owner's: an add that
  would write the file — clearing `stopped: true` — is refused for everyone else.
- **`team up`** — the owner or the team's lead seat, or a delegate entry naming `up`; a verified
  grant admits the orchestrator's seat where the map's row does not.
- **`team down`, `team restart` and `team remove`** — the owner, or the orchestrator's seat — and
  any seat the record marks a lead (the map's `leads`) — acting on another seat, never its own.
  `down` and `remove` also admit the file's delegate whose entry carries them; `restart`
  is not delegable. An operator the record does not mark a lead loses these unless a delegate
  entry carries `down` or `remove`.
- **`team grant` and `team revoke`** — the owner alone, from a terminal outside herdr, at both
  seat level and team level.

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

Who may send to whom is a rule table: a seat to its own team's orchestrator, a team's leads to its
own seats, a lead to another team's lead inside the same entity — cross-entity refused — an
owner-signed grant last — and a seat the file marks `assistant: true` is admitted to its entity's
main coordinator.

## What else is new

The registry and `team register` (a seat that is already running is written in without a relaunch),
projects, the live seat state in `team seats` and the sidebar labels beside each pane, and the work
queue. The full list is in
[CHANGELOG.md](https://github.com/floor/teamcli/blob/main/CHANGELOG.md), and the grouped summary
in the README's "What's new in 0.5.0".

How to tell it is done: `team doctor` ends `nothing missing` (a warning count may follow), and
`team check` answers `team check: nothing wrong` over the line naming what the check cannot see.
