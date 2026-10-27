# `team up`: rationale and known limits

What moved off [the `team up` page](../commands/up.md): the reasons behind the rules, what the run
reads and writes, the behaviour behind the records, the refusals in their own words, the repair
rules, and the limits. The synopsis, the flags, who may run it and the exit codes stay on the page.
The lines that begin with `-` are as they stood there.

## Starting state: a stopped session, the lobby, trust

Starts the team: the herdr session when it is not up, a workspace and a seat for every seat the file
declares and this machine can run, and the watch, in a workspace of its own. Seats already ready
are left as they are; a seat stopped in the file is left out until `team add` starts it. `--dry-run`
prints the plan and runs nothing.

A session stopped in herdr that this team's state records is cleared under the run lock, then
started from the beginning. A stopped session the state does not record is refused
(`session <name> is stopped`); that line names no herdr command. A recorded session that does
not clear is refused too (`session <name> is stopped and did not clear`).

Every seat, shared and worktree-mode alike, starts in the team's lobby, with one exception: a
lead, the seat the file names orchestrator or operator, starts in the project folder itself. The
team's lobby is the file's `lobby:`, else the lobby the registry recorded for this session, else
`<home>/.config/team/lobbies/<entity>` for a team that names `entity:`, else the machine-global
`~/.config/team/lobby`. Before creating anything, `team` verifies the
lobby gate:
ownership by the invoking user, no symbolic links anywhere in the chain, directory mode exactly
`0700`, nothing but the files the profiles the tool ships declare (claude-code declares
`.claude/scheduled_tasks.lock`), and not inside a git repository or worktree. The set is the
same for every team on the machine: what a lobby may hold cannot depend on this team's seats — a
lock another team's claude-code seat wrote must not block a team with no claude-code seat. Two
teams share a lobby only where they resolve to the same folder. The launch uses
that verified path. The lobby is checked again — the gate's checks, plus that it is still the
folder the gate read: the same canonical path, device and inode — directly before every
workspace this run creates in it, with nothing between that confirmation and herdr's create
call. Every declared file is confirmed with it, by `lstat` alone — `team` never opens one —
against everything a file created again under the same name cannot keep: the same device and
inode, size, inode change time and birth time, at nanosecond resolution, so a replaced file is
refused even where the filesystem hands the new file the old inode number. What can still slip
through a file's check: a rewrite in place inside one filesystem timestamp tick that changes
no size — every number the gate reads would be the same. A failed confirmation
creates nothing: the seat is left out with the gate's cause in words — the gate's own line, the
folders it resolved, is written under the record on stderr — and the rest of the
launch stops, so no further workspace is made, and the watch is not started. A seat created earlier
in the same run is left running: its workspace was created while the path was the verified
lobby, and `up` never closes a workspace it may already have started a CLI in. Another window
remains, inside herdr itself: the create call takes a path, not an open folder handle, so herdr
resolves that path in its own process after the confirmation.

A seat goes to its real folder itself: a worktree seat to the worktree its brief names; a shared
seat to its configured `cwd` before any project work.

The lobby is a folder no CLI has seen before, and `up` reads a trust question and never answers one:
a seat that stops there waits for its owner — at a terminal `up` keeps the seat's workspace,
records it waiting and asks with one prompt (below); a run without a terminal closes the workspace
without an answer and records `<seat>: left out: trust (no terminal for owner)`. Nothing is run
until the owner trusts the lobby once in that CLI. Then it starts.

## What it reads and writes

Reads the team file (or the one `--file` names), this machine's approval store, the session's state
(`.agents/team.state.json`, for each seat's stage), herdr (whether the session is up, its agents and
workspaces), the doctor's findings, and the machine's load, free memory, free disk, free swap and
the OS's memory-pressure level.
Writes `.agents/team.state.json` (each seat's stage, pane, workspace and the CLI it was launched
with; a waiting seat's classification, process identity and `manual` flag; the watch's pane, pid and
heartbeat; and, under the session's `briefs`, each seat's general-brief claim — its record id,
delivery time, incarnation, runtime epoch, sha256, attempt, stage and the ids it superseded), each
seat's general-brief record under `.agents/send-drops/<session>/<seat>/`,
`.agents/team.log`, the team's lobby folder (made if absent; every seat but a lead
starts in it), and, through herdr: the server, one workspace per seat at each seat's launch, and one
workspace and pane for the watch. A real run holds the session mutator lock
(`<state dir>/seat-locks/<session>/.run`), the one lock `up`, `add`, `down` and `remove` share, from
before its first effect to its end — its first effect being the make of an absent lobby, itself
under the lock, so two fresh runs cannot race their components. One session-mutating
run per session at a time, under a name no seat can have (a leading dot; `seat-locks` otherwise
holds one lock per seat, the launch's and `answer`'s). A second real run, delegated or not, stops
on it before the first step, with the refusals below; `--dry-run` takes no lock, makes nothing and
still plans.

## Who may run it

The owner, from a terminal outside herdr; and a seat this team's record marks `leads` — its
orchestrator, or a registry roster line that says `leads` — on this folder's own team file. A run
with no terminal is refused with ``only the owner or a `leads` seat runs this, from a terminal
outside herdr or its own pane`` and launches nothing. An admitted run that is not that owner — a lead's, the grant's, a delegate's, the
token's — never reads stdin and never prompts, so every dialog is left for the owner (below). `--dry-run` is open to anyone: it reaches nothing and
changes nothing, prints the refusals it would hit as `! up would refuse: …` above the plan. A caller
the run does not admit — not the owner, no grant, no delegate, no token — is refused with the word
`deny` alone on a real run: no reason, no plan, exit 1. Its `--dry-run` is never
denied: the same `! up would refuse:` line carries the placement reason, `! to unblock:` carries
the run that admits the caller — a `leads` seat's own, from its pane, or the owner's, from a
terminal outside herdr — and the plan follows when no `--file` or `--session` kept the file unread — a flagged target is read on the real run's own terms, never to fill a plan.
A dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch). It returns before these real-run failures, and never takes their status:

- `up.no-launch`, this call has no way to reach herdr (`src/commands/up.ts:1176`)
- `up.run-lock`, another run holds the session (`src/commands/up.ts:1190`)
- `up.lobby`, the lobby could not be created (`src/commands/up.ts:1212`)
- `up.clear`, a stopped session this team records did not clear (`src/commands/up.ts:1228`)
- `up.pending`, a seat left short of ready; `up.server`, the server did not start; `up.watch`, the watch did not start (`src/commands/up.ts:1579`)

A pane of another session the approved file's `delegates` section names may run `up` when that
entry's `commands` list names it. The ordinary rule above refuses such a caller first, and only
then — the section is in the file — does the delegate gate decide, against the live file and the
approved copy, never a cached team: refused, the gate's own words replace the ordinary refusal
(same list, same dry-run line, same exit); passed, the run is the delegate's. The section is read
from the folder's own default file, never one the caller names: a delegated run never has
`--session` or `--file` — both are the owner's, the gate refuses them before the file or the
session they name is read, and a refused run answers in the gate's words without reading the
flagged target at all. A delegated run writes `delegate [delegate] <pane> up` to
`.agents/team.log` before its first effect — a dry run writes nothing. With no `delegates`
section in the default file none of this exists: the ordinary order, the ordinary refusal, the
same words, the same exit.

## What it prints

One record per seat, in the file's order, is the run's whole account of that seat:

    claude-keeper: ready
    claude-beacon: ready

