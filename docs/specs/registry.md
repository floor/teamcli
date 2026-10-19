---
created: 2026-10-18
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: Runtime, chapters B and I (commitments 2 to 7, 26, 28 and 29)
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: registry

## 1. Scope

This spec covers the three record types the tool registers — the agent, the team and the
project — with their ids, fields, lifecycles, provenance and write discipline, and the roster
line a team record carries. It leaves the team file's own seat declaration to the launch spec,
the seat's live state to the seat-state-and-watch spec, and the grants a record may be mentioned
by to the grants spec. It says what the code at the tag does, in the code's words; where a text or a decision names
something the code does not hold, §3.5 and §7 say so, the planned store among them.

## 2. Terms

- **home**: the owner's home folder; every registry path below is relative to it.
- **agent**: one seat's record, kept across the occupants that fill the seat.
- **agent id**: `agt_` plus twelve lowercase hexadecimal digits, minted at random.
- **team**: a project root's team, keyed by its **team id**: the first twelve hex digits of the
  SHA-256 of the root's real path.
- **project**: the record between the entity and the teams, keyed by a **project id** derived
  once from its display name.
- **roster**: the list of roster lines a team record carries.
- **roster line**: `{ agent, seat, role }` plus optional `nickname`, `leads` and `assistant`.
- **lifecycle**: the word on an agent (`registered`, `running`, `stopped`, `retired`) or a team
  (`defined`, `running`, `stopped`, `archived`).
- **provenance**: who wrote a record, when, and under what marks.
- **seat handle**: `seat_` plus twelve lowercase hex digits, minted by the state and kept on the
  agent record for continuity across a stop and a relaunch.
- **retired**: the agent lifecycle word for a removed seat; its record stays readable.

## 3. Formats

### 3.1 The agent record

Lives at `.config/team/agents/<agent id>.yaml`. `team` alone writes it: a temporary file in the
same folder, then a rename, with the folder's lock held across a read-modify-write. A missing
folder is no agents; a file whose stem is not a valid agent id, or whose body does not read as
an agent record, is not handed out.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `id` | string | yes | — | 0.5.0 | `agt_` and twelve lowercase hex; immutable |
| `name` | string | yes | — | 0.5.0 | Display only; a rename edits this field and nothing else |
| `signing.model` | string | yes | — | 0.5.0 | The model the commit gate checks |
| `signing.version` | string | yes | — | 0.5.0 | The version the commit gate checks |
| `signing.role` | string | yes | — | 0.5.0 | The role the commit gate checks |
| `lab` | string | yes | — | 0.5.0 | The vendor |
| `cli` | string | yes | — | 0.5.0 | The CLI the seat runs |
| `launcher` | string \| null | yes | `null` | 0.5.0 | A launcher reference; until launchers exist, the raw line is in `launch` |
| `launch` | string | yes | — | 0.5.0 | The launch line as it ran |
| `reach.team` | string | yes | — | 0.5.0 | The team id the seat belongs to |
| `reach.seat` | string | yes | — | 0.5.0 | The seat's name in the team file |
| `reach.session` | string | yes | — | 0.5.0 | The herdr session |
| `reach.pane` | string \| null | yes | — | 0.5.0 | The current pane; re-pointed on relaunch |
| `reach.address` | string \| null | yes | — | 0.5.0 | A cross-session address when the CLI has one |
| `mcp` | string[] | yes | `[]` | 0.5.0 | Declared, and empty in this build |
| `skills` | string[] | yes | `[]` | 0.5.0 | Declared, and empty in this build |
| `lifecycle` | `registered` \| `running` \| `stopped` \| `retired` | yes | — | 0.5.0 | The record's word |
| `seat_handle` | string \| null | no | absent | 0.5.0 | The stable `seat_<12 hex>` handle, when the state minted one |
| `policies` | map | no | absent | 0.5.0 | Owner-signed seat-level policy declarations |
| `provenance.registered_by` | string | yes | — | 0.5.0 | Who first registered the record; never changed |
| `provenance.registered_at` | ISO 8601 | yes | — | 0.5.0 | When it was first registered |
| `provenance.updated_at` | ISO 8601 | yes | — | 0.5.0 | When it was last written |
| `provenance.dev_mode` | boolean | no | absent | 0.5.0 | The mark of a record a dev-mode run wrote |
| `provenance.dev_mode_by` | string | no | absent | 0.5.0 | The caller that dev-mode run admitted |
| `provenance.dev_mode_at` | ISO 8601 | no | absent | 0.5.0 | When the mark was written |
| `provenance.delegated` | `{ signer: 'owner', actor, command }` | no | absent | 0.5.0 | The delegation the last write ran under |

