# team revoke

Removes the grant or one external delegate from the current team file, or ends a standing grant.
An absent target is a successful no-op. Removing the last delegate removes the `delegates`
section.

## Synopsis

    team revoke grant [--dry-run] [--json]
    team revoke delegate <session/pane> [--dry-run] [--json]
    team revoke <name> [--dry-run] [--json]
    team revoke <client-grant-id> [--json]
    team revoke --client <client-grant-id> [--json]

The delegate target is exact. There is no wildcard or revoke-all form. The bare `<name>` form
revokes a standing grant only when a record with that name exists; any other word is the
invocation error. A target that reads as a client grant id — `cg_` and twenty-four hex digits —
takes the client form whether it is bare or named with `--client`.

## Who may run it

Only the owner, from a terminal outside herdr, in every form. An agent, seat, delegate or caller
without a terminal is refused before the team file is read. Existing grant or delegate authority
cannot authorize this command, and no mode waives the gate; `--dry-run` has the same owner
requirement.

## What it changes

`grant` and `delegate` write only the selected top-level section, preserving other delegates and
unrelated text. An invalid file, malformed target, linked file or concurrent file change is
refused. `--dry-run` validates the removal without writing.

A bare `<name>` appends a signed revocation record naming that standing grant's file name and
generation — the pair that identifies the record — into the grants folder in the owner's home;
the grant file itself is never edited. The revocation takes effect at the next gate check, and
never restores an older record: a later grant under the same name is a new record this revocation
does not touch. Revoking a team grant that carries the `dialogs.trust` setting turns trust
answering off at the next dialog. A record already revoked is an unchanged no-op. A revocation is always its own
file: a record name that is the grant's own, or another grant's stem, is refused before anything
is written, so a revocation never overwrites a grant.

A client grant id appends one owner-signed per-event revocation record into the same grants folder,
beside the grant and every other revocation; nothing is deleted or rewritten. Each event covers the
whole signed bytes it was made from, and a revocation record that cannot be read or verified fails
closed — the client grant is treated as revoked, never as still valid. This is the only way a client
grant signed with no end date (`--expires never`, see [How long a client grant lasts](../concepts/client-grant-duration.md))
ends; it is revocable like any other, and the revocation is read by the build that knows the grant. A client request is
revalidated against the grant, its expiry and these events when it lands, so a revocation ends the
client's access even for a request composed before it. A grant already revoked is an unchanged
no-op.

Removal withdraws the named record only. Another independent grant, delegate or intrinsic lead
capability can still authorize an operation. The next admission check reads the live file and the
records that remain; an older record does not restore the removed one. Existing runtime
requirements still apply. Running seats stay running.

## Output and exit codes

| Outcome | Output | Exit |
| --- | --- | --- |
| record removed or revocation appended | `revoke: updated` | 0 |
| target absent or already revoked | `revoke: unchanged` | 0 |
| valid preview that would change | `revoke: would change` or `revoke: would revoke the grant …` | 0 |
| caller refused, concurrent edit or write failed | `team revoke: <problem>` | 1 |
| invalid invocation, file, target or name | `team revoke: <problem>` | 2 |

`--help` and `-h` show usage and exit 0. See [team grant](grant.md) and
[team delegate](delegate.md) for creating records.
