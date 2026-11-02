# team waits

Lists the messages this seat is still waiting on an answer to, and how long each has waited. A
wait is a signed message record whose kind is `task` or `question` and that has no `replied`
receipt beside it. `team send --kind task` and `--kind question` write such a record on the
release that adds the writer; this build reads the record and lists it, and a send that names no
kind is not a wait. The addressee's reply writes the receipt that takes the record out of the
list.

Every message record lives in its recipient's folder,
`<root>/.agents/send-drops/<session>/<seat>/<id>`, so this command finds a wait where the record
sits, not where the sender wrote it: it reads the send-drop trees of every checkout the team
registry names and keeps the records whose sender is a seat of this team. Each record is verified
with the checkout's message key before any field is read; a file that does not verify, whose id,
seat, session or checkout does not match the folder it sits in, or whose kind is none of the
waiting kinds is not a wait. A record written by another team's seat is never listed — a
same-named seat of another team is not this team's seat. Nothing is written: no receipt, marker
or message key.

A seat lists the waits it wrote. The lead — the team file's `coordinator:` seat, including one the
file marks `leads: true` — lists its whole team's waits, including the records its seats wrote
into another team's checkout; such a row shows the awaited seat as `<seat>@<team>`, named by the
registry project the record points at. A lead's call prints the whole team's waits; a seat of
another team is refused, and so is the owner.

Retention is the team's signed `event-retention-days` word, read through the policy chain (30 days
by default). A record older than the window is left out of the listing; this command deletes
nothing.

## Synopsis

    team waits [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--json` | — | print one `team.waits` document instead of the table |
| `--help`, `-h` | — | the usage, and exit 0 |

The table shows the `WAITER` seat, the `AWAITED` seat (with its team when the record sits in
another checkout), the record's `KIND`, the `WORK` item when the sender named one, and how long
ago the record was written; then the count, `2 waits`.

## The document

`--json` prints one `team.waits` document: `format: 1`, the `project`, `session` and `seat` the
listing was read as, the `scope` (`seat` for a seat's own waits, `team` for the lead's), the
`retention_days` in force, and `waits` — oldest first, then by id. Each wait carries its record
`id`, the `from` seat and its registry `from_id`, the awaited `to` seat and `to_id`, the `kind`,
the `work` item and `subject` when the sender wrote them, the record's `at`, its `age_seconds`,
its `thread`, and `to_team` — the registry project the record points at, `null` when it sits in
no registered checkout. A missing or unreadable message key lists nothing and adds a `notes` line
saying so, because no record can be verified.

## Exit codes

| Code | When |
| --- | --- |
| 0 | the waits were listed |
| 1 | the caller is not a seat of this team |
| 2 | the invocation, the team file, the registry or the retention policy can't be read |
