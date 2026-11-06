# team up

Starts the team: the herdr session when it is not up, a workspace and a seat for every seat the file
declares and this machine can run, and the watch, in a workspace of its own labelled
`Watch · <project>`. A fresh launch of
the orchestrator or the operator starts in the project folder; every other seat starts in the team's
lobby. A seat already running or ready is left as it is — its pane is not closed, moved or typed
into — and its sidebar is rewritten from the file either way. A seat the file marks `human: true`
is a human's own pane: the plan skips it — nothing is launched into it or typed into it; left as
it is — and it does not count as short of ready.

A Claude seat whose launch enables the `team-inbox` development channel starts in its own
`<lobby>/<seat>/` folder, including a lead seat. The lobby must already be registered and trusted.
After the launch claim exists and before workspace creation and Claude startup, TeamCLI writes
that folder's `.mcp.json` with the exact claimed epoch and adds the named `team-inbox` approval
to `.claude/settings.local.json`. It preserves other server entries, enabled names and settings,
refuses malformed settings, explicit local rejection and unsafe or changed paths, and rechecks
both files under the same exclusive lease before spawn. It adds no approve-all switch or CLI
trust entry; Claude's workspace trust remains a separate condition. A failed start leaves the
bounded config for the next launch and releases only its own config claim.

The watch is read against both records: the watch the session's state carries and the hosted watch
the machine daemon records for this route. A hosted watch that is not standing by is already
watching the session, so the run starts no pane watch beside it; a standing-by hosted watch yields
to the pane watch the state records. A pane watch with a live process and a fresh heartbeat is left
alone, a dead or missing record starts one, and a live process behind an old heartbeat is stopped
before its replacement starts — only when the pane the watch's own record names still shows that
pid as the pane's process. A pid alone cannot tell the watch from a reused process, so a record
with no pane, a pane that cannot be read, or another process in it is held: nothing is signalled
and no replacement is started. A signalled watch is given ten seconds to exit; a refusal, or a
process still running then, holds the run and starts no replacement beside it. When the daemon's
health cannot be read, the run starts no pane watch and the plan says why rather than risking a
second one.

Before the plan types anything, the run delivers the general seat brief: TeamCLI's built-in
default, the first text every seat gets, written as a signed message record into the drop folder
of every seat the plan launches or relaunches, and of every declared seat the session records no
launch of — a human seat, which is never launched, among them. Each delivery is a claim and a
drop: the claim in the session's state names the delivery's incarnation, the runtime epoch, the
brief's sha256 and the record's expected id, and it is written before the drop. When this build's
brief is ahead of any live or human seat's claim, the run also delivers to those seats, without
relaunching them; every other delivery is the plan's own seats. The claim's epoch is the runtime
the launch hands its reader, so an older process — one started under an earlier epoch — serves
nothing until its seat is launched again; a launch that ends short of ready leaves its delivery
on disk and a read by that process is provisional, never a successful read. A seat the state
records as already launched, and that the run leaves as it is, is left exactly so when its claim
is current: no drop and no state entry. The brief travels the drop leg and is never typed; a seat
that already holds this brief's verified record is left as it is, and a name held at the claim's
expected id by another file, a link, a folder or a FIFO is refused, never replaced or followed —
only [`team brief rollout --apply`](brief.md) recovers that delivery at the claim's next attempt.
[`team check`](check.md) names a seat the session launched without a verified delivery record.

## After a power loss

The service manager starts the machine daemon at login, often before the terminal host has
finished restoring the sessions it had. The daemon's startup pass sweeps the checkouts its service
unit names and retries the ones whose session has not come back yet: it waits five seconds, then
twice as long each time up to a minute, for five minutes and a quarter in all, and stops waiting
early when every session is back or the daemon closes. A session still restoring at that bound is
logged as pending, never reported as nothing to do.

One command runs the restore pass across every registered team, whatever the daemon's checkouts:

    team up --all

