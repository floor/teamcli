---
created: 2026-10-18
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: Kernel amendment 02 Policies
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: Policies

## 1. Scope

This specification defines the policy object — a named rule with a value, set at one level by a named setter — its four signed level sources, the closed catalogue of names the release owns with defaults and tightness directions, the commands that read and write it, the resolver that walks the chain, and the gate-lifting runtime. The refusal the object backs is the Kernel's map's, not this specification's. The catalogue's prose (what each name means, how to add one) stays in the catalogue, the living page; this specification is the code's shape.

## 2. Terms

- `policy`: one named rule with a value, set at one level, by a named setter, on a date, with an optional expiry and a kind (`src/policy/types.ts`).
- `level`: one of entity, project, team, seat — the four inheritance levels, outermost first.
- `kind`: enforced or advised. Enforced names are a closed, release-owned vocabulary; advised names may be the catalogue's or a project's own.
- `chain`: the four sources walked outermost to innermost; the effective value is the innermost unexpired declaration that is within every outer one.
- `within`: the tighten-only test — a lower level's value must be tighter than or equal to the higher's, judged per name (`isWithin`).
- `gate-lifting`: a policy whose absent or expired value reads as `off` — the default never silently stands in when a level spoke (`gateLifting`).
- `domain tag`: the constant prefix a signature covers, `POLICY_DOMAIN` = `'team-policy-v1\n'`, so a signed policy verifies as nothing else.
- `generation`: the owner key store's signing sequence, one per source write.
- `gate lift`: the `gate-lift` policy (in code: `dev-mode`, until the rename ships) lifting the caller gate of nine everyday operations; the compatibility environment variable is honoured only while no value governs.

## 3. Formats

### 3.1. The policy object (built)

One declaration at one level, as Kernel amendment 02 §2.1 requires it, carried in code as `Policy` (`src/policy/types.ts`):

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `name` | canonical name | yes | — | 0.5.0 | Kebab-case; snake-case aliases are normalized to it at load |
| `value` | 'on'/'off', boolean, number, string, or an ordered list | yes | — | 0.5.0 | What the name is set to at this level |
| `level` | entity, project, team, seat | yes | — | 0.5.0 | Where it is set |
| `setter` | string or null | yes | — | 0.5.0 | Who set it; the owner in 0.5.0, or null for an unsigned legacy `delivery_order:` declaration |
| `date` | ISO 8601 or null | yes | — | 0.5.0 | When set; null only for unsigned legacy declarations |
| `expiry` | ISO 8601 or null | no | null | 0.5.0 | When the declaration expires; an expired declaration is unset at its level |
| `kind` | enforced or advised | yes | — | 0.5.0 | Fixed by the defining text, not chosen at write |
| `target` | id | no | — | 0.5.0 | What the signature covers: entity name, project id, team id, or agent id |
| `generation` | integer | no | — | 0.5.0 | The signing sequence of the write |
| `signature` | Ed25519 | no | — | 0.5.0 | Over `POLICY_DOMAIN` = `'team-policy-v1\n'` |

On disk in a signed source the entry carries `value`, `setter`, `date`, `expiry`, `kind`, `target`, `generation`, `signature` under the policy's name (`SignedPolicyDiskEntry`, `src/policy/sources.ts`); `name` is the key it sits under, `level` is which of the four files it sits in. A record that does not verify under the domain tag is not in force.

### 3.2. The four level sources (built)

One signed source per level, each read as a `policies:` map (`src/policy/sources.ts`):

| Level | File | Where |
|---|---|---|
| entity | `entities.yaml` | `<home>/.config/team/entities.yaml`, under `<entity>.policies` |
| project | `projects.yaml` | `<home>/.config/team/projects.yaml`, under `projects.<projectId>.policies` |
| team | `team.yaml` | the team root's `.agents/team.yaml`, owner `policies:` section |
| seat | agent file | `<home>/.config/team/agents/<agentId>.yaml`, under `policies` |

