# Synthetic owner statement and inert request contract

This is a **proposed wire v1**, based on the round-1 and round-2 fold rulings through docs
`3c94748`, reconciled with draft 6 at `f99ef13`. Nothing here activates a command, enrolls a
signer, authenticates a person, writes authority or supplies an execution permit. The frozen
`18791ec` gate and `SIGN_METHOD_COMMANDS_ACTIVE = false` are unchanged. Existing receipts and
their signatures are not migrated or reinterpreted.

## Modules and bytes

`src/signing/owner-statement.ts` exports the strict serializer, statement validator, challenge,
synthetic signer and cryptographic transcript verifier. `src/signing/owner-request.ts` exports
inert request construction, action classification and evaluation over injected current state.

`canonicalOwnerBytes(value)` is UTF-8 JSON with object keys sorted by JavaScript string order,
no whitespace, dense arrays in their original order, and safe integers only. It rejects negative
zero, undefined, accessors, non-plain objects, cycles, extra array properties and excessive input
(32 levels, 10,000 nodes or 256 KiB). It does not normalize Unicode or include a domain prefix.
`ownerValueHash(value)` is lowercase hexadecimal SHA-256 of those bytes.

The payload has exactly these fields; missing or additional fields refuse:

| Field | Wire type |
| --- | --- |
| `format` | `team-owner-statement-v1` |
| `request_id`, `signer_id` | one safe identifier, 1–81 ASCII characters |
| `params_hash`, `act_digest`, `nonce` | 64 lowercase hexadecimal characters |
| `choice` | `once`, `always`, `deny` |
| `standing_rule` | explicit `null`, or the object below for `always` only |
| `signer_type` | `mac-keystore`, `webauthn`, `phone-passkey`, `fido2-key` |
| `time` | canonical UTC ISO text with milliseconds |

`standing_rule` has exactly `kind`, `scope`, `bounds`, `expires_at`; scope and bounds are plain
JSON objects, including empty objects where appropriate. Its expiry is after statement time.
It is mandatory for `always` and forbidden for `once` or `deny`. The gate's nonce exists before
the payload. The challenge is SHA-256 of the **complete canonical payload**, nonce included,
without a domain prefix. The payload contains neither its own challenge nor its own hash.

The synthetic transcript is exactly `{ format: "team-owner-transcript-v1",
scheme: "synthetic-ed25519", statement, challenge, signature }`. Its single signature covers
UTF-8 `team-owner-statement-v1\n` followed by the 32 decoded challenge bytes. The challenge
and signature are hex. No public key or assurance claim in the transcript is trusted; verification
receives the synthetic registered public key from its host. There is **one owner signature**;
the transcript is copied into the record, not independently signed again. This scheme is a test
seam, not the wire assertion of a real device adapter or evidence of actual user presence.

For `all-of`, each signer signs its own statement, including its own identity and time. All
statements must bind the same request, parameters, act, nonce, choice and standing rule. Duplicate
signer ids refuse. No successful partial proof is reused for another request.

## Inert requests and trusted inputs

`OwnerAct` includes the seven classes (`create` is new beside the frozen six-class parser),
operation, level, target, artifact, payload, input state and request id. `OWNER_KIND_CLASSES`
maps `grant`, `delegate`, `revoke`, `team-create`, `signer-add`, `signer-remove`,
`approval-policy`, `policy`, `publish`, `spend`, `go` to their classes; a delegate's class is
`grant`, team-create is `create`, signer and policy changes are `policy`. Unknown kinds refuse.
The parameter hash covers `act.payload`;
the act digest covers the complete `OwnerAct`, including input state and request id.

`createInertOwnerRequest(act, { requester, selfRequest, now })` returns a deeply frozen object:
`format: team-owner-request-v1`, request id, requester, self-request flag, creation and expiry,
parameter hash and act. Expiry is exactly 15 minutes after creation. There is no stored nonce.
The caller identity and self-request status must come from trusted placement/admission. This
constructor does not authenticate a requester, sign a request record or persist one.

The evaluator requires `context.verifiedRequestHash`, supplied independently from the host's
verified request, and compares it with the complete request. This binds requester, self-request
status and expiry as well as the act. Supplying a hash computed from untrusted incoming JSON
would not verify a request. A production signed-request store and durable single-use claim are
**not implemented**. The injected `spentRequestIds` and returned `nextSpentRequestIds` describe
an in-memory transition only; callers must not use this module to execute authority writes.

