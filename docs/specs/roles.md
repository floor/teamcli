---
created: 2026-10-18
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: int/0.5.1 (8acb470b)
for: 009 Roles and Skills
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: roles and skills

## 1. Scope

This specification defines the role definition a library carries, how each level references,
overlays and inherits one, how skills are bound and delivered, the rule-versus-skill test, the two
launch policies the module names, and the planned `universe` setting, `team universes add` command,
and seat-naming, team-role and standing role-name rules (`OD-20261019-06`, `OD-20261019-10`,
`OD-20261019-15` to `OD-20261019-21`). It leaves capabilities, their vocabulary and their
enforcement to the Kernel, the seat's list and the envelope to the grants specification, and the
address grammar and the nickname's resolution to messaging. **Nothing of the libraries or the
universe setting is built at int/0.5.1 8acb470b**: the sections below separate what the code reads
today, marked built, from the decided forms the code does not read, marked planned.

## 2. Terms

- `role`: a TeamCLI base function (`orchestrator`, `operator`, `builder`, `reviewer`, `tester`,
  `documentarist`, `communication` or `architect`; `OD-20261019-15`, `OD-20261019-16`,
  `OD-20261019-21`, `OD-20261019-32` answer 29) or the named job a seat's line references; it
  carries capability words, a skill set and written rules.
- `team role`: a team's or universe's word for a job, mapped onto one of the base functions and
  optionally adding its own grants, capabilities and skills within the team envelope
  (`OD-20261019-16`, `OD-20261019-21`, `OD-20261019-32` answer 29).
- `seat`: a position in a team that keeps its registry id (`agt_…`), its list and its leases across
  occupants and renames.
- `nickname`: a name for humans, unique within its team, conferring nothing.
- `universe`: the world from which a team draws its seat names, titles and team-role words; a
  setting at entity, project or team level, inherited downwards (`OD-20261019-06`,
  `OD-20261019-10`, `OD-20261019-21`).
- `entry`: a sourced record in a universe's canon carrying a name, its titles and when they apply,
  relations and relevant traits (`OD-20261019-12`, `OD-20261019-21`).
- `name`: the human-readable name of a seat, drawn from its selected entry in lowercase with
  hyphens; unique within a team, addressed across the entity as `name@team`, and distinct from the
  seat's stable registry id (`OD-20261019-17`, `OD-20261019-19`, `OD-20261019-21`).
- `title`: a sourced rank, office or occupation attached to an entry at a stated point, paired with
  the name on the seat's label `Name · Title` (`OD-20261019-12`, `OD-20261019-21`).
- `role name`: a universe's standing seat name for a role, reused by teams that adopt that universe
  definition (`OD-20261019-19`, `OD-20261019-21`).
- `occupant`: the program and session filling a seat.
- `defaults`: the role templates TeamCLI ships.
- `library`: a generic, versioned, reusable source of roles, skills or universes; the storage and
  the format are implementation decisions.
- `overlay`: a level's own rules laid over the roles it references.
- `binding`: a level's act of attaching a skill to a seat, a context or a task.
- `context`: a declared trigger for a binding: a phase, a file kind the work touches, or a label.
- `agreed set`: the set of skills the owner has agreed a seat may receive.
- `required` / `optional`: the binding's property, never the role's; an optional skill is
  reported when undelivered, a required one refuses.
- `resolved content`: a role's text after inheritance, which is what the owner agrees.
- `lead`: the seat whose role holds `leads`; one per team or none.

## 3. Formats

### 3.1 The seat line's `role` and `nickname` (built)

The team file's seat line carries `role` (required) and, optionally, `nickname`, beside the seat's
name. The file's load reads both; the registry copies the role and the nickname into the seat's
record. The line's `leads: true` is a separate mark, not a role.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `role` | string | yes | — | 0.5.0 | the role's name; recorded and never decides |
| `nickname` | string | no | — | 0.5.0 | a human name; unique in the team, not another seat's name, never `lead`, and equal to its own seat's name is allowed |
| `leads` | boolean | no | — | 0.5.0 | the team's lead mark; exactly one seat carries it |

