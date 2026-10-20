# `team brief`: rationale and known limits

What moved off [the `team brief` page](../commands/brief.md): why a delivery is a claim and a
drop, what the command reads and writes, how a held name is recovered, the crash seams, and the
limits. The synopsis, the flags, who may run it and the exit codes stay on the page.

## Why a command at all

The general seat brief — the built-in first text every seat gets — was delivered only by a
launch. A team already up, or a build that changes the brief, had no way to bring its seats to
the new text without relaunching them. `team brief rollout` is that way, and it is the same
boundary every launch calls (`deliverBriefForAttribution`), so the two paths cannot drift: one
works out which seats to write, the other writes one seat's claim and its record.

A delivery is deliberately not a pane operation. It writes a signed message record into the
seat's drop folder and nothing else; the seat's own turn-start reader (`team drops --read`)
verifies it, writes its receipt and prints it. Nothing is typed, no screen is read, and the
command needs no herdr call — which is why it works for a human seat too.

## The claim

Each seat's delivery lifetime lives in the session's state under `briefs`. The claim names:

- `incarnation` (`inc_<12 hex>`) — the seat's delivery lifetime. A fresh lifetime is minted when
  a live CLI seat has no claim or an old build's claim; a reword under the same lifetime keeps it;
- `epoch` (`run_<12 hex>`) — the runtime epoch a reader is started with. A read receipt counts
  only while the claim still names its epoch;
- `sha256` — the delivered body's digest, so a claim and a record compare without trusting text;
- `id` — the expected drop file name, derived from the lifetime and the delivered body: attempt 0
  is `sha256(incarnation + "\n" + delivered body)`, and a recovery attempt hashes the attempt
  number between the two. The digest's first 32 hex digits are shaped as a lowercase RFC 4122
  UUID, the only name a drop may have;
- `attempt` — 0 on the first delivery, one more for each recovery;
- `stage` — `claimed` while the drop is being written, `ready` once it was read back and verified;
- `superseded` — the earlier ids the claim replaced, newest last, fifty kept.

The claim is written under the state's lock before any file, and the drop is posted at exactly
the claim's id. The boundary reads the record back, verifies it with the message key, and only
then finalizes the claim at the record's own `at`. A claim whose drop is missing, or whose name
holds something else, is what `team check` reports as not delivered — the state is never
evidence that a record exists.

The id is derived, never stored twice: a repeated delivery of one lifetime posts the same name,
so an interrupted run is finished by the next one without a duplicate. A reworded brief is a new
id under the same lifetime; each delivery also records the id it replaced, so a read of an older
record can be refused as superseded rather than served.

## Currency is not read

The rollout reports a seat `current` when its claim is this build's brief and the record at the
claim's id verifies. It never writes a read receipt and never asks whether the seat read the
brief: a live seat freshly delivered is `current` while still `not read`, and that is
[`team check`](check.md)'s line. `--apply` therefore exits 0 on a clean delivery even though every
live seat reads `not read`.

## Who is delivered, and when

A rollout targets every declared seat the session's state records as running (`seats[name]`
exists) and every human seat. A declared CLI seat that is not running is not mailed into a
stopped pane's folder: its next launch delivers it, and the plan prints `not running <seat>:
delivered at its next launch`. A human seat is delivered to exactly like a CLI seat and is never
read — the plan and apply always say `human <seat>: delivery only`.

The attribution commands call the same boundary, each with the targets its own path works out.
`team add`, `team restart` and `team register` pass `broadcast: true`: they attribute the seat
they acted on and reach every live or human declared seat as well. `team up` attributes the seats
its plan launches or adopts, and `team reload` the seat it acts on; the other live or human seats
are targeted only when this build's brief is ahead of their claim. Every path that launches a seat
writes the claim and its signed drop before the launch line is typed. `team rename` attributes
the seat under its new name, after the state's own rename. The swap and resume paths go through
the restart path where that caller exists; no call of their own is on this head. A rollout is
never required by a launch: each is complete on its own, and a second run of either finds the
seats current.

## A held name, and recovery

The drop writer never replaces, removes or follows a name it did not write. A regular file at the
expected id that is not this brief's record, a symbolic link, a FIFO or a folder is reported, and
the plan prints `recover ...`: the run records the claim's next attempt and posts the drop at
that attempt's id instead, leaving the held name byte for byte as it was found. Only `--apply`
recovers; an ordinary launch reports the held name and leaves it, so a person can look at it
first.

Delivery is idempotent in both directions: a verified record already at the id is kept as the
delivery it is, and a retried apply keeps the same lifetime and attempt and posts the same id, so
a failed seat is retried by the next apply with no duplicate.

## Crash reconciliation

| Crash point | On disk | The next boundary | `team check` until then |
|---|---|---|---|
| before the claim write | nothing | mints, delivers | not delivered |
| after the claim, before the drop | claim with its expected id | sees the file missing and writes it | not delivered |
| during the drop write | a temp file, no record | retries; a temp is not a record | not delivered |
| after the drop, before finalize | claim and verified record, `stage: claimed` | keeps the record, finalizes at the next launch | delivered; a receipt, if any, is provisional |
| after the drop | claim and verified record | `recordHolds` → keep | delivered, not read (until the seat's turn) |
| mid-broadcast | some seats delivered | retries the rest | per-seat lines |
| a blocked name | claim and the old file | `--apply` recovers at the next attempt | does not verify until recovery |

## What it reads and writes

Reads the team file (the checkout's own, or this folder's team root), the session's state, and
the drop folder of each live or human seat, including the `.inbox-listener` its MCP server writes.
`--apply` writes the claim in `.agents/team.state.json`
and one signed record per due seat under `.agents/send-drops/<session>/<seat>/`; nothing else.
Delivery is local file I/O with no network leg. A folder that cannot be written, a checkout with
no message key, a link at the name or a read-back failure is reported for that seat alone, and a
later apply or launch retries it.

## Known limits

- The dry run's row for a seat with no claim shows the id a fresh lifetime would produce — its
  lifetime is minted by the run that writes, so `--apply` reports the id it actually used.
- A recovery is `--apply`'s alone. A launch and every other attribution path report a held name
  and leave it; only a person decides to move past it.
- A not-running seat is left entirely alone, stale claim included, until its next launch.
- A seat whose live inbox server records a version or build other than this build's — or no build
  identity at all — is reported stale and written nothing. The server keeps the parsers of the
  build it started with, so a record this build signs can fail verification there; the fix is a
  restart of the seat's CLI host, never a weaker signature.
- A held symbolic link or folder is never followed, read or replaced, and a recovery does not
  change that: the new record lands at a new id beside it.
- The rollout writes no receipt, so it cannot make a seat `read`; only the seat's own reader can.
- A claim records a delivery, not a lasting fact: a record deleted after a clean apply turns
  `team check` red and the next apply or launch posts it again at the same id.
