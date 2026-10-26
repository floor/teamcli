# team approvals

Lists the owner seat's always rules, or removes one by its id. `team init --revoke-approval`
removes a team-create rule only; this command lists both kinds and revokes either.
Listing reads the owner's folder and changes nothing. Revoking removes a rule the owner already
gave. It does not grant, and it does not change `owner-signers` or `approval-mode`.

## Synopsis

    team approvals list [--json]
    team approvals revoke <id> [--json]
    team approvals revoke <id> --request [--json]
    team approvals revoke <id> --approval <request-id> [--json]

`<id>` is `tc_…` for a team-create rule or `oa_…` for an owner-action rule.

## Who may run it

Anyone may list. Revoking is the owner's, from a terminal outside herdr, or an owner-seat answer
for that revoke: `--request` records it and the owner answers on the owner page; `--approval`
runs it once. A signed always rule for `team-revoke-approval` covering this folder admits the
revoke with no request. A run with no terminal and no such answer is refused:
`team approvals: only the owner runs this, from a terminal outside herdr`.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the rules are listed | one line per rule, `id  kind  scope`, or `team approvals: no always rules`; `--json` prints `{ "format": 1, "rules": […] }` | 0 |
| a rule is revoked | `team approvals: revoked <id>` | 0 |
| a request is recorded | the owner-seat request line | 0 |
| the revoke is refused | `team approvals: <reason>` | 1 |
| the invocation can't be read | `team approvals: <problem>` and the usage | 2 |

## Examples

```console
$ team approvals ; echo "exit $?"
team approvals: a verb is required: list or revoke
Usage: team approvals list [--json]
       team approvals revoke <id> [--json]
       team approvals revoke <id> --request [--json]
       team approvals revoke <id> --approval <request-id> [--json]

Lists the owner seat's always rules — team-create (tc_…) and owner-action (oa_…) — or removes one
by its id. Listing reads the owner's folder and changes nothing. Revoking is the owner's, from a
terminal outside herdr, or an owner-seat answer for that revoke: --request records it and
--approval <request-id> runs it once the owner has answered on the owner page. A signed always
rule for team-revoke-approval covering this folder admits the revoke with no request.

Exits 0 when the rules are listed, a rule is revoked, or a request is recorded, 1 when the revoke
is refused, 2 when the invocation can't be read.
exit 2
$ team approvals list ; echo "exit $?"
team approvals: no always rules
exit 0
$ team approvals list --json ; echo "exit $?"
{"format":1,"rules":[]}
exit 0
$ team approvals revoke not-an-id ; echo "exit $?"
team approvals: "not-an-id" is not an approval rule id
exit 1
```
