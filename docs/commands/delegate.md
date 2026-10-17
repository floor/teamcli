# team delegate

Adds or replaces one external delegate in the current team file. Replacing an entry sets its
complete command list; commands from the old entry are not retained. Other delegates keep
their values and order.

## Synopsis

    team delegate <session/pane> --commands <act,...> [--dry-run] [--json]

`<session/pane>` identifies a pane outside the team's own session. Both components are
required, with one slash and no whitespace. At most eight delegates may be recorded.
`--commands` is a nonempty comma-separated list of distinct words: `up`, `down`, `add`,
`remove`, `approve`, `swap`. Their existing admission checks and limits still apply.

## Who may run it

Only the owner, from a terminal outside herdr. An agent, seat, delegate or caller without a
terminal is refused before the team file is read. Delegated authority cannot authorize this
command or widen its own entry. `--dry-run` has the same owner requirement.

## What it changes

Writes only the top-level `delegates` section. An identical entry leaves every byte unchanged.
Other sections keep their original text. An invalid file, target, command list, linked file or
concurrent file change is refused. `--dry-run` validates the proposed edit without writing.

This command manages existing team-file records. It does not create a machine-wide grant
store or add new powers. Runtime admission still requires a verified approval, and delegated
`approve` retains its restrictions on changes to owner sections. Writing the record does
not perform an approval.

## Output and exit codes

| Outcome | Output | Exit |
| --- | --- | --- |
| entry written | `delegate: updated` | 0 |
| identical entry | `delegate: unchanged` | 0 |
| valid preview that would change the file | `delegate: would change` | 0 |
| caller refused, concurrent edit or write failed | `team delegate: <problem>` | 1 |
| invalid invocation, file or entry | `team delegate: <problem>` | 2 |

`--help` and `-h` show usage and exit 0. Use [team revoke](revoke.md) to remove one delegate.
