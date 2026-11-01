# `team answer`: rationale and known limits

What moved off [the `team answer` page](../commands/answer.md): what the run reads and
writes, the recovery it records before the key, the behaviour behind the lines it prints, the
refusals in their own words, the log lines, the exit codes with their ids, and the known limits.
The synopsis, the flags, the caller table and the outcome table stay on the page.

## What the run does: the dialog, the two reads, the one key

Two words answer two kinds of blocking dialog, and each presses one recorded key — never an
option, never a typed answer.

`trust` presses the one recorded key of a folder-trust dialog. Every check has to pass on two
fresh reads of the pane, and the folder must be the lobby on three readings at once: the path
the screen shows, the folder the pane itself reports working in, and the lobby's parent
directory, where no name may sit that differs from the lobby's by whitespace alone. A row's
trailing padding is stripped, so the screen's last byte alone is never proof. Anything else
sends nothing.

`question` dismisses a question, plan approval or confirmation dialog with that CLI's recorded
let-me-type-or-cancel key — `escape` or `ctrl+c`, the closed set `src/profiles/question-answer.ts`
parses. The two fresh reads must agree on the dialog kind and on the text the screen shows, and
the record each read matched must agree with the other; a pane that changed between the reads is
refused, never answered. The text is the dialog's whole block: a profile reads to the row that
ends it, and a question still going when the version's supported rows run out is refused
(`answer.incomplete`) rather than answered on the part of it that was visible. A permission
prompt is refused by its screen kind, and so is a login prompt; a trust dialog is refused with
the word that answers it, `team answer <seat> trust`. A screen that reads as none of the three
answerable dialogs is refused too: the question word answers a question, a plan approval or a
confirmation and nothing else. Trust-to-run-a-command counts as a permission prompt and is
never answered.

The dismissal key only clears the dialog. It never selects a choice, and no option is marked or
chosen. Immediately after the key, the seat receives one decision line in its own conversation,
through the ordinary send path — the send command's own admission, delivery order and record,
with both writers silenced so its report is not this command's output. The line, word for word:
`decide within your rules or ask your orchestrator with team send`. Nothing is typed at the
dialog; the line arrives the way any other message to the seat arrives.

## What it reads and writes

Reads the team file, the seat's state, the installed CLI's version, and the pane — the screen's
own lines, the folder the terminal host reports the pane working in, and the lobby's parent
directory. The version must match an answer record: the trust word's record is keyed to the
exact printed version and also needs its own capture registered (`src/profiles/trust-answer.ts`),
while a question-answer record matches the printed version either exactly or by a version range
(`src/profiles/question-answer.ts`). A question-answer range covers whole versions, and
overlapping records for one dialog kind are refused when the profile is parsed, so a version
never carries two answers for the same kind. Codex's trust record also needs a registered
capture of its folder layout in the real lobby and none exists, so Codex answers no trust
dialog today. The command holds the seat's lock (`<state dir>/seat-locks/<session>/<seat>`) for
its whole run, so a launch of the same seat cannot act beside it.

The `question` word additionally reads the team file of the folder this run was started in,
before anything is pressed: the decision line travels the ordinary send path, and that path
loads its team from the run's folder. The landing must be this seat's team and the session must
be the team's own; otherwise the run refuses as a configuration error before any key. The two
teams are compared whole — roster, session and all — because one folder can hold a second team
file beside the default the send path reads, and a file for another team or another session is
refused, never sent through. This is what keeps a dismissal from sending the line to another
team's — or another session's — seat of the same name after this pane's dialog is already gone.

On success it writes the word's own recovery into the seat's state — `trust-sent-recovery` or
`question-sent-recovery` — and reads it back **before** sending the key: a crash between the
two leaves a recovery a retry only observes, never a dialog answered twice. Under the seat
lock, on both of its fresh reads of the pane, and immediately before the one terminal input it
sends — the recorded key — and again after the key for a profile whose launch carried the rules
line, if the seat's state holds a `launched` record (a seat stopped at a dialog has one: its
launch records the identity in the same write as the waiting record; a launch from before the
field existed, or one whose process the terminal host could not read when it stopped, has none
and keeps today's check), the pane's process identity must match the recorded process (`same`);
if the terminal host cannot read the process or it is `gone` or `replaced`, the command refuses
before sending that input, or after the key before recording the seat ready. Refusals before
the recovery write — caller, policy, state, version, screen, label, folder and action, and both
inspections — write nothing. The one refusal between the write and the key, this process check,
puts the record back to exactly what it was (`waiting-owner`), written and read back under the
same lock: a later `team answer` can still answer the seat, and only a crash in that window
leaves the recovery for a retry to observe. After the key — a send that failed, the decision
line that could not be delivered, an idle prompt that did not come, rules not delivered — a
refusal leaves the recovery as well. For `question` the record also keeps the dialog kind it
answered, so a retry that only delivers the line still names that kind in its summary.

