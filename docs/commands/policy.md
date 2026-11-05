# team policy

Reads and resolves the effective policies for the current team (or a named seat) across the
tighten-only inheritance chain (`entity → project → team → seat`), or sets and unsets owner-signed
policy declarations (`team policy set` and `team policy unset`).

## Synopsis

    team policy [--seat <name>] [--file <path>] [--json]
    team policy set <level> <name> <value> [--until <iso>] [--kind <enforced|advised>] [--entity <id>] [--project <id>] [--seat <name>] [--file <path>] [--dry-run] [--json]
    team policy unset <level> <name> [--entity <id>] [--project <id>] [--seat <name>] [--file <path>] [--dry-run] [--json]

`<level>` is one of `entity`, `project`, `team`, or `seat` (or `seat:<name>`).
Every enforced policy comes from the release catalogue (`dev-mode`, `seats-cross-teams`,
`state-trace-window-seconds`, `state-blind-after-seconds`, `state-hook-working-seconds`,
`liveness-idle-lead-seconds`, `liveness-idle-owner-seconds`, `delivery-order`,
`brief-transport`,
`event-thread-ttl-seconds`, `event-thread-cap`, `event-retention-days`,
`event-held-threshold-seconds`, `event-unreachable-threshold-seconds`,
`event-idle-threshold-seconds`, `event-reconcile-interval-seconds`, `model-rule`,
`swap-wait-seconds`, `watch-read-budget-ms`, `watch-read-timeout-ms`, `webhook-sender-deadline-ms`,
`client-bundles`,
`client-grant-max-duration`, `daemon.fallback-backlog-above`, `daemon.fallback-backlog-limit`,
`daemon.chores`, `daemon.chores-slice-ms`, `daemon.chores-missed-beats`,
`daemon.chores-backoff-cap-ms`, `daemon.heartbeat`, `actions-commands`).
Inheritance tightens only: a lower level that loosens a higher level is refused at load and before
writing, naming both levels. Where no level sets a value, the release default applies (`off` for
gate-lifting policies); an expired value counts as unset at its level.

`actions-commands` is which Actions commands the command guard allows. The default is
`rerun-failed`, `deploy` and `ci-pr-head`: `gh run rerun --failed`, `gh workflow run deploy.yml`,
and `gh workflow run ci.yml` with a ref. A lower level may only drop a command. Every other Actions
command is refused. So is an `api` path under `/actions` or `/dispatches`, an `api` call
whose method is POST, PUT, PATCH or DELETE (`-X` and `--method`; the last verb named is the one
that counts), and an `api` call that adds
`-f`, `--field`, `-F`, `--raw-field` or `--input` without an explicit GET. A graphql read stays
allowed, including a path that ends in `/graphql`. A graphql query that contains `mutation` is refused.

`client-grant-max-duration` is how long a new client grant may last: `7d`, `30d`, `90d` or `none` (no
end date) for every kind of grant, or per kind, `send=30d;up=90d;bundle=none`. Unset it is
`send=7d;up=90d;bundle=90d`, today's limits. Entity and project level only; a lower level may only
shorten (`none` is the loosest); a chain that cannot be verified refuses a new grant. It decides what
`team grant --client … --expires <ISO|never>` may sign. The owner sets it from a terminal:

    team policy set entity client-grant-max-duration send=365d --entity floor
    team policy set entity client-grant-max-duration send=none --entity floor
    team policy set project client-grant-max-duration send=30d --project <project-id>
    team policy unset entity client-grant-max-duration --entity floor

See [How long a client grant lasts](../concepts/client-grant-duration.md).

`daemon.fallback-backlog-above` and `daemon.fallback-backlog-limit` are the machine daemon's
fallback-store retirement knobs: above the first many eligible finished episodes, one retirement
pass takes up to the second instead of the steady 256, so a store that was never retired before
empties over a few passes. The defaults are 256 and 500. A higher threshold and a smaller bulk
limit are the tighter words. The daemon reads both for each hosted root; a chain that cannot be
read keeps the release defaults and says which word it could not read.

`daemon.heartbeat` (alias `daemon-heartbeat-seconds`) is the machine daemon's loop heartbeat, in
whole seconds from 1 to 60 — 5 by default: how often the daemon refreshes its state record
and probes its hosted endpoints. The fallback sweep rides the beat only under
`daemon.chores: inline`; otherwise it is the chores child's pass (below). The daemon reads it for each hosted root when it starts and again on its housekeeping
pass, and runs the shortest word any hosted root declares, so no hosted team loosens another's
beat; a longer beat has to be declared at a level every hosted checkout shares. A shorter beat is
the tighter word. `team daemon status` prints the beat it runs (`heartbeat <time> (every
<seconds>s)`). Where the sweep does ride the beat, a shorter beat makes a backlog stall more
often, not less.

`daemon.chores` decides where the machine daemon runs its heavy per-checkout chores: `per-root`
(the default) gives each hosted checkout its own supervised child, so one checkout's work never
shares a process with another's; `shared` runs one child for every checkout whose word is
`shared`, with a queue per checkout and a slice per turn in round robin, so one checkout's
backlog delays another's chores by a slice and never its socket or the daemon's beat; and
`inline` keeps the work on the daemon's own loop, exactly as before the isolation — the
rollback. Three limits bound a child:
`daemon.chores-slice-ms` (2000) is how long one slice of a pass runs before it yields to its
heartbeat, `daemon.chores-missed-beats` (2) is how many heartbeats it may miss before the daemon
ends and replaces it, and `daemon.chores-backoff-cap-ms` (30000) caps the doubling wait between
replacements. A shared group runs the tightest limits of its checkouts. Each child reports its own
resident size in every heartbeat, so the daemon's record and `team daemon status` say what one
child costs. The daemon reads all four for each hosted root; a chain that cannot be read keeps the
release defaults.

