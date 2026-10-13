# `team answer`: rationale and known limits

What moved off [the `team answer` page](../commands/answer.md): what the run reads and
writes, the recovery it records before the key, the behaviour behind the lines it prints, the
refusals in their own words, the log lines, the exit codes with their ids, and the known limits.
The synopsis, the flags, the caller table and the outcome table stay on the page.

## What the run does: the dialog, the two reads, the one key

Presses the one recorded key of a folder-trust dialog, and only that key. Every check has to pass on two fresh reads of the pane, and the folder must be the lobby on three readings at once: the path the screen shows, the folder the pane itself reports working in, and the lobby's parent directory, where no name may sit that differs from the lobby's by whitespace alone. A row's trailing padding is stripped, so the screen's last byte alone is never proof. Anything else sends nothing.

## What it reads and writes

Reads the team file, this machine's approval and the approved copy the trust entries are read from, the seat's state, the installed CLI's version, and the pane — the screen's own lines, the folder herdr reports the pane working in, and the lobby's parent directory. The version must match a record whose own capture is registered (`src/profiles/trust-answer.ts`); Codex's record also needs a registered capture of its folder layout in the real lobby and none exists, so Codex answers nothing today. The command holds the seat's lock (`<state dir>/seat-locks/<session>/<seat>`) for its whole run, so a launch of the same seat cannot act beside it.

