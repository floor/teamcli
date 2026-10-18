# teamcli

The same tool as [team](https://github.com/floor/teamcli), under its other name.

`@teamcli/cli` installs the `team` command, and `teamcli`, the same command under the package's
name. npm refuses the bare package name as too similar to another package's, so the package is
scoped; the tool itself is the `team` package, installed with it. A project's team lives in
`.agents/team.yaml` — the seats, the model each one runs, the rules it follows, the folders it may
touch — and the commands check that file against this machine and start and watch the team. It
runs the team in [herdr](https://herdr.dev), and Node 22 or later runs it.

## Install

```sh
npm install -g @teamcli/cli
team --version
```

Then, in your project's git repository, from the owner's terminal outside herdr:

```sh
team init     # writes .agents/team.yaml: one seat, and comments to edit
team doctor   # what this machine still needs
team up       # starts the session and its seats
```

The file stays private to your clone; `init` puts it in `.git/info/exclude`, never `.gitignore`.

## What's new in 0.5.0

The first release since 0.3.5. The full list is in
[CHANGELOG.md](https://github.com/floor/teamcli/blob/main/CHANGELOG.md).

- **The registry, and `team register`.** The machine records the agents, teams and projects it
  has seen, and a seat that is already running is written in without a relaunch, so the other
  commands can address it by name.
- **Permissions, the owner's.** Send is denied by default. `team grant` records what a seat or a
  team may do and `team delegate` what a pane outside the team may run; `team revoke` takes
  either back, a create-grant admits a runner outside herdr on the paths it covers, and the gates
  fail closed.
- **Native delivery.** A send walks the receiving seat's delivery order — `native`, `mcp-inbox`,
  `typed`. This build goes by the drop file and one trigger line and opens no socket, and records
  the legs it could not take. `team route` answers the address a sender's own cross-session tool
  uses, and `team send --record` writes that delivery down.
- **Projects.** A team names the project it sits in; `team projects` lists them, `team status
  --project` covers one project's teams, and settings inherit entity, project, team, seat.
- **Seat state.** `team seats` gives each seat a state and the source it was read from, a blind
  seat is called blind, and the pane's sidebar lines are the file's own text.

## Documentation

- The site: [teamcli.io](https://teamcli.io)
- The README and command reference: [github.com/floor/teamcli](https://github.com/floor/teamcli#readme)
- One page per command: [docs/commands](https://github.com/floor/teamcli/tree/main/docs/commands)
- The team file: [docs/team-file.md](https://github.com/floor/teamcli/blob/main/docs/team-file.md)
- Changelog: [CHANGELOG.md](https://github.com/floor/teamcli/blob/main/CHANGELOG.md)
- Upgrading to 0.5.0: [UPGRADE-0.5.md](https://github.com/floor/teamcli/blob/main/UPGRADE-0.5.md)

## License

MIT, see [LICENSE](https://github.com/floor/teamcli/blob/main/LICENSE).
