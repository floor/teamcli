# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.16] - Unreleased

### Security

- Grok's workspace preset also grants the folder a Grok seat starts in; a Grok seat started in a shared lobby can write that lobby. Until the next release, start Grok seats in their own worktree.
- Grok and Cursor seats now require their own start folder, using a recorded worktree when one is available. Shared root, lobby, overlapping seat folders and Grok starts outside its sandbox grants refuse before launch with the own-worktree repair. Cursor seats keep separate project MCP configurations. Existing Grok or Cursor seats with `cwd: .` and no recorded worktree are refused on their next `team up` placement or relaunch until their cwd names an own folder.

## [0.5.15] - 2026-11-06

### Security

- **Grok sandbox grants were wider than the seat (affected: 0.5.12 through 0.5.14).** Before this release, a Grok seat's sandbox profile granted read-write on ~/.config/team and on the whole project .agents folder. That reaches other seats' drops, their hook settings, and the team state on the machine. The profile now grants the seat's worktree and start folder, and only that seat's own paths: under the git common dir, objects/, refs/, logs/ and worktrees/<its own>; under .agents, send-drops/<session>/<seat>, messages/<seat> and the seat's own state folder seat-state/<session>/<seat>/. Only existing directories are granted; any surviving grant that is not a directory refuses the seat before launch. The packed-refs file is never granted. A fetch or pack-refs that must rewrite packed refs is refused (EPERM at packed-refs.lock) and fails loudly; commits and loose-ref fetches work. The common dir's config and hooks and the seat's hook settings file are not granted. Nothing under ~/.config/team is granted. A start at the shared project root is refused; give the seat its own worktree or clone. A Grok seat whose sandbox profile cannot be written is now refused instead of launched without a sandbox. If Grok cannot apply its sandbox for a reason outside these grants, it may still run unsandboxed; the launch does not yet refuse that warning on screen. If a Grok seat's pane shows "sandbox could not be applied", stop that seat; a later release refuses it at launch. This was local only: the seat runs as the same user on the same machine. Nothing was reachable over the network. Upgrade; the next launch writes the narrowed profile and removes the leftover [profiles.team-seat-<project>] table. No configuration change is needed. The profile extends Grok's workspace preset, as before; what that preset grants beyond this list is not measured.

## [0.5.14] - 2026-11-06

A listed Muse hint is the empty box only when it is faint or drawn in the colour the composer declares. A listed hint in another colour stays a draft, and a typed wake does not type over it.

### Fixed

- A listed Muse hint drawn in typed blue, another colour, or an undeclared grey stays a draft. The empty-box reading is a faint hint or a colour the composer declares, the same rule as a rotating hint. A longer line on that row stays a draft too.
- The CI timing recorder counts a test file once. A nested describe suite is not a second unit, and a report that has only describe rows keeps the sum of those rows under the file.
- The daemon answers health and status requests without re-reading the team state for every seat.

### Security

- **`team drops --read` now checks the caller (affected: 0.5.1 through 0.5.13).** Before this
  release, `team drops --read --seat <seat>` served any seat's waiting messages to any process run
  inside that team's folder, and wrote their signed read receipts. One seat could therefore read
  another seat's messages and mark them read, so the real recipient never saw them. Now only the
  seat itself writes a read receipt. `--read` serves a seat's messages to that seat, as the
  turn-start hook runs it, and the owner or a lead (the orchestrator or the operator) may read
  another seat's drops only as a peek: the body is shown, no receipt is written, nothing is marked
  read, and the message still waits for its seat. A peek is logged with the reader, the seat and
  the ids. Every other caller is refused, the refusal is logged, and nothing is receipted. This
  was local only: the caller had to run on the
  same machine, as the same user, inside a folder holding that team's file. Nothing was reachable
  over the network, and no key or credential was exposed. Upgrade to 0.5.14; no configuration
  change is needed.

## [0.5.13] - 2026-11-06

Message delivery now reports only the leg that ran, a seat behind a launcher wrapper can
answer, and a managed Codex endpoint that is down is named instead of typed into.

### Fixed

- A send to a managed Codex seat whose endpoint is not listening now says the endpoint is
  blocked, with the socket's own reason: the message stays in the seat's mailbox, the lead
  gets one signed notice, and the outcome is queued, not woken. A reply takes the same path.
- A managed Codex seat whose endpoint does not start is left out with one line instead of
  falling back to `--no-daemon`, and `team check` names each ready Codex seat whose endpoint
  record is absent or unusable.
- A send reports the leg that actually ran: a mailbox drop says queued, a channel
  notification says notified, not yet read, and neither says the seat was woken. A recorded
  socket that is gone is reported as that failure, never as an event-adapter wake.
- A send's `--json` document accepts the channel leg.
- `team reply` and `team ack` run from a seat's shell now recognise the seat placed in the
  team's session, as `team send` already did, so a seat behind a launcher wrapper is no longer
  refused as unplaced.
- A reply to a seat held by another command is queued instead of refused: the signed answer
  is written to the seat's mailbox, and the watch delivers it once the seat is free.
- An idle Codex pane whose last row shows `? for shortcuts` with the account's warning now
  reads idle, while a box holding text still reads unsent.
- A Cursor seat launched through the terminal host now records its conversation, and a
  restored pane ties back to its launch.
- A typed wake to an Antigravity seat answers the CLI's bottom feedback survey with Skip once,
  then reads the prompt again before typing.
- The watch's chores child awaits its pane proof read, so a slow terminal-host read no longer
  stalls its heartbeat.
- `team status` reports a machine daemon whose health probe timed out but whose heartbeat is
  recent as busy under load, not hung.
- `team up` records a live Claude seat's socket address even when it leaves the seat at
  launched, so a send reaches it without a restart.
- `team up` binds an address only to the seat and session that own the pane: it skips a pane
  the terminal host names for another seat, or one another declared seat's record already
  claims, and leaves a record standing in another session neither refreshed nor cleared — a
  send can no longer wake another seat's process.
- `team check` names the repair that works: `team up` for a live seat whose record holds no
  address or whose pane was restored (its own plan adopts the running process in place), and
  `team register` when the record names no held process or stands in another session. A pane
  two seats both claim is named once for the pane, and only a pane no proof binds names a
  restart, which records the address itself. The stale-socket line names the machine's restart
  load limit.
- A managed Codex seat's inbox tool starts after a restore or reload: its launch epoch is
  carried through both, `team reload` registers the inbox again when the registration is
  missing, and a managed endpoint that died is started again in place.
- An idle Muse box that shows its rotating hint reads as empty, so a typed wake can reach the
  seat. The unsent check and `team status` say the box reads as holding text, and never ask
  anyone to clear it.
- A command that waits on a team lock now stops at its deadline in every case, including a lock
  whose holder record cannot be read and a stale record the folder refuses to remove, so a
  wedged lock can no longer hang a run. A no-wait attempt is refused at once, and the refusal
  names the process holding the lock now, never one that has exited.

## [0.5.12] - 2026-11-05

A send walks one cascade and stops at the first leg that takes it. A message stays in the mailbox
until the seat that must read it signs the receipt.

### Delivery

A send tries three leg classes, in order, and stops at the first one that takes the message. First
the channel: a live socket, a runtime queue, or the CLI's own session. Then a webhook the sender
posts itself. Then a gated typed nudge, one trigger line into an idle prompt. The mailbox sits under
all three and is the last resort. The inbox server is how a seat reads that mailbox; it is not a
wake, and a delivery order that still names it is reported unavailable. A seat marked human uses the
mailbox only. A reply walks the same cascade toward the sender and reports the leg that took it.

### Re-wake

The sender does not move on because a receipt is missing. The watch does. When the unread window
passes with no receipt the seat signed, the watch tries the next leg down the cascade. The window is
30 seconds for a seat that can be woken while idle, 60 seconds for a typed or pull-only seat, or the
team's own setting. At twice that window the sender and the lead are told the message is queued, not
woken. A mailbox drop that no leg can wake ends with those words.

### Read receipts

Only the seat signs a read receipt: its inbox read, its drops read, an acknowledgement, or a reply.
A frame the channel took is reported delivered as taken. Delivered as read means the seat signed the
receipt. The frame's last line names the record and the two acts that settle it: a reply marks it
read, and an acknowledgement marks it read when no answer is needed. A taken frame that is still
unread is re-woken once, with that hint.

### Messages

`team messages` serves and signs one mailbox: the caller's own. A run as the owner serves the
owner's mailbox, and a run as a seat serves the mailbox of the seat it is placed as. A caller placed
nowhere is refused. A record waiting on another seat's mailbox is listed as waiting; a seat's run
does not show its body, and the owner's run shows a verified body read-only without spending that
seat's receipt.

### Client answers

A client that holds a bundle grant can open a thread with a seat the grant reaches. That seat can
now answer it: `team reply` and `team ack` accept a verified bundle grant, and the ops the grant
signed decide which of the two is allowed — a reply needs the reply op, an acknowledgement needs the
ack op, and a bundle without it is refused as before. The grant is verified, and the recipient
re-checked, while the grant lock is held. A reply whose recipient seat, or whose agent id, moved
while it waited is refused and writes nothing; it says to send the reply again.

### Trace

Each step of a message writes a signed event on that message's id. `team trace` prints the steps in
order with the time between them. A send prints the id on its last line.

### Daemon start

The daemon answers as soon as it is bound. Each root's first store scan runs behind that, and status
reports the scan while it runs and when it finishes.

### Chores

Heavy work for a root — its watch, its presence steps, and its fallback sweep — runs in a supervised
child. The release default is one child per root. The daemon's own loop keeps answering. A child
that has exited is not given another beat. A cold event-log read verifies from a signed checkpoint
in slices, and the send endpoint's terminal host is read off the loop that answers health, so
neither holds the daemon up.

### Webhook deadline

The sender's webhook post waits for the `webhook-sender-deadline-ms` policy: 3 seconds when unset, a
whole number of milliseconds from 500 to 10000. It waits the tighter of that bound and the seat
row's own answer bound. A post that outlives the wait is reported unknown, not failed, and is not
posted again. An answer that arrives after the wait is still recorded.

### Typed wakes

Antigravity, Grok, Codex, Muse, and Cursor can declare a typed wake. A send types one trigger line,
never the message, into a prompt two reads showed empty and idle, presses Enter only while the box
still holds that line, at most three times, and calls the send delivered only when the working
screen shows and the box no longer holds the line. Otherwise it is not delivered, the line is not
typed again, and the message stays for a later wake. The line names how that profile reads its
inbox. `delivered (typed wake)` is a history outcome. Muse's faint placeholder reads as an empty
box, and a typed wake waits out a drawing line before it presses Enter.

### Scroll-back

A pane scrolled back over its transcript hides the prompt, so a wake used to find a screen it did
not recognise and refuse. Codex's scroll-back view is now read as its own screen, in two layouts:
the footer on the last row with the prompt hidden, and the marker directly above the prompt with the
status footer on the last row. Both are read from the pane's bottom rows only, never from a
transcript row higher up that quotes them. The wake presses the view's own return key once, then
reads the prompt twice before typing, and keeps every guard it already had: a draft the return
reveals, a working turn, or a dialog refuses, and Enter is pressed only while two reads agree on the
line. A scrolled pane whose host word says unknown is woken this way too. A footer this build does
not know is still an unrecognised screen, and nothing is typed into it; a launch keeps reading the
view as unrecognised.

### Codex prompt chrome

The hint row Codex draws after the scroll-back return — `esc again to edit previous message` — is
the prompt's own chrome: the empty composer reads idle and a wake may type its line there, and the
hint is never answered with esc. With a line in the box, Codex hides its shortcuts row and draws the
account's warning row under the status row; that row is the pane's own chrome too, so the box still
reads unsent and a typed wake presses its guarded Enter into the line it typed. Neither row is read
from a transcript row that quotes it, and no key is pressed into either.

### Exit text

`team down` and `team restart` clear the exit text they typed when the submit Enter is refused or
never runs.

### End of turn

A seat whose tools do not include the inbox is told, in its own rules, to read its drops at the end
of every turn.

### Sidebar order

`team order` puts the sidebar back in roster order, restarting one seat at a time. An owner who
names a session or a team file has that choice followed by the placement and by every restart the
pass delegates.

### Placement

When the terminal host hands a live session to a new server, placement follows the new server's root
process, and a caller keeps its seat placement and any development-mode lift across the handoff.

### Actions and comments

A seat may read workflow runs, and may run the Actions commands its policy allows. The release set
is rerunning the failed jobs of a run, and starting the deploy and ci workflows on a named ref. A
lower level may only drop a command. Deleting or dismissing a comment is refused; the seat posts a
superseding comment instead.

### Lead settings

Every seat's rules carry the owner's reserved scope, and under it the line that checkouts, seats,
and team config belong to the teams. A lead's rules also say when a lead may act in a seat's pane,
and when a lead in development mode may restore a stopped seat. Those two lines ship on, and each
can be turned off. The third ships off: inside an entity, an entity may turn on the line that a
decision the main orchestrator relays from the owner is quoted, cited, and acted on — off by
default, because a relayed decision carries the owner's authority and a sender's claim to relay one
does not yet verify. The reserved scope stays whatever is set.

### Development mode

Under development mode, the owner lift on `team config set` and `team add` admits only its subject:
the target team's lead, placed in that team's session, or the entity's main orchestrator. An
`always` rule for an owner action admits only its subject as well, and the rule spent is the one
naming the caller's team; revoking an approval is one of those actions. While development mode is on
for a team, `team check` reports a pending owner card that asks for anything beyond the general
grant and the development-mode switch as policy drift.

In development mode, `team restart`, `team order` and `team worktree` continue when a stored
approval does not verify: each names the record and the unverified lines, restart names
`team approve` as the command that writes a new approval, and none of them signs one. Outside
development mode the refusal is unchanged; order and worktree say that standing cannot be renewed in
this build.

### Main orchestrator

The entity's main orchestrator can reach any seat of the entity's teams. A seat can answer that
orchestrator on the thread the orchestrator opened, and cannot open a thread toward it. A restart of
a stopped seat by that orchestrator is judged by who the caller is.

### Heartbeat

`daemon.heartbeat` is a whole number of seconds from 1 to 60. Unset, the beat is 5 seconds. The
daemon records it and answers a health probe while other work runs.

### Store

Two first writers of a new home share the state folders and the pending folder. A folder that is
already a real folder of this user is used. A link, a file, or another user's folder is still
refused.

### Chores liveness

A chores child reports the processor time it has been charged on every heartbeat, so a healthy beat
does not stop to read the process table. The daemon asks the process table only for a child that has
gone silent: one question at a time, off the answering loop. A reading that fails, or runs
backwards, spares the child. A child still being charged work is not forced off. A child that has
not yet had time to hear a beat is not judged silent. A root's next child waits 60 seconds from the
moment the last one was ended, including when the start itself throws, so a child that comes up
under load is not replaced again inside that minute.

### Roster

A seat written on one line, or as a list at the seats header's own column, can be revived. Restart
decides that the seat exists from the validated record, and clears or re-marks the stopped mark
through that record, wherever the text holds the key. A record that no longer validates keeps the
old line writer. A registry team can declare a seat no launch has run for yet. Up, add, restart and
reload write that seat's roster line before the plan runs, so the first launch can register. A name
the launching record does not declare is refused, and the registry is left as it was.

### Idle colour

An exact listed line drawn in one non-bold colour reads as idle, so a seat that has gone idle can be
woken. A second colour, a bold word, or a cursor cell stays text. A webhook delivery the seat has
not read is posted once more, with the same message id. The wake marker stops a second pass.

### Tasks hint

A tasks hint is an empty box only when the whole row is that exact text. The same words with
anything after them stay a draft, so a wake does not type over a draft. A listed tasks sentence in
one non-bold colour is that empty box. The same words split across two colours stay a draft.

### Held wake line

Two reads that hold exactly the wake line press Enter, and a listed placeholder row under that line
does not spoil the hold. A working screen that still holds the line is not delivered. The wait stays
inside the existing bound. A bound that ends with the line still there leaves the message for a
later wake.

### Blocked screen

When unread mail is due and the seat's screen is one the watch does not recognise, the watch does
not type into it. It tells the lead once and records the message delivered but blocked. The notice
is owed once the message is due, not only inside twice the unread window: a pass that first looks
late still names the screen, where the queued, not woken report was the only word before. Twice the
window keeps the notice single — a report already standing for the same seat and screen is the one
later messages join. A screen the watch already knows keeps its own handling, so a later idle screen
can still be typed.

### Stuck seat

Some states keep the wake path from looking at a seat at all: the message already has a retry, or a
proven presence says the seat is mid-turn. When the oldest unread message has waited past twice the
seat's unread window, the watch now names the seat to the lead anyway, once per episode, for every
seat not marked human and not stopped. The notice says what waits — how many messages, and the
oldest one's age — and why: the screen is not recognised, or presence has said working for longer
than `watch.stuck_after`. That bound is 15 minutes when the team does not set it, and it is never
scaled by the tempo; a working word younger than it is a live turn and gets no notice. The episode
closes when the seat reads one of the messages the notice named, or its state is recognised and
fresh again. The blocked-screen report shares the episode, so one stall is one notice, and the
queued, not woken report stays quiet while an episode is open. The notice types nothing, takes no
seat lock, and leaves every pending retry and wake marker as it found it.

The stuck-episode marker is taken from the pass's own folder listing: an absent marker costs no
read, and a marker is read at most once per seat per pass.

### Watch pass

One watch pass reads each message file once. It checks a receipt before it reads the record, and the
unread set and the unacked set from that read are what the pass wakes, reports and waits on. A later
check in the same pass uses that set. It does not open the file again. A very large drop folder,
tens of thousands of old messages, still slows the hosted watch until archived drops are reclaimed
in the next release.

### Power-loss restore

After a machine loses power, the terminal host reopens the sessions it can, but the agent names it
had given their panes do not survive. A caller places itself by that name, so every restored seat
reads as unplaced and its sends and reads are refused. `team up` now re-ties a restored seat to its
record when the proof holds: the pane is the recorded one, in the recorded workspace, and either its
conversation is the one the record names, or — when neither side names a conversation — the declared
CLI is alone in its workspace, at an idle prompt, with nothing unsent in its box. The run names the
pane back, repaints the sidebar line and records the process the pane holds now; nothing is typed
into the pane and nothing is closed, and the seat counts as neither repaired nor refused. A pane
that fails the proof is left as it is, with the reason said.

A seat whose program the terminal host did not bring back is launched again. When its recorded pane
is back at its shell, the seat runs in that same pane; when the pane is gone or was replaced, the
seat launches from the beginning in a workspace of its own, and the workspace left behind closes
without input once the seat is ready — only while it still holds nothing but the old pane and is not
named for another seat. Replacing, removing or stopping a seat closes the workspace it vacates once
the replacement is ready, or at once when nothing replaces it, and only when the host, read just
before the close, shows no CLI and no other seat's pane in it. A team keeps one watch workspace: one
that already carries the team's label is reused instead of a second being made.

A restored pane that runs the bare CLI where the seat's own launch line starts a wrapper — an
alternate endpoint — is not adopted: every turn would lack the wrapper's settings. `team up` lets
the bare CLI exit by its own exit word or keys in that same pane, launches the seat again there
through its own launch line with its conversation resumed, and neither closes nor replaces the
workspace.

A Codex seat whose recorded managed endpoint did not survive the host is not left on it. When the
record names this seat's own socket and that socket is not live, or the recorded process is gone, or
the process now at that pid started at another time, `team up` lets the CLI exit in its pane and
launches the seat again there, so the launch starts a fresh endpoint and attaches to it. A live
endpoint stays. A record that is absent or not this seat's, and a start time this build cannot read,
leave the pane as it is: nothing is relaunched on a guess. The relaunch is the Codex binary itself
with the managed endpoint on. A wrapper, or a line that already names `--remote` or `--no-daemon`,
is not given one.

A launch asks the terminal host for the seat's name, and asks again when the host refuses because
the agent is still starting. The asks stay inside the naming wait: the first pause is a quarter of a
second and each later one doubles up to two seconds, cut to whatever the wait has left. A pane the
host has begun naming for another seat is left to that seat. Only the wait running out leaves the
seat unnamed, at launched.