A seat that reaches its idle prompt with its rules delivered prints `<seat>: ready`. A seat left out
prints `<seat>: left out: <what stopped it>` — a classification (`trust`, `permission`, `question`,
`vendor notice`, `login`, `unknown`, `unsent`, `timeout`) or the reason in the seat's own words, in
the table below. When the machine has load, memory and swap headroom, `up` launches seats and waits
on their idle prompts, renames and rules concurrently within the machine's capacity (`--serial`
forces one seat at a time, and a machine near its start limits falls back to one at a time on its
own). Whether seats run concurrently or one at a time, on a terminal the provisional line is drawn
as `<seat>: launching` and rewritten in place as seats advance — `waiting for its prompt`,
`naming`, `sending its rules` — and the final records, their stderr details and `.agents/team.log`
are emitted in declaration order. A
redirected stdout receives the final records only: one newline-terminated line per seat, nothing
provisional, no escape sequence. Everything else a run says about a seat — the indented detail
under the record, the `skip` line for a seat stopped in the file, a note, a timeout's last reading
and the pane's last lines — is written to stderr, after the record it belongs to; a seat on a CLI
with no launch profile prints the `left out` record above, on stdout. `watch: started` is on stderr
too.

A seat already ready is left as it is, and the words it was left with are the detail under its
record. Before that skip, when the seat has a pane and a workspace, the plan renames the workspace
to the file's title and reports the file's display line. A dry run prints both; a real run does
them and still does not type into the pane or launch the seat again. A ready seat the state records without its process identity, or with a start outside the
team's lobby, is left as it is too. The identity is recorded where the seat stands, without a
relaunch: `  already ready; left as it is; its process was never recorded: run team register <seat>
to record it, nothing relaunched` — for the lead's own seat too. A seat recorded with a process but
started outside the team's lobby is repaired by a relaunch, and its detail says so: `  already
ready; left as it is; a relaunch moves it into the lobby: team remove <seat> --keep, then team add
<seat> (or team down, then team up, for the whole team)`, or for a seat the file names as
orchestrator or operator, `team down, then team up (to restart the whole team)`; and a lead whose
process the state records, started in the project folder itself, is left with no relaunch note at
all — the project folder is home for a lead too.

A ready seat whose recorded process is still in its pane, and that pane is still named as the
seat, is read once while the plan is built. The model is taken the way `status` takes it. When
it matches the seat's record — the signed registry where there is one, the file otherwise — or
the screen names no model this version can read, the seat is left ready
exactly as above — an unreadable model is a note, never a cycle, the same convention as
`<seat>: its screen doesn't show a model this version knows; not checked` on a launch. When it
differs, and herdr reports the seat idle or done, `up` closes that workspace without input and
launches the seat again through its own `launch` line, resuming the conversation the pane's own
agent names where the CLI has a measured resume form — `--resume <id>` for Claude Code, `codex …
resume <id>` for Codex, `--conversation=<id>` appended to the launch line for Antigravity. A pane
that names no session, or one that is not the record's, launches
without a resume id. Nothing is typed, the seat is not renamed, and it
keeps its name. A box that holds unsent text does not stop the close. The record stays
`<seat>: ready`, and the detail says `  its model drifted; closed without input and launched
again`. A seat herdr reports working, or whose screen shows a running turn, is not closed: the
record stays `<seat>: ready` and the detail names the caller's own way, `  its model drifted;
left as it is (team remove <seat> --abandon)` for the owner, and `  its model drifted; left as
it is (run this again once herdr reports the seat idle or done)` for a delegate. A dialog on
that screen, or a screen this version does not classify, is left ready as well, with today's line. A seat the file names as orchestrator or
operator is never cycled this way; it keeps the whole-team line above.

A command run in a folder that is not a git repository reads `.agents/team.yaml` in that folder,
and nowhere above it. A link at `.agents` or at `team.yaml` is not followed. When `--file` names a
file a flagless watch in the project folder would not read, `up` still starts the watch, and the
command it runs carries no `--file`. The resolved path is recorded for the watch process. That
process may read it. Any other non-owner is refused. The command line and the plan do not print the path.

A seat is its pane while the process `team` launched is still in it, or while herdr names that
seat on the recorded pane and the agent session there is the one stored beside the launch. A seat
the state records whose pane is back at its shell is not "already ready": its workspace is closed
without a key and without input, and the seat is launched fresh with its rules. The seat's name
still being listed does not keep that pane. Its record is `<seat>: ready`, and the detail under it
says `  its pane held no CLI; closed without input and launched again`.

A pane that holds a program, and whose agent session is the one the seat's records bind (the
signed registry's, otherwise the state's), is the seat. Nothing is closed and nothing is typed
while it is working. The record stays `<seat>: ready`, the detail says
`  restored; left as it is`, and the stored process ids become the ones the pane holds now. A
model on that screen that differs from the seat's record is named on the same detail (`its model
drifted; left as it is`) and is not closed — unless the seat is idle or done and not a lead, where
the same close and relaunch as above repairs it, resuming the conversation the pane proves.

A pane that holds a program the record cannot tie to the launch — no stored agent session, a
different one, or an agent list that could not be read — is left as it is. Nothing is closed. A
ready seat's record stays `<seat>: ready` and the detail says `  its pane holds a process this
record cannot tie to the launch`. A seat that had not reached ready is left out with that reason.
The stored process ids are not rewritten.

The reading that decides the repair is taken while the plan is built, and the close can be minutes
later, after every seat before this one was created, waited for and delivered to. `up` reads herdr
again immediately before it, with nothing between those reads and the close, and closes only a pane
that is provably still the seat's stale shell: the agent list must name this seat on the recorded
pane, that pane's workspace as herdr reports it now must be the recorded workspace, that workspace
must hold no other panes (named or not), and the process reading must still say the pane runs no
CLI. A program in front is not closed: when its agent session is the stored one, the seat is
recorded ready under the pids the pane holds now; otherwise the seat is left out and the record
says the process cannot be tied to the launch. A pane held by another process that reads `working`
or `unsent` is never closed by `up`, whoever started it. A close for a drifted model asks one
thing more of that re-read: the process must still be the one `team` launched, the screen must
still name a different model, and the seat must still be idle or done with no running turn on its
screen. A model that now matches the file closes nothing and is not an error.
When any of that does not hold, nothing is closed, nothing is launched for that seat, its state is
left as it is, the seat is out of the run, and `up` exits 1 with one record:

| Record | When |
| --- | --- |
| `<seat>: left out: its pane is the seat's again; left as it is` | the pane now holds the recorded process — its owner restarted the CLI between the plan and the close. Not an error: the seat is skipped as ready and the exit code is unaffected |
| `<seat>: left out: its model matches the file again; left as it is` | a drifted seat's screen now names the file's model. Not an error: the seat is skipped as ready and the exit code is unaffected |
| `<seat>: left out: its model drifted; left as it is (team remove <seat> --abandon)` | the owner, and by the close the seat is working — herdr says so, or the screen shows a running turn. Nothing is closed |
| `<seat>: left out: its model drifted; left as it is (run this again once herdr reports the seat idle or done)` | a delegate, and by the close the seat is working. Nothing is closed |
| `<seat>: left out: the process in its pane is not the one team launched; nothing closed` | a drifted seat's process changed between the plan and the close |
| `<seat>: left out: its screen is not idle or done; nothing closed` | a drifted seat's screen is a dialog, or a screen this version does not classify, or herdr no longer reports it idle or done, and it is not the working row above |
| `<seat>: left out: herdr no longer shows this seat on its recorded pane; nothing closed; run team status` | the agent list no longer names the seat on the recorded pane, or that pane's workspace is no longer the recorded one |
| `<seat>: left out: its workspace holds other panes; nothing closed (close its pane there, then run team up)` | herdr's pane listing for the recorded workspace holds more than the seat's recorded pane |
| `<seat>: left out: the process in its pane is working; nothing closed (stop it there, or run team remove <seat>)` | a process team did not launch holds the pane and its screen reads `working` |
| `<seat>: left out: the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove <seat>)` | a process team did not launch holds the pane and its screen reads `unsent` |
| `<seat>: left out: its pane holds a process this record cannot tie to the launch` | between the plan and the close a program is in front, and its agent session is not the one stored at launch. Nothing is closed. Not an error |
| `<seat>: ready`, detail `  restored; left as it is` | between the plan and the close the pane's agent session is the one stored at launch. The stored process ids become the ones the pane holds now. Not an error |
| `<seat>: left out: its pane could not be read; nothing closed` | herdr can't give the workspace's panes, the pane's processes, or its screen reads as nothing this version knows |

