# team owner-seat

The owner seat is the human owner's own seat. An agent (the orchestrator) runs this command on the owner's
behalf; the owner never types it. Every step that needs the owner ends in a native prompt on the
owner's own device, Touch ID from the Secure Enclave helper or a passkey on the owner page, and
that signature is the authority, not the caller or a terminal.

See [owner-seat setup](../owner-seat-setup.md) for the morning checklist.

## Synopsis

    team owner-seat [--json]
    team owner-seat status [--json]
    team owner-seat setup --team <team> --signer <name> [--entity <entity>] [--owner-signers <a,b>] [--grant-emission <value>] [--policy-entity <entity>]
    team owner-seat profile <strict|relaxed|dev> [--days <1-30>] [--reason <text>] [--signer <name>]
    team owner-seat serve [--port <port>]
    team owner-seat export --out <file> [--signer <name>] [--json]
    team owner-seat pin --from <file> [--name <machine>] [--json]

- `status` (the default): the seat, its signers and the security-profile line. A relaxed profile
  prints `SECURITY PROFILE: RELAXED: …` in capitals. On a machine whose owner seat is pinned it
  names the pinned seat, its fingerprint and this machine, and says that a terminal here is not
  the owner.
- `setup`: creates the Secure Enclave key, registers the seat and asks for one Touch ID to confirm
  it. The same prompt covers the entity policies named with `--owner-signers` and
  `--grant-emission` (written at `--policy-entity`, default the seat's entity). A cancelled prompt
  registers nothing.
- `profile`: proposes the `security-profile` value with an expiry (default 7 days, at most 30).
  A Secure Enclave signer signs it at once (Touch ID); a passkey signer signs it on the owner page.
  `dev` is an alias of `relaxed`.
- `serve`: the owner page on `http://localhost:<port>/?t=<token>` (default port 7391, bound to
  127.0.0.1, one token per run): add a passkey, sign the waiting profile, answer team requests.
  The page asks `/api/state` every two seconds, so a request recorded while it is open appears
  on that page. A command that records a request does not open a browser. Refused while no
  owner seat is registered.
- `export`: on the machine that holds the signers, writes the seat's public signer records — each
  device key's public key, each passkey's public key, credential id and relying party — and the
  names the `owner-signers` policy accepts, to a new file. No private key is in it. One
  confirmation on the owner's device signs it (by an accepted device key; `--signer` names one
  when there are several), and the card and the output show its fingerprint.
