# Moving to 0.5.5: run `team migrate` in each project

0.5.5 finishes moving the team's definition out of the project. The team lives in the registry
(`~/.config/team/team-config/`), and `.agents/team.yaml` is no longer read, so there is nothing to
keep in sync.

## In each project

From a terminal outside herdr, in the project's checkout:

    team migrate

It imports `.agents/team.yaml` into the registry, reads it back and compares canonical records,
and then moves the file to the system Trash (or renames it to `.agents/team.yaml.migrated` when
no Trash can be reached). It never deletes it. `team migrate --dry-run` shows what it would do;
`team migrate --keep-file` imports and leaves the file where it is.

If you skip this step, the first `team up` you run imports the file for you and says so; the file
then stays until you run `team migrate`.

## Approval

An approval made on 0.5.5 is signed over the team's canonical record, not the file's text, so it
stays in force across the move. Two changes earlier in 0.5.5 can still ask you to approve again,
once:

- the default session is now `<entity>-<project>` for a team that names an `entity` and no
  `session:` — `team check` names the move; approve again, or set `session:` to keep the old name;
- approvals signed before canonical signing verify through a compatibility path; the next
  approval is written in the canonical form.

## Editing the team

The editor commands you already use (`team add`, `team remove`, `team rename`, `team tempo`,
`team grant`, …) edit the registry's record. Everything else the file held is edited with one
command:

    team config get seats.lead.model
    team config set watch.unread_after 15m
    team config unset seats.lead.label
    team config edit        # the whole record in $EDITOR, validated before it is written

Every write is validated, is the owner's, and names what the approval no longer covers.

## A leftover file

`team up`, `team check` and `team status` print one line when a `.agents/team.yaml` is still in a
project whose team is in the registry; run `team migrate` to retire it. A leftover that says
something else than the registry is a difference, and `team import` replaces the registry's record
with it if that is what you want.

## Legacy

`team-config.source: file` and `--file` still read a team file. They are deprecated, kept for
tests and snapshots, and will be removed in a later release.