This comparison is wrong in the safe direction, but it is wrong: a CLI that replaces its own
process — an updater that re-executes, a wrapper that hands over — changes the foreground pids, and
the seat then reads `restored, not launched by team` although nothing was restored. `up` closes
that pane without input and launches the seat fresh, and the conversation in it is lost. The record
holds every pid the launch left in front, and accepts the seat while **any** recorded pid is still
there; no reading of a CLI after its first message was taken when this record was made, though a
review's runs of a CLI with a helper beside it and of one behind a pipeline kept every pid. Before
running `up`, the owner looks: `team status` names such a seat, and the pane itself says whether
the CLI there is the one `team` launched.

When the workspace does not close, nothing is launched in its
place and the seat is left as it is:
`<seat>: left out: its workspace did not close; left as it is`, with `up` exiting 1. A seat with no `launched`
record in state (one launched before this version recorded process identity, or one whose process
herdr could not read when it stopped: the reading is taken once, after the idle prompt and after the
launch model check) keeps today's behaviour: nothing checks its pane.

When the idle screen names no model this version can read, `up` writes `<seat>: its screen doesn't show a model this version knows; not checked` to stderr, after the seat's record, and continues. It is detail, not a record: the log keeps the seat's one line, the record `ready`. Nothing is assumed about which model is running.

Before the plan lands anything, the seats whose launch this run owns — the seats it launches or
relaunches, and every declared seat the session records no launch of, a human's pane among them —
receive the general seat brief: TeamCLI's built-in default, embedded in the package (`src/launch/general-brief-text.ts`,
generated from the accepted source by `scripts/brief.ts --write`; `brief:check` pins its bytes, and
compares it with the source when one is given) so the package never reads a documentation checkout.
The delivery goes through `deliverBriefForAttribution` (`src/launch/general-brief.ts`), the one
boundary every attribution path calls. A delivery is a claim and a drop: `writeClaim` records the
seat's claim — a fresh incarnation and epoch for a seat this run attributes, the existing ones for
a seat it only broadcasts to, the expected record id, the brief's sha256, attempt 0 and
`stage: 'claimed'` — under the state lock before any file is written, and `deliverGeneralBrief`
then signs the record at exactly that id, reads it back and verifies it (`recordHolds`,
`src/send/record.ts`), and only then finalizes the claim's time and stage in the state. The id is
derived from the incarnation and the delivered body (`briefIdOf`), so a re-run of one lifetime
leaves a verified record and its first time as they are, and a reworded brief is a new message
under the same lifetime. A name held at the expected id by another regular file, a link, a folder
or a FIFO is never replaced, followed or removed: the delivery is reported and the recovery is
`team brief rollout --apply`, which posts the record at the claim's next attempt and leaves the
held name byte for byte. When this build's brief is ahead of any live or human seat's claim,
every live or human declared seat is targeted, the unattributed ones without a relaunch.

The claim's epoch is the runtime the launch hands the seat's reader: the launch line's
`team drops --read --epoch <run_id>` (and `team mcp serve --epoch <run_id>`) names it through
`currentBriefEpochs`, so a process started under an earlier runtime serves nothing until its seat
is launched again. A launch that ends short of ready leaves its delivered record on disk and its
seat record not ready; a receipt such a process wrote carries the pre-assigned epoch and
[`team check`](check.md) reports it as a provisional read (`a read happened before readiness; the
runtime is not confirmed`), never as a successful read. The session's `briefs` map is what the
check verifies to name a seat the session launched without a current delivery. A seat the
state records as already launched, and that this run leaves as it is, gets neither a drop nor a
state entry when its claim is current. A drop that
cannot be written is a line on stderr and in the log for that seat alone, and the launch carries
on: the record on disk is the message, and the check names the seat. Nothing is typed for the
brief, and `add`, `restart`, `reload`, `register` and `rename` deliver through the same boundary,
for the seat each acts on — `reload` on its matching path included, so the repair `team check`
names is a real one.

A seat whose rules travel as a first message (codex, cursor, antigravity) gets them from a file:
`up` writes the approved rules text to `<project state folder>/rules/<seat>.md` — owner-only,
mode `0600`, beside the approval store, never inside a worktree, the lobby or the project — and
types one line into the pane at an empty idle prompt:

    Read /home/owner/.config/team/demo-3f9c2a8e1d7b/rules/implementer.md (sha256 5e1d0a9c4b2f): your standing rules for this session; reply ready and wait for your brief.

The state folder is resolved from the **approved copy's** project name, through the one resolver
the writer, the line, the hash check before Enter, `status`, `doctor` and `remove` all use: a
project rename is not approval drift, and the line a seat is told to obey must name the file the
checks look at, not one resolved from the live file's new name.

The line carries the file's absolute path and the first 12 hex digits of its SHA-256, so the
seat — and the read-back — can tell exactly which text is meant. A path that holds whitespace or
a character outside letters, digits and `. _ / @ + -` is never typed: nothing is quoted or
escaped, and the report says the path can't be typed safely. The line is read back row by row —
every visible character in order, a row break allowed to stand for at most one space or nothing —
and only then is Enter pressed, once. A box that already holds exactly today's line (a run that
stopped after typing it) is verified and sent, never typed onto again. `up` never clears a box it
could not verify: a stop leaves the text where it is.

Under `--json` the run writes one `team.up` v1 document on stdout, its `schema` tag first:
`format`, `dry_run`, `status` (`dry-run`, or `ready` on a real run), `action_summary`, `project`,
`session`, `seats` — every name the file carries, once — and `notes`. A dry run's document is the
plan instead of the records: `action_summary` is `dry run: nothing was run`, and `plan` holds one
`{ step, seat?, detail, prefix? }` per plan line — a run step prefixed `+`, a skip `skip`, a wait
with none — with a folded warning leading as `{ step: "warning", prefix: "!" }` when there is one.
On a real run `action_summary` is the run's closing record — the last `<seat>: ready` line, or
`the team is ready` when the file has no seat to record — and the records before it travel in
`notes`. A refusal under `--json` writes a `team.error` v1 document on stdout instead — the
refusal's own `id`, its `message` and `repair`, and `rule` where the refusal carries one — and
stderr stays empty. The exit code is the same as without `--json`.

### Waiting for the owner

