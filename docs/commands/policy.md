# team policy

Reads and resolves the effective policies for the current team (or a named seat) across the
tighten-only inheritance chain (`entity → project → team → seat`), or sets and unsets owner-signed
policy declarations (`team policy set` and `team policy unset`).

## Synopsis

    team policy [--seat <name>] [--file <path>] [--json]
    team policy set <level> <name> <value> [--until <iso>] [--kind <enforced|advised>] [--entity <id>] [--project <id>] [--seat <name>] [--file <path>] [--dry-run] [--json]
    team policy unset <level> <name> [--entity <id>] [--project <id>] [--seat <name>] [--file <path>] [--dry-run] [--json]

`<level>` is one of `entity`, `project`, `team`, or `seat` (or `seat:<name>`).
Every enforced policy comes from the release catalogue (`dev-mode`, `seats-cross-teams`,
`state-trace-window-seconds`, `state-blind-after-seconds`, `state-hook-working-seconds`,
`liveness-idle-lead-seconds`, `liveness-idle-owner-seconds`, `delivery-order`,
`brief-transport`,
`event-thread-ttl-seconds`, `event-thread-cap`, `event-retention-days`, `event-segment-mb`,
`event-held-threshold-seconds`, `event-unreachable-threshold-seconds`,
`event-idle-threshold-seconds`, `event-reconcile-interval-seconds`, `model-rule`,
`swap-wait-seconds`, `watch-read-budget-ms`, `watch-read-timeout-ms`, `webhook-sender-deadline-ms`,
`client-bundles`,
`client-grant-max-duration`, `daemon.fallback-backlog-above`, `daemon.fallback-backlog-limit`,
`daemon.chores`, `daemon.chores-slice-ms`, `daemon.chores-missed-beats`,
`daemon.chores-backoff-cap-ms`, `daemon.heartbeat`, `actions-commands`,
`workspace.sidebar.rows`, `workspace.sidebar.manage`, `workspace.sidebar.status_indicators`,
`daemon.sidebar-ttl-ms`, `daemon.sidebar-refresh-ms`, `seat.dialog.answer`,
`seat-health.watchdog.after`, `seat-health.watchdog.auto-restart`).
Inheritance tightens only: a lower level that loosens a higher level is refused at load and before
writing, naming both levels. Where no level sets a value, the release default applies (`off` for
gate-lifting policies); an expired value counts as unset at its level.

`actions-commands` is which Actions commands the command guard allows. The default is
`rerun-failed`, `deploy` and `ci-pr-head`: `gh run rerun --failed`, `gh workflow run deploy.yml`,
and `gh workflow run ci.yml` with a ref. A lower level may only drop a command. Every other Actions
command is refused. So is an `api` path under `/actions` or `/dispatches`, an `api` call
whose method is POST, PUT, PATCH or DELETE (`-X` and `--method`; the last verb named is the one
that counts), and an `api` call that adds
`-f`, `--field`, `-F`, `--raw-field` or `--input` without an explicit GET. A graphql read stays
allowed, including a path that ends in `/graphql`. A graphql query that contains `mutation` is refused.

`client-grant-max-duration` is how long a new client grant may last: `7d`, `30d`, `90d` or `none` (no
end date) for every kind of grant, or per kind, `send=30d;up=90d;bundle=none`. Unset it is
`send=7d;up=90d;bundle=90d`, today's limits. Entity and project level only; a lower level may only
shorten (`none` is the loosest); a chain that cannot be verified refuses a new grant. It decides what
`team grant --client … --expires <ISO|never>` may sign. The owner sets it from a terminal:

    team policy set entity client-grant-max-duration send=365d --entity floor
    team policy set entity client-grant-max-duration send=none --entity floor
    team policy set project client-grant-max-duration send=30d --project <project-id>
    team policy unset entity client-grant-max-duration --entity floor

See [How long a client grant lasts](../concepts/client-grant-duration.md).

`daemon.fallback-backlog-above` and `daemon.fallback-backlog-limit` are the machine daemon's
fallback-store retirement knobs: above the first many eligible finished episodes, one retirement
pass takes up to the second instead of the steady 256, so a store that was never retired before
empties over a few passes. The defaults are 256 and 500. A higher threshold and a smaller bulk
limit are the tighter words. The daemon reads both for each hosted root; a chain that cannot be
read keeps the release defaults and says which word it could not read.

