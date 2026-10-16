# Exit codes

Each row is one way a command ends. `0` means the work finished, `1` means the command refused or a step failed, and `2` means the invocation or a file could not be read. One `return` can be several rows when several different failures leave through it. A thrown error ends as `1`.

The check keeps this list complete against ordinary changes to the commands (a new return, a new exit, a changed code); it reads the forms this codebase uses and refuses anything else; it is not a proof against code written to deceive it (`eval`, a patched `process`, a dynamic property name). The gate catches mistakes in ordinary command code; it isn't proof against code written to evade it.

| Id | Command | Code | Meaning | Example |
| --- | --- | --- | --- | --- |
| `add.dry-run` | `add` | 0 | a dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch) | `team add worker --dry-run` |
| `add.ready` | `add` | 0 | the seat is ready | `team add worker` |
| `add.agents` | `add` | 1 | the agents can't be read | `team add worker` |
| `add.already-running` | `add` | 1 | the seat is already running | `team add worker` |
| `add.another-pane` | `add` | 1 | the state records another pane for the caller's seat | `team add worker` |
| `add.branch-missing` | `add` | 1 | the merged branch doesn't exist | `team add --temporary --like lead --until merged:missing` |
| `add.budget` | `add` | 1 | the budget refuses the seat | `team add worker` |
| `add.caller` | `add` | 1 | the caller may not change the team | `team add worker` |
| `add.ceiling` | `add` | 1 | the approval ceiling would be passed | `team add worker` |
| `add.ceilings` | `add` | 1 | the approved ceilings can't be read | `team add worker` |
| `add.changed` | `add` | 1 | the file changed while add was checking | `team add worker` |
| `add.default-session` | `add` | 1 | the session can't be "default" | `team add worker --session default` |
| `add.delegate` | `add` | 1 | the caller is not the approved delegate | `team add worker` |
| `add.delegate-approval` | `add` | 1 | delegation needs a verified approval | `team add worker` |
| `add.delegate-approved-copy` | `add` | 1 | delegation needs a readable approved copy | `team add worker` |
| `add.delegate-command` | `add` | 1 | the approved delegate may not run add | `team add worker` |
| `add.delegate-drift` | `add` | 1 | delegation needs the approved file | `team add worker` |
| `add.delegate-edit` | `add` | 1 | the delegate's add would edit the file or the approval | `team add worker` |
| `add.delegate-evidence` | `add` | 1 | the delegate's placement or seats can't be verified | `team add worker` |
| `add.delegate-flag` | `add` | 1 | the delegate may not use this flag | `team add worker --temporary` |
| `add.delegate-placement` | `add` | 1 | the approved delegate must be an external non-seat pane | `team add worker` |
| `add.detached` | `add` | 1 | a run with no terminal | `team add worker` |
| `add.doctor` | `add` | 1 | doctor refuses the launch | `team add worker` |
| `add.file-owner` | `add` | 1 | --file is the owner's | `team add worker --file .agents/team.yaml` |
| `add.herdr` | `add` | 1 | herdr doesn't answer | `team add worker` |
| `add.lobby` | `add` | 1 | the lobby could not be created for the launch | `team add worker` |
| `add.machine` | `add` | 1 | the machine is over a launch limit | `team add worker` |
| `add.machine-again` | `add` | 1 | the machine goes over a launch limit before the seat starts | `team add worker` |
| `add.merged-base` | `add` | 1 | workspace.base is required to read a merged end | `team add --temporary --like lead --until merged:topic` |
| `add.never-approved` | `add` | 1 | the file was never approved | `team add worker` |
| `add.no-like` | `add` | 1 | the approved file has no seat to copy | `team add --temporary --like missing --until result:out.md` |
| `add.no-pane` | `add` | 1 | the state records no pane for the caller's seat | `team add worker` |
| `add.no-profile` | `add` | 1 | the seat has no launch profile | `team add worker` |
| `add.no-seat` | `add` | 1 | the approved file has no such seat | `team add missing` |
| `add.not-ready` | `add` | 1 | the launch finished without a ready seat | `team add worker` |
| `add.not-restored` | `add` | 1 | the seat can't be put back from the approved copy | `team add worker` |
| `add.override-owner` | `add` | 1 | --model and --effort on a declared seat are the owner's | `team add worker --model claude-sonnet-5-5` |
| `add.placed` | `add` | 1 | the seat would be placed outside the project | `team add worker` |
| `add.pretrust` | `add` | 1 | the lobby is not trusted for this seat's CLI | `team add worker` |
| `add.result-absolute` | `add` | 1 | a result path is absolute | `team add --temporary --like lead --until result:/tmp/out.md` |
| `add.result-exists` | `add` | 1 | the result path already exists | `team add --temporary --like lead --until result:README.md` |
| `add.run-lock` | `add` | 1 | another session-mutating run is holding the session | `team add worker` |
| `add.server` | `add` | 1 | the session's server did not start | `team add worker` |
| `add.session-doubt` | `add` | 1 | the pane holds a process the record cannot tie to the launch | `team add worker` |
| `add.session-owner` | `add` | 1 | --session is the owner's | `team add worker --session other` |
| `add.start` | `add` | 1 | the seat has nowhere to start | `team add worker` |
| `add.stopped` | `add` | 1 | the session is stopped | `team add worker` |
| `add.until` | `add` | 1 | --until is not a result path or a merged branch | `team add --temporary --like lead --until nope` |
| `add.worktree-failed` | `add` | 1 | the worktree setup failed | `team add --temporary --like lead --until result:out.md --worktree task` |
| `add.worktree-missing` | `add` | 1 | no worktree with that name is recorded | `team add --temporary --like lead --until result:out.md --worktree missing` |
| `add.effort` | `add` | 2 | the --effort override is not allowed for the seat's CLI or vendor | `team add worker --effort unknown` |
| `add.file` | `add` | 2 | the team file can't be read | `team add worker --file missing.yaml` |
| `add.file-invalid` | `add` | 2 | the team file can't be parsed | `team add worker --file team.yaml` |
| `add.invocation` | `add` | 2 | the invocation can't be read | `team add --nope` |
| `add.locked` | `add` | 2 | the locked edit does not validate | `team add worker` |
| `add.model` | `add` | 2 | the --model override is not known for the seat's CLI | `team add worker --model unknown` |
| `add.not-a-repo` | `add` | 2 | not inside a git repository | `team add worker` |
| `add.prepared` | `add` | 2 | the prepared edit does not validate | `team add worker` |
| `add.seat-name` | `add` | 2 | a seat name is required | `team add` |
| `add.temporary-flags` | `add` | 2 | --like, --until and --worktree need --temporary | `team add worker --like lead` |
| `add.temporary-unexpected` | `add` | 2 | an unexpected argument was passed to --temporary | `team add extra --temporary` |
| `answer.ready` | `answer` | 0 | the trust dialog was answered and the seat is ready | `team answer lead trust` |
| `answer.action` | `answer` | 1 | the recorded key was not sent | `team answer lead trust` |
| `answer.ambiguous` | `answer` | 1 | herdr lists more than one agent of this name | `team answer lead trust` |
| `answer.another-pane` | `answer` | 1 | the state records another pane for the caller's seat | `team answer lead trust` |
| `answer.caller` | `answer` | 1 | the caller may not answer a trust dialog | `team answer lead trust` |
| `answer.detached` | `answer` | 1 | a run with no terminal | `team answer lead trust` |
| `answer.file-owner` | `answer` | 1 | --file is the owner's | `team answer lead trust --file .agents/team.yaml` |
| `answer.folder` | `answer` | 1 | the dialog's folder is not the lobby's exact trust entry | `team answer lead trust` |
| `answer.label` | `answer` | 1 | the trust choice is not the recorded one | `team answer lead trust` |
| `answer.no-pane` | `answer` | 1 | the state records no pane for the caller's seat | `team answer lead trust` |
| `answer.policy` | `answer` | 1 | the file leaves trust dialogs to the owner | `team answer lead trust` |
| `answer.process` | `answer` | 1 | the process in the pane is not the one team launched | `team answer lead trust` |
| `answer.recovery` | `answer` | 1 | the trust answer did not complete: the seat stays in recovery | `team answer lead trust` |
| `answer.screen` | `answer` | 1 | the pane is not the trust dialog | `team answer lead trust` |
| `answer.session-owner` | `answer` | 1 | --session is the owner's | `team answer lead trust --session other` |
| `answer.state` | `answer` | 1 | the seat is not waiting at a trust dialog | `team answer lead trust` |
| `answer.unverified` | `answer` | 1 | the name is not a seat of the approved copy | `team answer lead trust` |
| `answer.version` | `answer` | 1 | this version has no trust answer | `team answer lead trust` |
| `answer.configuration` | `answer` | 2 | the team file cannot be read | `team answer lead trust --file missing.yaml` |
| `answer.usage` | `answer` | 2 | the invocation is not a seat and trust | `team answer` |
| `archive.keep-running` | `archive` | 0 | the snapshot was written and the team was left running | `team archive --keep-running` |
| `archive.detached` | `archive` | 1 | a run with no terminal | `team archive` |
| `archive.exists` | `archive` | 1 | the archive folder already exists | `team archive, when this run’s folder is already there` |
| `archive.file-owner` | `archive` | 1 | --file is the owner’s | `team archive --file .agents/team.yaml` |
| `archive.out-owner` | `archive` | 1 | --out is the owner’s | `team archive --out ~/archives` |
| `archive.file` | `archive` | 2 | the team file can’t be read | `team archive --file missing.yaml` |
| `archive.file-invalid` | `archive` | 2 | the team file can’t be parsed | `team archive --file team.yaml` |
| `archive.invocation` | `archive` | 2 | the invocation can’t be read | `team archive extra` |
| `archive.not-a-repo` | `archive` | 2 | not inside a git repository | `team archive` |
| `archive.stop-flags` | `archive` | 2 | --keep-running with a flag that only describes the stop | `team archive --keep-running --abandon` |
| `ask-show.shown` | `ask-show` | 0 | the question is printed | `team ask-show req-ask-show-v1 --ask ask.txt --marker marker.json --key key.txt` |
| `ask-show.expired` | `ask-show` | 1 | the marker matches and the ask is past expires_at plus 5 seconds | `team ask-show req-ask-show-v1 --ask ask.txt --marker marker.json --key key.txt` |
| `ask-show.refused` | `ask-show` | 1 | the marker does not verify, or a file cannot be read | `team ask-show req-ask-show-v1 --ask ask.txt --marker marker.json --key key.txt` |
| `ask-show.invocation` | `ask-show` | 2 | the invocation cannot be read | `team ask-show` |
| `broker.stopped` | `broker` | 0 | the broker served until it was stopped | `team broker` |
| `broker.bind` | `broker` | 1 | the socket could not be bound | `team broker` |
| `broker.busy` | `broker` | 1 | a broker is already answering on this clone's socket | `team broker` |
| `broker.detached` | `broker` | 1 | a run with no terminal | `team broker` |
| `broker.file` | `broker` | 1 | the team file can't be read or parsed | `team broker` |
| `broker.keychain` | `broker` | 1 | the Keychain credential was refused | `team broker` |
| `broker.locked` | `broker` | 1 | another start is binding this clone's socket | `team broker` |
| `broker.not-owner` | `broker` | 1 | only the owner runs broker | `team broker` |
| `broker.policy` | `broker` | 1 | a task policy the validator refuses | `team broker` |
| `broker.source` | `broker` | 1 | the team file declares no task source, or one the broker does not serve | `team broker` |
| `broker.invocation` | `broker` | 2 | the invocation can't be read | `team broker extra` |
| `broker.not-a-repo` | `broker` | 2 | not inside a git repository | `team broker` |
| `check.ok` | `check` | 0 | nothing needs acting on | `team check` |
| `check.file-owner` | `check` | 1 | --file is the owner's | `team check --file .agents/team.yaml` |
| `check.findings` | `check` | 1 | something needs acting on | `team check` |
| `check.session-owner` | `check` | 1 | --session is the owner's | `team check --session team` |
| `check.file` | `check` | 2 | the team file can't be read | `team check --file missing.yaml` |
| `check.file-invalid` | `check` | 2 | the team file can't be parsed | `team check --file team.yaml` |
| `check.herdr` | `check` | 2 | herdr doesn't answer | `team check` |
| `check.invocation` | `check` | 2 | the invocation can't be read | `team check` |
| `check.not-a-repo` | `check` | 2 | not inside a git repository and no team file here | `team check` |
| `check.not-yours` | `check` | 2 | the caller may not check this team | `team check` |
| `check.state` | `check` | 2 | the state can't be read | `team check` |
| `commits.passed` | `commits` | 0 | every commit passed | `team commits check HEAD` |
| `commits.refused` | `commits` | 1 | a commit was refused | `team commits check HEAD` |
| `commits.threw` | `commits` | 1 | a forbidden pattern is not a regular expression | `team commits check HEAD` |
| `commits.empty-range` | `commits` | 2 | the range holds no commit | `team commits check HEAD..HEAD` |
| `commits.file` | `commits` | 2 | the team file can't be read | `team commits check HEAD` |
| `commits.file-invalid` | `commits` | 2 | the team file can't be parsed | `team commits check HEAD --file team.yaml` |
| `commits.invocation` | `commits` | 2 | the invocation can't be read | `team commits check` |
| `commits.ledger` | `commits` | 2 | the approval ledger can't be read | `team commits check HEAD` |
| `commits.no-commit` | `commits` | 2 | the ref names nothing | `team commits check not-a-ref` |
| `commits.not-a-ref` | `commits` | 2 | since is not a ref | `team commits check HEAD --since --bad` |
| `commits.not-a-repo` | `commits` | 2 | not inside a git repository | `team commits check HEAD` |
| `commits.outside` | `commits` | 2 | the check is not in a git repository | `team commits check HEAD --file team.yaml` |
| `commits.range` | `commits` | 2 | the range can't be resolved | `team commits check missing..also` |
| `commits.since-missing` | `commits` | 2 | since doesn't name a commit | `team commits check HEAD --since missing` |
| `commits.since-unreachable` | `commits` | 2 | since is not reachable from the ref | `team commits check HEAD --since topic` |
| `conformance-adapter.finished` | `conformance-adapter` | 0 | the protocol finished | `team conformance-adapter` |
| `doctor.clear` | `doctor` | 0 | nothing is missing | `team doctor` |
| `doctor.missing` | `doctor` | 1 | something is missing | `team doctor` |
| `doctor.file` | `doctor` | 2 | the team file can't be read | `team doctor --file missing.yaml` |
| `doctor.file-invalid` | `doctor` | 2 | the team file can't be parsed | `team doctor --file team.yaml` |
| `doctor.invocation` | `doctor` | 2 | the invocation can't be read | `team doctor extra` |
| `doctor.not-a-repo` | `doctor` | 2 | not inside a git repository | `team doctor` |
| `down.dry-run` | `down` | 0 | a dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch) | `team down --dry-run` |
| `down.idle` | `down` | 0 | there was nothing to stop | `team down` |
| `down.stopped` | `down` | 0 | the seats that could be stopped were stopped | `team down` |
| `down.abandon` | `down` | 1 | only the owner abandons a team | `team down --abandon` |
| `down.another-pane` | `down` | 1 | the state records another pane for the caller's seat | `team down` |
| `down.caller` | `down` | 1 | the caller may not change the team | `team down` |
| `down.delegate` | `down` | 1 | the caller is not the approved delegate of any entry | `team down, from a pane no delegate entry names` |
| `down.delegate-approval` | `down` | 1 | delegation needs a verified approval | `team down, with no approval in force` |
| `down.delegate-approved-copy` | `down` | 1 | delegation needs a readable approved copy | `team down, when the approved copy can't be read` |
| `down.delegate-command` | `down` | 1 | the approved delegate may not run `down` | `team down, from the approved delegate whose commands leave it out` |
| `down.delegate-drift` | `down` | 1 | the file is not the approved one | `team down, after the file changed since approval` |
| `down.delegate-evidence` | `down` | 1 | delegation cannot verify its placement or seats | `team down, when herdr or the state can't be read for the gate` |
| `down.delegate-flag` | `down` | 1 | a prohibited flag is the owner's | `team down --abandon, from the approved delegate` |
| `down.delegate-placement` | `down` | 1 | the approved delegate must be an external non-seat pane | `team down, with a delegate entry naming a seat's pane` |
| `down.detached` | `down` | 1 | a run with no terminal | `team down` |
| `down.file-owner` | `down` | 1 | --file is the owner's | `team down --file .agents/team.yaml` |
| `down.grant-approval` | `down` | 1 | a grant needs a verified approval | `team down` |
| `down.grant-scope` | `down` | 1 | the grant does not list down | `team down` |
| `down.held` | `down` | 1 | a step was held | `team down` |
| `down.legacy` | `down` | 1 | a legacy approval record stops nobody | `team down` |
| `down.never-approved` | `down` | 1 | a file that was never approved stops nobody | `team down` |
| `down.no-launch` | `down` | 1 | this call has no way to reach herdr | `team down` |
| `down.no-pane` | `down` | 1 | the state records no pane for the caller's seat | `team down` |
| `down.refused` | `down` | 1 | a refused approval record stops nobody | `team down` |
| `down.run-lock` | `down` | 1 | another session-mutating run is holding the session | `team down` |
| `down.session-owner` | `down` | 1 | --session is the owner's | `team down --session other` |
| `down.agents` | `down` | 2 | the agents can't be read | `team down` |
| `down.file` | `down` | 2 | the team file can't be read | `team down --file missing.yaml` |
| `down.file-invalid` | `down` | 2 | the team file can't be parsed | `team down --file team.yaml` |
| `down.herdr` | `down` | 2 | herdr doesn't answer | `team down` |
| `down.invocation` | `down` | 2 | the invocation can't be read | `team down extra` |
| `down.not-a-repo` | `down` | 2 | not inside a git repository | `team down` |
| `feed.ok` | `feed` | 0 | the message feed was printed | `team feed` |
| `feed.unreadable` | `feed` | 1 | the history log cannot be read | `team feed` |
| `feed.configuration` | `feed` | 2 | the team file can't be read | `team feed` |
| `feed.usage` | `feed` | 2 | the invocation can't be read | `team feed extra` |
| `init.restored` | `init` | 0 | the approved copy was restored | `team init --restore` |
| `init.restored-archive` | `init` | 0 | the team file was restored from an archive | `team init --from-archive ~/.config/team/archive/beacon-<hash>-20261014T100000Z` |
| `init.wrote` | `init` | 0 | a skeleton was written | `team init` |
| `init.detached` | `init` | 1 | a run with no terminal | `team init` |
| `init.exists` | `init` | 1 | the team file already exists | `team init` |
| `init.from-archive` | `init` | 1 | the archive can’t be read or verified | `team init --from-archive <folder>` |
| `init.from-archive-invalid` | `init` | 1 | the archived team file doesn’t validate | `team init --from-archive <folder>` |
| `init.git-silent` | `init` | 1 | git doesn't answer for this folder | `team init` |
| `init.legacy` | `init` | 1 | the record predates signed records | `team init --restore` |
| `init.not-owner` | `init` | 1 | not the owner | `team init` |
| `init.nothing` | `init` | 1 | there is nothing to restore | `team init --restore` |
| `init.refused` | `init` | 1 | the stored record does not verify | `team init --restore` |
| `init.skeleton` | `init` | 1 | the skeleton doesn't validate | `team init` |
| `init.tracked` | `init` | 1 | the team file is tracked | `team init` |
| `init.invocation` | `init` | 2 | the invocation can't be read | `team init extra` |
| `init.not-a-repo` | `init` | 2 | not inside a git repository | `team init` |
| `init.sources` | `init` | 2 | --restore and --from-archive together | `team init --restore --from-archive <folder>` |
| `issues.none` | `issues` | 0 | nothing is waiting | `team issues` |
| `issues.shown` | `issues` | 0 | the task list was shown | `team issues` |
| `issues.file` | `issues` | 1 | the team file can't be read, it declares no task source, or its source is a broker's | `team issues` |
| `issues.missing` | `issues` | 1 | the task file is not there | `team issues` |
| `issues.shape` | `issues` | 1 | a record is not a task, or the task file is not a list | `team issues` |
| `issues.invocation` | `issues` | 2 | the invocation can't be read | `team issues extra` |
| `issues.not-a-repo` | `issues` | 2 | not inside a git repository | `team issues` |
| `list.empty` | `list` | 0 | herdr answered and there is nothing to list | `team list` |
| `list.herdr-down` | `list` | 0 | herdr cannot be asked, so the list is empty | `team list` |
| `list.shown` | `list` | 0 | the sessions are printed | `team list` |
| `list.invocation` | `list` | 2 | the arguments are not this command's | `team list --nope` |
| `lock.taken` | `lock` | 0 | the lock was taken | `team lock heavy-run` |
| `lock.held` | `lock` | 1 | the lock is already held | `team lock heavy-run` |
| `lock.io` | `lock` | 1 | the lock directory could not be written | `team lock heavy-run` |
| `lock.invocation` | `lock` | 2 | the invocation can't be read | `team lock` |
| `lock.project` | `lock` | 2 | the caller's project can't be read | `team lock heavy-run` |
| `mcp.clear` | `mcp` | 0 | the bridge is clear: doctor found nothing missing | `team mcp doctor` |
| `mcp.up` | `mcp` | 0 | every observed bridge leg is up | `team mcp status` |
| `mcp.down` | `mcp` | 1 | at least one leg is down or unknown | `team mcp status` |
| `mcp.missing` | `mcp` | 1 | doctor found something missing | `team mcp doctor` |
| `mcp.not-set-up` | `mcp` | 1 | no bridge configuration exists in the lobby folder | `team mcp status` |
| `mcp.invocation` | `mcp` | 2 | the invocation can't be read | `team mcp` |
| `messages.none` | `messages` | 0 | nothing is waiting | `team messages` |
| `messages.shown` | `messages` | 0 | a waiting message was shown and its receipt was written | `team messages` |
| `messages.file` | `messages` | 1 | the team file can't be read | `team messages` |
| `messages.id` | `messages` | 1 | the filename is not the record's id | `team messages` |
| `messages.key` | `messages` | 1 | the message key is missing or unreadable | `team messages` |
| `messages.root` | `messages` | 1 | the record is bound to another checkout | `team messages` |
| `messages.seat` | `messages` | 1 | the record is addressed to another seat | `team messages` |
| `messages.session` | `messages` | 1 | the record is bound to another session | `team messages` |
| `messages.shape` | `messages` | 1 | the record is not a message | `team messages` |
| `messages.signature` | `messages` | 1 | the signature is not the message key's | `team messages` |
| `messages.invocation` | `messages` | 2 | the invocation can't be read | `team messages extra` |
| `messages.not-a-repo` | `messages` | 2 | not inside a git repository | `team messages` |
| `next.none` | `next` | 0 | nothing to take or to release | `team next` |
| `next.released` | `next` | 0 | the caller's lease was released | `team next --release` |
| `next.taken` | `next` | 0 | a record was claimed, or the caller's live lease was renewed | `team next` |
| `next.wait` | `next` | 0 | the wait was stopped, or a clock that did not advance ended it | `team next --wait` |
| `next.broker` | `next` | 1 | no broker is running, or its answer was not one this build knows | `team next` |
| `next.caller` | `next` | 1 | the caller is not a seat of this team on its recorded pane | `team next` |
| `next.file` | `next` | 1 | the team file can't be read, or it declares no task source | `team next` |
| `next.missing` | `next` | 1 | the task file is not there | `team next` |
| `next.policy` | `next` | 1 | a task policy the validator refuses | `team next` |
| `next.read` | `next` | 1 | the broker failed the read | `team next` |
| `next.shape` | `next` | 1 | nothing was taken, and a record is not a task or the task file is not a list | `team next` |
| `next.invocation` | `next` | 2 | the invocation can't be read | `team next extra` |
| `next.not-a-repo` | `next` | 2 | not inside a git repository | `team next` |
| `plan.none` | `plan` | 0 | nothing is takeable | `team plan` |
| `plan.shown` | `plan` | 0 | the takeable queue was printed | `team plan` |
| `plan.broker` | `plan` | 1 | no broker is running, or its answer was not one this build knows | `team plan` |
| `plan.caller` | `plan` | 1 | the caller is not a seat of this team on its recorded pane | `team plan` |
| `plan.file` | `plan` | 1 | the team file can't be read, or it declares no task source | `team plan` |
| `plan.missing` | `plan` | 1 | the task file is not there | `team plan` |
| `plan.read` | `plan` | 1 | the broker failed the read | `team plan` |
| `plan.shape` | `plan` | 1 | nothing was printed, and a record is not a task or the task file is not a list | `team plan` |
| `plan.invocation` | `plan` | 2 | the invocation can't be read | `team plan extra` |
| `plan.not-a-repo` | `plan` | 2 | not inside a git repository | `team plan` |
| `pr.passed` | `pr` | 0 | the pull request body passed | `team pr check body.md` |
| `pr.refused` | `pr` | 1 | the pull request body was refused | `team pr check body.md` |
| `pr.body` | `pr` | 2 | the pull request body can't be read | `team pr check missing.md` |
| `pr.file` | `pr` | 2 | the team file can't be read | `team pr check body.md` |
| `pr.file-invalid` | `pr` | 2 | the team file can't be parsed | `team pr check body.md --file team.yaml` |
| `pr.invocation` | `pr` | 2 | the invocation can't be read | `team pr check` |
| `pr.ledger` | `pr` | 2 | the approval ledger can't be read | `team pr check body.md` |
| `pr.not-a-repo` | `pr` | 2 | not inside a git repository | `team pr check body.md` |
| `release.passed` | `release` | 0 | every check passed | `team release check material@3.0.2` |
| `release.missing` | `release` | 1 | a check is missing | `team release check material@3.0.2` |
| `release.unknown` | `release` | 2 | a check is unknown | `team release check material@3.0.2` |
| `release.configuration` | `release` | 64 | the team file can't be read | `team release check material@3.0.2` |
| `release.usage` | `release` | 64 | the invocation can't be read | `team release` |
| `reload.reloaded` | `reload` | 0 | the seat was closed at an idle prompt and the new launch reached ready | `team reload worker` |
| `reload.same` | `reload` | 0 | the seat is already running what the file declares | `team reload worker` |
| `reload.absent` | `reload` | 1 | the file has no seat of that name | `team reload missing` |
| `reload.changed` | `reload` | 1 | the seat changed before it closed; nothing relaunched | `team reload worker` |
| `reload.grant-another-pane` | `reload` | 1 | the state records another pane for the granted seat | `team reload worker` |
| `reload.grant-approval` | `reload` | 1 | a grant needs a verified approval | `team reload worker` |
| `reload.grant-approved-copy` | `reload` | 1 | a grant needs a readable approved copy | `team reload worker` |
| `reload.grant-caller` | `reload` | 1 | only the seat the grant names runs this | `team reload worker` |
| `reload.grant-drift` | `reload` | 1 | a grant needs the approved file | `team reload worker` |
| `reload.grant-file` | `reload` | 1 | the team file can't be read | `team reload worker` |
| `reload.grant-flag` | `reload` | 1 | --file is the owner's; the granted seat cannot use it | `team reload worker --file other.yaml` |
| `reload.grant-no-pane` | `reload` | 1 | no pane is recorded for the granted seat | `team reload worker` |
| `reload.grant-omitted` | `reload` | 1 | the approved file grants nothing | `team reload worker` |
| `reload.grant-scope` | `reload` | 1 | the grant does not list reload | `team reload worker` |
| `reload.launch` | `reload` | 1 | the close happened and the new launch did not reach ready | `team reload worker` |
| `reload.not-idle` | `reload` | 1 | the seat is not at an idle prompt; nothing closed | `team reload worker` |
| `reload.not-running` | `reload` | 1 | the seat has no ready pane to close | `team reload worker` |
| `reload.run-lock` | `reload` | 1 | another session-mutating run is holding the session | `team reload worker` |
| `reload.self` | `reload` | 1 | a granted reload does not close the caller's seat | `team reload lead` |
| `reload.unrecorded` | `reload` | 1 | the model and effort were not recorded at launch | `team reload worker` |
| `reload.unsent` | `reload` | 1 | the seat holds unsent text; nothing closed | `team reload worker` |
| `reload.working` | `reload` | 1 | the seat is working; nothing closed | `team reload worker` |
| `reload.file` | `reload` | 2 | the team file can't be read | `team reload worker --file missing.yaml` |
| `reload.invocation` | `reload` | 2 | the invocation can't be read | `team reload` |
| `remove.kept` | `remove` | 0 | a stopped seat was kept | `team remove worker --keep` |
| `remove.removed` | `remove` | 0 | the seat was removed | `team remove worker` |
| `remove.swapped` | `remove` | 0 | a lead seat was stopped for a swap; the file still names it | `team remove lead --keep` |
| `remove.temporary` | `remove` | 0 | a temporary seat was removed | `team remove worker` |
| `remove.abandon` | `remove` | 1 | only the owner abandons a seat | `team remove worker --abandon` |
| `remove.agents` | `remove` | 1 | the agents can't be read | `team remove worker` |
| `remove.ambiguous` | `remove` | 1 | herdr lists more than one agent of this name | `team remove lead` |
| `remove.another-pane` | `remove` | 1 | the state records another pane for the caller's seat | `team remove worker` |
| `remove.busy` | `remove` | 1 | the seat is not free | `team remove worker` |
| `remove.caller` | `remove` | 1 | the caller may not change the team | `team remove worker` |
| `remove.coordinator` | `remove` | 1 | only the owner removes the orchestrator's or the operator's seat | `team remove lead` |
| `remove.default-session` | `remove` | 1 | the session can't be "default" | `team remove worker --session default` |
| `remove.delegate` | `remove` | 1 | the caller is not the approved delegate | `team remove worker` |
| `remove.delegate-approval` | `remove` | 1 | delegation needs a verified approval | `team remove worker` |
| `remove.delegate-approved-copy` | `remove` | 1 | delegation needs a readable approved copy | `team remove worker` |
| `remove.delegate-command` | `remove` | 1 | the approved delegate may not run remove | `team remove worker` |
| `remove.delegate-drift` | `remove` | 1 | delegation needs the approved file | `team remove worker` |
| `remove.delegate-evidence` | `remove` | 1 | the delegate's placement or seats can't be verified | `team remove worker` |
| `remove.delegate-flag` | `remove` | 1 | the delegate may not use this flag | `team remove worker --keep` |
| `remove.delegate-placement` | `remove` | 1 | the approved delegate must be an external non-seat pane | `team remove worker` |
| `remove.detached` | `remove` | 1 | a run with no terminal | `team remove worker` |
| `remove.file-owner` | `remove` | 1 | --file is the owner's | `team remove worker --file .agents/team.yaml` |
| `remove.herdr` | `remove` | 1 | herdr doesn't answer | `team remove worker` |
| `remove.keep-temporary` | `remove` | 1 | a temporary seat is not kept in the file | `team remove worker --keep` |
| `remove.never-approved` | `remove` | 1 | the file was never approved | `team remove worker` |
| `remove.no-launch` | `remove` | 1 | this call has no way to reach herdr | `team remove worker` |
| `remove.no-pane` | `remove` | 1 | the state records no pane for the caller's seat | `team remove worker` |
| `remove.no-profile` | `remove` | 1 | the running seat has no launch profile | `team remove worker` |
| `remove.no-seat` | `remove` | 1 | the team has no such seat | `team remove missing` |
| `remove.run-lock` | `remove` | 1 | another session-mutating run is holding the session | `team remove worker` |
| `remove.session-owner` | `remove` | 1 | --session is the owner's | `team remove worker --session other` |
| `remove.stop-failed` | `remove` | 1 | the seat could not be stopped | `team remove worker` |
| `remove.swap-grant` | `remove` | 1 | no grant or delegate admits this caller's swap of a lead seat | `team remove lead --keep, from a seat the grant does not admit` |
| `remove.swap-self` | `remove` | 1 | a seat can't swap its own lead seat | `team remove lead --keep, from the lead's own pane` |
| `remove.unverified` | `remove` | 1 | a name the approved copy does not carry is left as it is | `team remove extra` |
| `remove.edit` | `remove` | 2 | the edit would not validate | `team remove lead` |
| `remove.file` | `remove` | 2 | the team file can't be read | `team remove worker --file missing.yaml` |
| `remove.file-invalid` | `remove` | 2 | the team file can't be parsed | `team remove worker --file team.yaml` |
| `remove.invocation` | `remove` | 2 | the invocation can't be read | `team remove` |
| `remove.locked` | `remove` | 2 | the locked edit does not validate | `team remove worker` |
| `remove.not-a-repo` | `remove` | 2 | not inside a git repository | `team remove worker` |
| `restart.dry-run` | `restart` | 0 | the stop and launch plan was printed and nothing was touched | `team restart worker --dry-run` |
| `restart.ready` | `restart` | 0 | the seat was restarted in a new pane | `team restart worker` |
| `restart.abandon-working` | `restart` | 1 | a seat caller passed --abandon on a working seat | `team restart worker --abandon` |
| `restart.busy` | `restart` | 1 | the seat is busy and --abandon was not given, or graceful stop did not close the pane | `team restart worker` |
| `restart.caller` | `restart` | 1 | the caller may not restart a seat, or passed an owner-only flag | `team restart worker` |
| `restart.detached` | `restart` | 1 | a run with no terminal | `team restart worker` |
| `restart.herdr` | `restart` | 1 | herdr doesn't answer | `team restart worker` |
| `restart.lead` | `restart` | 1 | a seat caller passed --abandon for the orchestrator's or the operator's seat | `team restart lead --abandon` |
| `restart.no-session` | `restart` | 1 | the herdr session is not running | `team restart worker` |
| `restart.not-ready` | `restart` | 1 | preflight or launch did not produce a ready seat | `team restart worker` |
| `restart.replaced` | `restart` | 1 | the old pane holds a process that is not the seat's CLI | `team restart worker` |
| `restart.run-lock` | `restart` | 1 | another session-mutating run is holding the session | `team restart worker` |
| `restart.self` | `restart` | 1 | a seat caller tried to restart its own recorded pane | `team restart lead` |
| `restart.signed-off` | `restart` | 1 | the seat is parked or stopped | `team restart worker` |
| `restart.temporary` | `restart` | 1 | the seat is a temporary copy | `team restart worker-tmp-1` |
| `restart.unknown` | `restart` | 1 | the seat is not a declared seat | `team restart missing` |
| `restart.configuration` | `restart` | 2 | the team file can't be read or parsed, or not inside a git repository | `team restart worker --file missing.yaml` |
| `restart.usage` | `restart` | 2 | the invocation can't be read | `team restart` |
| `seats.shown` | `seats` | 0 | the seats table was printed | `team seats` |
| `seats.file-owner` | `seats` | 1 | --file is the owner's | `team seats --file .agents/team.yaml` |
| `seats.session-owner` | `seats` | 1 | --session is the owner's | `team seats --session team` |
| `seats.file` | `seats` | 2 | the team file can't be read | `team seats --file missing.yaml` |
| `seats.file-invalid` | `seats` | 2 | the team file can't be parsed | `team seats --file team.yaml` |
| `seats.herdr` | `seats` | 2 | herdr doesn't answer | `team seats` |
| `seats.invocation` | `seats` | 2 | the invocation can't be read | `team seats extra` |
| `seats.not-a-repo` | `seats` | 2 | not inside a git repository | `team seats` |
| `seats.not-yours` | `seats` | 2 | the caller may not read this team | `team seats` |
| `send.answered` | `send` | 0 | the seat's reply came back within the window | `team send worker hello --wait` |
| `send.delivered` | `send` | 0 | the seat's channel took the message | `team send worker hello` |
| `send.dry-run` | `send` | 0 | the seat and channel were resolved and nothing was written | `team send worker hello --dry-run` |
| `send.listed` | `send` | 0 | the addressable seats were printed, nothing was sent | `team send --list` |
| `send.detached` | `send` | 1 | a run with no terminal | `team send --list` |
| `send.held` | `send` | 1 | the message is on disk and the pane was left untouched | `team send worker hello` |
| `send.refused` | `send` | 1 | nothing was sent, on purpose | `team send missing hello` |
| `send.timeout` | `send` | 1 | sent on the socket, but no reply within the window | `team send worker hello --wait --timeout 10` |
| `send.unreachable` | `send` | 1 | the seat was not reached | `team send worker hello` |
| `send.configuration` | `send` | 2 | the team file can't be read | `team send worker hello --file missing.yaml` |
| `send.usage` | `send` | 2 | the invocation can't be read | `team send` |
| `status.agrees` | `status` | 0 | the file, the state and the session agree | `team status` |
| `status.difference` | `status` | 1 | there is a difference | `team status` |
| `status.file-owner` | `status` | 1 | --file is the owner's | `team status --file .agents/team.yaml` |
| `status.session-owner` | `status` | 1 | --session is the owner's | `team status --session team` |
| `status.file` | `status` | 2 | the team file can't be read | `team status --file missing.yaml` |
| `status.file-invalid` | `status` | 2 | the team file can't be parsed | `team status --file team.yaml` |
| `status.herdr` | `status` | 2 | herdr doesn't answer | `team status` |
| `status.invocation` | `status` | 2 | the invocation can't be read | `team status extra` |
| `status.not-a-repo` | `status` | 2 | not inside a git repository | `team status` |
| `status.not-yours` | `status` | 2 | the caller may not read this team | `team status` |
| `team.command-help` | `team` | 0 | a command's help was printed | `team status --help` |
| `team.help` | `team` | 0 | help was printed | `team --help` |
| `team.version` | `team` | 0 | the version was printed | `team --version` |
| `team.command-threw` | `team` | 1 | a command threw | `team init` |
| `team.no-command` | `team` | 2 | no command was given | `team` |
| `team.unknown` | `team` | 2 | the command is unknown | `team nosuch` |
| `tempo.set` | `tempo` | 0 | the tempo was written | `team tempo urgent` |
| `tempo.unchanged` | `tempo` | 0 | the tempo was already that word | `team tempo urgent` |
| `tempo.detached` | `tempo` | 1 | a run with no terminal | `team tempo urgent` |
| `tempo.not-owner` | `tempo` | 1 | not the owner | `team tempo urgent` |
| `tempo.file` | `tempo` | 2 | the team file can't be read | `team tempo urgent` |
| `tempo.invocation` | `tempo` | 2 | the invocation can't be read | `team tempo` |
| `tempo.not-a-repo` | `tempo` | 2 | not inside a git repository | `team tempo urgent` |
| `tempo.word` | `tempo` | 2 | the word is not a tempo | `team tempo faster` |
| `unlock.released` | `unlock` | 0 | the lock was released | `team unlock heavy-run` |
| `unlock.io` | `unlock` | 1 | the lock directory could not be removed | `team unlock heavy-run` |
| `unlock.not-held` | `unlock` | 1 | the lock is not held | `team unlock heavy-run` |
| `unlock.not-yours` | `unlock` | 1 | the lock is held by someone else | `team unlock heavy-run` |
| `unlock.unknown-holder` | `unlock` | 1 | the lock's holder can't be read | `team unlock heavy-run` |
| `unlock.invocation` | `unlock` | 2 | the invocation can't be read | `team unlock` |
| `unlock.project` | `unlock` | 2 | the caller's project can't be read | `team unlock heavy-run` |
| `up.dry-run` | `up` | 0 | a dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch) | `team up --dry-run` |
| `up.ready` | `up` | 0 | the launch finished | `team up` |
| `up.agents` | `up` | 1 | the agents can't be read | `team up` |
| `up.clear` | `up` | 1 | a stopped session this team records did not clear | `team up` |
| `up.delegate` | `up` | 1 | only the owner or the approved delegate runs up | `team up` |
| `up.delegate-approval` | `up` | 1 | the delegate gate needs a verified approval | `team up` |
| `up.delegate-approved-copy` | `up` | 1 | the delegate gate needs a readable approved copy | `team up` |
| `up.delegate-command` | `up` | 1 | the approved delegate may not run up | `team up` |
| `up.delegate-drift` | `up` | 1 | the delegate gate needs the approved file | `team up` |
| `up.delegate-evidence` | `up` | 1 | the delegate gate can't verify its placement or seats | `team up` |
| `up.delegate-flag` | `up` | 1 | --session or --file is the owner's on a delegated run | `team up --session other` |
| `up.delegate-placement` | `up` | 1 | the approved delegate must be an external non-seat pane | `team up` |
| `up.deny` | `up` | 1 | deny | `team up` |
| `up.detached` | `up` | 1 | a run with no terminal | `team up --session elsewhere` |
| `up.doctor` | `up` | 1 | doctor refuses the launch | `team up` |
| `up.grant-another-pane` | `up` | 1 | the granted seat is not on its recorded pane | `team up` |
| `up.grant-approval` | `up` | 1 | a grant needs a verified approval | `team up` |
| `up.grant-approved-copy` | `up` | 1 | a grant needs a readable approved copy | `team up` |
| `up.grant-caller` | `up` | 1 | only the seat the grant names runs this | `team up` |
| `up.grant-drift` | `up` | 1 | a grant needs the approved file | `team up` |
| `up.grant-flag` | `up` | 1 | a granted seat cannot aim --session or --file | `team up --file other` |
| `up.grant-no-pane` | `up` | 1 | no pane is recorded for the granted seat | `team up` |
| `up.grant-scope` | `up` | 1 | the grant does not list up | `team up` |
| `up.herdr` | `up` | 1 | herdr doesn't answer | `team up` |
| `up.lobby` | `up` | 1 | the lobby could not be created for the launch | `team up` |
| `up.machine` | `up` | 1 | the machine is over a launch limit | `team up` |
| `up.never-approved` | `up` | 1 | the file was never approved | `team up` |
| `up.no-launch` | `up` | 1 | this call has no way to reach herdr | `team up` |
| `up.not-owner` | `up` | 1 | deny | `team up` |
| `up.pending` | `up` | 1 | a seat was left short of ready | `team up` |
| `up.placement` | `up` | 1 | a seat has nowhere to start | `team up` |
| `up.run-lock` | `up` | 1 | another session-mutating run is holding the session | `team up` |
| `up.server` | `up` | 1 | the session's server did not start | `team up` |
| `up.stopped` | `up` | 1 | the session is stopped | `team up` |
| `up.unknown` | `up` | 1 | a running agent is not in this file's state | `team up` |
| `up.watch` | `up` | 1 | the watch did not start | `team up` |
| `up.file` | `up` | 2 | the team file can't be read | `team up --file missing.yaml` |
| `up.file-invalid` | `up` | 2 | the team file can't be parsed | `team up --file team.yaml` |
| `up.invocation` | `up` | 2 | the invocation can't be read | `team up extra` |
| `up.not-a-repo` | `up` | 2 | not inside a git repository | `team up` |
| `usage.block` | `usage` | 0 | the machine's report printed | `team usage` |
| `usage.invocation` | `usage` | 2 | the invocation can't be read | `team usage extra` |
| `usage.store` | `usage` | 2 | the store folder can't be read | `team usage` |
| `watch.stopped` | `watch` | 0 | the watch ran and stopped | `team watch` |
| `watch.already` | `watch` | 1 | a watch already runs | `team watch` |
| `watch.caller` | `watch` | 1 | a run with no terminal | `team watch` |
| `watch.file-owner` | `watch` | 1 | --file is the owner's | `team watch --file .agents/team.yaml` |
| `watch.no-notify` | `watch` | 1 | a seat passed --no-notify | `team watch --no-notify` |
| `watch.no-nudge` | `watch` | 1 | a seat passed --no-nudge | `team watch --no-nudge` |
| `watch.watchdog` | `watch` | 1 | only the recorded watch may read the file up recorded | `team watch --session acme` |
| `watch.file` | `watch` | 2 | the team file can't be read | `team watch --file missing.yaml` |
| `watch.file-invalid` | `watch` | 2 | the team file can't be parsed | `team watch --file team.yaml` |
| `watch.invocation` | `watch` | 2 | the invocation can't be read | `team watch extra` |
| `watch.not-a-repo` | `watch` | 2 | not inside a git repository | `team watch` |
| `worktree.created` | `worktree` | 0 | the worktree was created | `team worktree new task --kind fix` |
| `worktree.listed` | `worktree` | 0 | the recorded worktrees were listed | `team worktree list` |
| `worktree.record-gone` | `worktree` | 0 | the record was removed after the folder was already gone | `team worktree remove task` |
| `worktree.removed` | `worktree` | 0 | the worktree was removed | `team worktree remove task` |
| `worktree.another-pane` | `worktree` | 1 | the state records another pane for the caller's seat | `team worktree new task` |
| `worktree.approved-copy` | `worktree` | 1 | the approved copy can't be read | `team worktree new task --kind fix` |
| `worktree.base` | `worktree` | 1 | workspace.base is not a branch here | `team worktree new task --kind fix` |
| `worktree.branch` | `worktree` | 1 | the branch already exists | `team worktree new task --kind fix` |
| `worktree.branch-name` | `worktree` | 1 | the branch name is not valid | `team worktree new task --kind fix` |
| `worktree.caller` | `worktree` | 1 | the caller may not change the team | `team worktree new task` |
| `worktree.config` | `worktree` | 1 | workspace.path and workspace.base are required | `team worktree new task` |
| `worktree.create-failed` | `worktree` | 1 | the worktree was not created | `team worktree new task --kind fix` |
| `worktree.default-session` | `worktree` | 1 | the session can't be "default" | `team worktree new task --session default` |
| `worktree.detached` | `worktree` | 1 | a run with no terminal | `team worktree list` |
| `worktree.dirty` | `worktree` | 1 | the worktree has uncommitted files | `team worktree remove task` |
| `worktree.elsewhere` | `worktree` | 1 | the worktree is recorded in another session | `team worktree remove task` |
| `worktree.exists` | `worktree` | 1 | the worktree folder already exists | `team worktree new task --kind fix` |
| `worktree.fetch` | `worktree` | 1 | the base couldn't be fetched | `team worktree new task --kind fix` |
| `worktree.file-owner` | `worktree` | 1 | --file is the owner's | `team worktree new task --file .agents/team.yaml` |
| `worktree.forbidden` | `worktree` | 1 | a public project refuses that name | `team worktree new WEB-1 --kind fix` |
| `worktree.kind` | `worktree` | 1 | --kind is not a single segment | `team worktree new task --kind ../fix` |
| `worktree.kind-nowhere` | `worktree` | 1 | --kind has nowhere to go | `team worktree new task --kind fix` |
| `worktree.kind-required` | `worktree` | 1 | --kind is required | `team worktree new task` |
| `worktree.limit` | `worktree` | 1 | the worktree limit is reached | `team worktree new task --kind fix` |
| `worktree.missing` | `worktree` | 1 | no worktree with that name is recorded | `team worktree remove task` |
| `worktree.never-approved` | `worktree` | 1 | the file was never approved | `team worktree new task` |
| `worktree.no-pane` | `worktree` | 1 | the state records no pane for the caller's seat | `team worktree new task` |
| `worktree.occupied` | `worktree` | 1 | a seat is recorded in the worktree | `team worktree remove task` |
| `worktree.path-kind` | `worktree` | 1 | workspace.path must not contain {kind} | `team worktree new task` |
| `worktree.placeholder` | `worktree` | 1 | the branch or path pattern has an unknown placeholder | `team worktree new task` |
| `worktree.published` | `worktree` | 1 | the branch already exists on a remote | `team worktree new task --kind fix` |
| `worktree.recorded` | `worktree` | 1 | the task is already recorded | `team worktree new task --kind fix` |
| `worktree.recorded-elsewhere` | `worktree` | 1 | the task is recorded in another session | `team worktree new task --kind fix` |
| `worktree.remove-failed` | `worktree` | 1 | the worktree was not removed | `team worktree remove task` |
| `worktree.remove-task` | `worktree` | 1 | the task name is not a single segment | `team worktree remove ../task` |
| `worktree.seat` | `worktree` | 1 | --seat names no declared seat | `team worktree new task --kind fix --seat missing` |
| `worktree.seat-unapproved` | `worktree` | 1 | --seat names a seat only the file declares | `team worktree new task --kind fix --seat added-later` |
| `worktree.session-owner` | `worktree` | 1 | --session is the owner's | `team worktree new task --session other` |
| `worktree.setup` | `worktree` | 1 | setup failed | `team worktree new task --kind fix` |
| `worktree.shared` | `worktree` | 1 | the workspace is shared | `team worktree new task` |
| `worktree.symlink` | `worktree` | 1 | the worktree follows a symlink outside the trust paths | `team worktree new task --kind fix` |
| `worktree.task` | `worktree` | 1 | the task name is not a single segment | `team worktree new ../task` |
| `worktree.tracking` | `worktree` | 1 | the base tracks something that is not a remote branch | `team worktree new task --kind fix` |
| `worktree.trust` | `worktree` | 1 | the worktree is outside the approved trust paths | `team worktree new select-width --kind fix` |
| `worktree.unpublished` | `worktree` | 1 | the worktree has commits on no remote branch | `team worktree remove task` |
| `worktree.unreadable` | `worktree` | 1 | the worktree couldn't be read | `team worktree remove task` |
| `worktree.extra` | `worktree` | 2 | an unexpected argument was given | `team worktree new task extra` |
| `worktree.file` | `worktree` | 2 | the team file can't be read | `team worktree new task --file missing.yaml` |
| `worktree.file-invalid` | `worktree` | 2 | the team file can't be parsed | `team worktree new task --file team.yaml` |
| `worktree.invocation` | `worktree` | 2 | the invocation can't be read | `team worktree --nope` |
| `worktree.not-a-repo` | `worktree` | 2 | not inside a git repository | `team worktree new task` |
| `worktree.remove-flags` | `worktree` | 2 | remove takes no --kind or --seat | `team worktree remove task --kind fix` |
| `worktree.subcommand` | `worktree` | 2 | a subcommand is required | `team worktree` |
| `worktree.task-required` | `worktree` | 2 | a task name is required | `team worktree new` |
