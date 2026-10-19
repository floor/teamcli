# @teamcli/relay

TeamCLI's message transport. It stores the one durable signed copy of a message and makes one
route attempt at a time: a socket frame, or the durable copy itself.

Private and local-only. Nothing here is published; publishing waits for the owner's go.

## What it owns

- The durable copy write: the record's bytes at the caller's path, whole, mode 0600, inside a
  folder kept at 0700, published by an exclusive hard link, so an existing holder is never
  replaced and the record is never written through a link.
- One socket attempt: the frame line as given, one connection, the measured frame limit and
  deadline, and the receipt's byte count and time.
- `capabilities`: a pure, synchronous answer about what the calling runtime carries.

## What it does not own

TeamCLI keeps placement, admission, signing, record identity, seat locks, drop-tree sealing,
pending markers, history, the feed, delivery order, policy, exit codes and the typed terminal
leg. The signed record is opaque text here: the package stores and carries it, and never checks
a signature. This package starts no server and no service on import. The relay-host modules live
in this same package without importing TeamCLI: `host/server.js` frames one caller's machine
socket, and `host/queue.js` holds durable messages for a host that took verified admission. The
framing host binds only when its caller calls `listen`, inside the caller's process; the queue
opens no socket. The listener and the verified caller stay the receiving session's host. Both
host modules are included and exported at `@teamcli/relay/host/server` and
`@teamcli/relay/host/queue`, with declarations beside the code.

## Current endpoints and auth

The machine daemon still hosts each checkout's existing send and bus listeners beside the machine
socket: N checkouts mean 2N+1 endpoints in one process today. The host modules remove none of
those listeners, and this build does not produce or claim a single endpoint.

Mutating daemon requests (send, next, route, receipts, feed, events and the like) are still
refused with `daemon.auth-unsupported`: there is no verified principal, and no field in a request
— including a caller or scope object — is trusted. The framing host only frames; admission,
signing, health semantics and the refusal answer stay in TeamCLI.

## Policies and invariants

The delivery policies are configurable and keep three names: `delivery-order`,
`delivery-timeout` (per route) and `delivery-escalation` (delays). The caller resolves them; this
package makes one attempt in the order it is given.

Four rules are fixed, not configurable:

- a signed durable copy is written before any attempt;
- a route that would hold or block is never chosen;
- one message ID, with de-duplication at the receiver;
- every attempt is recorded.

In this version the copy-before-attempt rule is the caller's contract for this standalone API:
`stage` first, then one `deliver`. This package makes no fallback decision and keeps no attempt
record; for the standalone API, receiver de-duplication, the attempt record, escalation and
fallback are the next change, not this one. TeamCLI's caller-side send path carries its own
sender walk separately; this package neither implements nor measures it. The timing values
reviewed for that next change are listed in
`packages/relay/docs/live-proof.md` under "Reviewed next behavior"; they are not in this build
and are not measured here.

## API

```js
import { stage, deliver, capabilities, dial } from '@teamcli/relay';

const copy = { dir: dropDir, name: messageId };
const staged = await stage(copy, { id: messageId, record: signedText });
// staged: { outcome: 'stored', receipt: { copy, existing?, at } }

const attempt = await deliver(
  { route: 'socket', socket, runtime: 'claude-code', copy },
  { id: messageId, record: signedText, frame },
  { dial },
);
// attempt: { route, outcome: 'delivered' | 'held' | 'refused' | 'read', reason?, receipt }
```

`stage` first, then one `deliver` per route in the order the caller resolved. The caller decides
what a refused attempt means and which route comes next; `deliver` never falls back on its own.
`deliver`'s durable-copy route stores and returns `held` — a durable copy is never a delivery.
`read` is reserved for a signed read receipt, and this build never returns it.

Outcome words are the transport's, not the message's:

- `delivered` — the socket took the frame (the write callback reached the kernel). The socket has
  no acknowledgement, so this is transport, never a read.
- `held` — the copy is stored and no live route woke anyone.
- `refused` — the copy could not be stored, or the route was not attempted; `reason` is the
  caller's fallback line.

`stage` is create-or-match. A regular file already at the name is read without following a link:
identical bytes make the copy `existing`; different bytes are refused and the file is left
untouched. A link, FIFO, folder or other holder is refused. The package never checks a signature,
so the caller still decides what the record means (same id, same signature), exactly as admission
always has.

`dial` is the raw socket primitive TeamCLI's `src/send/uds.ts` delegates to. Callers that inject
their own transport pass it as `options.dial`; that keeps an injected host's dial and the
package's client the same code path from the caller's point of view. A dial owns its own
deadline when supplied; `timeoutMs` applies to the package's default dial.

## Host modules

The host modules are plain Node ESM with hand-written declarations beside the code: no
dependencies, no TeamCLI import, no service. They are included and exported at
`@teamcli/relay/host/server` and `@teamcli/relay/host/queue`, with declarations.

### `host/server.js` — socket framing

`createHostServer({ socketPath, onRequest, onRefused, frameLimit, deadlineMs, onError })` accepts
one connection, reads one newline-terminated JSON line, hands the decoded value and the exact
stripped line to `onRequest`, writes the handler's answer once and ends the connection.

- The frame limit defaults to the daemon protocol's measured 65,536 characters and counts the
  newline; a frame past it is refused, never truncated.
- The frame-assembly deadline is off by default (`deadlineMs: 0`), as the daemon socket is
  today. An explicit deadline is cleared when the line arrives, before `onRequest`, so it never
  cuts off an admitted handler.
- `onRequest` receives untrusted data: no field, including a caller or principal field, is
  trusted, and no JSON value becomes an identity.
- The module never unlinks or chmods `socketPath`: stale-path and permission ownership stay with
  the caller, and Node's listener removes only the path it bound itself.
- It binds only when `listen()` is called, inside the caller's process; importing it starts no
  listener and no service. Refusals are the caller's exact bytes through `onRefused`.

### `host/queue.js` — durable queued host

`createHostQueue({ dir, now })` keeps one durable record per verified recipient and message id:
`enqueue`, `claim`, `ack`, `release`, `recover`. A claim is fenced by an epoch token; recovery
needs a fenced caller and receiver-gate evidence, and a bare "no record" is not evidence. The
recipient comes from the caller's verified admission and is trusted data, never an authorization
token; the queue performs no admission and no auth. It opens no socket, starts no service, and
never imports TeamCLI. Its verdicts are the ones its declaration lists; no run of the queue is
recorded on the proof page.

## Proof

`packages/relay/docs/live-proof.md` in the repository records the transport and packed-install
runs at the extraction commit, and the copy-collision and identity runs at the correction commit
that made `stage` create-or-match, with the exact outputs and file hashes. It also records the
framing host's focused synthetic tests and the machine-socket adapter's focused daemon tests,
with their exact commands and counts. In short: the staged copy's mode and bytes, the
extraction's existing-file answer kept as history, the correction's byte match and refusal with
the holder untouched, one complete frame taken by a local fixture peer, the refusals, and a
packed tarball and installed build whose relay files are byte-identical to the extraction
commit's. No run shows a runtime reading a delivered frame, and no run wakes or reads a durable
copy. Those remain unproven, and this standalone API's next change is not measured here.

## Compatibility

The frame bytes and the drop names and contents are frozen in this extraction: TeamCLI still
builds the frame line and signs the record, and this package writes those bytes unchanged. For
this standalone API, the fallback change — a held route continuing to the next allowed route,
cross-route de-duplication, recorded attempts and escalation — is a later, explicit change;
TeamCLI's caller-side send path carries its own walk separately.