`daemon.heartbeat` (alias `daemon-heartbeat-seconds`) is the machine daemon's loop heartbeat, in
whole seconds from 1 to 60 — 5 by default: how often the daemon refreshes its state record
and probes its hosted endpoints. The fallback sweep rides the beat only under
`daemon.chores: inline`; otherwise it is the chores child's pass (below). The daemon reads it for each hosted root when it starts and again on its housekeeping
pass, and runs the shortest word any hosted root declares, so no hosted team loosens another's
beat; a longer beat has to be declared at a level every hosted checkout shares. A shorter beat is
the tighter word. `team daemon status` prints the beat it runs (`heartbeat <time> (every
<seconds>s)`). Where the sweep does ride the beat, a shorter beat makes a backlog stall more
often, not less.

`daemon.chores` decides where the machine daemon runs its heavy per-checkout chores: `per-root`
(the default) gives each hosted checkout its own supervised child, so one checkout's work never
shares a process with another's; `shared` runs one child for every checkout whose word is
`shared`, with a queue per checkout and a slice per turn in round robin, so one checkout's
backlog delays another's chores by a slice and never its socket or the daemon's beat; and
`inline` keeps the work on the daemon's own loop, exactly as before the isolation — the
rollback. Three limits bound a child:
`daemon.chores-slice-ms` (2000) is how long one slice of a pass runs before it yields to its
heartbeat, `daemon.chores-missed-beats` (2) is how many heartbeats it may miss before the daemon
ends and replaces it, and `daemon.chores-backoff-cap-ms` (30000) caps the doubling wait between
replacements. A shared group runs the tightest limits of its checkouts. Each child reports its own
resident size in every heartbeat, so the daemon's record and `team daemon status` say what one
child costs. The daemon reads all four for each hosted root; a chain that cannot be read keeps the
release defaults.

The machine reminder rides the same fleet as one more supervised child of its own, under the
release limits: its subject is the machine, not a checkout, so no checkout's word speaks for it
and `daemon.chores` cannot move it inline. That child runs whenever the daemon runs, and one whose
entity record names no reminder reads an empty list and sends nothing.

The seven `event-*` policies are the owner's event thresholds: how long an unanswered thread
stays open (72 hours by default), how many records a thread may hold (50), how many days the
event log keeps (30), when a held record reaches the lead (600 seconds), when a seat that watches
nothing reads `unreachable` (600 seconds), when an idle seat's lead is told (300 seconds), and how
often the bus reconciles (120 seconds). Each takes a whole number — seconds, or days for
`event-retention-days`, records for `event-thread-cap`; a seconds value may be written with an
`s` suffix. The three delay thresholds — `event-held-threshold-seconds`,
`event-unreachable-threshold-seconds` and `event-idle-threshold-seconds` — may only be shortened:
a value above the release default is refused, and so is a level's word that lengthens the one
above it. The shorter field spellings (`held_threshold_seconds`, `thread-ttl`, …) are accepted
and written back under the canonical name. `team bus` reads the held, retention and reconcile
numbers when it starts, and `team reply` reads the thread life and cap from the caller's chain.

The log itself is kept in segments. `event-segment-mb` is the size of the open segment in whole
megabytes — 8 by default, 1 to 50 — after which an append seals it and opens the next; it is a
mechanical number, so the nearest level's word wins and no word tightens another's. What is kept
in all is bounded two ways: `event-retention-days` drops a sealed segment once it is wholly older
than the window (`0` and `all` are the explicit keep-everything words, and keep-all is looser
than every positive count, so no lower level may restore it against a level that dropped it),
and a fixed retained-size cap of 100 MB drops the oldest sealed segments first, each drop
declared in the log itself. The log stays writable when the chain cannot be read: the release
defaults stand in and the append path keeps writing.

