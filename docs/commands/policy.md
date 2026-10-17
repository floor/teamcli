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
`liveness-idle-lead-seconds`, `liveness-idle-owner-seconds`, `delivery-order`).
Inheritance tightens only: a lower level that loosens a higher level is refused at load and before
writing, naming both levels. Where no level sets a value, the release default applies (`off` for
gate-lifting policies); an expired value counts as unset at its level.

## Who may run it

The view (`team policy`) may be run by the owner, a seat of the team, or an approved delegate pane
that may read the team. `team policy set` and `team policy unset` are owner-only from a terminal
outside herdr, signed under `team-policy-v1\n`, and logged to `.agents/team.log`.

## Output and exit codes

| Outcome | Output | Exit |
| --- | --- | --- |
| effective policies listed, updated, or planned | table of effective policies or `policy: set|unset …` | 0 |
| non-owner attempted set/unset, lower level loosened a higher level, or source failed verification | `team policy: <problem>` | 1 |
| invalid invocation, file, policy name, or value | `team policy: <problem>` | 2 |

`--help` and `-h` show usage and exit 0.
