---
created: 2026-10-19
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: the Planning v2 text (chapter J, and chapter K's library commitment); the roles-and-skills v2 text (§12)
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: casting

## 1. Scope

This spec defines the universe package and its files (canon, roles, per-team casting, review), the
canon entry, the cast record, the casting review record, the `universe` setting and the planned
casting commands (`team universes add`, `team cast`, `team cast --propose`). It follows the owner
decisions OD-20261019-06 and OD-20261019-10 to OD-20261019-21, and the universe project's naming
method and package README, cited by their words and never by link. Nothing in this area is built at
the tag: no command, format or rule here has an implementation source, and every proof reads "none
at the tag". The actor side's inputs (cost, quota, measured results) stay with the budgets and
analysis specs; the swap queue that applies a re-cast stays with the Runtime; seat identity and
routing stay with [registry.md](registry.md); the `universe` key's levels, inheritance and
application rule stay with [config.md](config.md).

## 2. Terms

- **universe:** the world a team draws its seat names, titles and team-role words from — mythology,
  history, astronomy, a film saga, a director's films, a series or a book. A setting at entity,
  project or team level, inherited downwards (OD-20261019-10).
- **sub-universe:** a bounded part of a universe — one work or era — whose titles and relations
  must hold at the stated story point.
- **canon:** the sourced register of a universe's entries; it separates what a source establishes
  from a reading of it.
- **entry:** a name with its titles, relations and relevant traits, each sourced; it supplies the
  evidence for a seat's name and title (OD-20261019-21).
- **name:** a seat's human-readable name, drawn from its selected entry, lowercase with hyphens;
  never the seat's stable identity.
- **title:** a sourced rank, office or occupation attached to an entry at a stated story point; a
  seat's label is `Name · Title`.
- **role (base function):** one of the tool's base functions — orchestrator, operator, builder,
  reviewer, tester, documentarist, communication, architect (OD-20261019-32, answer 29).
- **team role:** a team's word for a job in its universe, mapped onto a base function
  (OD-20261019-16); it may add its own grants, capabilities and skills, and supplies no authority
  by itself.
- **role name:** a universe's standing seat name for a role, the same in every team that uses that
  definition (OD-20261019-19).
- **casting:** two choices kept apart and recorded separately (OD-20261019-11, -21): the actor
  choice — which lab, model, version and effort fills a seat — and the entry choice — which
  universe entry gives the seat its name.
- **cast record:** one team's casting as a written file: each seat's function mapped to its entry
  with the reason, coherent as a set (OD-20261019-12).
- **era:** the stated story point a casting holds to.
- **lab:** the vendor whose model an agent runs on; review independence is counted in labs, not in
  reviewers (OD-20261019-20).
- **source:** a reference a claim is checked against, read on the day it is cited.

The word **character** is reserved for a later scope and names nothing here (OD-20261019-21); the
decisions that used it are read with "entry" or "name" in its place.

## 3. Formats

Every format in this section is planned; no file of these shapes is read or written by the tool at
v0.5.0 (52db9b75). The shapes follow the universe project's package README and naming method by
their words.

### 3.1 The universe package

- **Where:** a folder per universe, kept locally or privately today; an API library serving
  packages is a decided direction, not an implementation claim (OD-20261019-18).
- **Who writes it:** the team or entity that makes the universe; built-in packages ship with the
  tool and are public-domain only (rule 12).

| File | Required | Contents |
|---|---|---|
| `canon.md` | yes | one row per entry (§3.2) |
| `roles.md` | no | team roles mapped to base functions, and standing role names with their reasons and canon sources (OD-20261019-16, -19); where the universe defines none, the file is absent rather than filled by invention |
| `casting.md` | one per team | a cast record (§3.3) |
| `review.md` | yes | the casting review record (§3.4) |

The package carries its **version**, its **sources** and its **review record**, so a library fetch
and a local copy can be checked the same way (OD-20261019-18). A universe may hold sub-universes as
folders of their own, for titles and relations that must hold at one story point.

Example (a Greek mythology package, public domain):

```text
greek-mythology/
  canon.md        # entries of the Olympian era, each claim sourced and dated
  roles.md        # the standing communication name; a team role mapped to a base function
  casting.md      # team beacon's cast record
  review.md       # the review record of beacon's casting
```

### 3.2 The entry (a canon.md row)

One row per entry. Every factual cell names its source and the day it was read; a claim no source
supports is marked **unverified**, never filled by guessing (OD-20261019-12).

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| entry | string | yes | — | planned | the display spelling, as the sources give it |
| name | string | yes | — | planned | the seat-name form: lowercase with hyphens; unique within a team |
| titles | string | yes | — | planned | canonical titles and when in the story each holds |
| relations | string | no | — | planned | the relations that bear on a cast set; "none needed" when the casting uses none |
| traits | string | yes | — | planned | the traits that bear on a function, with their story point |
| source | reference + read date | yes, per claim | — | planned | one per factual claim; an unsourced claim is marked unverified |

Example rows (Greek mythology, the Olympian era; sources read 2026-10-19):

| Entry | Titles and when they hold | Relations | Traits |
|---|---|---|---|
| Hera | Queen of the Gods, from the Olympian order's establishment (Theogony, read 2026-10-19) | consort of the king of the gods (Iliad 14, read 2026-10-19) | presides and exacts oaths; leadership with an exacting memory (Iliad 14–15, read 2026-10-19) |
| Ariadne | keeper of the labyrinth's thread, at the Cretan episode (Plutarch's life of Theseus, read 2026-10-19) | daughter of Minos (same source) | the thread that guides out of the maze: operational guidance through a structure (same source) |
| the Cyclopes | smiths of the thunderbolt, from the war against the Titans (Theogony, read 2026-10-19) | uncles of the Olympians (same source) | forged the king of the gods' weapon: direct construction evidence (same source) |
| Nemesis | goddess of due measure (Works and Days, read 2026-10-19) | none needed | weighs deeds and apportions what is due: judgment on evidence (same source) |
| Chiron | tutor of heroes, from the heroes' youth (Iliad 11, read 2026-10-19) | fostered and taught the heroes (same source) | keeps craft knowledge and teaches it: documentation and instruction (same source) |
| Pheme | personified report (Hesiod, Works and Days 760–764, read 2026-10-19) | none needed | report is readily raised and spreads through a people when many voice it (same source); this is the canonical claim, not a team function |

