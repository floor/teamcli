# The team file

`team` reads one team file per clone: `.agents/team.yaml` under the project root, or the path
`--file` names. It is a documented subset of YAML, read by the library's own parser — maps, lists,
one-line `{ }` and `[ ]`, plain and quoted values, comments; anchors, aliases, merge keys, tags,
block scalars, a second document and duplicate keys are refused, with the line number. The JSON
Schema ships at `schema/team.schema.json`, and `team init` writes a
`# yaml-language-server: $schema=…` line so editors validate the file. README's
[The file's format](../README.md#the-files-format) walks the whole format by example; this page
documents the sections one by one.

## `tasks`

Names the team's one task source. It is an owner section: adding, changing or removing it is a
change to the file the owner approves. Omitted, it reads as `null` and `team issues` refuses
rather than inventing a path.

```yaml
tasks:
  source: file
  path: .agents/tasks.yaml
```

or, for a tracker behind the owner's broker:

```yaml
tasks:
  source: linear
  linear:
    project: 01234567-89ab-cdef-0123-456789abcdef
    keychainService: team.linear.acme
  policy:
    omit: [description]
    transform:
      id: bare
```

- `source` is `file` or `linear`. A file source is the list the owner committed; a broker source
  is a tracker the owner's broker reads — the credential stays with the broker (`team broker`),
  and `team next` asks it over `.agents/broker.sock`. `team issues` lists a file source only.
- `path` is required for `source: file` and refused for `source: linear`. It is relative to the
  checkout and must stay inside it. An absolute path, a `~` path, or a `..` that leaves the
  checkout is refused: `tasks.path must stay inside the checkout`. The linear block is refused the
  other way: `tasks.linear is for source: linear`.
- `linear` is required for `source: linear`, with exactly `project` and `keychainService`. A
  missing half is `tasks.linear.project is required` or `tasks.linear.keychainService is
  required`.
- `policy` is for `source: linear` — for `source: file` it is refused with `tasks.policy is for a
  broker source; source: file has no broker`. It says which record fields cross the broker's
  boundary: `allow` names the set, `omit` removes from the default, the two are not used together
  (`tasks.policy: allow and omit are not used together`), and `id` and `title` are the record
  itself — `allow` must name both, `omit` must name neither. A name that is not a task field is
  `tasks.policy.allow lists "foo", not a task field` (likewise `omit`). With no `policy` the nine
  typed fields cross and `description` does not. `transform` has one defined value, `id: bare`:
  an id that arrives as its source URL crosses as its last `/`-separated segment. Anything else is
  `tasks.policy.transform: only id: bare is defined in this build`.
- `pull` is optional: `self` or `any`. Omitted, `team next` treats it as `self` and the parsed
  section does not gain the key. Any other value is `tasks.pull must be self or any`.
- `fallback` is optional: `file` or `id`. It orders records that have no priority. Omitted, those
  records keep file order. It does not reorder a record that has a priority. Any other value is
  `tasks.fallback must be file or id`.
- `cadence` is optional: a duration with its unit written, in `s`, `m` or `h`, such as `120s` or
  `10m`. Omitted, the parsed section does not gain the key, and no default is supplied.
  `cadence` is the pace `team next --wait` re-reads the source at. It governs nothing else: not
  the watch, not the lease. Zero is not a pause: a value that measures to zero, such as `0s` or
  `0.0m`, is `tasks.cadence must be greater than zero`. Any other value, including a quoted one,
  is `tasks.cadence needs a value with its unit (s, m, h), such as 120s or 10m`.
- Any other key, including `backoff` and `quiet_hours`, is an unknown field.

The file at `path` is a YAML list of task records. `team issues` reads it. `team next` claims one
record from it, and claims one from a broker source's read the same way — the lease stays local
either way. Nothing in this build writes the file or the tracker.

## `seats`

Each seat names a model and how it is launched. The fields are in the README's
[file format](../README.md#the-files-format). Two of them decide the herdr workspace title, and
one no longer does:

- `display` defaults to `model` and `version` (`Claude Opus 5.5`). It must contain the version
  as a token of its own when the file writes it.
- `up` and `add` title the workspace `<display> · <effort>` when the seat sets `effort`,
  and `<display>` when it does not. The title has no seat name and no role. Seats expanded from
  `count` share it: herdr shows the seat's name on its own line.
- `label`, written or left out, is still a field the file may carry. A written one is accepted.
  It does not title the workspace. Left out, the stored title stays the model and version in
  lowercase, which is what an approval of a file written that way already sealed.

## `delegates`

Names panes outside the team's session that may run some operational commands as a delegate of
this team file. It is an owner section: adding, changing or removing it is a change to the file
the owner approves. Omitted, it reads as `null` and nothing is delegated.

```yaml
delegates:
  - pane: main/w1:p1        # <herdr session>/<pane id>, outside the team's session
    commands: [up, down]    # of up, down, add, remove, approve: non-empty, distinct, order kept
  - pane: main/w2:p1
    commands: [add, remove]
```

- One to eight entries, each a map with exactly `pane` and `commands`; two entries naming one
  pane are refused.
- A pane is herdr's pane ID — `<session>/<pane id>`, such as `main/w1:p1` — one slash, no
  whitespace, matched on the whole string and case-sensitively. A pane closed and made again has
  a new ID, so delegation is off until the owner approves a file naming that new ID.
- `commands` names at most one each of the five `up`, `down`, `add`, `remove` and `approve`.
  Entry order and command order are part of the value the owner approves: a reorder is a change
  like any other.
- `approve` is granted like the rest, under the gate's guard, and the guard is an allowlist:
  a delegated approval admits the roster and `rules`, and refuses, fail-closed, every other
  owner section — `delegates`, `budgets`, `limits`, identity, `trust`, the workspace, the
  operator and orchestrator — and any section added later, so a delegate can never approve a
  change to its own authority. A delegated approval of an ordinary change — the roster, a
  launch line, a rule — passes, and the write records one audit line naming the pane and what
  it sealed.
- A pane named in several approved team files is a delegate of each — the files do not see or
  limit one another — and in every one of them the owner-only sections stay the owner's, never
  a delegate's.
- A pane's own shell reaches that pane's grant when the pane's root process is among the
  caller's ancestors. `HERDR_PANE_ID` only names which pane to read; the pid is what places
  the caller. No such variable, a root that is not an ancestor, or a pane-root read that
  fails places nobody, as before. A command the grant does not list is still refused, and a
  pane no grant lists is refused by name: `it runs in pane <session>/<pane id>, which no grant lists`.
- Delegate placement is an accident guard, not a security boundary. The pane ancestry and
  herdr's pid vouch are forgeable by a hostile process of the same user, which this tool does
  not resist: it guards a mistaken agent, not a hostile one. Nothing in the grants or in
  `trust:` is changed by that.