An example, in the shape the tests register at the tag:

```yaml
id: agt_0123456789ab
name: Worker Alpha
signing: { model: Claude Sonnet, version: "5.5", role: builder }
lab: anthropic
cli: antigravity
launcher: null
launch: zsh -lc "agy --model claude-sonnet-5-5-high"
reach: { team: acme, seat: worker-alpha, session: acme, pane: <pane>, address: null }
mcp: []
skills: []
lifecycle: running
seat_handle: seat_0123456789ab
provenance:
  registered_by: team up
  registered_at: 2026-10-18T09:00:00.000Z
  updated_at: 2026-10-18T09:00:00.000Z
```

The two identifiers are not interchangeable. A message record's `to_id` is this record's `agt_`
id — the id a cross-session address and a message bind to — and never the state's `seat_` handle,
which is the state's continuity key. A general-seat-brief record follows the same rule: it carries
the recipient's `agt_` id when the registry holds a record for the seat, and null otherwise.

### 3.2 The team record

Lives in `.config/team/teams.yaml`, keyed by team id. Written by a read-modify-write under a
lock file ending in an atomic replace.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `<team id>` | key | yes | — | 0.5.0 | The record's key; filled in when read, never written inside the body |
| `project` | string | yes | — | 0.5.0 | The team's own name (the team file's `project:` key) |
| `projectId` | string \| null | yes | `null` | 0.5.0 | The project it sits in, by project id; a team no project names is its own project |
| `entity` | string \| null | yes | `null` | 0.5.0 | The entity's name |
| `session` | string | yes | — | 0.5.0 | The herdr session |
| `root` | string | yes | — | 0.5.0 | The project root |
| `lobby` | string | yes | — | 0.5.0 | The lobby for `session`; recorded and kept |
| `lobbies` | map of session → path | yes | `{ session: lobby }` | 0.5.0 | One lobby per session; a file written before the map reads as one entry |
| `roster` | roster line[] | yes | `[]` | 0.5.0 | The seats this team holds |
| `lifecycle` | `defined` \| `running` \| `stopped` \| `archived` | yes | — | 0.5.0 | The team's word |
| `provenance` | `{ registered_by, registered_at, updated_at }` | yes | — | 0.5.0 | Who wrote it and when |

A roster line:

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `agent` | string | yes | — | 0.5.0 | The agent id |
| `seat` | string | yes | — | 0.5.0 | The seat's name |
| `role` | string | yes | — | 0.5.0 | The role's name, recorded and never used to resolve |
| `nickname` | string | no | absent | 0.5.0 | The human name, projected so another team can resolve it |
| `leads` | boolean | no | absent | 0.5.0 | The team file marks this seat as its lead |
| `assistant` | boolean | no | absent | 0.5.0 | The seat's place in the chain is the entity's assistant |

### 3.3 The project record