### 3.3 The cast record (a team's casting.md)

- **Who writes it:** the casting's author; the file owner applies it after review (rule 6).

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| team | string | yes | — | planned | the team the casting is for |
| universe | string | yes | — | planned | the universe, or the sub-universe, the entries come from |
| era | string | yes | — | planned | the story point the set holds to |
| seats | table | yes | — | planned | one row per seat: base function and any team role; lab/model baseline; selected entry; proposed name and exact label; the reason for the fit |
| relations | string | no | — | planned | the entry relations that matter across the set, noted as lore — never as permissions or reporting lines |
| identities | table | no | — | planned | the stable registry agent id (`agt_…`) under each renamed seat, so routing and history survive a re-cast (OD-20261019-17) |

Example (team beacon, universe Greek mythology, era "the Olympian order after the Titans' fall"):

| Seat function | Baseline lab / model | Entry | Proposed name and label | Why it fits (team-level interpretation) |
|---|---|---|---|---|
| orchestrator | lab A / model a | Hera | `hera` — Hera · Queen of the Gods | presiding over the Olympian order fits coordinating the team |
| operator | lab B / model b | Ariadne | `ariadne` — Ariadne · of the Labyrinth | the guiding thread fits operational legwork |
| builder | lab B / model b | a Cyclops | `cyclops` — Cyclops · Smith of the Thunderbolt | forging the thunderbolt is direct construction evidence |
| reviewer | lab C / model c | Nemesis | `nemesis` — Nemesis · of Due Measure | weighing deeds and apportioning what is due fits review |
| documentarist | lab C / model c | Chiron | `chiron` — Chiron · Tutor of Heroes | teaching the crafts fits keeping the team's knowledge |
| communication | lab A / model a | Pheme | `pheme` — Pheme · the Report | interpreting the sourced report that spreads through a people as a fit for team communication; speaking on team channels is the proposed job, not a canon claim |

A fictional title is never evidence of model ability (rule 4): the actor columns stand on the actor
inputs, the entry columns on the canon.

