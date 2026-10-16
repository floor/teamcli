# team

Ship with a team that never sleeps. Specialized agents, from any lab.

`team` is a command-line tool with no runtime dependencies. You set the roster, the agents do the
work, and you stay the one who decides. A project's team lives in `.agents/team.yaml` — the seats,
the model each one runs, the rules it follows, the folders it may touch; `team init`, or an agent,
writes it for you. The commands check that file against the machine and start and watch the team.
The live file is what they read. It runs the team in
[herdr](https://herdr.dev), and Node 22 or later runs it.

## Install

```sh
npm install -g team
```

The launcher `@teamcli/cli` installs the same tool:

```sh
npm install -g @teamcli/cli
```

## Start

In your project's git repository, from the owner's terminal:

```sh
team init                # writes .agents/team.yaml: one seat, and comments to edit
team doctor              # what this machine still needs
team up                  # starts the session and its seats
```

Edit `.agents/team.yaml` after `init`: the comments it writes name every field, and
the file stays private to your clone (it goes in `.git/info/exclude`, never `.gitignore`).

## What it needs

- Node 22 or later, and [herdr](https://herdr.dev), the terminal multiplexer the team runs in.
- Each seat's CLI, installed and signed in: Claude Code, Codex, Cursor, Antigravity or Grok. `team doctor`
  says what is missing; `team doctor --login` checks the sign-ins read-only.
- The owner's terminal, outside herdr, for `up`: it reads the processes above the
  call and refuses a seat — or an agent-run CLI — that makes it. That guards against a mistaken
  agent, not a hostile one; a seat that forges the owner's placement is a known limitation, being
  hardened.

## Links

- The site: [teamcli.io](https://teamcli.io)
- The full README, and the command reference: [github.com/floor/teamcli](https://github.com/floor/teamcli#readme)
- Changelog: [CHANGELOG.md](https://github.com/floor/teamcli/blob/main/CHANGELOG.md)
- Upgrading from an earlier release: [UPGRADE-0.3.md](https://github.com/floor/teamcli/blob/main/UPGRADE-0.3.md)
- RFC 000, what the project stands on: [floor/teamcli discussion 147](https://github.com/floor/teamcli/discussions/147)

## License

MIT, see [LICENSE](https://github.com/floor/teamcli/blob/main/LICENSE).