It reads the machine's registry, takes the teams in a fixed order — a team whose folder holds
another team's first, then by session name — and runs the ordinary `team up` pass for each team
whose session the terminal host is running and whose state records seats. Each pass re-ties the
seats the host restored, launches again the seats whose process did not come back, and leaves
working seats alone. A team whose session is not running is skipped, never started cold; a stopped
or archived team is skipped too. The run reports one line per team, then the totals:

    <project> (session <session>): <N> seats repaired, <M> skipped (working), <K> refused
    all teams: <T> teams swept (<R> seats repaired, <W> skipped, <F> refused)[; <S> inactive skipped]

A team whose file cannot be read, whose session lock is held, or whose pass is refused is named
with its reason — `team up: <project> (session <session>): <reason>` — and does not stop the teams
after it. A run with nothing to restore is its own refusal, never a false all-clear: `team up:
nothing restored yet: no registered team has a running session in the terminal host`, or `team up:
nothing restored yet: no teams are registered` when the registry is empty, exit 1 — a dry run
refuses the same way. A terminal host that does not answer is `team up: the terminal host doesn't
answer`, exit 1. A team that failed leaves the run at exit 1; a run in which every swept team came
back is exit 0.

`--dry-run` prints each team's plan under `=== <project> (session <session>) ===` and writes
nothing. `--json` prints one `team.up` document with `all` `true`, the per-team entries as
`teams`, every declared seat as `<project>/<seat>` in `seats`, and the closing line as
`action_summary`; a run with a failed team is the `up.pending` `team.error` document naming them.
`--serial` and `--no-launch` reach each team's pass. `--all` takes no single-team flag: `--file`,
`--session`, `--client`, `--team`, `--request`, `--approval` and `--reason` are refused with
`up.invocation`, exit 2, before any team is read.

The owner runs it from a terminal outside the terminal host; a general grant that carries `up`
admits it with no terminal; a team lead runs it only while development mode is on, from its own
recorded pane. Any other caller is refused before a team is touched: with no terminal, `only the
owner or a lead in development mode runs this, from a terminal outside the terminal host or the
lead's own pane`; otherwise `team up: only the owner or a lead in development mode runs team up
--all`, exit 1.

## A seat the terminal host restored

After a crash or a power loss the terminal host can restore the session: the panes and their
conversations come back, but the names the launch gave them do not. `team up` never adopts a pane
on trust. For a seat whose launch record reached ready and whose recorded pane still holds a
process the record does not name, it proves the seat from what the restore kept — the pane, its
workspace and the conversation:

- the seat's conversation is the one the record names — the strongest proof; or, when neither
  side names a conversation, the declared CLI is alone in its workspace, at an idle prompt, with
  nothing unsent in its box;
- it never re-ties a pane named for another seat, one holding another conversation or another CLI,
  one that is working, or one holding unsent text; a pane that fails the proof is left as it is,
  with the reason said.

A seat the proof holds is re-tied where it stands: the pane is named back, its sidebar line is
painted again from the file, and the record takes the process identity the pane holds now. Nothing
is typed into the pane and nothing is closed. The run says `restored and re-tied: <what proved
it>; left as it is`, and the seat counts nowhere in the restore summary: it was neither repaired
nor refused.

A restored pane that runs the bare CLI where the seat's own launch line starts a wrapper — an
alternate endpoint — is the exception: adopting it would leave every turn without the wrapper's
settings. `team up` lets the bare CLI exit cleanly in its own recorded pane — the CLI's own exit
word and Enter, or its own exit keys, and nothing else — and launches the seat again in that same
pane through its own launch line, resuming the proven conversation; the pane's workspace is
neither closed nor replaced. A pane that is working, holds unsent text, cannot be exited, or does
not come back to its shell in time is left exactly as it is; a launch line that cannot carry the
conversation stops the run before any key is typed.

A restored Codex seat whose managed endpoint died with the restart is the other exception: the
pane still runs the CLI, but the endpoint `team up` started for it is gone, and adopting the pane
would leave every turn on an endpoint that cannot answer. Whether it is gone is judged by the same
three readings `team check` uses — the record for the seat's current binding, the endpoint
socket's liveness, and the recorded process's start time; a live endpoint, an absent or invalid
record, or an unreadable start time leaves the pane adopted as it is. Only a proven loss relaunches
the seat: the same exit and holds as above apply, and the seat's own launch line runs in that same
pane with a fresh endpoint started and the CLI attached to it with `--remote`, or, when the
endpoint will not start, with the CLI's own background server off (`--no-daemon`).

