---
created: 2026-10-18
updated: 2026-10-19
kind: registry-draft
status: draft
read-at: v0.5.0 (52db9b75)
source: src/permissions/map.ts
---

# Registry: operations

**What it lists.** Command-to-gate rows at the tag and separately proposed Kernel operation contracts.

**Policy for a new entry.** The TeamCLI team maintains this registry with its implementation. An addition needs a spec change, its consistency check and a release note; an RFC round is needed only if it breaks a commitment. These are draft registration rules pending review.

The Since column records presence at a pinned revision, not an audited first-introduction release. Planned rows confer no implementation or authority.

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `init` | writing a team where none exists is the owner's act in 0.5.0: no create-bounds exist yet, so no agent holds `create` | present at 0.5.0 | `src/permissions/map.ts` | owner-only |
| `up` | `start`: it runs the hash-pinned start command, and an operation is reached only through `leads` held in a role, never through a grant | present at 0.5.0 | `src/permissions/map.ts` | owner-or-leads; this why string describes the intended pinned start; context hashing is not implemented |
| `down` | `stop`: the owner or `leads` for its own team, and the owner may always stop | present at 0.5.0 | `src/permissions/map.ts` | owner-or-leads |
| `restart` | the `start` row for a seat: as `start` | present at 0.5.0 | `src/permissions/map.ts` | owner-or-leads |
| `reload` | the `start` row for a running seat, as `restart`: closing and relaunching one seat is the same act | present at 0.5.0 | `src/permissions/map.ts` | owner-or-leads |
| `add` | adding a seat is the owner's in 0.5.0, where no `agree` or `grant` holders stand | present at 0.5.0 | `src/permissions/map.ts` | owner-only |
| `remove` | removing a seat: the owner or `leads`; a seat holding `grant`, `agree` or `leads` stands only by the owner | present at 0.5.0 | `src/permissions/map.ts` | owner-or-leads |
| `rename` | renaming a seat: the owner or `leads` for its own team | present at 0.5.0 | `src/permissions/map.ts` | owner-or-leads |
| `register` | a registry record is a report and confers no right: the owner, or the seat's own team | present at 0.5.0 | `src/permissions/map.ts` | owner-or-own-team |
| `grant` | granting is the approval, and the owner grants alone in 0.5.0 | present at 0.5.0 | `src/permissions/map.ts` | owner-only |
| `revoke` | removing a standing grant is the owner's edit, and the revocation channel of 0.5.0 is the owner at a terminal | present at 0.5.0 | `src/permissions/map.ts` | owner-only |
| `delegate` | a standing grant with a command list, written against this map: the owner's | present at 0.5.0 | `src/permissions/map.ts` | owner-only |
| `send` | admission is chain position and the pair's setting, never a role's name: it is decided by the send admission, and this map admits no one to it | present at 0.5.0 | `src/permissions/map.ts` | admission |
| `answer` | a key into another agent's pane belongs to the pane's lead, a seat above it, or the owner's word for that case; trust, login and security prompts to the owner's alone — pane authority is its own gate, and this map admits no one to it | present at 0.5.0 | `src/permissions/map.ts` | pane-authority |
| `messages` | Read-surface row admitting a registry-recorded seat. | present at 0.5.0 | `src/permissions/map.ts` | seat-record; individual command may have a separate gate; read scope not enforced |
| `feed` | Read-surface row admitting a registry-recorded seat. | present at 0.5.0 | `src/permissions/map.ts` | seat-record; individual command may have a separate gate; read scope not enforced |
| `status` | Read-surface row admitting a registry-recorded seat. | present at 0.5.0 | `src/permissions/map.ts` | seat-record; individual command may have a separate gate; read scope not enforced |
| `list` | Read-surface row admitting a registry-recorded seat. | present at 0.5.0 | `src/permissions/map.ts` | seat-record; individual command may have a separate gate; read scope not enforced |
| `check` | Read-surface row admitting a registry-recorded seat. | present at 0.5.0 | `src/permissions/map.ts` | seat-record; individual command may have a separate gate; read scope not enforced |
| `usage` | Read-surface row admitting a registry-recorded seat. | present at 0.5.0 | `src/permissions/map.ts` | seat-record; individual command may have a separate gate; read scope not enforced |
| `available` | Read-surface row admitting a registry-recorded seat. | present at 0.5.0 | `src/permissions/map.ts` | seat-record; no command module at the tag |
| `next` | Read-surface row admitting a registry-recorded seat. | present at 0.5.0 | `src/permissions/map.ts` | seat-record; individual command may have a separate gate; read scope not enforced |
| `waits` | Read-surface row admitting a registry-recorded seat. | present at 0.5.0 | `src/permissions/map.ts` | seat-record; no command module at the tag |
| `write` | Operational capability row. | present at 0.5.0 | `src/permissions/map.ts` | capability; none gated in this release |
| `read` | Operational capability row. | present at 0.5.0 | `src/permissions/map.ts` | capability; none gated in this release |
| `review` | Operational capability row. | present at 0.5.0 | `src/permissions/map.ts` | capability; none gated in this release |
| `gate` | Operational capability row. | present at 0.5.0 | `src/permissions/map.ts` | capability; none gated in this release |
| `merge` | Operational capability row. | present at 0.5.0 | `src/permissions/map.ts` | capability; none gated in this release |
| `deploy` | Operational capability row. | present at 0.5.0 | `src/permissions/map.ts` | capability; none gated in this release |
| `act-as` | Operational capability row. | present at 0.5.0 | `src/permissions/map.ts` | capability; none gated in this release |
| `use-broker` | Operational capability row. | present at 0.5.0 | `src/permissions/map.ts` | capability; none gated in this release |

