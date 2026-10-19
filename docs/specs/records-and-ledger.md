---
created: 2026-10-18
updated: 2026-10-18
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: the Kernel v2 text (the record ledger, the effect id, intent and outcome); the Runtime v2 text reads the store rules here
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: records and the ledger

## 1. Scope

This spec defines the common envelope of every ledger record, the Kernel's record types, the lease
record, the effect id, and the intent/outcome ordering. It leaves the grant and revocation records'
own fields and commands to the grants spec, the policy object to the policies spec, and the event
kinds of the bus to the events spec. At v0.5.0 no action ledger exists: everything here except the
approval store and the signed grant/revocation records is **planned**, and §5 says so for each rule.

## 2. Terms

- **record** — one signed, append-only entry of the ledger.
- **actor** — the seat that executed an action; authorizes nothing.
- **signer** — the principal whose signature authorizes the action.
- **co-authorization** — the second granter's signature over the same canonical proposal.
- **effect id** — a hash identifying the artifact a gate pass blesses (§3.4).
- **intent** — the record of the gate's decision, appended before the effect.
- **outcome** — the record of what happened: done, refused, or unknown.
- **head** — the signed sequence number and hash of the latest record.
- **lease** — a bounded, recorded, time-limited delegation (Kernel §7) — not a grant.
- **tombstone** — a signed record that hides archived content and leaves a counted stub.

## 3. Formats

No implementation holds these formats at the tag; the tables state the shape the Kernel defines.
"Since" is `planned` throughout §3.

### 3.1 The record envelope

Every record is canonical and append-only.

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `type` | enum | yes | — | planned | one of `grant`, `agreement`, `lease`, `revocation`, `intent`, `outcome`, `review`, `gate`, `refusal`, `notice`, `tombstone` |
| `seq` | integer | yes | — | planned | position in the chain; the head's sequence number |
| `prev_hash` | hash | yes | — | planned | hash of the previous record |
| `actor` | identity or claim | yes | — | planned | executing seat; a caller-supplied name is stored as an unauthenticated claim, never as actor |
| `signer` | signature | yes | — | planned | the authorizing principal's signature |
| `co_authorization` | signature | no | none | planned | the second granter's signature over the same canonical proposal; only on a two-granter record |
| `action` | string | yes | — | planned | the operation performed |
| `capability` | enum | yes | — | planned | the capability used, from the closed vocabulary |
| `scope` | object | yes | — | planned | the capability-and-scope the gate checked |
| `payload` | canonical object | yes | — | planned | domain (team, repository root), target (ref, environment, account, task, team), before/after artifact identity (typed `none` where none exists), root grant, unique request id |
| `input_state` | object | yes | — | planned | tree hash, configuration hash, lease-set hash |
| `time` | authenticated time | yes | — | planned | the record's time |
| `request_id` | string | yes | — | planned | unique; a retry carries the same one |

### 3.2 Record types

| Type | Written when | Adds |
|---|---|---|
| `grant` | a capability is given to a seat | the grants spec's fields |
| `agreement` | a change is confirmed | the canonical proposal and its hash |
| `lease` | a lease is issued | §3.3 |
| `revocation` | a grant or lease is taken back | the revoked record's id; its own record, never a field |
| `intent` | before an effect | the decided authorization |
| `outcome` | after an effect | result `done`, `refused` or `unknown`; the effect id where one exists |
| `review` | a verdict is recorded | the verdict and the effect id reviewed |
| `gate` | a change passes a check | the effect id |
| `refusal` | an attempt is refused | the named rule that refused it |
| `notice` | the owner must be told | the change noticed |
| `tombstone` | archived content is hidden | a stub the gate still counts |

### 3.3 The lease record