`createOwnerStatement(request, answer)` constructs the strict payload. The host supplies a fresh
nonce, decision, explicit rule/null, signer identity/type and time. A cryptographically valid
statement is not by itself proof of current membership, policy satisfaction or authorization.

## Action classification and policy

Authority parameters for `grant` and `delegate` must expose `commands` and
`capabilities` arrays, even when empty. Unknown command/capability words refuse. Administrative
words, including the Kernel's administrative names, `delegate`, `revoke`, `init`, `signer`,
`policy`, `approve`, `approval-policy`, and non-null `grant_scope`, require fresh high assurance.
This is a proposed parameter projection; production command projections have not been wired.
Team creation always requires fresh high assurance. Approval-policy names, including
`sign-method`, `owner-signers`, and the approvals policy family, do too. An ordinary policy
change is class `policy`, with the policy name in `payload.name`.

Authority writes and self-requests never admit `none`. Ordinary publish/spend/go and ordinary
non-approval policy changes can use it with no floor and verified policy evidence. Fresh-high
acts and self-requests never admit `always`. Other always answers require current permission,
an exact operation-kind match and the host's current scope/bounds/TTL containment check; a
policy rule must additionally name the exact policy in `scope.policy_name`. This slice verifies
fresh always answers; it does not install or automatically match standing rules.

`InertOwnerContext` injects current act, independently verified request hash, current signer list,
method/floor, minimum assurance, always permission, signer mode, nonce, clock and spent ids.
Missing signer policy refuses. Registered signer descriptors map `mac-keystore` to `touch-id`,
the passkey/key types to `phone`, and `terminal` to `terminal` with no key. High assurance here
is a **synthetic method/type assumption**, not measured hardware proof. Terminal is low;
any-of has its lowest branch assurance and all-of checks every part. Real adapters must verify
their own presence/verification and pinned enrollment before supplying these facts.

Proofs may be 30 seconds old and at most 5 seconds in the future. They cannot predate request
creation beyond that skew. The 15-minute request lifetime does not extend proof freshness.
The current act/input state, nonce, signer membership, selected method/floor and assurance are
checked on each evaluation. A changed choice/scope/digest/nonce invalidates the single signature.

Draft 6's terminal exception is `evaluateInertTerminal(request, context, signerId)`: no signed
statement, nonce, challenge or answer object is produced. Its decision is `once`. The independent
trusted host placement observation is exactly `{ request_id, act_digest, owner: true,
terminal: true, unattended: false }`, bound to this request and act; no incoming answer vouches
for itself. The record carries `taken: terminal`, the terminal signer's id/type and placement,
and has no `attestation` or signature. It cannot meet a fresh-high requirement. An all-of with
mixed terminal/device parts is not yet implemented; the standalone placement evaluator refuses
incomplete combinations rather than inventing a terminal statement.

## Records and limits

`evaluateInertOwnerAnswer` returns a validated **inert** answer, including `deny`, or a refusal.
`ok: true` means the answer verified, never that an effect may execute. A deny records its choice
and claims the injected request id; it approves nothing. The records are disjoint:

| Type | Consumer | Shape |
| --- | --- | --- |
| `approval` | owner GO only | `run_id` copied from required `act.payload.run_id`, request, transcript list or terminal placement |
| `approval-answer` | other owner-proof classes | request and transcript list or terminal placement; no run id |
| `policy-approval` | policy-authorized `none` only | request, verified policy reference, synthetic tool signature; no run id |

`evaluateInertNone` requires the host's current policy verification callback and synthetic tool
key. Its result decision is the record sentinel `policy`, never a signable owner choice or
an assertion that the owner answered `once`. Its separate tool signature covers domain `team-policy-approval-synthetic-v1\n` followed by
canonical `{type, request, policy}`. `verifySyntheticPolicyApproval` checks that signature and
record shape, not current policy authority. It is never accepted as an owner answer. No record
fabricates a run, writes a ledger, changes a grant or invokes an existing command.

Refusals use `owner-wire.*`, `owner-request.*` and `owner-answer.*` reason strings in the module.
These proposed internal literals are not CLI exit ids or a registry addition. Testers should
pin only the reasons relevant to their independent cases. Durable storage, production enrollment,
native proof verification, command integration, terminal observation, current policy resolution,
scope containment and actual effects remain separate work under the existing authorization gates.