A seat that stops at anything that isn't idle and that `team` may not answer — `trust` under either
policy, `permission`, `question`, `vendor notice`, `login`, `unknown`, `unsent`, or the idle wait's
`timeout` — meets the pause when its owner runs `up` at a terminal. `up` keeps the seat's
workspace, records `waiting-owner` (with the classification and the process identity read at that
moment, in the same write), shows the provisional record

    claude-beacon: waiting for owner (trust)

and asks, exactly:

    claude-beacon is waiting at trust: [o] open pane, [s] skip seat, [q] stop cleanly

The ask waits at most the profile's idle timeout (90 s today). That bound covers a trust or
permission prompt too, including one re-read on each tick while the lead may answer it. When it
ends with no `o`, `s` or `q`, the seat is left exactly as it is — workspace and waiting record
kept, nothing focused, nothing closed — with `<seat>: left out: timed out after <n> s waiting
for an answer; left as it is`, and `up` goes on to the next seat. The next `up` asks again, with
the same cap. Pressing `o` spends the open-pane poll's own timeout and then starts a new ask.

`o`, `s` and `q` are the whole answer. One chunk is one key only when it is exactly one byte and
that byte is `o`, `s`, `q` or Ctrl-C; anything else — several bytes that arrived together (a paste,
a held key, an escape sequence) or any other byte — reprints the exact line and changes nothing,
and a chunk's first byte is never taken for its key. Every byte already pending on the terminal is
read and discarded directly before each prompt, and once more on the way out, so a key typed while
the previous poll ran, or a line typed before `up` was started, never answers a prompt it was not
meant for: only a key that arrives after the prompt is drawn counts. A Ctrl-C is `q`; an end of
input is not — a closed stdin leaves the seat exactly as it is, its workspace and its waiting record
kept, with `<seat>: left out: its input ended; left as it is` and exit 1, since closing on a
vanished terminal is the destructive reading. What remains possible on this runtime: a byte that
has not reached `node`'s stream when the drain runs — one the terminal itself still buffers, or one
arriving between the drain and the read — is read by the next prompt; the one-chunk rule keeps a
multi-byte paste from ever acting as a key there, and a single trailing byte of a paste split
across two reads can only be `o`, `s`, `q` or Ctrl-C, the four the owner could have pressed. The
record stays provisional while the prompt is open — the seat's one final record still comes later.
The seat lock is taken before each of resume, open, skip and close, and never held while the
owner's key or a poll is waited for, so `team answer` can take it in between.

`o` takes the lock, verifies the waiting pane is still the seat's recorded one and still holds the
recorded process, records `manual: true`, releases the lock, and focuses that seat's herdr pane
with `herdr agent focus` — it sends no key and no text, and a captured run on a pane holding typed,
unsent text left the text exactly as it was and only moved the focus. `up` then polls the pane at
the profile's idle poll interval for at most the profile's idle timeout (90 s today), re-taking the
lock and reading the state and the pane fresh at each poll. A screen that reads idle means the
owner finished the seat in the pane: `up` removes the waiting record and carries the seat through
its ordinary steps — renaming it if it needs renaming, delivering its rules, and recording
`<seat>: ready`. A screen mid-work keeps the poll running
to the deadline, with `manual` kept. A screen that reads anything else keeps `manual` and asks
again at once, under the new classification. The deadline also keeps `manual` and asks again as
`timeout`. `o` stays available after every re-prompt. `manual` is cleared only when this same `up`
makes the seat ready, or closes it with `s` or `q`.

`s` takes the lock and closes the seat's workspace without input — the workspace the multiplexer
returns for the pane just verified, never the workspace id the state stores when the two differ
(then nothing is closed, and the record is `<seat>: left out: its pane is in workspace <live>, not
its recorded <stored>; nothing renamed, nothing closed, the state as it was`). The workspace's
panes are read from herdr directly before the close, with nothing between that read and it, and it
is closed only when it holds the verified pane and no other agent pane: a workspace holding any
other seat's pane is never closed — `<seat>: left out: its workspace holds another seat's pane;
nothing closed (close its pane there, then run team up)` — and a pane whose process is no longer
the recorded one is left as it is, `<seat>: left out: left as it is: its process changed`. It
clears the seat's launch state — the `waiting` field with it — and records
`<seat>: left out: skipped by owner`.

`q`, and a Ctrl-C, closes without input every workspace **this invocation created** that is not
already ready, and clears those seats' state. Before each of those closes the agent list, the
workspace's panes and the pane's process are read again, directly before it, with nothing between
the last read and the close, and the workspace closed is the one herdr returns for that pane,
holding no other agent pane; a workspace whose pane's process is not the one this run started is
not closed, and its record is `<seat>: left out: left as it is: its process changed`. The herdr
session is stopped only when this invocation created it and it now holds no ready seat:
a session that existed before, and a ready seat, are kept. The watch is a process, not a seat. The current seat
and every later configured, non-stopped seat with no final record get, in file order,
`<seat>: left out: stopped cleanly`; earlier final records stay. The run exits 1.

A later `up` on a seat the state records waiting reuses herdr's one agent of that seat's name —
its pane and workspace, nothing created for it — verifies the current screen with a fresh read,
and enters the same pause, **before** the ordinary unnamed or wrong-name handling, while the host
still lists the recorded pane. A recorded pane the host no longer lists is replaced: a fresh
workspace is made, the seat launches, and one line says `<seat>: its recorded pane <pane> was gone
and was replaced`. When the host still lists the recorded workspace, that same line names it
(`; its workspace <workspace> was left`). The workspace is not closed. A pane the host still
lists is never closed or recreated. No agent of that name while the pane is still listed, or
more than one, is not a reason to launch again: nothing
is created, the record kept, and the final record is
`<seat>: left out: its waiting pane is gone` or
`<seat>: left out: herdr lists more than one agent of this name; left as it is`, with the team file's own repair under it on stderr —
`team down` then `team up` (to restart the whole team) for a seat the file names as its
orchestrator or operator, `team remove <seat> --keep` then `team add <seat>` (or `team down` then
`team up` for the whole team) for any other. A pane that still exists but no longer holds the
recorded process fails the same way, with `its waiting pane holds another process`. Neither
`team down` nor `team remove` answers a prompt, and neither touches an agent it cannot name: a
seat at a dialog is left running — `  skip <seat>: is blocked at a prompt, which \`team\` never
answers; left running` on stdout for `down`, `team remove: <seat> is blocked at a prompt, which
team never answers` on stderr and exit 1 for `remove` — and a pane holding an agent the state
doesn't record is left in place. The owner answers that dialog, or closes that pane, by hand first — then
the sequence the record names runs, and the next `up` handles the seat.

A waiting record is a hint of where to look, never an authority — the state file is in the project
and any seat can write it. Before a later `up` resumes, opens, skips or closes a recorded waiting
seat it proves, from fresh reads, that the pane is still this seat's: no other seat's record of
this session names that pane or that workspace (then it is refused, `<seat>: left out: the state
names one pane for two seats (<seat> and <other>); nothing renamed, nothing closed, the state as it
was`, and nothing is acted on); the multiplexer lists that pane with its agent unnamed or already
carrying this seat's name; the workspace's live label is the one this seat's launch gives it (what
`up` set when it created the workspace); and the pane's process is still the recorded one. A
waiting record with no process identity proves nothing: it is never resumed, opened, skipped or
closed from the record, and the run fails closed with `<seat>: left out: its waiting record has no
process identity`, the team file's own repair under the record on stderr, beginning with the
by-hand step first — answer or close its dialog in its pane for a pane the multiplexer lists under
the seat's name, close that pane for any other — then run `team down` then
`team up` (to restart the whole team) for a seat the file names as its orchestrator or operator, or
`team remove <seat> --keep` then `team add <seat>` (or `team down` then `team up` for the whole
team) for any other, to establish one by a run. A stored classification is validated on the state's
own read against the closed list above: anything else the file holds reads `unknown` in the record,
the log line, the prompt, `team status` and `team doctor`.

