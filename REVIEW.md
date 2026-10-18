# Reviewing a change to team

`team` drives live panes, writes files other agents read and answers in exit statuses and JSON.
A wrong status or a line that overstates what happened is a defect here, not a polish item: the
caller is usually a program, and it acts on what it reads. [CONTRIBUTING.md](CONTRIBUTING.md)
covers the mechanics of a change. A weakness is reported in private, as [SECURITY.md](SECURITY.md)
says — never in a public review, issue or pull request.

## What failure looks like in TeamCLI

Read for these bug classes. Every finding names the class it belongs to.

- **A command that types into a human's pane.** A seat the file marks `human: true` is a person's
  pane. No command types into it, sends it a frame, presses a dialog key, launches over it or
  closes it — and no path reaches it another way, through the daemon, the queue or the launch
  record.
- **An exit status or JSON document that says something other than what happened.** A refused run
  exits 1, a run that cannot start exits 2, and `--json` carries the same facts as the text: no
  field says `ok` on a run that failed, and no exit 0 covers a write that did not land.
- **A line that claims more than the run did.** A delivery is `delivered` only when it was
  delivered, `delivered (read)` only when the seat read it, and a fallback says which leg was
  given up and why. A report names no pane, seat or record it did not read.
- **A package that reads a file it doesn't ship.** The npm tarball carries `dist`, `examples`,
  `schema` and two root files. A path that exists in a checkout does not necessarily exist in an
  install, and a file built for one target (the README npm renders, for instance) is not a file
  the command may open at run time.
- **A refusal that names the wrong actor.** A refusal says who may do the thing and which seat
  can fix it; `who:` in a difference points at the branch's owner or the seat holding the right.
  A wrong name sends the fix to the wrong place, or to no one.
- **A state file read as fact.** The state file (`.agents/team.state.json`) is not signed:
  anything can write it. A command adopts, removes or relaunches on a record only after checking
  it against the live pane, and a record it cannot confirm stops the command instead of being
  trusted.
- **One rule with two implementations that disagree.** When an exit code, a refusal, a page
  sentence or a default lives in more than one place, a change that moves one moves them all. The
  contract rows, the generated schema and the docs examples exist to make the copies disagree in
  CI rather than at a user's terminal.
- **A value that reaches a shell or herdr as syntax.** A seat name, a path, a launch line and a
  message body are data. They reach a shell or a pane wrapped and quoted as one value; nothing
  interpolates a name into a command line that a shell then reads as more than that value.

## Writing a finding

A finding is a defect, not a preference. Say what breaks, for whom, and give the evidence:

- **Where**: `path/to/file.ts:42`, a line a reader can open. A finding that points at a whole
  file is not yet a finding.
- **Class**: one of the classes above.
- **Scope**: *this change* or *pre-existing*. A pre-existing bug is labelled separately and does
  not hold this change unless the change makes it worse or depends on it.
- **Nit**: at most three nits in one review, each labelled `nit:`. A nit never blocks a merge;
  say it once and move on.

Put the change's own findings first and pre-existing bugs after them.

## The review loop

- **Three rounds at most.** Round 1 reads the change and the files it touches; round 2 reads the
  diff again against round 1's answers; round 3 is the last.
- **After round 2, read the diff only** — not the whole tree again, unless the diff can only be
  judged beside something it did not touch.
- **A fourth round is not a fourth patch.** If the same place is still breaking in round 3, the
  approach is the finding: question the design and send the change back, rather than asking for
  one more patch.
- **Never repeat a finding.** Once answered it stays answered; a regression is a new finding with
  new evidence.
- **Every finding is answered before merge**: fixed in the change, or declined with a reason in
  the pull request. Silence is not an answer, and neither is a thumbs-up with no words.
- **A review is not an approval without a `bun run ci` on macOS on the exact head**, quoted with
  its exit status and final line, as [CONTRIBUTING.md](CONTRIBUTING.md) sets out.
