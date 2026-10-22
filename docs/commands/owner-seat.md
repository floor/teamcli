# team owner-seat

The owner seat is the human owner's own seat. An agent (Iris) runs this command on the owner's
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

- `status` (the default): the seat, its signers and the security-profile line. A relaxed profile
  prints `SECURITY PROFILE: RELAXED: …` in capitals.
- `setup`: creates the Secure Enclave key, registers the seat and asks for one Touch ID to confirm
  it. The same prompt covers the entity policies named with `--owner-signers` and
  `--grant-emission` (written at `--policy-entity`, default the seat's entity). A cancelled prompt
  registers nothing.
- `profile`: proposes the `security-profile` value with an expiry (default 7 days, at most 30).
  A Secure Enclave signer signs it at once (Touch ID); a passkey signer signs it on the owner page.
  `dev` is an alias of `relaxed`.
- `serve`: the owner page on `http://localhost:<port>/?t=<token>` (default port 7391, bound to
  127.0.0.1, one token per run): add a passkey, sign the waiting profile, answer team requests.
  Refused while no owner seat is registered.

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
| `--json` | — | on `status`: one JSON document |
| `--help`, `-h` | — | the usage, and exit 0 |

## What it reads and writes

`~/.config/team/owner-seat.json` (the seat), `~/.config/team-owner-seat/` (the helper and its
Secure Enclave key handles), `~/.config/team/security-profile.json` (the signed profile),
`security-profile.proposal.json` beside it, and the append-only `security-profile.log`.

## Exit codes

0 when done, 1 when refused (including a cancelled prompt), 2 when the invocation is invalid.