Writer: the owner only, at `team policy set` / `team policy unset` (§4). A source that cannot be read, verified or ordered fails closed: nothing is lifted on it, the default does not silently stand in, and the run says why in its log.

### 3.3. The catalogue (built; the names the release owns)

Kinds, allowed levels, release defaults and tightness directions, from `POLICY_CATALOGUE` at the tag (`src/policy/types.ts`, defaults sourced from `src/settings/inherit.ts`):

| Name | Kind | Levels | Default | Tighter is | Note |
|---|---|---|---|---|---|
| `gate-lift` | enforced | entity, project, team | `off` | off; a nearer expiry is tighter than a later one or none | gate-lifting; in code `dev-mode`, until the rename ships; excludes the seat level |
| `seats-cross-teams` | enforced | entity, project, team, seat | from the settings fallback | off | — |
| `state-trace-window-seconds` | enforced | entity, project, team, seat | from the settings fallback | shorter or equal | — |
| `state-blind-after-seconds` | enforced | entity, project, team, seat | from the settings fallback | shorter or equal | — |
| `state-hook-working-seconds` | enforced | entity, project, team, seat | from the settings fallback | shorter or equal | — |
| `liveness-idle-lead-seconds` | enforced | entity, project, team, seat | from the settings fallback | shorter or equal | — |
| `liveness-idle-owner-seconds` | enforced | entity, project, team, seat | from the settings fallback | shorter or equal | — |
| `delivery-order` | enforced | entity, project, team, seat | the legs order fallback | dropping or reordering channels the higher level holds; adding one it excludes is not within | `socket-accepted` is not available in this release |
| `development-mode` | advised | entity, project, team | `local-fast` | unordered: a lower level chooses (`lowerLevelChooses`) | values `local-fast` or `pr-per-change` |
| `shared-checkout-hygiene` | advised | project, team | `on` | on | — |
| `seat-numbering` | advised | entity, project, team | from the settings fallback | unordered: a lower level chooses | width 1–4 digits or `auto`, plus separator, as one canonical string |
| `pane-conduct` | advised | entity, project, team | `on` | on | — |
| `client-grant-max-duration` | enforced | entity, project | `send=7d;up=90d;bundle=90d` (the limits it replaced) | a shorter cap, per kind; `none` (no end date) is the loosest | how long a new client grant may last; a bare value names every kind, `send=30d;up=none;bundle=90d` names each; `1d` to `3650d` or `none`; set at the entity (`entities.yaml`) or the project (`projects.yaml`), never lower; an unreadable chain refuses a new grant; see [How long a client grant lasts](../concepts/client-grant-duration.md) |
| `board` | advised | project | `''` | equal | a tracker pointer |
| `review-terms` | advised | project | `''` | equal | — |

Eight enforced names, six advised. Snake-case spellings are normalized to canonical kebab-case at load (`POLICY_NAME_ALIASES`); seconds values parse as integers or `120s`-style strings; `delivery-order` parses as a comma-separated or listed permutation of the delivery legs with no duplicate and refuses `socket-accepted` in this release. A name in the catalogue may not be set at a level it does not allow, and the refusal names the allowed levels.

### 3.4. Reading it back

`team policy` lists the effective policies with the value in force and where it comes from; `--seat` reads a seat's chain, `--file` names the team file, `--json` machine-reads the same. The write commands plan before they write: `--dry-run` reaches exactly what a real run would refuse and writes nothing.

## 4. Commands and options (built)

From `contract/cli.json` at the tag:

```text
team policy [--seat <name>] [--file <path>] [--json]
team policy set <level> <name> <value> [--until <iso>] [--kind <enforced|advised>] [--entity <id>] [--project <id>] [--seat <name>] [--file <path>] [--dry-run] [--json]
team policy unset <level> <name> [--entity <id>] [--project <id>] [--seat <name>] [--file <path>] [--dry-run] [--json]
```

`<level>` is one of entity, project, team, seat; `seat` is given as `--seat <name>` or as the level word `seat:<name>`. Exit codes from `contract/exit-codes.json`:

