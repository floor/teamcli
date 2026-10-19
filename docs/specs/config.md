---
created: 2026-10-18
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75) for what exists today (`team add --model --effort`, the team file's seat fields, `team policy`)
for: Runtime (seats and the registry); Kernel amendment 02 (policies, as the limits config is checked against)
decision: OD-20261018-18 (amending OD-20261018-17 and -14)
public: staged for review; contains no private links
---

# Spec: `team config`, `team settings` and `team seat`

## 1. Scope

How the owner, a lead and TeamCLI itself read and change **settings**: the operational values of an
entity, a project, a team or a seat (a seat's model and effort, a team's workspace adapter, an
entity's vault). **Settings are values. Policies are limits.** A setting is always checked against
the policies in force (Kernel amendment 02), and can never loosen one.

Three commands, one registry of keys and one set of rules (OD-20261018-18):

- **`team config`** reads and changes the values **above a seat** — at `entity`, `project` and
  `team` level;
- **`team settings`** reads and changes **one seat's** settings;
- **`team seat`** shows **the seat as an object** — its status, model, conversation, cost and last
  turn — and groups the seat's lifecycle under it.

All three target **0.5.3**.

## 2. Terms

- **setting:** one key and its value at one level.
- **level:** `entity`, `project`, `team` or `seat`. A lower level inherits from the one above unless it sets its own value. Where a key also has a policy, the value must fit the policy at every level above.
- **settings registry:** the list of known keys, with each key's levels, type, allowed values, default and how a change applies.

## 3. Formats: the commands

```sh
team config get <level> <name> [<key>]                      # one key, or all keys with where each comes from
team config set <level> <name> <key> <value>                # one key
team config set <level> <name> <key>=<value> [<key>=<value> …]   # several at once, applied together
team config unset <level> <name> <key>                      # back to the inherited value
team config keys [<level>]                                  # the registry: keys, types, allowed values

team settings <seat>                                        # the seat's settings, each with where it comes from
team settings set <seat> <key> <value>                      # one key
team settings set <seat> <key>=<value> [<key>=<value> …]    # several at once, applied together
team settings unset <seat> <key>                            # back to the inherited value

team seat <seat>                                            # status, model, conversation, cost, last turn
team seat add|remove|restart|rename …                       # the seat's lifecycle, grouped here; the top-level commands stay as aliases
```

`<level>` is `entity`, `project` or `team`: `team config` does not take `seat`, whose settings are
`team settings`'s.

Examples:

```sh
team settings <seat>                                        # where the model and the effort come from
team settings set <seat> effort high
team settings set <seat> model=<model> effort=<level>
team settings unset <seat> effort
team seat <seat>
team config set team <team> workspace tmux
team config set entity <entity> vault <repository>
```

`--dry-run` shows the change and how it would apply. `--json` follows the output contract.

## 4. How a change applies

| Kind of key | Applies |
|---|---|
| a seat's runtime (model, effort, cli, launch) | headless seats: the next turn. Live seats: a restart that resumes the same conversation (the default). `--live`: the CLI's own in-session command through the typed leg, read back, as the fallback only, never in a `human: true` pane |
| a seat's identity or routing (nickname, delivery_order, human) | at once, in the registry; the next send uses it |
| a team's, project's or entity's operational value (workspace, vault, storage, sender_name) | at the next `team up` or reload of the teams concerned; `team check` shows the difference until then |

Every change is a signed record in the registry, logged in the team log, and raises a
`config.changed` event.

## 5. Rules

1. An unknown key is refused, naming the known keys at that level.
2. A value outside the key's allowed values, or outside the CLI profile's range (an effort the CLI doesn't accept), is refused, naming the accepted values.
3. A value that a policy forbids is refused, naming the policy. Config never loosens a policy.
4. Who may set:
   - the owner, at every level;
   - a team's lead, at `seat` and `team` level within its team, for the keys and values its role's policy allows (for example an allowed-models list);
   - the budget's circuit breaker (008), for the keys its policy names (for example moving a seat to a cheaper model at a pace mark), logged and reversible.
5. `get` never shows a secret. Keys that reference credentials hold keychain references only.
6. There are no per-key top-level commands (`team model`, `team effort`): every setting goes through `team config` at the levels above a seat, or through `team settings` for a seat.

## 6. Registries

Keys at `entity`, `project` and `team` level are set through `team config`; keys at `seat` level,
through `team settings`. `team seat` shows a seat's settings from the same registry and changes
nothing.

`config-keys` (proposed; a first set):

| key | levels | type and allowed values | default | applies |
|---|---|---|---|---|
| model | seat | a model the seat's profile and the allowed-models policy accept | from the role or team | restart + resume / next turn |
| effort | seat | the profile's levels (for example low, medium, high, xhigh, max) | from the role or team | restart + resume / next turn |
| cli | seat | a known profile | — | restart (new conversation) |
| launch | seat | an adapter launch line (escape hatch) | from the account | restart + resume |
| account | seat | an account of the entity (Runtime commitment 50) | from the team | restart + resume |
| nickname | seat | unique in the team, never `lead` | none | at once |
| delivery_order | seat, team, project, entity | legs: native, mcp-inbox, drop, typed (tighten only) | native, mcp-inbox, typed, drop | at once |
| human | seat | true / false | false | at once |
| universe | team, project, entity | a universe name: a built-in public-domain universe, or the entity's own made with `team universes add` | none (plain seat numbering) | at once; the next `team add` draws the next free name from it — a change never renames existing seats |
| workspace | team, project, entity | headless, herdr, tmux | headless (from 0.6) | next up |
| vault | entity | a path or repository | none | next up |
| storage | entity | files, a database, Redis, online (an adapter) | files | next up |
| sender_name | project, entity | auto, nickname, seat, seat@team | auto | at once |

## 7. Open points

Storage (settled 2026-10-19, OD-20261018-08 and the orchestrator's ruling): settings sit beside policies in the registry's own signed records: entity in entities.yaml (<entity>.settings), project in projects.yaml (projects.<id>.settings), team in the registry's team record (teams.yaml teams.<id>.settings, never the team file), seat in agents/<agentId>.yaml (settings). One hierarchy, inheritance by absence, a separate config signature domain. A multi-key write is atomic per record, and a write across levels is applied lowest level first. A change whose signed generation has no config.changed event is reconciled by the bus's reconcile pass, which appends one marked reconciled.

1. A setting at `project` level for a team that spans projects: does the team's project win, or does the seat's?
2. Bulk changes across seats (`team settings set <seat> …` one at a time): a `role` level, or a selector?

## Revision log

- 2026-10-18: draft 1 (the writer), from OD-20261018-14 and -17.
- 2026-10-19: split to the three commands of OD-20261018-18 — `team config` above a seat,
  `team settings` for one seat, `team seat` for the seat as an object — all three targeting 0.5.3;
  generic examples in place of a named team, entity and seat; the first entry names the writer.
- 2026-10-19: the `universe` key added to the proposed `config-keys` table (OD-20261019-06, -10) —
  team, project and entity levels; a built-in public-domain universe or the entity's own, made with
  `team universes add`; none by default; a change applies at once, the next `team add` draws from it,
  and it never renames existing seats. A planned row: no key of this name is read at the tag.
- 2026-10-19: the storage open point settled (OD-20261018-08 and the orchestrator's ruling): settings
  sit beside policies in the registry's own signed records — entity, project, team (never the team
  file) and seat — one hierarchy, inheritance by absence, a separate config signature domain; a
  multi-key write is atomic per record, a cross-level write lowest level first, and a signed change
  with no `config.changed` event is reconciled by the bus's reconcile pass.
