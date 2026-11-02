# `team waits`: rationale and known limits

What moved off [the `team waits` page](../commands/waits.md): why a wait is derived from signed
records, why the read walks every registered checkout, what it cannot know, and the record-format
version note.

## What the run does

A wait is not stored as a wait. The record a `team send --kind task|question` writes is a signed
message; the reply the addressee later writes puts a signed `replied` receipt beside that record,
in the same folder (`team reply` writes it at the replying seat's own record folder, whose `to` is
that seat). The listing is the difference: a record of a waiting kind with no verifying `replied`
receipt, and nothing else. That keeps one source of truth — the transport tree — and means no
listing can invent a wait, and no reply can lose one silently: a replied receipt that does not
verify changes nothing, so the record stays listed.

The record sits in the RECIPIENT's folder (`<root>/.agents/send-drops/<session>/<seat>/<id>`), so
a sender's waits are not in the sender's checkout unless the recipient is a seat of it. The read
therefore walks the send-drop trees of every checkout the team registry names, verifies each file
with the caller's message key, and keeps the records whose sender is on this team's roster. A
sender is read strictly: a `from_id` must match a roster line; a record written without one is a
declared seat's only inside this team's own checkout, and only for a name the team file declares.
That rule is what keeps a same-named seat of another team from reading as this team's seat — the
case a name-only lookup gets wrong.

A lead is the team file's `orchestrator` — the `coordinator:` seat, or a seat marked `leads: true`.
Only that seat gets the team-wide scope; every other seat sees the records it wrote. The awaited
seat is shown as `<seat>@<project>` when the record sits in another registered checkout, named by
the registry project, and plain when it is this team's.

The retention window is the signed `event-retention-days` threshold of the caller's policy chain,
read up to the team level (the default is 30 days). It bounds the listing, not the store: records
past the window are still on disk, and deleting them is not this command's work.

Read-only: the run writes no receipt, marker or message key, and a home with no key still lists —
nothing, with a note that no record can be verified.

## The record format version note

The message record gains two optional signed fields: `message_kind` (one of `task`, `question`,
`answer`, `result`, `ready`, `blocked`) and `work` (the sender's own words for the work item).
Both are omitted when the send did not name them, so a record written without them is
byte-for-byte the record earlier builds wrote, and the record's kind field (`kind: message`) is
unchanged. Every readable signed field is listed in the record's field set, so the signature
covers them like the rest.

The shape rolls out in two phases, because a field added to the sealed record is one an older
build refuses. This release is the reader: it lists the fields in the record's field set and
projects them, and writes neither. The writer that names them (`team send --kind` and `--work`)
ships in the release after. A record carrying either field is refused as unsupported by a build
that does not know the field, the same rule every signed field follows. A receiving team below
the reader release therefore refuses a cross-team `--kind`/`--work` record as unsupported, and
the sending team cannot upgrade it: the record stays in the recipient's folder and is served
when that team upgrades, so the cost is delivery latency, not loss. Do not use the flags
cross-team until the machine's build train is past the reader release; a team's own seats are
that team's to keep on one build.

A build that reads `message_kind` but not one of its values serves the record as a plain message:
the unknown value is dropped, never interpreted, so a later release can add kinds without older
readers refusing the records that carry them. Only a field NAME a build does not read is
unsupported. Adding a value is the compatible half of the same rule; adding a field still waits
for the releases that must read it.

This — reader first, writer a release later — is the pattern for every optional signed field: the
builds that must accept a field are the ones already running when it is first written.

`team waits` reads a record with no `message_kind` as no kind at all: an older task-like message
never becomes a wait retroactively, and no reply is required for it to leave a list it was never
on.

## Known limits

- A wait is derived, not tracked: a record deleted from its recipient's folder is no longer a
  wait, with no trace in the listing that it existed. Transcripts and the feed are where a
  message's history survives.
- The read walks every registered checkout's send-drop tree. On a machine with many checkouts
  that is many folders, and a folder this process cannot read is silently no records — the
  listing cannot tell a permission problem from an empty tree.
- The team scope is the lead's alone. A seat that is not the lead has no flag to widen its own
  listing to its team's; that is deliberate while the lead's view is the one that matters.
- A reply that lands after the retention window does not change the listing; a record already left
  out by age is out whatever a later receipt says.