| id | code | meaning |
|---|---|---|
| `policy.done` | 0 | the effective policies were listed, updated, or planned |
| `policy.refused` | 1 | a non-owner attempted set or unset, a lower level loosened a higher level, or a source failed verification |
| `policy.invalid` | 2 | the team file, policy name, or value is invalid |
| `policy.invocation` | 2 | the invocation can't be read |

## 5. Rules

1. **Only the owner sets and unsets.** A non-owner's `policy set` or `policy unset` MUST be refused with `policy.refused`; in 0.5.0 there is no grant that carries the setter. *Source:* `src/commands/policy.ts`, `contract/exit-codes.json`. *Proof:* `test/policy.test.ts`.
2. **One signed source per level.** An entity policy lives under its entity, a project under its project id, a team in its `.agents/team.yaml` owner section, a seat in its agent file; every write is signed under `POLICY_DOMAIN` with the target and generation covered. *Source:* `src/policy/sources.ts`. *Proof:* `test/policy.test.ts`.
3. **A lower level may only tighten.** A declaration that is not within every outer level's MUST be refused at write with `policy.refused`; the tightness direction is per name (§3.3). The exception is the names whose defining text says a lower level chooses (`development-mode`, `seat-numbering`). *Source:* `POLICY_CATALOGUE`'s `isWithin`, `lowerLevelChooses`. *Proof:* `test/policy.test.ts`.
4. **The innermost unexpired declaration wins.** An expired declaration is unset at its level; the chain reads the next one out. *Source:* `src/policy/resolve.ts`. *Proof:* `test/policy.test.ts`.
5. **Gate-lifting policies fail to off.** A gate-lifting name with no effective value reads as `off` — the default never silently stands in for a level that spoke and expired. *Source:* `gateLifting` in the catalogue, `src/dev_mode.ts`. *Proof:* `test/dev-mode-gates-matrix.test.ts`.
6. **An unreadable source fails closed.** A source that cannot be read, verified or ordered lifts nothing and sets nothing; the run reports it rather than falling back. *Source:* `src/policy/sources.ts`, `src/dev_mode.ts`. *Proof:* `test/dev-mode-gates-matrix.test.ts`.
7. **Gate-lifting lifts nine operations' caller gate, and nothing else.** With `gate-lift` `on`, the caller gate of `up`, `down`, `remove` of an ordinary seat, `register`, `add`, `restart`, `init`, `reload`, `rename` — the owner's seven (OD-20261017-01; exactly those, OD-20261017-08) plus two more, read as the same words — folds into a warning on the error stream with a log line per use, in every running team; it never reaches `grant`, `delegate`, `revoke`, `approve`, `create`, `agree`, `leads`, a lead seat's removal or add, `remove --abandon`, `broker`, `tempo`, or a delegate's file-editing `add`. *Source:* `DEV_MODE_OPERATIONS`, `src/dev_mode.ts`. *Proof:* `test/dev-mode-gates-matrix.test.ts`.
8. **The environment variable is a migration trigger only.** `TEAMCLI_DEV_MODE=1` is honoured only while no `gate-lift` value is set anywhere in the chain; once a value governs — an expired declaration included — the variable is ignored and its ignoring logged once, and the first command after an expiry names it. *Source:* `src/dev_mode.ts`. *Proof:* `test/dev-mode-gates-matrix.test.ts`.
9. **Names normalize at load.** Snake-case spellings of catalogue names are read as their canonical kebab-case names; a value that does not parse for its name is refused with `policy.invalid`. *Source:* `normalizePolicyName`, the per-name `parseValue`. *Proof:* `test/policy.test.ts`.
10. **The entity's model rule is an entity-level policy (proposed).** The rule for which models may run on which seats MUST be held as one policy at entity level, and the tool MUST carry it out in every team of the entity: it lists the seats that break it, proposes each replacement, swaps one by one with the handover and reads the status bar back, and `team check` and `team watch` flag every breach. *Decided by:* OD-20261019-01 (Kernel amendment 02's fold). *Proof:* none at the tag — the name is not in `src/policy/types.ts`.
11. **A queued model swap waits, and the wait is set (proposed).** A swap queued under the model rule waits for the seat's task boundary; after the set wait — the `swap-wait-seconds` policy, 30 minutes proposed — it MUST run at the next pause between two turns, and the run MUST be logged; a broken seat swaps at once. *Decided by:* OD-20261019-03, with -02's task boundary. *Proof:* none at the tag.
12. **The minimum review labs are a setting (proposed).** The naming-method text and every casting MUST be reviewed by at least the number of labs the `review-labs-min` policy sets: entity, project or team level, default 2, labs other than the author's; the setting counts labs, not reviewers — Quality's `review-count` is another setting. *Decided by:* OD-20261019-20. *Proof:* none at the tag.