A seat whose recorded pane no longer holds the process team launched is launched again. When the
pane is back at its shell, the seat is launched in the same pane — `its recorded pane <pane> was
at its shell; launched in the same pane`. When the pane is gone or was replaced, the seat is
launched from the beginning in a workspace of its own, and the old workspace is closed without
input once the seat is ready, only if it still holds only the old pane and is not named for
another seat.

A launch in that same pane waits on its line differently. The shell was already at its prompt
when the line was typed into it, so the echo on the screen is not by itself evidence that the
line ran: the wait confirms the line was submitted — the echo left the prompt row, something was
drawn below it, or the foreground left the shell — and reads the end of the launch from the
foreground, the pane's own shell back in front through three consecutive readings. A line still
sitting at that prompt past the longest unread echo captured is given one more Enter — only while
the pane's own shell is in front and the line is exactly where it was, and only once. A pane whose
screen shows no echo of the line is never typed into, and a line whose second Enter does not land
either is reported at the deadline, never as a CLI that ended.

## A team still in its file

Since 0.5.5 the team lives in the registry. When the owner runs `team up` in a project whose
team the registry does not hold yet, and `.agents/team.yaml` is there, the run imports the file
first — the same import, read-back and canonical-record check as `team migrate` — and says so on
one line: `team up: this team was not in the registry yet: imported .agents/team.yaml (team
<id>), read back and verified; the file is no longer read: run team migrate to move it to the
Trash`. The file is kept; `team migrate` retires it. A dry run says a real run would import, and
imports nothing. A seat's run, or a run with `--file`, never imports.

When the registry holds the team and a `.agents/team.yaml` is still beside it, the run prints one
line naming `team migrate`, and goes on: the file is not read. `team check` and `team status`
print the same line as a note. A leftover file that says something else than the registry is a
difference in `team check` and `team status`, with `team import` as the repair.

`--file` is a deprecated legacy path, kept for tests and snapshots: it reads the file it names,
whatever the source.