On success it writes `trust-sent-recovery` into the seat's state and reads it back **before** sending the key: a crash between the two leaves a recovery a retry only observes, never a dialog answered twice. Under the seat lock, on both of its fresh reads of the pane, and immediately before every terminal input — the trust key, the typed rules line, and Enter — if the seat's state holds a `launched` record (a seat stopped at a dialog has one: its launch records the identity in the same write as the waiting record; a launch from before the field existed, or one whose process herdr could not read when it stopped, has none and keeps today's check), the pane's process identity must match the recorded process (`same`); if herdr cannot read the process or it is `gone` or `replaced`, the command refuses without sending that input. Refusals before the recovery write — caller, policy, state, version, screen, label, folder and action, and both inspections — write nothing. The one refusal between the write and the key, this process check, puts the record back to exactly what it was (`waiting-owner`), written and read back under the same lock: a later `team answer` can still answer the seat, and only a crash in that window leaves `trust-sent-recovery` for a retry to observe. After the key — a send that failed, an idle prompt that did not come, rules not delivered — a refusal leaves `trust-sent-recovery` as well. If refusal happens between typing and Enter, the line notes that rules were typed and not sent. It then sends one key, waits for the idle prompt, delivers the ordinary rules, and writes the seat `ready`.

## Who may run it

The owner, from outside herdr, or the orchestrator from its own seat — the seat of that name in a session this project's state records, the file's session first and then a session the state records the caller's pane in (any session key the state holds is a session the check will try), on the pane the state records for it: a seat of another session, or a pane merely renamed to the orchestrator's name, is refused — and so is a seat the state records no pane for, or records on another pane than this call is on; those two refusals name the seat and the repair. What that proves is placement, and no more: the state file is in the project, and a process of the same user that writes its own pane there under the orchestrator's name, and renames its pane, passes. The check guards a mistaken agent, not a hostile process running as the same user. `--file` and `--session` are the owner's alone, from a terminal outside herdr: a non-owner aiming either is refused before the flagged file or session is read at all. With `dialogs.trust: owner` (the value when `dialogs` is omitted) nobody sends a key, the owner included.

## What it prints

Human output is one line: refusals and recovery on stderr, success on stdout. Under `--json`, the same outcomes print one object on stdout and stderr stays empty.

| Outcome | Exit | stdout | stderr |
| --- | --- | --- | --- |
| answered | 0 | `<seat>: trust answered; ready` | — |
| refused | 1 | — | `<seat>: <reason>` |
| recovery | 1 | — | `<seat>: trust sent; recovery required` or `<seat>: the key could not be sent; recovery required` |
| usage | 2 | — | `team answer: <message>` and the synopsis line |
| configuration | 2 | — | `team answer: <message>` |

The JSON objects, by `status`:

| status | Object |
| --- | --- |
| `answered` | `{"seat":"<seat>","dialog":"trust","status":"answered","state":"ready"}` |
| `refused` | `{"seat":"<seat>","dialog":"trust","status":"refused","reason":"<reason>"}` |
| `recovery` | `{"seat":"<seat>","dialog":"trust","status":"recovery","state":"trust-sent-recovery","reason":"<reason>"}` |
| error | `{"error":{"code":"usage"\|"configuration","message":"<message>"}}` |

The recovery reasons are `its key could not be sent`, `its idle prompt did not come`, and `its rules were not delivered`. The usage message is `a seat and trust are required`, `unknown dialog "<word>"`, or the argument parser's own message. The configuration message is the file's problem list (`line <n>: <problem>`, joined with `; `) or `the team file cannot be read`.

### Refusals

Every refusal line is `<seat>: <reason>` except an unplaced caller's, which is its reason alone and names no seat, and the four `team answer:` lines that speak to the caller rather than about the seat: `team answer: --file is the owner's, from a terminal outside herdr; this call is <caller>`, `team answer: --session is the owner's, from a terminal outside herdr; this call is <caller>`, ``team answer: no pane is recorded for seat <name> in this session: the owner stops that seat and runs `team up` ``, and ``team answer: the state records pane <pane> for seat <name> in this session, not the pane this call is on: the owner stops the team and starts it again (`team down`, then `team up`) ``. The classes are the log line's own (`refused trust: <class>`):

| Class | Reasons |
| --- | --- |
| caller | `only the owner, or the orchestrator from its own seat, can answer`; the unplaced caller's reason; `--session is the owner's…`; `no pane is recorded for seat <name>…`; `the state records pane <pane> for seat <name>…`; `the file was never approved on this machine: run \`team approve\``; `approved before records were signed: run \`team approve\` once`; the approval verification's own reason; `the file is not the approved one (<section> changed; …)`; `the approved copy of the team file cannot be read` |
| policy | `use team up and [o]` |
| state | `another command holds it`; `it is not a live seat`; `its record is not an approved seat; left as it is (the owner cleans it: team remove <seat> --abandon)`; `herdr lists more than one agent of this name; left as it is`; `the owner has the pane open`; `it is not waiting at a trust dialog`; `its recovery state could not be recorded`; the process refusal's own reason with `(it is still recorded as a recovery)` appended, when the rollback itself did not take |
| version | `this version has no trust answer` |
| screen | `the pane is not the trust dialog` |
| label | `the trust choice is not the recorded one` |
| folder | `the dialog does not show exactly one folder`; `the dialog does not show the lobby as written: the owner answers it through team up`; `the pane's folder cannot be read`; `the pane's folder is not the lobby as written`; `the lobby's parent folder cannot be read`; `the lobby's parent folder holds a name that differs from the lobby's by whitespace alone`; `this folder is not an exact trust entry`; `ask the owner to approve this exact folder and answer through team up` |
| action | `the recorded key is not one this version sends` |
| process | `the process in its pane is not the one team launched`; `its pane could not be read`; `<reason>; rules were typed, not sent` |

`action` is a well-formedness defence: it is reached only when a profile records a key byte the host does not send, which the shipped profiles (0d, 31, 61) do not.

## Exit codes

| Code | Id | Meaning |
| --- | --- | --- |
| 0 | `answer.ready` | the trust dialog was answered and the seat is ready |
| 1 | `answer.action` | the recorded key is not one this version sends |
| 1 | `answer.ambiguous` | herdr lists more than one agent of this name |
| 1 | `answer.caller` | the caller may not answer a trust dialog |
| 1 | `answer.file-owner` | `--file` is the owner's |
| 1 | `answer.folder` | the dialog's folder is not the lobby's exact trust entry |
| 1 | `answer.label` | the trust choice is not the recorded one |
| 1 | `answer.no-pane` | the state records no pane for the caller's seat |
| 1 | `answer.policy` | the file leaves trust dialogs to the owner |
| 1 | `answer.process` | the process in the pane is not the one team launched |
| 1 | `answer.recovery` | the trust answer did not complete: the seat stays in recovery, and the key may or may not have been sent |
| 1 | `answer.screen` | the pane is not the trust dialog |
| 1 | `answer.session-owner` | `--session` is the owner's |
| 1 | `answer.state` | the seat is not waiting at a trust dialog |
| 1 | `answer.unverified` | the name is not a seat of the approved copy |
| 1 | `answer.version` | this version has no trust answer |
| 2 | `answer.configuration` | the team file cannot be read |
| 2 | `answer.usage` | the invocation is not a seat and trust |

## Log lines

Every transition writes one line to `team.log`: `<ISO timestamp> answer [<who>] <seat>: <message>`. `<who>` is the class the caller check returned — `owner`, `orchestrator`, `seat`, or `unplaced` — never the owner for a caller that is not the owner. No line holds pane text, a pane id, a folder, or an unplaced reason.

| Message | When |
| --- | --- |
| `refused trust: caller` | the caller check refused |
| `refused trust: policy` | the file leaves trust dialogs to the owner |
| `refused trust: state` | the lock, seat, waiting state, or recovery write refused |
| `refused trust: version` | no record matches the printed version, or it changed between reads |
| `refused trust: screen` | the pane is not the trust dialog |
| `refused trust: label` | the recorded label is not marked on screen |
| `refused trust: folder` | the screen's path, the pane's own folder, or the lobby's parent is not the lobby as written, or the folder is not an exact trust entry |
| `refused trust: action` | the recorded key is not one this version sends, or the send failed |
| `refused trust: process` | the process in the pane is not the one team launched, or its pane could not be read |
| `refused trust: idle` | the key was sent; the idle prompt did not come |
| `refused trust: rule delivery` | the key was sent; the rules were not delivered |
| `trust answered` | the seat is ready |

## Examples, moved here whole

The examples below are the page's own, moved here whole. The console is also on
[the `team answer` page](../commands/answer.md).

```console
$ team answer
team answer: a seat and trust are required
Usage: team answer <seat> trust [--session <name>] [--file <path>] [--json]
```

## Known limits

A process can still change between that last read and the input itself (two herdr calls), as for every read-then-act in `team`.