## 6. Registries

### registries/policy-names.md

Rows for the fourteen names in force at the tag (in-tool table), one line per entry in the row shape (entry | meaning | since | source at the tag | note):

- `gate-lift` | lifts the caller gate of the nine everyday operations | 0.5.0 | `src/policy/types.ts` | gate-lifting; in code `dev-mode`, until the rename ships; off by default; excludes the seat level
- `seats-cross-teams` | whether a seat may sit on more than one team | 0.5.0 | `src/policy/types.ts` | off is tighter
- `state-trace-window-seconds` | how fresh a trace must be for a seat to read as working | 0.5.0 | `src/policy/types.ts` | shorter is tighter
- `state-blind-after-seconds` | how long unknown reads as blind | 0.5.0 | `src/policy/types.ts` | shorter is tighter
- `state-hook-working-seconds` | how long a hook's working signal holds | 0.5.0 | `src/policy/types.ts` | shorter is tighter
- `liveness-idle-lead-seconds` | idle this long tells the lead | 0.5.0 | `src/policy/types.ts` | shorter is tighter
- `liveness-idle-owner-seconds` | idle this long tells the owner | 0.5.0 | `src/policy/types.ts` | shorter is tighter
- `delivery-order` | the legs a send tries, in order | 0.5.0 | `src/policy/types.ts` | `socket-accepted` unavailable in this release
- `development-mode` | how building work moves to the trunk | 0.5.0 | `src/policy/types.ts` | advised; a lower level chooses; `local-fast` default
- `shared-checkout-hygiene` | the shared checkout's hygiene rules | 0.5.0 | `src/policy/types.ts` | advised; on is tighter
- `seat-numbering` | the width and separator of a seat's number | 0.5.0 | `src/policy/types.ts` | advised; a lower level chooses
- `pane-conduct` | the pane conduct rules | 0.5.0 | `src/policy/types.ts` | advised; on is tighter
- `client-grant-max-duration` | the longest a new client grant may last, per kind (send, up/down, bundle), up to `none` (no end date) | not yet released | `src/policy/types.ts`, `src/client/duration-policy.ts` | enforced; entity and project level; default `send=7d;up=90d;bundle=90d`; shorter is tighter, `none` is loosest
- `board` | the team's tracker pointer | 0.5.0 | `src/policy/types.ts` | advised; project level
- `review-terms` | the terms a review runs under | 0.5.0 | `src/policy/types.ts` | advised; project level

Planned rows (decided in texts, not in code at the tag):

- `forward-only-install` | the install step refuses an older version without a declared rollback | planned | 010 Workflow §2d | advised until the Kernel names the gate
- `round-close-sequence` | `round close` refuses to skip or reorder a step | planned | 010 Workflow §2d | advised until the round is a command
- `model-rule` | the entity's rule for which models may run on which seats, carried out in every team of the entity | planned | Kernel amendment 02's fold (OD-20261019-01) | entity level only; a breach flagged by `team check` and `team watch`
- `swap-wait-seconds` | how long a queued model swap waits at the task boundary before running at the next pause between two turns, logged | planned | Kernel amendment 02's fold (OD-20261019-03) | 30 minutes proposed; a broken seat swaps at once
- `review-labs-min` | the least number of labs, other than the author's, that review the naming-method text and every casting | planned | Kernel amendment 02's fold (OD-20261019-20) | default 2; labs, not reviewers (`review-count` is another setting)