One command runs the restore across every registered team: `team up --all`, which only the owner or
a lead in development mode runs, takes the teams in a fixed order — a team whose folder holds
another team's first, then by session name — runs the ordinary pass for each team whose session is
running and whose record holds seats, and skips a team whose session is not running rather than
starting it cold. One team's failure never stops the next; the run ends with a line counting the
teams swept and the seats repaired, skipped and refused, and a run that restores nothing says so
instead of reporting success. The daemon's startup pass does the same for the checkouts its unit
names and retries a session that is still restoring — five seconds, then twice as long each time up
to a minute, for five minutes and a quarter — before it reports that session pending. That pass is
this home's unit alone: a loaded job whose path is not the unit file this home installed is not this
daemon's, and the retry does not borrow it. A seat lock left by the previous boot is stale unless
its process is alive and its start time matches the one recorded, so a reused pid no longer holds a
seat shut.

`team check` names each restore gap with its repair: a restored pane that holds the seat's
conversation or declared CLI, a seat whose CLI did not come back, a pane running no CLI, and a
process the record cannot tie to the launch. `team restart` proves the team of a restored session
from the team it was launched from, then the team the folder holds, then the team the registry
records for the session, and says which one it fell back to. A restored pane is `team up`'s to
re-tie, not restart's; restart takes one only while the host still names the seat on the recorded
pane, and only with `--abandon`.

## [0.5.11] - 2026-11-02

Clearer delivery reports and approval cards, steadier team recovery, and tighter checks before
an action changes a team or answers a dialog.

### Added

- `team peek` shows a seat's captured screen lines with credential masking, without sending
  input to its terminal.
- Seats can receive accepted inbox records through a webhook with configurable headers and
  request bodies. Delivery reports identify the route that accepted a message, and status shows
  whether each seat can be woken while idle or reads its inbox on its next turn.
- `team answer` handles questions, plan approvals and confirmations on supported CLI versions.
  The watch reports these dialogs, includes their visible text and flags incomplete questions.
- An entity can require unique seat nicknames across teams. Configuration changes keep a
  seat's label and nickname together, and checks report conflicting names.
- Owner-signed send grants can address another team's orchestrator within the same entity.
  `team daemon restart` accepts a verified general grant that covers the daemon operation.

### Changed

- Owner approval cards describe the action in plain words, with optional `--reason` text and
  the full record in details. Development-mode changes can be sent as an owner-seat request.
- A team's lead can restart its own stopped seat. A failed revival preserves the stopped
  mark. Development mode admits the lead's supported team and seat edits with a warning and an
  audit record written after a successful change.
- The machine daemon reports health while roots are starting, follows current registry
  records, renews its own watch heartbeat and reports failed endpoints. Installation uses a
  verified program copy without grant credentials in the service definition, and a failed
  refresh restores and checks the previous program.
- Custom screen rules require a matching condition. The `reason` field belongs only to
  rate-limit rules.

### Fixed

- Supported quoted Claude Code launch scripts keep resume and session options inside the
  script. Launch records and fallback reports describe the conversation actually started,
  and managed endpoint sockets remain usable for teams in deeply nested folders.
- Managed Codex conversations can accept queued messages during a running turn or dialog.
- Launched-team commands read current registry records. Inbox registration works without a
  local team file and retries a failed registration before leaving the seat unlaunched.
- Workflow runs preserve error transitions even when the requested destination is the error
  state, and check each step before saving it.
- Restored seats refresh their displayed state on the first watch cycle. Status reads a
  wrapper's model only from an unambiguous welcome header. Slow process and screen reads finish
  before the state lock is taken.
- Signed bus verification keeps an authenticated checkpoint across restarts. Closing a bus
  cancels deferred work, and webhook delivery preserves configured header and body values
  while refusing redirects and unsafe file inputs.
- Approval history checks read the complete record chain and distinguish a missing prior
  record from a team with no approval history. Policy logs credit the caller who made a change.
- A seat's declaration time now changes only when its cross-session acceptance setting changes,
  so a rewritten hook command no longer makes a running seat look stale to senders.
- A recovery pass that launches no seat leaves running seats' hook files untouched, so it
  cannot move their declaration times.
- `team route` reports the same stale session state a send would meet, instead of calling a
  socket live that a send would pass over.
- Hook commands name the installed program instead of the private copy the system's service
  manager runs, so a later refresh cannot leave a seat's hooks naming a removed folder.

### Security

- Grant and approval checks follow the operation, entity and resolved target folder the
  command actually names. Grant denials and approval revocations require the record's owner.
- Dialog answers recheck the recorded launch, supported CLI version, current dialog and
  resolved trust folder immediately before acting.
- Credential checks recognise framed tokens in team configuration. Private-text checks also
  scan binary-looking files and complete commit messages containing NUL bytes.
## [0.5.10] - 2026-11-01

0.5.10 is one release for everything since 0.5.5. The work prepared as 0.5.6 through 0.5.9 is
folded in here: the owner seat and grants, the registry, quiet starts, the general grant on
every command, the end of typed messaging, and the managed Codex endpoint.

### Breaking change

**Nothing is ever typed into a seat.** No message, wake, reminder, watch nudge, rules line or
restart handover is sent by typing into a seat's terminal or prompt. Every message ends in the
seat's bus inbox and reaches the seat by the route its own launch installed: an event adapter
that wakes it — the development channel its launch loads, or a socket its launch accepts whose
recorded address still stands — a Codex runtime queue under the managed endpoint that holds
the message between turns, or an inbox the seat reads when it next takes a turn. The sender is
told which, in plain words: woken through its event adapter, woken through its runtime queue,
queued and read at its next turn (pull-only), or queued with no way to be woken while it is
idle. A send that ends without a delivery never answers a bare "unconfirmed"; the bus-inbox
drop's own line still says `queued, no event adapter` when it takes the send. Starting a CLI in
a terminal, its exit keys and `team answer` (a permission dialog, not a message) are unchanged.

### Upgrade notes

- **A pull-only seat reads its own inbox.** Nothing is typed into its terminal. The launch's
  turn-start reader serves the waiting records on the seat's own turn, each with its signed
  read receipt; `team messages` serves them to a reader in the checkout. An ordinary MCP inbox
  is pull-only too: it serves `inbox_check` and `inbox_read`, and pushes nothing. A seat whose
  launch gives it a push adapter — the development channel, a socket its launch accepts, or a
  Codex runtime queue while the codex-daemon policy is on — is woken through it instead.
- **Rules ride the launch line.** A first-message CLI's profile names how its launch line takes
  an initial prompt; the rules file is written before the command runs, and the line pointing
  at it goes last on the launch line. A seat whose launch did not carry its rules is not typed
  to: it gets its rules file and is left out. Where the profile has an initial-prompt form,
  `team restart <seat>` carries them; where it has none, no launch ever carries them, and the
  report says so instead of advising a restart.
- **A declared `typed` delivery order names the seat's own adapters.** For a Claude seat it
  means its live channel and then the socket its launch accepts; for a Codex seat, its runtime
  queue while the codex-daemon policy is on. It no longer names a typed message.
- No team migration is needed: a 0.5.5 team keeps working, and approvals made on 0.5.5 stay in
  force. Grants signed before this release keep the ops they list; only a grant whose ops are
  `*` covers ops added later. The client bundle formerly named `developer` is the `default`
  bundle (`developer` remains its alias), and it may run `team down --abandon`.

### Added

- **The owner seat.** The owner approves several actions as one request with no owner terminal:
  import, add, up, migrate, send, down and bus, each shown to Touch ID and applied in one run.
  `team config set|unset --request` lets the owner seat approve a team-record change.
  `team grant --request` reports whether the owner was notified, presents a Touch ID card,
  prints a one-request link to the owner page, and the owner page lists pending grants. Owner
  prompts and owner-page strings come from one English message catalog, with a short French
  owner-seat prompt available.
- **Development mode.** One machine-wide, owner-signed switch (`team development-mode`), off by
  default: `local-fast` lifts the caller gates of `up`, `down`, `remove`, `register`, `add`,
  `restart`, `init`, `reload` and `rename`; the team-file approval the delegate and grant gates
  (`up`, `add`, `remove`, `down`, `register`, `reload`) and the `add`, `remove` and `down`
  standing check ask; named owner-only gates for a placed orchestrator, or the main orchestrator
  above it — `grant`, `delegate`, `revoke`, `policy set` and `unset`, `check --repair`, `remove`
  and `down --abandon`, `broker`, `tempo`, `daemon install`, `uninstall` and `fault-watch`; the
  file's designated installer while its designation is not approved; and one untested Antigravity
  release, `agy` `1.4.3`, in `team reload`. Beyond the lifts this entry lists, the client pane
  guard, the load guard, the swap gate and every public action keep their refusals. Each lift
  logs a warning with the command and the caller — the `dev mode continues` clause, except
  `down`'s caller-placement line under a policy or the machine record, which carries the level
  note alone — printed for the caller gates, file approval, owner gates and reload range, and in
  the audit log alone for the installer admission.
- **General grants.** One owner signature covers every entity or a listed set. The `team up
  --general` form admits a launch with no request. `team init --general` creates a team for an
  entity whose declared roots hold the folder: the grant must verify to the owner key, be
  unexpired, match the key and cover the entity; it is never self-issued and never wider than
  its parent. A refusal exits `init.general-refused`. A grant's ops may be the wildcard `*`,
  signed like any list, and `team client general-grant` defaults to `--ops '*'`.
- **The general door.** Every command but `team client general-grant` takes `--general
  <grant.json>` and `--key <client.key>`. The dispatcher verifies it once for the command's own
  op and the entity of the team in the folder, takes the two options off the line, and runs the
  command as the owner: no detached or terminal refusal, with the owner as the caller (for
  `reply`, in place of the walked caller). A command added later is covered with no wiring of
  its own; `up`, `init` and `config` keep their own admission, and the grant-issuing command
  refuses `--general` (a holder issues with `--via`). Every command name is a general-grant op,
  and the wildcard covers them all and later ones. Exit ids `team.general-usage` (2: `--general`
  without `--key`, or on the grant-issuing command) and `team.general-refused` (1: expired,
  another key, an op or entity the grant does not cover); the command contract lists `--general`
  and `--key` on every command and subcommand.
- **A team charter and the registry record.** Team setup takes one owner signature as its
  charter, and the team definition is read from the registry record.
- **Event delivery.** A send reaches a seat through its own push adapter: the Claude
  development channel its launch loads, which pushes each new record as one notification and
  is redelivered once by the watch when no signed read receipt arrives; or a socket the launch
  accepts. An ordinary MCP inbox pushes nothing: the seat reads it when its model calls the
  tool. `team up` starts the bus in its own workspace, `team down` closes it, and a dropped
  follower is redialed with a doubling wait. `team messages --client --follow` prints each
  reply on a client thread as it lands.
- **`team down --abandon`** answers known prompts and saves unsent text before stopping a seat.
- **Conversation record and resume.** Launches record the conversation id they carry, and
  `team config set` syncs the agent launch. A Grok seat resumes with `grok -r <id>` and an
  Antigravity seat with `agy --conversation=<id>`. After `team down`, `team up` resumes the
  conversation the registry records when no seat state record exists, exactly when the registry
  and the retained handle agree.
- **Quiet start.** `team up --no-launch` gives seats their rules only, with no general seat
  brief; the stop instruction travels in the rules file, a busy seat is waited out, and the
  start is quiet.
- **The managed Codex endpoint.** A Codex seat's launch starts a managed app-server endpoint
  under the seat's presence binding and attaches the TUI to it by remote. The seat's native
  turns, inbox server, permissions and tool calls then run under that endpoint. A seat launched
  through a shell script is seen through to the CLI it runs; a restarted seat starts a
  replacement endpoint and attaches with its recorded conversation; the endpoint accepts the
  app-server's linked socket. A Codex seat's tools and MCP servers under its managed endpoint
  are placed as that seat under the full ownership proof: the listen URL of its current
  binding, the recorded pid and a start inside the record's window, and, for a session, the
  terminal it records.
- **The workflow's live run store.** A run lives in a durable store: an item index that decides
  exclusion, a versioned, append-only journal that folds the run's state, and reservations that
  keep one seat on one item at a time. A pending hold has a release deadline, the built-in
  `work-item` definition ships with the workflow, and `team next` takes the run store's hold
  before its local lease.
- **The machine daemon records the packaged commit as its install identity.** Beside the version
  it runs, the daemon records the commit its build was packaged from, and `team daemon status
  --json` exposes it as `gitHead`. The pair tells an install that changed either the version or
  the commit from one that changed neither; a source checkout and an older state record report
  no commit.
- **`team status` names when the hosted watch started and which build is cycling.** A route the
  machine daemon hosts reads `watch: running in the daemon since <start>, version <version>`,
  the start the watch record holds and the version the daemon reports, `unknown` when it
  reports none. The line no longer carries a relative last-cycle time; a failed last pass is
  still the check's line.
- **`team agents prune` retires agent records no roster names.** It lists one row for each
  record this machine holds that no registered team's roster names: the agent, the seat and
  team it reaches, its lifecycle, why no roster names it, and what a run would do. `--apply`
  retires the orphaned and superseded records and leaves three kinds alone: a seat the team's
  configuration still declares, a record whose team the registry no longer holds, and a record
  whose team's configuration cannot be read. Retiring is a recorded state, never a delete: the
  record keeps every field, its signed settings among them, and the lookups that place a live
  seat skip it. `--apply` is the owner's, from a terminal rather than a seat's pane, and a
  scoped grant reaches only its own entities.
- **`team brief prune` retires a seat's own launch-brief retry sidecars.** A held launch
  delivery leaves a try marker behind; prune lists and, with `--apply`, removes the ones whose
  retry can no longer be right: a marker whose delivery the seat's current claim superseded,
  and one a signed receipt bound to that claim says the seat read. The current claim's unread
  marker is exactly what a retry still owes and is never touched, and neither is any other
  file in the folder. The dry run is the default, one row per file; `--apply` verifies each
  removal and reports one that failed. Only the seat itself, on the terminal its state records,
  prunes its own folder; a claim it cannot read, or one that changes while the run reads,
  retires nothing.
- **A seat's delivery class is read from its launch, not from its CLI's declaration.** Each
  shipped CLI profile declares one of `push`, `between-turns`, `pull-on-turn` or `none` — the
  loader requires the word and refuses one outside the set — and the launch refines it from
  what it left behind: the development channel on the launch line; a cross-session socket
  counted only while its address still exists, the launch settings accept it, the team file
  permits it, and it does not predate that declaration; the managed endpoint bound to the
  seat's current presence binding; and the recorded watcher. A declared `push` seat
  whose launch turned nothing on falls to its watcher; a person's seat is `none`. A send that
  ends without a delivery appends the class to its `sent (unconfirmed)`, `sent (channel)` and
  `queued (receiver busy)` lines, and to `action_summary` in `--json`, in plain words: `woken
  through its event adapter`, `woken through its runtime queue`, `queued; <seat> reads it at
  its next turn (pull-only)`, or `queued; <seat> has no way to be woken while idle`. A
  delivered line carries none: the delivery itself is the answer.
- **`team check` names a Claude Code seat whose sends skip its socket.** A live seat whose
  profile promises a push delivery but whose send would take the drop folder instead — its
  launch declares inbound accept but the team file lacks the required consent, its box held the
  last frame, or its socket is older than the declaration that accepts it — is one difference,
  with the command that repairs it: `team config set seats.<seat>.inbound accept` for the
  missing consent, `team restart <seat>` for the other two. A seat with no socket at all gets one
  note naming its delivery class, and the exit does not change; a declared delivery order that
  names neither the socket nor the `typed` wake word is a choice, not a finding, and neither is an
  explicit opt-out.

### Changed

- **The typed delivery leg is retired; the native leg is a runtime queue.** The native leg
  hands a pointer to a Codex seat's own runtime queue, or a Claude sender's message, and types
  nothing. The generated settings carry the team file's inbound accept when the launch scripts
  declare no word of their own.
- **`team config set` writes a value with its unit as plain text.**
- **The watch pushes idle work only to a seat's own records**, and holds direct work when it
  holds no verified watch authority.
- **A hosted watch's `team up` closes the legacy watch workspaces it replaced.** Only when the
  machine daemon's hosted watch owns the route, `up` closes each leftover workspace labelled as
  the team's watch whose terminals are readable and hold nothing but their own shell, and says
  how many on stderr and in the log. A terminal a process still holds, or one that cannot be
  read, is left alone; with no hosted watch owning the route nothing is closed, and a dry run
  only says what it would close.
- **`team remove` retires the removed seat's agent record.** The record is kept, never deleted:
  it is marked retired, its terminal is cleared, and its roster line goes, while its signed
  settings stay readable. `--keep`, which only stops the seat, keeps the record and its roster
  line for the seat to run again as the same agent.
- **`team config set` and `unset` keep the record's comments.** Only the changed key's lines
  are rewritten: an unset that empties a list leaves `[]` rather than regenerating the record, a
  comment beside or inside a removed value stays where its line was, and a set that replaces a
  whole section keeps the comments written inside it. A change the editor cannot address that
  way rewrites the record whole, and the command says so on stderr, with `comments_kept: false`
  in `--json`.
