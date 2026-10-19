# team grant

Writes an authority record for the current team, in one of three forms. `team grant <seat>
--scope <act,...>` sets the orchestrator's grant in the team file; a later invocation replaces
that scope exactly, and the file holds one grant. `team grant <seat|@team> --capabilities
<cap,...>` writes a standing grant record — an owner-signed record naming the grantee's registry
identity, an agent id for a seat or a team id for `@team`.

## Synopsis

    team grant <seat> --scope <act,...> [--dry-run] [--json]
    team grant <seat|@team> --capabilities <cap,...> [--scope <path,...>] [--expires <date>] [--name <stem>] [--dry-run] [--json]
    team grant --client <client-id> --entity <entity> --public-key <file> [--expires <ISO>] [--json]

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
`orchestrator@floor`. `--expires` is an ISO timestamp no more than seven days ahead; without it
the grant expires seven days after it is written, and a grant never carries an unlimited or a past
expiry. `--dry-run`, `--scope`, `--capabilities`, `--name` and positional arguments belong to the
other forms and are refused here. The grant admits only the signed client request form, with no
owner, seat or terminal authority.

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