A lease is immutable: no field of it is ever updated. Revocation is a separate record, and liveness
is derived (Kernel §7).

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `lease_id` | string | yes | — | planned | the lease's stable identity |
| `parent` | lease id | for a re-lease | none | planned | mandatory when the source is a lease; absent only for a root lease |
| `root_grant` | record id | yes | — | planned | the standing grant or the `leads` envelope the lease derives from |
| `issuer` | identity | yes | — | planned | the seat issuing the lease |
| `recipient` | identity | yes | — | planned | an existing member seat, by stable identity |
| `capability` | enum | yes | — | planned | an operational capability only |
| `scope` | object | yes | — | planned | within the issuer's source |
| `issued_at` | authenticated time | yes | — | planned | issue time |
| `expires_at` | time | yes | — | planned | hard expiry; bounded by the ceiling's lease TTL |

A lease is live only while its whole lineage is live: its named source currently covers it and its
issuer still holds that source, under the current deny and ceiling.

### 3.4 The effect id

The effect id is a hash over the artifact a gate pass blesses:

- the changed-path set, renames and copy sources included;
- the destination tree;
- the destination ref;
- the base;
- the policy hash (the team configuration).

It deliberately excludes the environment and the account: those are authorized separately at
act-time against the acting seat's own `deploy` and `act-as` scope. A `gate` record carries the
effect id; a `merge` or `deploy` record, and any gate/merge/deploy outcome, carries the same one. A
`refused` or `unknown` outcome carrying an effect id voids every pass recorded for that id, in every
environment.

### 3.5 Intent and outcome

An act is recorded in two steps. The `intent` record is appended durably **before** the effect; if
it cannot be appended, the act does not happen. The `outcome` record follows with `done`, `refused`
or `unknown`.

- An `unknown` outcome is written by recovery before any new act on the same target.
- While an effect is `unknown`, every act on its target is refused.
- A retry under the same request id is never re-dispatched: pending, it awaits the in-flight
  result; complete, it returns the recorded outcome.
- A used request id with a different payload is refused. A retry must be byte-identical.
- The reservation held for the effect counts as spent until the outcome is resolved.
- Where the external service cannot say whether the effect happened, only an owner-signed recovery
  decision — repeat as a new request id, or accept as done — unblocks the target, and the decision
  is recorded.

### 3.6 The head

The head is a signed sequence number and hash. The gate refuses if the history it reads does not
match the head it last signed. The head persists across process and machine restart; an update
interrupted mid-write is detected and the gate fails closed until the head is reconciled.

### 3.7 Stop and revocation flags

The owner's stop and a revocation take effect through a local flag the gate honours before reading
any record, so they do not depend on the store being writable. The flag persists across restart,
retains each signed stop and revocation payload so recording one never drops another, and a stop
holds until an owner act clears it. Stop and revocation are appended when the store returns, marked
late; reconciliation never clears a stop or drops a pending revocation.

### 3.8 Tombstone

Deletion is a signed tombstone, never a silent erase. A tombstone hides archived content and leaves
a stub the gate still counts; a revocation sticks even if later tombstoned.

## 4. Commands and options

None at the tag. No command prints or verifies the ledger; the commands that will read it are not
built. The approval store's commands are the launch and approval commands, specified elsewhere.

## 5. Rules

Each rule is the Kernel's; each is cited to the source at the tag, and none has a proof there.

1. **Every grant, agreement, lease, revocation, gated action and refused attempt MUST be signed and
   recorded; an action that cannot be recorded MUST be refused.** Source: no implementation.
   *Proof: none at the tag.*
2. **The store MUST NOT decide record policy.** It implements the records; the ordering, the
   refusal and the fields are the Kernel's. Source: no store implements them. *Proof: none at the
   tag.* The approval store at the tag signs one approved team-file record with a generation
   (`src/store/store.ts`) and decides no authority policy.
3. **Records MUST be append-only, and a lease MUST have no mutable field.** Source: none. *Proof:
   none at the tag.*
4. **Revocation MUST be its own record, and liveness MUST be derived from the issue record, its
   expiry, any revocation for it or an ancestor, and the whole lineage's current coverage.** Source:
   none. *Proof: none at the tag.* At the tag a revocation is an appended, signed record separate
   from the grant it revokes (`src/permissions/grants.ts`); there is no lineage.
