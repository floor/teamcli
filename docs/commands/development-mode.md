# team development-mode

One name, one machine-wide setting, above every team and project. `team development-mode` reads
the setting; `team development-mode set <local-fast|pr-per-change|off>` writes it. The value is
the whole machine's: it governs the everyday caller gates and the owner-gate admission together,
and while the record is present the legacy per-team `dev-mode` word is ignored. An absent record
leaves everything as it was, and the setting is off by default: with no record, nothing is set
and only the legacy per-team `dev-mode` declaration, or the migration variable while no
declaration governs, can lift; `off` beats them; and of the three machine modes, only
`local-fast` lifts anything.

| Mode | What it does |
| --- | --- |
| `local-fast` | lifts the caller gates of ten operations, the team file's approval precondition, named owner-only gates for a placed orchestrator, the designated installer's approval, and one untested Antigravity release in `team reload` |
| `pr-per-change` | keeps the process half and lifts no gate at all |
| `off` | lifts nothing, and beats every legacy source |

The write is the owner's, and it is signed: the record is written with the owner's existing
approval key under the setting's own domain, marked `setter: owner`, with the signing moment and
the machine's own generation. This command creates no key and no grant. A machine with no owner
key refuses the switch and names the owner terminal's signed-write path; the repair is to run the
switch there.

`--show` (or `--dry-run`) is the non-terminal path and is read-only: anyone may ask it, and it
writes nothing, logs nothing and types nothing. It prints the mode that would be set, the current
setting, and `Owner-authorization fingerprint: <hex>` — the digest of this machine, the exact
mode and the generation the record stands at now. The owner reads the fingerprint back, and the
same `set` run with `TEAM_OWNER_APPROVAL` holding that hex is admitted. An empty or arbitrary
token never matches; the token is never logged and never written into the record; and because it
binds the prior generation, a token shown for one switch never authorizes another — a switch that
finds the generation moved refuses and says to show the fingerprint again.

`set <mode> --request` is the owner-seat path, exactly as `team config set … --request` records a
record change: it records one owner-seat request naming this switch — for `local-fast` the card
reads `Turn on fast local development` / `Stop asking Touch ID for routine team changes on this
Mac. OK?` / `This Mac · all teams`, and the other modes say their own lines — and writes nothing. The owner answers it on her owner page (a passkey or
Touch ID signature), and `team development-mode set <mode> --approval <request-id>` applies the
switch once that verified answer binds these words; when the owner seat's Touch ID signer is
present at the request, the answer is taken then and the switch applies in the same run. The
request is bound to the caller's repository, team, HEAD and words, and the mode named on the
command is one of those words: an answer for `local-fast` does not apply `off`, and an approval
for another request, another folder or another HEAD refuses. No charter admits this switch,
because the setting is the machine's and not a folder's: only the owner's own answer stands for
her. A request and `--show` are not combined: `--show` prints the fingerprint and writes nothing,
and `--request` records the switch.

A record the machine cannot trust is not applied: an unreadable or malformed record, an unknown
field, a mode or scope this build does not know, an unreadable signing date or generation, a
missing signature, a signature that does not verify under this machine's owner key, a missing
generation counter, a counter that disagrees with the record, or a record that is missing while
its counter exists — all are refused, and nothing is lifted on any of them. The owner's next
switch is the repair.

## What dev mode lifts

With dev mode on, five lifts follow.

**The caller gates of ten operations.** The caller gate of `up`, `down`, `remove` of an ordinary
seat, `register`, `add`, `restart`, `init`, `reload`, `rename` and `peek` folds. `peek` is the one
lift that only reads a screen. The run prints
`warning: <the refusal>; dev mode continues` — with the level appended when a policy or the
machine record set it: `(dev-mode on at <level> level)`, or `(dev-mode on at machine level)` for
the machine record — and goes on; the act it carries out is logged with the command and the
caller. `down`'s caller-placement line is the one warning whose form follows the source: the
variable's run prints it with `; dev mode continues`, while a run a policy or the machine record
admits prints the level note alone,
`warning: <the refusal> (dev-mode on at <level> level)`.

**The team-file approval precondition.** Where a run asks for the team's approved file — the
delegate gate of `up`, `add`, `remove`, `down` and `register`, the grant gate of `up`, `remove`,
`down` and `reload`, and the standing check `add`, `remove` and `down` make — dev mode on lets
the live team file count as approved, with
`warning: <the refusal>; the live team file <path> counts as approved; dev mode continues`, the
level appended as above when a policy or the machine record set it. Only that precondition
moves: the delegated entry, the caller's placement, the grant's seat and scope, the target and
the file itself stay checks.

