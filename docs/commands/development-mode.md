# team development-mode

One name, one machine-wide setting, above every team and project. `team development-mode` reads
the setting; `team development-mode set <local-fast|pr-per-change|off>` writes it. The value is
the whole machine's: it governs the everyday caller gates and the owner-gate admission together,
and while the record is present the legacy per-team `dev-mode` word is ignored. An absent record
leaves everything as it was.

| Mode | What it does |
| --- | --- |
| `local-fast` | lifts the caller gates of the development operations |
| `pr-per-change` | keeps the process half and lifts no caller gate |
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

A record the machine cannot trust is not applied: an unreadable or malformed record, an unknown
field, a mode or scope this build does not know, an unreadable signing date or generation, a
missing signature, a signature that does not verify under this machine's owner key, a missing
generation counter, a counter that disagrees with the record, or a record that is missing while
its counter exists — all are refused, and no caller gate is lifted on any of them. The owner's
next switch is the repair.

## Synopsis

    team development-mode [--json]
    team development-mode set <local-fast|pr-per-change|off> [--show] [--dry-run] [--json]

`set` takes exactly one mode; `--show` and `--dry-run` mean the same thing on it. With no
subcommand the setting is read. Any other word is an invocation error.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--show` | — | on `set`: print the mode, the current setting and the authorization fingerprint; write nothing |
| `--dry-run` | — | the same as `--show` |
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
| read, or `set … --show` / `--dry-run` | anyone; both are read-only |
| `set <mode>` | the owner, from a terminal outside herdr, or the same run carrying the owner-authorization token for exactly that switch |

A caller who is not the owner and has no matching token is refused:
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
| the setting is read (set or not set), shown, or changed | the line above | 0 |
| a record that cannot be trusted is read | the refusal note | 1 |
| the write is refused (not the owner, no matching token, no owner key, the generation moved, the record did not read back) | `team development-mode: <reason>` | 1 |
| the invocation is invalid | `team development-mode: <problem>`, with the usage | 2 |

`--json` prints `{"schema": {"name": "team.development_mode", "version": 1}, "format": 1,
"machine": true, "set": …, "mode": …, "since": …, "set_by": …, "generation": …,
"caller_gates_lifted": …, "notice": …}`; a write adds `dry_run`, and a completed write `previous`
and `token_authorized`, while `--show` adds `fingerprint`. A refusal prints the `team.error`
document with `development-mode.refused` or `development-mode.invocation` as its id.