After the key it waits for the idle prompt, writes the rules file for a `message`-mode profile,
re-checks the process against the launched identity where the profile's launch carried the
rules line, and writes the seat `ready`. A profile whose rules mode is `option` or `prepend`
returns at the mode test, and no rules line is typed into a pane on any path.

A retry of the same word never presses a second key. `question-sent-recovery` is delivery-only:
the retry puts the decision line through the send path while the record says it is owed — a
first-run delivery failure leaves that record untouched — then finishes the seat. Once the send
path has taken the line, the record is marked `delivered` and read back, so a retry after a
readiness-only failure only finishes the seat and never sends the line a second time; a marker
that cannot be written once the line is out leaves the recovery recorded and says so.
`trust-sent-recovery` finishes the seat through the same ready check as a first answer. The
other word refuses the recovery and names the word that completes it.

## Who may run it

The owner, from outside the terminal host, or the orchestrator from its own seat — the seat of
that name in a session this project's state records, the file's session first and then a
session the state records the caller's pane in (any session key the state holds is a session
the check will try), on the pane the state records for it: a seat of another session, or a pane
merely renamed to the orchestrator's name, is refused — and so is a seat the state records no
pane for, or records on another pane than this call is on; those two refusals name the seat and
the repair. What that proves is placement, and no more: the state file is in the project, and a
process of the same user that writes its own pane there under the orchestrator's name, and
renames its pane, passes. The check guards a mistaken agent, not a hostile process running as
the same user. `--file` and `--session` are the owner's alone, from a terminal outside the
terminal host: a non-owner aiming either is refused before the flagged file or session is read
at all.

Both words share one owner switch. With a team grant carrying `dialogs.trust` in force for this
project's team id (`team grant @team --capabilities dialogs.trust`) a dialog may be answered;
with none — the default — nobody sends a key, the owner included, for either word, and the
refusal names the setting: `<seat>: use team up and [o] (dialogs.trust is off; only the owner
can turn it on: team grant @team --capabilities dialogs.trust)`. The record is read fresh on
every run, so a revocation takes effect at the next dialog, and no approval stands behind the
answer.

## What it prints

Human output is the team's context line and one summary line on stdout on success; refusals,
recovery and a delivery failure go to stderr. Under `--json`, a success prints one action
document on stdout, and a run that exits 1 or 2 prints the structured `team.error` document on
stdout too — stderr stays empty in both cases.

| Outcome | Exit | stdout | stderr |
| --- | --- | --- | --- |
| answered (trust) | 0 | `team <project>, session "<session>"`, then `<seat>: answered trust (<folder>)` | — |
| answered (question) | 0 | `team <project>, session "<session>"`, then `<seat>: answered question (<dialog>)` | — |
| refused | 1 | — | `<seat>: <reason>` |
| recovery | 1 | — | `<seat>: trust sent; recovery required`, `<seat>: question sent; recovery required`, `<seat>: the key could not be sent; recovery required`, or `<seat>: the decision line was delivered, but its record could not be marked; recovery required` |
| delivery | 1 | — | `<seat>: the dialog was dismissed, but the decision line could not be delivered; recovery required`, or on a retry `<seat>: the decision line could not be delivered; recovery required` |
| usage | 2 | — | `team answer: <message>` and the usage |
| configuration | 2 | — | `team answer: <message>` |

The closing line names the dialog kind for `question`: `question`, `plan approval` or
`confirmation`, the same word the screen reading calls it. The JSON documents, by outcome:

| Outcome | Document |
| --- | --- |
| answered (trust) | `{"schema":{"name":"team.answer","version":1},"format":1,"dry_run":false,"status":"answered","action_summary":"<seat>: answered trust (<folder>)","project":"<project>","session":"<session>","seat":"<seat>","pane":"<pane>","dialog":"trust","state":"ready","folder":"<folder>"}` |
| answered (question) | `{"schema":{"name":"team.answer","version":1},"format":1,"dry_run":false,"status":"answered","action_summary":"<seat>: answered question (<dialog>)","project":"<project>","session":"<session>","seat":"<seat>","pane":"<pane>","dialog":"question","dialog_kind":"<dialog>","state":"ready"}` |
| refused, recovery, delivery, usage, configuration | `{"schema":{"name":"team.error","version":1},"error":{"id":"<answer.* row>","message":"<message>","repair":<string\|null>}}` |

`error.id` is the contract row for the refusal site (`answer.recovery` on a run that did not
complete, `answer.delivery` on a dismissed dialog whose decision line is still owed,
`answer.usage` and `answer.configuration` on a bad invocation, file or send path), and
`error.message` is the sentence above without a `team answer: ` prefix. `error.repair` is a
repair string where one applies — `answer.detached` carries `run team answer from a terminal
outside herdr` — and `null` elsewhere. A recovery retry whose trust record carries no folder
prints the summary without the parenthetical.

The usage message is `a seat and trust or question are required`, `unknown dialog "<word>"`, or
the argument parser's own message. The configuration message is the file's problem list (`line
<n>: <problem>`, joined with `; `), `the team file cannot be read`, or one of the send-path
sentences: `the decision line is sent from <cwd>, which holds no readable team file`, `the
decision line is sent with the team file of <cwd>, which is not this seat's team`, `the
decision line is sent with the team file of <cwd>, which is not the team this answer read`,
`the decision line is sent in session <session>, and this answer read session <session>`, and
`the decision line is sent in the team's own session (<session>), and this run answered in
<session>`.

### Refusals

Every refusal line is `<seat>: <reason>` except an unplaced caller's, which is its reason alone
and names no seat, and the five `team answer:` lines that speak to the caller rather than about
the seat: `team answer: --file is the owner's, from a terminal outside herdr; this call is
<caller>`, `team answer: --session is the owner's, from a terminal outside herdr; this call is
<caller>`, ``team answer: no pane is recorded for seat <name> in this session: a lead stops
that seat and runs `team up` ``, ``team answer: the state records pane <pane> for seat <name>
in this session, not the pane this call is on: a lead stops the team and starts it again
(`team down`, then `team up`) ``, and `team answer: only the owner or the orchestrator from its
own seat runs this, from a terminal outside herdr or its own seat` — a run placed with no
terminal, judged before the file or the caller is read. The classes are the log line's own
(`refused trust: <class>` or `refused question: <class>`):

| Class | Reasons |
| --- | --- |
| caller | `only the owner, or the orchestrator from its own seat, can answer`; the unplaced caller's reason; `--session is the owner's…`; `no pane is recorded for seat <name>…`; `the state records pane <pane> for seat <name>…` |
| policy | `use team up and [o] (dialogs.trust is off; only the owner can turn it on: team grant @team --capabilities dialogs.trust)` |
| state | `another command holds it`; `it is not a live seat`; `its record is not an approved seat; left as it is (the owner cleans it: team remove <seat> --abandon)`; `herdr lists more than one agent of this name; left as it is`; `the owner has the pane open`; `it is not waiting at a trust dialog`; `it is not waiting at a question, plan approval or confirmation dialog`; `a trust answer was sent; complete it with team answer <seat> trust`; `a question was sent; complete it with team answer <seat> question`; `its recovery does not name a dialog this version answers`; `its recovery state could not be recorded`; the process refusal's own reason with `(it is still recorded as a recovery)` appended, when the rollback itself did not take |
| version | `this version has no trust answer`; `this version has no question answer` |
| screen | `the pane is not the trust dialog` |
| label | `the trust choice is not the recorded one` |
| folder | `the dialog does not show exactly one folder`; `the dialog does not show the lobby as written: the owner answers it through team up`; `the pane's folder cannot be read`; `the pane's folder is not the lobby as written`; `the lobby's parent folder cannot be read`; `the lobby's parent folder holds a name that differs from the lobby's by whitespace alone`; `this folder is not an exact trust entry`; `ask the owner to add this exact folder to trust and answer through team up` |
| action | `the recorded key is not one this version sends` |
| process | `the process in its pane is not the one team launched`; `its pane could not be read` |
| human | `the pane is a human's; no dialog key is pressed and no rules line is typed; left as it is` |
| permission | `the pane is at a permission prompt, which is never answered` |
| login | `the pane is at a login prompt, which is never answered` |
| not-a-question | `the pane is at a trust dialog; team answer <seat> trust answers it`; `the pane is not at a question, plan approval or confirmation dialog` |
| incomplete | `the question runs past the rows this version reads; left as it is` |
| disagree | `the two fresh reads of the pane do not agree on the dialog` |