**Named owner-only gates, for a placed orchestrator.** A team's orchestrator — the lead its file
resolves to, whether it was spelled `coordinator:` or by `leads: true` — continues past these
gates when it stands on the pane the team's own state records for it, in the team's session. The
main orchestrator is admitted the same way for a team under it: a team the registry holds whose
folder strictly holds the target's, whose file names the caller its orchestrator under the
target file's entity, and whose session places it on the pane its state records. The owner's own
path is untouched, and outside the `lead-gates` policy below no other seat is admitted — the
admission is the one name the file resolves as its lead.

- `team grant`, `team delegate`, `team revoke`
- `team policy set`, `team policy unset`
- `team check --repair`
- `team remove --abandon`, `team down --abandon`
- `team broker`, `team tempo`
- `team daemon install`, `team daemon restart`, `team daemon uninstall`, `team daemon fault-watch`
  — `team daemon run` is not this gate, and no mode admits a seat to it

**The operator place, under the `lead-gates` policy.** While dev mode is on, the enforced
`lead-gates` policy — set at entity, project or team, never at a seat — admits the file's own
`operator:` seat to five of the gates above when its effective value reads `lead+operator` for
the caller's chain: `team check --repair`, `team remove --abandon`, `team down --abandon`,
`team policy set` and `team policy unset`, and `team daemon restart`. `team answer` admits the
same place under the same policy; its own page says so. The proof is the lead's own: the seat
must stand on the pane the team's state records for it, in the team's session. The run prints
the same `dev mode continues` warning and writes the same audit line, with `admitted as
operator` naming the role. Everything else stays the lead's or the owner's: `grant`, `delegate`
and `revoke`, `broker` and `tempo`, the daemon's `install`, `uninstall` and `fault-watch`, and
the main-orchestrator route above have no operator share. The policy's default `lead` — and a
chain that cannot be read — admit no operator; a nearer level that keeps `lead` cannot be
widened by a farther `lead+operator`; and a seat spelled both `operator:` and the lead is the
lead, never the operator.

**The installer designation.** `team queue install` normally records an install only while the
file's `installer:` section is part of the approval in force. With dev mode on at the team's
place, the live file's validated designation stands: the seat it names, on the pane the team's
state records for it, records the install. The audit log then carries `warning: <the refusal>;
dev mode continues`, with the level appended as above, and the seat as admitted as `installer`;
the run itself prints only the install summary. Only the approval of the designation moves: the
declared seat, its recorded pane and the exact `installer:` name stay checks.

**One untested release in `team reload`.** Before it closes anything, `team reload` reads the
CLI's printed version against its profile's tested range and refuses `reload.untested` outside
it. With dev mode on, one release is admitted: Antigravity's `agy` `1.4.3`, the release after the
profile's tested `1.2.16` to `1.4.2`, closes and relaunches anyway, with `team reload: warning:
<the reading>; dev mode continues` on stderr and the level appended as above. The profile's
tested range never widens; every other CLI and version, and every run with dev mode off, keeps
the refusal.

Every lift logs its warning with the command and the caller, and every one carries the
`dev mode continues` clause except `down`'s caller-placement line under a policy or the machine
record, which carries the level note alone; the owner, operator and installer admissions add the
role they proved. The caller-gate, file-approval, owner-gate and reload warnings also print to
stderr, while the installer admission's is in the audit log alone.

## What it never lifts

- **The client pane guard.** It is a machine guard, and dev mode never lifts it: `team send
  --client`, `team messages --client`, `team client keygen`, `team grant --client-request`, a
  holder's `team client general-grant --via --key`, and every grant-verified `--client` form
  (`team up --client`, `team down --client`, `team status --client`, and the bundle ops `add`,
  `hold`, `pause`, `reload`, `remove`, `restart`, `resume`, `seat`, `seats` and `sessions`) refuse
  a caller that runs inside a team pane, whatever mode is on — a lift would hand a seat's own
  process the key the guard exists to keep out of it. The general door, `--general <grant.json>
  --key <client.key>` on a command, and the own `--general` doors of `up`, `init` and `config` are
  deliberately not pane-guarded: an owner tool applies changes under a general grant from inside a
  team pane, and the grant's own bounds cover the call.
- **The load guard.** After a caller gate folds, `up`, `restart` and `add` still pass the
  launcher's own admission: load per core, free memory, free disk, memory pressure and swap
  growth against the team file's `machine:` limits, and the seat ceiling. A launch over them is
  refused or the seat is left out.
- **The swap gate.** `team swap` answers exactly as it does with dev mode off: the charter, the
  owner's `now`, the caller judgement for a queued change and the team-read check do not read
  dev mode.
- **Every public action.** `team pr check`, the pull request body check, answers exactly as with
  dev mode off. Dev mode never authorizes anything that leaves the machine — publishing a
  package or a release, tagging, pushing to a shared remote — and TeamCLI does not do those on a
  seat's behalf anyway.
- **The switch itself.** `set` stays the owner's, the matching owner-authorization token's, or the
  owner's answer to a recorded request; no mode turns dev mode on or off by itself, and no charter
  admits it.
- **Every gate this page does not list.** A gate the page leaves out keeps its refusal: what this
  page lists is the whole of the widening it records.

## Synopsis

    team development-mode [--json]
    team development-mode set <local-fast|pr-per-change|off> [--show] [--dry-run] [--json]
    team development-mode set <local-fast|pr-per-change|off> --request [--json]
    team development-mode set <local-fast|pr-per-change|off> --approval <request-id> [--json]

`set` takes exactly one mode; `--show` and `--dry-run` mean the same thing on it. With no
subcommand the setting is read. Any other word is an invocation error.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--show` | — | on `set`: print the mode, the current setting and the authorization fingerprint; write nothing |
| `--dry-run` | — | the same as `--show` |
| `--request` | — | on `set`: record the switch as one owner-seat request; write no mode |
| `--approval` | a request id | on `set`: apply the switch once the owner's verified answer binds these words |
| `--json` | — | one `team.development_mode` document instead of the line |
| `--help`, `-h` | — | the usage, and exit 0 |