Lives in `.config/team/projects.yaml`, keyed by project id. The id is the display name,
lowercased, with every run of characters outside `a-z`, `0-9`, `.`, `_` and `-` replaced by one
`-`, and the ends trimmed; it is derived once and never moved. A rename moves `name`, never the
key.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `<project id>` | key | yes | — | 0.5.0 | The record's key |
| `name` | string | yes | — | 0.5.0 | The display name |
| `entity` | string \| null | yes | `null` | 0.5.0 | The entity's name |
| `lead` | string \| null | yes | `null` | 0.5.0 | The project lead, by agent id; never a seat or role name |
| `teams` | string[] | yes | `[]` | 0.5.0 | The team ids this project groups |
| `deliveryOrder` | array of `native` \| `mcp-inbox` \| `typed` | no | absent | 0.5.0 | The project's word on the delivery order; no command writes it in this build |
| `liveness` | map | no | absent | 0.5.0 | `idle_lead_seconds`, `idle_owner_seconds`, `blind_after_seconds`; whole seconds, at least one |
| `policies` | map | no | absent | 0.5.0 | Owner-signed project-level policy declarations |
| `provenance` | `{ registered_by, registered_at, updated_at }` | yes | — | 0.5.0 | Who wrote it and when |

### 3.4 Ids

- `agt_[0-9a-f]{12}` — minted from six random bytes at registration; never reused, never
  renamed, never derived from a name.
- `seat_[0-9a-f]{12}` — the state's seat handle, kept for continuity.
- `<team id>` — `sha256(realpath(root))` first twelve hex digits; a root that does not exist
  yet is hashed as written, resolved to an absolute path.
- `<project id>` — the derived display name above.

### 3.5 The store (planned; OD-20261018-08)

The registry's storage is one contract, whatever holds the records. None of this subsection is
built at the tag; it is the owner decision's direction of 2026-10-18.

| Operation | Meaning | At v0.5.0 |
|---|---|---|
| `read` | Return one record by its key, or say it is absent | not built |
| `write` | Write one record whole, by a command that signs and logs the change | not built |
| `list` | Return the keys under a level: an entity, a project or a team | not built |
| `watch` | Tell a reader when a record it asked about changed | not built |
| atomic compare-and-set | Write only if the record still holds the version the writer read, so a lost update is refused | not built |

The backends the decision names:

| Backend | Standing | Note |
|---|---|---|
| files in TeamCLI's machine configuration | built-in default | no runtime dependency; the only store the code has at the tag |
| a database, for example MongoDB or PostgreSQL | optional add-on package | for several machines sharing one team |
| Redis | optional add-on package | fast shared state for the event bus; not the only copy unless it is durable |
| an online service, possibly hosted from teamcli.io one day | optional add-on package | neither named nor built |

*Source:* OD-20261018-08 (2026-10-18). *Proof:* none at the tag — no storage interface exists, and
no backend but the files does.

### 3.6 The memory entry (planned; 003 Memory)

The Memory module keeps no spec of its own; the entry's provenance rides the Runtime's record
provenance, and this is its planned format. None of it is built at the tag.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `proposed-by` | string | yes | who proposed the entry: a registry id, or `owner` |
| `accepted-by` | string | yes | who accepted it: a registry id, or `owner`; an entry without an acceptance is not memory |
| `at` | ISO 8601 | yes | when it was accepted |
| `from` | string | yes | its source: a record's id, or a conversation's date |
| `level` | `entity` \| `project` \| `team` \| `seat` | yes | the level the entry lives at |
| `until` | ISO 8601 | no | the end the module gives it; an ended entry is offered for removal, never dropped |

Removal stops the tool giving the entry to any agent from then on, and the entry stays out until
the owner accepts it again; a removal reaches neither a conversation that already holds the entry
nor what a lab kept (003 Memory, commitments 6 and 7).

*Source:* the Memory module (003), commitments 4–7; planned, not built at the tag. *Proof:* none.

## 4. Commands and options

The registry owns no command of its own; these read or write its records.

    team register <seat> [--session <name>] [--pane <id>] [--dry-run] [--json]
    team projects [--json]
    team list [--all] [--seats] [--watch] [--json]
    team status [--session <name>] [--file <path>] [--project <name>] [--all] [--json]

