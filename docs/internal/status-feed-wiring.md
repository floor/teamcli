# Native status feed (opt-in)

The existing daemon `--presence` flag also enables a body-free `seat.status`
record. The flag remains off by default. No native status consumer, audience,
permission response, wake or dispatch route is added.

This initial slice has **no production controller registration** for provider
turn, lane, tool or gate identities. Every production record therefore carries
`status_availability: correlation-unproven`, advisory `unknown`, continuity
`unproven`, and gate `unknown`. Process confirmation is conservatively `needed`;
there is no process-exit assertion. Quiet is never translated into legacy idle,
and a session-end never disposes a current owner. The existing `presence.changed`
contract and its consumers are separate.

The Codex observer uses the original primitive frame text from the existing
permitted connection, before JSON-RPC role handling. It does not connect again,
start a runtime or answer any request. Matching payload identifiers do not
register correlation. Repeated identical refusal results are coalesced in memory;
they are neither provider sequence evidence nor channel-health heartbeats.

The Claude hook keeps its existing legacy behavior when native hosting is off.
It reads additional bounded stdin only when the marker names its argv binding,
the state's current binding and claim, and the active machine daemon's opt-in
owner nonce from the machine daemon record outside the checkout. Its location
comes from the OS-provided account home, never the hook's `HOME` or marker text
([Node OS reference](https://nodejs.org/api/os.html#osuserinfooptions)). The
existing process-placement guard must also place the caller in
the seat's recorded pane and session. The daemon record is opened once, no-follow, and checked with fstat on that descriptor, so a symlink cannot be swapped in between a check and a second read. A marker's short lease disables abandoned
markers; it establishes no native freshness or health. The daemon refreshes
markers only on the existing presence pass and removes its own markers on close.
The ordinary legacy Notification filter caps its stdin at 65537 bytes, even with `--presence` off. An oversized Notification only fails the permission-prompt match: fewer stagings, the safe direction, and only above 64 KiB, which no real Notification reaches. The cap stops a runaway stdin from hanging the hook.

A refusal reason is the seat's own word. The status-feed reader (`team trace`'s note for a `seat.status` row) and the lead's delivery line both show it quoted and labelled as reported by that seat. A seat name that is not a seat id is left out. The reason keeps at most 200 characters and is marked cut past that. DEL, C1, line and paragraph separators, and bidi controls are escaped inside the quotes. Neither surface presents the word as a finding.

Only fixed refusal receipts enter the private presence status spool. No prompt,
tool payload, provider identifier or raw error is persisted or published. The
daemon validates the complete refusal-only shape and current binding/claim again
before append. Invalid/stale receipts are set aside, not repaired or promoted.

Each current seat/binding has an isolated candidate and durable publication
cursor. `status_seq` counts publication attempts in this contract; it is **not**
the provider's observation sequence. A pending record keeps its exact payload
and deterministic `status:<seat>:<binding>:<sequence>` identity across append
retry/restart. The next existing pass retries a busy append without a new timer.
A stale producer cannot replace or dispose the current launch. Close stops new
native admission; pending receipts remain for a later opted-in owner.

`nativeCandidateFromText` accepts explicit trusted registration only as an
in-process test seam. No CLI flag, hook body, spool field or production caller
supplies it. Synthetic scenes exercise both adopted adapters and the reducer's
open/clear, subagent, stale and gap fences. They do not establish production
correlation or live lifecycle coverage. Trusted controller registration, reducer
main-turn handoff and any status consumer require separate work.

Claude real positive capture coverage remains pending. The two Codex capture
attempts supplied setup and rejected-turn frames only; positive lifecycle
coverage and acceptance completeness remain false. This source slice does not
authorize installation, live enablement or another capture.
