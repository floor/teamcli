# team up

Starts the team: the herdr session when it is not up, a workspace and a seat for every seat the file
declares and this machine can run, and the watch, in a workspace of its own labelled
`Watch · <project>`. A fresh launch of
the orchestrator or the operator starts in the project folder; every other seat starts in the team's
lobby. A seat already running or ready is left as it is — its pane is not closed, moved or typed
into — and its sidebar is rewritten from the file either way. A seat the file marks `human: true`
is a human's own pane: the plan skips it — nothing is launched into it or typed into it; left as
it is — and it does not count as short of ready.

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

## Synopsis

    team up [--dry-run] [--serial] [--session <name>] [--file <path>] [--json]
    team up --client <grant-file> --key <client-key> [--team <team>] [--dry-run] [--serial] [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--dry-run` | — | prints the plan and runs nothing; prints the refusals the real run would stop on as `! up would refuse: …` above it, and, for a caller the run does not admit, `! to unblock: …` with the command that admits it |
| `--serial` | — | launches and waits on one seat at a time instead of concurrently |
| `--session` | `<name>` | the herdr session to start, instead of `team.session`; the owner's alone |
| `--file` | `<path>` | the team file, instead of `.agents/team.yaml`; the owner's alone |
| `--client` | `<grant-file>` | the client form: an owner-signed up grant for one team, see [A client's up grant](#a-clients-up-grant) |
| `--key` | `<client-key>` | the client's private key file, which proves the client holds the key the grant names; required with `--client`, refused without it |
| `--team` | `<team>` | with `--client`, the team the grant is for, so the run can be made from outside its folder |
| `--json` | — | one `team.up` document instead of the working lines; a refusal is the `team.error` document on stdout, with stderr empty |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| the owner | run it, from a terminal outside herdr |
| a seat an active create-grant names by its own registry id | run it, on the paths that record covers and before it expires |
| a run with no terminal | a real run is refused: ``team up: only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane``; `--dry-run` prints the plan and `! up would refuse:` with that sentence, and launches nothing |
| a seat this team's record marks `leads` — its orchestrator, or a registry roster line that says `leads` | run it on this folder's own team file, and the run does not relaunch or close that seat. `--session` and `--file` are refused before either is read |
| a caller the run admits | run `--dry-run`, which reaches nothing and changes nothing |
| a caller the run does not admit | a real run is answered with the one word `deny` on stderr and nothing on stdout — no reason, and no plan — and exit 1. A `--dry-run` is never denied: it prints `! up would refuse:` with that reason, `! to unblock:` with a `leads` seat's own run of this folder from its pane (or the owner's, from a terminal outside herdr), and — when no flag kept the file unread — the plan, and exits 1 |
| the orchestrator's seat, where the row above does not admit it and the file's `grant` lists `up` | run it on this folder's own team file, and the run is audited as the grant's. A lead the map admits is not constrained by a grant, and the grant or delegate path applies only to seats the map does not admit: a grant that names another seat or pane, or leaves `up` out of its scope, refuses this fallback run, and a run the map admitted asks it nothing and is audited only as the row's. A file with no `grant` section grants nothing. The run does not relaunch or close that seat. `--session` and `--file` are refused before either is read, in the grant's words |
| a seat of this team the record does not mark `leads`, or a pane of another session | run `--dry-run` only; a real run is refused, unless the live `grant` admits the orchestrator's seat or the live file's `delegates` section names that pane with `up` in its entry's `commands`, and a `--session` or `--file` it passes is refused before either is read |

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
<team> --up`, see [team grant](grant.md)) brings up that one team with:

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

## Output and exit codes

Each pass ends with one restore summary, written even when all three counts are zero: `N seats
repaired, M skipped (working), K refused`, with ` (seat: why; …)` appended for the seats the pass
would not repair.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| every seat ready, watch running | one `<seat>: ready` record per seat in file order, on stdout; `watch: started` and the restore summary line, on stderr | 0 |
| `--dry-run` | the plan; `! up would refuse: …` per refusal above it | the refusal's own exit, else 0 |
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
`ready`. A run that ends short of
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
