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

Each seat names a model and how it is launched. The orchestrator and the operator start in
the project folder. Every other seat starts in the team's lobby. A lead already running in
either folder is left there. The fields are in the README's
[file format](../README.md#the-files-format). The sidebar has two lines:

- `label`, when the file writes one, is line 1, the workspace title. A seat expanded from
  `count` keeps that label on the first instance; each later instance appends `-<n>`, the same
  suffix the seat's name gets, so the lines differ (`desk`, `desk-2`).
- A seat with no written label is titled `<name> · <role>`. Count instances already have
  distinct names (`maker`, `maker-2`), so their lines differ too. The model is never line 1.
- Left out, the stored `label` stays the model and version in lowercase, which is what an
  approval of a file written that way already sealed. That stored field stays in the seat's digest.
- `display` defaults to `model` and `version` (`Claude Opus 5.5`). It must contain the version
  as a token of its own when the file writes it. After launch, `up` and `add` set the pane's
  display_agent to `<display> <effort>` when the seat sets `effort`, and to `<display> default`
  when it does not. The display stays the proper-case name, including a multi-word model
  (`DeepSeek V4.1 Flash`, `Gemini 3.8 Flash`). Herdr draws line 2 as its status word, then
  ` · `, then that text (`done · Grok 4.7 high`, `idle · Opus 5.5 default`). That is line 2.

`effort` is optional. It is a known field: a file may set it, and a file that leaves it out
loads as before. The words a lab allows are [`src/profiles/efforts.json`](../src/profiles/efforts.json),
format 1, keyed by the seat's `vendor`. Each list is the words that lab's own CLI help printed.
A lab whose help or model list names none is left out of the file, and a vendor with no entry
accepts any effort.

A word outside its lab's list is a warning, and the warning names the words that lab allows.
It does not fail `team check` or `team up`. That is not a regression for a file
that already loaded: an unknown field is refused, so no such file contains `effort`. Left out,
the field is not stored on the seat, and the seat's approval key is unchanged. Adding it, in
or out of the list, changes that key, because the word is part of the seat.

Nothing in the launch line reads `effort`.

## `grant`

Records the grant the owner gives the orchestrator's seat. It is an owner section: adding,
changing or removing it is a change to the file the owner approves. Omitted, it reads as `null`.

```yaml
grant:
  session: acme          # the file's own session
  seat: lead             # the orchestrator's seat
  scope:                 # non-empty, distinct, order kept
    - up
    - down
    - approve
    - init
```

- `session` is the team's own session: the `session` key, or the project name when that key is
  omitted. Any other value is `grant.session must be the file's session "<session>": "<written>"`.
- `seat` is the orchestrator's name, the one `coordinator:` or `leads: true` resolves. The
  operator's name, and any other name, is `grant.seat must name the orchestrator "<seat>":
  "<written>"`.
- `scope` names acts from the closed set `up`, `down`, `approve` and `init`. The list is
  non-empty, each act appears once, and the order is part of the value the owner approves. An
  empty list is `grant.scope must name at least one of: up, down, approve, init`. A repeated act
  is `grant.scope names "<act>" twice`. Any other word is `grant.scope must name up, down,
  approve, init: "<word>" is not one`.
- `approve` in `scope` is an ordinary approval: the roster and `rules`. A change to `grant`
  itself, and a change to any other owner section, stays the owner's. The grant admits the
  orchestrator's seat for that class when it lists `approve`. The run is this folder's own
  file, `--file` is refused, and the first approval of a team stays the owner's. A roster
  edit that moves the derived ceiling — a file that declares no `limits` — stays the owner's too.
- Any other key, including `path`, is an unknown field.
- `team up` admits the orchestrator's seat when the approved grant lists `up`. The run is this
  folder's own file: `--session` and `--file` are refused, and the run does not relaunch or close
  the orchestrator's seat. `team down` admits that seat when the list includes `down`, and leaves
  the orchestrator's seat and the operator's seat running. A file that omits `grant` keeps
  today's `down`.

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

## tempo

How fast the watch's waits run. It is an owner section. Omitted, it reads as `normal`.

```yaml
tempo: urgent
```

- `relaxed`, `normal` or `urgent`.
- `relaxed` doubles `idle_first`, `idle_repeat`, `team_idle`, `nudge_wait` and `unsent_after`.
  `urgent` halves them, to the nearest second, and never below one second. `normal` leaves
  them as written.
- An omitted `idle_repeat` stays off. `interval` is the pass rate and is not scaled, and
  neither are the quota marks or the check switches.
- `relaxed` and `urgent` take effect when the file is approved. A file that omits the key,
  and one that sets `normal`, stay the file that was approved.