`team register` writes the state, the log, the launched-pane pointer and the registry's agent and
roster line, and types nothing into the pane. Its outcomes are the exit-codes registry's
`register.*` rows: `register.ready` (0), `register.already` (0), `register.dry-run` (0),
`register.no-seat`, `register.no-session`, `register.no-agent`, `register.screen`,
`register.no-cli`, `register.no-profile`, `register.recorded`, `register.pane-taken`,
`register.pane-named`, `register.stopped`, `register.herdr`, `register.caller`,
`register.delegate`, `register.grant` (1), and `register.file`, `register.usage` (2).

## 5. Rules

1. **One record per seat, under an immutable id.** The tool MUST mint an agent id at first
   registration and MUST NOT reuse, rename or derive it from a name. *Source:*
   `src/registry/agents.ts` (`AGENT_ID_PATTERN`, `registerAgent`). *Proof:*
   `test/registry-agents.test.ts`.
2. **A record's identity is (team, seat), never the pane.** A re-point MUST update `reach` on the
   same record; one pair MUST hold at most one live record. *Source:* `src/registry/agents.ts`
   (`findAgent`), `src/registry/teams.ts`. *Proof:* `test/registry/identity.test.ts`.
3. **Records are appended, never deleted.** Ending a seat MUST mark its lifecycle; a retired
   record MUST NOT be handed out by the lookup that reads past it. *Source:*
   `src/registry/agents.ts` (`findAgent` skips `retired`). *Proof:* `test/registry-boundaries.test.ts`.
4. **Every write is whole or not at all.** An agent write MUST go through a temporary file and a
   rename under the folder's lock; a team or project write MUST be a read-modify-write ending in
   an atomic replace. *Source:* `src/registry/agents.ts`, `src/registry/teams.ts`,
   `src/registry/projects.ts`. *Proof:* `test/registry-writers.test.ts`.
5. **A record the writer would refuse is never handed out.** A file whose stem and body disagree,
   or whose body fails the reader's own rules, MUST read as no record; a registry that cannot be
   read MUST refuse, never read as empty. *Source:* `src/registry/agents.ts`
   (`readAgentFile`), `src/registry/teams.ts` (`TeamsError`). *Proof:*
   `test/registry-boundaries.test.ts`, `test/registry-acceptance.test.ts`.
6. **A team id is the root's real path, hashed.** Two stores of one checkout MUST be one team.
   *Source:* `src/registry/teams.ts` (`teamIdOf`). *Proof:* `test/registry-teams.test.ts`.
7. **A roster line names its agent, seat and role.** A line MAY carry `nickname`, `leads` and
   `assistant`; a line written before those marks existed MUST read as not known to hold them.
   *Source:* `src/registry/teams.ts` (`RosterEntry`). *Proof:* `test/registry-teams.test.ts`.
8. **A project id is derived once and never moved; a rename moves `name`.** Two projects MUST NOT
   share one name, and a team two projects name MUST be refused, naming both. *Source:*
   `src/registry/projects.ts` (`projectIdOf`, `byName`, `ofTeam`). *Proof:*
   `test/registry/projects.test.ts`.
9. **A project's `liveness` holds only the three keys, each a whole number of seconds, at least
   one.** Anything else MUST be refused at the read door. *Source:* `src/registry/projects.ts`
   (`checkedLiveness`). *Proof:* `test/registry/projects.test.ts`.
10. **Provenance is written on every record.** The first registration's `registered_by` and
    `registered_at` MUST NOT change; `updated_at` MUST move on every write; a gate-lifting mark and
    a delegation mark MUST be written by the writers that know them and cleared only as the
    source says. *Source:* `src/registry/agents.ts` (`AgentProvenance`, `updateAgent`).
    *Proof:* `test/registry-agents.test.ts`.
11. **A seat handle survives a stop.** `remove --keep`, `down` and `up`'s repair MUST keep the
    `seat_<12 hex>` handle for a declared seat and give it back on the next launch. *Source:*
    `src/state.ts` (`retained_seats`, `SeatState.id`). *Proof:* `test/registry-down-session.test.ts`.