### 3.4 The casting review record (a universe's review.md)

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| version | string | yes | — | planned | the package version and the files reviewed |
| author | lab | yes | — | planned | the authoring lab, per file |
| reviewers | table | yes | — | planned | one row per reviewer: lab, verdict, evidence (sources opened and read, scope checked) |
| verdicts | enum per file | yes | — | planned | PASS, PASS WITH CHANGES (the exact corrections), or NO (the blocker) |
| corrections | list | no | — | planned | each required correction and its disposition; the corrected proposal that passed is named |
| doubts | list | no | — | planned | what remains unverified or unresolved |
| assistance | list | no | — | planned | research or structural help, recorded apart from the independent verdicts — assistance never counts as one (OD-20261019-12) |

Example (beacon's casting, authored by a lab A seat; reviewers from labs B and C under the default
`review-labs-min` of 2):

| Reviewer | Lab | Verdict | Evidence |
|---|---|---|---|
| first reviewer | B | PASS | every canon claim opened against its cited source on 2026-10-19; coverage of all six seats; team-local name uniqueness |
| second reviewer | C | PASS WITH CHANGES | required the era phrase on the builder row; the correction was folded, then passed |

## 4. Commands and options

No command of this area exists in `contract/cli.json` at the tag; every synopsis here is planned
and contributes no exit-code rows.

```sh
team universes add <name>     # make a universe for the entity from a list of entries (a name, titles, relations, traits, role hints), or fetch one from the library by name
team cast [--team|--plan]     # show the cast: which agent stands which seat, with the reason for each choice, pointing at the canon file
team cast --propose           # propose a better cast, with its reasons
```

The `universe` value itself is a setting, read and changed through the configuration commands
(`team config set team <team> universe <name>`); its levels, inheritance and application rule live
in [config.md](config.md) §6. Applying a proposal goes through the configuration commands and the
swap queue, with the owner's go where a policy asks for it (OD-20261019-11). Re-casting — a seat
out of quota, repeatedly failing, or a changed plan — follows the queued-swap rules
(OD-20261019-01 to -03).

## 5. Rules

1. **A universe is a package** (OD-20261019-18): its canon, its team roles where it defines them,
   and its reviewed per-team castings. Every package MUST carry its version, its sources and its
   review record. Proof: none at the tag.
2. **A source per claim** (OD-20261019-12): every factual claim in a canon entry MUST name its
   source, read on the day. A claim with no source MUST be marked unverified; a gap MUST NOT be
   guessed away. Proof: none at the tag.
3. **The cast record is coherent as a set** (OD-20261019-12): a casting MUST map each seat's
   function to exactly one entry with a stated reason, cover every seat once, state its era, and
   note the relations that bear on the set. Proof: none at the tag.
4. **The actor choice and the entry choice are separate records** (OD-20261019-11, -21). The actor
   choice MUST weigh each model's abilities for the role; cost and the quota and pace left per
   account; lab diversity; the project's visibility; the owner's rules; and, once measured results
   exist, rounds to pass, work returned and cost per task. A fictional title MUST NOT be read as
   evidence of model ability. Proof: none at the tag.
5. **Review before use** (OD-20261019-20, -12): the naming method and every casting MUST be
   reviewed by at least N distinct labs other than the author's, where N is the `review-labs-min`
   setting (entity, project or team level; default 2). Several reviewers from one lab count as one
   lab. No team is renamed under a new universe before the method has passed its review. Proof:
   none at the tag.
6. **Application is the file owner's step** (OD-20261019-12): a casting is applied to a team file
   only after its review passes, and only by the file's owner; neither the proposal nor a review
   grants permission to edit another team's file. Proof: none at the tag.
7. **Names are unique within a team** (OD-20261019-19, amending -06): two teams MAY use the same
   entry name; across the entity a seat is addressed as `name@team`, and its stable identity is the
   registry's agent id. Proof: none at the tag.
8. **A seat's name is the entry it plays** (OD-20261019-17): a reviewed re-cast renames the seat
   when its selected entry changes, preserving the registry id; a name is not a leftover from an
   earlier cast. Changing the `universe` setting alone MUST NEVER rename existing seats
   (OD-20261019-06, -10). Proof: none at the tag.
9. **Name and label form** (the naming method, OD-20261019-21): the name is the entry's name in
   lowercase with hyphens; the label is `Name · Title` in the reviewed spelling, the title at the
   stated story point. Proof: none at the tag.
10. **A team role maps onto a base function** (OD-20261019-16, -21): a universe MAY define
    team-role words and standing role names, sourced and reviewed like the rest of its canon; a
    name, rank or team role supplies no authority — admission and permissions stay checkable
    against the base function underneath. Proof: none at the tag.