`model-rule` is the entity's rule for which models may run on which seats, held as one line of
`;`-separated entries, `<seat|role|*>=<lab>+<lab>`. A seat name beats a role word, a role beats
`*`, and a seat no entry names may run any model; labs are vendor words as a seat writes
`vendor:`, and an entry whose words are all `!lab` refuses those labs instead of allowing them.
Only the entity may set it — `orchestrator=anthropic; architect=anthropic; *=!anthropic` is one
rule — and the watch and `team check` carry it out in every team of the entity.
`swap-wait-seconds` is how long a queued model swap may wait for its boundary: 1800 seconds
(30 minutes) when nothing declares it, a shorter word being the tighter one, and a broken seat
swaps at once.

The two `watch-read-*` policies bound one pass of the watch's reads. `watch-read-budget-ms` is
how long one pass may spend reading panes and the machine before the panes it did not reach are
left unread and read on the next pass; `watch-read-timeout-ms` is the longest one read may take
before its child process is killed. Both default to 2000 milliseconds, take a whole number of
milliseconds from 100 to 30000, and take the entity, project and team levels; a shorter value is
the tighter one. A chain that cannot be read leaves both defaults in force, and the watch holds
its automated work on the unreadable pace as it always does.

`webhook-sender-deadline-ms` is how long a send's own arrival post waits on the receiving seat's
webhook routine before the send reports the answer unknown: 3000 milliseconds when nothing
declares it, a whole number of milliseconds from 500 to 10000, and a shorter value is the tighter
one. It takes the entity, project and team levels. The post is a wake beside a record that is
already durable and staged for the bus and the seat's pull, so the bound never costs the message:
a post that outlives it is reported `unknown`, never `failed`, and its claim keeps the record from
being posted a second time. A chain that cannot be read leaves the default in force. The bus
delivery keeps the adapter's own budget — three attempts, five seconds each — and does not read
this value. `team status` and `team check` report a claim left `sent` when no bus serves the root
to finish it, and never count such a post as delivered.

`brief-transport` says how a general seat brief reaches its seat. `file`, the default, writes the
claim and the signed drop and nothing else; `message` sends the whole brief as a real send body
through the seat's own delivery legs, so its receipt, history line and outcome are an ordinary
send's; `memory` is an experiment no runtime in this build proves zero-persistence for, so a
`memory` policy delivers nothing, refuses every seat and every `team send --brief`, and falls
back to nothing. `message` is within `file`; `memory` is comparable only to itself. It takes the
entity, project and team levels.

The three `router.*` policies place the mailbox router's map. `router.aliases` places each alias
at a `seat@team` address, as a comma list (`atlas=zeus@floor`); the release places
`iris=iris@floor`, `atlas=orchestrator@floor` and `zeus=architect@floor`. A word names only what
it moves: every alias a word leaves out keeps the address in force above it. The entity may move
an alias or add names, and an entity word's target names a team of the entity — one its own
record or a project record of the entity places there — never one outside it. A team may add an
alias for its own seats — the team spelled by its registry id, its name or its session, the forms
a send accepts — and never retarget one the entity places: a word that tries is refused at load,
naming the alias, and so is one naming an address that is not a seat of the team. An alias with
no address, an address that is not `seat@team`, a seat named `desk`, and an alias named twice in
one word are refused at write and at load, each with its own named error. `router.fallback`
places where an ask goes when its route is a definite miss: another alias's address, or `none`
to clear it. The release falls `atlas` back to `iris@floor`; `iris` and `zeus` have none. An
entity alias's fallback belongs to the entity alone — a team may set the fallback only of an
alias it added, and it names a seat of that same team — and a fallback naming its own alias or
its own route is refused. `router.reply-bound` bounds how long the router waits for a verified
reply: a whole number of seconds from 1 to 86400 (`600`, `600s`), the nearest level choosing.
Unset means twice the seat's unread window; the bridge's synchronous cap of 120 seconds is the
router's own constant, not a value here. All three words take the entity and team levels only.
A team file that cannot be read refuses the whole read — the router never answers the release
defaults over a team it could not read — and `team check` names the rule a word broke, with the
`team policy unset` repair that clears it.