## 7. Open points

1. **No ledger record yet**: a policy change is signed in its source but not written to the ledger as an event; the object's §2.11 record is decided and not built.
2. **No owner notice yet**: a set or unset does not tell the owner beyond the log line.
3. **No non-owner setters yet**: the amendment's grant-carried setter is decided and not built; the owner is the only setter in 0.5.0.
4. **Advised showing**: whether an advised policy's value is shown where it is followed (briefs, checks) is not built.
5. **One value per name per level**: the code holds one value; two declarations of one name at one level are a YAML error, so the amendment's "the stricter stands" rule has no case to decide at the tag.
6. **A project's own advised names**: the kind allows them; the catalogue holds only the release's fourteen, and what a name outside the catalogue gates is its defining text's business, nothing in the code's.
7. **The seat level's reach**: a seat-level policy binds the named seat only; whether a seat may read every level above it in one listing (`--seat` today) or only its effective values is a display question still open.

## Revision log

- **Draft** (the writer, 2026-10-18): rebuilt for Kernel amendment 02 at `v0.5.0 (52db9b75)` from the code — the object (§3.1, the amendment §2.1 field list), the four sources, the fourteen-name catalogue with defaults and tightness directions, the commands and exit codes, nine rules and the policy-names rows; replaces the earlier anonymous draft of 21:10, which was verified against the same tag before its removal.
- **Review fold carried in** (the writer, 2026-10-19): rule 7 takes what the amendment's §2.7 handed over at the fold — the ordinary-seat qualifier on `remove`, the decision anchors on the owner's seven, the seven-plus-two reading, the warning on the error stream with a log line per use, and a lead seat's removal or add among the never-reaches; rule 8 logs the variable's ignoring once.
- **Night decisions carried in** (the writer, 2026-10-19): rules 10–12 proposed — the entity's model rule (OD-20261019-01), the queued swap's wait as a setting with 30 minutes proposed and a broken seat swapping at once (OD-20261019-03, with -02), and the minimum review labs at entity, project or team level, default 2, distinct from `review-count` (OD-20261019-20) — each with *Proof:* none at the tag, and each mirrored by a planned row of §6 and of registries/policy-names.md.
- **Agreed Phase B review fold** (2026-10-19): proposed model-rule rule 10 includes reading the status bar back under OD-20261019-01; it remains proposed, with no proof or implementation at the tag.
- **The gate-lift rename** (the writer, 2026-10-19; OD-20261019-33, answer 3): the gate-lifting switch's name is `gate-lift` from this revision — it lifts a gate, it is not a mode — and `local-fast` stays the development mode's one name. Renamed here: §1's close, the Terms entry, the §3.3 catalogue row, rule 7's head and its `on` reading, rule 8's governed value, §6's registry row. Renamed elsewhere, one word change per place: specs-draft/grants.md (the delegated-run line, the owner-only sentence, rule 5, open point 3), specs-draft/tasks-and-broker.md (the broker line), specs-draft/registry.md (rule 10's provenance mark; the `provenance.dev_mode` field names of §3 stay), specs-draft/registries/operations.md (the `--abandon` row), specs-draft/registries/policy-names.md (the switch's row), and Kernel amendment 02's text (eight places; its revision log lists them). The code's identifiers keep the tag's spelling — `dev-mode` in `src/policy/types.ts`, `src/dev_mode.ts`, `DEV_MODE_OPERATIONS`, `TEAMCLI_DEV_MODE`, `provenance.dev_mode` — as facts of v0.5.0; the port carries the echo. A wording ruling from the review then tightened the writing: the name carries its code pairing — `gate-lift` (in code: `dev-mode`, until the rename ships) — at the Terms entry, the catalogue row and the registry row, and the writing is generic (gate-lifting) where no identifier is cited; the code rename is the tool's own separate change, and the port does not wait for it.
