# team

Ship with a team that never sleeps. Specialized agents, from any lab.

`team` is a small command-line tool with no runtime dependencies: you set the roster, the
agents do the work in [herdr](https://herdr.dev) panes, and you stay the one who decides.
It is early and herdr only. Every command `team --help` lists is here. Node 22 or later runs it.

- **Any model, in any seat.** Put the right agent from any lab on each role, and swap it without rewriting the team.
- **Safe by design.** Agents move fast inside the envelope you set, and stop at its edge.
- **The watch tells you.** It reports idle seats and nudges the operator.

## Install

```sh
npm install -g team
```

## Your first team in five minutes

```sh
mkdir hello && cd hello && git init
team init                  # writes .agents/team.yaml, private to this clone
$EDITOR .agents/team.yaml  # name your seats; any CLI fits any role
team doctor                # what this machine still needs
team up --dry-run          # every command it would run, and every refusal
team up                    # starts the session and its seats
```

The file stays private to the clone: `team init` keeps it out of git in `.git/info/exclude`,
never by editing `.gitignore`. `team init --restore` brings back the copy this machine stored.
Read a file you receive before you run `team up`.

## The few ideas

**The team file.** `.agents/team.yaml` holds the roster and the owner's sections — `budgets`,
`trust`, `grant`, `delegates`. It is private to each clone, and the commands read it as the
record. The whole format is in
[the team file](https://github.com/floor/teamcli/blob/main/docs/team-file.md).

**Seats.** A seat is one role, one model, one launch command, in its own pane. Any CLI fits any
role: `vendor`, `model` and `version` name what it runs, `count` adds instances, and `parked`
or `stopped` keeps it out of reports or out of `up`. Swap a seat by editing the file.

**Owner, grants, policies.** The owner is a person at a terminal outside herdr. Only the owner
grants rights: `team grant` and `team delegate` record what a seat or pane may do, `budgets`
and `trust` set what it may spend and reach. Agents move inside that envelope and stop at its
edge. Approvals guard against mistakes, not against a hostile process running as the owner.

## The commands you'll use

| Command | What it does |
| --- | --- |
| [`team init`](https://github.com/floor/teamcli/blob/main/docs/commands/init.md) | writes the team file |
| [`team doctor`](https://github.com/floor/teamcli/blob/main/docs/commands/doctor.md) | checks this machine against the file |
| [`team up`](https://github.com/floor/teamcli/blob/main/docs/commands/up.md) / [`team down`](https://github.com/floor/teamcli/blob/main/docs/commands/down.md) | starts or stops the session and its seats |
| [`team status`](https://github.com/floor/teamcli/blob/main/docs/commands/status.md) | the file against the running session, each difference with its repair |
| [`team seats`](https://github.com/floor/teamcli/blob/main/docs/commands/seats.md) | each seat's state, and where it was read |
| [`team send`](https://github.com/floor/teamcli/blob/main/docs/commands/send.md) | one message to one seat, with a delivery report |
| [`team drops`](https://github.com/floor/teamcli/blob/main/docs/commands/drops.md) | the messages waiting for this seat |
| [`team watch`](https://github.com/floor/teamcli/blob/main/docs/commands/watch.md) | reports idle seats and nudges the operator |
| [`team register`](https://github.com/floor/teamcli/blob/main/docs/commands/register.md) | writes the record for a seat that is already running |
| [`team next`](https://github.com/floor/teamcli/blob/main/docs/commands/next.md) | claims the next task; `team plan` shows the queue |
| [`team check`](https://github.com/floor/teamcli/blob/main/docs/commands/check.md) | reports the differences, each with its repair |

Every command, flag, refusal and exit code is in
[the command reference](https://github.com/floor/teamcli/blob/main/docs/commands/README.md).

## What's new in 0.5.5

0.5.5 moves the team's definition out of the project and into the registry
(`~/.config/team/team-config/`). Run `team migrate` once in each project: it imports
`.agents/team.yaml`, verifies the import, and moves the file to the Trash (`--keep-file` keeps
it). From then on, `team config get|set|unset|edit` edits the team. Approvals are signed over
one canonical team record, so they stay in force across the move. See
[UPGRADE-0.5.5.md](https://github.com/floor/teamcli/blob/main/UPGRADE-0.5.5.md).

A team that names an `entity` and no `session:` now runs in the session `<entity>-<project>`;
`team check` names the move, and the team is approved again once.

Clients gain the `observer`, `operator`, `manager` and `developer` grant bundles, replies through
`team reply` and `team messages --client`, and a pane guard that refuses client commands inside a
team pane. A seat stopped at a usage wall reads as `blocked: quota`, and `team pause` can pause one
seat.

Downgrading to 0.5.3 after a team has been migrated is NOT supported: 0.5.3 reads only the file.
Keep the file with `team migrate --keep-file` if you may need to go back.

The full list is in [CHANGELOG.md](https://github.com/floor/teamcli/blob/main/CHANGELOG.md).

## Learn more

- [The team file](https://github.com/floor/teamcli/blob/main/docs/team-file.md) — the format by example, then every section field by field.
- [The command reference](https://github.com/floor/teamcli/blob/main/docs/commands/README.md) — every command, flag, refusal and exit code.
- [Upgrading to 0.5](https://github.com/floor/teamcli/blob/main/UPGRADE-0.5.md) — from 0.3.5 or 0.4.x.
- [Moving to 0.5.5](https://github.com/floor/teamcli/blob/main/UPGRADE-0.5.5.md) — run `team migrate` once in each project.
- [Security](https://github.com/floor/teamcli/blob/main/SECURITY.md) — report a weakness in private.

The project is TeamCLI; the site is [teamcli.io](https://teamcli.io) and the founding text is
[RFC 000](https://github.com/floor/teamcli/discussions/147).

## License

MIT