5. **The `intent` record MUST be appended durably before the effect; without it the act MUST NOT
   happen.** Source: none. *Proof: none at the tag.*
6. **An `unknown` outcome MUST block its target and its request id; a retry MUST NOT be
   re-dispatched; a request id reused with a different payload MUST be refused.** Source: none.
   *Proof: none at the tag.*
7. **The tool MUST keep a signed head and MUST fail closed when the history does not match it.**
   Source: none. *Proof: none at the tag.*
8. **A `merge` or `deploy` MUST consume exactly one `gate` record of result pass whose effect id
   equals its own; a `refused` or `unknown` outcome for that effect id MUST void the pass, and a
   pass whose gater's authority has since been revoked MUST be void.** Source: none. *Proof: none
   at the tag.*
9. **The gate MUST refuse when authorship, a lease's validity, a seat's lab binding, or the
   required gate record cannot be read or verified.** Source: none. *Proof: none at the tag.*
10. **Deletion MUST be a signed tombstone; archived history is owner-removable, an in-flight
    record the gate reads is not.** Source: none. *Proof: none at the tag.*

## 6. Registries

The entries this area contributes, in each registry's row shape. They are listed here for the
registries' owner to collect; no message carries them.

### registries/capabilities.md

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `write` | change files within its `path` scope | 0.5.0 | `src/permissions/grants.ts` (`GRANT_CAPABILITIES`) | in the vocabulary; gates no command at 0.5.0 |
| `read` | be served file contents within its `path` scope; every tool disclosure is a `read` | 0.5.0 | `src/permissions/grants.ts` | in the vocabulary; the scope is not enforced at 0.5.0 |
| `review` | record a verdict on a change (`path`, `branch`) | 0.5.0 | `src/permissions/grants.ts` | gates no command at 0.5.0 |
| `gate` | let a change pass a required check (`path`, `branch`) | 0.5.0 | `src/permissions/grants.ts` | gates no command at 0.5.0 |
| `merge` | bring a change into a trunk (`path`, `branch`); consumes a gate pass | 0.5.0 | `src/permissions/grants.ts` | gates no command at 0.5.0 |
| `deploy` | release to an environment (`env`, optionally `branch`); consumes a gate pass | 0.5.0 | `src/permissions/grants.ts` | gates no command at 0.5.0 |
| `use-broker` | be served a secret-bearing task resource through the broker | 0.5.0 | `src/permissions/grants.ts` | in the vocabulary; the per-seat check is not built |
| `act-as` | use the owner's external identity within its `account` scope | 0.5.0 | `src/permissions/grants.ts` | gates no command at 0.5.0 |
| `create` | start a team within its create-bounds | 0.5.0 | `src/permissions/grants.ts` (`TEAM_GRANT_FORBIDDEN`) | named as never team-grantable; no command row at 0.5.0 |
| `grant` | give a capability to a seat | 0.5.0 | `src/permissions/grants.ts` (`TEAM_GRANT_FORBIDDEN`) | owner-only at 0.5.0 |
| `agree` | confirm a same-copy change | 0.5.0 | `src/permissions/grants.ts` (`TEAM_GRANT_FORBIDDEN`) | no copy agreement by hash at 0.5.0 |
| `leads` | the single authority root | 0.5.0 | `src/file/sections/lead.ts` | read as one lead seat; the envelope is not built |

### registries/operations.md

