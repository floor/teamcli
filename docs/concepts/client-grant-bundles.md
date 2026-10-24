# Client grant bundles

A **bundle** is a named, fixed list of commands grouped in one owner-signed client grant, so one
signature covers a team's everyday operations for one client. It complements the per-command grants
(`--up`, `--down`, a send grant, an inbox grant, a master grant); it replaces none of them.

A lay owner reads one sentence at signing and signs once:

> Grok Bot may, for team docs until 2027-01-21 09:00 UTC: see status, send to orchestrator,
> start (file 3f9a1c0b2d4e), stop. It cannot change permissions, add or remove seats, or create
> teams.

## The two bundles

| Bundle | Expands to (release default) | Needs |
| --- | --- | --- |
| `observer` | `status`, `list`, `check`, `feed`, `messages` | `--team` |
| `operator` | the observer's ops, plus `send` to the granted seats, `up`, `down` | `--team`, and `--seat` when the team admits more than one seat |

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

Vocabulary 5. The record carries:

- `allowed_ops`: the **explicit** list the owner signed, in canonical order. **This decides.**
- `bundle`: `observer` or `operator`, **for display only**. A record labelled `operator` that lists
  only `status` admits only `status`; one labelled `observer` that lists `down` admits `down`.
- `seats`: the seats `send` may reach (empty without `send`).
- `team`: one team by name, registry id (twelve hex of the digest of its real root) and real root,
  plus the file fingerprints **only when `up` is an op**.
- `entity`, the client's key id and public key, issue time and expiry.

The ops are expanded at signing time. A command added to a bundle in a later build, or a policy
loosened later, never widens a grant already signed. A grant is never widened in place: the owner
signs a new one. An older build reads vocabularies 1 to 4 only and refuses a bundle whole.

## What can never be in a bundle

Structurally, not by policy: `grant`, `revoke`, `delegate`, `init`, `owner-seat`, `policy`
(`set`, `unset`), `settings` (`set`, `unset`), `development-mode` (`set`), `add`, `remove`,
`rename`, `swap`, `answer`, `tempo`, `broker`, `bus`, `daemon`, `register`, `queue`, `hold`,
`worktree`, `raise`, `client` (`keygen`), `pause`, `resume`. They follow from one invariant: a
client must not change who may do what, the seats, the teams, the owner's settings or the
machine's daemons. A bundle can only carry the closed list `status`, `list`, `check`, `feed`,
`messages`, `send`, `up`, `down`. The planner, the policy parser and the record decoder all refuse
the others, and the decoder refuses a hand-built record that lists one even when it carries a valid
owner signature.

## Policy

The bundles' ops and expiry are values of the `client-bundles` policy (entity and project levels):

    operator=status,send,up,down@30d;observer=status@90d

A bundle left out keeps the release default; days default to ninety, the ceiling. A policy chooses
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
