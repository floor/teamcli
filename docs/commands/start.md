# team start

`team start` is the first-run path for an admitted owner. Run it from a terminal outside a team
session, in the folder that will hold the team. A general grant never admits this command. The
grant refusal says: `only the owner runs team start, from a terminal outside a team session; a
general grant never admits it`.

```
team start
team start --json
```

The command reads the current folder and the account’s existing records. An empty account stops
at bootstrap, exits 1 and writes nothing. This command does not perform first-run admission or
create owner or grant records; those belong to first-run admission.

With an admitted owner, the pass looks for two signed-in CLIs for its preset. It checkpoints
completed steps in `.agents/start.json`, creates `.agents/team.yaml` once, and records the created
team’s root as running in the team registry. It then attempts initialization, launch and the first
task exchange. A later run resumes at the first unfinished step; it does not replace an existing
team file. An incomplete pass can already have written setup files.

If the folder already holds a team without a recorded preset step, the command refuses with
`team start: this folder already holds a team; run team up`. A caller inside a team session is
refused with `team start: only the owner starts a team on this account`. Links and non-regular
files at the setup paths, or links in their checked parent folders, are refused with `team start: setup files refused: <reason>`.

`--json` prints the step proof and elapsed times as one JSON document. Without it, the closing
line is `team start: started` or `team start: a step is not done` on standard error. The command
exits 0 only when all completion proof is present, 1 for an incomplete or refused pass, and 2 for
an unreadable invocation. There are no other flags or positional arguments.
