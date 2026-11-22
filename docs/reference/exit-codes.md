# Exit codes

Every `team` command ends with one of three codes.

| Code | Meaning |
|---|---|
| 0 | Done: the command did what it says, or a dry run planned it. |
| 1 | Not done: the command ran and refused, or the work did not happen (the message says why and what to do). |
| 2 | Could not run: a bad invocation (unknown flag, missing argument), or a team file or record that cannot be read. |

Each command's help line ends with what its 0, 1 and 2 mean for it (`team <command> --help`).

Under `--json`, a refusal prints a `team.error` object whose `error.id` names the case, in the
form `<command>.<case>` (for example `send.refused`). The ids are stable within a minor version.