Five words govern the terminal host's sidebar; all five take the entity, project and team
levels, and a chain that cannot be read leaves the release defaults in force — the sidebar is
presentation, and an unreadable word never blocks a launch. `workspace.sidebar.manage` is
whether `team` may touch the host's config for the sidebar at all: `on`, the release default,
lets the marked sidebar block and the marked status-indicator key be spliced in, back up first
and rolled back on a refused check; `off` is absolute — no write is made, and a lower level may
switch managing off but never back on against a level that said `off`. `workspace.sidebar.rows`
is the layout itself: rows joined by `;`, tokens by `,`, each token one of `state_icon`,
`machine`, `workspace`, `tab`, `state_text`, `agent` (the YAML list of token lists reads the
same way); unset, it is today's layout, `state_icon,machine,workspace,tab` over `state_text,agent`.
Any parsed layout is as strict as any other, so the nearest level chooses.
`workspace.sidebar.status_indicators` is which status indicator the host draws beside an agent —
`symbols`, the release default, or `dots`, the host's own closed vocabulary.
`daemon.sidebar-ttl-ms` is how long a pane's reported sidebar metadata lives before it lapses:
whole milliseconds from 1000, one day (86400000, the host's own cap) when nothing declares it;
a word above the cap is clamped to it when read rather than refused, and a shorter ttl is the
tighter word. `daemon.sidebar-refresh-ms` is how often the sidebar line is re-reported to stay
inside that ttl: whole milliseconds from one minute to seven days, six hours (21600000) when
nothing declares it; a shorter interval is the tighter word. Under `workspace.sidebar.manage: off`,
`team up` plans no sidebar config step and `team check` prints the exact TOML block without writing
the config (applying it only on the owner's explicit `team check --repair`). The supervised chores
child refreshes each seat's `display_agent` at `daemon.sidebar-refresh-ms` with `--ttl-ms`
`daemon.sidebar-ttl-ms` under a read-back guard, and skips roots whose `daemon.chores` policy is
`inline` with a note.

Three words govern the seat-health watchdog (its behaviour is under
[`team daemon`](daemon.md#seat-health)). `seat.dialog.answer` is the closed list of dialogs the
watchdog may answer itself: comma-separated `trust:<folder>` tokens (trust exactly that folder)
and `permission:<command>` tokens (allow always for a command named token for token, as the
command guard parses it — no `*`, no `..`, no backslash). Nothing is answered when it is unset,
a lower level may only drop tokens, and widening it — at `set` or at load — needs a fresh owner
proof, at most 30 seconds old, naming exactly the resulting list. A login dialog is never on
the list and never answered. `seat-health.watchdog.after` is how long the full stall proof must
hold before the watchdog acts, in whole seconds from 60 to 7200 — 900 by default; a lower level
may only lengthen the wait. `seat-health.watchdog.auto-restart` is whether a proven stall is
restarted at all: `1`, the release default, restarts once; `0` only tells the lead. A lower
level may only turn it down.

Two advised words print the relay and reserved-scope lines in every seat's generated rules.
`entity.main-orchestrator.relays-owner`, on at the entity level by default, says a decision the
entity's main orchestrator relays from the owner — quoting the owner and citing its
owner-decisions entry — is acted on without asking again; `off` drops the line. A relay never
carries an owner-reserved decision: senders are attributed, not verified, within one OS user,
so a reserved decision needs the owner's own device, whatever any message says.
`owner.reserved-scope` is the list that rule keys to — `public releases`, `spending`,
`credentials`, and `the owner's machine` (OS and system settings, accounts and logins, the
credential store, hardware) by default; set it at entity, project or team to add words. The
four default words are the floor and stay in force even when a set value leaves one out.

## Who may run it

The view (`team policy`) may be run by the owner, a seat of the team, or an approved delegate pane
that may read the team. `team policy set` and `team policy unset` are owner-only from a terminal
outside herdr, signed under `team-policy-v1\n`, and logged to `.agents/team.log`. `--dry-run`
prints the plan and does not ask for Touch ID.

## Output and exit codes

| Outcome | Output | Exit |
| --- | --- | --- |
| effective policies listed, updated, or planned | table of effective policies or `policy: set\|unset …` | 0 |
| non-owner attempted set/unset, lower level loosened a higher level, or source failed verification | `team policy: <problem>` | 1 |
| invalid invocation, file, policy name, or value | `team policy: <problem>` | 2 |

`--help` and `-h` show usage and exit 0.
