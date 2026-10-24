# team grant

Writes an authority record for the current team, in one of three forms. `team grant <seat>
--scope <act,...>` sets the orchestrator's grant in the team file; a later invocation replaces
that scope exactly, and the file holds one grant. `team grant <seat|@team> --capabilities
<cap,...>` writes a standing grant record — an owner-signed record naming the grantee's registry
identity, an agent id for a seat or a team id for `@team`.

## Synopsis

    team grant <seat> --scope <act,...> [--dry-run] [--json]
    team grant <seat|@team> --capabilities <cap,...> [--scope <path,...>] [--expires <date>] [--name <stem>] [--dry-run] [--json]
    team grant --client <client-id> --entity <entity> --public-key <file> [--inbox] [--expires <ISO|never>] [--json]
    team grant --client <client-id> --entity <entity> --public-key <file> --team <team> --up [--down] [--expires <ISO|never>] [--json]
    team grant --client <client-id> --entity <entity> --public-key <file> --team <team> --up [--down] --request [--expires <ISO|never>] [--json]
    team grant --client <client-id> --entity <entity> --public-key <file> --team <team> --down [--expires <ISO|never>] [--json]
    team grant --client <client-id> --entity <entity> --public-key <file> --team <team> --down --request [--expires <ISO|never>] [--json]
    team grant --client <client-id> --entity <entity> --public-key <file> --team <team> --bundle <observer|operator|manager|developer> [--seat <seats>] [--expires <ISO|never>] [--json]
    team grant --client <client-id> --entity <entity> --public-key <file> --team <team> --bundle <observer|operator|manager|developer> --request [--seat <seats>] [--expires <ISO|never>] [--json]

In the first form `<seat>` must name the file's orchestrator. The grant uses the file's session.
`--scope` is a nonempty comma-separated list of distinct words: `up`, `down`, `init`, `reload`,
`swap`. These words retain their existing admission checks and limits.

In the second form the capability list is comma-separated, from the closed vocabulary `write`,
`read`, `review`, `gate`, `merge`, `deploy`, `act-as`, `use-broker`; the record stores it sorted
and without duplicates. A seat names a registered agent of this project's team, and the record
carries that agent's id, never the seat name; `@team` names the project's registered team. A team
grant never carries `grant`, `create`, `agree` or `leads`; naming one is refused with the rule.
The list may also carry the owner setting `dialogs.trust`, on a `@team` grant only: it lets the
team's lead answer a folder-trust dialog (`team answer`, and the polled wait in `team up`), and
`team status` and `team check` offer that repair. It is not a command, the map admits no one to
it, and a seat grant naming it is refused with the rule. [team revoke](revoke.md) ends it like
any other standing grant, at the next dialog.
`--scope` here is a comma-separated list of absolute paths, each inside the project root; without
it the scope is the project root itself. `--expires` is a readable timestamp; without it the
grant does not expire. `--name` sets the record's file name; without it the name is
`seat-<agent id>` or `team-<team id>`. The words `grant`, `delegate` and `revoke-…` are reserved.

In the third form `--public-key` reads the public side of a client key pair written by
[`team client`](client.md) `keygen` — `client.pub`, or `client.key`, whose public half is derived.
The grant binds the client id, the entity and the key's directory, and is signed with the owner's
key into the shared grants folder; its id begins `cg_`. This slice admits only the one principal
and destination of the local bot relay: `--client grok-bot`, `--entity floor`, a recipient of
`orchestrator@floor`. `--expires` is an ISO timestamp inside the cap the owner's
`client-grant-max-duration` policy sets for send grants, seven days unless the owner changed it;
without it the grant expires after the shorter of seven days and that cap, and a grant never carries
a past expiry. `--expires never` signs a grant with no end date, and is refused unless the policy
says `none` for send grants (see [How long a client grant lasts](../concepts/client-grant-duration.md)).
`--dry-run`, `--scope`, `--capabilities`, `--name` and positional arguments belong to the
other forms and are refused here. The grant admits only the signed client request form, with no
owner, seat or terminal authority. `--inbox` widens the vocabulary to `send` and `messages`: the
same grant then admits the client's own read of its replies (`team messages --client`, see
[`team messages`](messages.md)) as well as its sends. Without `--inbox` the grant is exactly the
send-only grant earlier builds wrote, byte for byte, and a read presented under it is refused.

## An up or down grant