## Synopsis

    team up [--dry-run] [--serial] [--session <name>] [--file <path>] [--json]
    team up --all [--dry-run] [--serial] [--no-launch] [--json]
    team up --client <grant-file> --key <client-key> [--team <team>] [--dry-run] [--serial] [--json]
    team up --request [--serial] [--json]
    team up --approval <request-id> [--dry-run] [--serial] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--dry-run` | — | prints the plan and runs nothing; prints the refusals the real run would stop on as `! up would refuse: …` above it, and, for a caller the run does not admit, `! to unblock: …` with the command that admits it |
| `--serial` | — | launches and waits on one seat at a time instead of concurrently |
| `--all` | — | the restore pass across every registered team whose session is running in the terminal host, in parent-first then session order; see [After a power loss](#after-a-power-loss) |
| `--session` | `<name>` | the herdr session to start, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | deprecated: read the team from this file instead of the registry (tests, snapshots); the owner's alone |
| `--client` | `<grant-file>` | the client form: an owner-signed up grant for one team, see [A client's up grant](#a-clients-up-grant) |
| `--key` | `<client-key>` | the client's private key file, which proves the client holds the key the grant names; required with `--client`, refused without it |
| `--team` | `<team>` | with `--client`, the team the grant is for, so the run can be made from outside its folder |
| `--request` | — | record this launch and send it to the owner seat; see [Owner-seat approval](#owner-seat-approval-no-owner-terminal) |
| `--approval` | `<request-id>` | run the launch the owner seat signed for, once; a dry run verifies it and spends nothing |
| `--json` | — | one `team.up` document instead of the working lines; a refusal is the `team.error` document on stdout, with stderr empty |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr |
| any caller holding an owner-seat approval | run it with `--approval <request-id>`, once, exactly as the owner seat signed it, or with no request where a signed always rule for `team-up` covers this folder; it never prompts and never types into a pane |
| a seat an active create-grant names by its own registry id | run it, on the paths that record covers and before it expires |
| a run with no terminal | a real run is refused: ``team up: only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane``; `--dry-run` prints the plan and `! up would refuse:` with that sentence, and launches nothing |
| a seat this team's record marks `leads` — its orchestrator, or a registry roster line that says `leads` | run it on this folder's own team file, and the run does not relaunch or close that seat. `--session` and `--file` are refused before either is read |
| a caller the run admits | run `--dry-run`, which reaches nothing and changes nothing |
| a caller the run does not admit | a real run is answered with the one word `deny` on stderr and nothing on stdout — no reason, and no plan — and exit 1. A `--dry-run` is never denied: it prints `! up would refuse:` with that reason, `! to unblock:` with a `leads` seat's own run of this folder from its pane (or the owner's, from a terminal outside herdr), and — when no flag kept the file unread — the plan, and exits 1 |
| the orchestrator's seat, where the row above does not admit it and the file's `grant` lists `up` | run it on this folder's own team file, and the run is audited as the grant's. A lead the map admits is not constrained by a grant, and the grant or delegate path applies only to seats the map does not admit: a grant that names another seat or pane, or leaves `up` out of its scope, refuses this fallback run, and a run the map admitted asks it nothing and is audited only as the row's. A file with no `grant` section grants nothing. The run does not relaunch or close that seat. `--session` and `--file` are refused before either is read, in the grant's words |
| a seat of this team the record does not mark `leads`, or a pane of another session | run `--dry-run` only; a real run is refused, unless the live `grant` admits the orchestrator's seat or the live file's `delegates` section names that pane with `up` in its entry's `commands`, and a `--session` or `--file` it passes is refused before either is read |
| any caller the rows above admit, running `--all` | only the owner, a caller a general grant covers, or a team lead while development mode is on and standing on its own recorded pane; any other caller is refused before a team is touched — with no terminal, `only the owner or a lead in development mode runs this, from a terminal outside the terminal host or the lead's own pane`; otherwise `team up: only the owner or a lead in development mode runs team up --all` |

## Owner-seat approval: no owner terminal

`team import`, `team add`, `team up` and `team migrate` run for a caller that is not the owner at a terminal once
the owner seat has signed for exactly that run. The owner never types a command and never answers
a question in a pane: the answer is a signature from the owner's own device. `team migrate` with no
`--request` waits in the same process for that signature; `--dry-run` only reads, and anyone may run it.

1. The caller runs the command with `--request`. TeamCLI records the action, the repository root,
   the team, `HEAD`, a hash of the command's arguments and who asks, for fifteen minutes, and drops
   the confirmation in the owner-seat inbox. It prints the request id and the exact run to make next.
2. The owner answers on the owner page (`team owner-seat serve`): **Approve once**, **Always allow**
   or **Deny**, confirmed with Touch ID on the Mac or with the iPhone passkey. **Approve once** is
   a one-time approval. A migration needs that, and its card offers only **Approve once** and
   **Deny** as decisions (the later words are on every card, but they decide nothing). The answer
   is signed by an accepted owner signer whose key TeamCLI confirms against the credential store.
3. The caller runs the same command with `--approval <id>`. TeamCLI verifies the signed answer is
   bound to this id, this action, this repository, team, `HEAD` and arguments, claims it once for
   this action, and writes an audit entry in `~/.config/team/action-audit/`. `--dry-run` verifies
   and spends nothing.

**Always allow**, on a card that offers it, also stores a signed rule for that action under the
repository's parent folder, inside the owner's `approval-rule-ttl`: a later run of that action in a
sibling repository is admitted with no request. A migration card does not offer it. Everything else
fails closed: a missing, expired, mismatched (repository, team,
`HEAD`, arguments or action), unsigned or forged answer, an answer signed for another kind of
request, a request answered by a signer of the requester's own name, and a replay. Only lifecycle
actions are requested this way; a grant, an owner-signer change or an approval-mode change keeps
its own owner approval, so no principal grants or widens its own authority through it.

