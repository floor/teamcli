# team projects

Lists the projects this machine's registry holds, from `~/.config/team/projects.yaml` (mode
`0600`, under `~/.config/team/` beside the team records). A project is the layer above a team: its
immutable id, the display name people and team files use for it, the entity it belongs to, its
lead, and the IDs of the teams that sit in it. The lead is the seat whose role holds the `leads`
capability — an agent ID, never a role-name string.

## Synopsis

    team projects [--json]

## What it reads and writes

Reads `~/.config/team/projects.yaml`, a map of project IDs to records:

    projects:
      teamcli:
        name: TeamCLI
        entity: floor
        lead: agt_2b9f
        teams: ["1a2b3c4d5e6f", "6f5e4d3c2b1a"]

A missing file is no projects — every team is its own project — and prints `(no projects)`. A
file that does not read as a project registry (not a map with a `projects` key, a project without
a name, a provenance that is not a map of three instants) is refused with the file's path and what
is wrong; nothing is listed. Reads no team file and needs no caller. Writes nothing.

The project level's other view is `team status --project <name>`, which covers every team the
project names; the teams of one project are read there. `team send --list` prints each seat's
project in the roster, the registry's grouping when the machine has one and the team's own
`project:` name otherwise.

## Who may run it

Anyone may run it, from any folder.

## Exit codes

| Outcome | Exit | Printed |
| --- | --- | --- |
| listed | 0 | one line per project — id, name, entity, lead and teams — or `(no projects)` when the file names none; `--json` prints one document instead |
| unreadable | 1 | `team: <path>: <what is wrong>` on stderr |
| usage | 2 | `team projects: <message>` and the usage on stderr |

## Examples

On a machine that has never registered a project, there is nothing to list:

```console
$ team projects ; echo "exit $?"
(no projects)
exit 0
$ team projects --json ; echo "exit $?"
{
  "format": 1,
  "projects": []
}
exit 0
```

A registry with two projects — the one this project belongs to, and one whose entity and lead are
not recorded — prints one line per project, shorter values padded:

```yaml file=../../.config/team/projects.yaml
projects:
  beacon:
    name: Beacon
    entity: acme
    lead: null
    teams: ["7a8b9c0d1e2f"]
    provenance: { registered_by: team, registered_at: "2026-10-05T04:00:00.000Z", updated_at: "2026-10-05T04:00:00.000Z" }
  teamcli:
    name: TeamCLI
    entity: floor
    lead: agt_2b9f
    teams: ["1a2b3c4d5e6f", "6f5e4d3c2b1a"]
    provenance: { registered_by: team, registered_at: "2026-10-05T04:00:00.000Z", updated_at: "2026-10-05T04:00:00.000Z" }
```

```console
$ team projects ; echo "exit $?"
  beacon   Beacon   acme   -         7a8b9c0d1e2f
  teamcli  TeamCLI  floor  agt_2b9f  1a2b3c4d5e6f, 6f5e4d3c2b1a
exit 0
```

`--json` prints the records themselves — ids and provenance included — as one document:

```console
$ team projects --json ; echo "exit $?"
{
  "format": 1,
  "projects": [
    {
      "id": "beacon",
      "name": "Beacon",
      "entity": "acme",
      "lead": null,
      "teams": [
        "7a8b9c0d1e2f"
      ],
      "provenance": {
        "registered_by": "team",
        "registered_at": "2026-10-05T04:00:00.000Z",
        "updated_at": "2026-10-05T04:00:00.000Z"
      }
    },
    {
      "id": "teamcli",
      "name": "TeamCLI",
      "entity": "floor",
      "lead": "agt_2b9f",
      "teams": [
        "1a2b3c4d5e6f",
        "6f5e4d3c2b1a"
      ],
      "provenance": {
        "registered_by": "team",
        "registered_at": "2026-10-05T04:00:00.000Z",
        "updated_at": "2026-10-05T04:00:00.000Z"
      }
    }
  ]
}
exit 0
```

An argument the command does not take is the usage:

```console
$ team projects extra ; echo "exit $?"
team projects: unexpected "extra"
Usage: team projects [--json]

Run from any folder. Lists the projects this machine's registry holds: each project's id, name,
entity, lead and teams. The lead is the seat whose role holds the leads capability. Reads the
registry and changes nothing.
exit 2
```
