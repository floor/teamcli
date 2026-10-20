# `team queue`: rationale and known limits

What moved off [the `team queue` page](../commands/queue.md): what the run reads and writes, the
source it picks, the add in its own words, the two green-slice events, the refusals, and the
known limits. The synopsis, the flag table and the exit codes stay on the page.

## The source the queue is

The local queue is a fallback, not a second store beside a declared one. The team file's `tasks`
union decides which file a team reads:

- no `tasks` section: `.agents/queue.yaml` under the team root. It is the local queue, and its
  absence reads as an empty list — a team that has never queued anything is not a broken team.
- `source: file`: the owner's declared `path`, relative to the team root. Its absence stays
  `missing`, and the command refuses as `team next` and `team plan` do; the fallback never
  quietly replaces a path the owner wrote.
- `source: linear`: no local queue at all. `add` and `list` both refuse in one line, and nothing
  is sent to the tracker or to the broker.

The read is the file adapter's (`src/tasks/file.ts`): the same list, the same id rule, the same
known fields, the same refusals. A record the adapter refuses beside accepted records is printed
as a note on stderr and does not block the listing or the add. A file that holds only refused
records is `queue.read` with the reasons joined.

The path must stay inside the checkout (`taskPathStaysInside`), checked before any read or write.

## The add

`add` validates its arguments first — title, id, assignee, priority — then judges the caller,
then calls `addToQueue`. Nothing is read or written before all three passes.

The caller is the owner, or a declared seat of this team standing on the pane the state records
for it. A seat of another team, a declared seat with no recorded pane, and a declared seat whose
recorded pane is another pane are all refused; the pane gates the write. `list` asks nobody.

The write itself is one lock (`withLock` on `.agents`, the state's own lock), one read, one
append, one validated replacement:

1. read the source with `readFileSource`;
2. an id already present is `present` when the whole record is deep-equal — the file is not
   rewritten — and `duplicate` when any field differs;
3. otherwise the whole candidate file is written to a sibling temporary file
   (`<path>.<pid>.tmp`) and read back through the file adapter. The add lands only when the
   reader accepts the candidate and finds the new id among its records;
4. the temporary file is renamed over the queue, and removed on every path out.

Text is written double-quoted with the parser's escapes, and a numeric priority is written as a
number. The empty flow list `[]` is replaced by the block form; any other flow list is
`not-a-list` on the read before the append, so it is refused rather than replaced.

## The green-slice events

`ready` and `install` record into `.agents/green-slices.json`, a journal of task, seat, commit,
version, installer and instants — no brief body, message text or free-form note. The recorders
are `src/tasks/green-slices.ts`, under the journal's own lock and atomic rename, the same way the
team state is written. A slice is pending until an install event names the same task and commit;
`pendingGreenSlices` pairs them, and a malformed install entry is dropped at the read door, which
leaves the slice pending — the safe direction.

### `ready`

The seat is the verified caller, never an argument: a declared seat of this team on the pane the
state records for it. The owner is refused — this is a seat's own record. The caller must hold a
live lease whose id is the task it names (`liveLeaseOf`, the same thirty-minute lease `team next`
takes), and the task must be in the queue the team reads. A missing record is `the queue has no
task "<id>"`, not an implicit add. The same event again is `held`: the journal keeps one record,
and a different commit for the same task is a second event, because it is a different slice.

### `install`

Running the verb is the acknowledgment, and it installs nothing itself. It is not implied by a
ready, a merge, the clock, or a version comparison. The journal's recorder takes the task,
commit and version; the installer is `installedBy`, the verified caller — `owner`, or the named
seat — never an argument. The task need not still be in the queue: the acknowledgment is of the
commit, and a queue that dropped the record does not erase what was installed.

The seat gate is the owner, or the one seat the team file names in `installer:`, on its recorded
pane. That designation is an owner section and counts only while it is part of the approval in
force: `designationApproved` requires a verified approval standing and no `` `installer` changed ``
difference. Without a verified approval, or with a hand edit since the last one, the gate falls
back to the owner alone — the file cannot make itself an installer, so an unapproved designation
admits nobody. Adding the section itself is no difference: the approval fingerprints fill a
section missing from an older record from the record's own stored copy of the file, so an old
approval still stands until someone writes the key.

Refusals keep their own exit ids: `queue.lease` for no live lease or another task, `queue.caller`
for the seat gate on `ready`, `queue.installer` for the designation gate, and `queue.record` for
a journal that is malformed or holds its 256-event cap.

## Known limits

- There is no remove or edit verb: a record is edited in the file, as any file source is. An
  edit that collides with an existing id is a `duplicate` on the next add, not a merge.
- The queue is per checkout, like every file source. A second clone has its own file and its own
  leases; nothing synchronises the two.
- The add is atomic against a concurrent add in this checkout through the state lock. Two
  checkouts writing the same branch are git's problem, as they are for any committed file.
- A seat that has never been started cannot add: the state has no pane to place it on. The
  refusal names the repair — the owner records the seat's pane and runs `team up`.
- Until the owner writes `installer: <seat>` in the team file and approves it, only the owner
  records an install. The verb cannot infer a designated installer from a message, a role or a
  running pane; an unapproved hand edit withdraws the designation rather than creating one.
- The owner cannot record a slice ready: `ready` is a seat's own record, and `installedBy` is
  what names the owner. A team with no live seat lease has no ready path at all.
- The journal keeps at most 256 events, dropping installed history before pending slices; a
  journal that is nothing but pending slices refuses a new record rather than evict one. A
  malformed journal is refused with the file's path; the repair is to move it aside.
- The journal is per checkout, like the queue and the leases. A second clone has its own
  journal, and nothing synchronises the two.
