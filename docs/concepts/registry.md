# The agent and team registries

Two records hold who the fleet is: one file per agent under `~/.config/team/agents/`, and one teams
file. `team` writes them — registration happens at a seat's first launch by `up`, `add`, `restart`
or `reload` — and routing, [team list](../commands/list.md) and
[team send](../commands/send.md) read them. The team file (`.agents/team.yaml`) stays the seed and
the projection; the registries are the live truth that `up` and routing read.

## The agent record

`~/.config/team/agents/<id>.yaml`, one file per agent:

| Field | Meaning |
| --- | --- |
| `id` | `agt_` and twelve hex digits, assigned at registration |
| `name` | display only: a rename edits this field and nothing else |
| `signing` | the model, version and role triple the commit gate checks |
| `lab`, `cli` | the vendor and the CLI the seat runs |
| `launch` | the raw launch line, recorded as it was started; `launcher` is a reference, later |
| `reach` | the namespaces the agent answers to: team, seat, session, pane, and a cross-session address when it has one |
| `seat_handle` | when the launch supplies one, the stable `seat_<12 hex>` handle `team seats` shows; set once, never changed |
| `mcp`, `skills` | declared now, filled later |
| `lifecycle` | `registered`, `running`, `stopped` or `retired` |
| `provenance` | who registered it, and when it was registered and last updated |

`up`, `add`, `restart` and `reload` register a seat's agent at its first launch and re-point it on
every relaunch; `remove` and the stop of a seat end it — `stopped` comes back to the same agent,
`retired` never does. A relaunch keeps the id and re-points `reach.pane`, and every write goes
through a temporary file and a rename.

## The team record

`~/.config/team/teams.yaml`, one entry per team, keyed by the team id — the first twelve hex digits
of the SHA-256 of the root's real path, so two stores of one root are one team:

| Field | Meaning |
| --- | --- |
| `project`, `entity` | the project's name, and the entity it belongs to — the entity whose lobby the team lives in |
| `session` | the herdr session |
| `root`, `lobby` | the checkout, and the lobby folder |
| `roster` | one `{agent, seat, role}` per seat |
| `lifecycle` | `defined`, `running`, `stopped` or `archived` |
| `provenance` | including when the record was last updated |

## The id is the identity

An id is assigned once and never changes: a rename moves `name`, never `id`, and a retired id is
never reused. A seat keeps its id across relaunches; only `reach.pane` is re-pointed. Routing and
the sender header read the id — a name is for display, and for addressing a target as
`<seat>@<team>`.