- **Time-bound work is never handed to a seat that cannot be woken while it is idle.** `team
  next`, in the command and in the daemon, and the workflow's reservation take leave a record
  carrying a deadline out of the candidates they offer such a seat, while ordinary work stays
  on offer. The watch's dispatch spends no idle attempt on it: the push would be a wake that
  never lands and the episode's one attempt would be gone with it, and an episode whose wake
  already went is still settled. `team plan` marks such a record `(its seat cannot be woken
  while idle)` after its title, and `team up` warns that `<seat> is a lead seat and <cli>
  cannot be woken while it is idle; time-bound work is never dispatched to it` (a reviewer
  seat says so as a reviewer; a person's seat is left out).
- **A pull-only seat checks its inbox at the start and the end of every turn.** The standing
  rule and the `inbox_check` tool description name both ends, with an `inbox_read` for each
  message the check lists, so a message that arrived while the seat was working is acted on in
  the same turn instead of waiting for the next one. Only a profile with a measured inbox route
  adds the rule; every other seat's rules stay as they were.

### Fixed

- **The machine daemon under the system's service manager finds the terminal host.** The unit
  carries the installing shell's PATH; without it every session read failed and every hosted
  send answered "the session could not be read".
- **A slow heartbeat probe no longer kills the hosted send endpoint.** Three 2 s misses in a
  row mark it failed, and an answer restores it; one 400 ms miss used to mark it failed for
  good.
- **Seats may send while the daemon is up.** The send endpoint refused every sender but the
  owner and the orchestrator; it now refuses only a sender that is no seat of the team, and the
  CLI's admission decides the rest.
- **`team daemon install --general <grant.json> --key <client.key>` installs a unit that
  starts.** Under the service manager the run's parent processes cannot be read, so it was
  `unplaced` and refused at every start. An install admitted by the general door writes the
  grant and key paths it was verified with into the unit's run command; each service start
  passes the same door, which verifies the grant again (op `daemon`) and refuses, exit 1, once
  it is expired, revoked by a missing file, another key, or no longer covers `daemon`. Only the
  paths the door verified for that install are recorded; a plain install writes no grant, as
  before.
- **The daemon's fallback sweep passes over settled episodes without locking them.** A marker
  with no pending intent that is delivered, still trying, already escalated or not yet due is
  counted and skipped before its lock, so a large delivered backlog no longer stalls the
  heartbeat.
- **Rules ride the launch line; nothing is typed.** `team up` writes the rules file before the
  command and puts the line that points at it last on the launch line. A seat this run did not
  launch gets the file and is left out: where its profile has an initial-prompt form, a
  restart carries the rules, and where it has none, no launch carries them and the report says
  so. A single-seat restart drops the launch brief to that seat alone, and a registration
  briefs only the registered seat.
- **A resume line the CLI cannot find is launched fresh.** Before the launch runs, the
  conversation is checked on disk and a missing one is launched fresh with a note. If the CLI
  still refuses the resume at runtime, the idle wait reads that refusal and relaunches fresh
  once in the same terminal.
- A launch record can no longer re-run a disallowed launch line.
- **The terminal host's idle never makes a seat ready once its CLI has exited.** Its word
  counts only while a CLI is in front of the terminal and on a second reading in a row; a
  terminal back at its shell waits into the ended reading, the missing-conversation fallback or
  the timeout.
- **A Codex seat's managed endpoint keeps its inbox server and its permissions.** A TUI attached
  by remote loads the app-server's `-c` pairs, so the seat keeps its team inbox server, and the
  endpoint carries its approval policy and sandbox mode. Measured on codex-cli 0.161.0: a
  resume line's permission overrides are carried by the endpoint, so an attached resume keeps
  its recorded thread, and a fresh line is unchanged.
- **A restarted Codex seat on its managed endpoint resumes the recorded conversation.** The
  seat's permissions are carried by the endpoint, so the restart keeps the thread instead of
  starting a fresh one.
- **A list inside a seat no longer ends the seat** when the team file is read.
- **The registry's session is kept when the config omits it**, and wording names the registry
  config when no team file is read.
- **A receipt publisher's temp file is ignored during a read race**, and an unwritten bus
  section leaves the canonical record unchanged.
- **Several watch and MCP channel-push races are closed**, including push name reservation and
  a stale inbox server reload.
- **`team mcp serve` finds its team without a `--file`.** A server started without one takes its
  team from the registry record that holds its seat, narrowed by `--session`, and never reads the
  folder it starts in as the team. When more than one registered team holds the seat it refuses,
  naming the teams it found; a seat no registered team holds is refused with the `--file` it
  needs.
- **The Codex daemon dialog closes on `team down`**, and a detached agent is named by `caller`.
- **Team-made state folders are created 0700.** The log, the state lock, the restart handover
  and the launch's own files create their folders with mode 0700, so a project store they
  first make is accepted by the rules file written before launch. A folder that already exists
  keeps the mode it has.
- **A client drop no event adapter took is recorded as the drop leg**, sent unconfirmed, and
  the log says `queued, no event adapter` rather than `unreachable`.
- **A bundle-grant send walks the same delivery legs as any other send**, and a walk that fails
  logs the reason and prints one warning on stderr.
- **A launch line that sets its own permission flags keeps them.** An option written on the
  line keeps its value, and the profile's default for that option is not appended as stray
  words: the whole default, its value included, is suppressed, and an option's short, long and
  `=` spellings all count as the same option. A quoted config or prompt word is not read as a
  flag, and neither is a word after `--`.
- **A managed Codex endpoint stop proves the process, not its socket file.** A missing socket
  file is no evidence the server is gone: a live pid that its command line and start instant
  prove to be this record's server is stopped by pid, and the socket file is removed only when
  it is that socket. A live pid that cannot be proved is never signalled. A record that is
  present but unreadable reads as unproven, not absent: the stop says why it cannot act, and a
  removal that needs it is refused while the seat and its record stay.
- **A failed launch stops the managed Codex endpoint it started.** Cleanup stops the endpoint
  this run started before it clears the seat's workspace and record. An endpoint the launch
  reused is not its to stop: the launch record is kept, and the run holds with the reason,
  rather than dropping the identity of a live server.
- **A quiet start reads the inbox instead of skipping it.** The note a quiet start adds to every
  rules file told the seat not to continue earlier work and not to read drops, so a message
  queued before it was never read. It now tells the seat to read its inbox, act on what is
  addressed to it, and leave earlier work alone unless a message asks for it.
- **A recorded socket counts only while its address is there and the declarations admit it.** A
  seat's delivery class reads a socket from the launch settings' accept, the team file's own
  `inbound` word, and an address the seat's record names that still exists and does not
  predate the declaration that accepts it. Dispatch counts no socket for a seat whose socket is
  absent or refused by declaration. A send that disproves the socket falls back to the bus
  inbox, and reports the class the seat has without it, so it never claims a wake the attempt
  just disproved.
- **A restart waits for the session lock instead of refusing at once.** `team restart` takes the
  session's mutator lock before its first effect — the stop — standing aside up to fifteen
  seconds for the run already holding it, so a restart that arrives while the watch is restoring
  is no longer turned away at the first reading. When the wait is spent it refuses with the
  holder's pid named and nothing stopped, rather than leaving a seat half-stopped.
- **A restart or a refresh binds a seat's record only on proven continuity.** A restart's
  relaunch binds the record to the seat state it just wrote. A refresh rewrites an existing
  handle only when the pane's live processes are the ones the record's launch started — the
  recorded shell with a recorded CLI pid in front; a pane holding another process is refused
  (`register.replaced`), and an id another live seat's record of the team carries is refused
  (`register.handle-held`). Both refusals name what they found and leave the record unchanged,
  and a record that predates the process identity is not rebound at all: the refresh fills only
  a handle it never had.
- **A restart or a refresh whose binding was not written says `pull-only` and why.** After the
  launch, the record is read back as the seat's native route resolves it — a route addressed by
  the conversation also needs the recorded agent session. A record that is missing, refused or
  not yet carrying that session leaves the seat reachable by pull alone: the closing line ends
  `; pull-only: <reason>` and `--json` carries `pull_only`, rather than reporting a restart done
  whose record was never written.
- **A Claude seat launched through a provider wrapper reads its declared model.** Its model is
  the launcher's declaration, checked against the provider id its start banner prints — the
  declaration's model and version read as one string, so a version its model name repeats is
  counted once, a digit belonging to another model word (a capacity such as 2B) stays part of the
  model, and the version keeps its written order — never the Claude CLI's own default family:
  `team status` labels the seat with the model it runs, and a send is not held for a false drift.
  A wrapper is identified by the seat's recorded launch, or by its explicit launcher-model
  declaration (`model_from: launcher`), never guessed: a launch line the reader cannot follow
  reads unread only where that declaration is absent, and the signed record's bare `claude` launch
  — with a path, an environment prefix or quotes — stays plain Claude and overrides the
  declaration. `team check`, the watch and `team up` read a live seat's model from its recorded
  launch, not the team file's current line.
- **`team status` reads the send's own socket eligibility.** The REACH column walks the send's
  own socket rule — the same gate and the same address choice — so a row says `socket` only while
  the shared checks admit that route: the launch's inbound declaration, the team file's word, a
  held frame, the socket's age, and the selected address (the recorded address first, the pane's
  own socket otherwise). A temporary seat gets its REACH from its record. The send's configured
  delivery order and its other checks still decide which leg carries a message. The agreement
  holds for the same registry and the same moment; it says nothing about a socket that goes away
  later.
- **`team config set`, `unset` and `team add` file an owner request from a team root that is not
  a git repository.** They resolve the team's root the way `team config get` does — a checkout's
  root, or the plain folder itself, whose registry record holds the team — so the request and
  its approval work in the team's own folder. The approval rules are unchanged: no team change is
  applied before the owner's verified signature authorizes the exact requested words.
- **A model word written in a seat's signed version field reads as the same model.** A record
  naming the model `Gemini` with version `4 Argon` reads as the same model as a screen reading
  `Gemini Argon 4`, so the seat's sends are no longer held as a false drift. A token carrying a
  letter word of its own — a capacity such as `2B`, a tag such as `A4` — stays part of the model,
  never a version's family letter.
- **A stale team approval report names a removed seat and a step this build has.** The `team
  config` report adds a seat the approval still holds and the record no longer names, and a
  default seat ceiling that moved only because the roster did; its session line offers `session:
  <old>` to keep the old default, never a re-approval this version does not have. `team migrate`
  says the team record is unchanged only when the stored approval's canonical record and the
  registry's read-back are equal.
- **`team reply` to another team lands where that team's reader reads.** The record is written
  under the root and session the answered team's live file names — the tree its `team messages`
  and inbox server scan — so a team that moved to another session is answered in the new one. The
  run says `delivered` only after the record passes that reader's checks, and a write it cannot
  confirm says so instead of claiming delivery.
- Configuration paths and parsed team, settings, request and workflow records read only the keys they own.

## [0.5.5] - 2026-10-26

0.5.5 moves the team's definition into the registry. The team is read from and written to
`~/.config/team/team-config/`, approvals are signed over one canonical team record instead of
the file's text, and `team migrate` imports `.agents/team.yaml` and retires it. It also brings
client grant bundles and replies, the message-display wake line, a usage wall read as
`blocked`, and the dry workflow runner. 0.5.4 was never published as a stable release: its
release candidates are folded in here.

### Upgrade notes

- Run `team migrate` in each project, from a terminal outside herdr. It verifies the import,
  then moves `.agents/team.yaml` to the Trash (or renames it `.migrated`); `--keep-file` keeps
  it. A team not yet migrated is imported by the first owner `team up`.
- Approve the team again once with the owner seat if `team check` says so: the default session
  moved to `<entity>-<project>`, and approvals made before canonical signing are rewritten in
  the canonical form at the next approval. An approval made on 0.5.5 stays in force across
  `team migrate`.
- See [UPGRADE-0.5.5.md](UPGRADE-0.5.5.md).

### Breaking changes

- **Behavior change: the default session is `<entity>-<project>`.** A team file that names an
  `entity` and omits `session:` now runs in the herdr session `<entity>-<project>` instead of the
  project name alone, so two entities' teams of the same project no longer share one session. A
  file without an entity keeps the project name, and `session:` still overrides the default per
  team. `session` is an owner section, so an affected team must be approved again: `team check`
  (as a note) and the approval comparison name the move as `` `session` changed: "web" ->
  "acme-web" `` and say to approve again, or to set `session: web` to keep the old one;
  `team status` does not compare approvals, and `team approve` is gone.
- **The team is read from the registry.** Under the registry source (`team-config.source: registry`)
  `.agents/team.yaml` is no longer read; a leftover file is named by one
  line in `team up`, `team check` and `team status`. Edit the team with `team config`.

### Added