`team init --request --then-up` asks for the team and its first `team up` in one request; the one
answer admits `team init --execute <id>` and then `team up --approval <id>`, once each.

## Trust at launch

A file whose `trust:` is missing, empty or still project-relative does not stop the launch: the run
trusts only the team's lobby and the project root, both absolute, and says so once on stderr with
the block that makes it permanent. Nothing is written to the file.

Before a seat starts, `up` pre-accepts its CLI's folder-trust question for the lobby (a lobby seat)
or the project root (a seat that starts there), and for nothing else, in the record that CLI already
reads: `projects[<folder>].hasTrustDialogAccepted` in `~/.claude.json` for Claude Code,
`[projects."<folder>"] trust_level = "trusted"` in `~/.codex/config.toml` for Codex, the
`trusted_folders.toml` table `grok --trust` writes, and the marker `cursor-agent --trust` writes. No
key is ever typed into a pane for it. Antigravity has no such record, so nothing is written for it:
its launch carries the folder as trusted for that session only (`--settings`, never saved), and
its dialog does not wait for the owner.

## A create-grant's seat

A create-grant — a record in `~/.config/team/grants/` — admits a seat whose own registry record the
record names, by its registry agent id (`agt_` …) or by its team's registry id, and nothing else.
That seat runs `up` on the paths the record covers — its own `paths:`/`path:`, or the roots its
`entity:` declares in `~/.config/team/entities.yaml` when it names none — before it expires. A
record that spells its holder as a name, a seat, a pane, a session or a runner process grants
nothing and is skipped, an expired record keeps the answer above, and so does a folder outside the
covered paths or one reached through a `..` segment or a symlink. A caller outside herdr has no
registry record and is never admitted; where the team file's `grant` decides, that record
decides instead. The record's shape, with one example: [team init](init.md).

## A client's up grant