`--up`, `--down` or both make the third form a TeamCLI **team grant**: a durable, owner-signed record
that lets one client with no terminal run [`team up`](up.md), [`team down`](down.md) or both for one
team, at one folder, and nothing else. It is for a client that is not a seat and cannot take the
owner's place at a terminal, such as a bot that brings its team's folder up and later stops it on
request. The record lists what it admits in `allowed_ops`: `["up"]`, `["down"]` or `["up", "down"]`.
One record can carry both, so the owner answers once.

    team grant --client grok-bot --entity floor --public-key ~/.config/team-client/grok-bot/client.pub \
      --team docs --up --down --expires 2027-01-20T00:00:00Z --request

`--team` is required and names the one team. The grant binds, in the owner's signature:

- the team's project name, its registry id (the digest of its real root) and that real root, so a
  copy of the team in another folder, or another team under the same name, is not the team signed;
- the fingerprints of the team file the owner saw: every owner-only section and every seat's
  entry. A comment or a prompt edit changes none of them; a new seat, a changed seat or a changed
  owner section does. **Only `up` reads them.** A `down` run does not need the team file to be the
  one the owner signed: stopping a team must stay possible after its file changed (a seat added,
  an edit in progress, even a file that no longer loads). `down` still needs the folder, the
  registry id and the project name to be the ones signed, and the team to still sit under the
  entity; a team that was renamed, moved or given another entity is another team and is refused.

The `--entity` is the policy and signer domain the grant is issued under, not the team's binding.
A team that names no entity, or the same entity, may be bound; a team of another entity, an
archived team, or a team whose root lies outside the roots its entity declares is refused.

A team grant carries `up`, `down` or both, and nothing else. It never carries `send`, `messages` or
`grant`, so `--seat`, `--inbox`, `--allow-grant` and `--client-request` are refused with it, a
sub-grant can never carry `up` or `down`, and a team grant presented to `team send` or
`team messages` is refused as the wrong kind of grant (as a send grant is refused by
`team up --client` and `team down --client`). A grant never widens itself: an up-only grant is
refused by `team down --client` with the request that would add `down` (`--up --down`), and a
down-only grant is refused by `team up --client` the same way; the owner signs a new record. The
record is bound to one team: there is no form of it for "every team this client launched" today.

`--request` is the conversational form, and it works as for any client grant: the entity's
`grant-emission` policy must be `conversational`, the request is written as a pending `gr_…`
record, and the owner seat answers it with `team grant --approve-as-owner-seat <request-id> oui`
(a Touch ID or passkey signature, never a terminal prompt of the client) and the owner then runs
`team grant --execute <request-id>`. The approval prompt names the client, what it may run, the
team and the folder. `always` is refused for a team grant: a standing rule would renew the grant
without the owner seeing the team again. A request that carries `up` is bound to the team file it
was made against: when the file changed between the request and `--execute`, execute refuses, the
request is not spent, and the message says to ask again. A down-only request is not spent by a
changed file, since `down` never reads its fingerprints.

Without `--request` the owner at a terminal signs the same grant directly.

`--expires` is an ISO timestamp. A team grant is meant to last: without `--expires` it expires
ninety days after it is written (or sooner, when the owner's `client-grant-max-duration` policy
caps up/down grants lower), and ninety days is the cap unless that policy changes it; `--expires
never` signs one with no end date and is refused unless the policy says `none` for up/down grants.
Nothing else sets it: no constant is a ceiling. Ending it earlier is [`team revoke`](revoke.md) `<grant-id>`, from the owner's
terminal, at any time; the client's next `team up --client` or `team down --client` is refused.

An up-only record is exactly what the first build of the up grant wrote, byte for byte (its binding
is stored under `up`). A record that carries `down` stores the same binding under `team`, so a
build that knows only `up` refuses it whole instead of reading half of it.

## A bundle grant

