# team grant

Sets the orchestrator's grant in the current team file. The owner chooses the seat and its
complete scope; a later invocation replaces that scope exactly. The file holds one grant.

## Synopsis

    team grant <seat> --scope <act,...> [--dry-run]

`<seat>` must name the file's orchestrator. The grant uses the file's session. `--scope` is a
nonempty comma-separated list of distinct words: `up`, `down`, `approve`, `init`, `reload`,
`swap`. These words retain their existing admission checks and limits.

## Who may run it

Only the owner, from a terminal outside herdr. An agent, seat, delegate or caller without a
terminal is refused before the team file is read. A grant cannot authorize this command;
`--dry-run` has the same owner requirement.

## What it changes

Writes only the top-level `grant` section. An identical grant leaves every byte unchanged.
Other sections keep their original text. An invalid file, invalid scope, linked file or
concurrent file change is refused. `--dry-run` validates the proposed edit without writing.

This command manages the existing team-file record. It does not create a machine-wide grant
store or add new powers. Runtime admission still requires a verified approval. `approve`
and `reload` also apply their existing checks against the approved copy. Writing the record
does not perform an approval.

## Output and exit codes

| Outcome | Output | Exit |
| --- | --- | --- |
| grant written | `grant: updated` | 0 |
| identical grant | `grant: unchanged` | 0 |
| valid preview that would change the file | `grant: would change` | 0 |
| caller refused, concurrent edit or write failed | `team grant: <problem>` | 1 |
| invalid invocation, file or grant | `team grant: <problem>` | 2 |

`--help` and `-h` show usage and exit 0. Use [team revoke](revoke.md) to remove the grant.
