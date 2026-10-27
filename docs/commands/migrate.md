# team migrate

Moves this team's definition from `.agents/team.yaml` into the registry, once, and then retires the file.

## Usage

    team migrate [--keep-file] [--dry-run] [--json]
    team migrate [--keep-file] --request [--json]
    team migrate [--keep-file] --approval <request-id> [--json]

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
- `--request` — record an owner-seat card for this exact record and stop. The card names the team, the project, the seat count and the canonical-record hash.
- `--approval <request-id>` — run the migrate the owner seat signed, once. A denial, an expiry, or a bad signature writes nothing. No signer approves a request they asked for.
- `--json` — one JSON document on stdout.

Run by anyone but the owner at a terminal, `team migrate` records that card, waits for the signed answer, and continues. The owner at a terminal runs it with no extra flags.

## See also

- [team import](import.md) — replace the registry's record when a leftover file differs
- [team config](config.md) — edit the team after it lives in the registry
- [Owner-seat approval](up.md#owner-seat-approval-no-owner-terminal)