The seven `event-*` policies are the owner's event thresholds: how long an unanswered thread
stays open (72 hours by default), how many records a thread may hold (50), how many days the
event log keeps (30), when a held record reaches the lead (600 seconds), when a seat that watches
nothing reads `unreachable` (600 seconds), when an idle seat's lead is told (300 seconds), and how
often the bus reconciles (120 seconds). Each takes a whole number — seconds, or days for
`event-retention-days`, records for `event-thread-cap`; a seconds value may be written with an
`s` suffix. The three delay thresholds — `event-held-threshold-seconds`,
`event-unreachable-threshold-seconds` and `event-idle-threshold-seconds` — may only be shortened:
a value above the release default is refused, and so is a level's word that lengthens the one
above it. The shorter field spellings (`held_threshold_seconds`, `thread-ttl`, …) are accepted
and written back under the canonical name. `team bus` reads the held, retention and reconcile
numbers when it starts, and `team reply` reads the thread life and cap from the caller's chain.

`model-rule` is the entity's rule for which models may run on which seats, held as one line of
`;`-separated entries, `<seat|role|*>=<lab>+<lab>`. A seat name beats a role word, a role beats
`*`, and a seat no entry names may run any model; labs are vendor words as a seat writes
`vendor:`, and an entry whose words are all `!lab` refuses those labs instead of allowing them.
Only the entity may set it — `orchestrator=anthropic; architect=anthropic; *=!anthropic` is one
rule — and the watch and `team check` carry it out in every team of the entity.
`swap-wait-seconds` is how long a queued model swap may wait for its boundary: 1800 seconds
(30 minutes) when nothing declares it, a shorter word being the tighter one, and a broken seat
swaps at once.

The two `watch-read-*` policies bound one pass of the watch's reads. `watch-read-budget-ms` is
how long one pass may spend reading panes and the machine before the panes it did not reach are
left unread and read on the next pass; `watch-read-timeout-ms` is the longest one read may take
before its child process is killed. Both default to 2000 milliseconds, take a whole number of
milliseconds from 100 to 30000, and take the entity, project and team levels; a shorter value is
the tighter one. A chain that cannot be read leaves both defaults in force, and the watch holds
its automated work on the unreadable pace as it always does.

`webhook-sender-deadline-ms` is how long a send's own arrival post waits on the receiving seat's
webhook routine before the send reports the answer unknown: 3000 milliseconds when nothing
declares it, a whole number of milliseconds from 500 to 10000, and a shorter value is the tighter
one. It takes the entity, project and team levels. The post is a wake beside a record that is
already durable and staged for the bus and the seat's pull, so the bound never costs the message:
a post that outlives it is reported `unknown`, never `failed`, and its claim keeps the record from
being posted a second time. A chain that cannot be read leaves the default in force. The bus
delivery keeps the adapter's own budget — three attempts, five seconds each — and does not read
this value. `team status` and `team check` report a claim left `sent` when no bus serves the root
to finish it, and never count such a post as delivered.

`brief-transport` says how a general seat brief reaches its seat. `file`, the default, writes the
claim and the signed drop and nothing else; `message` sends the whole brief as a real send body
through the seat's own delivery legs, so its receipt, history line and outcome are an ordinary
send's; `memory` is an experiment no runtime in this build proves zero-persistence for, so a
`memory` policy delivers nothing, refuses every seat and every `team send --brief`, and falls
back to nothing. `message` is within `file`; `memory` is comparable only to itself. It takes the
entity, project and team levels.

Four advised words shape the rules every seat reads at launch; they lift no gate and grant no
power. `leads.pane-actions` and `leads.self-service` (each `on` by default, at the entity,
project and team levels) print, for a lead seat, the lines that a lead may type or choose in a
seat's pane when a send cannot reach it or a dialog blocks it, and that a lead in development
mode may bring back a stopped seat; `off` drops the line. `entity.main-orchestrator.relays-owner`
(entity level alone) prints, inside an entity, the line that a decision the main orchestrator
relays from the owner is quoted, cited, and acted on without asking again; it is `off` until an
entity turns it on, because a relayed decision carries the owner's authority and a sender's
claim to relay one does not yet verify. `owner.reserved-scope` is the list the owner's reserved
scope line names — public releases, spending, credentials, and the owner's machine (its system
settings, accounts and logins, credential store and hardware) unless a level names its own list — and
that line always prints, with its second sentence: checkouts, seats and team config belong to
the teams. A chain that cannot be read leaves the defaults in force.

## Who may run it

The view (`team policy`) may be run by the owner, a seat of the team, or an approved delegate pane
that may read the team. `team policy set` and `team policy unset` are owner-only from a terminal
outside herdr, signed under `team-policy-v1\n`, and logged to `.agents/team.log`. `--dry-run`
prints the plan and does not ask for Touch ID.

## Output and exit codes

| Outcome | Output | Exit |
| --- | --- | --- |
| effective policies listed, updated, or planned | table of effective policies or `policy: set\|unset …` | 0 |
| non-owner attempted set/unset, lower level loosened a higher level, or source failed verification | `team policy: <problem>` | 1 |
| invalid invocation, file, policy name, or value | `team policy: <problem>` | 2 |

`--help` and `-h` show usage and exit 0.