- **The `manager` client grant bundle.** `team grant --client <id> --entity <entity> --public-key <file>
  --team <team> --bundle manager --request` asks the owner to sign one grant that lets a client with no
  terminal run one team: the operator's list, the team's own reads, `restart`, `reload`, and the seat
  lifecycle (`add` and `remove`), as an explicit list of 28 ops at vocabulary 6, for ninety days at most.
  It needs `--team`. `team add` and `team remove` take `--client <grant> --key <key> --team <team>`, which
  is verified on the exact team before the terminal check that refuses a caller with no herdr record;
  a human's pane, the orchestrator and the operator are never targets, the approval record is left
  as it was, and the run says the roster change is for the owner to approve with the owner seat. `team
  restart`, `team reload`, `team seats`, `team seat` and `team sessions` take the same `--client` form.
  `observer` and `operator` still never carry `add` or `remove`, and the commands that change who may do
  what stay out of every bundle. See [Client grant bundles](docs/concepts/client-grant-bundles.md#the-manager-bundle).
- **The `developer` client grant bundle.** `--bundle developer` is the manager's list plus `rename`, `swap`,
  `pause`, `resume`, `hold`, `release`, `tempo`, `queue`, `lock`, `unlock`, `worktree`, `raise`, `route`, `pr`,
  `workflow` and `proc` (44 ops, vocabulary 7), for one team and ninety days at most. `team pause`,
  `team resume` and `team hold` take `--client <grant> --key <key>`, verified on the exact team; a client's
  pause is as graceful as the owner's (ongoing work finishes, only new work is withheld until resume) and
  takes no `<team>` and no `--all`. The commands that change who may do what (`grant`, `revoke`, `delegate`,
  `owner-seat`, `policy`, `settings`, `development-mode`, `answer`, `config`, `broker`, `bus`, `daemon`,
  `register`, `client`, `init`) stay out of every bundle. The other developer ops are listed in the grant and
  admit nothing until their route is wired. See [Client grant bundles](docs/concepts/client-grant-bundles.md#the-developer-bundle).

- **`team config get|set|unset|edit` edits the team's record.** One schema-validated editor for
  what `.agents/team.yaml` used to hold: dotted paths (`seats.lead.model`, `watch.unread_after`),
  values read as YAML, and `edit` opens the whole record in `$EDITOR`. Every write is validated
  first, is the owner's, and names what the approval no longer covers. See
  [team config](docs/commands/config.md).
- **The registry read and write path.** `team-config.source`, `team import` and `team migrate`
  read the team from the registry; `team init`, `team add`, `team remove` and the other writers
  write the registry record, with `created_by`, the restore check and the policy read.
- **Client grant bundles.** `observer` and `operator` bundles, client `up`/`down`/`send`/`status`
  forms, and a policy cap on a client grant's duration.
- **Seat-to-client replies** through `team reply` and `team messages --client`; client commands
  are refused inside a team pane.
- **The message-display wake line.** A send's wake line names how the message is displayed.
- **A usage wall reads as `blocked: quota`**, and `team pause` can pause one seat.
- **`team archive`** snapshots a team into an archive, and `team init` can start from one.
- **`team status` counts unclaimed backlog items** beside the queue depths.
- **`team doctor --jules`** names the Jules CLI's missing step.
- **Workflows:** the definition schema, the statechart core, `team workflow check`, waits and
  timers, the dry runner, and `team workflow run --dry` and replay.
- **Watch:** the aggregate watch report, ownership that survives a restart, recovery of a hosted
  watch that leaves, and the scoped fault-watch diagnostic.
- **Restore:** every drifted seat restored in one pass, with a one-line summary.
- An optional `issue_tracker` field on the team record; a real-CLI capture corpus per tested
  version; recognition of the Cursor 2026.10.19 and Muse 1.4.11 ready screens.

### Changed

- **Behavior change: `team migrate` retires `.agents/team.yaml`.** After the import is read back
  and verified, the file is moved to the system Trash, or renamed to
  `.agents/team.yaml.migrated` when no Trash can be reached; it is never deleted. `--keep-file`
  leaves it. A second run retires a leftover that matches the registry and refuses one that
  does not. The approval stays in force: it is signed over the canonical record. See
  [UPGRADE-0.5.5.md](UPGRADE-0.5.5.md).
- **A team still in its file is imported by `team up`.** The owner's `team up` on a team the
  registry does not hold imports `.agents/team.yaml` first and says so on one line; the file is
  kept until `team migrate`. A leftover file beside a registry team is named by one line in
  `team up`, `team check` and `team status`, which do not refuse.
- **Deprecated: the `file` source and `--file`.** `team-config.source: file` and `--file` remain
  as a legacy and test path only. `team init` writes the registry and never a file under the
  registry source.
- **Behavior change: approvals are signed over one canonical team record**
  (`team-record-c14n-v1`), not the file text, so formatting and comments do not invalidate an
  approval. Older approvals verify through a compatibility path.
- The team's configuration is read through one seam; pull-request CI runs diff-targeted tests,
  and the full suite runs on main.
- The installer refuses an older version unless a rollback is declared, and reports what it
  actually did after dispatch. The CLI package ships no type declarations and a reproducible gzip
  layer.
- Seats never run commands that print credentials.

### Fixed

- A team file's `clients:` section added or edited after the last approval is honoured as the live file writes it while the approval standing is verified, like `watch` and `budgets`; an unverified standing falls back to the default seats. It was refused since `team approve` was removed.
- The team's own writes land whole, and a torn read is retried.
- A registry model is marked declared when the screen is unread; a launch line the entity model
  rule disallows is refused.
- Faint text in every profile's input box counts as empty; Muse 1.4.11's typed line is read back.
- A client-origin unread message is reported to the lead alone; a client grant's drop goes through
  the coordinator's order.
- An error above a completed turn and a ready composer is history, not the seat state; a missing
  completion keeps an error on the live screen.
- `team up` keeps the bound registry record and cleans a partial relaunch; a non-working restored
  identity is held, not reported ready.
- `team check` names the default-session move; the current project's approval store is read.

## [0.5.3] - 2026-10-21

0.5.3 is the event-driven send release: a message to another seat is delivered by the first
route that can take it, accepted rather than refused while the receiver is busy, and confirmed
by a signed read receipt instead of a guess. Admission is bound to the seats the team file
declares; a restored seat is recognized by its signed registry record; and a send to a seat
whose running model has drifted is held rather than delivered.

### Added

- **Socket-first delivery for Claude receivers.** A send to a Claude seat is walked over the
  session socket first when the receiving team's inbound policy accepts — an explicit
  `inbound: accept`, or no `inbound` word at all with the settings-attested accept. An explicit
  hold or refuse wins; the team file and the launch do not both have to say accept. A frame the
  receiver's dialog holds falls through to the next leg with the same message id, and that
  socket is not dialed again until the setting is rewritten.

- **A busy receiver queues instead of refusing.** When another command holds the seat's lock,
  the reachable legs write the signed record and its `<id>.pending` marker without the lock,
  type nothing, dial nothing, and answer `queued (receiver busy)` with the id the delivery
  keeps. A running watch or the seat's own watcher finishes the delivery from that marker;
  retries retain the same message id and consult the signed receipts. A compose seat has no
  queue leg, so its held lock stays a refusal.

- **Codex gets a typed wake before the inbox fallback.** For a Codex receiver with no declared
  delivery order, the runtime queue leads when its signed Codex daemon setting is on, then a
  typed wake, then the inbox; when the setting is off, the typed wake leads. An inbox write
  alone does not wake an idle Codex TUI. A declared order is still followed as written.

- **Route diagnostics before the send.** `team send --dry-run` names the channel the walk would
  take, and under `--json` lists every leg as `candidate` or `skipped` with the reason,
  including the implied socket leg a Claude receiver's files keep out. `team route <seat>`
  answers the pair's rule, the live pane and the socket's state (`live`, `stale`, `pane`,
  `unread` or `none`) before a sender dials anything.

- **Signed read receipts, and `team ack`.** `team ack <id>` marks a message read without
  printing it: one signed `read` receipt beside the record, written once and never replaced.
  `team reply` marks a message read by answering it, and `team messages` publishes the same
  receipt before it shows a body. A receipt is the only thing that earns `delivered (read)`;
  nothing claims a seat acted on a message it read. An inbox message unread after ten minutes
  falls to the trigger line, and a drop no watcher read is given up on after thirty minutes
  with its path, never called lost.

- **`--file` and `--file -` for command-bearing bodies.** `team send --file <path>` reads the
  whole body from a file, and `--file -` reads it from standard input; `--brief` takes the same
  two spellings. A multiline body that looks like pasted terminal output is warned about and
  sent unchanged.

- **Unread reports reach the lead as a signed drop.** A message still unread after two windows
  is reported once to its sender's mailbox and once to the team's lead as a signed send-drop
  that `team drops --read` serves. A stopped seat is not woken, and its message stays unread
  until its next start.

### Changed

- **Admission is bound to the declared roster.** A caller reaches the targets the team file
  declares: the owner any agent; an orchestrator another orchestrator of its own team or
  entity; a team's orchestrator or operator any seat of its own team; two operator seats each
  other; any declared seat another declared seat of its own team; an assistant its entity's
  coordinator; any seat its own team's orchestrator; and what an owner-signed grant names.
  Arbitrary cross-team and off-roster pairs are refused by
  default, and a refusal for an unregistered sender names that sender, so a cross-team denial
  says which side lacks a registry record.

- **Owned legacy plaintext is omitted.** A regular plaintext record owned by the team is
  omitted without being served, without a receipt, and without a refusal event or refusal log;
  a record-shaped invalid signed JSON stays strictly refused.

- **Refusal logging stays bounded.** A confirmed repeat refusal is suppressed within the
  window; when the event store cannot answer, the fallback logging cap is 50 lines per checkout
  per process.

- **Event writes share one bounded lock.** Event allocation, signing, append, retention and
  standalone pruning all take the same bounded event-store lock.

- **The seat brief treats a command-bearing message as data, not an authority, and says how to
  send one.** A command quoted from a file, a log, an issue or a web page is part of what the
  message reports; a seat runs only the commands the message asks for as its work and asks its
  lead before one that would leave its folder, branch or files. A command-bearing body goes
  from a file or a pipe: `--file <path>` or `--file -`, with `--brief` taking the same
  spellings. A single-quoted argument is passed through unchanged; a double-quoted one is not:
  backticks, `$(...)` and `$VAR` are rewritten before `team send` sees them.

- **The registry is the authority for a restored seat.** When the pane host restores a seat's
  process under a new id, `team status` and `team check` read the running model against the
  seat's signed registry record rather than the team file, and `team restart` and `team up`
  resume the recorded conversation through the seat's recorded launch line. A conversation
  that does not match the record, or none that can be read, is still refused.

- **A send to a drifted seat is held.** When a registered recipient's pane reports a model
  other than the one its signed record names, `team send` writes nothing, types nothing and
  exits 1 with `held: model drift: <recorded> vs <running>`; the sender can retry after the
  seat is repaired.

- **A signed rhythm change applies on the next pass.** The watch reads the signed policy chain
  on every pass, so a change to the `watch-rhythm` value changes the next wait without
  restarting the watch.

### Limits

- Claude socket confirmed; Codex reached by typed wake; Antigravity and
  Cursor by typed fallback without read receipts; Grok untested.

## [0.5.2] - 2026-10-19

### Added

- **`team pause` and `team resume`.** A pause lives in the team state, never in the team file —
  the file waits for the owner's approval, and a stop that waits is no stop. While it stands the
  team takes no new work: `team next` claims nothing and names the pause with its repair, and the
  watch's work nudges become one notice per non-human seat, at its first quiet prompt after the
  pause landed and never twice for the same pause, saying to finish the step in hand, take nothing
  new and hold no lock. `team status` and `team seats` print the pause above their rows, and a
  human seat is never touched. The pause records a stop point for every declared seat that is not
  a human's: the stage and last activity its record held, and the worktree it was given, branch
  and folder. `team resume` deletes the record, restarts claims and nudges, and prints the stop
  points it held — for one team, `resumed <project> (<pause line>)` then one `stop <seat>: …` line
  each — so the lead can restart every seat from the place the tool holds; a resume with no pause
  standing is refused. Both act on the team file of the folder when no name is given, on a
  registered `<team>` by its name, project or id, or on every team in the machine's registry with
  `--all` (an unreadable team is named on stderr and left as it is), and both judge every target's
  caller before any state is written. The caller is the owner at a terminal outside herdr, or the
  team's own orchestrator on the pane the state records for it. `--json` emits `team.pause` /
  `team.resume` and is refused with `--all`.
- **Operators of one team may message each other.** Two seats of the same team whose file lines
  both write `role: operator` may send to each other; the pair rule admits that direction alone,
  and it is the one decision a role's own word makes. It reads the word the live file writes
  today — a seat the file no longer declares falls back to the role it was registered under —
  and it is not the team's operator place, which already reaches every seat of its team. The word
  grants no other reach: it makes no lead and no assistant, and the pair never crosses teams, so
  another team's operator is reached through that team's orchestrator or an owner-signed grant.
  A send the pair admits is written, delivered and logged like any other: its header names the
  rule and its history line lands in the receiving team's store. `team send --list` shows both
  seats with their role, and a refusal for an unknown name lists them among the file's seats.
- **`team usage` reports each seat's spend.** Under each team's seat table, `--tree` now prints
  the seats' own figures: one line per window — left, used, resets, margin — and one spend line
  per seat. A figure is `measured` when the run read the seat's own screen, `estimated` from the
  watch's per-seat record when the live read did not answer, and a seat with neither prints
  `unknown` with its reason. The spend line is the seat's own money figure, read from the amount
  a Claude Code status row prints in its `S:` field; any other CLI, an unread pane or a row
  without the field prints `cost unknown` with one sentence, never `0`. Figures belong to the
  seat and the run (herdr session) their pane was read in, so two teams' same-named seats never
  borrow each other's numbers. `--json` carries the same facts under `teams[].seats`, with the
  session registry's own `measured` / `estimated` / `unknown` word, so every surface prints the
  same mark for the same figure.
- **`team check` names a seat held at a prompt.** The pass that reads the team's differences now
  names each seat that sits at a prompt on the pane the state records for it, one line per seat,
  read through the watch's own screen reader and only while that pane still holds the process team
  launched: a pane back at its shell, one running a process the record does not name with no
  stored session showing continuity, or a record with no identity whose pane holds a bare shell is
  not read for a prompt at all, so a dialog left in a dead or replaced pane's scrollback is not a
  seat held at one. The line gives the seat, the prompt's kind — a permission prompt, a trust
  prompt, a quota prompt with the reset time the screen shows, the CLI's own exit question, or an
  unrecognised screen that quotes the safety floor's row — the command the screen shows when the
  profile's trace reader finds one, and the record's `last active` age: that age dates the
  record, and the line never claims the prompt itself has waited that long. A permission prompt is
  its lead's to answer; a trust prompt, a quota screen, a confirm prompt or an unrecognised one is
  the owner's, and a confirm prompt also closes with `team down --abandon`, a quota screen with
  the reset it names. The check answers nothing, types nothing and writes nothing: the pane's own
  reader takes the act. Where `status`'s plain permission or trust row would name the same seat
  the check replaces it, so a held seat is named once, and `status` itself now reads a prompt only
  where the seat's process runs, for a declared seat and a temporary one alike. A temporary seat
  is read the same way from its record, with its like-seat's CLI. `--json` renders each line's
  `what` as it stands, cleaned with the report's own plain-line reader.
- **The event thresholds are the owner's to set.** Seven `event-*` policies join the release
  catalogue: how long an unanswered thread stays open (`event-thread-ttl-seconds`, 72 hours by
  default), how many records a thread may hold (`event-thread-cap`, 50), how many days the event
  log keeps (`event-retention-days`, 30), when a held record reaches the lead
  (`event-held-threshold-seconds`, 600), when a seat that watches nothing reads `unreachable`
  (`event-unreachable-threshold-seconds`, 600), when an idle seat's lead is told
  (`event-idle-threshold-seconds`, 300), and how often the bus reconciles
  (`event-reconcile-interval-seconds`, 120). Each takes a whole number — seconds, days for
  retention, records for the cap — and a seconds value may carry an `s` suffix; the shorter field
  spellings are accepted and written back under the canonical name. The three delay thresholds may
  only be shortened: a value above the release default is refused, and so is a level's word that
  lengthens the one above it. `team bus` reads the held, retention and reconcile numbers when it
  starts and refuses to start on a signed policy source it cannot read or verify, with the
  problem on stderr and exit 2, and `team reply` reads the thread life and cap from the caller's
  chain.
- **Seat status comes from herdr as events.** One `herdr wait agent-status` waiter per eligible
  seat turns herdr's status transitions into signed event records, replacing screen polling where
  herdr's status is reliable: `blocked` raises `seat.at-prompt` — the screen is read once to
  classify the prompt — `done` raises `seat.done`, `idle` past the idle-lead threshold raises
  `seat.idle` once per idle stretch, and `working` after `blocked` raises the new
  `seat.unblocked`, which closes the open prompt notice and cancels its climb clock; `unknown`
  raises no event, and a `blocked -> working -> blocked` flicker within the one-pass grace window
  does not emit `seat.at-prompt` twice. Profiles whose herdr status is unreliable keep the screen
  module, `human: true` seats are never waited on and their screens are never read, and a status
  waiter never types or sends keys.
- **`team sessions` lists the session records TeamCLI keeps.** Every launch and stop command now
  writes an append-only registry, one event per line, in the project's machine state folder —
  never from an agent's word. `up` and `add` write a `start` when a pane takes the launch line;
  `restart` closes a record with reason `restart`, `reload` with `swap`, and `down` or `remove`
  with `owner-stop`; a `start` that finds a session still open for the same team, herdr session
  and seat closes it as `crash`, and a launch after a drift repair or a reload closes the old
  record as `swap` and links the new one. A record holds what the launching command knew — seat,
  team and entity, CLI and lab, declared model, version and effort, account, herdr session, pane
  and workspace, the previous session of the seat, and the CLI session id where the CLI takes one
  — and a field no command wrote is absent. `team sessions [<seat>] [--by model|team|entity]
  [--json]` lists them from every state folder on the machine, so it runs anywhere and needs no
  team file: SESSION, SEAT, TEAM, MODEL, STARTED, ENDED, WHY (`swap`, `restart`, `crash`,
  `owner-stop`; `quota` is in the vocabulary with no writer yet) and COST, which prints `unknown`
  — never `0` — until a command measures it. `--by` groups the listing under one heading per
  value, and `--json` carries each record whole, absent keys absent. A Claude Code launch line
  that chooses no session gets `--session-id <uuid>` appended; one that already carries
  `--session-id`, `--resume`/`-r` or `--continue`/`-c` is left as the owner wrote it, and an id
  the line spells is recorded. The id is the one TeamCLI set — it never reads the CLI's own
  session files — and reading a record back into a launch is not part of this release.
- **`team add <name> --like <seat>` copies a declared seat.** Without `--temporary`, `--like` now
  writes a new entry directly under the source's last field: the source's fields and the title
  `<name>`, with its `stopped` mark and `count:` dropped (a counted source is split first) and its
  comments and blank lines left where they are. The source's own entry is untouched, and the new
  seat starts now where `up` would start it, and the entry is written before the launch, so a
  launch that fails leaves the declared seat in the file for a retry. A `human: true` source is
  refused before anything is written or launched. The name must be one the file does not declare (refused as
  `add.like-exists`) and the source one it does; a copy the file's own validation refuses — a
  second `leads`, `assistant` or nickname — stops before anything is written or launched. The new
  entry is not added to the approval record, so the roster change is the owner's to approve; a
  delegate's standing grant admits a copy only when the record holds the source seat just as the
  live file writes it and the run writes that one entry, and a source the record does not hold, or
  holds differently, stays the owner's. `--until` and `--worktree` still need `--temporary`;
  `--like` alone is now a declared copy.
- **A one-row unsent draft no longer holds a delivery.** A profile may now carry an `input`
  block, declaring the measured way into its CLI's input box: the keys that empty an idle box
  (`clear`), optionally the keys that empty it mid-turn (`clear_working`), the paste surface
  (`paste: bracketed`, the one measured), and whether the CLI takes text while a turn runs
  (`mid_turn`). claude-code, codex and cursor carry one, each from a run recorded over its own
  pane; every other profile carries none, and a delivery that finds unsent text there holds as
  it did. A typed delivery that finds a one-row draft copies it beside the drop file
  (`<drop>.draft`), clears the box with the profile's keys — the mid-turn key while the seat is
  working, never the interrupt key — types the trigger and presses Enter, then pastes the text
  back exactly as it was read and removes the copy only once the box reads that text back. A
  copy already beside the drop holding different text is never overwritten: the run holds and
  names it. The direct leg, the daemon queue, the watch's held-send retry and the native
  handoff all carry the same keys, so every route makes the same delivery, while the watch's
  own nudge still types only into an empty idle box. The receipt says where the text went (`the
  unsent text was pasted back`, or `…; its copy is at <path>`); a delivered exit restores the
  draft after a late clear or a read that fails, a box that reads other text keeps its copy,
  and a not-submitted run puts the text back before saying so. `restart` restarts an idle seat
  holding one row of unsent text instead of leaving it: it copies that row to
  `restart-drafts/<session>/<seat>.draft` under the session lock, prints the copy's path in the
  pre-close facts, closes the pane without typing over the text, and pastes it back into the
  new pane once herdr reports it idle or done, removing the copy only after the box reads it
  back; a different copy at the path refuses the restart and is never overwritten.
  A box drawn over more than one row is never copied — the composer word-wraps a long line over
  the same continuation rows a person's Enters draw, so a soft wrap cannot come back as a line
  break nobody typed — and that box, a profile with no measured keys, a missing mid-turn key, a
  paste chip and rows the reader cannot read each keep the old hold on send or the old refusal
  on restart, with the box's own reason. `--abandon` still closes the workspace without a copy.
- **Every command states who may run it.** The generated CLI contract now carries a `who` row for
  every command and subcommand — the gate kind and the command map's own sentence, plus the
  detached route (who and where) where the module refuses a run with no terminal — and
  `docs/reference/cli.md` prints it under each command's `Who may run it` heading. The rows are
  copied from `COMMAND_GATES` (`src/permissions/map.ts`) as they stand, never reworded, and
  generation stops on a word the map does not name: the map is closed, so its silence is not an
  admission and no unlisted word reaches the adapter. The 0.5.2 kinds `any-caller`, `seat-only`,
  `leads-only`, `team-change`, `team-pause` and `team-read` join the map, `error.rule` carries
  `team-change`, `team-read` and `terminal`, and a difference repair names the actor it named
  before: a lead for `team-change`, `team-pause`, `any-caller`, `seat-only` and `leads-only`, any
  seat for `team-read`.

### Changed

- **The bus verifies only what was appended.** A reconciliation pass or a subscription now
  verifies the event records appended since the last verified sequence and trusts the prefix its
  checkpoint pins: the highest sequence it has verified and a SHA-256 over the raw lines of every
  retained record at or below it, in retained order. A read with no checkpoint, a different
  message key, or a digest that does not match — a segment trimmed, a file rewritten, a record
  altered in place — verifies the whole retained log again and rebuilds the checkpoint, so a
  record altered earlier is still caught: it changes the digest, and the read that sees the
  change falls back to the full verify that finds it. File boundaries are not part of the digest,
  so a rotation that keeps every byte keeps the checkpoint while a trim does not, and the
  checkpoint lives in the bus process's memory, so a restart or a read from another process
  starts from a full verify. The bus's plain output and exit codes are unchanged.

### Fixed

- **A seat launched into a lobby keeps its inbox.** The launch now carries the team file it read
  into the plan and the seat-inbox registration, and the registration names that file to
  `team mcp serve` with `--file`: the server resolves the team from it instead of the folder it
  started in, which a seat launched into a lobby does not have. With no file named, the folder's
  team file is the fallback, and a team that cannot be read is still refused. `restart`'s real
  launch registers the inbox like `up`, `add` and `reload` already do. The codex launch-line route
  writes no config file of its own, so its two `-c` values now carry the `--file` pair, with the
  path escaped as a JSON string inside the structured value so a path with spaces or quotes stays
  one argument; the cursor route's written JSON names the launch file, and gemini's and grok's
  `mcp add` argv carries the path byte for byte. A named file is read and only that file: an empty
  name, a missing file, a folder or an unreadable file is a refusal that writes nothing, though
  the folder holds a valid team of its own, and `team mcp serve` exits 2 with the loader's message
  before it makes a listener or an inbox folder. `--file ''` is refused by the parser with
  `team mcp: --file needs a value`.
- **`team usage` tells a file it cannot read from one that does not load.** The team-file loader
  returns its refusal for an unreadable file instead of throwing it, and marks that refusal
  `unreadable`, so `team usage` keeps the two faces the case had: the owner reads the loader's
  own sentence, the file named once; a caller who is not the owner reads the fixed sentence
  `cannot be read: the owner reads the reason`, prefixed by the team file path — never `does not
  load` for a file that never loaded. A file that loads and still has a problem keeps its load
  sentence, with the line and the loader's reason for the owner.

## [0.5.1] - 2026-10-19

### Added

- **The `drop` leg, and human seats.** A receiving seat's delivery order may name `drop`: the walk
  writes the record as the typed leg's own 0600 drop file and types nothing at all — no trigger
  line, no socket frame, no daemon round trip, no pane read — so a receiver that watches its own
  drop folder finds the message there. Its console line is `<seat>: sent (unconfirmed) (drop,
  <n> ms)`, exit 0: the record is the message, safely on disk, and no signed receipt has come
  back yet. Beside it the send leaves the marker `<id>.pending`; the seat's own watcher reads the
  drop and writes the signed `<id>.read.json` receipt, and a running watch promotes it once — one
  `delivered (read)` history line, the marker cleared, nothing typed. A drop no watcher read
  thirty minutes after the send is given up on with the file's path: the marker is cleared, the
  record stays in the folder, and it is never typed and never called lost. The history line says
  `via: drop` and the JSON channel is `drop`; the leg sits in the default order between the
  seat's own MCP inbox and the typed trigger. The typed leg stays terminal, and a drop-leg marker
  is never typed or retried; `team drops` reads the receiver's own folder, and its `--follow`
  prints each drop that arrives. A dry run names only the legs it can
  reach: the phrase stops at the first terminal typed leg, and names only the drop channel when
  `drop` leads. A seat the team file marks `human: true` walks the drop leg alone, whatever its
  order or the default says: the typed trigger, the native frame and the seat's own inbox are
  kept out, the reason for each leg the order holds recorded on the history line, so the message
  arrives in the drop file and nothing reaches a pane or an inbox; a `delivery_order` written on
  such a seat is not a `team check` difference, because the seat walks `drop` alone whatever the
  word says. A person reads the drop and writes no receipt, so no marker waits there, and an
  expired handoff's fallback walks the same one leg. `--wait` is
  allowed for such a seat: the record is written on its `drop` leg, nothing is typed, and the run
  awaits a reply record on the thread. The watch types no retry, nudge, work drop or ring there,
  giving a held drop up with the reason instead.

- **`team drops`.** The receiving seat reads its own folder under
  `.agents/send-drops/<session>/<seat>`: one row per waiting drop, the sender the record's payload
  names — `the owner`, a seat's name, or a registered name — or, in a raw body file an earlier
  build wrote, the sender its first line names; `unknown` when there is neither, and when a record
  does not verify against the message key. A drop with the signed `<id>.read.json` receipt beside
  it is read, and is not listed — a receipt the key did not sign, or one naming another message,
  seat, checkout or session, proves nothing and the drop is still listed; a name with a dot in it
  is a sidecar, never a drop. Apart from `--read`'s receipt, the command only reads: it moves,
  deletes and marks nothing, and a folder that does not exist yet is an empty one. Only the seat
  itself, on the pane the state records for it, may run it; the owner,
  another seat and a seat on another pane are refused. `--follow` prints
  `from <sender> — <path>` for each drop that appears while it runs — the drops already on disk
  are waiting, not new — flushed per line for a Monitor in the receiving seat, and Ctrl-C stops it
  with exit 0. `--json` prints one `team.drops` document; it and `--follow` cannot be combined,
  and `--read` combines with neither. `--read --seat <seat> [--session <session>]` is the
  launch's own turn-start read: it verifies each waiting record with the checkout's message key,
  writes the signed `<id>.read.json` receipt beside it before printing its body, hands over at
  most ten records a run, and asks for no placed caller, because a CLI's hook runs outside any
  pane. The team file must declare the seat, and a session it is given must be the team file's
  own; a record it cannot verify or receipt is a refusal and its body is not printed. `--read` is
  the one mode that writes, and it writes only the receipt (mode 0600): the drop itself is never
  moved, deleted or marked. `--seat` or `--session` without `--read` is an invocation error.

- **The message record, threads, and `team reply`.** A plain send writes the message whole as one
  signed record — the body, the sender, the rule that admitted the send, and the thread — into
  the recipient's folder at `.agents/send-drops/<session>/<seat>/<id>`, mode 0600, by renaming a
  temporary file into place, in the leg that takes the send and before that leg delivers it; a
  walk no leg takes writes no record. The record is the message, and the typed, drop and
  mcp-inbox legs all carry it. `team messages` reads every record still waiting,
  verifies its signature with the checkout's message key, prints the body and writes the signed
  read receipt `<id>.read.json` in that one step; the seat's inbox server writes the same receipt
  for each message it returns, and verifies the record before anything is shown, so an unsigned
  or tampered file prints no body and leaves no receipt. The history keeps the conversation:
  every line carries `thread`, the first message's id, a reply also carries `in_reply_to`, the
  feed's DETAIL opens a reply with `re <id>: `, and its `--json` event carries a `status` derived
  from the outcome — `sent`, `held`, `delivered`, `read` or `replied` — never a stored one.
  `team reply <id> <text>` answers the sender of a record on its thread: one signed reply record,
  delivered as the drop leg delivers — left in the sender's folder, nothing typed, no frame sent
  — and the signed `<id>.replied.json` receipt beside the record it answers. `team reply <id>
  --close` writes a signed `<id>.closed.json` instead; a thread also ends when its newest record
  is 72 hours old or when it reaches 50 records, and a reply on a closed thread opens a new
  thread that cites the record it answers. A reply goes only to the sender, admitted by
  `reply-on-open-thread`; a record the owner sent has no seat to answer, so a reply to it is
  refused before anything is written.

- **A waited send.** `team send --wait` writes the signed record through the receiving seat's
  delivery walk — `mcp-inbox`, `drop` or `typed`, or `drop` alone when the seat's file marks it
  `human: true`, so nothing is typed into a person's pane — then waits on the thread for the first
  verified reply record until the `--timeout` window (120 seconds by default) closes. A reply makes
  the run `answered` (exit 0); a window that closes with no reply makes it `timeout` (exit 1) and
  leaves the thread open, so a late `team reply` still lands on it, and an answered `--json`
  document carries the thread id.

- **The native leg, as a handoff.** When the recipient's CLI carries the cross-session channel and
  the sender's own file declares `cli: claude-code`, a send to the native leg becomes a handoff:
  the run resolves the recipient live, admits the pair, writes one pending record (0600, a
  temporary file renamed into place), and prints the exact `to:` target, the body and the
  `team send --confirm <id>` line, exiting 0 with status `native`. The sender makes the call;
  `--confirm` takes the record by rename before it writes the one history line (`delivered`,
  `via: native`, the span from the handoff to the confirm) and clears it, so a second confirm
  finds none. The confirm reads the recipient's visible 40 lines for the handoff's nonce
  (`nv-<8 hex>`): the window that shows it records `delivered`, and its absence — or a nonce
  already scrolled off — records `sent (unconfirmed)`. An unconfirmed handoff past ten minutes is
  claimed by a running watch on the sender's team, recorded `native: unconfirmed after 10m`, and
  handed to the remaining legs of the recipient's order — a live inbox takes the body, the drop
  leg leaves it in the drop file, or the typed leg types its trigger — so a late `--confirm`
  finds no record and nothing is delivered twice. A handoff that cannot resolve the recipient's
  live pane or its socket hands the send to the next leg the recipient's order holds, and a
  record that cannot be written refuses. Without a running watch, an unconfirmed record does not
  fall back, and no timer sweeps it: the folder is pruned only when another pending record is
  written or a confirm next reads it, so a record nobody touches again outlives the 24 hours.

- **`team mcp serve`, and the `mcp-inbox` leg.** `team mcp serve --seat <seat>` runs the MCP server
  a seat's launch line starts: two tools over that seat's own drop folder, the seat and session
  fixed at launch, an id a lowercase UUID only, and a receipt written before the body leaves; a
  folder path that is a link at any step refuses service rather than being followed, and the
  listener marker carries the server's pid while it runs, removed at exit only while it still
  names that pid. A send to a seat whose listener is live takes the `mcp-inbox` leg: it writes the
  same 0600 drop file into the seat's inbox and types nothing; the receipt its `inbox_read`
  leaves makes the outcome `delivered (read)` — the seat read the message, never a claim that it
  acted on it — and a wait that ends without one records `sent (unconfirmed)`, exit 0, the file
  being the message safely on disk. A marker absent, malformed, dead or naming another seat,
  session or root is `mcp-inbox: no live inbox listener`, and the walk moves on. A receipt that
  lands after the sender has gone is promoted by the watch — one `delivered (read)` history line,
  nothing typed — and a message still unread ten minutes after the send is handed to the retry,
  which types its trigger once and records `mcp-inbox: no receipt within 10m`; a typed record
  always goes before an inbox one, so an inbox message never delays a held send's retry.
  `team feed` shows one row per message when its outcome moves: the latest line once, in its
  chronological place, keeping the address the send recorded when the later line has none, and a
  `--follow` pass still prints the update.

- **The inbox registered with each CLI, and read each turn.** A seat's launch registers the server
  where a measured route exists: a codex launch line carries the registration itself, with no
  file written into the seat's folder; a gemini or grok seat's launch runs that CLI's own
  `mcp add -s project`, the file it writes being the CLI's own project settings; and a cursor
  seat's launch merges the server into its project MCP config and carries the approval flag, so
  the CLI loads what team registered for it. The server names the seat it launched for, and the
  session it serves is the team file's in the seat's folder. Where that folder is a git work tree
  that does not ignore a file the registration would write, registration is refused, the seat
  still launches on its drop and typed legs, and its line carries the reason. A seat whose CLI
  carries the server is asked, in its rules, to call `inbox_check` at the start of each turn and
  `inbox_read` for each message, then act on what it read.

- **`team bus`, and the project event log.** The owner starts `team bus` in a foreground terminal
  outside herdr, one per clone: it owns the project's event log (`events.jsonl`), appends each
  event as a signed record, runs the reconciliation pass over durable message and seat records
  when it starts and every two minutes after, and serves `publish` and `subscribe` on
  `.agents/bus.sock`; Ctrl-C removes the socket and exits 0. A segment rotates at 100 MB, and
  when the bus starts an idle live file is sealed and the oldest sealed segments are dropped
  whole once their last write is thirty days old or the retained files together pass 100 MB; one
  signed `team.event-log-dropped` record names the dropped sequence range and whether the age
  window or a size bound dropped it, so a reader and a gap-resync see a declared hole rather than
  an unexplained one. Nothing starts it for you in 0.5.1.
  It refuses to start when the caller is not the owner, when a bus is already answering, when
  another start holds the socket lock, or when the socket cannot be bound, and exits 2 on a bad
  invocation or a team file it cannot read. With a bus answering, `team watch` reads new events
  in sequence order and publishes the events its reports imply — `seat.unreachable`,
  `seat.at-prompt`, `seat.prompt-escalated` and `seat.blocked` — to the log, and after a sequence
  gap re-announces the reports that are still true; with no bus running it polls exactly as
  before. The reconciliation pass appends only the events the on-disk records imply and the log
  is missing, keyed by kind,
  record and session, so a pass over unchanged records adds no second
  event. A seat that is not a default recipient may not subscribe itself to a privileged kind —
  a grant, a policy, `seat.at-prompt`, or one the owner has named — and the bus refuses it with
  `privileged-self-subscription`, logs the refusal, and raises `team.policy-refused` to the
  owner.

- **Routing, and the owner's own delivery.** An event's recipients come from its kind's release
  defaults, folded through the routing words in force: a word may add a recipient for a kind,
  and cannot remove one it did not add, and a privileged kind keeps its default owner. A
  recipient may name a seat by its plain name or by the agent registry id that holds it — a
  claimed pane must match the one the registry holds, a retired agent's id names nobody, and an
  id the registry does not know is left as written. An event routed or addressed to `owner`
  reaches the owner with no seat in the path: the machine notification the watch raises and a
  signed record in the owner's mailbox, the list `team messages` reads, so a held or unreachable
  seat silences neither, and the watch's owner report merges with the operator's copy of the
  same observation, so the owner's list holds it once. A kind on the owner's immediacy list —
  `owner-at-once`, an owner-sovereign setting whose release default holds `seat.at-prompt` only
  at a permission, trust, login, vendor-notice or rate-limit prompt, `seat.prompt-escalated` at
  every climb, and `seat.unreachable` and `seat.done` only for the team's lead, plus every
  roster, grant and policy event, both raise kinds and both refusals — rings and lands as its
  own record; everything else collects in the pass and lands as one digest record at its flush,
  and both ids are deterministic, so a watch restarted from cursor 0 rings and writes nothing
  again. `--no-notify` never silences an owner push.

- **The watcher each launch leaves.** The launch plan reads, once per seat, how the seat's CLI
  will learn that a drop is waiting — the turn-start hook the launch installs, the MCP inbox
  server its profile registers, or nothing — carries it through the launch's steps, and stores
  it in the seat's record; `team up --dry-run` names it under the launch line it would type:
  `reads its drops at each turn start`, `reads its drops through its MCP inbox`, or `watches
  nothing: a drop sent here is never read`.

- **A general seat brief, delivered first.** `up` writes TeamCLI's built-in general brief into
  every declared seat's drop folder as one signed message record before the plan types a rules
  line into any pane, human seats included; `add`, `restart` and `reload` write it to the one seat
  they act on and refuse a human pane, so a human seat's record comes from `up` alone. Nothing is
  typed into any pane. The text is the package's own, embedded from its accepted source; the
  record's id is derived from the text, so the same brief has one id in every seat's folder and a
  second run leaves a verified record and its time as they are. A file already at that id that
  does not verify is replaced through the signed record writer, and a link, a folder or a FIFO
  there is refused, never followed. The session's state records each delivery, and `team check`
  opens and verifies the delivered record, naming a launched seat whose record is missing or does
  not verify, with its repair.
  `bun run brief:check` fails unless the embedded text still hashes to its pinned value, and given
  the source it compares the two byte for byte and names the first line that differs; CI runs the
  pin.

- **The command guard a `claude-code` seat carries.** The per-launch settings file a claude-code
  seat loads now carries a shipped `PreToolUse` hook, run by this install's own interpreter
  before every `Bash` tool call, that denies a conservative set of commands and hands the model
  one line of guidance back instead: `chmod` and `chown`, `sudo`, a recursive `rm`, `pkill`,
  `killall` and a `kill` that asks for `SIGKILL`, a `curl` or `wget` download piped into a shell,
  a forced git push (`--force`, `-f`, a `+` refspec), `git reset --hard`, a destructive `git
  clean` (`-f` with `-x` or `-d`), a forced branch deletion (`-D`, or `-d -f`), `dd` and `mkfs`,
  `shutdown`, `reboot`, `launchctl`, `crontab` and `npm publish`. It judges commands, never
  words: a sentence in a quote, a heredoc body and a send body are arguments to the command that
  carries them, while unquoted `;`, `&`, newlines and pipes separate a line into commands judged
  one by one; a leading assignment and the prefixes that run another command (`env`, `command`,
  `exec`, `nohup`, `nice`, `time`, `timeout`, `stdbuf`) are read through to it, and `xargs` and
  `find -exec` are judged as the command they carry. `command -v` asks where a name is and
  passes, and a payload the hook cannot read is left to the CLI, so a CLI that changes its
  payload never freezes a seat. The hook never asks — it allows a command or denies it — and a
  deny wins over the owner's user-wide ask, measured on Claude Code 2.1.302, so an unattended
  seat does not freeze at a permission prompt it cannot answer. A human seat carries no guard,
  because a human's pane is never launched into, and neither does a seat whose launch line names
  its own settings file: the guard rides the one TeamCLI writes. Each deny raises
  `security.refused` with the command's class as the rule and the seat as the object, never the
  command line, which may hold a secret. It is a best-effort net against an unattended prompt,
  not a sandbox: a shell can always reach a command another way, deliberate evasions are out of
  scope, and the climb of an unanswered prompt to the lead and the owner is the backstop.

- **Readable sender names.** A team file or a seat may write `sender_name` — `auto`, `nickname`,
  `seat` or `seat@team` — and every sender headline TeamCLI prints by hand reads by the word in
  force: the first line of a drop file, the FROM cell of `team drops` and `team messages`, the
  SEAT cell of `team feed`, and the display name a claude-code seat's session is launched with
  (`--name`). The default, `auto`, reads a sender inside its own team as its nickname (the seat
  name when the file writes none) and one from another team as `seat@team`, because a nickname is
  unique only inside one team; `nickname` always reads the nickname, `seat` always the seat name,
  and `seat@team` always the address. The word is read nearest first — the reading seat's own
  word, then the team file's, then the project's registry record, then `auto` — so one team's
  file decides how senders read to it. It changes presentation only: every signed record keeps
  the seat in `from` and the registry id in `from_id`, and the `--json` readings keep the
  record's own fields. A feed line records the sender's team with the send, so a sender from
  another team reads by its address and never as a local nickname of the same name; a line
  written before that field reads as the plain seat name. A registry that cannot answer is no
  answer: the seat name stands.

### Changed

- **The default delivery order, and the words a level may add.** A send whose receiving seat
  declares no order walks `mcp-inbox`, then `drop`, then `typed`: the seat's own inbox when a
  server serves it, the 0600 drop file with nothing typed into the pane when one does not, and
  the typed trigger line last. `native` is never in the default — the sender chooses it and
  records the delivery itself — and it is the one leg a declared word may add to the order in
  force; a word naming any other leg the order does not have is still set aside. A seat whose
  file declares no word takes the one its shape implies: a pane marked `human` walks `drop`
  alone, and a CLI whose launch installs no watcher — no turn-start hook and no MCP inbox —
  leaves `drop` out, because nothing on its side would read the file.

- **A human seat's pane is never touched, whichever command reaches it.** `up` skips the seat in
  its plan — no workspace, no launch line, no key — says why, and does not count it short of
  ready; `down` leaves it running, types no exit line and closes no workspace, even with
  `--abandon`; `add` and `restart` name one seat and refuse with that reason. `remove` takes the
  seat out of the file (or marks it stopped under `--keep`) without typing the exit line,
  pressing a key or closing the pane, which keeps running, and its closing line says why in
  `down`'s words. `reload` refuses with the reason before the launch record is read; `answer`
  refuses after the caller admission and before the seat's lock, state or screen is read, and
  names the spare; `register` adopts the pane as before but writes no rules file and types no
  rules line, even when a record written before the mark says a trust dialog is waiting. The
  send daemon refuses a human seat at its own queue — the CLI's walk takes the drop leg alone
  earlier — so no trigger is typed, no frame is sent and no worker is started.

- **`team raise`, and two owner events.** `team raise <kind> <text>` carries one line from the
  team's lead to the owner at once: a signed record in the owner's mailbox, the matching
  `release.ready` or `decision.needed` event, and the machine notification. Both kinds are routed
  to `owner` alone and stand in the owner-at-once list, so the watch rings them instead of
  batching them into the pass's digest, and the record is written under the id the event's own
  delivery would use, so the watch finds it already there and does not deliver it twice. The
  orchestrator's seat, or a seat the file marks `leads`, may raise; the owner and every other seat
  are refused by name, and a lead's seat must be on the pane the state records for it. The same
  kind and line from the same seat within the hour is one record, rewritten as `<line> (×N)` and
  adds no event, and ten raises reach the owner per team per UTC day, an eleventh refused with the
  reason. `--dry-run` reads the log and the record, says what would happen, and writes nothing.

- **Two refusal events reach the owner.** A record or receipt that fails verification — in the
  seat's inbox server, in `team drops --read`, or in the message list — raises `record.invalid`,
  and an identity or admission the send and reply rules deny raises `security.refused`. Both
  kinds are privileged, routed to `owner` alone and on the owner-at-once list, so the watch rings
  them and writes the owner's record at once, never into a person's pane; each event carries the
  refusal's rule and object (a record id, a seat, a path) and never the refused content, and one
  event stands per rule and object in an hour with every occurrence counted in
  `.agents/team.log`, so a refusal loop counts instead of flooding.

- **A prompt that is not cleared climbs.** A seat held at a permission, vendor-notice or
  rate-limit prompt starts a clock, and one still held after `prompt_escalation_seconds` — five
  minutes in this release — reports `<seat> is still at a <prompt> prompt after <n> minutes: the
  team's lead has not cleared it, and the entity's lead and the owner are told` and raises
  `seat.prompt-escalated`, once for that prompt spell; a prompt that clears before the window is
  the lead acting, and its clock goes. The kind is privileged and on the owner-at-once list, and
  its release routing is the entity's own lead and the owner; the owner stands even when the
  registry names no entity lead, so a climb is never silent. The entity's lead is the
  lead-marked seat of the team whose project is the entity — that team's roster, root and
  session — and the climb is left there as one signed runtime record in that lead's mailbox,
  where that team's watch rings it as a message. The team's own orchestrator keeps no clock: its
  `seat.at-prompt` reaches the routing table's lead and operator, and because the prompted seat is
  the lead, it also reaches the entity's lead and the owner; the same mailbox record is left. A
  watch that restarts mid-spell starts the clock again, so a prompt held
  across a restart can climb once more. Nothing is typed into any pane — a climb is an event
  and a record, never a keystroke — so a human seat's prompt climbs the same way. The check is
  one of the five the watch file cannot turn off.

- The Antigravity profile is tested with CLI 1.2.16 to 1.4.2: the 1.4.2 screens — trust, idle,
  unsent, working, question, permission and exit — are captured as fixtures, the trust dialog is
  unchanged, its fresh idle footer carries no model row again as on 1.4.0 — the row appears under
  the box once a turn has run — and the launch test's boundary moves to 1.4.3.

- The Cursor profile is tested with CLI 2026.10.01 to 2026.10.16: the 2026.10.16 screens — trust,
  idle, unsent, working, question, permission and exit — are captured as fixtures, the trust
  dialog still marks `[a] Trust this workspace` with the same key, so that build gets its own
  trust record beside the two earlier ones, and the launch test's boundary moves to 2026.10.17.

### Fixed

- **A receipt file that proves nothing is replaced, not trusted.** The signed read receipt is
  write-once per status for the message and context it verifies for: a signed receipt already at
  `<id>.<status>.json` that names this message, seat, checkout and session is left untouched, so
  a second read adds nothing. A regular file at that name that does not verify — unsigned,
  unreadable, another message's, or signed for another seat, session or checkout — is replaced
  by the signed receipt, so a planted or stale file cannot keep a message waiting forever; a
  name held by a link, a folder or a FIFO is refused, and nothing is written through it.

- `team doctor` names a launch record that carries the pane's process identity and no seat id —
  the one `team seats` shows as `-` in its ID column — with the sibling note and the same repair
  as the process note (`team register <seat>`), and a lead's own seat draws neither note.

- A watch retry never types a held line into a pane back at its shell: it reads the pane's process
  identity under the seat's lock and refuses the same state the typed leg and the daemon refuse —
  no line typed, no Enter, the reason said — and the drop file stays for a person to send again.

- `team reload` says and logs a seat it leaves out. A close re-read that refuses the seat (moved,
  working, replaced process, unsent box) and a rules line whose read-back fails each print
  `<seat>: left out: <reason>` in `up`'s words and write the same line to the log, where the run
  used to say nothing; a rules line this run typed that cannot be read back is cleared with the
  profile's clearing key, the key `up` sends, and its record says the line was cleared and names
  `run up again`. A ready seat still prints only the run's one success line.

- `team drops`, `team messages`, `team next`, `team plan`, `team issues`, `team bus` and
  `team broker` work at a team root that is not a git repository. Each resolved its root through
  git before reading the team file, so a folder holding `.agents/team.yaml` outside any checkout
  was refused with the no-repository sentence; each now takes the shared resolution — the
  enclosing checkout, or the plain root in this folder. A folder that is neither a checkout nor a
  team root keeps the no-repository refusal and exit 2, and an unreadable or invalid team file
  keeps its own exit.

- `team reply` admits a placed seat in its own session. A seat a real launch placed carries its
  session in the session-aware reading only, and the command judged the sessionless one, so the
  seat's own reply — and its own `--close` — was refused as `a caller of another session is not
  that seat`; it now judges the same session-aware placement `team send` does.

- `team init` keeps `.agents/send-drops/` out of git. The exclude list it writes to
  `.git/info/exclude` — never `.gitignore` — names the drop folder beside `.agents/messages/`, so
  the records a send leaves in a seat's folder never show up as untracked changes.

- **`team init` keeps the bus's start files out of git.** The exclude list now also names
  `.agents/bus.sock`, `.agents/bus.sock.lock`, the lock's takeover claim and the private temp an
  atomic create keeps, beside the broker's own entries, so a running bus no longer leaves an
  untracked socket and lock in the checkout. The bus's event log and its sealed segments live in
  the project store, not in the checkout, so nothing else under `.agents` is missing.

- **A running seat's draft is never typed over by a direct send.** The direct typed leg read a
  running turn as an empty box — the caution stages run before the composer stage — so a send
  typed its trigger into a draft a person had written during the turn, and the first Enter
  submitted both. The composer below a working screen is now read too: when it holds unsent
  text, nothing is typed and the send is `held` with the box's text, the record and the pending
  marker are kept, and a running watch retries it when the seat is idle; a clear composer on a
  working screen still takes the line. The same read backs the one guard the daemon, the retry
  and the nudge share, so every typed path judges a working screen by its composer.

### Known limits

- The event thresholds ship as fixed defaults; an owner-only `team policy set` for them comes in
  0.5.2.

- No team can override the general seat brief yet: it is TeamCLI's built-in default, shipped in
  the package, and every team receives that text. A registry-held definition, overridable by an
  entity or a project, is deferred to 0.5.2.

## [0.5.0] - 2026-10-18

The first release since 0.3.5, and the first on npm since it. The file in the clone is the
record: `team approve` is no longer a command, the commands read the file itself, and a seat
that is already running is written into this machine's registry so the rest can reach it by
name. A send says which channel it took; a team names the project
it sits in; each seat's state and the two sidebar lines beside it say what it is doing and where
that reading came from; and grants, delegates and holds put the owner's decisions where the
commands read them.

### Added

- **One output contract, and `team --about`.** Every command prints under one contract across its
  plain text, `--json` documents, `--help` usage and exit codes: a reading opens with
  `team <project>, session "<session>"` (or the project line), prints an uppercase-headered
  table, notes and any `difference:`/`repair:`/`who:` blocks, and closes with one summary line; an
  action prints its plan steps under `--dry-run` and one summary line. `--json` prints one
  document per command, its `schema` first (`team.<command>`, format 1) and a refusal as a
  `team.error` document carrying the contract's exit id and repair; the schemas are published
  under `schema/`. Output is quiet by default: stopped seats wait for `--all`, repeated notes
  collapse to one line with `(x<n>)`, the `what 0.5.0 must not pretend` block prints only in
  `team doctor` and `team --about`, and a deprecation warning only in `team check` and
  `team doctor`, with its repair. Colour reaches a terminal only — never `--json`, never under
  `NO_COLOR`. `team --about` prints the version, the licence, the docs link and the block; `watch`
  and `broker` keep their foreground loops and take no `--json`.

- **The registry, and `team register`.** The machine keeps records of the agents it has seen, the
  teams and the projects they sit in, under `~/.config/team/`. `team register <seat>` writes the
  record for one seat that is already running — a pane herdr places under that name, holding a
  CLI at the seat's prompt — so `team send`, `team seats`, `team watch` and `team down` can
  address it. It types nothing into the pane, and a pane change re-records the same agent rather
  than a second one: a record's identity is the file's seat under its team, never the pane.
  Records are appended, never deleted — a removed seat is marked ended and its history stays
  readable — and a record confers no right. The record also carries the seat's pane, which binds
  the sender: only a caller standing on the pane its own record names acts as that seat. A send
  reads its delivery pane live, by the seat's name, so a pane that closed or was reused since the
  record was written is never typed into; a claude-code seat's cross-session socket address is
  recorded for `team route`.

- **`team send`, and the channels a seat is reached on.** One message to one seat, ending in one
  confirmed outcome: `delivered`, `answered`, `held`, `not-submitted`, `timeout`, `unreachable`
  or `refused`. A send walks the receiving seat's delivery order — `native`, `mcp-inbox`, then
  `typed` when no level of the seat's chain changes it: the entity, the project's registry
  record, the team file's `delivery_order` and the seat's own each may drop a leg or reorder the
  ones it keeps, never add one — and 0.5.0 carried no `mcp-inbox` leg and opened no socket, so
  every delivery it made went by the typed leg, and each leg the walk could not take was
  recorded `unavailable` on the history line. A plain send gives the seat the body whole in a
  mode-0600 drop file and types one short trigger line naming it — the body is never typed, and
  never split — for every seat, Claude Code's included: a socket write to a busy session can land
  at its held-message dialog, where the box is blocked, so no path opens a cross-session socket
  at all. A waited send walks the same delivery order — `--wait` writes the record as a plain
  send does and then waits on the thread for the first verified reply record (see the waited
  send above). A seat the receiving team file marks
  `stopped: true` is not addressed at all: the send, its dry run and `team route` refuse it as
  stopped, with its own exit id, before a drop file exists, a leg is walked or a history line is
  written.
  `--json`, `--file`, `--dry-run` and `--list` round it out. The native channel is the sender's
  own half: `team route <seat>` answers the address a delivery from the sender's cross-session
  tool uses — the recipient's agent id, session, CLI and pane, and its socket — and
  `team send --record <seat> --channel native --ms <n>` writes that delivery down, one
  `via native` history line, the body not passing through the CLI. A message's body is written
  down in the project's history, which `team feed` reads, with the send-to-outcome milliseconds
  and the path it took; the refusal for a seat no record covers names the command that writes
  one (`team up`, `team register <seat>`).
  A seat its file marks `assistant: true` — one per file, never a seat with `count` — is its
  entity's assistant, and the routing admits it to the entity's coordinator: the first mark
  found walking the entity's teams in chain order, the entity's own team first and then its other
  teams by team id, never a role's name. Send is denied by default: the owner may send to any
  agent; an orchestrator to an orchestrator of its own team or of a team in its entity, never
  across entities; a team's orchestrator or operator to any seat of its own team; an assistant
  to its entity's coordinator; any seat to its own team's orchestrator; and an owner-signed
  `send` grant to what it names.

- **The send grammar: `@<nickname>`, `<seat>@<team>`, `lead@<team>`.** One grammar answers
  `team send` and `team route`: an agent id (`agt_` and twelve hex), `@<nickname>`,
  `<seat>@<team>`, `<nickname>@<team>`, `lead@<team>`, or a bare seat or nickname of the caller's
  own team. `<team>` is a team's registry id, its project or its session, as the record spells
  it. `lead@<team>` reaches the seat its file marks `leads: true` — never a seat merely named
  `lead`, and never a role's name — and a team with no lead is refused, because there is no one
  to deliver to; a roster marking two leads refuses the address, naming both. A nickname is the
  file's `nickname:` line, unique inside its team and free to repeat across teams:
  `@<nickname>` asks the caller's own team first, then the other teams of its entity, and from a
  folder that is no team every team the registry holds. Exactly one match sends; several are
  refused, each named by the `<nickname>@<team>` spelling that picks it; none points at
  `team send --list`. A spec two roster entries answer — one seat's name and another seat's
  nickname of the same team — is refused naming both, before anything is typed. Every form
  resolves to one seat's registry record before admission runs, and admission judges that
  record's seat: a nickname added or removed never changes who may reach whom. A full address
  reaches another team from any folder — and from a folder that holds no team file, where that
  send is the owner's — the receiving team's file judges it, and the drop lands under that
  team's `.agents`; a bare name from a folder that is no team is refused with the forms that
  need none. `lead` is reserved from this release on: no new seat and no nickname takes the
  word, and a file written before it that declares a seat named `lead` still loads and answers
  its bare name, `team check` noting the repair `team rename lead <new-name>`. A history line
  keeps the address as written: where the caller wrote a form rather than the seat's name, it
  carries `spec` and `resolved` (`agt_…`), and `team send --list` prints each seat's `NICKNAME`
  — `-`, an `@<nickname>` in the file's own roster, a `<nickname>@<team>` in another's.

- **A lead from a 0.3.5 or 0.4 file is still the lead.** A team whose lead seat still carries the
  old role word `coordinator` is judged by its file, never the word: an orchestrator of the same
  entity reaches it by `lead@<team>` or its seat address, exactly as for a file written for this
  release, and `team check` notes the 0.5 word, `role: orchestrator`, without a difference or an
  exit change.

- **A held send is retried, not abandoned.** When a typed send leaves its drop because the
  seat's composer held text, the seat did not take the trigger, or a dialog was up — `held`,
  `not-submitted`, or an `unreachable` that is a dialog — send writes a pending record beside
  the drop, and a running watch delivers it on a later pass: only when the pane reads `idle` or
  `done`, its box is free or holds nothing but that send's own trigger line, and under the
  seat's lock, so a retry cannot interleave with a new send. A trigger line the failed send left
  unsent is submitted with the Enter and never typed over. The retry is bounded to three tries
  within thirty minutes; a delivered retry is written into the history, and a give-up names the
  sender and the recipient seat, says why, points at the drop while it is still there and asks
  the sender to send it again. A record whose drop file was moved or removed is given up on
  rather than typed, and the age bound is applied before the pane is looked for, so a vanished
  seat's record still ages out. The send's held, not-submitted and dialog lines name the drop
  and the retry — a dialog's reads `unreachable now (the screen reads <kind>); a running watch
  retries it when the seat is idle; the drop file is at <path>` — while a send through the
  daemon keeps no record a watch reads, so its not-submitted line promises no retry.

- **Projects.** Entity, then project, then team, then seat. A team names its project in its team
  file, a team that names none is its own project, and a team two projects name is refused by
  `team check`, naming both. `team projects` lists the registry's projects — immutable id,
  display name, entity, lead and teams; `team status --project <name>` covers every team of one
  project; `team send --list` shows each addressable seat's project. Settings inherit through
  the four levels — a lower level may tighten, and loosen only where the level above allows it —
  and the first project-level setting, `seats_cross_teams`, decides whether a seat may cross
  teams within its project. Within a project the project lead and its teams' leads are admitted
  to each other, by capability, never by a role's name.

- **The lobby, recorded per session.** A team's seats work in its lobby: the file's explicit
  `lobby:`, else the lobby the registry recorded for the session, else
  `~/.config/team/lobbies/<entity>` for a team that names an entity, else
  `~/.config/team/lobby`. The record keeps one entry per session — `up --session alt` records
  its own, and neither replaces another's — and once a session is recorded, editing the file's
  `entity:` never moves it; a record written before the map reads as one entry.

- **Seat state, and the words beside it.** `team seats` prints the seat registry: one row per
  seat with its stable handle (`seat_<12 hex>`), role, CLI, model, effort, status, state, source,
  last active time and pane; `--all` adds the stopped rows, and `--watch` refreshes the table
  every two seconds. STATE is the word — `working`, `idle`, `blocked`, `done`, `held`,
  `unreachable`, `unknown` — and SOURCE is where it was read: the pane's screen, the CLI's own
  hook files (`cli-hook`, valid 24 hours; a working reading carries the 120-second window),
  herdr's word, the seat's newest trace (a commit, an ack or a message) or its process; a seat
  no source has heard from past the blind threshold reads `unknown (blind)`, and counts as not
  working.
  `team status`'s rows end in the word a send would use — `socket` or `typed` — and
  `team status --all` prints the expanded columns. The pane's two sidebar lines — its workspace
  label and the display line under it — are the file's own text, re-applied from the file by
  `team register` without a relaunch, and `team check` reports one that reads as neither.

- **`team rename`, and the seat numbering.** `team rename <seat> <new-seat>` renames a seat in
  the live team file and carries what the old name held: the file's references to it — the
  `coordinator:` and `operator:` lines, a `grant:`'s `seat:` — the registry record under its
  agent id, the herdr agent's name, its task leases, pending send-drops, mailbox messages (a
  signature this machine can check is remade under the new name), its rules, queue and notes
  files, the state's records and the message history, so nothing is left addressed to a name no
  seat holds. Comments, order and every other seat stay as written: the edit is by the line,
  never a rewrite of the file. `team rename --renumber [--dry-run]` rewrites every numbered seat
  to the width and separator the `seat-numbering` setting in force asks for (`builder-1` →
  `builder-01`), leaves a name with no number plain and skips a seat written with `count`; a dry
  run prints each `from -> to (dry run)` and writes nothing. A seat number is read as a number,
  so a roster naming the same role and number twice — `builder-1` beside `builder-01` — is
  refused at load rather than left for an address to pick between. The owner or `leads` renames;
  a target already declared, a target another seat's nickname holds, a counted seat renamed
  partially and a name outside the seat grammar are each refused with the reason. A verified copy
  of the file this machine still holds is carried across the rename where the renamed digests
  match it, so a rename alone reports no drift.

- **Three more launch profiles.** `grok`, `gemini` and `muse` join `claude-code`, `codex`,
  `cursor` and `antigravity`, each with its own screen reading, unattended flags, login check
  where the CLI offers one, and tested range. The Claude Code profile is tested with CLI
  2.1.288 to 2.1.302. The Antigravity profile is tested with CLI 1.2.16 to 1.4.1.
  The Codex profile is tested with CLI 0.157.0 to 0.161.0.

- **Jules as a pane seat.** `jules` joins the profiles with its 0.1.42 CLI: a send to a jules seat
  still writes its drop file, and the body is typed through the CLI's own screens, so a new
  remote session on the seat's own repo is the delivery. A seat sends only to the repo of its own
  folder; when the account's repo list does not hold that repo, the send is refused with nothing
  typed rather than sent elsewhere. The profile never deletes a session: a turn is ended with
  `ctrl+c` alone, and every jules seat's rules carry `Never delete a Jules session.` herdr cannot
  report a jules pane's agent, so the profile declares `herdr_status: unreliable` and the screen
  is the reading — an idle session table is a free seat, a running card a working one — across
  `status`, `check`, `watch`, `list` and `down`.

- **Grants, and delegates, the owner's alone.** `team grant <seat> --scope <acts>` sets the team
  file's one grant — the seat the file's orchestrator marks, and the complete scope it may run; a
  later run replaces it exactly — and `team revoke grant` removes it. `team grant <seat|@team>
  --capabilities <cap,...>` writes a standing grant record in the shared grants folder — a seat
  resolved to its registered agent's id, `@team` to the project's team id — out of the closed
  vocabulary `write`, `read`, `review`, `gate`, `merge`, `deploy`, `act-as` and `use-broker`,
  with `--expires`, `--name` and an optional `--scope` of paths; a team grant never carries
  `grant`, `create`, `agree` or `leads`, and naming one is refused with the rule. The records
  are signed and read fresh at every use: a revoked or expired grant admits nothing, and
  revocation is its own appended record, never an edit of the grant — `team revoke <name>`
  appends it. `team delegate <session/pane> --commands <acts>` records one pane outside the
  team, up to eight, and `team revoke delegate` removes one. A create-grant — a record in
  `~/.config/team/grants/` naming its holder by registry identity, `agent:` an agent id (`agt_`
  …) or `team:` a registry team id, with the paths or entity it covers and its expiry — admits
  its holder to `init`, `up`, `add` and `remove` under those paths until the record expires.
  The holder is the caller's own registry record while it is running, placed by the session,
  pane and seat it stands as, and a team record admits an agent registered to that team; the
  owner, an agentless pane and an unplaced process have no registry record, so no record admits
  them. A record spelling a name, a seat, a pane, a session or a runner grants nothing, and one
  naming both `agent` and `team`, or no holder, is skipped with the rule. Every one of these is
  the owner's, from a terminal outside herdr, with a `--dry-run`, and none can widen its own
  entry.

- **The work queue.** `team issues` lists the typed records in the one file the team file names;
  `team next` claims one, held by a lease in this clone (`--mine`, `--release`, and `--wait` at
  the file's `tasks.cadence`); `team plan` prints the queue a claim would consider and claims
  nothing, a passed deadline marked `(overdue)` and never dropped or reordered; and `team broker`
  — the owner's foreground process, one per clone — holds the tracker credential and answers
  `team next` over a local socket, with the
  file's `tasks.policy` filtering every record before it crosses. A broker runs as the same OS
  principal as the seats: that is integrity, not authenticity, and it isolates nothing.

- **The rebuilt `team usage`.** `team usage` reads the machine rather than one project: every
  team it keeps a store for, the caller's own project among them whether or not it holds one, in
  one report — each account and window with what is left and used, when it was last read and from
  which source, its reserve and its state, under the account table and a closing line that counts
  the machine's teams, labs and accounts. Anyone may run it from any folder, and it changes
  nothing: no check runs, nothing is written, no credential, key or CLI session file is opened. It
  does read the seat panes herdr records and may run a CLI's own usage command where a seat runs
  one, bounded by a fifteen-second timeout. The owner at a terminal reads the machine's
  subscriptions and the caller's team, and `--all` adds every team's seat-to-account rows; every
  other caller reads the restricted view, a closed list built before anything prints. `--tree`
  adds the quota view between the account lines and the team tables — one block per lab and per
  account, each window with its margin and state — while the one `advice:` line, printed either
  way, names the accounts with headroom or where a walled seat should move. Shared machine
  subscriptions live once in `~/.config/team/accounts.yaml`, and `--json` carries the same report
  as one document, format 1.

- **Around the seats.** `team list` shows the herdr sessions on this machine — the running ones
  unless `--all`, `--seats` for the active breakdown, `--watch` to refresh every two seconds;
  `team feed` reads and follows the project's message history, `--all` merging every project on
  the machine; `team messages` verifies a waiting message, prints its body and writes the
  receipt; `team proc` keeps the processes the seats started as a register in the team's state;
  `team hold <reason>` places a note on the team's work (`--release` clears it) that `status` and
  `doctor` show; `team tempo`
  sets the watch's pace; `team lock` and `team unlock` take and release a named machine lock, so
  one heavy run holds it at a time; `team mcp status` and `team mcp doctor` read the MCP bridge's
  legs; `team ask-show` prints one signed ask; `team reload` and `team restart` bring a later
  model or effort edit to a seat already running; and `team worktree list` joins the worktree
  set.

- **`team check` is integrity, not authority.** It reads the file, the state, herdr, the
  registries and the agents' records, and reports the differences alone, each with its repair: a
  reading of whether the records agree, never a grant. No approval, no launch and no right
  follows from a clean answer. The owner's `--repair` is its one write: it drops the state's
  leftovers — a record for a seat the file no longer declares, with the pane it claims, and a
  session the state holds with no seat of the team in it — re-checks each against the state on
  disk, prints one `repaired:` line per drop and logs it. Herdr is not asked which records are
  leftovers: the state's own claims are the subject. The repair still waits on the live read, so a
  check whose herdr cannot answer drops nothing; a temporary seat is never a leftover, and neither
  is the file's own session or the one the run checks.

### Changed

- The file in the clone is the record: the commands read it, and `add`, `remove` and `down` keep
  going when no approval record exists. `team up` admits the owner or the team's lead seat; where
  that refuses, a `delegates` entry whose commands include `up` or a seat the file's verified
  `grant` names for `up`. Anyone else is told `deny` and exits 1, and a dry run says what the
  real one would (`! up would refuse:` with the reason, `! to unblock:` with the owner's run of
  this folder, then the plan).
- `team up` gains `--serial`, launching and waiting on one seat at a time, and a fresh
  orchestrator or operator seat starts in the project folder and every other seat in the team's
  lobby.
- The watch runs in a herdr workspace of its own, labelled `Watch · <project>`: `up` ends its
  plan by creating it and running the watch in its pane, and a bare `team watch` from the owner's
  terminal hands itself there and returns — a `--no-nudge` or `--no-notify` run stays in the
  caller's terminal. The state records the pane, the pid and the heartbeat; `team status` shows
  them, and `team check` flags a heartbeat older than two in-force cycles.
- `team down --wait` gives a working seat up to 120 seconds to come free and leaves one that
  never does running; an agent still in the session keeps it up, and a pane is closed only where
  the state records it for one seat.
- `team status` is gated like the other commands (`team status: this team is not yours to read`),
  prints a hold as its first note, and marks a rate-limited row `(rate limit on <account>, resets
  at <time>)`; its drift line reports the effort on its own when the model matches and only the
  effort differs (`<seat>: effort <seen>, file says <effort>`), and an effort the file never
  declares is never a drift. `team doctor` prints a hold line and cleans every line it prints of
  escape sequences and invisible characters.
- `team watch` nudges any idle seat, not the operator's alone, and announces a waiting message
  with `Team: run team messages`; it reports a seat stopped on its provider's connection error or
  at a rate limit, naming the account and the reset time, and types into neither screen; a
  temporary seat is left as it is for the owner to remove.
- **A report meant for the operator stays out of the panes.** `team watch` writes it to
  `.agents/team.log` and the desktop notification, never typing it into a free seat; the only
  lines it types are a work drop's line naming its file and the message ring, and an attention
  report a flickering screen shows is said once, not every other pass.
- `team add` takes `--model` and `--effort` (the owner's, on a declared seat) and starts a
  temporary seat from `--temporary --like <seat> --until <end>`; `team remove <lead> --keep` then
  `team add <lead>` replaces the agent on a lead's seat without stopping the team, and a removal
  by a caller other than the owner leaves the pane running, renamed `<name>-left`.
- `team list` shows the registry beside discovery: a registered team and its seats join the rows.
- `team worktree` gains `list` and `remove --branch <name>`, and reads the live file's workspace
  values. `team release check` warns when npm's `next` dist-tag points below `latest` and prints
  the exact `npm dist-tag add` command, without running it.

- `team check --repair` settles every finding the file alone can settle, in one owner-signed
  run: besides the state's leftovers, it re-records each seat an agent registered under dev
  mode, clearing the mark the way an owner's `team register <seat>` does, and sets herdr's
  drifted workspace label and display line back from the file through the same two writes
  `team register` makes. Each written line is printed as `repaired:` and logged as its phase
  finishes, and a sidebar write the session refuses prints the line it could not report. A
  model drift keeps its relaunch advice: the repair never starts, stops or relaunches a seat,
  and it stays owner-only. Under a governing dev-mode policy the check's rows still collapse to
  one quiet count, and `--repair` clears the marks behind it.

### Removed

- `team approve` is no longer a command: `team up` admits from the live file, and `add`, `remove`
  and `down` keep going when no approval record exists.

## [0.3.5] - 2026-10-07

A release about a seat whose screen nobody can read: a caller other than the owner can now let
it go on herdr's word alone, and `team status` and `team watch` say so instead of staying quiet.

### Added
- `team remove <name>` from a caller other than the owner: a seat herdr reports `idle` or `done`
  is taken out of the team without typing anything into it — the state record is dropped and the
  pane's agent is renamed best-effort to `<name>-left` (or `-left-2`, and so on), leaving the
  pane running for the owner to close. `--keep` marks it stopped with the same line instead. A
  seat herdr reports `working` is never taken out.

### Fixed
- `team status` marks the row when the profile cannot read the seat's screen: an idle or done
  seat reads `<state> (screen not recognised)`.
- `team watch` reports a quiet seat on an unrecognised screen instead of going silent.

## [0.3.4] - 2026-10-07

A release about reading a machine and reading a file: `team usage` reads every store this
machine holds into one report, under one resolved view — the owner at a terminal reads the full
one, every other caller the restricted one — and every line that carries a figure may carry its
pace; a pane the approved file names as a delegate may approve the ordinary changes, a roster or
a launch line or a rule, and can never approve a change to its own authority; and the credential
warning's path exemption is the filesystem's own verdict, so a path-shaped word that is not a
real directory warns.

### Added

- `team usage` reads the machine: every store this machine holds into one report, under one
  resolved view. The full view is the owner at a terminal; every other caller reads the
  restricted one, and a process with no terminal of its own is placed `owner-no-tty` and still
  reads the restricted view, closing the no-terminal forgery. The text and `--json` render from
  one document, so they cannot disagree, and nothing a read of another team produced crosses it:
  no name, no root, no rows, no problems in their own words — each family one fixed sentence,
  counted — no seat on another team's machine line, and no figure of an account the caller's own
  file does not name. `usage.outside` is gone: a run outside every project is a note and exit 0,
  and `usage.store` is the command's one refusal.
- Every stored reading may keep the point before it — the figure it replaced and the moment it
  last moved — and every `team usage` line that carries a figure may end with its pace:
  `pace <n>%/h`, used points per hour, signed, one decimal, or `pace not known` where the state
  holds no usable pair. A restricted line whose newest reading is another team's ends without
  one: that pace is withheld, and nothing stands in its place.
- `team approve` takes a delegate: a pane the approved file names in `delegates:` with `approve`
  among its commands may approve the ordinary changes — a seat's line, a rule — under a
  fail-closed allow-list judged before anything else is read. The `rules` section and the seat
  differences pass; every other owner section is refused by name (`this change needs the owner:
  <what changed>`), including any section a later version adds, so a delegate can never approve
  a change to its own authority — `delegates`, `limits`, `trust`, `budgets`, the workspace whose
  `setup` runs commands. An ordinary difference rejoins the owner's path — the same key guards,
  the same signed record, the same store, `--confirm` inert and no terminal read — and leaves
  one audit line in the log; the owner's run is untouched and approves anything.

### Fixed

- The credential warning's path exemption is the filesystem's verdict: an absolute-shaped word
  is exempt only when `lstat` says it is a real directory — fail closed on an absent path, a
  regular file, a symlink to a directory (`lstat`, never `stat`), or any error — so a credential
  in path clothing warns again, and the runner's real project directory stays quiet.

## [0.3.3] - 2026-10-07

A release about names and evidence: the bare `team check` reads the team itself and answers with
its differences, a ref's check moves to `team commits check` and a pull request's to
`team pr check`, the seat that leads is `leads: true` and its word is orchestrator, and
`team usage` reads one project's budgets and approvals back, read-only. The machine gate and the
watch leave their readings in the log, `doctor` and `status` say when the machine's total swap
sits under what the check asks, a refused run remembers nothing and a refused dry run exits as
the real run would, and the READMEs say plainly what the owner refusal is — and is not.

### Added

- `team check`, bare — every word `--session` or `--file`, or none at all — reads the team
  itself: the caller gate in its decided order, one screen pass over the panes the state records,
  and each difference with its repair. It is a read: it writes nothing, `remember` is false for
  every caller, and a caller the gate refuses gets one fixed sentence and nothing else.
- `team usage`: one project's block, read-only — the budgets in force as `status` prints its
  rows, the watch line, and a note where the state cannot be read; `--json` carries the same
  reading as one document. Every name it prints comes from the one approved copy in force, never
  the live file; a block whose file names no account prints the ruled sentence under its rows,
  and accounts the approval does not back print the tool's own why-line.
- `doctor` and `status` say when the machine's total swap sits under the figure the check asks:
  the figure, the total at this reading, that `team up` would refuse now, and the repair — set
  `machine.swap_free_min`, then run `team approve`.
- The machine gate and the watch leave their readings in the log: a machine refusal in `up` and
  `add` logs the line and the figures it was decided on, and a watch pass logs what it read at
  most once per ten minutes, `unread` where a figure was not taken.

### Changed

- The seat that leads is a field: `leads: true` on that seat, and the word for it is orchestrator
  in every text. The `coordinator:` key still selects it, printing one notice per file, and an
  approval over either spelling holds for both; `dialogs.trust` takes the new word too.
- `team check <ref>` becomes `team commits check <ref>`, and its `--pr <file>` half becomes
  `team pr check <file>`, which checks one pull request body alone and needs no repository; every
  printed line that names the command names the new one. The old spelling is read through 0.3.3,
  one notice line per half on stderr before the run's own bytes, the commits one first.
- The shipped examples lead on no single lab: the README's walkthrough says any CLI fits any
  role, and the example teams lead on cursor and codex.
- The READMEs say what the owner refusal is: a guard against a mistaken agent, not a guarantee
  against a hostile one — a seat that forges the owner's placement is a known limitation, being
  hardened.

### Fixed

- `team approve`: the paste guard reads the command's own terminal and answers three ways — only
  an input read empty lets the write through, a box waiting on input refuses
  (`approve.input-waiting`), and a terminal that cannot be read refuses apart
  (`approve.input-unreadable`) — and is proven under a real pty. The signing key is created only
  after every refusal has had its chance: a refused first approval writes no key, record,
  generation or log. A key that exists and cannot be read refuses before the question, not after
  it.
- A run refused before it acts remembers nothing: a dry run, a `down` that finds the session lock
  held, and a watch that finds one already running leave the state file as it was, and the caller
  gate answers before the file is remembered.
- A refused dry run exits as the real run would — the status and the exit id are that refusal's,
  and nothing is written; it returns a refusal only where the real run would refuse before doing
  anything, so the plan still exits 0 and the pages list the later failures it never takes.
- A log write that fails is dropped, never the command's exit or a watch pass: the log is
  evidence, never a decision.

## [0.3.2] - 2026-10-06

A release about repairs, found on the first day of 0.3.1: `down` and `remove` stop a seat and
clear what the stop leaves, a CLI's own exit question is answered in both the forms it draws
where its profile declares the key, every key follows a fresh check of the pane, a delegate can
start a team whose session is down, one run at a time takes a session, the lobby may hold the
files the shipped profiles declare, the watch's nudge waits for its text and is sent only as
the watch's own, `up` resumes its own interrupted launch, `status` shows no model it did not
verify, and a stop clears only the exit text it typed.

### Added

- `SECURITY.md`: how to report a weakness in private — the repository's security advisories,
  never a public issue, discussion or pull request — what to include, what we do, which
  versions get fixes, and what is not one.

### Fixed

- `down` and `remove` stop a seat: the exit text is typed into a box read empty and idle, read
  back, and only a box that reads back as exactly the typed text gets the Enter (0.3.0 and
  0.3.1 read the screen once, an instant after the typing, too early for the pane to have drawn
  the text, and never pressed it).
- A CLI's own exit question is answered where the profile declares a key for it, in both forms
  Claude Code draws — its second row "2. Stay", or "2. Move to background and exit" with
  "3. Stay" under the marked "1. Exit and stop tasks" — and never when the frame is anything
  else: the second choice is never what a stop sends. A profile that declares no key leaves
  the seat running, and the line says so.
- Every key the stop sends — and the watch's nudge — follows a fresh check of the pane taken
  after each wait: the CLI is the pane's foreground process and is not mid-turn, read again at
  the key, never reused from before the wait.
- `--abandon` closes a seat this run asked whose exit could not be typed or confirmed, and the
  line names that close.
- `down` clears the session it stopped itself: it waits until herdr lists the session stopped,
  deletes it, and the line reads `session <name>: stopped and cleared`. `up` clears a stopped
  session this team's state records, then starts it.
- A delegate can start a team whose session is down: a session that is not running has no seats
  to collide with, so the gate no longer reads "nothing listed" as "herdr does not answer".
- One `up`, `add`, `down` or `remove` runs at a time per session: the run takes the `.run` lock
  before its first effect, a second run is refused naming the pid that holds it (`up.run-lock`,
  `add.run-lock`, `down.run-lock`, `remove.run-lock`), and a lock left by a dead run is taken
  over by the next.
- The lobby's allowed files are the union of what the shipped profiles declare, whichever seats
  a run starts: one folder per machine, so another team's Claude Code lock
  (`.claude/scheduled_tasks.lock`) no longer blocks a team with no Claude Code seat, `up`, `add`
  and `doctor` read the one set, and `doctor` names the profile each declared file present
  belongs to.
- `up` resumes its own interrupted launch: a seat whose pane was made but never renamed — a run
  interrupted in between — is read as this team's half-finished seat and resumed, not refused
  as a stranger.
- `status` shows no model it did not verify: a row whose name does not match shows the model
  its screen names, or `(unread)`, never the model from the file.
- `down` and `remove` clear only the exit text they typed: a box holding other text is not
  typed onto, and a box already holding exactly this exit text is cleared with the profile's
  one key first, never sent.
- The watch's nudge waits for its text to be drawn, reads the box back and re-reads the pane
  before the Enter, and a box it finds already holding the line is sent only on the record of
  the same watch process's own typing — the same fixed line typed by a person, or found by a
  restarted watch, is never typed over, sent or cleared.

### Known limits

Unchanged by this release:

- `add` on a stopped session still asks for a manual clear: `herdr session delete <name>`.
- A delegate still cannot pass `--abandon`.
- A seat whose CLI has already exited (its pane holds a bare shell) is left by `team down` — the
  screen is not one the profile recognises — and closed by `team down --abandon`.
- A `team up` started within a second or two of a `team down` that left the session up can report a
  seat the down has just stopped as left at launch — `left out: its pane has been back at its shell
  for <n> s and shows no CLI prompt; left at launched`, and `run team up again to resume it` —
  running `team up` again starts it.
- `team approve` still asks its question.
- A delegated `up` never answers a trust dialog or a vendor notice: the seat is left out —
  reported, its workspace closed without input, nothing typed into the dialog — and the dialog
  is the owner's to answer.
- The lobby recheck cannot see a rewrite in place inside one filesystem timestamp tick that
  changes no size — every number it reads would be the same.
- The default machine check asks for 2 GB of free swap before a launch; under it, `up` refuses.
- A refused `team approve` run by an agent on a machine that has no signing key yet still makes
  the machine's signing key on its way to the refusal: the key folder and its key file are left
  behind, no approval is written and nothing is signed; fixed in 0.3.3.

## [0.3.1] - 2026-10-06

A release about delegation: a team's owner approves, once, which panes outside the team's own
session may run `up`, `down`, `add` and `remove` for that team, and every delegated run is
matched on session and pane id against a file that is exactly the approved one.

### Added

- **`delegates`**, a team-file section (owner section, one to eight entries): each entry names a
  pane — `<herdr session>/<pane id>`, matched whole and case-sensitively — and the operational
  commands of `up`, `down`, `add`, `remove` it may run. Entry order and command order are part
  of what the owner approves. A pane in the team's own session is refused at load, and so is
  `seat:` or any other key.
- The **delegate gate**: the four commands decide a delegated run in preflight order and refuse
  a caller that is not the approved pane, a command the entry does not list, prohibited flags, a
  file that is not exactly the approved one, or a pane that collides with a seat or with the
  team's session. A delegated run writes one line to the file's log naming the pane and the
  command, and the four commands' own delegate refusal ids are in the exit-code contract.
- `team approve` prints one `Delegate: pane <pane> may run <commands>.` line per entry, before
  the seat-count question.
- `docs/team-file.md`: the format page, with the `delegates` section.

### Known limits

Not in this release: `approve` by a delegate — never, approval is the owner's, and a `commands`
list naming `approve` is a load error; `--abandon` by a delegate — never; restarting a running
seat (needs a `team restart` that changes no file); status, doctor and their JSON for a delegate
— next.

## [0.3.0] - 2026-10-06

A release about setting a team up and upgrading it: one lobby per machine, signed approvals, a
caller gate bound to the pane the team recorded, a launch that reports one line per seat and waits
for its owner at a dialog, and, in the repository, the launcher package `@teamcli/cli`, published
in a later release. **Three changes are breaking; read UPGRADE-0.3.md before upgrading a running
team.**

### Changed

- **Breaking:** seats now start in a machine-wide lobby at `~/.config/team/lobby` instead of a
  `.lobby` folder beside the project's worktrees, and `trust:` entries must be absolute folders that
  include that lobby. A file from an earlier release still reads (`status`, `doctor`), but `team up`
  and `team add` refuse it until `trust:` is migrated and approved again; `team doctor` and
  `team up` print the whole block to paste.
- **Breaking:** approval records are signed per project and per machine. An approval made before
  this release is not in force until `team approve` runs once more; running seats aren't disturbed.
- **Breaking:** a coordinator or operator is the pane its own team's session records. From any other
  pane, or when the state records no pane for that seat, `add`, `remove`, `worktree`, `down` and
  `answer` are refused; the owner repairs it with `team down`, then `team up`. `--session` and
  `--file` on those commands are the owner's alone, from a terminal outside herdr, refused before
  anything is read.
- `status` and `doctor` read any team file without writing anything; `watch --file` is the owner's;
  a plain folder gets its watch.
- The rules reach a seat as one verified line that points at its rules file.
- The watch reports an idle seat once per idle period; `watch.idle_repeat` is off unless set.
- `team worktree` reads the approved copy of every value it uses.
- `up` refuses a launch line that can't run where its seat starts.
- `doctor` warns about a model-less launch only when nothing checks it; `status` gives a runnable
  repair order, the owner's repairs and unsent text.
- A file whose `version` is `"0"` (the placeholder `init` wrote) reads as unset; a wrong model
  family is still refused.

### Added

- `team up` reports one final record per seat, a vendor notice as a kind of its own, and cleaned
  output lines.
- `team up` no longer closes a seat that stops at a dialog: it keeps the workspace, records that the
  seat waits for its owner, and asks one key: `o` opens the pane, `s` skips the seat, `q` stops
  cleanly. `team` answers nothing and types nothing at a dialog. An owner with no terminal is never
  prompted.
- `team answer` and the `dialogs` policy: a coordinator may answer a trust dialog when the owner
  allows it.
- `team release check`, its `linear` and `activity` checks, and `--file` for it.
- Exit codes, documented and tested.
- `packages/teamcli`: the launcher package `@teamcli/cli` (the same tool, typed `teamcli`), in the
  repository and tested; it is not published with 0.3.0.

### Fixed

- A restored pane is its seat only while `team`'s own process is still in it; the repair is named.
- A trust close says the workspace was closed, a failed close is not announced as one, and a seat
  seen running and then gone is reported as such.
- Cursor: the idle box drawn inside a border is read; Cursor seats are read and checked whatever
  model they run.
- The pane-text sanitiser: BEL ends an OSC sequence only, in one linear pass.

### Known issues

- A team file at a non-default path: `up --file` starts no watch for it; start it by hand
  (`team watch --file <path>` from the owner's terminal). The line "watch: started" can be printed
  for a watch that then exits.
- **After a restart of the machine** (the multiplexer restores the panes; a CLI can come back as
  another model, or a pane as a bare shell): a seat launched by 0.3 is recognised as no longer the
  process `team` started, and `up` closes it without input and launches it again. **A seat still
  recorded by 0.2.1 (not relaunched since the upgrade) is not:** `up` leaves it ("already ready"),
  `remove` refuses a bare shell, and `status` names `team up` as a repair that does not work for it.
  What works: the owner's `team remove <seat> --abandon` (or `team down --abandon`), then `team up`.
  The upgrade's relaunch (`team down`, then `team up`) removes the case.
- `team down` that cannot confirm the exit text it typed leaves that text in the seat's input box;
  the next `down` skips the seat ("holds unsent text"). Clear the box by hand.
- The coordinator of a team whose file is not at the default path can run no team-changing command:
  it finds no file, and `--file` is the owner's. The owner runs them.
- A seat waiting at a permission prompt is reported by a running watch, to the owner; `team status`
  has no line for it.
- A seat that `up` leaves out because its screen's model family is not the file's ("left at
  launched, not named") keeps an unnamed pane; after the file is corrected and approved, the next
  `team up` refuses the session until that pane is closed by hand, and `team down` does not close
  it. This happens on a new 0.3 team too, not only after an upgrade.
- `--until` on the commands that take it is not validated.
- A seat stopped on its provider's error screen can read as idle or working.

### Not checked on a real session before the tag

Three things in this release were checked by tests and by runs in process on a test host, not on a
real herdr session. They are due on the owner's own upgrade.

- The caller gate from a coordinator's pane and from another pane (`add`, `remove`, `worktree`,
  `down` with no `--session`): covered by the caller and command tests; not typed in a real pane.
- A real trust dialog during `team up` (`o`, `s`, `q`): covered by the launch tests with an injected
  terminal; not answered on a real CLI.
- A seat left at launch for a model family its CLI doesn't run, the refusal of the next `team up`,
  the pane closed by hand, and `team up` again: run in process, where it ends with every seat ready;
  not on a real multiplexer.

## [0.2.1] - 2026-10-04

A safety patch: on Codex and Cursor the composer's input row is read only under the box's frame, so a
person's text can no longer be submitted together with `team`'s; and Antigravity's and Cursor's
dialogs are recognised as the permission or question they are.

### Security

- **In 0.2.0, and in every earlier release, on Codex and Cursor the composer's input row was the
  lowest row carrying the prompt glyph at the prompt column, wherever it sat.** A box drawing a
  person's text on one row and the glyph alone under it read idle: the person's text was not read,
  `team` typed under the glyph, the read-back held the typed text alone, and the Enter submitted the
  person's text together with the text `team` had typed. The input row is now read only under the
  box's frame, the blank run every capture draws directly above it: a second prompt row above or
  below the input, any other non-blank row pressed against the prompt from above, and a window that
  starts at or inside the box now read `unknown`, with no typing and no Enter, closing the limit
  the 0.2.0 section stated. What is not refused, and why: a prompt-shaped row across the blank frame
  is the transcript's echo of a message already sent — the real captures show both CLIs draw a
  person's later lines at the continuation column — so the empty input row under its frame still
  reads idle, and a seat between turns can still be dispatched to or nudged.

### Fixed

- Four Antigravity screens — the file-creation prompt, the file-edit prompt, the question screen and
  the "unsent comments" dialog — and two Cursor screens — the question box and the plan-mode
  approval — read `unknown`; they are now read as the permission or question they are. `team` typed
  into none of them before or after: `unknown`, permission and question all refuse typing alike.

## [0.2.0] - 2026-10-04

A feature release: the budgets table falls back per window and names the source each figure was
counted from; `team doctor` runs each account's approved budget check; `overrides.yaml` teaches a
shipped profile new dialog and quota patterns without waiting for a release; and every typing path
reads the input row from the captured frame and its prompt column, pressing Enter only when the box
reads back as exactly the typed text. Upgrade: a seat with no label is titled with its model and
version, and `team down` now clears the session it stopped.

### Security

- **In 0.1.2, a quota figure could be read off a pane the seat's CLI had already left.** herdr
  keeps a pane listed after the CLI exits, and a shell's last row is a last row by position, not a
  status row, so a status-shaped line under the recorded exit screen folded a figure into the
  readings and the watch saved it. A figure now reads only off a pane whose foreground processes
  still hold the seat's `cli`; a pane herdr can't list keeps its figure — not knowing is not proof
  the seat left.
- **In 0.1.2, a shell line containing a middot under a rule passed for Claude Code's status
  footer**, so a shell prompt could read as an idle composer when the box's top rule was out of the
  window. The footer rows are now anchored to Claude Code's own status rows, declared by the
  profile.
- **In 0.1.2, one indented line shaped like Claude Code's status row, or its mode row, under a rule
  below a shell prompt read as an idle composer.** A box whose top rule is out of the window is now
  recognised only by both rows, in order.
- **In 0.1.2, a Cursor seat with its follow-up queue on screen read idle or as holding unsent
  text**, so `down` could type `/exit` into a running seat and `remove` refused it as unsent. The
  queue's hint row under the empty composer belongs to the running turn; the profile now reads any
  spinner verb and that row (with nothing but chrome under it), so `down --wait` waits and `remove`
  says the seat is working.
- **In 0.1.2, delivery pressed Enter as soon as the composer read as unsent text, whatever the box
  actually held** — a fold marker whose hidden-row count could not be right, a box still holding a
  person's own text, and the typed text with one character changed all got the Enter, so text that
  was not the rules could be submitted as if `team` had sent it; the watch's nudge and the exit
  typed by `down` and `remove` pressed Enter on an unread box the same way. Every Enter now waits
  until the box reads back as exactly the text typed — folded or not, row for row — and a box whose
  wrap the profile's data cannot model gets no Enter at all: the wait ends in a refusal that reports
  the rules were not delivered, never an Enter on trust.
- **In 0.1.2 the composer's input row was the last row whose content began with a prompt glyph, and
  the fold frame ended on the first rule-looking row** — pre-existing holes, present in every
  release before this one too. A box holding a person's text and then a continuation row with only
  the CLI's prompt glyph read idle, the read-back held, and the Enter submitted the person's text
  with the team's; a rule row after the true tail still got the Enter. The input row is now read
  from the captured frame and its prompt column: for Claude Code and Antigravity, the box's first
  row under its opening rule; for Codex and Cursor, the column their captures draw the prompt at,
  where a continuation row as those CLIs draw it — indented — is content, so the person's text
  above it stays in the box. A row carrying the glyph at that exact column — a shape no capture
  shows those two CLIs drawing — is read as the input row, and a person's text left above it is not
  read. The box's fold is read the same way: its closing rule is the window's last rule row at the
  opening rule's own width, a rule-looking row anywhere else is a row of the box, and where the
  frame cannot be told the read fails closed and nothing is entered.
- **In 0.1.2 a two-rule frame was read without comparing its rules' widths** — pre-existing too,
  present in every release before this one. The composer's frame is read only when its two rules are
  one width, as every capture draws them: where a window's rules differ — a closing rule that is not
  the opening rule's own width — the box cannot be established, the read is unknown, and nothing is
  entered.

### Added

- `team doctor` runs each account's approved budget check once, for the owner only, and reports its
  reading, a broken output contract, a failure or a timeout; a check edited since approval is not
  run and is reported as changed. It also lists accounts no pattern or check can read. The check's
  raw output is never printed.
- `overrides.yaml`, beside the approval in `~/.config/team/<project>-<hash>`, may add dialog
  patterns and quota patterns to a shipped profile. `team approve` records it. Until then the
  approved copy stays in force, and `doctor` and `status` name the change.
- `schema/team.schema.json` describes the team file (draft 2020-12), assembled from the same
  section modules that validate it, with `schema:check` in CI keeping it current. The schema ships
  in the package, and a file `team init` writes now opens with a
  `# yaml-language-server: $schema=…` line pointing at this version's copy.
- `docs/reference/cli.md` is a generated CLI reference — every command, flag and positional, from
  the command definitions themselves — kept current by `contract:check`, with the same snapshot as
  data in `contract/cli.json`. Help text is unchanged.
- `bun run conformance` checks an implementation of screen reading and the YAML subset against the
  shared fixtures. `team conformance-adapter` is the TypeScript implementation of that protocol. It
  is not listed in `team --help`.
- `bun run coverage` prints the capture coverage matrix — for each CLI and screen kind, how many
  conformance fixtures are real captures, constructed, or with no provenance stated — and
  `coverage:check` keeps `contract/capture-coverage.json` current in CI, failing on a difference or
  any provenance problem. Only the fixture folder's README decides: a `capture` claim counts where
  the README lists the file under a heading that is not Constructed or Not produced.
- A profile may give a dialog pattern its own `ignore_case: true` beside its `match` — the flag
  reaching its `except` list too. Claude Code's trust question, spelled out in both cases letter
  class by letter class through 0.1.2, is now one line with the flag on it, and the "1. Yes" choice
  beside it stays matched as it is drawn. A composer's own patterns — `prompt`, `rule`, `footers`,
  the status line, the suffix — take strings; a flag written among them is refused at load with the
  key's name (`"prompt" cannot ignore case: only a dialog pattern may`).
- A profile may name a `screen_module` — a code module inside the package's profiles folder — for a
  CLI whose screens the data rules cannot express. Its predicates are combined with the data rules
  by OR for `working`, every dialog stage and `unknown`, so a hatch can only add caution, never
  remove it; a composer comes from data or from the hatch, never both, and a profile that carries
  both is refused when it loads. No shipped profile uses one. The guarantees cover what a hatch
  returns and what load accepts; a hatch is trusted package code, not a sandbox.

### Changed

- A seat with no label is titled with its model and version in lowercase (`claude opus 5.5`). A
  label written in the file is kept. Two seats may share a label — names are the only key — and an
  approval recorded by 0.1.1 or 0.1.2 stays valid while the file is unchanged since that approval.
- `team doctor` warns when a seat's name or label repeats the project or the session. The warning
  does not refuse the file.
- The budgets table names the source each figure was counted from and marks it `(fallback)` when
  that is not the first source the account names — `status line (fallback)` — and `status --json`
  carries the same `fallback` field on each budget row. The fallback is per window, not per
  account: a check that reported one window leaves the other window to the next source the account
  names.
- A stale figure with no known reset time reads unknown only while it could still matter: inside
  its reserve, or within the reserve again outside it. Beyond that it still counts, its row saying
  `last seen <age>` — the room the figure last held. It never refuses a launch.
- **`team down` now clears the herdr session it has itself just stopped**, its line reading
  `stopped and cleared`, so `up` after `down` starts the team again instead of refusing on the
  stopped session herdr keeps listed; where the clear does not happen the line names
  `herdr session delete <session>`. `up` never deletes a session: one it did not stop keeps the
  refusal.

### Fixed

- Claude Code's folder-trust dialog with unnumbered choices is read as a trust prompt, not a
  question.
- `team down` now stops a seat the file renamed after `up` launched it: the state records the CLI
  each seat was launched with, and `down` resolves the file's name first and the state's second,
  falling back to the seat a temporary seat is like. A state too old to say leaves the seat to its
  owner, named per seat with the command that closes it without typing.
- **A pattern's astral code point wrote five hex digits.** U+1F600 compiled as `ὠ` and a `0`, so an
  emoji or an astral range matched the wrong text; they now compile to the `\u{…}` form.
- **A `chrome` pattern could hide the unmarked second choice of a dialog.** The guard tested six
  sample lines, all of the first choice; it now tests the drawn shape — every mark or the indent,
  both numbered lines the safety floor reads, and the labels the profiles name.
- **A check's CRLF output read unknown.** `weekly 39% used\r\n` broke the contract on its line
  ending; each line now loses the trailing CR of a CRLF ending, and a CR anywhere else still breaks
  the contract.
- **A class mixing a complement shorthand with members was silently rewritten.** `[\D0-9]`
  compiled to `[\s\S]`; the positive class is now refused with the reason when the profile loads.
  `[^\S\n]` and a shorthand alone are unchanged.
- A temporary seat now follows the drift of the seat it is like, folding no figures until
  unapproved edits to the like-seat are approved.
- **An Antigravity seat's rules are delivered when agy folds the paste.** A long paste folds to
  `↑ N more lines` and the tail; the box is now read as folded, and Enter is pressed only when the
  visible tail rows and the hidden-row count are the ones the typed text renders to. A fold that
  doesn't match stays unsent.
- **A spend refusal rounded the figure it printed, into a contradiction with itself.** A reading of
  `4.996 USD` against a `5 USD` floor printed "5.00 USD, at or below its 5.00 USD floor"; the
  figure now prints as read — up to four decimals, the trailing zeros beyond the cents dropped,
  never fewer than two — in the refusal and the dry-run lines that reuse it, and a floor prints as
  the file wrote it.

## [0.1.2] - 2026-10-04

A safety release: 0.1.1 could type a nudge or an exit into the shell left after Claude Code exited,
and a seat could silence the watch's reports about itself. Upgrade.

### Security

- **In 0.1.1, a shell prompt left after Claude Code exited read as an idle composer**, so a nudge, a
  first message or an exit could be typed into a shell. A composer now reads idle only inside its
  own frame — the rule above the box or the status footer under it — and every typing path (the
  nudge, rules delivery, `down`'s and `remove`'s exit) also needs herdr to report the agent's
  process in the pane, read again immediately before the Enter.
- **In 0.1.1, parking or stopping a seat was not drift**, so a seat could silence its own idle
  reports by editing its entry in the file. Parking and stopping are now part of what the owner
  approves; `remove --keep` and `add` record the new digest when `stopped` is the only change, so
  those commands still leave that file approved, and an approval recorded before this stays valid
  while the file is unchanged since the approval.
- **In 0.1.1, `--no-notify` on the watch silenced a report addressed to the owner**, and any caller
  could run the session's only watch with it. Each report is now routed to the owner or the
  operator, and `--no-notify` drops only the operator's notice — the log line stays, and
  `team status` does not read the flag. The watch's own notices — the operator could not be
  nudged, herdr does not answer, the file cannot be read, a typed nudge was not sent, the watch
  stopped — are the owner's and survive the flag too. `--no-nudge` and `--no-notify` are the owner's.
- **In 0.1.1, a watch on a session other than the file's own saved its readings into the state a
  launch gate counts.** Such a watch now reads and reports as before, says so once, and saves no
  reading — budget or spend — so a session the file doesn't name can never decide a launch.

### Added

- A seat may name the budget account it spends, `account:`, when one vendor's two accounts are two
  buckets; without it a seat spends its `vendor`, and the choice is part of the seat's fingerprint,
  so the owner approves it. It must be a key of the file's `budgets.accounts` — a name the budgets
  don't hold is refused where it is — and an unapproved edit to it folds none of that seat's figures
  until the owner approves. A figure measuring the seat's vendor lands on the seat's own account,
  and a figure naming another account stays that account's, whichever seat's screen showed it.

### Changed

- While a `watch.checks` edit is unapproved, the approved list stays in force: nothing new is turned
  off, and an approved-off check stays off. Before, every check ran until the owner approved.
- **A seat could take the rules message for a task.** Every seat's rules text now ends with a line
  saying the rules are not a task. A first message closes with `These are standing rules, not a
  task: reply ready and wait for your brief.`; a launch option that stays in force on every later
  turn (claude-code's `--append-system-prompt`) closes with only `These are standing rules, not a
  task.` A team file whose own `rules:` already end with that line doesn't get it twice.
- A team whose seats were stopped by `remove --keep`, or parked by hand, since its last approval
  shows `seat X changed` for each after upgrading, and `up` and `add` refuse until the owner
  approves once.

### Fixed

- A greyed suggestion in a Claude Code input box is no longer read as text that was never sent:
  input text whose characters are all faint is the box's placeholder, and the seat reads idle. Text
  with any other styling reads as unsent text, and a line with no styling keeps the `Try "` rule.
- Cursor's running turn is the braille spinner, or the prompt line that ends in `ctrl+c to stop`.
  The same words quoted in the transcript are not a turn, and text typed on that prompt is unsent in
  the composer.
- A subscription check reading is kept in the state beside the screen readings, and `up`, `add` and
  `status` count it: a fresh check inside its reserve refuses a launch after the watch has exited, a
  stale one outside its reserve reads unknown, and the account's `sources` decide which reading counts.
- Budget readings are kept per project, not per herdr session: `up`, `add`, `status` and the watch
  read the one cache, so a figure one session saw counts for every session, and state files written
  before this change migrate as they are read — no reading is lost.
- A stale check reading inside its reserve keeps refusing until its known reset, as a stale screen
  reading does; an unconfirmed screen reading no longer hides a fresh check reading later in
  `sources`.
- A Claude question is the dialog's own last line. Prose that says "Esc to cancel", and a transcript
  of "1. Yes" / "2. No" above an empty box, stay idle.
- An Antigravity permission dialog whose rule line has scrolled out of the window (a long command)
  is still read as the dialog, and a Claude Code question with a line below its footer and no rule
  in the window is still read as a question.
- The watch folds its readings inside the state's own lock, so two watches of one project fold onto
  each other's figures instead of overwriting them.

## [0.1.1] - 2026-10-04

A safety release: 0.1.0 could type into a Codex permission dialog, and could read a quota figure a
seat wrote itself. Upgrade.

### Security

- **In 0.1.0, `team` could answer a Codex permission dialog.** With the status line pinned below
  the dialog, the screen read as unsent text, so rules delivery and the watch's nudge typed their
  text and Enter into it, accepting its first choice. The dialog is now read as the dialog: the
  safety floor's markers match without regard to case, and a rule's footer may sit above a
  `status-last` composer's pinned line. The dialog is reported and never answered, and rules
  delivery and the watch type nothing into it.
- **In 0.1.0, a seat could set its own quota figure** by printing or typing a line shaped like one,
  which could keep a launch from being refused. Quota figures are now read only from the status
  line's own row of a composer screen: a line printed into the transcript or typed into the input
  box is not read as one, a CLI whose composer shows no status line reads no figures at all, and a
  dialog, a question, a trust or an unknown screen reads none. A pane's owner can still draw a whole
  fake composer; a fresh `check` reading stays first, and a wrong figure can only refuse a launch or
  produce a report.

### Added

- A spend account's `floor` refuses a launch: the watch keeps the money each spend check reads in the
  state, and `up` and `add` refuse a seat whose account is at or below its floor. A reading that is
  missing, stale or in another currency than the floor's reads unknown, is said, and never refuses.

### Changed

- `bun run build` empties `dist/` first, so a file left by an older build can no longer end up in a
  packed or globally installed tarball.

## [0.1.0] - 2026-10-04

The first release: set up, change and watch a project's team of AI agents from one file,
`.agents/team.yaml`. Runs on Node 22 or later, with no runtime dependencies.

### Added

- The team file: a documented YAML subset with its own parser, validated field by field with line
  numbers, and a fictional example at `examples/team.yaml`. (#2, #11)
- `team init` and `team status`: write the skeleton file and keep it out of git through
  `.git/info/exclude`; print the file's seats against the running session, each difference with its
  repair; `--json` prints the same facts as one JSON document (`format: 1`) for scripts. (#3, #33)
- A seat whose own status line names another model than the file's is a status difference, with its
  repair; a model id the map doesn't know, or another maker's model run through Claude Code, is
  unread — a note, never a difference. (#30)
- `team approve`: record the file, its ceilings and its seats on this machine after a read-back and
  a typed seat count; `--show` prints the approved copy. (#4, #5)
- `team check`: check one commit, a range or a pull request body against the signature rule;
  forbidden lines and session links are refused by default; it runs on every pull request in this
  repository's CI, against the repository's own team file and the seats that sign its history.
  (#1, #8, #12)
- `team doctor`: check this machine for what the file needs — herdr, each CLI, login, launcher,
  model, watch heartbeat; `--login` checks read-only that each declared CLI is signed in, using each
  profile's login check, and answers no prompt. (#5, #33)
- `team watch`: report idle and blocked seats, unsent input and machine figures, and nudge the
  operator only into an empty idle prompt; `--no-nudge` and `--no-notify` turn those off. (#6, #7,
  #22)
- Linux: the caller check and the watch's load, memory and swap figures are read from `/proc`, so
  `team` answers there as on macOS. (#29)
- A stopped seat its owner starts by hand is watched like a parked one: prompts and unsent text are
  reported, its idle is not, and it is never read as an agent the file doesn't hold; parked and
  stopped follow RFC 0001. (#25)
- `team up` and `team down`: start and stop the session and its seats, each with its caller rule;
  staged launches, a wait for an empty idle prompt, trust and update screens read and never
  answered; `--dry-run` prints the plan and changes nothing. (#5, #13, #14)
- `team up` and `team add`: every `machine:` start limit — load, memory, disk, free swap and swap
  growth — is checked before each seat, and a breach refuses the launch, naming the figure and its
  limit; a `--dry-run` prints the refusal too. (#26)
- Launch profiles for `claude-code`, Codex, Antigravity and Cursor: approval flags added only at
  launch, rules delivered only into an empty idle prompt, screens read from recorded, sanitised
  fixtures; a Codex permission dialog is reported for its owner and never answered. (#16, #17,
  #18, #23, #24, #27)
- `team add` and `team remove`: start one declared or temporary seat; stop a seat, then take it out
  of the file — `--keep` leaves it stopped, `--abandon` is the owner's. (#19, #20)
- `team worktree new` and `team worktree remove`: create a task worktree from an up-to-date base, or
  remove its folder; a failed setup is kept and recorded, and the branch is never deleted. (#15)
- A README that covers the file by example and every command with who may run it. (#9)
- A page per command in `docs/commands`, every example run in CI. (#31)
- Codex's profile reads a weekly quota from its status line: `weekly N% left`, for the OpenAI account.
  A line cut short of the number is not a figure.
- `budgets` is an owner section: marks, freshness, and each account's reserve or floor. A `check`
  command is resolved and hashed at `team approve`. `watch.quota_marks` is read, with a warning.
  A changed check file leaves that account unknown; it does not refuse the rest of the file.
- A quota figure is kept per seat in the state file. The newest confirmed change counts. A first
  sight does not replace it, and a reading from before its reset is dropped.
- `team status` prints a budgets table, and the same rows in `--json`, when an account is named or
  a reading is stored. Unknown and stale are shown as such. A row inside its reserve says so even
  when the figure is still fresh.
- `team watch` reports a budget: each mark a window crosses, an account inside its reserve or floor
  (to the owner), and an account that reads unknown while seats run on it (to the operator). The
  accounts' check commands run in the watch loop, outside the pass: at most every `budgets.check_every`,
  ten seconds, an empty environment, and only when the approval covers them — their output is never
  logged. The core parses each seat's quota line, and a reading the pass saw is saved, so `status`,
  `up` and `add` count it. `watch.checks: { budget: off }` turns the report off.

### Changed

- The whole `watch` section is an owner section, its timings included: an edit to `interval`,
  `idle_first`, `idle_repeat`, `team_idle`, `nudge_wait` or `unsent_after` needs a new approval, and
  until the owner approves it the watch runs with the values of the approved copy — or with the
  defaults when nothing was approved. `watch.checks` keeps its own finer line inside the section.
  A timing a seat changed without an approval shows its difference at the next pass, for the owner
  to settle. A never-approved team runs on the defaults, whatever its file says.
- The whole `budgets` section is an owner section too, its accounts and marks included: an edit to
  a reserve, a floor, `stale_after`, `check_every` or the accounts needs a new approval, and until
  the owner approves it every reader — the watch's reports and its check cadence, the check
  commands' own run, `up`'s and `add`'s launch gate, and `status`'s table — runs with the values of
  the approved copy, or with the defaults (no accounts) when nothing was approved. A file never
  approved runs no check at all. An unapproved edit silences nothing and unblocks nothing.

### Fixed

- A seat that isn't `mode: shared` and works in worktrees starts in the lobby — the parent of
  `workspace.path` with `.lobby` beside the worktrees, inside `trust` and outside every protected
  checkout — never the project root, which holds the owner's uncommitted work; `up` and `add` make
  it once, refuse a lobby outside `trust` or inside a protected checkout, and refuse a seat the file
  aims at one. (#35)
- Claude Code's permission stage is the dialog itself: the question with its "Esc to cancel · Tab to amend"
  footer, or a Yes/No choice below the last rule. An idle seat that only quotes "Do you want to proceed?"
  stays idle.

[Unreleased]: https://github.com/floor/teamcli/compare/v0.3.5...HEAD
[0.3.5]: https://github.com/floor/teamcli/releases/tag/v0.3.5
[0.3.4]: https://github.com/floor/teamcli/releases/tag/v0.3.4
[0.3.3]: https://github.com/floor/teamcli/releases/tag/v0.3.3
[0.3.2]: https://github.com/floor/teamcli/releases/tag/v0.3.2
[0.3.1]: https://github.com/floor/teamcli/releases/tag/v0.3.1
[0.3.0]: https://github.com/floor/teamcli/releases/tag/v0.3.0
[0.2.1]: https://github.com/floor/teamcli/releases/tag/v0.2.1
[0.2.0]: https://github.com/floor/teamcli/releases/tag/v0.2.0
[0.1.2]: https://github.com/floor/teamcli/releases/tag/v0.1.2
[0.1.1]: https://github.com/floor/teamcli/releases/tag/v0.1.1
[0.1.0]: https://github.com/floor/teamcli/releases/tag/v0.1.0
