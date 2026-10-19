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
a signature. The listener belongs to the receiving session's host — this package opens no server
and starts no service. A future relay-host (server, queue, health) lives in this same package,
behind its own exports, without importing TeamCLI.

## Policies and invariants

The delivery policies are configurable: delivery order, a delivery timeout per route, and
delivery-escalation delays. The caller resolves them; this package makes one attempt in the
order it is given.

Four rules are fixed, not configurable:

- a signed durable copy is written before any attempt;
- a route that would hold or block is never chosen;
- one message ID, with de-duplication at the receiver;
- every attempt is recorded.

In this version the copy-before-attempt rule is the caller's contract: `stage` first, then one
`deliver`. The package makes no fallback decision and keeps no attempt record; receiver
de-duplication, the attempt record, escalation and fallback are the next change, not this one.

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

## Proof

`packages/relay/docs/live-proof.md` in the repository records the transport and packed-install
runs at the extraction commit, with the exact outputs and file hashes. In short: the staged copy's
mode and bytes, the existing-copy answer, durable `held`, one complete frame taken by a local
fixture peer, the refusals, and a packed tarball and installed build whose relay files are
byte-identical to the commit's. No run shows a runtime reading a delivered frame, and no run wakes
or reads a durable copy. Those remain unproven, and the next change is not measured here.

## Compatibility

The frame bytes and the drop names and contents are frozen in this extraction: TeamCLI still
builds the frame line and signs the record, and this package writes those bytes unchanged. The
fallback change — a held route continuing to the next allowed route, cross-route de-duplication,
recorded attempts and escalation — is a later, explicit change.