Under a `dialogs.trust` team grant in force for this project's team id (read fresh on every run), a seat waiting at `trust` is also re-read on a tick: every
prompt timeout and every return from `o` takes the lock and reads the state and the pane fresh,
and follows what they show — a seat `team answer` made ready in the meantime, the
`trust-sent-recovery` state it may have left behind (shown as
`<seat>: waiting for owner (trust sent; recovery required)`, with the same keys), or the screen's
own reading. `up` never invokes `team answer` and never sends a trust key.

An owner whose stdin is not a terminal never prompts: for each seat that meets a dialog on a fresh
launch it closes the workspace without input, prints `<seat>: left out: <classification> (no terminal for owner)`
and exits 1. A seat already recorded waiting is not closed by that run:
`<seat>: left out: a run with no terminal does not close a waiting seat; left as it is`, and its
workspace stays. The fresh launch's close makes the stop pass's own reads — the agent list, the workspace's panes and
the pane's process, directly before it, with nothing between the last read and it — and closes only
the workspace the multiplexer returns for the verified pane, holding no other agent pane; a pane
whose process is not the one the dialog was found with is left as it is (`left as it is: its
process changed`), its record kept — and a close that did not happen writes the seat's state back
so the next `up` reads it: the waiting record with the classification that stopped it, and the
process identity the seat's own records already carried (its `launched`), never the changed read
just made, which would bless the replacement. The next `up` then compares the pane against the
launch's identity and resumes or refuses by the rules above; a seat whose records carried no
identity gets the waiting record alone, and the next `up` refuses it for that missing identity
rather than adopting its named, idle pane or refusing the whole session over an agent the state
does not record. A seat stopped at the idle wait's `timeout` is not a dialog: that owner keeps the
ordinary `timeout` record and the detail under it.

A delegated run takes the no-terminal path above whatever its stdin is, terminal or not: it never
prompts, never focuses a pane, never sends a key or a text. Every dialog it meets is closed without
input and recorded `<seat>: left out: <classification> (no terminal for owner)` exactly as above,
and its idle wait's `timeout` is a dialog like any other stop for it — closed without input under
the same proof as every close here, never left at launched. The owner's runs are unchanged: at a
terminal the owner is asked, and without one the owner keeps the ordinary records above.

### Known limits

- The waiting proof is placement, and no more: the state file is in the project, and a process of
  the same user that writes its own pane, workspace and process identity into this seat's waiting
  record, renames the pane to this seat and relabels the workspace to match, passes every check
  above. What copying another seat's record cannot pass is that seat's own record: while the seat
  whose pane or workspace this was still has a record naming it, the pane is refused
  (`the state names one pane for two seats`), so the forger must also move that record — edit it or
  delete it — before the copy passes. The proof guards a mistaken or corrupted record, not a
  hostile process running as the same user; nothing here can tell the two apart, because nothing
  distinguishes them: the same user may do all of it by hand.
- The final read of the box and the pressing of Enter are two separate `herdr` calls. Something
  can change the pane in the gap between them; `team` reads the pane again right before the
  Enter, but it cannot make the two one action. Closing that needs a key herdr itself does not
  offer today.
- A row break may hide at most one space, and no read can prove what a pane folds into a break:
  the check requires every other visible character to match exactly, and refuses anything looser
  rather than guess.
- The file is read once more, without following a link, directly before the Enter — but a
  process of the same user can still replace the file between that check and the seat's read.
  The line carries the file's hash, so the seat, or the owner, can check what was read against
  what was meant.
- Every folder from `team`'s state root down to `rules/` is checked before it is used — but the
  check and the use are two calls, and a process of the same user can swap a checked folder for a
  link in the window between them, so a folder of the ladder, or the file itself, lands where the
  link points. The runtime this runs on offers no way to hold the checked folder open and create
  the next level through that handle, so the window stays open. What limits it: the write is the
  approved text and nothing else, through an exclusive no-follow temporary whose name no other
  process knows, the file is read back by its hash after the rename, and the line the seat
  receives carries the same hash — so whatever lands wherever it lands can always be checked
  against what was meant, and nothing but the approved text ever lands anywhere. The removal
  of a temporary seat's rules file walks the same checked chain as the writer, folder by folder
  and without following a link, before it unlinks anything — so its window is the writer's own
  and no wider.

A seat that doesn't get there prints its one record with what stopped it, and `up` exits 1. For a
seat whose wait ended without a prompt, the record is `<seat>: left out: timeout` (or the
ended-at-its-shell reason below), and the detail under the record, on stderr, carries the last
non-empty lines the pane showed — the launch line's own
echo first when it is within reach, six at most, every escape sequence and every control character
but the line breaks removed, each line cut to 200 characters with `…` — each on `  | `;
`  run \`team up\` again to resume it` names how the seat is finished.
A wait that runs out with the owner at a terminal is not left there: it meets the pause as
`timeout` and is the owner's to open, skip or stop (above); the recorded timeout and the detail
above are what a run without a terminal keeps.
Those lines go to the terminal only: the log file gets the record, never the screen's text. The
same holds for every folder the run resolves: a refusal's record holds the finding in words — the
start folder a launch line was looked for in, the lobby a failed confirmation names — and the
sentence with the folder is written under the record, on stderr, for this terminal alone. One line
per final record, in file order, plus the watch's own line — `watch: started`, or `watch:` and its
reason in words when it did not — is the whole of what the log gets: a defect in the seat's file,
or a note like the unread-model one below, is stderr detail and never a log line.

The records are what stdout gets; a line below that is not a record is written to stderr, after the
record it belongs to, as its meaning says.