A client with no terminal that the owner signed an up grant for (`team grant --client <id> --team
<team> --up`, see [team grant](grant.md#an-up-or-down-grant)) brings up that one team with:

    team up --client ~/.config/team/grants/cg_<24 hex>.json --key ~/.config/team-client/<id>/client.key

Run it in the team's folder, or from anywhere with `--team <team>`. `--file` and `--session` are
the owner's and are refused with `--client`; the run is bound to the folder the owner signed. A
folder of another team is refused; so is a team of the same name at another folder. Before any
step the run verifies, and refuses with the reason and the owner's next step when any check fails:

1. the grant file is the owner-signed record in the grants folder, byte for byte, and is an up
   grant (a send grant is refused here, and an up grant is refused by `team send`);
2. it is not expired and not revoked;
3. the key file proves identity: the key is the one the grant names;
4. the team, its registry id and its real folder are the ones the grant binds;
5. the team file still carries the fingerprints the owner signed. When it does not, the refusal
   lists what changed (a seat added, a seat changed, an owner section changed) and says that the
   owner re-signs with `team grant --client <id> --entity <entity> --public-key <file> --team
   <team> --up --request` and answers on the owner seat; a comment or a prompt edit needs no new
   signature.

Then it runs as an owner launch with no terminal: it never prompts and never reads a pause. It
still refuses every seat the signed team file does not declare, and it reaches no other session,
file, team or command. It does not run `team approve` and it does not stamp a folder as trusted: a
team the owner has not approved for this machine, or a folder-trust dialog, is handled as for any
other launch without an owner at the terminal. The `--dry-run` form verifies the grant and prints
the plan, and writes nothing.

A real run writes one line to the team's own log (`.agents/team.log`) once the grant verified:

    client-up-authorized: grant <cg_id> client <client-id> team <project> root <root> request <rid>

A refusal after the client's key proved identity writes `client-up-refused: grant <cg_id>:
<reason>`. A refusal before it (a wrong key, an unreadable grant) writes nothing, so a stranger
cannot fill the log. A run under the lock re-reads the grant, so a revocation in the middle of a
run ends it before the first step.

The `up.detached` refusal of a run with no terminal is unchanged for every caller that does not
present a grant; `--client` is the only way a caller with no terminal passes it.


A bundle grant that carries `up` (`--bundle operator`, see
[Client grant bundles](../concepts/client-grant-bundles.md)) runs the same `team up --client`, with
the same checks and the same `up` rule about the team file: an `operator` bundle's `up` is refused
after a seat or an owner section changed, until the owner re-signs. The audit line is the same
(`client-up-authorized`). An `observer` bundle does not carry `up` and is refused with the request
for an operator bundle.

## Output and exit codes

Each pass ends with one restore summary, written even when all three counts are zero: `N seats
repaired, M skipped (working), K refused`, with ` (seat: why; …)` appended for the seats the pass
would not repair.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| every seat ready, watch running | one `<seat>: ready` record per seat in file order, on stdout; `watch: started` and the restore summary line, on stderr | 0 |
| `--dry-run` | the plan; `! up would refuse: …` per refusal above it | the refusal's own exit, else 0 |
| `--all`, every swept team ready | one `<project> (session <session>): <summary line>` per team, then the aggregate `all teams: <T> teams swept (…)` line, on stderr; a team that failed adds `team up: <project> (session <session>): <reason>` | 0, or 1 when any swept team failed |
| `--all` with nothing to restore | `team up: nothing restored yet: no registered team has a running session in the terminal host`, `team up: nothing restored yet: no teams are registered`, or `team up: the terminal host doesn't answer` | 1 |
| `--all` with a single-team flag | the invocation refusal (`up.invocation`) | 2 |
| a caller the run does not admit | a real run: `deny`, and nothing else: no `team up:` prefix, no reason, no plan. A `--dry-run`: `! up would refuse: <the reason>`, `! to unblock: <a leads seat's own run, or the owner's>`, then the plan where the run reached one | 1 |
| the run is refused | one `team up: <reason>` per reason, on stderr, before the first step | 1 |
| a seat was left out, the server did not start, the watch did not start | the seats' records and the run's own lines | 1 |
| the up grant, or the client run it admits, does not verify (`up.client-refused`) | `team up: <reason and the owner's next step>`; nothing ran | 1 |
| the invocation can't be read | `team up: <problem>` and the usage | 2 |
| the team file can't be read | `team up: line <n>: <message>` (`team up: <message>` when the problem names no line) | 2 |

`--json` prints one `team.up` document instead: `project`, `session`, the seat names the file
declares as `seats`, `notes` — the run's other lines in order — `action_summary`, the restore
summary line, and `restore_summary`, which carries that line's `repaired`, `skipped_working` and
`refused` counts, its `repaired_seats` and `skipped_working_seats`, and its `refused_seats` with
each seat's `seat` and `reason`, beside the same `line`, with `dry_run` `false` and `status`
`ready`. With `--all` it carries `all` `true`, the per-team entries as `teams` — each with its
`project`, `session`, `status`, `failed` and `summary`, and a real pass's `restore_summary` —
every declared seat as `<project>/<seat>` in `seats`, and the aggregate line as
`action_summary`; a failed team makes the run the `up.pending` `team.error` document naming it.
A run that ends short of
ready is the `team.error` document instead, named by what fell short: `up.pending` (the seats it
names), `up.server` or `up.watch`. With `--dry-run` the document is `status` `dry-run`, `dry_run`
`true`, `action_summary` `dry run: nothing was run`, and the plan as `plan` — the warning first
when there is one, then one step per plan line, `prefix` `+`, `!` or `skip`. A refusal under
`--json` is the `team.error` document on stdout — its `id` is the contract row for that refusal
(`up.deny`, `up.invocation`, …), and a caller the run does not admit gets `message` `deny` — with
nothing on stderr; a dry run that would be refused is answered so too, and prints no plan.

## Example

```console caller=agent
$ team up --file other.yaml ; echo "exit $?"
deny
exit 1
$ team up --dry-run --file other.yaml ; echo "exit $?"
! up would refuse: only the owner or `leads` starts the team; this call is unplaced (it is run by an agent (claude) outside herdr)
! to unblock: a `leads` seat runs `team up --file other.yaml` from its own pane (the owner runs it from this folder, at a terminal outside herdr)
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/up.md](../internal/up.md).
