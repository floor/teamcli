# team projects

Lists the projects this machine's registry holds, from `~/.config/team/projects.yaml` (mode
`0600`, under `~/.config/team/` beside the team records). A project is the layer above a team: its
immutable id, the display name people and team files use for it, the entity it belongs to, its
lead, and the IDs of the teams that sit in it. The lead is an agent ID — never a seat or a role
name. It comes from the lead team: a team says it leads the project it sits in with
`project_lead: true` beside `in_project:`, one team per project, and the record's lead is the agent
of that team's own lead seat — the seat its file marks with `leads: true` — re-resolved on every
launch, so a mark that moves in the file moves the record with it. A file that stops claiming
`project_lead`, or stops naming the project, clears the lead it set — only while the lead on record
is one of that team's agents — so an agent the team no longer leads with is not left admitted as
the project's lead.

The hierarchy is entity, then project, then team, then seat, and the project level is where
settings start: they inherit entity, then project, then team, then seat — a lower level may
tighten, and loosen only where the level above allows it.

A team names its project in its team file, `in_project`, holding the project's display name;
today's `project:` field keeps meaning the team, so every file written before this build loads
unchanged, and a team that names no project is its own project. A team belongs to one project at
most: when the registry names a team in two, [`team check`](check.md) refuses it, naming both
projects, and the repair is the registry file; and a file that sets `project_lead: true` without
naming a project is refused as the file loads.

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

The ID is the display name lowercased, every run of characters outside letters, digits, `.`, `_`
and `-` written as one `-` and nothing left at either end: `TeamCLI` is `teamcli`, `Team CLI` is
`team-cli`. It is minted when the project is first written and never moves: a rename writes
`name`. The registry sits beside the agent and team records, all three described in
[the registries](../concepts/registry.md).

A record may also carry `liveness` — the windows by which its teams report an idle seat and count
it blind: `idle_lead_seconds`, `idle_owner_seconds` and `blind_after_seconds`, each a positive
number of seconds. A project tightens them for every team in it; the blind window alone it may
also open again, and a team inside may close it again. Any other longer word is set aside where
the thresholds resolve, and the value in force stands. Omitted, each keeps the shipped default —
five minutes to the lead, fifteen to the owner, five to blind. The levels above a project have
their own surfaces: the machine's `~/.config/team/settings.yaml` and the entity's `entities.yaml`
entry, each under `liveness`.

A record may also carry `sender_name` — how a sender from its teams reads in TeamCLI's own
headlines: `auto` (the default when the record declares none), `nickname`, `seat` or `seat@team`.
The word is presentation only: every signed record keeps the seat in `from` and the registry id in
`from_id`, and the machine readings keep the record's own fields. A team file's own `sender_name`
key and a seat's sit nearer in the chain than this word; a seat's reading resolves its own key
first, then its file's, then the project's. Any word outside the four is refused when the registry
is read, naming the four the record may carry.

A missing file is no projects — every team is its own project — and prints the table header and
`0 projects`. A
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
| listed | 0 | the `ID  NAME  ENTITY  LEAD  TEAMS` table and `<n> project` / `<n> projects` (or `0 projects` when the file names none); `--json` prints one document instead |
| unreadable | 1 | `team projects: the project registry cannot be read: <what is wrong>` on stderr |
| usage | 2 | `team projects: <message>` and the usage on stderr |

## Examples

On a machine that has never registered a project, there is nothing to list:

```console
$ team projects ; echo "exit $?"
ID  NAME  ENTITY  LEAD  TEAMS
0 projects
exit 0
$ team projects --json ; echo "exit $?"
{
  "schema": {
    "name": "team.projects",
    "version": 1
  },
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
ID       NAME     ENTITY  LEAD      TEAMS
beacon   Beacon   acme    -         7a8b9c0d1e2f
teamcli  TeamCLI  floor   agt_2b9f  1a2b3c4d5e6f, 6f5e4d3c2b1a
2 projects
exit 0
```

`--json` prints the records themselves — ids and provenance included — as one document:

```console
$ team projects --json ; echo "exit $?"
{
  "schema": {
    "name": "team.projects",
    "version": 1
  },
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

Exits 0 when the projects are listed, 1 when the project registry cannot be read, 2 when the invocation can't be read.
exit 2
```