Example, from `test/rename.test.ts`: a seat `worker-alpha` renames to `worker-beta`; its pending
send-drops, signed mailbox messages, rules file and queue files move with it, its leases follow
the new name, and a send to `worker-beta` arrives. Renaming it to `max`, a nickname another seat
already carries, is refused (cases 5 and 6 of the same file).

### 3.2 The role definition (planned)

A role lives in a roles library and is referenced by name from a level. Its storage is out of
scope; its content is not.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `name` | string | yes | — | planned | the role's name, the owner's, in any language |
| `base_function` | `orchestrator` \| `operator` \| `builder` \| `reviewer` \| `tester` \| `documentarist` \| `communication` \| `architect` | for a team role | the role itself when it is a base function | planned | the base function a team role maps onto so admission and permission checks hold underneath (`OD-20261019-15`, `OD-20261019-16`, `OD-20261019-32` answer 29) |
| `inherits` | string | no | — | planned | a parent role; the resolved content is the parent's plus this role's |
| `capabilities` | list of `{name, scope}` | no | — | planned | Kernel vocabulary words with the scope each is bounded to |
| `constraints` | list | no | — | planned | the Kernel's recorded constraints (`allowed`, `required`, `forbidden`) |
| `skills` | list of strings | no | — | planned | skill names the library must resolve for this role |
| `rules` | text | no | — | planned | written rules, composed as §3.3 says |

A role definition MUST name no person, local path, operating-system folder or company. The words
`grant`, `agree` and `create` are never in a role; `leads` may be, in exactly one role per team.
The shipped base functions include `communication` — the seat role that converses with the owner
through the communication module, carrying `read` on state, send/route grants, and the skills to
read state, route asks, confirm commands and speak on every channel (`OD-20261019-15`) — and
`architect`, whose admission rules differ because it rules on texts and dispatches nothing, while
`archivist` and `recorder` map onto `documentarist` and `first assistant` maps onto `operator` as
team roles (`OD-20261019-32` answer 29).

### 3.3 A level's reference and overlay (planned)