Every row is `planned` as the Kernel specifies it; the note names the command at the tag where one
exists. Each operation has exactly one authorizing principal; a two-granter change records a
primary signer plus one co-authorization.

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `start` | owner, or `leads` for its own team; runs the hash-pinned start command and its full hashed execution context; takes no argument and refuses a caller-supplied environment; a `create` bound that also starts triggers it | planned | `src/permissions/map.ts` (`up`) | `up` is owner-or-lead at 0.5.0; pinning and context hashing not built |
| `stop` | owner, or `leads` for its own team; never reaches another team | planned | `src/permissions/map.ts` (`down`) | `down` is owner-or-lead at 0.5.0 |
| machine-wide stop | owner only | planned | — | one stop per team at 0.5.0, and unreliable |
| `add` a same-copy seat | an `agree` holder, or the owner; `leads` may execute and authorizes nothing | planned | `src/permissions/map.ts` (`add`) | `add` is owner-only at 0.5.0; no copy agreement by hash |
| `add` any other seat | owner, or a `grant` holder; inside the ceiling and deny; two-granter where set | planned | `src/permissions/map.ts` (`add`) | as above; no grant holder path |
| `remove` a seat | owner, or `leads`; a seat holding `grant`, `agree` or `leads` by the owner only; removing a seat revokes every lease it holds or issued; removing `leads` revokes every live lease in the team; a delegate's removal that breaks a minimum is refused, an owner's commits and pauses the floor | planned | `src/permissions/map.ts` (`remove`) | `remove` is owner-or-lead at 0.5.0; no lease revocation, no floor |
| issue a lease | the issuer; within a live parent (re-lease), a standing grant it holds, or the `leads` envelope only when the issuer is `leads`; parent mandatory when the source is a lease; the recipient passes the whole-chain ban; a present `leads` is required; a two-granter capability needs a co-signed lease; re-checks the constraints | planned | — | no lease at 0.5.0 |
| grant a capability or edit the team's configuration | owner, or a `grant` holder; inside the ceiling, deny and declared sets; two-granter where set, though the owner may grant alone; `leads` has no grant power | planned | `src/permissions/map.ts` (`grant`), `src/commands/grant.ts` | owner-only at 0.5.0 |
| a configuration change that is not a same-copy | the same principal and bounds; it is a grant | planned | — | the same-copy distinction is not built |
| revoke a lease | owner, `leads`, or a holder above the revoked lease in its chain | planned | — | `revoke` at 0.5.0 revokes a grant record, not a lease |
| `--abandon` | owner only | planned | — | not built |
| a `use-broker` call | the requesting seat, by its own scope and deny; `leads` is not a proxy and is not required in the call | planned | `src/broker/policy.ts` | the field policy exists at 0.5.0; the per-seat scope check is not built |
| `act-as` | the seat holding it, within its `account` scope | planned | — | not built |
| `write`, `read`, `review`, `gate`, `merge`, `deploy` | the seat holding that capability, within its scope and the constraints; `merge`/`deploy` consume a valid gate pass; the author-inequality binds `gate`/`merge`, and `deploy` where the owner binds it; a `deploy` under the owner's identity also needs `act-as` | planned | `src/permissions/map.ts` | the map says 0.5.0 gates none of them |
| `create` (execute) | the seat holding `create`, within its create-bounds; recorded as that seat's act, never the owner's; resets no unattended clock | planned | — | no `create` command row at 0.5.0 |
| rebind a seat's lab; change a ceiling, deny, declared set, minimum, maximum, exclusion, review mode or the two-granter requirement | owner only | planned | — | no such surface at 0.5.0 |

## 7. Open points

- **Everything in §3 is a text's format with no implementation at the tag.** The v2 Kernel's Today
  rows say so; no code rule is claimed.
- **The approved team-file record has no type here.** The approval store at the tag keeps a signed
  per-project record with a generation and a ledger of display/role/model/version entries
  (`src/store/store.ts`); no accepted text assigns those entries a Kernel record type. The v2
  Kernel does not invent one.
- **The approval store's generation is not a chain head.** It orders approvals of one file; it
  does not link records, and the v2 Kernel does not call it the head.
- **The grant and revocation record fields are the grants spec's.** This spec carries only their
  type names and the envelope they share.

## Revision log

- **Draft** (2026-10-18): lifted from the Kernel v2 text, §§15, 3, 6 and 9; read at the tag; the
  registry entries from the Kernel's capability list and authorization table are in §6.