`action` is a well-formedness defence: it is reached only when a profile records a key byte the
host does not send, or a question-answer record carries a key outside the closed set
(`escape`, `ctrl+c`), which the shipped profiles do not.

## Exit codes

| Code | Id | Meaning |
| --- | --- | --- |
| 0 | `answer.question` | the question dialog was answered: dismissed with the recorded key, and the seat sent the decision line |
| 0 | `answer.ready` | the trust dialog was answered and the seat is ready |
| 1 | `answer.action` | the recorded key was not sent |
| 1 | `answer.ambiguous` | herdr lists more than one agent of this name |
| 1 | `answer.another-pane` | the state records another pane for the caller's seat |
| 1 | `answer.caller` | the caller may not answer a dialog |
| 1 | `answer.delivery` | the dialog was dismissed, but the decision line could not be delivered; the recovery stays recorded |
| 1 | `answer.detached` | a run with no terminal |
| 1 | `answer.disagree` | two fresh reads of the pane do not agree on the dialog |
| 1 | `answer.file-owner` | `--file` is the owner's |
| 1 | `answer.folder` | the dialog's folder is not the lobby's exact trust entry |
| 1 | `answer.human` | the seat is a human's pane; no dialog key is pressed and no rules line is typed |
| 1 | `answer.incomplete` | the question runs past the rows this version reads; it is not answered |
| 1 | `answer.label` | the trust choice is not the recorded one |
| 1 | `answer.login` | the pane is at a login prompt; it is never answered |
| 1 | `answer.no-pane` | the state records no pane for the caller's seat |
| 1 | `answer.not-a-question` | the pane is not at a question, plan approval or confirmation dialog |
| 1 | `answer.permission` | the pane is at a permission prompt, including trust to run a command; it is never answered |
| 1 | `answer.policy` | the dialogs.trust grant is not in force |
| 1 | `answer.process` | the process in the pane is not the one team launched |
| 1 | `answer.recovery` | the answer did not complete: the seat stays in recovery |
| 1 | `answer.screen` | the pane is not the trust dialog |
| 1 | `answer.session-owner` | `--session` is the owner's |
| 1 | `answer.state` | the seat is not waiting at the dialog this word answers |
| 1 | `answer.unverified` | the name is not a declared seat |
| 1 | `answer.version` | this version has no answer for the dialog |
| 2 | `answer.configuration` | the team file cannot be read, or the decision line would go to another team |
| 2 | `answer.usage` | the invocation is not a seat and trust or question |

## Log lines

Every transition writes one line to `team.log`: `<ISO timestamp> answer [<who>] <seat>:
<message>`. `<who>` is the caller as the log names it — `owner`, the caller's own seat name, or
`unplaced` — never the caller's role (the orchestrator's seat logs as its name) and never the
owner for a caller that is not the owner. No line holds pane text, a pane id, a folder, or an
unplaced reason.