| Line | Meaning |
| --- | --- |
| `<seat>: left out: trust (no terminal for owner)` | the CLI asked whether to trust the folder, and `up` never answers one; the run had no terminal to ask on, and the detail under the record says its workspace was closed without an answer and the seat left out. A run at a terminal asks its owner instead — the pause, above. A delegated run closes without input like this one, whatever its stdin |
| `<seat>: left out: permission (no terminal for owner)` / `<seat>: left out: question (no terminal for owner)` | a permission dialog, or a question, was left for its owner to answer; the run had no terminal to ask on, and the detail under the record says its workspace was closed without input and the seat left out. A run at a terminal asks its owner instead; a delegated run closes without input like this one, whatever its stdin |
| `<seat>: left out: vendor notice (no terminal for owner)` | the CLI shows a vendor notice its owner has to act on: a screen its profile captured as one — today, Codex 0.157.0's update screen. `team` never answers one, and treats it at least as strictly as a question: nothing is typed, the watch reports it, and delivery stops on it. The detail under the record says its workspace was closed without input and the seat left out, and adds `untested on <version>` when the CLI installed here is outside the range the notice was captured on — the reading itself is never made less cautious by a version. A run at a terminal asks its owner instead; a delegated run closes without input like this one, whatever its stdin |
| `<seat>: waiting for owner (<classification>)` | the provisional record drawn while the seat's owner is asked, at a terminal (the pause, above); it is rewritten in place when the classification changes, and is not the seat's final record |
| `<seat>: left out: skipped by owner` | the owner pressed `[s]`: the seat's workspace was closed without input and its launch state cleared, the `waiting` record with it |
| `<seat>: left out: stopped cleanly` | the owner pressed `[q]` (or Ctrl-C) at this or an earlier seat, and this seat had no final record: a workspace this invocation created for it — not already ready or closed — was closed without input and its state cleared |
| `<seat>: its recorded pane <pane> was gone and was replaced` / `<seat>: its recorded pane <pane> was gone and was replaced; its workspace <workspace> was left` | a later `up` found the seat recorded waiting and the host no longer lists that pane: a fresh workspace was made and the seat launched. The second line is that same line when the host still lists the recorded workspace: the workspace is named and not closed. A pane the host still lists is never this line |
| `<seat>: left out: its waiting pane is gone` / `<seat>: left out: its waiting pane holds another process` | a later `up` found the seat recorded waiting and the host still lists that pane but no agent of the seat's name, or the pane no longer holds the recorded process: nothing was created, nothing closed, the record kept; the repair under the record on stderr is the team file's own for this seat — `team down` then `team up` (to restart the whole team) for an orchestrator or operator, `team remove <seat> --keep` then `team add <seat>` (or the whole team) for any other — and the owner answers or closes by hand first when the seat sits at a dialog, or its pane holds an agent `team` cannot name (above) |
| `<seat>: left out: <reading>; its workspace did not close; left as it is` | the close of that workspace failed, with `<reading>` one of `trust`, `permission`, `question` or `vendor notice` — a run without a terminal closing it, or the pause's own close at the prompt: nothing claims it was closed, and the seat is left exactly as it was, its state kept — a later `up` resumes it |
| `<seat>: left out: runs <model> <version>; the file says <model> <version>; left at launched, not named. Add <flag> <id> to its launch, or correct the file's model and version` | the idle screen shows a different model than the file. The seat is not renamed and gets no rules; its pane stays open. The flag is that CLI's model flag, and the id is the one the profile maps to the file's model. When the profile knows no id, the line says `<id>` |
| `<seat>: left out: its pane has been back at its shell for <n> s and shows no CLI prompt; left at launched` | herdr's process info says the pane's foreground program is back at its shell through three full polls on end, four readings, the screen matches no CLI shape, and the launch line's own echo is visible on the screen. A pane read before the line arrived, one whose echo scrolled away, one whose program is slow to draw, or a herdr that can't say (no shell process info), is waited out to the deadline — the end is never inferred from the screen's text, and a single reading can never reach the three polls. The workspace is kept, and the pane's last lines follow on stderr, under the record |
| `<seat>: left out: timeout` | the prompt never came within the profile's own time limit; the detail under the record, on stderr, says after how long it waited, the screen it last read, the pane's last lines, and that `team up` again resumes it |
| `<seat>: left out: timeout (no terminal for owner)` | a delegated run's idle wait ran out: for it the timeout is a dialog like any other stop, so the workspace is closed without input — the same proof as every close above — and the seat left out. The owner at a terminal is asked instead (the pause, above), and the owner without one keeps the plain `timeout` record above |
| `<seat>: left out: was not in the agent list in time; left at launched` | herdr listed no agent in the pane to name |
| `<seat>: left out: rules not typed: the folder that would hold its rules file is <what>; the owner removes or repairs it, then runs up again` | a folder from `team`'s per-user state root down to `rules/` is not a real directory of this user's — a symbolic link, not a directory, another user's, or (for `rules/` and the project folder) a mode wider than `0700`, never `chmod`'d closer; `<what>` says which. Nothing was written, nothing typed |
| `<seat>: left out: rules not typed: its rules file's place holds <what>; the owner removes it, then runs up again` | the final name holds anything other than this user's `0600` regular file — a symbolic link, a FIFO, a directory, a wider mode, another owner — and is never replaced; `<what>` says what is there |
| `<seat>: left out: rules not typed: its rules file did not read back as written; check the project state folder, then run up again` | the write landed but did not read back (no-follow) as the hash the line carries; nothing was typed |
| `<seat>: left out: rules not typed: its rules file could not be written; check the project state folder, then run up again` | the write failed; nothing was typed |
| `<seat>: left out: rules not typed: its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -; rename the seat or move the project, then run up again` | the path holds a character the read-back cannot prove; nothing was typed, nothing quoted |
| `<seat>: left out: rules not typed: the CLI never appeared as its pane's foreground process (the screen read <kind>); check the seat's launch line — the wrapper it starts through, or the command itself — then run up again` | within the profile's own time limit the pane's foreground process was never the CLI — a wrapper's shell still in front of it, or a launch line that exited. A CLI that starts through a wrapper is waited out, its first frame included; nothing is typed into the wrapper's shell |
| `<seat>: left out: rules not confirmed: the seat is working; run up again when it is idle` | the seat is mid-turn; nothing was typed |
| `<seat>: left out: rules not typed: <what stopped it>; <what to do>` | nothing was typed: the screen was not an empty idle prompt, or the box already held text that is not the rules line. A box that already holds exactly this CLI's exit text — an earlier `down` typed it and never confirmed it — is its own line: the text is named and the owner is told the one key that empties it (`press Ctrl+U in its pane to clear it, then run up again`), or, on a CLI with no such key, to clear the box in its pane |
| `<seat>: left out: rules typed, not sent: the read-back didn't match; the line sits in its box, unsent: <what to do>` | the line was typed and its box did not read back as the line, and this run did not clear it: the delivery has no clearing key, the line was already in the box when this run started, the screen was not the unsent composer, the seat was not idle, or the CLI was not the pane's foreground. `<what to do>` names the profile's one key when the CLI has one. When the box drew a row that is not the line's own, the first such row is written under the record on stderr, stripped of control characters and cut to 200 characters |
| `<seat>: left out: rules typed, not sent: the read-back didn't match; the line team typed was cleared (<key>); run up again` | this run typed the line, the read-back failed, and the profile's one key restored the idle prompt. `<key>` is the one the profile names, spelled as its pane spells it |
| `<seat>: left out: rules typed, not sent: the read-back didn't match; the clearing key (<key>) was not delivered; the line sits in its box, unsent: <what to do>` | the pane did not take the clearing key. The line stays unsent |
| `<seat>: left out: rules typed, not sent: the read-back didn't match; the clearing key (<key>) left the screen reading <kind>; the line sits in its box, unsent: <what to do>` | the key was sent and the screen did not come back to an idle prompt. `<kind>` is the reading after the key, and the line stays unsent |
| `<seat>: left out: rules typed, not sent: the rules file changed after it was written` | the line read back, but the file — read again without following a link, directly before Enter — no longer held the text whose hash the line names. Enter was not pressed; the line sits in the box, unsent, and the owner checks the project state folder before running `up` again |
| `<seat>: left out: rules typed, not sent: its box still holds the line after Enter; <what to do>` | Enter was pressed — up to three tries, each after the box read back as the line again — and the box still shows the line: the key did not take, and nothing was sent |
| `<seat>: left out: the seat did not come back to its idle prompt (<reading>); <what to do>` | the line was submitted and the seat never came back to its idle prompt — a running turn, or a dialog to answer |
| `<seat>: left out: its rules were not delivered; left at named` | the pane could not be read at all; nothing was typed |
| `<seat>: left out: its workspace did not close; left as it is` | its pane no longer held the process `team` launched, and closing that workspace failed, so nothing was launched in its place |
| `<seat>: left out: its workspace was not created; left at launched` | herdr made no workspace for it |
| `<seat>: left out: its launch command did not run; left at launched` | the pane took no command |
| `<seat>: left out: the approval allows 3 seats; 4 would be running` | the approval's ceiling, from the record, not the file |
| `<seat>: left out: refused: <account> <window> left <n>%, inside its <reserve>% reserve, changed <age> ago; accounts with room: <accounts>` | a counted reading is inside that account's reserve and this run would launch the seat; this seat is not started, and the others still are. `accounts with room: none` when no other account has room |
| `<seat>: left out: refused: <account> spend <amount> <CUR>, at or below its <floor> <CUR> floor, read <age> ago; accounts with room: <accounts>` | the money its check counted is at or below the account's floor, and this run would launch the seat; this seat is not started, and the others still are |
| `<seat>: left out: refused: its launch line starts `<word>`, which is not on the PATH` / `…, which does not exist` / `…, which is not executable` / `…, not found from `~`` / `…, not found from its start folder` | the program the line starts is missing where the seat starts — the lobby for a seat that works in worktrees. When the check looked in a folder it resolved, the record's reason stops at `…, not found from its start folder` and the sentence naming the folder is written under the record, on stderr. A first word that is one fully quoted literal (`"claude"`, `'zcash'`) is checked with the quotes removed, the way a shell would run it, and `<word>` is the word as written, quotes and all — a quoted `"~/x"` is a pathname with a literal `~` folder, resolved from the start folder, never the home. A path written as the program is read as main's launcher check read it: it must be there and executable, not merely there. This seat is not started, and the others still are |
| `<seat>: left out: refused: its launch line runs `<path>`, not found from its start folder` | the line runs a shell — `sh`, `bash` or `zsh`, by name or by path — whose first argument is a relative script path, not an option, and that script resolves from the project root but not from the folder the line will run in: the shell exits 127 without starting anything. The record's reason stops at `…, not found from its start folder`; the sentence naming the folder it looked in and the absolute path to write is written under the record, on stderr. This seat is not started, and the others still are |
| `<seat>: left out: refused: the lobby is not trusted for <cli>: run <cli> in <lobby> and accept the folder` | a seat about to start in the lobby whose CLI's own trust record for that folder cannot be written: the record is written under the seat's home before its workspace is made, and a config that is a link — that file, or a folder above it — one that cannot be read, or one that CLI's own file cannot be merged into leaves the seat out instead. A `grok` or `cursor` seat is told its own flag instead (`run grok --trust in <lobby>`, `run cursor-agent --trust in <lobby>`); a CLI this build has no writer for starts with nothing written. A `--dry-run` writes nothing: it reports this refusal, as a `would refuse:` line, only for a Claude seat whose config it cannot merge into. This seat is not started, and the others still are |
| `<seat>: <account> <window> left <n>%, inside its <reserve>% reserve, changed <age> ago; accounts with room: <accounts>` | the same reading, and the seat is already running; setup continues and the line is only a notice — on a real run it is written to stderr, under the seat's record |
| `<seat>: <account> spend <amount> <CUR>, at or below its <floor> <CUR> floor, read <age> ago; accounts with room: <accounts>` | the same money reading, and the seat is already running; setup continues and the line is only a notice — on a real run it is written to stderr, under the seat's record |
| `<seat>: <account> is unknown` | the account is in the file and its figure is unknown — a subscription with no counted reading, or a spend account whose money reading is missing, older than `budgets.stale_after`, or in another currency than the floor's. A subscription figure with no known reset is unknown while it could still matter — inside its reserve, or within the reserve again outside it; further out — more than the reserve again — it counts, the room the figure last held, and the launch decision is clear: no unknown line. The seat still starts, and the line is a notice written to stderr, under the seat's record, on a real run |
| `<seat>: <account>: first sight only, not yet counted` | the account's only readings are unconfirmed; the seat still starts, and the line is a notice written to stderr, under the seat's record, on a real run |