**Not in the tool at the release tag, named by a text:**

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
| `--abandon` | owner-only command option; the Kernel’s full abandonment contract remains planned | present at 0.5.0 in part | `src/commands/remove.ts`; `src/permissions/map.ts` | Present option is outside gate-lifting; the broader ledger/authority-lease behavior is not built. |
| a `use-broker` call | the requesting seat, by its own scope and deny; `leads` is not a proxy and is not required in the call | planned | `src/broker/policy.ts` | the field policy exists at 0.5.0; the per-seat scope check is not built |
| `act-as` | the seat holding it, within its `account` scope | planned | — | not built |
| `write`, `read`, `review`, `gate`, `merge`, `deploy` | the seat holding that capability, within its scope and the constraints; `merge`/`deploy` consume a valid gate pass; the author-inequality binds `gate`/`merge`, and `deploy` where the owner binds it; a `deploy` under the owner's identity also needs `act-as` | planned | `src/permissions/map.ts` | the map says 0.5.0 gates none of them |
| `create` (execute) | the seat holding `create`, within its create-bounds; recorded as that seat's act, never the owner's; resets no unattended clock | planned | — | no `create` command row at 0.5.0 |
| rebind a seat's lab; change a ceiling, deny, declared set, minimum, maximum, exclusion, review mode or the two-granter requirement | owner only | planned | — | no such surface at 0.5.0 |
| `sessions` | to decide; lists a seat's session records — which agent stood the seat, from when to when, the end reason, tokens and cost, what it produced — and `--by model`, `--by team` and `--by entity` group them | planned | proposed; not in `src/permissions/map.ts` | decided 2026-10-19; the registry writes the records at up, restart, swap and down |
| `resume` | to decide; resumes a seat's session by the CLI's session id — a restart with the same conversation, the resumed session reading the latest handover first; the CLI must be the same | planned | proposed; not in `src/permissions/map.ts` | decided 2026-10-19 |
| `cast` | to decide for the showing; shows the cast — which agent stands which seat, with the reason for each choice — and `--propose` proposes a better one; applying a proposal goes through `team config` and the swap queue, with the owner's go where a policy asks for it | planned | proposed; not in `src/permissions/map.ts` | decided 2026-10-19; a cast is reviewed before it applies. Planned in the casting spec, second handover |
| `universes add` | to decide; makes a universe for the entity from a list of entries (a name, titles, relations, traits, role hints), or fetches one from the library by name; built-in universes are public-domain only | planned | proposed; not in `src/permissions/map.ts` | decided 2026-10-19. Planned in the casting spec, second handover |
| `mcp check` | to decide; runs the per-client channel checks on demand — reachability with the client's Origin, the OAuth metadata, a signed ask round trip timed per stage; `team watch` runs them on a schedule | planned | proposed; not in `src/permissions/map.ts` | decided 2026-10-19 |
| `mcp deploy` | the owner's go where a policy asks for it; deploys only a reviewed sha by the one documented path, records the live sha for rollback, runs the per-client checks, and rolls back by itself if a check fails | planned | proposed; not in `src/permissions/map.ts` | decided 2026-10-19; no unreviewed sha is deployed |

The map has no `create` command row. `send` admission and `answer` pane authority are owned by their own gates; a map row itself admits no caller to them. The Kernel’s planned `issue a lease` means an authority lease, not the implemented local task lease. Planned operation rows are copied from the records/ledger spec’s §6, with no new authority. Proof: `test/permissions/resolve.test.ts`, `test/permissions/fail-closed.test.ts`.

The Roles contribution names lifecycle `start`/`stop` by their act; their CLI surfaces here are `up`/`down`. It also calls same-copy addition `add-same-copy` and ordinary removal `remove-ordinary`. Those are conceptual delegated-form labels, not identifiers in the command map or grant vocabulary at either pinned revision; the separate planned same-copy/ordinary-removal contracts do not create new commands or alter the tag’s `add` gate. The Roles contribution’s shorthand “as start” does not supersede the command map’s owner-only addition rule.

Contributions reconciled at this draft: accounts and gates, budgets, casting, events, grants, launch, messaging, quality gates, records and ledger, RFC process files (no entries), registry, roles, round, seat state and watch, tasks and broker. The Kernel’s §12 points to the same records/ledger contribution rows. All list-valued contributions were expanded against their pinned code source; feature settings outside the release catalogue remain planned.

## Revision log

- **Draft** (2026-10-18): read the pinned source lists and consolidated completed spec contributions; planned entries remain distinct.
- **Amended** (2026-10-19): six planned rows added from the night's decisions — `sessions`, `resume`, `cast`, `universes add`, `mcp check`, `mcp deploy` — each `proposed; not in src/permissions/map.ts`; who-may-run is the decision's words where the decision gives them (`cast`'s applying path, `mcp deploy`'s reviewed sha and the owner's go where a policy asks) and `to decide` where it does not. No implementation source at the tag.
- **Amended** (2026-10-19): the planned `cast` and `universes add` rows carry the casting spec reference (S6), deferred to the second handover; their operation and admission meanings are unchanged.

- **Phase A review and first-handover fold** (2026-10-19): casting references deferred as plain prose so the included files do not link to the excluded casting spec; casting added to the contribution summary; the planned operation meanings and undecided showing/addition gates are unchanged.