11. **New seats draw from the universe** (OD-20261019-06, qualified by -10, -12, -17 and -19):
    adding a seat takes the next free name from the team's universe; a hand-chosen name is a
    reviewed entry name; exhaustion yields a numbered name with a warning. Availability alone is
    not permission to apply a name. Proof: none at the tag.
12. **Rights come first** (OD-20261019-06, -10, -18): built-in universes MUST be public-domain
    only; a franchise's or an author's universe stays user-made and private to its owner, and MUST
    NOT be copied to a public repository, distributed, sold or served by a public API without a
    licence from the rights holder. The library begins with a free public-domain API; a paid tier
    MUST wait for both legal advice and ten public-domain universes in real use, and sets no price
    or licence now (OD-20261019-33, answer 27). Proof: none at the tag.

## 6. Registries

The rows this area contributes, in each registry's row shape.

### registries/policy-names.md

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `review-labs-min` | the least number of labs, other than the author's, that review the naming-method text and every casting | planned | this area's proposed policy; not in the policy catalogue | entity, project and team levels; default 2; counts labs, not reviewers — the review-count setting is a different one |

### registries/operations.md

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `cast` | shows the cast — which agent stands which seat, with the reason for each choice — and `--propose` proposes a better one; applying a proposal goes through the configuration commands and the swap queue, with the owner's go where a policy asks for it | planned | proposed; no command-map row | decided 2026-10-19 (OD-20261019-11); a cast is reviewed before it applies |
| `universes add` | makes a universe for the entity from a list of entries (a name, titles, relations, traits, role hints), or fetches one from the library by name; built-in universes are public-domain only | planned | proposed; no command-map row | decided 2026-10-19 (OD-20261019-10) |

### config.md's proposed key registry

| key | levels | type and allowed values | default | applies |
|---|---|---|---|---|
| universe | team, project, entity | a universe name: a built-in public-domain universe, or the entity's own made with `team universes add` | none (plain seat numbering) | at once; the next seat addition draws the next free name from it — a change never renames existing seats |

No exit-code, capability, event-kind, cli-range, delivery-leg or seat-state rows come from this
area at the tag.

## 7. Open points

1. **Era coherence:** whether a mixed-era ensemble may pass, and under what per-seat snapshot
   conditions; the worked example the naming method records passed with a snapshot per seat, which
   settles no general rule.
2. **Name spelling:** how punctuation, accents, transliteration, aliases and shortened forms become
   the lowercase-hyphen name beyond an approved table.
3. **Exhaustion and repeated functions:** how numbered names fit the canon and review requirements,
   and how several seats serving one function receive distinct names within a team.
4. **Re-casting review scope:** when a model-only change needs a naming review, and which changes
   to canon, roles or titles take a full review rather than a recorded delta review.
5. **Conflicting sources:** how sources are ranked when they disagree, and when an unverified claim
   may remain in a passed package without supporting the chosen name or title.
6. **Package layout and versions:** where several teams' cast records live, how sub-universes
   inherit entries and role names, and how library versions are updated.
7. **Applying a rename:** the collision-safe ordering, alias handling and recovery when target
   names overlap existing names; the stable registry identity is required, the mechanism
   unspecified.
8. **The library's business model:** pricing, licensing and any paid tier beyond the settled
   constraints of rule 12 remain for planning (OD-20261019-18).
9. **Seat and agent:** the explanation of a seat as a persistent place and an agent as a connection
   to a model was recorded under OD-20261019-22, which is revoked; it stands as an explanation for
   review, not a decision, and settles no terms here.

## Revision log

- **Draft** (the writer, 2026-10-19): from the owner decisions OD-20261019-06 and OD-20261019-10
  to -21, with the library constraint of OD-20261019-33 (answer 27), and the universe project's
  naming method and package README, cited by their words and never by link; every format, command
  and rule is planned, with nothing of the area built at v0.5.0 (52db9b75); examples come from the
  public-domain Greek universe only.

- **Phase A review fold** (2026-10-19): architect added as the eighth base function under OD-20261019-32, answer 29; Pheme’s source corrected to Hesiod, Works and Days 760–764, with the canonical report claim separated from the team-level role-fit interpretation in the cast example. All formats, commands and rules remain planned.
