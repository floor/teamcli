# team peek

Prints the last lines of one seat's screen — 50 by default. It reads and never sends: no text, no
key and no turn are typed into any pane.

The seat is asked for by name and resolved from the team's file; a raw pane id is not a name. The
screen comes through the terminal host's read-only status source on the team's own session. A seat
the file does not declare is refused, and so is a seat the file marks `human: true`: the owner's
pane is never read. A seat whose state record names no pane, or whose screen cannot be read,
prints nothing.

## Synopsis

    team peek <seat> [--lines <n>]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--lines` | a whole number from 1 to 500 | how many of the screen's last lines to print; 50 when absent. Anything else is an invocation error, never a truncated screen |
| `--general` | a general grant file | the dispatcher's door: a general grant the owner signed over every entity and covering `peek` (or every op, `*`) runs the command as the owner |
| `--key` | a client key file | the key the general grant is verified with; required with `--general` |
| `--help`, `-h` | — | the usage, and exit 0 |

## What it reads

Reads the team file in the current folder and the team's state beside it, then the recorded pane's
screen. It writes nothing but the audit line below: no file, no state, no drop, and nothing into
the session the screen belongs to.

The pane is the one the state records for the seat, `sessions[<session>].seats[<seat>].pane`. A
state record that cannot be read, a seat with no recorded pane, a host where no screen reader
stands, and a read that fails are all `peek.no-screen`: the command names no screen it cannot
prove.

The printed lines are the last `<n>` of the screen as the host reports it, without the one empty
tail a trailing line break makes. Masking never changes that count.

## What masking covers

Every row passes the same judgement the team-file secret check makes, applied to the screen's own
shape. A known key prefix, a private-key header, a URL's userinfo and a random-looking word each
become `[masked]`. A screen wraps a token in whatever punctuation the program printed, so a prefix
is matched wherever it sits, even beside other characters, and a line is re-scanned until no known
shape survives.

A terminal also wraps long text: the rows are read joined as well, each row taken between the
whitespace around its own text, and a row join is a token boundary exactly as a line start or end
is. A credential a wrap split over two rows is masked on both rows, including the whitespace the
wrap removed. The row count never changes. A bare hex string looks like a commit id: it cannot
clear the randomness threshold, so a sha is printed as it is, and a UUID usually is not masked
either. A long hex run is masked only where a row join falls inside it.

## Who may run it

The owner; a seat the team's state records on the pane the call stands on; or a pane the file's
`delegates` section names. Every other caller is refused with one sentence and learns no detail.
With dev mode on, the same caller the other dev-mode lifts admit is let through: the warning is
printed and the audit line written as everywhere else. A general grant covering `peek` reaches the
command through the dispatcher's door, which makes the run the owner's.

The owner's pane is refused whatever admits the caller: a seat the file marks `human: true` is
never read, admitted or not. A name the file does not declare is an unknown seat, not an empty
screen.

## The audit line

Every attempt after the team file loads is written to the team folder's log. A success names the
caller, the project, the seat and the line count — `team <project>: seat <seat>, <n> lines` — and
a refusal names the caller and the exit id — `refused peek.owner-pane: seat <name>`, for one.
The screen's text is never logged. A refusal before the file loads — a bad invocation, or a file
that will not read — writes no line, because there is no team folder to write it in.

## Output and exit codes

The printed screen is the whole of a success's output: stdout carries the masked lines and nothing
else.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the screen was printed | its masked lines on stdout | 0 |
| the team declares no seat by that name | `team peek: no seat named "<name>" in this team` | 1 |
| the named seat is a person's pane | `team peek: "<name>" is the owner's pane, and the owner's pane is never read` | 1 |
| the caller is not the owner, a placing seat, or a named delegate | `team peek: this team is not yours to read` | 2 |
| no screen is readable: no pane is recorded, no reader stands, or the read failed | `team peek: no screen is readable for seat "<name>"` | 2 |
| the team file can't be read | `team peek: <problem>` | 2 |
| the invocation can't be read, including a `--lines` value outside 1 to 500 | `team peek: <problem>`, with the usage | 2 |