Each level (the shipped defaults, the entity's library, the project's library, the team's overlay,
the seat's identity) references roles and lays its own rules over them.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `library` | reference | no | the level above | planned | where this level's roles are read from |
| `role` | string | one of the two | — | planned | a role this level's seats may reference |
| `rules` | text | no | — | planned | this level's overlay rules |
| `skills` | list of bindings | no | — | planned | §3.4 |
| `contexts` | map name → trigger | no | — | planned | the declared triggers of this level |

An overlay MAY add a limit and MUST NOT remove one. Composition of the written rules goes from the
role's rules (with what it inherits) to the entity's, the project's and the team's overlay rules,
each level tightening the one above; a limit against a looser rule resolves to the more
restrictive. Two positive duties that cannot both hold are a `duty-conflict` (§3.6).

### 3.4 A skill binding and a task's `needs` (planned; the field is built)

A binding attaches a skill to a seat by a level, a context or a task, and says whether it is
required. A task record carries `needs`, a list of skill names.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `skill` | string | yes | — | planned | the skill's name in the library |
| `required` | boolean | no | `false` | planned | refuses when undelivered; optional reports |
| `trigger` | `phase` \| `file-kind` \| `label` | no | — | planned | a context's declared trigger |
| `needs` | list of strings | no | — | 0.5.1, recorded only | a task's skill names; a record carrying any is not claimable |

A `needs` entry MUST name only a skill in the owner's agreed set for that seat; one outside it is
escalated, not granted. At int/0.5.1 8acb470b the task record reads and prints `needs`, and
`team next` does not consider a record that carries any (`src/commands/next.ts`, `takeable`), so
no skill is bound or delivered.

An adapter answers four questions in the same words for every harness: what the seat is shown,
where it is written, how the team verifies the seat received it, and, where the harness cannot
take a binding, that it says so and refuses where `required-skill-delivery` requires — never
dropping the binding silently. The delivery legs these answers name are the delivery-legs
registry's; this spec fixes only the four questions.

### 3.5 The agreement's pin (planned)

The library revisions and each level's own configuration are pinned together by content in the
agreement record; the per-seat file generated from them is throwaway output. An upgrade of a
library is reviewed and re-agreed like any change. The record's fields belong to the Kernel's
agreement record; this spec fixes only that the pin is by content over both the libraries and the
levels.

### 3.6 The two launch policies (planned)

Both are written in the policy object's form (the policies specification), enforced at the
Runtime's launch step.

| Name | Scope | Values | Default | Kind | Set by | Since |
|---|---|---|---|---|---|---|
| `required-skill-delivery` | entity, project, team | `refuse`, `report`; `refuse` is tighter | `refuse` | enforced at launch | the owner; a holder named by grant; a project lead may set `report` for a harness listed as unable to deliver skills (`OD-20261019-32` answer 28) | planned |
| `duty-conflict` | entity, project, team | `refuse`, `report`; `refuse` is tighter | `refuse` | enforced at launch | the owner only (`OD-20261019-32` answer 28: nobody below the owner sets `report`) | planned |

A project lead MAY set `required-skill-delivery: report` for a harness listed as unable to deliver
skills, never for all harnesses; nobody below the owner MAY set `duty-conflict: report`
(`OD-20261019-32` answer 28).

### 3.7 The `universe` setting, universe entries, team roles and standing role names (planned)

A team's `universe` setting selects the package from which seat names, titles, team-role words and
standing role names are drawn (`OD-20261019-06`, `OD-20261019-10`, `OD-20261019-12`,
`OD-20261019-16` to `OD-20261019-21`, `OD-20261019-32` answer 29).

| Element | Scope / Location | Type / Fields | Required | Default | Since | Meaning |
|---|---|---|---|---|---|---|
| `universe` | config key at `entity`, `project`, `team` | string | no | inherited from the level above | planned | the universe name (`team config set <level> <target> universe <name>`); changing it never renames existing seats (`OD-20261019-06`, `OD-20261019-10`) |
| `entry` | universe `canon.md` row | `{name, titles, relations, traits, sources}` | yes (per entry) | — | planned | one sourced canon entry; every factual claim cites a source and date, and any unsupported claim is marked `unverified`, never guessed (`OD-20261019-12`, `OD-20261019-21`) |
| `team_role` | universe `roles.md` row | `{name, base_function, capabilities, grants, skills}` | no | — | planned | a team role in the universe's vocabulary mapped onto one of the eight base functions (`OD-20261019-16`, `OD-20261019-21`, `OD-20261019-32` answer 29) |
| `role_name` | universe `roles.md` row | `{role, entry, reason, sources}` | no | — | planned | a standing entry name for a role across teams that use the universe (`OD-20261019-19`, `OD-20261019-21`) |
| seat `name` and `label` | seat record / casting output | `name` (`<entry>` in lowercase with hyphens), `label` (`Name · Title`) | yes (when cast) | next free entry in `universe` | planned | the seat's name is the entry it plays (`OD-20261019-17`), unique in its team and addressed across the entity as `name@team` (`OD-20261019-19`); re-casting changes the name while preserving the `agt_…` registry id |

Built-in universes shipped with TeamCLI MUST be public-domain only; universes from trademarked
franchises or authors' works remain user-made and private to their owner unless licensed
(`OD-20261019-06`, `OD-20261019-10`, `OD-20261019-18`).

## 4. Commands and options

At `int/0.5.1 8acb470b`, this area's built formats are read by existing Runtime and task commands,
and `OD-20261019-06`, `OD-20261019-10` and `OD-20261019-18` add the planned universe command and
`team add` naming behavior:

| Command / Option | Status | Meaning |
|---|---|---|
| `team check` | built | reports a second `leads` mark, a nickname collision and a seat name `lead` |
| `team add` / `team rename` | built | refuse `lead` as a new seat name or nickname and refuse a nickname another seat in the team carries |
| `team next` | built | skips a task record that carries `needs` |
| `team seats` | built | prints the role and the nickname |
| `team universes add <name>` | planned | adds a universe from a local list or fetches a versioned, sourced, reviewed universe package from the library API (`OD-20261019-06`, `OD-20261019-10`, `OD-20261019-18`) |
| `team config set <level> <target> universe <name>` | planned | sets the `universe` setting at `entity`, `project` or `team` level (`OD-20261018-17`, `OD-20261018-18`, `OD-20261019-06`, `OD-20261019-10`); never renames existing seats |
| `team add` (universe name selection) | planned | takes the next free entry name from the team's `universe` (or accepts a hand-chosen entry name), suggests names by role when the universe provides role hints, and numbers names (`<name>-2`) with a warning when the universe runs out (`OD-20261019-06`, `OD-20261019-10`, `OD-20261019-19`) |

The exit ids of those commands belong to their own specifications (operations and exit codes).

## 5. Rules

1. **A role is a named bundle of capability words and a skill set.** A role MUST NOT carry
   `grant`, `agree` or `create`; `leads` MAY travel in one role's bundle. *Source:* no role
   section at int/0.5.1 8acb470b; the seat's `role` is a required string
   (`src/file/sections/seats.ts`). *Proof:* none at int/0.5.1 8acb470b.
2. **A definition names no person, path, folder or company.** *Source:* no library at int/0.5.1
   8acb470b. *Proof:* none at int/0.5.1 8acb470b.
3. **Levels inherit and tighten.** A level MUST inherit the level above and MUST NOT loosen it
   except where a text says so; an overlay adds limits, never removes them. *Source:* no library
   and no overlay at int/0.5.1 8acb470b; the policy chain's tighten-only rule is
   `src/policy/resolve.ts`. *Proof:* `test/policy.test.ts` proves the policy chain only.
4. **A seat's list is its role's bundle plus its own seat grants, inside the team envelope.**
   A team grant MUST reach a seat only through a capability its role holds; a seat grant only
   narrows. *Source:* the resolver's role-bundle slot is empty at int/0.5.1 8acb470b
   (`src/permissions/who.ts`). *Proof:* `test/settings-as-policies.test.ts` proves the policy
   chain; none for the bundle.
5. **`leads` travels in a role; nothing resolves by a role's name.** A seat holds `leads` only
   because its role's bundle names it, and everything that needs the lead resolves to that seat,
   never to a seat called by a word. *Source:* at int/0.5.1 8acb470b `leads` is a per-seat boolean
   in the file, read as the roster's mark (`src/file/sections/lead.ts`,
   `src/file/sections/seats.ts`), and `lead@<team>` addresses the seat so marked. *Proof:*
   `test/check-lead-role-note.test.ts`, `test/leads-at-most-one.test.ts`.
