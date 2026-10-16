# team revoke

Removes the grant or one external delegate from the current team file. An absent target is a
successful no-op. Removing the last delegate removes the `delegates` section.

## Synopsis

    team revoke grant [--dry-run]
    team revoke delegate <session/pane> [--dry-run]

The delegate target is exact. There is no wildcard target or revoke-all form.

## Who may run it

Only the owner, from a terminal outside herdr. An agent, seat, delegate or caller without a
terminal is refused before the team file is read. Existing grant or delegate authority cannot
authorize this command. `--dry-run` has the same owner requirement.

## What it changes

Writes only the selected top-level section, preserving other delegates and unrelated text.
An invalid file, malformed target, linked file or concurrent file change is refused.
`--dry-run` validates the removal without writing.

Removal withdraws the named record only. Another independent grant, delegate or intrinsic
lead capability can still authorize an operation. The next admission check uses the live
record or refuses because it differs from the approved copy; an older approval does not
restore the removed record. Existing runtime requirements still apply. Running seats stay
running.

This command manages existing team-file records. It does not create a machine-wide grant
store, issue revocation notices or stop processes.

## Output and exit codes

| Outcome | Output | Exit |
| --- | --- | --- |
| record removed | `revoke: updated` | 0 |
| target absent | `revoke: unchanged` | 0 |
| valid preview that would change the file | `revoke: would change` | 0 |
| caller refused, concurrent edit or write failed | `team revoke: <problem>` | 1 |
| invalid invocation, file or target | `team revoke: <problem>` | 2 |

`--help` and `-h` show usage and exit 0. See [team grant](grant.md) and
[team delegate](delegate.md) for creating records.