| Message | When |
| --- | --- |
| `refused trust: caller` | the caller check refused the trust word |
| `refused question: caller` | the caller check refused the question word |
| `refused trust: policy` | the dialogs.trust grant is not in force |
| `refused question: policy` | the dialogs.trust grant is not in force |
| `refused trust: state` | the lock, seat, waiting state, or recovery write refused |
| `refused question: state` | the lock, seat, waiting state, cross-word recovery, or recovery write refused |
| `refused trust: version` | no record matches the printed version, or it changed between reads |
| `refused question: version` | no question-answer record matches the printed version |
| `refused trust: screen` | the pane is not the trust dialog |
| `refused trust: label` | the recorded label is not marked on screen |
| `refused trust: folder` | the screen's path, the pane's own folder, or the lobby's parent is not the lobby as written, or the folder is not an exact trust entry |
| `refused trust: action` | the recorded key is not one this version sends, or the send failed |
| `refused question: action` | the recorded key is outside the closed set, or the send failed |
| `refused trust: process` | the process in the pane is not the one team launched, or its pane could not be read |
| `refused question: process` | the process in the pane is not the one team launched, or its pane could not be read |
| `refused trust: human` | the seat is a human's pane |
| `refused question: human` | the seat is a human's pane |
| `refused question: permission` | the pane is at a permission prompt, including trust to run a command |
| `refused question: login` | the pane is at a login prompt |
| `refused question: not-a-question` | the pane is at a trust dialog, or at none of the three answerable dialogs |
| `refused question: incomplete` | the question block runs past the rows this version reads |
| `refused question: disagree` | the two fresh reads of the pane do not agree |
| `refused trust: idle` | the key was sent; the idle prompt did not come |
| `refused question: idle` | the key was sent; the idle prompt did not come |
| `refused trust: rule delivery` | the key was sent; the rules were not delivered |
| `refused question: rule delivery` | the key was sent; the rules were not delivered |
| `trust answered` | the seat is ready |
| `question answered` | the dialog was dismissed, the decision line was delivered, and the seat is ready |
| `question answered; delivery required` | the dialog was dismissed, but the decision line could not be delivered; the recovery stays recorded |
| `question sent; delivery required` | a delivery-only retry could not deliver the line; the recovery stays recorded |
| `question answered; delivery unrecorded` | the decision line was delivered, but the delivered marker could not be written or read back on the first answer |
| `question sent; delivery unrecorded` | the decision line was delivered, but the delivered marker could not be written or read back on a delivery-only retry |

## Examples, moved here whole

The examples below are the page's own, moved here whole. The console is also on
[the `team answer` page](../commands/answer.md).

```console
$ team answer
team answer: a seat and trust or question are required
Usage: team answer <seat> trust [--session <name>] [--file <path>] [--json]
       team answer <seat> question [--session <name>] [--file <path>] [--json]

Presses the one recorded key of a dialog, and only that key. trust answers a folder-trust
dialog, and the folder must be the lobby on three readings at once: the path the screen
shows, the folder the pane itself reports working in, and the lobby's parent directory.
question dismisses a question, plan approval or confirmation dialog with that CLI's recorded
let-me-type-or-cancel key, then sends the seat one line through the ordinary send path and
never a keystroke at a choice: decide within your rules or ask your orchestrator with team
send. A permission, login or trust-to-run-a-command prompt is never answered. Every check
has to pass on two fresh reads of the pane, and the question word's two reads must agree on
the dialog and on its text. <seat> names one seat of the team file. No option takes a key,
a text, or another dialog. The pane is the terminal host's one agent of that name; a pane
recorded in the state selects nothing. A name the file does not carry is left as it is, and
two agents of the name send nothing. --session is the owner's alone, and so is --file: each
is refused before the flagged session or file is read. The answer opens on the team's
context line and closes on <seat>: answered trust (<folder>) or <seat>: answered question
(<dialog>). A refused or incomplete answer names its reason on stderr, and a recovery stays
recorded for the next answer to observe. --json prints one document instead of the lines:
{format, dry_run, status, action_summary, project, session, seat, pane, dialog,
dialog_kind?, state, folder?}. A run that exits 1 or 2 writes the structured error document
instead — {error: {id, message, repair}} — and stderr stays empty.

Exits 0 when the dialog is answered and the seat is ready, 1 when the answer is refused or
does not complete, 2 when the invocation or team file can't be read.
```

## Known limits

A process can still change between that last read and the input itself (two terminal-host
calls), as for every read-then-act in `team`. The question word's decision line is only as
reachable as the ordinary send path: a receiving seat its team file marks stopped refuses the
line, and the dismissal then stands with the recovery owed. A CLI whose profile carries no
question-answer record for the printed version answers no question dialog; and the closed key
set holds only the let-me-type-or-cancel keys, so a dialog whose only exit is an option is never
answered.
