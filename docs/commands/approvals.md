# team approvals

Lists the owner seat's always rules, prints one request's full record, or removes rules by their
ids, in one command. `team init --revoke-approval` removes a team-create rule only; this command
lists both kinds and revokes either. Listing and details read the owner's folder and change
nothing. Revoking removes rules the owner already gave. It does not grant, and it does not change
`owner-signers` or `approval-mode`. Every id in one `revoke` is one request, one card, and one
Touch ID. A bad id revokes nothing.

The card the owner answers shows at most three plain lines: what the request is, the question, and
— when the kind has one — who asked and what the answer covers. The record it stands for — the
request id, the repository, HEAD and the bound arguments — is in the signed request and the audit
log, and `team approvals details <id>` prints it.

## Synopsis

    team approvals list [--json]
    team approvals details <id> [--json]
    team approvals revoke <id...> [--json]
    team approvals revoke <id...> --request [--json]
    team approvals revoke <id...> --approval <request-id> [--json]

Each `<id>` is `tc_…` for a team-create rule or `oa_…` for an owner-action rule.

## Who may run it

Anyone may list or read details. Revoking is the owner's, from a terminal outside the terminal host, or an
owner-seat answer for that revoke: `--request` records every id as one request and the owner
answers on the owner page; `--approval` runs it once. A signed always rule for
`team-revoke-approval` covering the folder of every rule named admits the revoke with no request.
The rule covers the rules' folders, not the caller's; a rule whose file does not verify has no
folder that can be checked, so it admits nothing. A run with no terminal and no such answer is
refused: `team approvals: only the owner runs this, from a terminal outside the terminal host`.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the rules are listed | one line per rule, `id  kind  scope`, or `team approvals: no always rules`; `--json` prints `{ "format": 1, "rules": […] }` | 0 |
| details are printed | one line per record field — request id, who asked, team, repository, HEAD, each action's bound arguments, hashes — then `audit <name>` per audit entry; `--json` prints `{ "format": 1, "request": …, "audit": […] }` | 0 |
| the rules are revoked | `team approvals: revoked <id...>` | 0 |
| a request is recorded | the owner-seat request line | 0 |
| details are refused | `team approvals: <reason>` | 1 |
| the revoke is refused | `team approvals: <reason>` | 1 |
| the invocation can't be read | `team approvals: <problem>` and the usage | 2 |

## Examples

```console
$ team approvals ; echo "exit $?"
team approvals: a verb is required: list, details or revoke
Usage: team approvals list [--json]
       team approvals details <id> [--json]
       team approvals revoke <id...> [--json]
       team approvals revoke <id...> --request [--json]
       team approvals revoke <id...> --approval <request-id> [--json]

Lists the owner seat's always rules — team-create (tc_…) and owner-action (oa_…) — or removes
every id in the one command. Listing reads the owner's folder and changes nothing. Details prints
one request's full record — request id, repository, HEAD, bound arguments, hashes — and the audit
entries written for it; the card the owner answers never carries them. Revoking is the owner's,
from a terminal outside the terminal host, or an owner-seat answer for that revoke: --request records every
id as one request and --approval <request-id> runs it once the owner has answered on the owner
page. One card and one Touch ID cover the whole list. A signed always rule for
team-revoke-approval covering the folder of every rule named admits the revoke with no request. A bad id revokes
nothing.

Exits 0 when the rules are listed, the details are printed, the rules are revoked, or a request
is recorded, 1 when the details or the revoke are refused, 2 when the invocation can't be read.
exit 2
$ team approvals list ; echo "exit $?"
team approvals: no always rules
exit 0
$ team approvals list --json ; echo "exit $?"
{"format":1,"rules":[]}
exit 0
$ team approvals details not-an-id ; echo "exit $?"
team approvals: "not-an-id" is not an owner-seat request id
exit 1
$ team approvals revoke not-an-id ; echo "exit $?"
team approvals: "not-an-id" is not an approval rule id; nothing was revoked
exit 1
```
