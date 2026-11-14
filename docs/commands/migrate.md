# team migrate

Moves this team's definition from `.agents/team.yaml` into the registry, once, and then retires the file.

## Usage

    team migrate [--keep-file] [--dry-run] [--json]
    team migrate [--keep-file] --request [--json]
    team migrate [--keep-file] --approval <request-id> [--json]
    team migrate --root [--dry-run] [--json]

## Examples

```fixture
approved: false
```

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

workspace:
  mode: shared

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

Anyone can see what a migrate would do. It writes nothing, and it does not ask the owner:

```console caller=agent
$ team migrate --dry-run
beacon: would import ./.agents/team.yaml (team <id>); nothing written
then .agents/team.yaml would be moved to the Trash (--keep-file leaves it)
```

The owner, from a terminal, imports and leaves the file. A second run finds the team already there:

```console
$ team migrate --keep-file
beacon: imported ./.agents/team.yaml (team <id>); read back and verified
.agents/team.yaml was kept (--keep-file); it is no longer read, and team migrate moves it later
$ team migrate --keep-file
beacon: the registry already holds this team; nothing to import
.agents/team.yaml was kept (--keep-file); it is no longer read, and team migrate moves it later
```

## Options

- `--dry-run` — say what would be imported, and write nothing. Anyone in the project may run it.
- `--keep-file` — import and verify, and leave `.agents/team.yaml` where it is.
- `--request` — record an owner-seat card for this exact record and stop. The card is titled **Migrate the team** and asks **<asker> wants to migrate the team. OK?**, adding the reason the request carried when it has one; the project, the seat count, the canonical-record hash and the request id are in its folded details, and `team approvals details <id>` prints them. It offers **Approve once** and **Deny** as decisions (the page's later words are on it too, but they decide nothing). A migration needs that one-time approval; the card does not offer **Always allow**.
- `--approval <request-id>` — run the migrate the owner seat signed, once. A denial, an expiry, or a bad signature writes nothing. No signer approves a request they asked for.
- `--root` — rewrite full paths inside the entity's projects root as `{root}` (above).
- `--json` — one JSON document on stdout.

Run by anyone but the owner at a terminal, `team migrate` records that card, waits for the signed answer, and continues. The owner at a terminal runs it with no extra flags.

## Rewriting full paths as `{root}`

`team migrate --root` rewrites, in this team's record, every value that writes a full path inside
its entity's projects root on this machine — the absolute path, `~/…` or `$HOME/…` — as `{root}/…`
([the team file's reference](../team-file.md#the-entitys-projects-root-root)), so the same record
reads on every machine. Set the root first: `team config set <entity>.root <folder>`.

    team migrate --root --dry-run    # each line it would change; writes nothing
    team migrate --root              # the owner, from a terminal: writes those lines

The rewrite is line by line: comments, keys and every other value stay byte for byte, a value that
would start with the word is quoted, and the result must read back as the same team with only
those paths changed, or nothing is offered. Every changed line is printed, before and after, by
the dry run and by the write alike; the write is never silent. Anyone may run the dry run; the
write is the owner's, from a terminal outside herdr, as every edit of the team's record. A seat
whose launch line changed has its agent record's launch line updated with it. `--root` takes no
other import option.

| Outcome | Exit |
| --- | --- |
| the lines listed, written, or nothing to rewrite | 0 |
| no root set, a rewrite that does not read back, a caller who is not the owner | 1 |
| an invalid invocation, or a record that cannot be read | 2 |

## See also

- [team import](import.md) — replace the registry's record when a leftover file differs
- [team config](config.md) — edit the team after it lives in the registry
- [Owner-seat approval](up.md#owner-seat-approval-no-owner-terminal)