- `pin`: on a machine that holds no owner signer (a headless server), pins that export. The
  export must verify under a signer it names, and this machine must have no owner seat of its
  own. The first pin is trust on first use: this machine believes the first export its owner
  gives it, from a terminal on this machine outside the terminal host, and it prints the same
  fingerprint so the owner compares the two. It makes this machine's record: a random id and a
  name (`--name`, default this machine's own name). Pinning the same seat again changes nothing;
  a changed seat (a passkey added, a key replaced) is pinned only from a newer export signed by a
  signer already pinned here, whoever runs the command. A pin that cannot be read is never
  replaced by this command.

## A machine whose owner seat is pinned

- **A terminal there is not the owner**, with a terminal or without one: any agent that opens a
  shell on the account would otherwise count as the owner. No mode, policy or variable changes
  this. Seats in their own panes are placed as before.
- **Nothing else stands in for the owner there.** Dev mode lifts no gate on a pinned machine, for
  any caller — a terminal, an agent outside the terminal host, an unattended run, a placed lead. A
  general grant is refused (`--general`), since it is signed with this account's own key, and the
  owner-authorization fingerprint (`TEAM_OWNER_APPROVAL`) admits nothing, since a fingerprint is
  public.
- **Owner-only actions run on the owner's signed answer.** The command records its request
  (`--request`). The request names this machine, its answer window (made, and expiring at most
  fifteen minutes later) and every action's full argument words, all inside the signed
  parameters, and each action's argument hash must be the hash of the words its card shows. An
  agent carries it to the signer machine and the answer back (`team approvals export`, `sign`,
  `answer`); the command then runs with `--approval <id>`. An answer is checked against the
  pinned keys, is bound to one request of this machine, expires with the signed window, and is
  spent once in this machine's approval ledger. A request that names no machine or another
  machine, carries no signed window or no words, is refused here; the signer machine never runs
  a request that names another machine.
- **No owner signer is made here.** `team owner-seat setup` and `team setup` are refused, and no
  `always` rule is kept here yet: `always` admits the one request once.
- **Where the owner state lives.** The pin, the machine record and the approval ledger are found
  by one rule, which never reads the environment's home: a system folder (`/etc/teamcli`) first,
  when it is present, owned by the system's administrator and writable by no one else, then the
  account's own home from the user database (`~/.config/team`). A machine that holds any of the
  three counts as pinned, and a state that cannot be read or trusted — a missing pin beside a
  machine record, a parent that is not a folder, an unprotected system folder — refuses every
  answer and keeps the terminal from being the owner; it never reads as unpinned.
- **The limit of this step.** In the account's own folder, the owner state is as safe as the
  account's files: a process of the account can replace the pin, copy a machine record, or remove
  a ledger entry. A later step keeps all three in the system folder, out of the agents' reach;
  this command does not write there. Commands that have no `--request` door (`team daemon
  install`, `team grant`) are refused from a terminal here until they have one.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--team` | name | on `setup`: the owner seat's team |
| `--signer` | name | on `setup`: the first signer's name; on `profile`: which signer signs |
| `--entity` | entity | on `setup`: the seat's entity (default: the team) |
| `--owner-signers` | names | on `setup`: also set the `owner-signers` policy, under the same Touch ID |
| `--grant-emission` | value | on `setup`: also set the `grant-emission` policy, under the same Touch ID |
| `--policy-entity` | entity | on `setup`: the entity those policies are written at |
| `--days` | 1-30 | on `profile`: the expiry, in days |
| `--reason` | text | on `profile`: recorded in the profile and the audit |
| `--port` | port | on `serve`: the local port (0 picks a free one) |
| `--out` | file | on `export`: the new file the export is written to (never over an existing file) |
| `--from` | file | on `pin`: the export to pin |
| `--name` | name | on `pin`: this machine's name on the owner's cards, at the first pin (lower case, digits, dots, dashes) |
| `--json` | — | on `status`, `export` and `pin`: one JSON document |
| `--help`, `-h` | — | the usage, and exit 0 |

## What it reads and writes

`~/.config/team/owner-seat.json` (the seat), `~/.config/team-owner-seat/` (the helper and its
Secure Enclave key handles), `~/.config/team/security-profile.json` (the signed profile),
`security-profile.proposal.json` beside it, and the append-only `security-profile.log`. On a
pinned machine, in the owner-state folder (`/etc/teamcli` when it is present and protected, else
the account's own `~/.config/team`): `owner-seat-pin.json` (the pinned export, its fingerprint
and the fingerprint it replaced), `machine.json` (this machine's id and name) and `owner-ledger/`
(one entry per approval spent). The export, the pin and the re-pin are logged in
`security-profile.log`.

## Exit codes

0 when done, 1 when refused (including a cancelled prompt), 2 when the invocation is invalid.

## One-request links

`team grant --request` prints `http://localhost:7392/r/<request-id>#<nonce>`. With the page served
on port 7392, that link shows only that request's card, without the page token. The nonce is
single-use, bound to the request and expires with it; it grants nothing, and an answer from the
card still needs an owner-signer signature. See `docs/commands/grant.md`.

## The later answer

Every card offers **Later**, **Tomorrow** and **Monday** beside its decisions. A later word is
not an approval: it writes one signed deferral beside the request (`<request-id>.later.json`),
bound to the request id and its parameter hash, and approves, denies and spends nothing.

- The card is hidden until the return instant and lists again at it, with one more full answer
  window (fifteen minutes) after that. The request's original window is not otherwise extended.
- `later` returns after four hours; `tomorrow` and a weekday return at 08:00 local time, the next
  one that is still ahead.
- No deferral reaches past the request's creation + 7 days: a return time later than that is
  refused when it is asked for, and a record that names one anyway is honoured only to the cap.
- A deferral that does not verify — an unsigned or forged record, one signed by a signer the
  owner-signers policy does not accept, or one bound to another request or parameter hash — hides
  nothing and extends nothing.
- When the card belongs to a blocked team, that team's lead gets one plain note: it is from the
  owner page, says that the request waits until the return instant, and claims nothing about the
  owner's identity. A team-create card names no team yet, so it leaves no note; a team this build
  cannot resolve keeps the deferral and says that no lead was told.

