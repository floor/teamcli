# team client

The app-key side of a client grant. `keygen` writes one Ed25519 pair for a client app:
`client.key` holds the private half, mode 0600, and `client.pub` holds the public half and its
key id. A directory it creates is mode 0700. The pair is never replaced — a second run against a
directory that already holds one is refused.

The directory is the placement rule, not a suggestion: it must sit under
`~/.config/team-client`, and a path overlapping a registered team root or lobby, or the OS temp
folder, is refused, as is a symbolic link anywhere on it. This is where a same-user process could
still read the key, and the command says so rather than implying otherwise:
`key isolation: not enforced (pane guard pending)`.

A key pair alone admits nothing. The owner issues a grant for it with
[`team grant`](grant.md) `--client`, bound to the client id, the entity and the key's directory,
expiring in at most seven days; the owner withdraws it by grant id with
[`team revoke`](revoke.md). The client then sends with `team send --client`, signing each request
with `client.key`. `team client` itself never signs a grant, a request or a drop.

## Synopsis

    team client keygen --out <dir> [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--out` | `<dir>` | the directory to write `client.key` and `client.pub` into; created 0700 when absent; required |
| `--json` | — | emit the structured `team.client.keygen` JSON document on stdout (`schema/client.schema.json`) |

## Who may run it

| Caller | May |
| --- | --- |
| anyone | write a fresh key pair in an allowed directory |

No team file, seat, registry record or terminal is read: the key belongs to the caller, and only
the owner's signed grant makes it mean anything.

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the pair is written | `client key: <path>`, `client public key: <path>`, `client public key id: <id>`, and the isolation line | 0 |
| the directory is refused or the pair cannot be written | `team client keygen: <why>` | 1 |
| no subcommand, an unknown subcommand, or invalid arguments | `team client: <why>` and the usage | 2 |
