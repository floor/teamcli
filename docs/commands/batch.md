# team batch

Records several owner-seat actions as one request, or runs that request once the owner has
answered. One card and one Touch ID cover the whole list. Each command is bound the way its own
`--request` binds it: repository, team, HEAD, and the hash of its arguments. The commands are
`approvals revoke`, `forget`, `up`, `add`, `import`, `send`, `down`, and `bus`. A batch does not
grant, and it does not change `owner-signers` or `approval-mode`.

## Synopsis

    team batch --request --do <command> [--json]
    team batch --approval <request-id> [--dry-run] [--json]

Repeat `--do`, once per command. The words after `--do` are that command and its arguments.
`--approval` runs every action in the recorded list, each once. `--dry-run` checks the answer
and changes nothing. Before anything runs, every action must be one the request admits, and
every revoke id and forget id must resolve; otherwise nothing runs.

## Who may run it

Anyone. The command records a request or runs a batch the owner seat already signed. The owner
answers on the owner page. A command that records a request does not open a browser; when the
owner page is already open, that page shows the new card.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| a request is recorded | the owner-seat request line, how many actions one signature covers, and `then run: team batch --approval <request-id>` | 0 |
| the batch has run | each command's own lines, then `team batch: ran <N> actions` | 0 |
| a dry run checked the answer | `team batch: <request-id> would run <plan>` and `dry run: nothing was run` | 0 |
| the batch is refused | `team batch: <reason>` | 1 |
| the invocation can't be read | `team batch: <problem>` and the usage | 2 |

## Examples

```console
$ team batch ; echo "exit $?"
team batch: pass --request and one or more --do <command>, or --approval <request-id>
Usage: team batch --request --do <command> [--json]
       team batch --approval <request-id> [--dry-run] [--json]

Records several owner-seat actions as one request, or runs that request once the owner has
answered. Repeat --do, once per command. The words after --do are that command and its
arguments: approvals revoke and its rule ids, or forget and its team ids, or up, add, import,
send, down, bus with the arguments that command would take. Each command is bound as its own
--request would bind it: repository, team, HEAD, and the hash of its arguments. One card and
one Touch ID cover the whole list.

--approval runs every action in the recorded list, each once. --dry-run checks the answer and
changes nothing. Before anything runs, every action must be one this request admits, and every
revoke id and forget id must resolve; otherwise nothing runs. A command here does not grant,
does not change owner-signers, and does not change approval-mode.

Exits 0 when the request is recorded or the batch has run, 1 when it is refused, 2 when the
invocation can't be read.
exit 2
```
