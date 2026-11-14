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

On a machine whose owner seat is pinned from another machine (`team owner-seat pin`), owner
requests travel as files until machines are linked: `export`, `sign` and `answer` below.

## Synopsis

    team approvals list [--json]
    team approvals details <id> [--json]
    team approvals revoke <id...> [--json]
    team approvals revoke <id...> --request [--reason <text>] [--json]
    team approvals revoke <id...> --approval <request-id> [--json]
    team approvals export <id> --out <file> [--json]
    team approvals sign --from <file> --out <file> [--answer <oui|always|non>] [--signer <name>] [--assertion <file>] [--json]
    team approvals answer --from <file> [--json]

Each `<id>` is `tc_…` for a team-create rule or `oa_…` for an owner-action rule (and, for
`export`, an owner-action request id).

## Carrying a request between machines

A machine whose owner seat is pinned holds no owner signer, and a terminal there is not the owner.
Its owner-only actions run on the owner's signed answer, carried as files by an agent:

1. **On the pinned machine**, the command records its request as on any machine (`--request`).
   The request names this machine — its id and name — its answer window (at most fifteen
   minutes) and every action's argument words, all inside the parameters the owner signs.
   `team approvals export <id> --out <file>` writes it to a new file. A request that is answered,
   past its window, names no machine or carries no signed window (one recorded before the pin,
   or by an earlier build) is refused.
2. **On the machine that holds the signers**, `team approvals sign --from <file> --out <file>`
   records the request as a card for another machine (the owner page shows it, and its scope
   line names that machine) and writes the signed answer to a new file. Before the card is
   recorded or shown, every action's argument hash must be the hash of the words the card shows,
   and the window must be whole and no longer than fifteen minutes. With
   `--answer <oui|always|non>` the owner signs at once on the usual card (on the owner's device,
   or a passkey with `--signer` and `--assertion`); without it, the card waits on the owner page and running
   `sign` again writes the answer the owner gave there. That machine never runs the request
   itself, and keeps no `always` rule for it. A note says when the other machine pinned another
   owner seat than this one.
3. **Back on the pinned machine**, `team approvals answer --from <file>` records the answer once
   it verifies against the pinned owner seat: signed by a pinned, accepted signer, over exactly
   this request and this machine, inside the signed window, and not answered or run before. The
   command then runs with `--approval <id>`, checked again and spent once in the machine's
   approval ledger. On a pinned machine `always` admits that one request once; no standing rule
   is kept there yet.

The files carry the request record and the signed answer unchanged; neither file grants anything
on its own, and neither is ever written over an existing file.

## Who may run it

Anyone may list or read details. Revoking is the owner's, from a terminal outside the terminal host, or an
owner-seat answer for that revoke: `--request` records every id as one request (`--reason <text>` is
the short reason the card shows) and the owner answers on the owner page; `--approval` runs it once. A signed always rule for
`team-revoke-approval` covering the folder of every rule named admits the revoke with no request —
to its subject: the lead of the team the rule was signed for, placed in that team's session, or
that team's entity's main orchestrator (the owner as ever). The rule spent is the one naming the
caller's team, so two teams sharing a folder cannot spend each other's rules; a plain seat, a lead
of another team and another entity's orchestrator keep the refusal.
The rule covers the rules' folders, not the caller's; a rule whose file does not verify has no
folder that can be checked, so it admits nothing. A run with no terminal and no such answer is
refused: `team approvals: only the owner runs this, from a terminal outside the terminal host`.

Anyone may run `export`, `sign` and `answer`: the owner's signature is the authority, made on the
owner's own device when `sign` asks for it, and checked where the request runs.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the rules are listed | one line per rule, `id  kind  scope`, or `team approvals: no always rules`; `--json` prints `{ "format": 1, "rules": […] }` | 0 |
| details are printed | one line per record field — request id, who asked, team, repository, HEAD, each action's bound arguments, hashes — then `audit <name>` per audit entry; `--json` prints `{ "format": 1, "request": …, "audit": […] }` | 0 |
| the rules are revoked | `team approvals: revoked <id...>` | 0 |
| a request is recorded | the owner-seat request line | 0 |
| a request is exported | `team approvals: request <id> of machine <name> written to <file>` and its expiry | 0 |
| a carried request is signed | `team approvals: request <id> for machine <name> answered <choice> by <signer>; answer written to <file>` | 0 |
| a carried request waits on the owner page | `team approvals: request <id> from machine <name> is on the owner page; …` | 0 |
| a carried answer is recorded | `team approvals: request <id> answered <choice> by <signer>, verified against the pinned owner seat <fingerprint>`, then `run the command again with --approval <id>`; a denial says `nothing runs` | 0 |
| details are refused | `team approvals: <reason>` | 1 |
| the revoke is refused | `team approvals: <reason>` | 1 |
| an export, a signature or a carried answer is refused | `team approvals: <reason>` | 1 |
| the invocation can't be read | `team approvals: <problem>` and the usage | 2 |

## Examples

```console
$ team approvals ; echo "exit $?"
team approvals: a verb is required: list, details, revoke, export, sign or answer
Usage: team approvals list [--json]
       team approvals details <id> [--json]
       team approvals revoke <id...> [--json]
       team approvals revoke <id...> --request [--reason <text>] [--json]
       team approvals revoke <id...> --approval <request-id> [--json]
       team approvals export <id> --out <file> [--json]
       team approvals sign --from <file> --out <file> [--answer <oui|always|non>] [--signer <name>] [--assertion <file>] [--json]
       team approvals answer --from <file> [--json]

Lists the owner seat's always rules — team-create (tc_…) and owner-action (oa_…) — or removes
every id in the one command. Listing reads the owner's folder and changes nothing. Details prints
one request's full record — request id, repository, HEAD, bound arguments, hashes — and the audit
entries written for it; the card the owner answers never carries them. Revoking is the owner's,
from a terminal outside the terminal host, or an owner-seat answer for that revoke: --request records every
id as one request (--reason <text> is the short reason the card shows) and --approval <request-id> runs it once the owner has answered on the owner
page. One card and one Touch ID cover the whole list. A signed always rule for
team-revoke-approval covering the folder of every rule named admits the revoke with no request. A bad id revokes
nothing.

On a machine whose owner seat is pinned from another machine, owner requests travel as files.
Export writes one waiting request of this machine to a file. Sign, on the machine that holds
the owner's signers, records that request, shows its card (signed at once with --answer, or on
the owner page) and writes the signed answer to a file. Answer, back on the pinned machine, checks that
answer against the pinned owner seat and records it; the command then runs with --approval <id>.

Exits 0 when the rules are listed, the details are printed, the rules are revoked, a request
is recorded, a file is written or an answer is recorded, 1 when the details, the revoke or a
carried file are refused, 2 when the invocation can't be read.
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
$ team approvals export oa_0123456789abcdef01234567 --out request.json ; echo "exit $?"
team approvals: this machine's owner seat is not pinned from another machine; its requests are answered here
exit 1
```
