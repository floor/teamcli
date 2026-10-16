# The agent, team and project registries

Three records hold who the fleet is: one file per agent under `~/.config/team/agents/`, one teams
file, and one projects file. `team` writes them — registration happens at a seat's first launch by
`up`, `add`, `restart` or `reload` — and routing, [team list](../commands/list.md),
[team send](../commands/send.md) and [team projects](../commands/projects.md) read them. The team
file (`.agents/team.yaml`) stays the seed and the projection; the registries are the live truth
that `up` and routing read.

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
| `project`, `entity` | the team's own name — today's `project:` key in the team file, not the project it sits in — and the entity it belongs to, the entity whose lobby the team lives in |
| `project_id` | the project the team sits in, by project ID, or `null`: a team no project names is its own project; written from the team file's `in_project` |
| `session` | the herdr session |
| `root`, `lobby` | the checkout, and the lobby folder |
| `roster` | one `{agent, seat, role}` per seat, and the capabilities on the seats that hold them: `leads: true` on the one seat the team file marks as its lead, `assistant: true` on the one it marks as its entity's assistant — readable without a role name; an absent field means the seat is not known to hold the capability, so a record written before the fields reads unchanged |
| `lifecycle` | `defined`, `running`, `stopped` or `archived` |
| `provenance` | including when the record was last updated |

## The project record

`~/.config/team/projects.yaml`, one entry per project, keyed by the project ID — the display name
lowercased, every run of characters outside letters, digits, `.`, `_` and `-` written as one `-`,
nothing left at either end: `TeamCLI` is `teamcli`, `Team CLI` is `team-cli`. A team file's
`in_project` writes the display name, and the id is the key it reaches. The id is minted when the
project is first written and never moves: a rename writes `name`. The team file's `in_project`
writes this record — the name, the entity and the team IDs — and a team that sets
`project_lead: true` beside it supplies `lead` on every launch: the agent of that team's own lead
seat, so a mark that moves in the file moves the record with it. A team the registry names in two
projects is refused by [`team check`](../commands/check.md), which names both.

| Field | Meaning |
| --- | --- |
| `name` | the display name — what people and team files call the project (`TeamCLI`) |
| `entity` | the entity the project belongs to |
| `lead` | the project lead, by agent ID — never a seat or a role name: the agent of the lead seat (`leads: true`) of the one team whose file sets `project_lead: true` beside `in_project`, re-resolved on that team's every launch; a lead seat with no agent yet leaves it `null` |
| `teams` | the team IDs the project groups |
| `provenance` | who registered the record, and when it was registered and last updated |

## The id is the identity

An id is assigned once and never changes: a rename moves `name`, never `id`, and a retired id is
never reused. A seat keeps its id across relaunches; only `reach.pane` is re-pointed. Routing and
the sender header read the id — a name is for display, and for addressing a target as
`<seat>@<team>`.
