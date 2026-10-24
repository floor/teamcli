# Client grant bundles

A **bundle** is a named, fixed list of commands grouped in one owner-signed client grant, so one
signature covers a team's everyday operations for one client. It complements the per-command grants
(`--up`, `--down`, a send grant, an inbox grant, a master grant); it replaces none of them.

A lay owner reads one sentence at signing and signs once:

> Grok Bot may, for team docs until 2027-01-21 09:00 UTC: see status, send to orchestrator,
> start (file 3f9a1c0b2d4e), stop. It cannot change permissions, add or remove seats, or create
> teams.

## The four bundles

| Bundle | Expands to (release default) | Needs |
| --- | --- | --- |
| `observer` | `status`, `list`, `check`, `feed`, `messages` | `--team` |
| `operator` | the observer's ops, plus `send` to the granted seats, `up`, `down` | `--team`, and `--seat` when the team admits more than one seat |
| `manager` | the operator's ops, plus the team's reads, `restart`, `reload`, and the seat lifecycle `add` and `remove` ([below](#the-manager-bundle)) | **`--team`, always**: it is for one team |
| `developer` | the manager's ops, plus `pause`, `resume`, `hold` and the other everyday commands that are not the owner's ([below](#the-developer-bundle)) | **`--team`, always**: it is for one team |

Which commands the observer carries is one constant, `OBSERVER_DEFAULT_OPS` in
`src/client/bundle-ops.ts`, and a policy value (below). Only some of those commands have a
`--client` form today:

| Op | `--client` form | Reads the team file as signed |
| --- | --- | --- |
| `status` | `team status --client <grant> --key <key> [--team <team>]` | no |
| `send` | `team send --client <grant> --key <key> <seat>@<team> <text>` | no |
| `up` | `team up --client <grant> --key <key>` | **yes**: a changed file stops `up` until the owner re-signs |
| `down` | `team down --client <grant> --key <key>` | no: a stop stays possible after an edit |
| `list`, `check`, `feed`, `messages` | none yet | — |
| `seats`, `seat` | `team seats --client …`, `team seat <seat> --client …` | no |
| `sessions` | `team sessions --client …` (that one team's records, never the machine's) | no |
| `restart`, `reload` | `team restart <seat> --client …`, `team reload <seat> --client …` | no |
| `add`, `remove` | `team add <name> [--like <seat>] --client … --team <team>`, `team remove <name> --client … --team <team>` | no |

A bundle may carry an op whose route does not exist yet; it admits nothing today and the route
arrives later without any grant being widened or re-signed.

## Asking for one

    team grant --client grok-bot --entity floor --public-key ~/.config/team-client/grok-bot/client.pub \
      --team docs --bundle operator --seat orchestrator --request

`--bundle observer|operator` replaces `--up`/`--down`; the two are refused together. `--seat` is a
comma-separated list of the seats `send` may reach; each must be one the team admits for this client
(its approved `clients:` list, never the operator or a human seat) and one its roster holds. With no
`--seat`, every seat that satisfies both. The request is the one every conversational client grant
is: the entity's `grant-emission` must be `conversational`; the owner seat answers it with one
signature (`team grant --approve-as-owner-seat <request-id> oui`) and the owner runs
`team grant --execute <request-id>`. The signature prompt is the owner's card above. A bundle is
never approved `always`. The requester can ask; it cannot answer.

Without `--request`, the owner at a terminal signs the same grant directly.

## What the record says

Vocabulary 5 for `observer` and `operator`, vocabulary 6 for `manager`, vocabulary 7 for `developer`. The record carries:

- `allowed_ops`: the **explicit** list the owner signed, in canonical order. **This decides.**
- `bundle`: `observer`, `operator`, `manager` or `developer`, **for display only**. A record labelled `operator` that lists
  only `status` admits only `status`; one labelled `observer` that lists `down` admits `down`.
- `seats`: the seats `send` may reach (empty without `send`).
- `team`: one team by name, registry id (twelve hex of the digest of its real root) and real root,
  plus the file fingerprints **only when `up` is an op**.
- `entity`, the client's key id and public key, issue time and expiry.

The ops are expanded at signing time. A command added to a bundle in a later build, or a policy
loosened later, never widens a grant already signed. A grant is never widened in place: the owner
signs a new one. An older build reads vocabularies 1 to 4 only and refuses a bundle whole, and refuses a bundle with no end date whole; this build reads 1 to 7, and a vocabulary 5 record that lists a manager op, a vocabulary 6 record that lists a developer op, or a record whose vocabulary is not its bundle's, is nothing.

## What can never be in a bundle

Structurally, not by policy: `grant`, `revoke`, `delegate`, `init`, `owner-seat`, `policy`
(`set`, `unset`), `settings` (`set`, `unset`), `development-mode` (`set`), `add`, `remove`,
`rename`, `swap`, `answer`, `tempo`, `broker`, `bus`, `daemon`, `register`, `queue`, `hold`,
`release`, `worktree`, `raise`, `client` (`keygen`), `pause`, `resume`, `config`, `lock`, `unlock`. They follow from one invariant: a
client must not change who may do what, the seats, the teams, the owner's settings or the
machine's daemons. `observer` and `operator` can only carry the closed list `status`, `list`,
`check`, `feed`, `messages`, `send`, `up`, `down`. The planner, the policy parser and the record decoder
all refuse the others, and the decoder refuses a hand-built record that lists one even when it carries a
valid owner signature.

The forbidden list stays authoritative. It is narrowed in two steps, each for one bundle and no other:
`add` and `remove` (spelled `seat add` and `seat remove` in the group) for `manager` and `developer`, and
`rename`, `swap`, `pause`, `resume`, `hold`, `release`, `tempo`, `queue`, `lock`, `unlock`, `worktree` and `raise`
for `developer` alone. `observer` and `operator` never carry any of them, and a policy cannot give them to
either; the manager never carries the second group.

## The manager bundle

`manager` is the bundle for a client that runs one team's day: it is `operator` plus the team's own reads,
`restart` and `reload`, and the seat lifecycle. It is **for one team**: a manager grant without `--team` is
refused, and it is capped at, and by default lasts, ninety days. The explicit list the owner signs
(`allowed_ops`, in this order, 28 ops):

    status, list, check, feed, messages, seats, seat, sessions, usage, drops, projects, issues, plan, next,
    brief, watch, doctor, commits, send, reply, ack, ask-show, up, down, restart, reload, add, remove

The owner asks for it with

    team grant --client grok-bot --entity floor --public-key ~/.config/team-client/grok-bot/client.pub \
      --team teamcli --bundle manager --request --json

and answers on the owner seat (`team grant --approve-as-owner-seat <request-id> oui`, one Touch ID), then
`team grant --execute <request-id>`.

**Never in the bundle, even for a hand-built record:** `grant`, `revoke`, `delegate`, `owner-seat`,
`policy` (`set`, `unset`), `settings` (`set`, `unset`), `development-mode`, `answer`, `config`, `broker`,
`bus`, `daemon`, `register`, `client` (key creation), `init`, `tempo`, `raise`, `queue`, `worktree`, `lock`,
`unlock`, and, for the manager, `rename`, `swap`, `pause`, `resume`, `hold` and `release`. They follow from the **never-self-widen invariant**: a manager can run the team and change its
roster, but it can never change who may do what, so it cannot grant itself or anyone else more, widen its own
grant, answer its own request, or change the owner's settings and policies. The pacing and naming
commands (`rename`, `swap`, `pause`, `resume`, `hold`, `release`) are not the manager's: the
[developer bundle](#the-developer-bundle) carries them.

**The roster rules.** `add` and `remove` are the one place the manager changes the file, so they are the
narrowest routes: the client form is dispatched before the terminal check that refuses every caller without a
herdr terminal record, verified on the exact team like `up --client`, and then runs the ordinary `add` or
`remove`. A seat marked `human: true` is never a source or a target; the orchestrator and the operator are never
removed (and a client never starts a lead seat, which is the second half of the owner's swap); `--keep`,
`--abandon`, `--file`, `--session`, `--model` and `--effort` are the owner's and refused with `--client`. A
roster change is **not** added to the approval record: the run says so, the owner approves it with the owner
seat, and an added seat is a new seat to the fingerprints the owner signed, so `up --client` for that team
stops until the owner signs a fresh manager grant (a removed seat is no difference to them).

**Not wired yet.** These manager ops have no `--client` form in this build and admit nothing yet: `list`,
`check`, `feed`, `messages`, `usage`, `drops`, `projects`, `issues`, `plan`, `next`, `brief`, `watch`, `doctor`,
`commits`, `reply`, `ack`, `ask-show`. The owner's card says so ("Not usable yet in this build: …"). `reply`
and `ack` are not wired because a client has no seat identity: `ack` would fake the owner's read and `reply`
would speak in the owner's place. Wiring any of them later widens no grant and needs no new signature.

## The developer bundle

`developer` is the bundle for a client that works a team as a developer would: **everything the manager
carries, and the pacing, naming and work commands the manager does not**. It is for one team (a developer grant
without `--team` is refused), is capped at, and by default lasts, ninety days, and is verified on the exact team
(`team_id`, key, `allowed_ops`, expiry, revocation) on every `--client` route like the manager's. Vocabulary 7.
The explicit list the owner signs (`allowed_ops`, in this order, 44 ops): the manager's 28, then

    rename, swap, pause, resume, hold, release, tempo, queue, lock, unlock, worktree, raise, route, pr, workflow, proc

Two of them are pace controls and have a `--client` form that is as graceful as the plain one:

| Op | What it does for a client | `--client` form |
| --- | --- | --- |
| `pause` | stops the team taking new work: ongoing work finishes, nothing is interrupted, a seat is never typed into or closed; `team next` claims nothing and the watch sends no work nudge until `resume` | `team pause --client <grant> --key <key> [--team <team>] [--reason <text>]` |
| `resume` | clears the pause, so `team next` claims and the watch nudges again, and prints the stop points the pause recorded | `team resume --client <grant> --key <key> [--team <team>]` |
| `hold` | places or releases the hold on the team's work (`team hold <reason>`, `team hold --release`) | `team hold <reason> --client <grant> --key <key> [--team <team>] [--until <time>]` |

The pause form takes **no `<team>` and no `--all`**: those are the owner's, and a client pauses the one team its
grant names, found by the grant's own folder, never by a name it types. The `--team` it takes is only a check
that the grant is for that team. Each run is logged as `client:<id>` in the team's state and as
`client-pause-authorized` / `client-resume-authorized` / `client-hold-authorized` in the team's log, and a
refusal as `…-refused`.

The owner asks for it with

    team grant --client grok-bot --entity floor --public-key ~/.config/team-client/grok-bot/client.pub \
      --team teamcli --bundle developer --request --json

and answers on the owner seat (`team grant --approve-as-owner-seat <request-id> oui`, one Touch ID), then
`team grant --execute <request-id>`.

**Never in the bundle, even for a hand-built record:** `grant`, `revoke`, `delegate`, `owner-seat`, `policy`
(`set`, `unset`), `settings` (`set`, `unset`), `development-mode`, `answer`, `config`, `broker`, `bus`, `daemon`,
`register`, `client` (key creation) and `init`. The decoder refuses a vocabulary 7 record that lists one, signed
or not, and the roster rules of the manager (a human's seat and the orchestrator are never touched, a roster change
is the owner's to approve) apply to `add` and `remove` unchanged.

**Wired (a real `--client` form):** every manager route (`status`, `seats`, `seat`, `sessions`, `send`, `up`,
`down`, `restart`, `reload`, `add`, `remove`), and `pause`, `resume` and `hold`.

**Not wired yet** (they admit nothing in this build, and the owner's card says so): the manager's own unwired
ops, and `rename` and `swap` (they move a seat's identity and its pane), `release`, `tempo` (it rewrites the
team file, which is the owner's), `queue`, `worktree` and `raise` (they act as the seat that calls them, and
a client has none), `lock` and `unlock` (machine-wide named locks), `route` (it addresses a seat of any team),
`pr`, `workflow` and `proc`. Wiring any of them later widens no grant and needs no new signature.

## Policy

The bundles' ops and expiry are values of the `client-bundles` policy (entity and project levels):

    operator=status,send,up,down@30d;observer=status@90d;manager=status,restart,add,remove@30d;developer=status,pause,resume@30d

A bundle left out keeps the release default (a policy narrows a bundle; it cannot switch one off); days default to ninety, and a policy's `@<days>d`
(1 to 90) is both the default length and a bound that only shortens. How long a bundle may last at
all is the `client-grant-max-duration` policy's `bundle` cap (ninety days unless the owner changes
it; `none` allows `--expires never`), see [How long a client grant lasts](client-grant-duration.md).
A policy chooses
among eligible ops only (a forbidden command is a parse error); a lower level may only narrow.
It is set like any enforced policy, at the entity or the project level (see [`team policy`](../commands/policy.md)). A policy chain that cannot be
read or verified refuses a new bundle instead of falling back to defaults that may be looser.

## Using one, and what is written

Every run is checked whole before anything happens: the grant verifies under the owner key and is
the canonical record for its id; the key file is the grant's own key; it is unexpired and
unrevoked; the folder or `--team` is the team signed; and the op is in `allowed_ops`. The run then
re-reads the grant under the grant lock immediately before its first effect. Nothing prompts.

Each op writes one line to `<root>/.agents/team.log`:

    client-<op>-authorized: grant <cg_id> client <client-id> team <project> root <root> request <rid>
    client-<op>-refused: grant <cg_id>: <why>

A refusal is logged once the client's key proved who it is; a grant that did not verify identifies
no one and writes nothing. `team revoke <cg_id>` ends the whole bundle at once.

## Key isolation

The client key is a file outside every team folder. That is a file-hygiene rule, not isolation:
every seat runs as the owner's user, so `team client keygen` says `key isolation: not enforced
(pane guard pending)`, and a bundle grant is no stronger than that.