12. **A record confers no right.** Registration, a lifecycle and a signing role MUST NOT admit
    anything by themselves; admission and the resolver read the roster line and the grants, never
    the record's existence. *Source:* `src/registry/agents.ts` (the module comment),
    `src/permissions/resolve.ts`. *Proof:* `test/permissions/record-acceptance.test.ts`.

## 6. Registries

This area writes no registry of its own; its words are the fields above. It feeds:

**`operations`** (the command-to-gate rows this area's read surfaces appear in):

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `register` | the owner, or the seat's own team | 0.5.0 | `src/permissions/map.ts` | a registry record is a report and confers no right |
| `list` | any seat with a registry record | 0.5.0 | `src/permissions/map.ts` | a read surface |
| `status` | any seat with a registry record | 0.5.0 | `src/permissions/map.ts` | a read surface |

**`exit-codes`** (the rows for the command this area owns):

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `register.ready` | the running seat's record was written | 0.5.0 | `contract/exit-codes.json` | exit 0 |
| `register.already` | the seat is already recorded on that pane | 0.5.0 | `contract/exit-codes.json` | exit 0 |

## 7. Open points

- **The store is a planned direction, not built.** OD-20261018-08 makes the registry the home of a
  team's definition — seats, roles, the role-and-trade briefs, the general brief, the start
  briefs, and as today grants, policies and records — keyed by entity, then project, then team,
  with TeamCLI's defaults overridden by the entity then the project, and its storage pluggable
  behind one contract of five operations: `read`, `write`, `list`, `watch` and an atomic
  compare-and-set (§3.5). None of it is built at v0.5.0: `team.yaml` in the project root is still
  the definition's source, the agent, team and project records are files in the machine's
  configuration, and no command exports or imports a store.
- **Offline behaviour and conflicts are still to specify.** A store the machine cannot reach
  either leaves a local cache with queued writes or refuses; whether two writers' changes meet the
  compare-and-set or wait is open.
- **Moving between backends is still to specify**, under the decision's names `team registry
  export` and `team registry import`; the decision's `team export` and `team import` keep a
  readable copy for review, backup or another machine outside the repository.
- **The backend as an entity setting is still to specify**: one store per entity, shared by all
  its projects, where the setting lives, and who may change it.
- **The launcher registry and the resume record are not built.** `launcher` is a reference the
  code declares and never resolves; the per-seat resume record a text names is absent, so
  continuity across a launch is the live pane's, never a resumed conversation.
- **`mcp` and `skills` are declared and empty.** No writer fills either list in this build.
- **The entity is an entry, not a record.** The team record carries `entity`, and the lobby key
  reads it; the entity's own entry lives in `.config/team/entities.yaml` and may carry `liveness`
  and `policies`. It has no id, no lifecycle and no record of its own in this registry.
- **The project's `deliveryOrder` has no writer.** A hand-written value reads and an upsert keeps
  it; no command sets a project-level setting.
- **The registry's cost view is not built.** `team usage` reads accounts and seats, not agent
  records.
- **One `leads` per team is checked at the file and not re-checked when a grant is made or a
  seat added** (the Runtime text's §10, question 11).
- **A seat the roster does not list has no record, whatever the file declares.** The refusal's
  words live in the resolver, not in a registry row; a run of `team register` on such a seat is
  refused by placement rather than by a record-shaped exit id.

## Revision log

- **Draft** (the Runtime text's writer, 2026-10-18): lifted from the Runtime's chapters B and I;
  read at the tag.
- **Draft, amended** (the writer, 2026-10-18): §3.5 and §7 record OD-20261018-08's
  planned store — the five-operation contract, the backend list and the still-to-specify points —
  none of it built at the tag.
- **Amended** (the writer, 2026-10-19): §3.6 adds the Memory entry's planned provenance format
  (003 Memory, commitments 4–7) for the Memory v2 draft's fold; none of it is built at the tag.