6. **Zero or one `leads` per team.** A second mark MUST be refused, naming both seats, and the
   launch with it. *Source:* `src/file/sections/lead.ts` refuses a second mark at its line and
   names every marked seat. *Proof:* `test/leads-at-most-one.test.ts`. At int/0.5.1 8acb470b a
   file with no lead is also refused (`src/file/sections/lead.ts`: "the file has no seat that
   leads"), where this rule and the Kernel allow zero; the code is stricter at the tag.
7. **A required skill that cannot be delivered refuses; an optional one reports.** The property
   MUST belong to the binding, never to the role, and a harness MUST NOT drop a binding silently;
   a project lead MAY set `required-skill-delivery: report` only for a harness listed as unable to
   deliver skills (`OD-20261019-32` answer 28). *Source:* no `required-skill-delivery` policy at
   int/0.5.1 8acb470b. *Proof:* none at int/0.5.1 8acb470b.
8. **Incompatible positive duties fail visibly, naming both rules, and nobody below the owner sets
   `duty-conflict: report`.** *Source:* no `duty-conflict` policy at int/0.5.1 8acb470b
   (`OD-20261019-32` answer 28). *Proof:* none at int/0.5.1 8acb470b.
9. **The library rejects a skill that carries a rule or a permission.** A would-be skill
   containing a must, a may-not or a permission MUST NOT enter a library. *Source:* no library
   check at int/0.5.1 8acb470b. *Proof:* none at int/0.5.1 8acb470b.
10. **A task's `needs` grants nothing.** It MUST name only agreed skills, and a record carrying
    any is not claimable while no binding exists. *Source:* `src/commands/next.ts` (`takeable`),
    `src/tasks/format.ts` (the printed `needs`). *Proof:* `test/next.test.ts`.
11. **A nickname is unique in its team and `lead` is reserved.** A nickname MUST NOT equal
    another seat's nickname or name in the same team; equal to its own seat's name it is allowed.
    No new seat name or nickname may be `lead`; a seat already named `lead` keeps loading, and
    `team check` notes it when it does not carry the mark. *Source:* `src/file/sections/seats.ts`
    (`nicknameProblem`, `LEAD_NAME`), `src/commands/add.ts`, `src/commands/rename.ts`. *Proof:*
    `test/rename.test.ts`, `test/check-lead-name-note.test.ts`.
12. **The lead is addressed as `lead@<team>`, a nickname as `@<nickname>` or `<nickname>@<team>`.**
    *Source:* `src/commands/send.ts`, `src/file/sections/seats.ts`. *Proof:* `test/route.test.ts`.
    (The grammar is messaging's; this spec links to [messaging.md](messaging.md).)
13. **A seat rename keeps the registry id, the grants and the leases.** *Source:*
    `src/commands/rename.ts` (`renameSeatLeases`). *Proof:* `test/rename.test.ts`.
14. **A rule says what a seat must or may not do; a skill says how to do what is already
    allowed.** A mandatory step MUST split: the "must" is a rule, the skill carries the how. A
    worked example: a reviewer's scope, its write of the verdict only and its citation
    requirement are rules or constraints, while how to review well is a skill; no skill can make
    it able to merge, because merging is a capability its role does not hold. *Source:* no
    library at int/0.5.1 8acb470b. *Proof:* none at int/0.5.1 8acb470b; rule 9 is the check
    that would refuse a skill carrying a rule.
15. **The `universe` setting inherits downwards, built-in universes are public-domain only, and
    changing a team's universe never renames existing seats.** A `universe` setting at `entity`,
    `project` or `team` level MUST inherit downwards; built-in universes MUST be public-domain
    only (`OD-20261019-06`, `OD-20261019-10`, `OD-20261019-18`); and changing the `universe`
    setting MUST NOT rename existing seats. *Source:* not built at int/0.5.1 8acb470b. *Proof:*
    none at int/0.5.1 8acb470b.
16. **`team add` takes the next free name from the team's universe and numbers with a warning when
    the set runs out.** When a team has a `universe` set, `team add` MUST take the next free entry
    name in that team (while allowing a name to be chosen by hand, and optional role hints), and
    when the universe's entries are exhausted MUST number the name (`<name>-2`) and emit a warning
    (`OD-20261019-06`, `OD-20261019-10`). *Source:* not built at int/0.5.1 8acb470b. *Proof:* none
    at int/0.5.1 8acb470b.
17. **A seat's name is the entry it plays and changes on a re-cast, while the registry's agent id
    is the stable identity underneath.** A seat's name (lowercase with hyphens) and label
    (`Name · Title`) MUST come from its cast entry; on a reviewed re-cast to a different entry, the
    seat's name MUST change with the entry while the registry's agent id (`agt_…`), grants, leases
    and session history stay intact (`OD-20261019-17`, `OD-20261019-21`). *Source:*
    `src/commands/rename.ts` preserves the id, grants and leases on rename; casting-driven rename is
    not built at int/0.5.1 8acb470b. *Proof:* `test/rename.test.ts` for rename preservation; none
    for casting.
18. **Seat names are unique within a team and addressed as `name@team` across the entity.** Two
    teams in the same entity MAY use the same seat name; within a team, seat names MUST be unique,
    and cross-team addressing MUST use `name@team`, with the registry's agent id as the canonical
    identity (`OD-20261019-19`). *Source:* `src/file/sections/seats.ts`, `src/send/resolve.ts`.
    *Proof:* `test/rename.test.ts`, `test/route.test.ts`.
19. **Every team role maps onto a base function.** A team role defined in a universe's vocabulary
    MUST map onto one of the eight base functions (`orchestrator`, `operator`, `builder`,
    `reviewer`, `tester`, `documentarist`, `communication`, `architect`) so admission and
    permission checks hold underneath (`archivist` and `recorder` mapping onto `documentarist` and
    `first assistant` onto `operator`), and MAY declare its own grants, capabilities and skills
    within the team envelope (`OD-20261019-15`, `OD-20261019-16`, `OD-20261019-21`,
    `OD-20261019-32` answer 29). *Source:* not built at int/0.5.1 8acb470b. *Proof:* none at
    int/0.5.1 8acb470b.
20. **A universe's standing role names are sourced, reviewed across labs and confer no authority.**
    A universe MAY assign standing role names in its `roles.md` file, reviewed by at least the
    configured number of distinct labs other than the author's (default 2), and a standing role
    name MUST NOT confer any capability or grant (`OD-20261019-12`, `OD-20261019-19`,
    `OD-20261019-20`, `OD-20261019-21`). *Source:* not built at int/0.5.1 8acb470b. *Proof:* none
    at int/0.5.1 8acb470b.

## 6. Registries

**`policy-names`** (planned entries; not in the policy object at int/0.5.1 8acb470b):

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `required-skill-delivery` | refuse or report an undelivered required skill at launch | planned | not in `src/policy/types.ts` at int/0.5.1 8acb470b | default `refuse`; scope entity, project, team; a project lead may set `report` for a harness listed as unable to deliver skills (`OD-20261019-32` answer 28) |
| `duty-conflict` | refuse or report two incompatible positive duties | planned | not in `src/policy/types.ts` at int/0.5.1 8acb470b | default `refuse`; nobody below the owner sets `report` (`OD-20261019-32` answer 28); the error names both rules |

**`capabilities`** (the one word this area places in a role):

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `leads` | the team's lead | 0.5.0 (carried in a role: planned) | `src/file/sections/seats.ts` | one per team; carried as the file's `leads` mark at int/0.5.1 8acb470b |

**`operations`** (the lifecycle acts this area keeps out of every role, plus the planned universe operation):

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `start` | start a team or a seat | 0.5.0 | `src/commands/up.ts` | one principal: the owner, or the team's `leads` |
| `stop` | stop a team or a seat | 0.5.0 | `src/commands/down.ts` | as `start` |
| `restart` | restart a seat | 0.5.0 | `src/commands/restart.ts` | as `start` |
| `reload` | reload a seat | 0.5.0 | `src/commands/reload.ts` | as `start` |
| `add` | add a seat | 0.5.0 | `src/commands/add.ts` | owner-only base gate at the pinned revision (declared delegation paths qualified separately; `add-same-copy` is a proposed conceptual delegated form, not a command or capability); planned next-free-name selection from `universe` (`OD-20261019-06`, `OD-20261019-10`) |
| `remove` | remove a seat | 0.5.0 | `src/commands/remove.ts` | `remove-ordinary` delegated; a seat holding `grant`, `agree` or `leads` is never removed this way |
| `universes add` | add a universe from a list or package (`team universes add <name>`) | planned | proposed; not in `src/permissions/map.ts` at int/0.5.1 8acb470b | `OD-20261019-06`, `OD-20261019-10`, `OD-20261019-18` |

**`config`** (planned setting contributed to [config.md](config.md)):

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `universe` | the universe from which a team draws seat names, titles, team-role words and standing role names | planned | not in `src/` at int/0.5.1 8acb470b | scope `entity`, `project`, `team`, inherited downwards; changing it never renames existing seats (`OD-20261019-06`, `OD-20261019-10`) |

**`briefs`** (the general seat brief, first record under OD-20261018-08):

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `general` | the default seat brief: what a seat is, who it reports to, and the one rule — tell your lead in one line when you finish or are blocked | 0.5.1 (delivery built on an unmerged feature branch ahead of int/0.5.1 8acb470b; the registry record planned) | `scripts/brief.ts` (unmerged feature branch; not at int/0.5.1 8acb470b) | built in; delivered by `up`, `add`, `restart`, `reload`, `register` and `rename` as a claim and a signed message record by drop, never typed, and by `team brief rollout --apply` to a team already up; the claim in the session's `briefs` names the delivery's incarnation, runtime epoch, sha256, expected id, attempt and stage; overridable by an entity or a project (planned); `role-and-trade` and `start` follow |

## 7. Open points

- **No library, no role section, no bundle.** A seat's `role` is a required string recorded and
  never decides; the resolver's bundle is empty, so capabilities come from grants alone.
- **No binding, no adapter, no delivery report.** A task record's `needs` is printed and skipped;
  no skill is bound, delivered or reported.
- **The two policies are absent from the policy object.** `required-skill-delivery` and
  `duty-conflict` are decided in catalogue form and not in `src/policy/types.ts`.
- **Library distribution and layering in detail**: how a level points at a library, how a shared
  library is published and imported, and how an overlay names what it overrides.
- **The neutral format and each adapter's translation**, and the full set of context triggers.
- **Inheritance**: how it is written, how deep it may go, and whether a child may narrow a
  parent's capabilities (it never widens).
- **The list of harnesses unable to deliver skills**: settled by `OD-20261019-32` answer 28 that a
  project lead may set `required-skill-delivery: report` for a harness on that list and nobody
  below the owner sets `duty-conflict: report`; the concrete harness list remains for the build.
- **The Kernel's own line** on an unresolvable composition being refused at launch as the
  Kernel's act (the round's question Q1).
- **The lead name**: `lead` is reserved, and a team whose lead seat is still named `lead` is noted
  by `team check` with the rename that fixes it; whether the name is ever refused outright is
  open.
- **Zero leads**: the text and the Kernel allow a team with no lead; the file at int/0.5.1
  8acb470b refuses one, so the code is stricter. No seat resolves `lead@<team>` in such a team.
  The open point is kept and nothing is decided here.
- **Universe naming details (`OD-20261019-06`, `OD-20261019-10` to `OD-20261019-21`)**: how
  numbered exhaustion names (`<name>-2`) interact with reviewed canon and standing role names, how
  overlapping target names are ordered safely during a re-cast rename, and where multi-team
  casting files live inside a universe package.

## Revision log

- **Draft** (the writer, 2026-10-18): lifted from 009 Roles and Skills (draft 2) and its
  0.5.1 catalogue annex; read at int/0.5.1 8acb470b; the built formats (the seat's role, nickname
  and lead mark, the task's `needs`, the rename) are separated from the planned ones, and every
  rule cites the code or says "proof: none".
- **Draft, amended** (the writer, 2026-10-18): §6 gains the `briefs` registry, whose first
  record is `general`, the general seat brief shipping in 0.5.1 as the built-in default under
  OD-20261018-08; its drop delivery is on an unmerged feature branch ahead of int/0.5.1, its
  registry record planned.
- **Draft, amended** (the writer, 2026-10-19): added the planned `universe` setting, `team
  universes add` command, `team add` next-free-name behavior, `communication` base role, team-role
  `base_function` mapping, standing role names, and rules 15 to 20 (`OD-20261019-06`,
  `OD-20261019-10`, `OD-20261019-12`, `OD-20261019-15` to `OD-20261019-21`); and folded a Phase B
  pre-round review on the §6 `add` row (`owner-only` base gate at the pinned revision, with declared
  delegation paths qualified separately and `add-same-copy` a proposed conceptual form).
- **Draft, amended** (the writer, 2026-10-19): folded `OD-20261019-32` answers 28 and 29 (`architect`
  added to the base functions, `archivist` and `recorder` mapped onto `documentarist` and `first
  assistant` onto `operator` as team roles, and project-lead vs owner setter rules for
  `required-skill-delivery: report` and `duty-conflict: report` in §2, §3.2, §3.6, §3.7, §5 rules
  7, 8 and 19, §6, and §7).
