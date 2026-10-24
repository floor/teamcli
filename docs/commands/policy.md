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
`swap-wait-seconds`, `client-bundles`, `client-grant-max-duration`).
Inheritance tightens only: a lower level that loosens a higher level is refused at load and before
writing, naming both levels. Where no level sets a value, the release default applies (`off` for
gate-lifting policies); an expired value counts as unset at its level.

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

`brief-transport` says how a general seat brief reaches its seat. `file`, the default, writes the
claim and the signed drop and nothing else; `message` sends the whole brief as a real send body
through the seat's own delivery legs, so its receipt, history line and outcome are an ordinary
send's; `memory` is an experiment no runtime in this build proves zero-persistence for, so a
`memory` policy delivers nothing, refuses every seat and every `team send --brief`, and falls
back to nothing. `message` is within `file`; `memory` is comparable only to itself. It takes the
entity, project and team levels.

## Who may run it

The view (`team policy`) may be run by the owner, a seat of the team, or an approved delegate pane
that may read the team. `team policy set` and `team policy unset` are owner-only from a terminal
outside herdr, signed under `team-policy-v1\n`, and logged to `.agents/team.log`.

## Output and exit codes

| Outcome | Output | Exit |
| --- | --- | --- |
| effective policies listed, updated, or planned | table of effective policies or `policy: set\|unset …` | 0 |
| non-owner attempted set/unset, lower level loosened a higher level, or source failed verification | `team policy: <problem>` | 1 |
| invalid invocation, file, policy name, or value | `team policy: <problem>` | 2 |

`--help` and `-h` show usage and exit 0.
