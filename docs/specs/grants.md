---
created: 2026-10-18
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: Kernel amendment 01 Grants; Kernel amendment 03 Lifecycle Delegation (one section); Kernel (the map's rows)
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: Grants

## 1. Scope

This specification defines the owner-signed standing grant and revocation records, the folder that holds them, the commands that write and remove them, the command-to-capability map and the resolver that decide what a caller may do, and the team file's two delegated forms read as standing grants. One section defines the lifecycle delegation record decided by Kernel amendment 03, which is not built at the tag. Registry identity, seat state, policies and send admission belong to their own specifications (`registry.md`, `seat-state-and-watch.md`, `policies.md`, `messaging.md`).

## 2. Terms

- `grant`: the signed mapping inside a grant record (`src/permissions/grants.ts`).
- `revocation`: the signed mapping that ends one grant by its stem and generation (`src/permissions/grants.ts`).
- `active set`: `activeGrants(home, now)`, the fresh read every gate makes, with revoked and expired records left out (`src/permissions/grants.ts`).
- `capability`: one of the eight operational words a grant may carry (`GRANT_CAPABILITIES`).
- `envelope`: a team-level grant, which bounds what the seats of that team may be granted; never a source of capability on its own (`src/permissions/resolve.ts`).
- `bundle`: the capability words a role resolves to; empty at the tag (`src/permissions/who.ts`).
- `map`: `COMMAND_GATES`, one row per command naming what admits a caller (`src/permissions/map.ts`).
- `resolver`: `resolvePermission`, the pure decision over records (`src/permissions/resolve.ts`).
- `bridge`: `callerRecordOf`, which reads a walked caller as the resolver's record (`src/permissions/who.ts`).
- `delegate entry`: one item of the team file's `delegates` section (`src/delegate-types.ts`).
- `file grant`: the team file's `grant` section, the orchestrator seat's standing authorization (`src/file/sections/grant.ts`).
- `delegation record`: the lifecycle delegation of amendment 03; planned, not built.
- `generation`: the signing sequence of the grants folder, one sequence per folder (`bumpGeneration`, `src/store/keys.ts`).
- `domain tag`: the constant prefix a signature covers so it verifies as nothing else (`GRANT_DOMAIN`).

## 3. Formats

### 3.1. Grant record (`grant`)

One JSON file per record in the grants folder (§3.3), written whole, signed with the owner's Ed25519 key under `GRANT_DOMAIN` (`'team-grant-v1\n'`) over the payload `{ name, grant }` — the file's stem and the whole grant mapping — so a record renamed or edited after signing does not verify. A record with a field this version does not know is skipped. Writer: the owner, through `team grant … --capabilities` (`src/permissions/manage.ts`).

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `grantor` | `'owner'` | yes | — | 0.5.0 | Who signed; the owner writes grants alone at 0.5.0 |
| `grantee` | string | yes | — | 0.5.0 | An agent id (`agt_` plus twelve hex) for `kind: seat`; twelve lowercase hex, the team id, for `kind: team` |
| `kind` | `'seat' \| 'team'` | yes | — | 0.5.0 | Written, never inferred from the id's shape |
| `capabilities` | string[] | yes | — | 0.5.0 | From `GRANT_CAPABILITIES`, stored sorted without duplicates; a team grant may add `dialogs.trust` |
| `scope` | string[] | yes | the declared roots | 0.5.0 | Absolute paths, the user's home directory expanded, sorted without duplicates, each inside a declared root |
| `issued` | string (ISO 8601) | yes | — | 0.5.0 | When the record was written |
| `expires` | string \| null | yes | `null` | 0.5.0 | Optional; checked at every use |
| `generation` | integer ≥ 1 | yes | — | 0.5.0 | The folder's signing sequence at this write |
| `vocabulary` | integer | yes | `1` | 0.5.0 | `GRANT_VOCABULARY_VERSION`; unknown values are refused |

The closed vocabulary beside the mapping: `GRANT_CAPABILITIES` is `write`, `read`, `review`, `gate`, `merge`, `deploy`, `act-as`, `use-broker`; `GRANT_SETTINGS` is `dialogs.trust` (a team grant's only setting word; a seat grant carrying it is refused); `TEAM_GRANT_FORBIDDEN` is `grant`, `create`, `agree`, `leads`, refused on a team grant with the four named. A record's file stem matches `RECORD_NAME_PATTERN` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`).

Example (`src/permissions/grants.ts`, module header; written shape):

```json
{
  "grant": {
    "grantor": "owner",
    "grantee": "agt_0123456789ab",
    "kind": "seat",
    "capabilities": ["gate", "merge"],
    "scope": ["/code/acme"],
    "issued": "2026-10-17T02:00:00.000Z",
    "expires": null,
    "generation": 1,
    "vocabulary": 1
  },
  "signature": "9f2c…"
}
```

### 3.2. Revocation record (`revocation`)

One JSON file per record in the same folder, signed the same way over `{ name, revocation }`. A revocation is appended, never an edit of the grant: the write refuses a stem that is its grant's own or another grant's, and the reader matches the pair `grant` + `grant_generation` — the pair is the grant record's identity, so a later grant under the same name is a new record the revocation never touches. Writer: the owner, through `team revoke <name>`.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `grant` | string | yes | — | 0.5.0 | The revoked record's file stem |
| `grant_generation` | integer ≥ 1 | yes | — | 0.5.0 | The revoked record's generation; with the stem, the record's identity |
| `by` | `'owner'` | yes | — | 0.5.0 | Who wrote the revocation; the holder's renunciation is not built |
| `at` | string (ISO 8601) | yes | — | 0.5.0 | When the revocation was written |
| `generation` | integer ≥ 1 | yes | — | 0.5.0 | The folder's signing sequence at this write |

A grant is out of the active set when a revocation names its `name@generation` pair or its `expires` is past (`activeGrants`); the read is made fresh at every gate and depends on no ledger.

### 3.3. The grants folder

`<home>/.config/team/grants/`, mode 0700, created by the first write; the folder and every parent up to the home must be real directories, and each record a plain file — a symbolic link anywhere is skipped rather than followed (`src/grant.ts`, `readGrantRecords`). Files are `.yaml`, `.yml` or `.json`, read in sorted name order; each record file is written whole through a temporary file of mode 0600 and a rename. The same folder holds the entity create-grants and the send-grants. The signing key is the owner's approval key the store keeps; `bumpGeneration` moves one sequence per folder before each signed write (`src/store/keys.ts`). Default record names: `seat-<agent id>` and `team-<team id>`, or `--name`, minus the spellings the file forms read (`grant`, `delegate`, `revoke-…`), so a standing record and a team-file edit never share a word (`src/permissions/manage.ts`).

### 3.4. Send-grant record (`send`)

An unsigned record in the same grants folder naming one admitted pair (`src/send/grants.ts`). A record missing any field is not a grant and is left out.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `send.from` | string | yes | — | 0.5.0 | The sender: an agent id, `seat@team`, or `session/seat` |
| `send.to` | string | yes | — | 0.5.0 | The receiver, same spellings; a bare seat is the sender's own team's |
| `expires` (or `expiry`, `expires_at`, `expiresAt`) | string (ISO 8601) | yes | — | 0.5.0 | When the grant stops; must parse |
| `name` | string | no | the file stem | 0.5.0 | The record's name in reports |

### 3.5. Entity create-grant

An unsigned record in the same grants folder (`src/grant.ts`, `EntityCreateGrant`): `entity` (string or null), `grantee` (one of `{ kind: 'agent', id }` or `{ kind: 'team', id }` — admission matches the caller's registry record only), `paths` (the paths or entity it covers), `expires`. Its admission is by registry identity; its roots are read from the entity's declared roots in the machine's entity configuration alone, narrowed never widened.

### 3.6. The team file's `delegates` section

Owner-only section (`src/file/sections/delegate.ts`): an array of one to eight entries; two entries naming one pane are refused.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `pane` | string | yes | — | 0.5.0 | `<session>/<pane id>`, pattern `^[^\s/]+/[^\s/]+$`; the session must not be the team's own |
| `commands` | string[] | yes | — | 0.5.0 | Non-empty, distinct, from `up`, `down`, `add`, `remove`, `approve`, `swap` |

`approve` is accepted and inert (it acts on nothing; the word stays so files that name it load unchanged). `swap` is not a command of its own: it admits `remove <lead> --keep` and `add <lead>`, the replacement of the agent on the orchestrator's or the operator's seat; `remove` alone never admits a lead (`src/delegate-types.ts`).

### 3.7. The team file's `grant` section

Owner-only section (`src/file/sections/grant.ts`): the orchestrator seat's standing authorization.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `session` | string | yes | — | 0.5.0 | The file's own session: the session key, or the project name when that key is omitted |
| `seat` | string | yes | — | 0.5.0 | The orchestrator seat's name, the one `coordinator:` or `leads: true` resolves |
| `scope` | string[] | yes | — | 0.5.0 | Non-empty, distinct, order kept, from `up`, `down`, `approve`, `init`, `reload`, `swap` |

### 3.8. The lifecycle delegation record (planned; not built)

Decided by Kernel amendment 03; **not built at v0.5.0, not built at int/0.5.1 8acb470b**. A first-class, immutable ledger record — the same signed-record shape as §3.1, one file per record — with these decided fields:

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `signer` | the owner, or `leads` for its own team | yes | — | planned | The principal the Kernel's table names; a signer never delegates what it does not hold, and `leads` never re-delegates |
| `delegate` | agent id | yes | — | planned | One seat by its registry id; never a pane, a runner, a session or a name; kept across pane and occupant changes, revoked by a rebind, ended by removal |
| `operations` | list | yes | — | planned | A subset of `start`, `stop`, `restart`, `reload`, `add-same-copy`, `remove-ordinary`, `register`, `swap`; never `--abandon`, never a non-same-copy `add`, never removing a seat holding `grant`, `agree` or `leads`, never a sovereign section, never `grant`, `agree`, `create` or a lease |
| `teams` | list of team ids | yes | — | planned | Explicit; an owner-signed record may name any team of the entity, a `leads`-signed record its own only; one act per team |
| `issued` | ISO 8601 | yes | — | planned | When written |
| `expires` | ISO 8601 or null | no | null | planned | Checked at every use |
| `generation` | integer | yes | — | planned | The signing sequence |
| `signature` | the signer's | yes | — | planned | Revoked by a separate revocation record from the signer or the owner |

How an act under it is read: the signer is the principal on every record the act writes and the delegate is the actor; the log line says both before the effect; a same-copy `add` under an owner-signed record is authorized by it — the owner's standing agreement to the copies the file declares exactly as written — and under a `leads`-signed record the add is executed only, waiting for an `agree` holder or the owner as today. A delegated run needs no gate-lifting policy: the record is the caller gate's answer.

### 3.9. The vault scope (planned; not built)

Decided by Kernel amendment 01 Grants commitment 3.4 (which carries the authority rules); **not built at v0.5.0, not built at int/0.5.1 8acb470b**. A vault scope is the scope field of a grant record of §3.1's shape, a path pattern within **one** entity's vault, written:

```
vault:<entity>/<pattern>
```

Generic examples (an entity's id is its registry id, never a folder of a person's machine):

- `vault:<entity>/**` — the whole of one entity's vault; by the owner's word, an entity's main orchestrator's `read` and `write` scope.
- `vault:<entity>/projects/<project>/**` — one project's tree of the vault.
- `vault:<entity>/projects/<project>/decisions/**` — one subtree, the narrowest a working grant carries.

Rules the form carries (the amendment's commitment 3.4, restated for the reader of the record): a grant MUST NOT reach into two entities' vaults — one scope, one entity; the capabilities are the closed vocabulary's `read` and `write`; every vault read and write is logged with the scope it used. The vault's own schema, its operations and its storage adapters are the memory module's spec's (planned).

## 4. Commands and options

From `contract/cli.json` and `contract/exit-codes.json` at v0.5.0:

```text
team grant <seat> --scope <act,...> [--dry-run] [--json]
team grant <seat|@team> --capabilities <cap,...> [--scope <path,...>] [--expires <date>] [--name <stem>] [--dry-run] [--json]
team revoke grant [--dry-run] [--json]
team revoke delegate <session/pane> [--dry-run] [--json]
team revoke <name> [--dry-run] [--json]
team delegate <session/pane> --commands <act,...> [--dry-run] [--json]
```

`team grant <seat> --capabilities …` resolves the seat to its registered agent and writes the id, never the name; `@team` writes this project's team id. `team revoke <name>` treats a bare name as a standing grant's only when a grant holds it. `--dry-run` refuses exactly what a write refuses and writes nothing. Every form is owner-only: the gate is the team-file editors' own (`walkCaller` plus `isOwner`), the same refusal sentence, and no mode waives it — gate-lifting never reaches these commands.

| ID | Command | Code | Meaning | Trigger |
|---|---|---|---|---|
| `grant.done` | `grant` | 0 | The authority was written or already matched — the team file's grant, or a standing grant record | `team grant lead --scope up,down` |
| `grant.refused` | `grant` | 1 | The caller is not the owner, the file changed during the edit, or the write failed | `team grant lead --capabilities gate,merge` |
| `grant.invalid` | `grant` | 2 | The team file, the named seat or team, or the proposed authority record is invalid or unknown | `team grant @team --capabilities create` |
| `grant.invocation` | `grant` | 2 | The command arguments are invalid | `team grant lead` |
| `revoke.done` | `revoke` | 0 | The authority was removed or matched, the standing grant's revocation appended or already so | `team revoke flag-gate` |
| `revoke.refused` | `revoke` | 1 | The caller is not the owner, the file changed during the edit, or the write failed | `team revoke grant` |
| `revoke.invalid` | `revoke` | 2 | The team file, the named target or the proposed authority record is invalid | `team revoke delegate malformed` |
| `revoke.invocation` | `revoke` | 2 | The command arguments are invalid | `team revoke all` |
| `delegate.done` | `delegate` | 0 | The authority record was updated, already matched, or passed a write-free preview | `team delegate <session/pane> --commands up,down` |
| `delegate.refused` | `delegate` | 1 | The caller is not the owner, the file changed during the edit, or the write failed | `team delegate <session/pane> --commands up,down` |
| `delegate.invalid` | `delegate` | 2 | The team file or proposed authority record is invalid or cannot be read | `team delegate <session/pane> --commands up,down` |
| `delegate.invocation` | `delegate` | 2 | The command arguments are invalid | `team delegate <session/pane> --commands up,down` |

## 5. Rules

1. **A grant carries operational capabilities only, from a closed, version-pinned vocabulary.** A capability outside `GRANT_WORDS` MUST be refused at plan and at write with the word named; a team grant naming one of `TEAM_GRANT_FORBIDDEN` (`grant`, `create`, `agree`, `leads`) MUST be refused with the four named; a seat grant naming `dialogs.trust` MUST be refused as a team setting. *Source:* `src/permissions/grants.ts`. *Proof:* `test/permissions/grants.test.ts`, `test/grant.test.ts`.
2. **The grantee is a registry identity and nothing else.** A seat grant MUST name an agent id (`agt_` plus twelve hex) and a team grant a team id (twelve lowercase hex), with `kind` written, never inferred; the command layer MUST resolve a seat name to its registered agent id before the write. *Source:* `src/permissions/grants.ts`, `src/permissions/manage.ts`. *Proof:* `test/grant-registry-id.test.ts`.
3. **Every scope path MUST sit inside a declared root**, expanded from the user's home directory, and a grant with no scope given MUST carry the declared roots themselves; the write is refused with the path and the roots named. *Source:* `src/permissions/grants.ts` (`planGrant`, `grantProblem`). *Proof:* `test/grant-boundaries.test.ts`.
4. **A record's signature covers the file's stem and the whole mapping under the grant's own domain tag**, so a renamed or edited record does not verify and is not a grant; a record with a field this version does not know MUST be skipped, not judged. *Source:* `src/permissions/grants.ts`. *Proof:* `test/permissions/grants.test.ts`.
5. **Granting is the approval; there is no `team approve`.** The commands that write authority MUST refuse every caller but the owner at a terminal outside the terminal multiplexer, in every mode, with one sentence; gate-lifting MUST NOT reach them. *Source:* `src/permissions/manage.ts`, `src/dev_mode.ts`, `src/cli.ts`. *Proof:* `test/permissions/grants.test.ts`, `test/dev-mode-gates.test.ts`.
6. **A revocation is its own appended record, never an edit of the grant.** The write MUST refuse a stem that is its grant's own or another grant's, and MUST require the exact pair of stem and generation; the active set MUST be read fresh at every gate, with revoked and expired records left out, so revocation takes effect at the next gate check and expiry needs no action. A revocation record MUST never be removed; revival is a new grant. *Source:* `src/permissions/grants.ts`. *Proof:* `test/permissions/grants.test.ts`.
   *Today (v0.5.0):* a reused grant name overwrites the earlier revocation — the name-reuse gap of Kernel amendment 01's §10, question 13; rule 6 stays the target, the tag's behaviour is the overwrite.
7. **A dry run refuses exactly what a write refuses**: `planGrant`/`planRevocation` are the write's validation without the generation, the signature or the file. *Source:* `src/permissions/grants.ts`. *Proof:* `test/permissions/grants.test.ts`.
8. **The resolver denies by default and decides from records alone.** Absent is deny; deny wins through every grant; a caller with no registry record MUST be refused with the rule named; the same inputs MUST always give the same answer; nothing resolves by a role's name — the name is recorded in the answer and the bundle's capability words decide. *Source:* `src/permissions/resolve.ts`. *Proof:* `test/permissions/resolve.test.ts`.
9. **A seat's effective list is its own list intersected with the team envelope, never a union.** A capability MUST be admitted only when the seat's own list names it (a seat grant over the role's resolved bundle — the most specific admitting rule is recorded) and the team envelope carries it; named but not enveloped is refused under `outside-envelope`; a target outside a grant's scope or the envelope's is refused under `outside-scope`; a seat resolves within its own team's envelope and never another's (`other-team`). *Source:* `src/permissions/resolve.ts`. *Proof:* `test/permissions/resolve.test.ts`.
10. **The map is closed.** A word with no row MUST be refused by the resolver rather than judged; `create` has no row because it is no command; `send` and `answer` are rows whose gates live elsewhere (the send admission and the pane-authority gate) and the map admits no one to either. *Source:* `src/permissions/map.ts`. *Proof:* `test/permissions/resolve.test.ts`.
11. **The bridge reads identity from the registry.** A seat is a record only where the registry's roster line (or, for a team the registry holds no record of, the file's own declaration, which carries no agent id, so no grant can name it and no read-surface row admits it) stands for it; the bundle is empty at the tag; a registry that cannot be read MUST fail closed, never fall to the file. *Source:* `src/permissions/who.ts`. *Proof:* `test/permissions/who.test.ts`, `test/permissions/fail-closed.test.ts`.
12. **The file forms are kept as standing grants.** A `delegates` entry (up to eight panes, each with a command list) and the `grant` section's scope words are read as the owner's standing authorizations with a command list: the owner as signer, the pane as actor, one command per mark; `approve` MUST be accepted and inert so older files parse, and no command consults it. *Source:* `src/file/sections/delegate.ts`, `src/file/sections/grant.ts`, `src/delegate-types.ts`. *Proof:* `test/permissions/delegates.test.ts`.
13. **No command lists the standing grants and no team-log line is written for one**: `team grant` and `team revoke` write the record, print one word of outcome, and nothing else; the folder's listing is the only view. *Source:* `src/permissions/manage.ts`. *Proof:* none at the tag.
14. **The must-not-pretend block is printed** by `team doctor` (full runs, not `--login`) and `team --about`, each line with its Kernel reference in `--json`. *Source:* `src/permissions/must-not-pretend.ts`. *Proof:* `test/check-devmode.test.ts`.

## 6. Registries

This specification contributes to `registries/capabilities.md` and `registries/operations.md` (consolidated by the documentarist):

### capabilities.md

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `write` | operational capability of the closed vocabulary | 0.5.0 | `src/permissions/grants.ts` (`GRANT_CAPABILITIES`) | gated nowhere at the tag |
| `read` | operational capability of the closed vocabulary | 0.5.0 | `src/permissions/grants.ts` | not enforced at the tag |
| `review` | operational capability of the closed vocabulary | 0.5.0 | `src/permissions/grants.ts` | |
| `gate` | operational capability of the closed vocabulary | 0.5.0 | `src/permissions/grants.ts` | |
| `merge` | operational capability of the closed vocabulary | 0.5.0 | `src/permissions/grants.ts` | |
| `deploy` | operational capability of the closed vocabulary | 0.5.0 | `src/permissions/grants.ts` | gated nowhere at the tag |
| `act-as` | operational capability of the closed vocabulary | 0.5.0 | `src/permissions/grants.ts` | gated nowhere at the tag |
| `use-broker` | operational capability of the closed vocabulary | 0.5.0 | `src/permissions/grants.ts` | gated nowhere at the tag |
| `dialogs.trust` | the one owner setting a team grant may carry beside its capabilities | 0.5.0 | `src/permissions/grants.ts` (`GRANT_SETTINGS`) | a word of the record, never a command |
| `grant`, `create`, `agree`, `leads` | administrative capabilities, not grantable operational words at this release | 0.5.0 | `src/permissions/grants.ts` (`TEAM_GRANT_FORBIDDEN`) | refused on a team grant with the four named |

### operations.md

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `init` | writing a team where none exists | 0.5.0 | `src/permissions/map.ts` | owner-only |
| `up` | start a team or seat | 0.5.0 | `src/permissions/map.ts` | owner-or-leads |
| `down` | stop a team | 0.5.0 | `src/permissions/map.ts` | owner-or-leads |
| `restart` | the start row for one seat | 0.5.0 | `src/permissions/map.ts` | owner-or-leads |
| `reload` | the start row for a running seat | 0.5.0 | `src/permissions/map.ts` | owner-or-leads |
| `add` | add a seat | 0.5.0 | `src/permissions/map.ts` | owner-only at the tag |
| `remove` | remove a seat | 0.5.0 | `src/permissions/map.ts` | owner-or-leads; a seat holding `grant`, `agree` or `leads` by the owner only |
| `rename` | edit the roster's display names | 0.5.0 | `src/permissions/map.ts` | owner-or-leads |
| `register` | a registry record: a report, confers no right | 0.5.0 | `src/permissions/map.ts` | owner-or-own-team |
| `grant` | grant a capability or edit the team's configuration | 0.5.0 | `src/permissions/map.ts` | owner-only |
| `revoke` | remove a standing grant | 0.5.0 | `src/permissions/map.ts` | owner-only |
| `delegate` | a standing grant with a command list, written against the map | 0.5.0 | `src/permissions/map.ts` | owner-only |
| `send` | admission, decided by the send admission | 0.5.0 | `src/permissions/map.ts` | the map admits no one |
| `answer` | a key into another agent's pane | 0.5.0 | `src/permissions/map.ts` | pane-authority gate, not this map's |
| `messages`, `feed`, `status`, `list`, `check`, `usage`, `next` | read surfaces | 0.5.0 | `src/permissions/map.ts` | any seat with a registry record |
| `available`, `waits` | read surfaces named by the Kernel's table | 0.5.0 | `src/permissions/map.ts` | rows with no command module at the tag |

## 7. Open points

1. **The holder's renunciation is not built**: `by` is `'owner'` and the command is owner-only; the amendment keeps the renunciation as its round's question 1.
2. **No listing command, no notice**: no command lists the standing grants, no team-log line is written on a grant or a revocation, and nothing tells the owner beyond the command's own output.
3. **The gate-lifting list is nine against the eight-command gate-lifting scope of Kernel amendment 01 Grants** (`reload` included in the eight; `rename` in the code's list and left open by Kernel amendment 01 Grants §10 question 4); the amendment reads it as the same word, to confirm or take out.
4. **The role bundle is empty at the tag**: the resolver reads no per-role capabilities, so a seat's list is its seat grants within the envelope and its `leads`; the roles catalogue is the slot that fills it.
5. **The lifecycle delegation record (§3.8) is decided and not built**; the `delegates` and file `grant` forms it replaces stay readable, and nothing reports an entry with no record behind it.
6. **`available` and `waits` are rows with no command**, kept because the map is the Kernel's table, not the CLI's.
7. **The `approve` word is read and inert**; its removal is an open question of the amendment (remove at the forms' retirement, or sooner).

## Revision log

- **Draft** (the writer, 2026-10-18): lifted from Kernel amendment 01 Grants and amendment 03 Lifecycle Delegation; read at `v0.5.0 (52db9b75)`, the delegation section read against `int/0.5.1 8acb470b`.
- **§3.9 added** (the writer, 2026-10-19): the vault scope's written form and its generic examples, placed here by the amendment's review fold — the RFC keeps the one-entity bounds and the authority rules, the record's form lives in the spec; examples are generic, no entity of this machine is named.
- **Public-bound scrub** (the writer, 2026-10-19): at the lifecycle amendment's review fold, the two home-directory shorthand literals (the scope row and rule 3) became the user's home directory spelled out, and the two terminal-multiplexer product names (the pane row and rule 5) became the generic session and multiplexer words.
- **Fold of round 1** (the writer, 2026-10-19): at the round-1 review fold of Kernel amendment 01 Grants the §6 row's grant-word note became "administrative capabilities, not grantable operational words at this release"; at the verification follow-up rule 6 gained its Today note (at v0.5.0 a reused grant name overwrites the earlier revocation — Kernel amendment 01 Grants §10, question 13; the rule stays the target) and open point 3's count was corrected to the eight-command gate-lifting scope of Kernel amendment 01 Grants (§10, question 4).