`--bundle observer`, `--bundle operator`, `--bundle manager` or `--bundle developer` writes a **bundle grant**: one owner-signed record that
carries a named, fixed list of commands for one team at one folder, so one signature covers them
all. `observer` is read-only (`status`, `list`, `check`, `feed`, `messages`); `operator` is the
observer plus `send` to the granted seats (`--seat`, a comma-separated list), `up` and `down`.
`manager` is for one team only and **needs `--team`**: the operator's list, plus the team's own
reads, `restart` and `reload`, and the seat lifecycle, `add` and `remove` (28 ops; the whole list is in
[Client grant bundles](../concepts/client-grant-bundles.md#the-manager-bundle)). Its length is capped at,
and defaults to, ninety days. It may carry `add` and `remove`, and so may `developer`; `observer` and
`operator` never do.
`developer` is the manager's list plus `rename`, `swap`, `pause`, `resume`, `hold`, `release`, `tempo`, `queue`, `lock`,
`unlock`, `worktree`, `raise`, `route`, `pr`, `workflow` and `proc` (44 ops), also for one team only and ninety
days at most; `pause` and `resume` stop and restart new work for the grant's team without interrupting a seat (see
[Client grant bundles](../concepts/client-grant-bundles.md#the-developer-bundle)).

    team grant --client grok-bot --entity floor --public-key ~/.config/team-client/grok-bot/client.pub \
      --team docs --bundle operator --seat orchestrator --request

    team grant --client grok-bot --entity floor --public-key ~/.config/team-client/grok-bot/client.pub \
      --team teamcli --bundle manager --request

    team grant --client grok-bot --entity floor --public-key ~/.config/team-client/grok-bot/client.pub \
      --team teamcli --bundle developer --request

The bundle is expanded at signing time into the explicit op list stored in `allowed_ops`; the
bundle's name is a label and decides nothing, so a command added to a bundle later never widens a
grant already signed. The owner's signature prompt reads, for example: "Grok Bot may, for team docs
until 2027-01-21 09:00 UTC: see status, send to orchestrator, start (file 3f9a1c0b2d4e), stop. It
cannot change permissions, add or remove seats, or create teams." Commands that change who may do
what (`grant`, `revoke`, `init`, `policy`, `settings`, `owner-seat`, `delegate`, `daemon`, and the rest of the list in
[Client grant bundles](../concepts/client-grant-bundles.md)) can never be in a bundle, and `add` and `remove`
can be in the manager and developer bundles only. `--bundle`
refuses `--up`, `--down`, `--inbox`, `--allow-grant` and `--client-request`. As for `--up`, only `up`
reads the team file's fingerprints; `always` is refused; `--expires` is capped by the `client-bundles`
policy's days when it writes them, and by the `client-grant-max-duration` policy's `bundle` cap
(ninety days by default; `--expires never` only when that cap is `none`); and [`team revoke`](revoke.md) `<grant-id>` ends the
whole bundle. The per-command grants above are unchanged: this complements them.

## Who may run it

Only the owner, from a terminal outside herdr, in every form. An agent, seat, delegate or caller
without a terminal is refused before the team file is read. A grant cannot authorize this command,
and no mode waives the gate; `--dry-run` has the same owner requirement.

## What it changes

The first form writes only the top-level `grant` section. An identical grant leaves every byte
unchanged. Other sections keep their original text. An invalid file, invalid scope, linked file or
concurrent file change is refused. `--dry-run` validates the proposed edit without writing.

The second form writes one signed record into the grants folder in the owner's home; the team file
is read for the project's root and team, never changed. A revocation is not restored: a new grant
under the same name is a new record, and [team revoke](revoke.md) appends the revocation record
that ends it. Runtime admission still requires a verified record of the team file on this machine;
`reload` reads the live file's grant. Writing either record does not change the team file.

## How long, and no end date

How long a new client grant may last is the owner's `client-grant-max-duration` policy
(`send=7d;up=90d;bundle=90d` when unset, so nothing changes until it is set; `none` allows no end
date). The owner sets it with `team policy set entity client-grant-max-duration <value> --entity
<entity>`. A refusal for duration names the policy, the level it was read at and that command. A grant
signed with `--expires never` stores `"expires": null`; it is never expired, only `team revoke
<grant-id>` ends it, the owner card reads "until revoked (no end date)", `always` is refused for it, a
master grant and a sub-grant never take it, and an older build refuses it whole. The full page is
[How long a client grant lasts](../concepts/client-grant-duration.md).

The third form writes one owner-signed client grant into the same shared grants folder, under the
grant id; the team file is read for nothing and changed by nothing. A grant id is unique: a second
invocation for the same client key writes a second grant with its own id, and
[team revoke](revoke.md) ends either one by id.

## Output and exit codes

| Outcome | Output | Exit |
| --- | --- | --- |
| record written | `grant: updated` | 0 |
| identical team-file grant | `grant: unchanged` | 0 |
| valid preview that would change | `grant: would change` or `grant: would write the <kind> grant …` | 0 |
| caller refused, concurrent edit or write failed | `team grant: <problem>` | 1 |
| invalid invocation, file, seat, team, name or record | `team grant: <problem>` | 2 |

`--help` and `-h` show usage and exit 0. Use [team revoke](revoke.md) to remove the grant or end
a standing grant.
