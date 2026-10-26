# Exit codes

Each row is one way a command ends. `0` means the work finished, `1` means the command refused or a step failed, and `2` means the invocation or a file could not be read. One `return` can be several rows when several different failures leave through it. A thrown error ends as `1`.

The check keeps this list complete against ordinary changes to the commands (a new return, a new exit, a changed code); it reads the forms this codebase uses and refuses anything else; it is not a proof against code written to deceive it (`eval`, a patched `process`, a dynamic property name). The gate catches mistakes in ordinary command code; it isn't proof against code written to evade it.

| Id | Command | Code | Meaning | Example |
| --- | --- | --- | --- | --- |
| `ack.read` | `ack` | 0 | the message was marked read, or another reader had already marked it read or answered it | `team ack 3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d` |
| `ack.refused` | `ack` | 1 | the message can't be marked read, or the call is not the record's addressee | `team ack 3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d` |
| `ack.configuration` | `ack` | 2 | the team file can't be read | `team ack 3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d` |
| `ack.usage` | `ack` | 2 | the invocation can't be read | `team ack` |
| `add.approval-requested` | `add` | 0 | an owner-seat request for this add was recorded and sent to the owner seat | `team add <name> --request` |
| `add.dry-run` | `add` | 0 | a dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch) | `team add worker --dry-run` |
| `add.ready` | `add` | 0 | the seat is ready | `team add worker` |
| `add.agents` | `add` | 1 | the agents can't be read | `team add worker` |
| `add.already-running` | `add` | 1 | the seat is already running | `team add worker` |
| `add.approval-refused` | `add` | 1 | the owner-seat request or approval for this add was refused: missing, expired, mismatched, unsigned, self-approved or already used | `team add <name> --approval <request-id>` |
| `add.branch-missing` | `add` | 1 | the merged branch doesn't exist | `team add --temporary --like lead --until merged:missing` |
| `add.budget` | `add` | 1 | the budget refuses the seat | `team add worker` |
| `add.caller` | `add` | 1 | the caller may not change the team | `team add worker` |
| `add.ceiling` | `add` | 1 | the file's seat ceiling would be passed | `team add worker` |
| `add.ceilings` | `add` | 1 | a record that does not verify is not in force | `team add worker` |
| `add.changed` | `add` | 1 | the file changed while add was checking | `team add worker` |
| `add.client-refused` | `add` | 1 | the owner-signed manager grant, or the client add it admits, did not verify, or the seat is a lead seat | `team add Desk --like worker --client grant.json --key client.key --team docs` |
| `add.default-session` | `add` | 1 | the session can't be "default" | `team add worker --session default` |
| `add.delegate` | `add` | 1 | the caller is not the approved delegate | `team add worker` |
| `add.delegate-approval` | `add` | 1 | delegation needs a verified approval | `team add worker` |
| `add.delegate-command` | `add` | 1 | the approved delegate may not run add | `team add worker` |
| `add.delegate-edit` | `add` | 1 | the delegate's add is not a same-copy seat: it would edit the file, or names a stanza the approval does not hold | `team add worker` |
| `add.delegate-evidence` | `add` | 1 | the delegate's placement or seats can't be verified | `team add worker` |
| `add.delegate-flag` | `add` | 1 | the delegate may not use this flag | `team add worker --temporary` |
| `add.delegate-placement` | `add` | 1 | the approved delegate must be an external non-seat pane | `team add worker` |
| `add.detached` | `add` | 1 | a run with no terminal | `team add worker` |
| `add.doctor` | `add` | 1 | doctor refuses the launch | `team add worker` |
| `add.file-owner` | `add` | 1 | --file is the owner's | `team add worker --file .agents/team.yaml` |
| `add.herdr` | `add` | 1 | herdr doesn't answer | `team add worker` |
| `add.human` | `add` | 1 | the named seat is a human's pane | `team add worker` |
| `add.like-exists` | `add` | 1 | the new seat's name is already declared | `team add worker --like lead` |
| `add.lobby` | `add` | 1 | the lobby could not be created for the launch | `team add worker` |
| `add.machine` | `add` | 1 | the machine is over a launch limit | `team add worker` |
| `add.machine-again` | `add` | 1 | the machine goes over a launch limit before the seat starts | `team add worker` |
| `add.merged-base` | `add` | 1 | workspace.base is required to read a merged end | `team add --temporary --like lead --until merged:topic` |
| `add.never-approved` | `add` | 1 | the file was never approved | `team add worker` |
| `add.no-like` | `add` | 1 | the file has no seat to copy | `team add --temporary --like missing --until result:out.md` |
| `add.no-profile` | `add` | 1 | the seat has no launch profile | `team add worker` |
| `add.no-seat` | `add` | 1 | the file has no such seat | `team add missing` |
| `add.not-ready` | `add` | 1 | the launch finished without a ready seat | `team add worker` |
| `add.not-restored` | `add` | 1 | the seat can't be put back into the file | `team add worker` |
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
| `add.reserved-name` | `add` | 2 | a new seat may not be named lead | `team add lead` |
| `add.seat-name` | `add` | 2 | a seat name is required | `team add` |
| `add.temporary-flags` | `add` | 2 | --until and --worktree need --temporary | `team add worker --until result:out.md` |
| `add.temporary-unexpected` | `add` | 2 | an unexpected argument was passed to --temporary | `team add extra --temporary` |
| `answer.ready` | `answer` | 0 | the trust dialog was answered and the seat is ready | `team answer lead trust` |
| `answer.action` | `answer` | 1 | the recorded key was not sent | `team answer lead trust` |
| `answer.ambiguous` | `answer` | 1 | herdr lists more than one agent of this name | `team answer lead trust` |
| `answer.another-pane` | `answer` | 1 | the state records another pane for the caller's seat | `team answer lead trust` |
| `answer.caller` | `answer` | 1 | the caller may not answer a trust dialog | `team answer lead trust` |
| `answer.detached` | `answer` | 1 | a run with no terminal | `team answer lead trust` |
| `answer.file-owner` | `answer` | 1 | --file is the owner's | `team answer lead trust --file .agents/team.yaml` |
| `answer.folder` | `answer` | 1 | the dialog's folder is not the lobby's exact trust entry | `team answer lead trust` |
| `answer.human` | `answer` | 1 | the seat is a human's pane; no dialog key is pressed and no rules line is typed | `team answer lead trust` |
| `answer.label` | `answer` | 1 | the trust choice is not the recorded one | `team answer lead trust` |
| `answer.no-pane` | `answer` | 1 | the state records no pane for the caller's seat | `team answer lead trust` |
| `answer.policy` | `answer` | 1 | the dialogs.trust grant is not in force | `team answer lead trust` |
| `answer.process` | `answer` | 1 | the process in the pane is not the one team launched | `team answer lead trust` |
| `answer.recovery` | `answer` | 1 | the trust answer did not complete: the seat stays in recovery | `team answer lead trust` |
| `answer.screen` | `answer` | 1 | the pane is not the trust dialog | `team answer lead trust` |
| `answer.session-owner` | `answer` | 1 | --session is the owner's | `team answer lead trust --session other` |
| `answer.state` | `answer` | 1 | the seat is not waiting at a trust dialog | `team answer lead trust` |
| `answer.unverified` | `answer` | 1 | the name is not a declared seat | `team answer lead trust` |
| `answer.version` | `answer` | 1 | this version has no trust answer | `team answer lead trust` |
| `answer.configuration` | `answer` | 2 | the team file cannot be read | `team answer lead trust --file missing.yaml` |
| `answer.usage` | `answer` | 2 | the invocation is not a seat and trust | `team answer` |
| `approvals.approval-requested` | `approvals` | 0 | an owner-seat request for this revoke was recorded and sent to the owner seat | `team approvals revoke <id> --request` |
| `approvals.listed` | `approvals` | 0 | the always rules were listed | `team approvals list` |
| `approvals.revoked` | `approvals` | 0 | the always rule was removed | `team approvals revoke <id>` |
| `approvals.approval-refused` | `approvals` | 1 | the owner-seat request or approval for this revoke was refused: missing, expired, mismatched, unsigned, self-approved or already used | `team approvals revoke <id> --approval <request-id>` |
| `approvals.refused` | `approvals` | 1 | the revoke was refused | `team approvals revoke <id>` |
| `approvals.invocation` | `approvals` | 2 | the invocation cannot be read | `team approvals` |
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
| `brief.current` | `brief` | 0 | --apply left every live or human seat current; the read is not demanded here | `team brief rollout --apply` |
| `brief.plan` | `brief` | 0 | the dry run found every live or human seat current, and wrote nothing | `team brief rollout` |
| `brief.file-owner` | `brief` | 1 | --file is the owner's | `team brief rollout --file .agents/team.yaml` |
| `brief.incomplete` | `brief` | 1 | --apply left a seat stale or failed | `team brief rollout --apply` |
| `brief.session-owner` | `brief` | 1 | --session is the owner's | `team brief rollout --session other` |
| `brief.stale` | `brief` | 1 | the dry run found a live or human seat that needs delivery | `team brief rollout` |
| `brief.file` | `brief` | 2 | the team file can't be read | `team brief rollout` |
| `brief.file-invalid` | `brief` | 2 | the team file can't be parsed | `team brief rollout` |
| `brief.invocation` | `brief` | 2 | the invocation can't be read | `team brief` |
| `brief.not-yours` | `brief` | 2 | the caller may not read this team | `team brief rollout` |
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
| `bus.approval-requested` | `bus` | 0 | an owner-seat request for this bus start was recorded and sent to the owner seat | `team bus --request` |
| `bus.started` | `bus` | 0 | the bus started and served on .agents/bus.sock | `team bus` |
| `bus.stopped` | `bus` | 0 | the bus served until it was stopped | `team bus` |
| `bus.approval-refused` | `bus` | 1 | the owner-seat request or approval for this bus start was refused: missing, expired, mismatched, unsigned, self-approved or already used | `team bus --approval <request-id>` |
| `bus.refused` | `bus` | 1 | the caller is not the owner or a leads seat at the right terminal, a bus is already running or starting, the inheritance token does not match, or the socket could not be bound | `team bus` |
| `bus.configuration` | `bus` | 2 | not inside a git repository or the team file cannot be read | `team bus` |
| `bus.usage` | `bus` | 2 | the invocation cannot be read | `team bus extra` |
| `check.ok` | `check` | 0 | nothing needs acting on | `team check` |
| `check.repaired` | `check` | 0 | the owner's --repair dropped the state's leftovers, and nothing else needs acting on | `team check --repair` |
| `check.file-owner` | `check` | 1 | --file is the owner's | `team check --file .agents/team.yaml` |
| `check.findings` | `check` | 1 | something needs acting on | `team check` |
| `check.repair-owner` | `check` | 1 | --repair is the owner's | `team check --repair` |
| `check.session-owner` | `check` | 1 | --session is the owner's | `team check --session team` |
| `check.file` | `check` | 2 | the team file can't be read | `team check --file missing.yaml` |
| `check.file-invalid` | `check` | 2 | the team file can't be parsed | `team check --file team.yaml` |
| `check.herdr` | `check` | 2 | herdr doesn't answer | `team check` |
| `check.invocation` | `check` | 2 | the invocation can't be read | `team check` |
| `check.not-a-repo` | `check` | 2 | not inside a git repository and no team file here | `team check` |
| `check.not-yours` | `check` | 2 | the caller may not check this team | `team check` |
| `check.state` | `check` | 2 | the state can't be read | `team check` |
| `client.keygen.done` | `client` | 0 | the client key pair was written in the named directory | `team client keygen --out ~/.config/team-client/grok-bot` |
| `client.keygen.pane` | `client` | 1 | keygen ran inside a team pane (a herdr seat or its child) and was refused before any directory was written | `team client keygen --out ~/.config/team-client/grok-bot` |
| `client.keygen.refused` | `client` | 1 | the key directory is outside the client key folder, inside a checkout, lobby or temp folder, linked, or cannot be checked | `team client keygen --out .` |
| `client.keygen.write` | `client` | 1 | the key directory already holds a key, or the pair could not be written 0600 | `team client keygen --out ~/.config/team-client/grok-bot` |
| `client.keygen.invocation` | `client` | 2 | the command arguments are invalid | `team client keygen` |
| `client.unknown` | `client` | 2 | the subcommand is not one this command knows | `team client grant` |
| `client.usage` | `client` | 2 | no subcommand was named | `team client` |
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
| `config.shown` | `config` | 0 | the settings registry is printed | `team config keys` |
| `config.unchanged` | `config` | 0 | the edit changes nothing; nothing was written | `team config set project acme` |
| `config.value` | `config` | 0 | the value at the path is printed | `team config get project` |
| `config.written` | `config` | 0 | the change validated and was written | `team config set watch.unread_after 5m` |
| `config.detached` | `config` | 1 | an edit was run with no terminal | `team config set watch.unread_after 5m` |
| `config.invalid` | `config` | 1 | the changed record does not validate; nothing was written | `team config set seats.lead.cli nope` |
| `config.no-value` | `config` | 1 | the path holds nothing in the record | `team config get watch.missing` |
| `config.not-owner` | `config` | 1 | an edit was run by a caller that is not the owner | `team config set watch.unread_after 5m` |
| `config.path` | `config` | 1 | the path cannot be set (a value on the way, or no such list item); nothing was written | `team config set seats.ghost.cli claude` |
| `config.editor` | `config` | 2 | the editor exited non-zero; nothing was written | `team config edit` |
| `config.invocation` | `config` | 2 | the invocation is not one of the command's forms | `team config` |
| `config.no-record` | `config` | 2 | the team's record could not be read for an edit | `team config get project` |
| `config.no-team` | `config` | 2 | no team is found for this folder to read or edit | `team config get project` |
| `config.unreadable` | `config` | 2 | the team's record cannot be read | `team config get project` |
| `config.usage` | `config` | 2 | a get, set, unset or edit invocation is not one of its forms, or the path does not parse | `team config set watch` |
| `conformance-adapter.finished` | `conformance-adapter` | 0 | the protocol finished | `team conformance-adapter` |
| `daemon.already-running` | `daemon` | 0 | a machine daemon is already answering; nothing second was started | `team daemon run` |
| `daemon.dry-run` | `daemon` | 0 | the install plan was printed and nothing was written | `team daemon install --dry-run` |
| `daemon.fault-dry-run` | `daemon` | 0 | the fault plan was printed and no request was written | `team daemon fault-watch --root <folder> --route <id> --dry-run` |
| `daemon.faulted` | `daemon` | 0 | the one named route's hosted run ended as a counted fault and restarts on the next heartbeat | `team daemon fault-watch --root <folder> --route <id>` |
| `daemon.installed` | `daemon` | 0 | the user service unit was written and registered, and the system service manager starts the daemon | `team daemon install` |
| `daemon.status` | `daemon` | 0 | the one-line health reading was printed: running, not running or unknown | `team daemon status` |
| `daemon.stopped` | `daemon` | 0 | the daemon served until it was stopped | `team daemon run` |
| `daemon.uninstalled` | `daemon` | 0 | the user service unit was removed, or was not installed | `team daemon uninstall` |
| `daemon.entry-missing` | `daemon` | 1 | the CLI entry cannot be found, so the service unit cannot be written | `team daemon install` |
| `daemon.fault-daemon` | `daemon` | 1 | the machine daemon is not running, so there is no hosted watch to fault | `team daemon fault-watch --root <folder> --route <id>` |
| `daemon.fault-not-reached` | `daemon` | 1 | the daemon did not fault the watch: it answered not reached, or the wait ended first; nothing was killed | `team daemon fault-watch --root <folder> --route <id>` |
| `daemon.fault-pending` | `daemon` | 1 | a fault request is already waiting for the daemon, so no second request was written | `team daemon fault-watch --root <folder> --route <id>` |
| `daemon.fault-refused` | `daemon` | 1 | the daemon refused the fault request: another home, daemon run or route, a non-private request, or no hosted run to fault | `team daemon fault-watch --root <folder> --route <id>` |
| `daemon.fault-route` | `daemon` | 1 | the route id does not name this checkout's own canonical route | `team daemon fault-watch --root <folder> --route <id>` |
| `daemon.fault-watch` | `daemon` | 1 | the daemon record carries no hosted watch for this checkout's route | `team daemon fault-watch --root <folder> --route <id>` |
| `daemon.fault-watch-state` | `daemon` | 1 | the route's hosted watch was not started as required, is standing down, or has stopped | `team daemon fault-watch --root <folder> --route <id>` |
| `daemon.install-failed` | `daemon` | 1 | the system service manager refused to write or start the unit | `team daemon install` |
| `daemon.not-owner` | `daemon` | 1 | the caller may not install or remove the machine daemon | `team daemon install` |
| `daemon.run-failed` | `daemon` | 1 | another start holds the machine lock, or the machine socket could not be bound | `team daemon run` |
| `daemon.run-not-owner` | `daemon` | 1 | the caller may not run the machine daemon; only the owner or the system service manager starts it | `team daemon run` |
| `daemon.service-unavailable` | `daemon` | 1 | no system service manager adapter is available on this platform yet | `team daemon install` |
| `daemon.uninstall-failed` | `daemon` | 1 | the system service manager refused to stop or remove the unit | `team daemon uninstall` |
| `daemon.fault-root` | `daemon` | 2 | a checkout named on fault-watch cannot be read, so no request was written | `team daemon fault-watch --root <folder> --route <id>` |
| `daemon.fault-usage` | `daemon` | 2 | the invocation cannot be read, or the route id is not one a hosted watch records | `team daemon fault-watch --route nope` |
| `daemon.no-root` | `daemon` | 2 | no checkout was named and the current folder has no readable team file | `team daemon install` |
| `daemon.run-root` | `daemon` | 2 | a checkout named on run cannot be read, so nothing was started | `team daemon run` |
| `daemon.usage` | `daemon` | 2 | the invocation cannot be read | `team daemon watch` |
| `delegate.done` | `delegate` | 0 | the authority record was updated, already matched, or passed a write-free preview | `team delegate <session/pane> --commands up,down` |
| `delegate.refused` | `delegate` | 1 | the caller is not the owner, the file changed during the edit, or the write failed | `team delegate <session/pane> --commands up,down` |
| `delegate.invalid` | `delegate` | 2 | the team file or proposed authority record is invalid or cannot be read | `team delegate <session/pane> --commands up,down` |
| `delegate.invocation` | `delegate` | 2 | the command arguments are invalid | `team delegate <session/pane> --commands up,down` |
| `development-mode.done` | `development-mode` | 0 | the machine development mode was read, shown, planned, or switched | `team development-mode set local-fast --show` |
| `development-mode.refused` | `development-mode` | 1 | a non-owner called set without the owner-authorization token for this exact switch, or the machine record cannot be read or verified | `team development-mode set off` |
| `development-mode.invocation` | `development-mode` | 2 | the command arguments are invalid | `team development-mode set maybe` |
| `doctor.clear` | `doctor` | 0 | nothing is missing | `team doctor` |
| `doctor.missing` | `doctor` | 1 | something is missing | `team doctor` |
| `doctor.both-modes` | `doctor` | 2 | both focused modes were asked at once | `team doctor --login --jules` |
| `doctor.file` | `doctor` | 2 | the team file can't be read | `team doctor --file missing.yaml` |
| `doctor.file-invalid` | `doctor` | 2 | the team file can't be parsed | `team doctor --file team.yaml` |
| `doctor.invocation` | `doctor` | 2 | the invocation can't be read | `team doctor extra` |
| `doctor.not-a-repo` | `doctor` | 2 | not inside a git repository | `team doctor` |
| `down.approval-requested` | `down` | 0 | an owner-seat request for this stop was recorded and sent to the owner seat | `team down --request` |
| `down.dry-run` | `down` | 0 | a dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch) | `team down --dry-run` |
| `down.idle` | `down` | 0 | there was nothing to stop | `team down` |
| `down.stopped` | `down` | 0 | the seats that could be stopped were stopped | `team down` |
| `down.abandon` | `down` | 1 | only the owner abandons a team | `team down --abandon` |
| `down.another-pane` | `down` | 1 | the state records another pane for the caller's seat | `team down` |
| `down.approval-refused` | `down` | 1 | the owner-seat request or approval for this stop was refused: missing, expired, mismatched, unsigned, self-approved or already used | `team down --approval <request-id>` |
| `down.caller` | `down` | 1 | the caller may not change the team | `team down` |
| `down.client-refused` | `down` | 1 | the owner-signed down grant, or the client run it admits, did not verify | `team down --client grant.json --key client.key` |
| `down.delegate` | `down` | 1 | the caller is not the approved delegate of any entry | `team down, from a pane no delegate entry names` |
| `down.delegate-approval` | `down` | 1 | delegation needs a verified approval | `team down, with no approval in force` |
| `down.delegate-command` | `down` | 1 | the approved delegate may not run `down` | `team down, from the approved delegate whose commands leave it out` |
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
| `drops.ok` | `drops` | 0 | the caller's unread drops were listed, or followed until it stopped | `team drops` |
| `drops.file` | `drops` | 1 | the team file can't be read | `team drops` |
| `drops.refused` | `drops` | 1 | the caller is not a placed seat of this team | `team drops` |
| `drops.unreadable` | `drops` | 1 | the drop folder can't be read | `team drops` |
| `drops.invocation` | `drops` | 2 | the invocation can't be read | `team drops extra` |
| `drops.not-a-repo` | `drops` | 2 | not inside a git repository | `team drops` |
| `feed.ok` | `feed` | 0 | the message feed was printed | `team feed` |
| `feed.presence-unreadable` | `feed` | 1 | the presence event log cannot be read | `team feed` |
| `feed.unreadable` | `feed` | 1 | the history log cannot be read | `team feed` |
| `feed.configuration` | `feed` | 2 | the team file can't be read | `team feed` |
| `feed.usage` | `feed` | 2 | the invocation can't be read | `team feed extra` |
| `forget.approval-requested` | `forget` | 0 | an owner-seat request for this forget was recorded and sent to the owner seat | `team forget <id> --request` |
| `forget.forgotten` | `forget` | 0 | the team registry record was removed; panes were not stopped and the team file was not deleted | `team forget <id>` |
| `forget.approval-refused` | `forget` | 1 | the owner-seat request or approval for this forget was refused: missing, expired, mismatched, unsigned, self-approved or already used | `team forget <id> --approval <request-id>` |
| `forget.missing` | `forget` | 1 | no team record matches the id | `team forget <id>` |
| `forget.refused` | `forget` | 1 | the forget was refused | `team forget <id>` |
| `forget.invocation` | `forget` | 2 | the invocation cannot be read | `team forget` |
| `grant.done` | `grant` | 0 | the authority was written or already matched — the team file's grant, or a standing grant record — or a write-free preview passed | `team grant lead --scope up,down` |
| `grant.refused` | `grant` | 1 | the caller is not the owner, the file changed during the edit, or the write failed | `team grant lead --capabilities gate,merge` |
| `grant.invalid` | `grant` | 2 | the team file, the named seat or team, or the proposed authority record is invalid, unknown or cannot be read | `team grant @team --capabilities create` |
| `grant.invocation` | `grant` | 2 | the command arguments are invalid | `team grant lead` |
| `hold.placed` | `hold` | 0 | the hold was placed | `team hold "freeze deploys"` |
| `hold.released` | `hold` | 0 | the hold was released | `team hold --release` |
| `hold.caller` | `hold` | 1 | not the owner, the orchestrator or the operator | `team hold "freeze deploys"` |
| `hold.client-refused` | `hold` | 1 | the owner-signed developer grant did not verify for this run | `team hold "freeze deploys" --client grant.json --key client.key` |
| `hold.detached` | `hold` | 1 | a run with no terminal | `team hold "freeze deploys"` |
| `hold.held` | `hold` | 1 | a hold already stands | `team hold "freeze deploys"` |
| `hold.io` | `hold` | 1 | the state can't be read or written | `team hold "freeze deploys"` |
| `hold.not-held` | `hold` | 1 | no hold stands | `team hold --release` |
| `hold.until` | `hold` | 1 | --until is not a clock or an instant | `team hold "freeze deploys" --until tomorrow` |
| `hold.file` | `hold` | 2 | the team file can't be read | `team hold "freeze deploys"` |
| `hold.invocation` | `hold` | 2 | the invocation can't be read | `team hold` |
| `import.approval-requested` | `import` | 0 | an owner-seat request for this import was recorded and sent to the owner seat | `team import --request` |
| `import.done` | `import` | 0 | the registry holds the file, or would with --dry-run | `team import` |
| `import.approval-refused` | `import` | 1 | the owner-seat request or approval for this import was refused: missing, expired, mismatched, unsigned, self-approved or already used | `team import --approval <request-id>` |
| `import.detached` | `import` | 1 | the owner-only act was run with no terminal | `team import` |
| `import.not-owner` | `import` | 1 | the caller is not the owner | `team import` |
| `import.invalid` | `import` | 2 | the team file is missing or does not validate | `team import missing.yaml` |
| `import.invocation` | `import` | 2 | the invocation does not parse | `team import a b` |
| `import.round-trip` | `import` | 2 | the team read back from the registry differs from the file | `team import` |
| `init.approval` | `init` | 0 | an owner-seat team request was recorded, answered, listed or revoked | `team init --request` |
| `init.restored` | `init` | 0 | the approved copy was restored | `team init --restore` |
| `init.restored-archive` | `init` | 0 | the team file was restored from an archive | `team init --from-archive ~/.config/team/archive/beacon-<hash>-20261014T100000Z` |
| `init.wrote` | `init` | 0 | a skeleton was written | `team init` |
| `init.approval-refused` | `init` | 1 | an owner-seat team request, answer, rule or execute was refused | `team init --execute <request-id>` |
| `init.detached` | `init` | 1 | a run with no terminal | `team init` |
| `init.exists` | `init` | 1 | the team file already exists | `team init` |
| `init.from-archive` | `init` | 1 | the archive can’t be read or verified | `team init --from-archive <folder>` |
| `init.from-archive-invalid` | `init` | 1 | the archived team file doesn’t validate | `team init --from-archive <folder>` |
| `init.git-silent` | `init` | 1 | git doesn't answer for this folder | `team init` |
| `init.legacy` | `init` | 1 | the record predates signed records | `team init --restore` |
| `init.not-owner` | `init` | 1 | not the owner | `team init` |
| `init.nothing` | `init` | 1 | there is nothing to restore | `team init --restore` |
| `init.refused` | `init` | 1 | the stored record does not verify | `team init --restore` |
| `init.restore-invalid` | `init` | 1 | the stored copy doesn't validate | `team init --restore` |
| `init.skeleton` | `init` | 1 | the skeleton doesn't validate | `team init` |
| `init.tracked` | `init` | 1 | the team file is tracked | `team init` |
| `init.invocation` | `init` | 2 | the invocation can't be read | `team init extra` |
| `init.not-a-repo` | `init` | 2 | not inside a git repository | `team init` |
| `init.sources` | `init` | 2 | --restore and --from-archive together | `team init --restore --from-archive <folder>` |
| `issues.none` | `issues` | 0 | nothing is waiting | `team issues` |
| `issues.shown` | `issues` | 0 | the task list was shown | `team issues` |
| `issues.file` | `issues` | 1 | the team file can't be read, its source is a broker's, or its task path can't be used | `team issues` |
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
| `mcp.serve-ended` | `mcp` | 0 | the inbox server's stdin closed and it stopped cleanly | `team mcp serve` |
| `mcp.up` | `mcp` | 0 | every observed bridge leg is up | `team mcp status` |
| `mcp.down` | `mcp` | 1 | at least one leg is down or unknown | `team mcp status` |
| `mcp.missing` | `mcp` | 1 | doctor found something missing | `team mcp doctor` |
| `mcp.not-set-up` | `mcp` | 1 | no bridge configuration exists in the lobby folder | `team mcp status` |
| `mcp.invocation` | `mcp` | 2 | the invocation can't be read | `team mcp` |
| `mcp.serve-refused` | `mcp` | 2 | the inbox server can't start: the invocation, the team placement or its inbox folder can't be read | `team mcp serve` |
| `messages.client-none` | `messages` | 0 | no client reply is waiting | `team messages --client client-grant.json --key client.key` |
| `messages.client-shown` | `messages` | 0 | a client reading completed, and an acknowledged reply's receipt was written when it was asked for | `team messages --client client-grant.json --key client.key --ack 3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d` |
| `messages.none` | `messages` | 0 | nothing is waiting | `team messages` |
| `messages.shown` | `messages` | 0 | a waiting message was shown and its receipt was written | `team messages` |
| `messages.client-key` | `messages` | 1 | the client key is missing or unreadable, or the ack receipt could not be signed with it | `team messages --client client-grant.json --key client.key --ack 3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d` |
| `messages.client-pane` | `messages` | 1 | a client reading ran inside a team pane (a herdr seat or its child) and was refused before the grant or key was opened | `team messages --client client-grant.json --key client.key` |
| `messages.client-refused` | `messages` | 1 | the signed request, its grant, its placement or its inbox can't be read, or a reply record or the ack does not verify | `team messages --client client-grant.json --key client.key` |
| `messages.file` | `messages` | 1 | the team file can't be read | `team messages` |
| `messages.id` | `messages` | 1 | the filename is not the record's id | `team messages` |
| `messages.key` | `messages` | 1 | the message key is missing or unreadable | `team messages` |
| `messages.root` | `messages` | 1 | the record is bound to another checkout | `team messages` |
| `messages.seat` | `messages` | 1 | the record is addressed to another seat | `team messages` |
| `messages.session` | `messages` | 1 | the record is bound to another session | `team messages` |
| `messages.shape` | `messages` | 1 | the record is not a message | `team messages` |
| `messages.signature` | `messages` | 1 | the signature is not the message key's | `team messages` |
| `messages.client-usage` | `messages` | 2 | the client invocation can't be read | `team messages --client client-grant.json` |
| `messages.invocation` | `messages` | 2 | the invocation can't be read | `team messages extra` |
| `messages.not-a-repo` | `messages` | 2 | not inside a git repository | `team messages` |
| `migrate.done` | `migrate` | 0 | the team is in the registry (or would be, with --dry-run), and its team file was moved to the Trash, renamed, kept with --keep-file, or already gone | `team migrate` |
| `migrate.already-migrated` | `migrate` | 1 | the registry already holds the team and the file left beside it says something else; team import replaces the record | `team migrate` |
| `migrate.detached` | `migrate` | 1 | the owner-only act was run with no terminal | `team migrate` |
| `migrate.not-owner` | `migrate` | 1 | the caller is not the owner | `team migrate` |
| `migrate.invalid` | `migrate` | 2 | the team file is missing or does not validate | `team migrate` |
| `migrate.invocation` | `migrate` | 2 | the invocation does not parse | `team migrate extra` |
| `migrate.registry` | `migrate` | 2 | the registry record that exists cannot be read | `team migrate` |
| `migrate.round-trip` | `migrate` | 2 | the team read back from the registry differs from the file | `team migrate` |
| `next.none` | `next` | 0 | nothing to take or to release | `team next` |
| `next.released` | `next` | 0 | the caller's lease was released | `team next --release` |
| `next.taken` | `next` | 0 | a record was claimed, or the caller's live lease was renewed | `team next` |
| `next.wait` | `next` | 0 | the wait was stopped, or a clock that did not advance ended it | `team next --wait` |
| `next.broker` | `next` | 1 | no broker is running, or its answer was not one this build knows | `team next` |
| `next.caller` | `next` | 1 | the caller is not a seat of this team on its recorded pane | `team next` |
| `next.file` | `next` | 1 | the team file can't be read, or its task source or task path can't be used | `team next` |
| `next.missing` | `next` | 1 | the task file is not there | `team next` |
| `next.paused` | `next` | 1 | the team or the calling seat is paused, so nothing was claimed | `team next` |
| `next.policy` | `next` | 1 | a task policy the validator refuses | `team next` |
| `next.read` | `next` | 1 | the broker failed the read | `team next` |
| `next.shape` | `next` | 1 | nothing was taken, and a record is not a task or the task file is not a list | `team next` |
| `next.swap` | `next` | 1 | the seat waits on a queued model swap, so nothing was claimed | `team next` |
| `next.invocation` | `next` | 2 | the invocation can't be read | `team next extra` |
| `next.not-a-repo` | `next` | 2 | not inside a git repository | `team next` |
| `owner-seat.done` | `owner-seat` | 0 | the owner seat was read, set up, its security profile signed or proposed, or the owner page served | `team owner-seat status` |
| `owner-seat.refused` | `owner-seat` | 1 | no owner seat, a cancelled or unverifiable owner-device signature, or a profile outside its bounds | `team owner-seat profile relaxed` |
| `owner-seat.invocation` | `owner-seat` | 2 | the command arguments are invalid | `team owner-seat profile maybe` |
| `pause.placed` | `pause` | 0 | the team or the named seat was paused | `team pause` |
| `pause.caller` | `pause` | 1 | not the owner or the orchestrator | `team pause` |
| `pause.client-refused` | `pause` | 1 | the owner-signed developer grant did not verify for this run | `team pause --client grant.json --key client.key` |
| `pause.detached` | `pause` | 1 | a run with no terminal | `team pause` |
| `pause.io` | `pause` | 1 | the state or the registry can't be read or written | `team pause` |
| `pause.paused` | `pause` | 1 | the team or the named seat is already paused | `team pause` |
| `pause.file` | `pause` | 2 | the team file can't be read | `team pause` |
| `pause.invocation` | `pause` | 2 | the invocation can't be read | `team pause --all --json` |
| `pause.team` | `pause` | 2 | the name is neither a declared seat nor a registered team, or names more than one | `team pause other` |
| `plan.none` | `plan` | 0 | nothing is takeable | `team plan` |
| `plan.shown` | `plan` | 0 | the takeable queue was printed | `team plan` |
| `plan.broker` | `plan` | 1 | no broker is running, or its answer was not one this build knows | `team plan` |
| `plan.caller` | `plan` | 1 | the caller is not a seat of this team on its recorded pane | `team plan` |
| `plan.file` | `plan` | 1 | the team file can't be read, or its task source or task path can't be used | `team plan` |
| `plan.missing` | `plan` | 1 | the task file is not there | `team plan` |
| `plan.read` | `plan` | 1 | the broker failed the read | `team plan` |
| `plan.shape` | `plan` | 1 | nothing was printed, and a record is not a task or the task file is not a list | `team plan` |
| `plan.invocation` | `plan` | 2 | the invocation can't be read | `team plan extra` |
| `plan.not-a-repo` | `plan` | 2 | not inside a git repository | `team plan` |
| `policy.done` | `policy` | 0 | the effective policies were listed, updated, or planned | `team policy` |
| `policy.refused` | `policy` | 1 | a non-owner attempted set or unset, a lower level loosened a higher level, or a source failed verification | `team policy set team dev-mode on` |
| `policy.invalid` | `policy` | 2 | the team file, policy name, or value is invalid | `team policy set team dev-mode maybe` |
| `policy.invocation` | `policy` | 2 | the invocation can't be read | `team policy set` |
| `pr.passed` | `pr` | 0 | the pull request body passed | `team pr check body.md` |
| `pr.refused` | `pr` | 1 | the pull request body was refused | `team pr check body.md` |
| `pr.body` | `pr` | 2 | the pull request body can't be read | `team pr check missing.md` |
| `pr.file` | `pr` | 2 | the team file can't be read | `team pr check body.md` |
| `pr.file-invalid` | `pr` | 2 | the team file can't be parsed | `team pr check body.md --file team.yaml` |
| `pr.invocation` | `pr` | 2 | the invocation can't be read | `team pr check` |
| `pr.ledger` | `pr` | 2 | the approval ledger can't be read | `team pr check body.md` |
| `pr.not-a-repo` | `pr` | 2 | not inside a git repository | `team pr check body.md` |
| `proc.added` | `proc` | 0 | the process was recorded | `team proc add build` |
| `proc.done` | `proc` | 0 | the record was cleared | `team proc done build` |
| `proc.listed` | `proc` | 0 | the live records were listed | `team proc list` |
| `proc.caller` | `proc` | 1 | the caller is no seat of this team and not the owner | `team proc add build` |
| `proc.detached` | `proc` | 1 | a run with no terminal | `team proc add build` |
| `proc.other-seat` | `proc` | 1 | another seat's record, which the caller may not clear | `team proc done build` |
| `proc.pid` | `proc` | 1 | the pid is not running | `team proc add build --pid 4243` |
| `proc.taken` | `proc` | 1 | another seat holds the name, with its process live | `team proc add build` |
| `proc.unknown` | `proc` | 1 | no record holds that name | `team proc done build` |
| `proc.file` | `proc` | 2 | the team file can't be read | `team proc add build` |
| `proc.file-invalid` | `proc` | 2 | the team file can't be parsed | `team proc add build` |
| `proc.invocation` | `proc` | 2 | the invocation can't be read | `team proc` |
| `proc.not-yours` | `proc` | 2 | the caller may not read this team | `team proc list` |
| `projects.listed` | `projects` | 0 | the projects are listed | `team projects` |
| `projects.unreadable` | `projects` | 1 | the project registry cannot be read | `team projects` |
| `projects.invocation` | `projects` | 2 | the invocation can't be read | `team projects extra` |
| `queue.added` | `queue` | 0 | the record was added to the queue | `team queue add "the task title" --id m1` |
| `queue.install` | `queue` | 0 | the install acknowledgment was recorded, or the same one was already held | `team queue install m1 --commit abcdef1` |
| `queue.none` | `queue` | 0 | the queue is empty | `team queue list` |
| `queue.present` | `queue` | 0 | the same record was already queued; nothing was written | `team queue add "the task title" --id m1` |
| `queue.ready` | `queue` | 0 | the green slice was recorded ready, or the same one was already held | `team queue ready m1 --commit abcdef1` |
| `queue.shown` | `queue` | 0 | the queue was listed | `team queue list` |
| `queue.caller` | `queue` | 1 | the caller is not the owner or a seat of this team on its recorded pane, or is not a seat for `ready` | `team queue add "the task title" --id m1` |
| `queue.duplicate` | `queue` | 1 | the id is already queued with a different record | `team queue add "another title" --id m1` |
| `queue.file` | `queue` | 1 | the team file can't be read | `team queue list` |
| `queue.installer` | `queue` | 1 | the caller is not the owner or the designated installer on its recorded pane, or the designation is not approved | `team queue install m1 --commit abcdef1` |
| `queue.lease` | `queue` | 1 | the caller holds no live lease of the task it names | `team queue ready m1 --commit abcdef1` |
| `queue.read` | `queue` | 1 | the task file is missing, not a list, could not be written or read back, or holds no such task | `team queue list` |
| `queue.record` | `queue` | 1 | the green-slice journal can't be read or written, or holds its maximum pending slices | `team queue ready m1 --commit abcdef1` |
| `queue.source` | `queue` | 1 | the team file declares a linear task source; there is no local queue, and the tracker is never written | `team queue list` |
| `queue.invocation` | `queue` | 2 | the invocation can't be read, or a value is not a task id, a declared seat, a one-line title or priority, a commit, or a version | `team queue add` |
| `queue.not-a-repo` | `queue` | 2 | not inside a git repository | `team queue list` |
| `raise.dry-run` | `raise` | 0 | the route the raise would take; nothing was written | `team raise release.ready "the release is ready for the owner" --dry-run` |
| `raise.merged` | `raise` | 0 | the line was merged into the owner's open record, and the record counts it | `team raise release.ready "the release is ready for the owner"` |
| `raise.raised` | `raise` | 0 | the line reached the owner's mailbox as a signed record, and the owner was notified | `team raise release.ready "the release is ready for the owner"` |
| `raise.capped` | `raise` | 1 | ten raises have reached the owner today | `team raise release.ready "the release is ready for the owner"` |
| `raise.io` | `raise` | 1 | the event log or the owner's record can't be read or written | `team raise release.ready "the release is ready for the owner"` |
| `raise.refused` | `raise` | 1 | not the orchestrator's seat or a lead's | `team raise release.ready "the release is ready for the owner"` |
| `raise.file` | `raise` | 2 | the team file can't be read | `team raise release.ready "the release is ready for the owner"` |
| `raise.usage` | `raise` | 2 | the invocation can't be read | `team raise` |
| `register.already` | `register` | 0 | the seat is already recorded on that pane | `team register worker` |
| `register.dry-run` | `register` | 0 | the seat would be registered; nothing was written | `team register worker --dry-run` |
| `register.ready` | `register` | 0 | the running seat's record was written | `team register worker` |
| `register.caller` | `register` | 1 | --session is the owner's | `team register worker --session other` |
| `register.cli` | `register` | 1 | the pane holds no process the seat's CLI profile names | `team register worker` |
| `register.delegate` | `register` | 1 | the caller is not the approved delegate for up | `team register worker` |
| `register.detached` | `register` | 1 | a run with no terminal | `team register worker` |
| `register.grant` | `register` | 1 | the caller is not the seat the file's grant names for up | `team register worker` |
| `register.grant-flag` | `register` | 1 | --session is the owner's for a granted seat | `team register worker --session other` |
| `register.herdr` | `register` | 1 | herdr doesn't answer | `team register worker` |
| `register.many-agents` | `register` | 1 | the session has more than one agent with that name | `team register worker` |
| `register.no-agent` | `register` | 1 | no agent of that name is running in the session | `team register worker` |
| `register.no-cli` | `register` | 1 | the pane holds no CLI in front of its shell | `team register worker` |
| `register.no-pane` | `register` | 1 | no pane of that id runs in the session | `team register worker --pane w9:p9` |
| `register.no-profile` | `register` | 1 | the seat has no launch profile | `team register worker` |
| `register.no-seat` | `register` | 1 | the file has no such seat | `team register missing` |
| `register.no-session` | `register` | 1 | the herdr session is not running | `team register worker` |
| `register.not-owner` | `register` | 1 | the caller is not the owner, a delegate this file names for up, or the seat its grant names | `team register worker` |
| `register.pane-named` | `register` | 1 | --pane named a pane herdr already names as another agent | `team register worker --pane w2:p2` |
| `register.pane-taken` | `register` | 1 | another seat of the session holds that pane | `team register worker --pane w2:p2` |
| `register.recorded` | `register` | 1 | the state records another pane for that seat | `team register worker` |
| `register.screen` | `register` | 1 | the pane is not the seat at its prompt | `team register worker` |
| `register.session-file` | `register` | 1 | the session was launched from another team file | `team register worker --session other` |
| `register.stopped` | `register` | 1 | the seat is stopped in the file | `team register worker` |
| `register.file` | `register` | 2 | the team file can't be read or parsed, or not inside a git repository | `team register worker` |
| `register.usage` | `register` | 2 | the invocation can't be read | `team register` |
| `release.passed` | `release` | 0 | every check passed | `team release check material@3.0.2` |
| `release.missing` | `release` | 1 | a check is missing | `team release check material@3.0.2` |
| `release.unknown` | `release` | 2 | a check is unknown | `team release check material@3.0.2` |
| `release.configuration` | `release` | 64 | the team file can't be read | `team release check material@3.0.2` |
| `release.usage` | `release` | 64 | the invocation can't be read | `team release` |
| `reload.reloaded` | `reload` | 0 | the seat was closed at an idle prompt and the new launch reached ready | `team reload worker` |
| `reload.same` | `reload` | 0 | the seat is already running what the file declares | `team reload worker` |
| `reload.unrecorded` | `reload` | 0 | its launch record held no model; the screen's or the file's values were recorded, and nothing was closed | `team reload worker` |
| `reload.absent` | `reload` | 1 | the file has no seat of that name | `team reload missing` |
| `reload.changed` | `reload` | 1 | the seat changed before it closed; nothing relaunched | `team reload worker` |
| `reload.client-refused` | `reload` | 1 | the owner-signed manager grant, or the client reload it admits, did not verify | `team reload worker --client grant.json --key client.key` |
| `reload.grant-another-pane` | `reload` | 1 | the state records another pane for the granted seat | `team reload worker` |
| `reload.grant-approval` | `reload` | 1 | a grant needs a verified approval | `team reload worker` |
| `reload.grant-caller` | `reload` | 1 | only the seat the grant names runs this | `team reload worker` |
| `reload.grant-file` | `reload` | 1 | the team file can't be read | `team reload worker` |
| `reload.grant-flag` | `reload` | 1 | --file is the owner's; the granted seat cannot use it | `team reload worker --file other.yaml` |
| `reload.grant-no-pane` | `reload` | 1 | no pane is recorded for the granted seat | `team reload worker` |
| `reload.grant-omitted` | `reload` | 1 | the file grants nothing | `team reload worker` |
| `reload.grant-scope` | `reload` | 1 | the grant does not list reload | `team reload worker` |
| `reload.human` | `reload` | 1 | the seat is a human's pane; nothing is closed, typed into or launched over it | `team reload worker` |
| `reload.launch` | `reload` | 1 | the close happened and the new launch did not reach ready | `team reload worker` |
| `reload.not-idle` | `reload` | 1 | the seat is not at an idle prompt; nothing closed | `team reload worker` |
| `reload.not-running` | `reload` | 1 | the seat has no ready pane to close | `team reload worker` |
| `reload.run-lock` | `reload` | 1 | another session-mutating run is holding the session | `team reload worker` |
| `reload.self` | `reload` | 1 | a reload does not close the caller's seat | `team reload lead` |
| `reload.unsent` | `reload` | 1 | the seat holds unsent text; nothing closed | `team reload worker` |
| `reload.untested` | `reload` | 1 | the installed CLI is outside its profile's tested range, so the relaunch's ready screen may not be recognised; nothing closed | `team reload worker` |
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
| `remove.client-refused` | `remove` | 1 | the owner-signed manager grant, or the client removal it admits, did not verify, or the seat is a lead seat or a human's pane | `team remove spare --client grant.json --key client.key --team docs` |
| `remove.coordinator` | `remove` | 1 | only the owner removes the orchestrator's or the operator's seat | `team remove lead` |
| `remove.default-session` | `remove` | 1 | the session can't be "default" | `team remove worker --session default` |
| `remove.delegate` | `remove` | 1 | the caller is not the approved delegate | `team remove worker` |
| `remove.delegate-approval` | `remove` | 1 | delegation needs a verified approval | `team remove worker` |
| `remove.delegate-command` | `remove` | 1 | the approved delegate may not run remove | `team remove worker` |
| `remove.delegate-evidence` | `remove` | 1 | the delegate's placement or seats can't be verified | `team remove worker` |
| `remove.delegate-flag` | `remove` | 1 | the delegate may not use this flag | `team remove worker --keep` |
| `remove.delegate-placement` | `remove` | 1 | the approved delegate must be an external non-seat pane | `team remove worker` |
| `remove.detached` | `remove` | 1 | a run with no terminal | `team remove worker` |
| `remove.endpoint` | `remove` | 1 | the seat's managed Codex endpoint cannot be stopped or kept | `team remove worker, on a seat whose pane is left running or whose endpoint cannot be proven` |
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
| `remove.unverified` | `remove` | 1 | a name the file does not carry is left as it is | `team remove extra` |
| `remove.edit` | `remove` | 2 | the edit would not validate | `team remove lead` |
| `remove.file` | `remove` | 2 | the team file can't be read | `team remove worker --file missing.yaml` |
| `remove.file-invalid` | `remove` | 2 | the team file can't be parsed | `team remove worker --file team.yaml` |
| `remove.invocation` | `remove` | 2 | the invocation can't be read | `team remove` |
| `remove.locked` | `remove` | 2 | the locked edit does not validate | `team remove worker` |
| `remove.not-a-repo` | `remove` | 2 | not inside a git repository | `team remove worker` |
| `rename.done` | `rename` | 0 | the seat was renamed (or --renumber planned/applied) | `team rename worker builder-1` |
| `rename.refused` | `rename` | 1 | the caller is not the owner or leads, the target seat exists, or the target clashes with a nickname | `team rename worker lead` |
| `rename.invalid` | `rename` | 2 | the team file or new seat name is invalid | `team rename worker Bad_Name` |
| `rename.invocation` | `rename` | 2 | the invocation can't be read | `team rename` |
| `reply.replied` | `reply` | 0 | the reply record was written on its thread, or its thread was closed | `team reply 3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d answered` |
| `reply.client-refused` | `reply` | 1 | a client thread can't be answered: its origin grant, its placement, its recipient or the writer's own seat does not bind it, or the reply can't be written | `team reply 3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d answered` |
| `reply.refused` | `reply` | 1 | the record can't be answered, the thread can't be closed, or the call is not the owner or a seat of the team | `team reply 3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d answered` |
| `reply.configuration` | `reply` | 2 | the team file can't be read | `team reply 3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d answered` |
| `reply.usage` | `reply` | 2 | the invocation can't be read | `team reply` |
| `restart.dry-run` | `restart` | 0 | the stop and launch plan was printed and nothing was touched | `team restart worker --dry-run` |
| `restart.ready` | `restart` | 0 | the seat was restarted in a new pane | `team restart worker` |
| `restart.abandon-working` | `restart` | 1 | a seat caller passed --abandon on a working seat | `team restart worker --abandon` |
| `restart.busy` | `restart` | 1 | the seat is busy and --abandon was not given, or graceful stop did not close the pane | `team restart worker` |
| `restart.caller` | `restart` | 1 | the caller may not restart a seat, or passed an owner-only flag | `team restart worker` |
| `restart.client-refused` | `restart` | 1 | the owner-signed manager grant, or the client restart it admits, did not verify | `team restart worker --client grant.json --key client.key` |
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
| `resume.resumed` | `resume` | 0 | the team or the named seat resumed | `team resume` |
| `resume.caller` | `resume` | 1 | not the owner or the orchestrator | `team resume` |
| `resume.client-refused` | `resume` | 1 | the owner-signed developer grant did not verify for this run | `team resume --client grant.json --key client.key` |
| `resume.detached` | `resume` | 1 | a run with no terminal | `team resume` |
| `resume.io` | `resume` | 1 | the state or the registry can't be read or written | `team resume` |
| `resume.not-paused` | `resume` | 1 | no pause stands on the target; under a team pause, a seat has no own record | `team resume` |
| `resume.file` | `resume` | 2 | the team file can't be read | `team resume` |
| `resume.invocation` | `resume` | 2 | the invocation can't be read | `team resume --all --json` |
| `resume.team` | `resume` | 2 | the name is neither a declared seat nor a registered team, or names more than one | `team resume other` |
| `revoke.done` | `revoke` | 0 | the authority was removed or matched, the standing grant's revocation was appended or already named, or a write-free preview passed | `team revoke flag-gate` |
| `revoke.refused` | `revoke` | 1 | the caller is not the owner, the file changed during the edit, or the write failed | `team revoke grant` |
| `revoke.invalid` | `revoke` | 2 | the team file, the named target or the proposed authority record is invalid or cannot be read | `team revoke delegate malformed` |
| `revoke.invocation` | `revoke` | 2 | the command arguments are invalid | `team revoke all` |
| `route.dry-run` | `route` | 0 | the pair is admitted; the address is answered and nothing was written | `team route builder-2 --dry-run` |
| `route.routed` | `route` | 0 | the pair is admitted and the recipient's address is answered and recorded | `team route builder-2` |
| `route.detached` | `route` | 1 | a run with no terminal | `team route builder-2` |
| `route.refused` | `route` | 1 | no address was answered, on purpose | `team route builder-2` |
| `route.unrecorded` | `route` | 1 | the pair is admitted and the route record could not be written | `team route builder-2` |
| `route.configuration` | `route` | 2 | the team file cannot be read | `team route builder-2` |
| `route.usage` | `route` | 2 | the invocation cannot be read | `team route` |
| `seat.shown` | `seat` | 0 | the seat is printed | `team seat lead` |
| `seat.client-refused` | `seat` | 1 | the owner-signed bundle grant, or the client read it admits, did not verify | `team seat worker --client grant.json --key client.key` |
| `seat.file-owner` | `seat` | 1 | --file is the owner's | `team seat lead --file .agents/team.yaml` |
| `seat.no-seat` | `seat` | 1 | the team file declares no seat of that name | `team seat ghost` |
| `seat.session-owner` | `seat` | 1 | --session is the owner's | `team seat lead --session team` |
| `seat.sessions` | `seat` | 1 | the session registry can't be read | `team seat lead` |
| `seat.file` | `seat` | 2 | the team file can't be found or read | `team seat lead --file missing.yaml` |
| `seat.file-invalid` | `seat` | 2 | the team file does not parse or does not validate | `team seat lead --file team.yaml` |
| `seat.herdr` | `seat` | 2 | herdr doesn't answer | `team seat lead` |
| `seat.invocation` | `seat` | 2 | the invocation is not one of the command's forms | `team seat` |
| `seat.not-a-repo` | `seat` | 2 | the directory is not inside a git repository | `team seat lead` |
| `seat.not-yours` | `seat` | 2 | the team is not the caller's to read | `team seat lead` |
| `seat.source` | `seat` | 2 | a signed settings record can't be read or does not verify | `team seat lead` |
| `seats.shown` | `seats` | 0 | the seats table was printed | `team seats` |
| `seats.client-refused` | `seats` | 1 | the owner-signed bundle grant, or the client read it admits, did not verify | `team seats --client grant.json --key client.key` |
| `seats.file-owner` | `seats` | 1 | --file is the owner's | `team seats --file .agents/team.yaml` |
| `seats.session-owner` | `seats` | 1 | --session is the owner's | `team seats --session team` |
| `seats.file` | `seats` | 2 | the team file can't be read | `team seats --file missing.yaml` |
| `seats.file-invalid` | `seats` | 2 | the team file can't be parsed | `team seats --file team.yaml` |
| `seats.herdr` | `seats` | 2 | herdr doesn't answer | `team seats` |
| `seats.invocation` | `seats` | 2 | the invocation can't be read | `team seats extra` |
| `seats.not-a-repo` | `seats` | 2 | not inside a git repository | `team seats` |
| `seats.not-yours` | `seats` | 2 | the caller may not read this team | `team seats` |
| `send.answered` | `send` | 0 | a reply record on the thread arrived within the window | `team send worker hello --wait` |
| `send.approval-requested` | `send` | 0 | an owner-seat request for this send was recorded and sent to the owner seat | `team send <seat> <message> --request` |
| `send.client-sent` | `send` | 0 | a client grant's signed drop was written to the entity orchestrator's drop folder | `team send --client grant.json --key client.key orchestrator@floor hello` |
| `send.confirmed` | `send` | 0 | a native handoff was recorded to the history and its pending record cleared | `team send --confirm 11111111-1111-4111-8111-111111111111` |
| `send.delivered` | `send` | 0 | the record is written and the seat's channel took the message | `team send worker hello` |
| `send.dry-run` | `send` | 0 | the seat and channel were resolved and nothing was written | `team send worker hello --dry-run` |
| `send.listed` | `send` | 0 | the addressable seats were printed, nothing was sent | `team send --list` |
| `send.native` | `send` | 0 | a native handoff was printed for the sender's own SendMessage, and nothing was delivered | `team send worker hello` |
| `send.queued` | `send` | 0 | the receiver was busy, so the signed copy is stored and nothing was typed; the message is delivered when the seat's lock clears, and the id on the line is the one the delivery keeps | `team send lead hello` |
| `send.record-dry-run` | `send` | 0 | a recorded native delivery was resolved and nothing was written | `team send --record builder-2 --channel native --ms 812 --dry-run` |
| `send.recorded` | `send` | 0 | a native delivery the sender made itself was written to the history | `team send --record builder-2 --channel native --ms 812` |
| `send.sent-unconfirmed` | `send` | 0 | the record is written and left in the seat's own folder — its inbox on the mcp-inbox leg, its drop folder on the drop leg — and no signed read receipt has come back | `team send worker hello` |
| `send.approval-refused` | `send` | 1 | the owner-seat request or approval for this send was refused: missing, expired, mismatched, unsigned, self-approved or already used | `team send <seat> <message> --approval <request-id>` |
| `send.brief-memory` | `send` | 1 | a --brief send is refused because the team's brief transport is memory; nothing was written and there is no fallback | `team send worker --brief brief.md` |
| `send.client-pane` | `send` | 1 | a client invocation ran inside a team pane (a herdr seat or its child) and was refused before the grant or key was opened | `team send --client client-grant.json --key client.key orchestrator@floor hello` |
| `send.client-refused` | `send` | 1 | a client grant invocation was refused before any record was written | `team send --client missing.json --key client.key orchestrator@floor hello` |
| `send.detached` | `send` | 1 | a run with no terminal | `team send --list` |
| `send.held` | `send` | 1 | the message is on disk and the pane was left untouched | `team send worker hello` |
| `send.not-submitted` | `send` | 1 | the trigger was typed and the seat never took it | `team send worker hello` |
| `send.refused` | `send` | 1 | nothing was sent, on purpose | `team send missing hello` |
| `send.stopped` | `send` | 1 | the seat is stopped in the team file | `team send worker hello` |
| `send.timeout` | `send` | 1 | the record was sent, and the wait window closed with no reply on the thread (the thread stays open) | `team send worker hello --wait --timeout 10` |
| `send.unreachable` | `send` | 1 | the seat was not reached | `team send worker hello` |
| `send.client-usage` | `send` | 2 | the client grant invocation can't be read | `team send --client grant.json orchestrator@floor hello` |
| `send.configuration` | `send` | 2 | the team file cannot be read, or the caller's folder is no team and a bare name has none to resolve in | `team send lead --file missing.yaml` |
| `send.usage` | `send` | 2 | the invocation can't be read | `team send` |
| `sessions.none` | `sessions` | 0 | no session record matched | `team sessions` |
| `sessions.shown` | `sessions` | 0 | the session records were listed | `team sessions` |
| `sessions.client-refused` | `sessions` | 1 | the owner-signed bundle grant, or the client read it admits, did not verify | `team sessions --client grant.json --key client.key` |
| `sessions.read` | `sessions` | 1 | a session registry can't be read | `team sessions` |
| `sessions.invocation` | `sessions` | 2 | the invocation can't be read | `team sessions --by nothing` |
| `settings.dry-run` | `settings` | 0 | the change a write would make is printed and nothing is written | `team settings set lead nickname=Ada --dry-run` |
| `settings.set` | `settings` | 0 | the setting is signed into the seat's record and logged | `team settings set lead nickname=Ada` |
| `settings.shown` | `settings` | 0 | the seat's settings are printed | `team settings lead` |
| `settings.unset` | `settings` | 0 | the setting is removed from the seat's record and logged | `team settings unset lead nickname` |
| `settings.file-owner` | `settings` | 1 | --file is the owner's | `team settings lead --file .agents/team.yaml` |
| `settings.no-agent` | `settings` | 1 | the seat has no registered agent record and one could not be created to hold its settings | `team settings set lead nickname=Ada` |
| `settings.no-seat` | `settings` | 1 | the team file declares no seat of that name | `team settings ghost` |
| `settings.not-owner` | `settings` | 1 | only the owner sets a seat's settings | `team settings set lead nickname=Ada` |
| `settings.not-set` | `settings` | 1 | an unset names a setting that is not set on the seat | `team settings unset lead model` |
| `settings.policy` | `settings` | 1 | a policy in force over the seat does not admit the value | `team settings set lead delivery_order=typed` |
| `settings.file` | `settings` | 2 | the team file can't be found or read | `team settings lead --file missing.yaml` |
| `settings.file-invalid` | `settings` | 2 | the team file does not parse or does not validate | `team settings lead --file team.yaml` |
| `settings.invocation` | `settings` | 2 | the invocation is not one of the command's forms | `team settings` |
| `settings.key` | `settings` | 2 | a setting key is unknown or is not one a seat holds | `team settings set lead nope=1` |
| `settings.not-a-repo` | `settings` | 2 | the directory is not inside a git repository | `team settings lead` |
| `settings.not-yours` | `settings` | 2 | the team is not the caller's to read | `team settings lead` |
| `settings.source` | `settings` | 2 | a signed settings record can't be read or does not verify | `team settings lead` |
| `settings.value` | `settings` | 2 | a value is outside what the seat's profile or the key's shape accepts | `team settings set lead model=nope` |
| `settings.write` | `settings` | 2 | the seat's record can't be replaced | `team settings set lead nickname=Ada` |
| `status.agrees` | `status` | 0 | the file, the state and the session agree | `team status` |
| `status.project-listed` | `status` | 0 | the project's teams are listed | `team status --project TeamCLI` |
| `status.client-refused` | `status` | 1 | the owner-signed bundle grant, or the client read it admits, did not verify | `team status --client grant.json --key client.key` |
| `status.difference` | `status` | 1 | there is a difference | `team status` |
| `status.file-owner` | `status` | 1 | --file is the owner's | `team status --file .agents/team.yaml` |
| `status.project-unknown` | `status` | 1 | no project is named that | `team status --project nope` |
| `status.session-owner` | `status` | 1 | --session is the owner's | `team status --session team` |
| `status.file` | `status` | 2 | the team file can't be read | `team status --file missing.yaml` |
| `status.file-invalid` | `status` | 2 | the team file can't be parsed | `team status --file team.yaml` |
| `status.herdr` | `status` | 2 | herdr doesn't answer | `team status` |
| `status.invocation` | `status` | 2 | the invocation can't be read | `team status extra` |
| `status.not-a-repo` | `status` | 2 | not inside a git repository | `team status` |
| `status.not-yours` | `status` | 2 | the caller may not read this team | `team status` |
| `swap.cancelled` | `swap` | 0 | the queued swap was taken out of the queue | `team swap cancel builder-1` |
| `swap.forced` | `swap` | 0 | the owner forced the queued swap to run at once | `team swap now builder-1` |
| `swap.listed` | `swap` | 0 | the queue or the entity's rule listing was shown | `team swap` |
| `swap.queued` | `swap` | 0 | a model swap was queued for the seat's boundary | `team swap queue builder-1` |
| `swap.ran` | `swap` | 0 | the queued swaps due now were carried out, or none was due | `team swap --run` |
| `swap.caller` | `swap` | 1 | not the owner, the orchestrator or the operator, or not a seat of the team for the view | `team swap queue builder-1` |
| `swap.detached` | `swap` | 1 | a run with no terminal | `team swap now builder-1` |
| `swap.herdr` | `swap` | 1 | herdr cannot be read, so no swap can be run | `team swap --run` |
| `swap.io` | `swap` | 1 | the state can't be read or written | `team swap queue builder-1` |
| `swap.not-queued` | `swap` | 1 | no swap waits for the seat | `team swap cancel builder-1` |
| `swap.rule` | `swap` | 1 | the entity's model rule can't be read or none is declared | `team swap queue builder-1` |
| `swap.run-failed` | `swap` | 1 | a due swap did not run: a preflight refusal, a read-back mismatch, or the seat is signed off or no longer declared | `team swap --run` |
| `swap.seat` | `swap` | 1 | no such seat in the team | `team swap queue nobody` |
| `swap.target` | `swap` | 1 | no seat of the entity the team may copy from runs the requested model, or no recipe is available | `team swap queue builder-1 --to claude-code:nothing` |
| `swap.unchanged` | `swap` | 1 | the seat already declares a model the rule allows | `team swap queue builder-1` |
| `swap.file` | `swap` | 2 | the team file or a --file path can't be read | `team swap --rule` |
| `swap.invocation` | `swap` | 2 | the invocation can't be read | `team swap queue` |
| `team.command-help` | `team` | 0 | a command's help was printed | `team status --help` |
| `team.help` | `team` | 0 | help was printed | `team --help` |
| `team.presence-hook-ignored` | `team` | 0 | a notification other than the measured permission prompt was ignored and nothing was staged | `team presence-hook --event human-wait --notification permission_prompt` |
| `team.presence-hook-staged` | `team` | 0 | the presence event was staged | `team presence-hook --event turn-end` |
| `team.version` | `team` | 0 | the version was printed | `team --version` |
| `team.command-threw` | `team` | 1 | a command threw | `team init` |
| `team.presence-hook-invalid` | `team` | 1 | the presence hook's words can't be read | `team presence-hook --event turn-end` |
| `team.presence-hook-refused` | `team` | 1 | the presence event could not be staged | `team presence-hook --event turn-end` |
| `team.approve-removed` | `team` | 2 | the approve command was removed in 0.5.0 | `team approve` |
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
| `up.approval-requested` | `up` | 0 | an owner-seat request for this launch was recorded and sent to the owner seat | `team up --request` |
| `up.dry-run` | `up` | 0 | a dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch) | `team up --dry-run` |
| `up.ready` | `up` | 0 | the launch finished | `team up` |
| `up.agents` | `up` | 1 | the agents can't be read | `team up` |
| `up.approval-refused` | `up` | 1 | the owner-seat request or approval for this launch was refused: missing, expired, mismatched, unsigned, self-approved or already used | `team up --approval <request-id>` |
| `up.clear` | `up` | 1 | a stopped session this team records did not clear | `team up` |
| `up.client-refused` | `up` | 1 | the owner-signed up grant, or the client run it admits, did not verify | `team up --client grant.json --key client.key` |
| `up.delegate` | `up` | 1 | only the owner or the approved delegate runs up | `team up` |
| `up.delegate-approval` | `up` | 1 | the delegate gate needs a verified approval | `team up` |
| `up.delegate-command` | `up` | 1 | the approved delegate may not run up | `team up` |
| `up.delegate-evidence` | `up` | 1 | the delegate gate can't verify its placement or seats | `team up` |
| `up.delegate-flag` | `up` | 1 | --session or --file is the owner's on a delegated run | `team up --session other` |
| `up.delegate-placement` | `up` | 1 | the approved delegate must be an external non-seat pane | `team up` |
| `up.deny` | `up` | 1 | deny | `team up` |
| `up.detached` | `up` | 1 | a run with no terminal | `team up --session elsewhere` |
| `up.doctor` | `up` | 1 | doctor refuses the launch | `team up` |
| `up.grant-another-pane` | `up` | 1 | the granted seat is not on its recorded pane | `team up` |
| `up.grant-approval` | `up` | 1 | a grant needs a verified approval | `team up` |
| `up.grant-caller` | `up` | 1 | only the seat the grant names runs this | `team up` |
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
| `watch.standby` | `watch` | 0 | a hosted watch stood down for a running watch | `team watch` |
| `watch.started` | `watch` | 0 | the watch started in its own workspace | `team watch` |
| `watch.stopped` | `watch` | 0 | the watch ran and stopped | `team watch` |
| `watch.already` | `watch` | 1 | a watch already runs | `team watch` |
| `watch.caller` | `watch` | 1 | a run with no terminal | `team watch` |
| `watch.file-owner` | `watch` | 1 | --file is the owner's | `team watch --file .agents/team.yaml` |
| `watch.no-notify` | `watch` | 1 | a seat passed --no-notify | `team watch --no-notify` |
| `watch.no-nudge` | `watch` | 1 | a seat passed --no-nudge | `team watch --no-nudge` |
| `watch.watchdog` | `watch` | 1 | only the recorded watch may read the file up recorded | `team watch --session acme` |
| `watch.workspace` | `watch` | 1 | the watch did not start in its workspace | `team watch` |
| `watch.file` | `watch` | 2 | the team file can't be read | `team watch --file missing.yaml` |
| `watch.file-invalid` | `watch` | 2 | the team file can't be parsed | `team watch --file team.yaml` |
| `watch.invocation` | `watch` | 2 | the invocation can't be read | `team watch extra` |
| `watch.not-a-repo` | `watch` | 2 | not inside a git repository | `team watch` |
| `workflow.check.passed` | `workflow` | 0 | the workflow passed validation | `team workflow check workflow.yaml` |
| `workflow.replay` | `workflow` | 0 | the dry-run journal replayed identically against the definition and evidence | `team workflow replay workflow.yaml journal.json --evidence evidence.json` |
| `workflow.run-dry` | `workflow` | 0 | the dry run exhausted the script without a stop | `team workflow run workflow.yaml --dry --script script.yaml` |
| `workflow.check.refused` | `workflow` | 1 | at least one finding is a refusal | `team workflow check workflow.yaml` |
| `workflow.definition` | `workflow` | 1 | the workflow definition is invalid, mismatches the journal's digest, or reaches uses: | `team workflow replay workflow.yaml journal.json --evidence evidence.json` |
| `workflow.dry-only` | `workflow` | 1 | live workflow execution is refused without --dry until the Kernel workflow gate (amendment 04) | `team workflow run workflow.yaml` |
| `workflow.evidence` | `workflow` | 1 | the evidence block or evidence file is malformed or a referenced fixture is missing | `team workflow replay workflow.yaml journal.json --evidence evidence.json` |
| `workflow.journal` | `workflow` | 1 | the dry-run journal is malformed or not a non-authoritative dry-run journal | `team workflow replay workflow.yaml journal.json --evidence evidence.json` |
| `workflow.refused` | `workflow` | 1 | the dry run stopped on a held or refused decision | `team workflow run workflow.yaml --dry --script script.yaml` |
| `workflow.replay-mismatch` | `workflow` | 1 | the re-evaluated run diverged from the recorded journal | `team workflow replay workflow.yaml journal.json --evidence evidence.json` |
| `workflow.script` | `workflow` | 1 | the dry-run script is not valid format 1 | `team workflow run workflow.yaml --dry --script script.yaml` |
| `workflow.check.file` | `workflow` | 2 | the workflow file can't be read | `team workflow check missing.yaml` |
| `workflow.check.file-invalid` | `workflow` | 2 | the workflow file can't be parsed as a YAML mapping | `team workflow check workflow.yaml` |
| `workflow.check.invocation` | `workflow` | 2 | the invocation can't be read | `team workflow check` |
| `workflow.file` | `workflow` | 2 | a workflow, script, journal, or evidence file can't be read or the workflow file is invalid for run | `team workflow run missing.yaml --dry --script script.yaml` |
| `workflow.invocation` | `workflow` | 2 | the invocation can't be read | `team workflow` |
| `worktree.created` | `worktree` | 0 | the worktree was created | `team worktree new task --kind fix` |
| `worktree.listed` | `worktree` | 0 | the recorded worktrees were listed | `team worktree list` |
| `worktree.record-gone` | `worktree` | 0 | the record was removed after the folder was already gone | `team worktree remove task` |
| `worktree.removed` | `worktree` | 0 | the worktree was removed | `team worktree remove task` |
| `worktree.another-pane` | `worktree` | 1 | the state records another pane for the caller's seat | `team worktree new task` |
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
| `worktree.never-approved` | `worktree` | 1 | the standing approval record is legacy or cannot be verified | `team worktree new task` |
| `worktree.no-pane` | `worktree` | 1 | the state records no pane for the caller's seat | `team worktree new task` |
| `worktree.occupied` | `worktree` | 1 | a seat is recorded in the worktree | `team worktree remove task` |
| `worktree.path-kind` | `worktree` | 1 | workspace.path must not contain {kind} | `team worktree new task` |
| `worktree.placeholder` | `worktree` | 1 | the branch or path pattern has an unknown placeholder | `team worktree new task` |
| `worktree.published` | `worktree` | 1 | the branch already exists on a remote | `team worktree new task --kind fix` |
| `worktree.recorded` | `worktree` | 1 | the task is already recorded | `team worktree new task --kind fix` |
| `worktree.recorded-elsewhere` | `worktree` | 1 | the task is recorded in another session | `team worktree new task --kind fix` |
| `worktree.remove-branch` | `worktree` | 1 | the --branch given does not name the branch the worktree is on | `team worktree remove task --branch fix/other` |
| `worktree.remove-failed` | `worktree` | 1 | the worktree was not removed | `team worktree remove task` |
| `worktree.remove-task` | `worktree` | 1 | the task name is not a single segment | `team worktree remove ../task` |
| `worktree.seat` | `worktree` | 1 | --seat names no declared seat | `team worktree new task --kind fix --seat missing` |
| `worktree.session-owner` | `worktree` | 1 | --session is the owner's | `team worktree new task --session other` |
| `worktree.setup` | `worktree` | 1 | setup failed | `team worktree new task --kind fix` |
| `worktree.shared` | `worktree` | 1 | the workspace is shared | `team worktree new task` |
| `worktree.symlink` | `worktree` | 1 | the worktree follows a symlink outside the trust paths | `team worktree new task --kind fix` |
| `worktree.task` | `worktree` | 1 | the task name is not a single segment | `team worktree new ../task` |
| `worktree.tracking` | `worktree` | 1 | the base tracks something that is not a remote branch | `team worktree new task --kind fix` |
| `worktree.trust` | `worktree` | 1 | the worktree is outside the file's trust paths | `team worktree new select-width --kind fix` |
| `worktree.unpublished` | `worktree` | 1 | the worktree has commits on no remote branch | `team worktree remove task` |
| `worktree.unreadable` | `worktree` | 1 | the worktree couldn't be read | `team worktree remove task` |
| `worktree.branch-flags` | `worktree` | 2 | new and list take no --branch | `team worktree new task --branch fix/task` |
| `worktree.extra` | `worktree` | 2 | an unexpected argument was given | `team worktree new task extra` |
| `worktree.file` | `worktree` | 2 | the team file can't be read | `team worktree new task --file missing.yaml` |
| `worktree.file-invalid` | `worktree` | 2 | the team file can't be parsed | `team worktree new task --file team.yaml` |
| `worktree.invocation` | `worktree` | 2 | the invocation can't be read | `team worktree --nope` |
| `worktree.not-a-repo` | `worktree` | 2 | not inside a git repository | `team worktree new task` |
| `worktree.remove-flags` | `worktree` | 2 | remove takes no --kind or --seat | `team worktree remove task --kind fix` |
| `worktree.subcommand` | `worktree` | 2 | a subcommand is required | `team worktree` |
| `worktree.task-required` | `worktree` | 2 | a task name is required | `team worktree new` |