A `version: "0"` — exactly that literal, the placeholder a fresh `init` writes before the owner
fills the release number — is read as *no version declared*: the seat's first launch is not stopped
by it, and the model family is still compared, so a file whose model names a family the CLI does
not run stops as above. No other spelling is read that way: `version: "0.0"` stops the launch as
any mismatch would. [team doctor](../commands/doctor.md) says the placeholder as a note — what the seat really
runs, and the one edit that pins it.

`<account>` in these lines is the seat's own account: its `account:` when the file names one, its
`vendor` when it doesn't.

A launch line the check can't be sure of is never refused: it is printed as `  note <seat>: <why>`
and the seat starts. A note says the line was not checked — a word of it quotes or substitutes text
this version does not read, or its first word names no command — or that a relative path is not
there yet, `not checked: the command may create it`; that is every relative argument but the shell's
script path above — option text, an output path, a path the command creates, one a launcher changes
directory for — and a `~/…` that is not there now is said the same way. A seat resumed into an
existing pane is checked where that pane runs when the state records the folder it was started in;
without that record its launch line is not checked at all and the note says so — the file's folder
is not where that pane is. The notes are said once: on stderr on a real run, on stdout with the plan
on a dry one, as [team doctor](../commands/doctor.md) says them. A miss is not a note: on a dry run it leaves
the seat out as `  skip <seat>: would refuse: …`.

The plan a `--dry-run` prints is also what `team down --dry-run` prints: `+ <command>` for a command
that would run, a `    (<note>)` line under one that carries a note, `  wait <text>` for a wait,
`  skip <text>` for a seat left out, and `dry run: nothing was run` at the end. A seat a stored
reading would refuse, and that this run would launch, is `  skip <seat>: would refuse: …` and is not
in the commands — the same line a seat whose launch line can't run where it starts is left out with,
before its workspace is made. The words after `would refuse:` are the same as the words after
`refused:`. A seat
already running keeps its setup, with that reading in a note. A seat whose account is unknown
carries `(<account> is unknown; would launch)` under its first command. A first sight carries
`(<account>: first sight only, not yet counted; would launch)`. A launch carries the seat's rules
when they travel as a launch option (claude-code, grok), so its line is long; a first-message seat's
launch is the plain CLI command, and the plan shows the one line it types at the seat's idle
prompt, with the note that the rules go to a per-seat file in the project state folder first.

## Refusals

A real run stops before the first step, prints one `team up: <reason>` per reason and exits 1:

| Reason |
| --- |
| ``only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane`` — a run with no terminal. ``only the owner or `leads` starts the team; this call is <caller>`` — any other caller the ordinary rule refuses. With a `delegates` section in the file, that other refusal is the delegate gate's to say, in its own words below |
| ``only the owner or the approved delegate runs `up`; this call is <caller>`` — the delegate gate: the file's `delegates` section names panes, and this caller is none of them |
| ``--<flag> is the owner's; the approved delegate cannot use it`` — the delegate gate, for `--session` and `--file` on a delegated run, refused before the file or the session the flag names is read |
| the delegate gate's other refusals, each in its own words — no verified approval in force on this machine, the caller's placement in its pane unproven, or the caller's entry not naming `up` in `commands` — printed like every refusal here, and on a dry run above the plan |
| ``approved before records were signed`` — the record was written by an earlier `team` |
| the case a refused record names — a signed record that does not verify |
| a `MISS` finding from [team doctor](../commands/doctor.md) — herdr or a CLI not installed, or a CLI not logged in. A launch that names another model than the file, or that names none, is a warning, so `up` still starts the seat; a seat's own launch line is not this — it leaves that seat out alone, in the lines above. After the idle wait, a screen that shows a different model leaves that seat at launched, not named |
| `the load is 1.2 per core, above 1` / `free memory is 8%, below 25%` / `free disk is 3.0 GB, below 10.0 GB` / `memory pressure is critical` — the OS's own level, where the platform reports one; free swap is the watch's reading and never refuses a launch on its own |
| `herdr doesn't answer` |
| `session beacon is stopped` — herdr lists it stopped and this team's state does not record it, so `up` does not clear it |
| `session <session> is stopped and did not clear` — herdr lists it stopped, this team's state records it, and the clear did not happen |
| ``session beacon has 2 agents this file's state doesn't record: `up` never touches a running team`` — an agent on a pane no record names, or on a pane this state records for a seat at another stage: a seat at `named` or `ready` whose pane now holds a foreign agent is refused here, with the whole team. An agent on the pane this state records for a seat left at `launched` — the run stopped after its pane was made and before its rename — is not refused: it is the run's own half-finished seat, and this run finishes it, the idle wait and the rename like any launched seat |
| ``the file is legacy: migrate trust to absolute paths including the lobby <lobby>: ...`` — `<lobby>` is the team's lobby, `~/.config/team/lobby` when the defaults apply — followed by the whole `trust:` block to paste: every entry the next `up` requires, one line saying which key of the file each entry comes from, and, for an entry a rule of `trust` refuses, one line naming the key that forces it |
| ``the lobby <lobby>: <check>`` — the team's lobby; gate check failed (symbolic link, permissions, mode, a file a shipped CLI reads at start, inside git repo) |
| ``the lobby <path>: failed to create <component>: <code>`` — the run had to make an absent lobby, and the make itself failed at `<component>`: a component that cannot be written, or one another process took first. The read-only check above found the lobby missing and made nothing; the make runs under the run lock, after a delegated run's audit line and before any seat's own effect, and the run stops here (exit 1) |
| ``seat beacon-qa would start in live, inside the protected checkout live; a seat that isn't `mode: shared` never starts in one`` — the folder the file gives it, or its lobby, is a protected checkout |
| ``another session-mutating run is holding session <session> (pid <pid>); try again when it is done`` — another run holds the session's mutator lock, the one lock `up`, `add`, `down` and `remove` share: this run stopped before its first step, and a delegated run gets the same line. The line names no command, because the lock is shared and its token records only a pid. `--dry-run` takes no lock and never shows it |
| ``another session-mutating run may be holding session <session>, and its lock cannot be read; if no run is using it, delete <state dir>/seat-locks/<session>/.run`` — the lock file does not read as a token (empty, corrupt, unreadable), so its holder is unknown: a run that cannot be proven finished counts as running, the same as a lock left by a run whose pid is still alive, and only the owner clears it — the line names the file |

A watch that has not run, or whose heartbeat is old, is not a reason to refuse: `up` starts the
watch itself.

## Known issues

A team file that is not `.agents/team.yaml` in the folder the watch starts in is still watched.
`up` records the resolved path for the watch and starts `watch` with no `--file`. That
process reads the recorded file. Any other non-owner is refused.

## The examples, moved off the page

The fixture and the examples below are the page's own, moved here whole. They run in the order they
stand in, and the `fixture` line is theirs: the two seats are up, the third is stopped in the file,
and this session has no watch running. The first example was also on [the `team up`
page](../commands/up.md) until its one-glance cut; none of them is on the page now — it keeps one
five-line refusal scene of its own — and none is executed by any test: `test/docs.test.ts` reads
`docs/commands/` alone.

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby      # the team's lobby; the default when the file sets none
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

  - role: implementer
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: reviewer
    name: gemini-qa
    label: reviewer
    cli: antigravity
    vendor: google
    model: Gemini
    version: "3"
    launch: agy
    stopped: true
```

```fixture
agents: [claude-keeper, claude-beacon]
watch: none
state:
  seats:
    claude-keeper: {stage: ready}
    claude-beacon: {stage: ready}
```

Two seats are up and the third is stopped in the file, so the plan is short — the skipped seats, and
the watch this session has never had:

```console
$ team up --dry-run ; echo "exit $?"
+ herdr --session beacon workspace rename w1 coordinator
+ herdr --session beacon pane report-metadata w1:p1 --source team --display-agent 'Claude Opus 5.5 default'
  skip claude-keeper: already ready; left as it is; its process was never recorded: run team register claude-keeper to record it, nothing relaunched
+ herdr --session beacon workspace rename w2 implementer
+ herdr --session beacon pane report-metadata w2:p1 --source team --display-agent 'Claude Opus 5.5 default'
  skip claude-beacon: already ready; left as it is; its process was never recorded: run team register claude-beacon to record it, nothing relaunched
  skip gemini-qa: stopped in the file; start it with `team add gemini-qa`
+ herdr --session beacon workspace create --cwd . --label 'Watch · beacon' --no-focus
+ herdr --session beacon pane run <pane of Watch · beacon> 'team watch --session beacon'
    (a desktop notification follows when the watch exits)
dry run: nothing was run
exit 0
```

The same command for real runs exactly that:

```console
$ team up ; echo "exit $?"
claude-keeper: ready
  already ready; left as it is; its process was never recorded: run team register claude-keeper to record it, nothing relaunched
claude-beacon: ready
  already ready; left as it is; its process was never recorded: run team register claude-beacon to record it, nothing relaunched
  skip gemini-qa: stopped in the file; start it with `team add gemini-qa`
watch: started
exit 0
```

A seat this team's record does not mark `leads` cannot start the team; it can read the plan:

```console caller=claude-beacon
$ team up ; echo "exit $?"
team up: only the owner or `leads` starts the team; this call is claude-beacon
exit 1
```

A session stopped in herdr that this team's state records is cleared under the run lock, then
started. This page's earlier examples have already recorded the session, so a stopped herdr
session is cleared and the seats come up. A stopped session the state does not record is
refused, and that line names no herdr command (`session beacon is stopped`).

```console herdr=stopped
$ team up ; echo "exit $?"
claude-keeper: ready
claude-beacon: ready
  skip gemini-qa: stopped in the file; start it with `team add gemini-qa`
exit 0
```

An owner section changed in the file is what the commands read. The plan is the live file's:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby      # the team's lobby; the default when the file sets none
  - ~/Code/beacon

limits:
  seats: 4

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

  - role: implementer
    name: claude-beacon
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: reviewer
    name: gemini-qa
    label: reviewer
    cli: antigravity
    vendor: google
    model: Gemini
    version: "3"
    launch: agy
    stopped: true
```

```console
$ team up --dry-run ; echo "exit $?"
+ herdr --session beacon workspace rename w1 coordinator
+ herdr --session beacon pane report-metadata w1:p1 --source team --display-agent 'Claude Opus 5.5 default'
  skip claude-keeper: already ready; left as it is; its process was never recorded: run team register claude-keeper to record it, nothing relaunched
+ herdr --session beacon workspace rename w2 implementer
+ herdr --session beacon pane report-metadata w2:p1 --source team --display-agent 'Claude Opus 5.5 default'
  skip claude-beacon: already ready; left as it is; its process was never recorded: run team register claude-beacon to record it, nothing relaunched
  skip gemini-qa: stopped in the file; start it with `team add gemini-qa`
dry run: nothing was run
exit 0
```

The real run follows that plan. A live edit of an owner section is not a refusal.