## What it reads and writes

Reads `~/.config/team/development-mode.json`, the generation counter beside it under the machine
config folder, and the owner approval key this machine holds, which verifies the record's
signature. A write bumps the machine counter, signs the new record, replaces the file whole
(mode 0600 in a 0700 folder) and reads it back: a record that does not read back as the mode and
generation just written is a refusal, and the machine setting is not in force. The log gains one
line naming the mode, the previous mode and the caller; it never carries the token or the
fingerprint.

The read never repairs a record. It answers one of three ways: `not set` (this machine never
carried one, and the legacy behaviour is untouched), the setting (the signature and the counter
agree), or a refusal with its reason.

## Who may run it

| Call | Who |
| --- | --- |
| read, `set … --show` / `--dry-run`, or `set … --request` | anyone; the first two are read-only, and the third records a request and writes no mode |
| `set <mode> --approval <request-id>` | anyone holding the owner's verified answer to that request |
| `set <mode>` | the owner, from a terminal outside herdr, or the same run carrying the owner-authorization token for exactly that switch |

A caller who is not the owner, has no matching token and no owner-seat answer is refused:
`only the owner switches the machine development mode, from a terminal outside herdr, or with the
owner-authorization token for this exact switch; this call is <placement>`.

## Output and exit codes

The read prints one line:

- `dev mode: <mode>, since <date>, set by the owner` — the record is set and trusted;
- `dev mode: not set; …` — this machine never carried a record;
- `dev mode: the machine setting cannot be read (<why>); no caller gate is lifted` — the record is
  refused, and that refusal is visible wherever the gates are read.

`set … --show` prints `would set the machine development mode to <mode>`, then the current
setting's line, then `Owner-authorization fingerprint: <hex>`. A successful `set` prints the
setting line, with `; owner-token-authorized` appended when the token admitted it rather than the
owner.

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the setting is read (set or not set), shown, changed, or a request is recorded | the line above | 0 |
| a record that cannot be trusted is read | the refusal note | 1 |
| the write is refused (not the owner, no matching token, no owner key, the generation moved, the record did not read back) | `team development-mode: <reason>` | 1 |
| the approval is refused (not a request id, another switch's answer, unanswered, expired or already used) | `team development-mode: <reason>` | 1 |
| the invocation is invalid | `team development-mode: <problem>`, with the usage | 2 |

`--json` prints `{"schema": {"name": "team.development_mode", "version": 1}, "format": 1,
"machine": true, "set": …, "mode": …, "since": …, "set_by": …, "generation": …,
"caller_gates_lifted": …, "notice": …}`; a write adds `dry_run`, and a completed write `previous`
and `token_authorized`, while `--show` adds `fingerprint`. A `--request` run prints the
owner-seat request document (`status: "requested"`, the request id, its expiry and the command
that applies it), as `team config … --request` does. A refusal prints the `team.error` document
with `development-mode.refused`, `development-mode.approval-refused` or
`development-mode.invocation` as its id.
