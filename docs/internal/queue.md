# `team queue`: rationale and known limits

What moved off [the `team queue` page](../commands/queue.md): what the run reads and writes, the
source it picks, the add in its own words, the refusals, and the known limits. The synopsis, the
flag table and the exit codes stay on the page.

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

## Known limits

- There is no remove or edit verb: a record is edited in the file, as any file source is. An
  edit that collides with an existing id is a `duplicate` on the next add, not a merge.
- The queue is per checkout, like every file source. A second clone has its own file and its own
  leases; nothing synchronises the two.
- The add is atomic against a concurrent add in this checkout through the state lock. Two
  checkouts writing the same branch are git's problem, as they are for any committed file.
- A seat that has never been started cannot add: the state has no pane to place it on. The
  refusal names the repair — the owner records the seat's pane and runs `team up`.
