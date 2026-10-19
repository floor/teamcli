---
created: 2026-10-18
updated: 2026-10-18
kind: registry-draft
status: draft
read-at: v0.5.0 (52db9b75); integration supplement int/0.5.1 8acb470b, unreleased
source: contract/exit-codes.json
---

# Registry: exit-codes

**What it lists.** Every symbolic exit identifier, owning command and numeric exit status in the release contract.

**Policy for a new entry.** The TeamCLI team maintains this registry with its implementation. An addition needs a spec change, its consistency check and a release note; an RFC round is needed only if it breaks a commitment. These are draft registration rules pending review.

The Since column records presence at a pinned revision, not an audited first-introduction release. Planned rows confer no implementation or authority.

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `add.dry-run` | a dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch) | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `0` |
| `add.ready` | the seat is ready | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `0` |
| `add.agents` | the agents can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.already-running` | the seat is already running | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.branch-missing` | the merged branch doesn't exist | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.budget` | the budget refuses the seat | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.caller` | the caller may not change the team | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.ceiling` | the file's seat ceiling would be passed | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.ceilings` | a record that does not verify is not in force | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.changed` | the file changed while add was checking | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.default-session` | the session can't be "default" | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.delegate` | the caller is not the approved delegate | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.delegate-approval` | delegation needs a verified approval | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.delegate-command` | the approved delegate may not run add | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.delegate-edit` | the delegate's add is not a same-copy seat: it would edit the file, or names a stanza the approval does not hold | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.delegate-evidence` | the delegate's placement or seats can't be verified | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.delegate-flag` | the delegate may not use this flag | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.delegate-placement` | the approved delegate must be an external non-seat pane | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.doctor` | doctor refuses the launch | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.file-owner` | --file is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.herdr` | herdr doesn't answer | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.lobby` | the lobby could not be created for the launch | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.machine` | the machine is over a launch limit | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.machine-again` | the machine goes over a launch limit before the seat starts | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.merged-base` | workspace.base is required to read a merged end | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.never-approved` | the file was never approved | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.no-like` | the file has no seat to copy | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.no-profile` | the seat has no launch profile | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.no-seat` | the file has no such seat | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.not-ready` | the launch finished without a ready seat | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.not-restored` | the seat can't be put back into the file | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.override-owner` | --model and --effort on a declared seat are the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.placed` | the seat would be placed outside the project | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.pretrust` | the lobby is not trusted for this seat's CLI | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.result-absolute` | a result path is absolute | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.result-exists` | the result path already exists | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.run-lock` | another session-mutating run is holding the session | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.server` | the session's server did not start | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.session-doubt` | the pane holds a process the record cannot tie to the launch | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.session-owner` | --session is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.start` | the seat has nowhere to start | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.stopped` | the session is stopped | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.until` | --until is not a result path or a merged branch | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.worktree-failed` | the worktree setup failed | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.worktree-missing` | no worktree with that name is recorded | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `1` |
| `add.effort` | the --effort override is not allowed for the seat's CLI or vendor | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `2` |
| `add.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `2` |
| `add.file-invalid` | the team file can't be parsed | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `2` |
| `add.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `2` |
| `add.locked` | the locked edit does not validate | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `2` |
| `add.model` | the --model override is not known for the seat's CLI | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `2` |
| `add.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `2` |
| `add.prepared` | the prepared edit does not validate | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `2` |
| `add.reserved-name` | a new seat may not be named lead | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `2` |
| `add.seat-name` | a seat name is required | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `2` |
| `add.temporary-flags` | --like, --until and --worktree need --temporary | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `2` |
| `add.temporary-unexpected` | an unexpected argument was passed to --temporary | present at 0.5.0 | `contract/exit-codes.json` | command `add`; exit `2` |
| `answer.ready` | the trust dialog was answered and the seat is ready | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `0` |
| `answer.action` | the recorded key was not sent | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.ambiguous` | herdr lists more than one agent of this name | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.another-pane` | the state records another pane for the caller's seat | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.caller` | the caller may not answer a trust dialog | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.file-owner` | --file is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.folder` | the dialog's folder is not the lobby's exact trust entry | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.label` | the trust choice is not the recorded one | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.no-pane` | the state records no pane for the caller's seat | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.policy` | the dialogs.trust grant is not in force | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.process` | the process in the pane is not the one team launched | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.recovery` | the trust answer did not complete: the seat stays in recovery | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.screen` | the pane is not the trust dialog | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.session-owner` | --session is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.state` | the seat is not waiting at a trust dialog | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.unverified` | the name is not a declared seat | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.version` | this version has no trust answer | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `1` |
| `answer.configuration` | the team file cannot be read | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `2` |
| `answer.usage` | the invocation is not a seat and trust | present at 0.5.0 | `contract/exit-codes.json` | command `answer`; exit `2` |
| `ask-show.shown` | the question is printed | present at 0.5.0 | `contract/exit-codes.json` | command `ask-show`; exit `0` |
| `ask-show.expired` | the marker matches and the ask is past expires_at plus 5 seconds | present at 0.5.0 | `contract/exit-codes.json` | command `ask-show`; exit `1` |
| `ask-show.refused` | the marker does not verify, or a file cannot be read | present at 0.5.0 | `contract/exit-codes.json` | command `ask-show`; exit `1` |
| `ask-show.invocation` | the invocation cannot be read | present at 0.5.0 | `contract/exit-codes.json` | command `ask-show`; exit `2` |
| `broker.stopped` | the broker served until it was stopped | present at 0.5.0 | `contract/exit-codes.json` | command `broker`; exit `0` |
| `broker.bind` | the socket could not be bound | present at 0.5.0 | `contract/exit-codes.json` | command `broker`; exit `1` |
| `broker.busy` | a broker is already answering on this clone's socket | present at 0.5.0 | `contract/exit-codes.json` | command `broker`; exit `1` |
| `broker.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `broker`; exit `1` |
| `broker.file` | the team file can't be read or parsed | present at 0.5.0 | `contract/exit-codes.json` | command `broker`; exit `1` |
| `broker.keychain` | the Keychain credential was refused | present at 0.5.0 | `contract/exit-codes.json` | command `broker`; exit `1` |
| `broker.locked` | another start is binding this clone's socket | present at 0.5.0 | `contract/exit-codes.json` | command `broker`; exit `1` |
| `broker.not-owner` | only the owner runs broker | present at 0.5.0 | `contract/exit-codes.json` | command `broker`; exit `1` |
| `broker.policy` | a task policy the validator refuses | present at 0.5.0 | `contract/exit-codes.json` | command `broker`; exit `1` |
| `broker.source` | the team file declares no task source, or one the broker does not serve | present at 0.5.0 | `contract/exit-codes.json` | command `broker`; exit `1` |
| `broker.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `broker`; exit `2` |
| `broker.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `broker`; exit `2` |
| `check.ok` | nothing needs acting on | present at 0.5.0 | `contract/exit-codes.json` | command `check`; exit `0` |
| `check.repaired` | the owner's --repair dropped the state's leftovers, and nothing else needs acting on | present at 0.5.0 | `contract/exit-codes.json` | command `check`; exit `0` |
| `check.file-owner` | --file is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `check`; exit `1` |
| `check.findings` | something needs acting on | present at 0.5.0 | `contract/exit-codes.json` | command `check`; exit `1` |
| `check.repair-owner` | --repair is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `check`; exit `1` |
| `check.session-owner` | --session is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `check`; exit `1` |
| `check.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `check`; exit `2` |
| `check.file-invalid` | the team file can't be parsed | present at 0.5.0 | `contract/exit-codes.json` | command `check`; exit `2` |
| `check.herdr` | herdr doesn't answer | present at 0.5.0 | `contract/exit-codes.json` | command `check`; exit `2` |
| `check.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `check`; exit `2` |
| `check.not-a-repo` | not inside a git repository and no team file here | present at 0.5.0 | `contract/exit-codes.json` | command `check`; exit `2` |
| `check.not-yours` | the caller may not check this team | present at 0.5.0 | `contract/exit-codes.json` | command `check`; exit `2` |
| `check.state` | the state can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `check`; exit `2` |
| `commits.passed` | every commit passed | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `0` |
| `commits.refused` | a commit was refused | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `1` |
| `commits.threw` | a forbidden pattern is not a regular expression | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `1` |
| `commits.empty-range` | the range holds no commit | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `2` |
| `commits.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `2` |
| `commits.file-invalid` | the team file can't be parsed | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `2` |
| `commits.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `2` |
| `commits.ledger` | the approval ledger can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `2` |
| `commits.no-commit` | the ref names nothing | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `2` |
| `commits.not-a-ref` | since is not a ref | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `2` |
| `commits.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `2` |
| `commits.outside` | the check is not in a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `2` |
| `commits.range` | the range can't be resolved | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `2` |
| `commits.since-missing` | since doesn't name a commit | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `2` |
| `commits.since-unreachable` | since is not reachable from the ref | present at 0.5.0 | `contract/exit-codes.json` | command `commits`; exit `2` |
| `conformance-adapter.finished` | the protocol finished | present at 0.5.0 | `contract/exit-codes.json` | command `conformance-adapter`; exit `0` |
| `delegate.done` | the authority record was updated, already matched, or passed a write-free preview | present at 0.5.0 | `contract/exit-codes.json` | command `delegate`; exit `0` |
| `delegate.refused` | the caller is not the owner, the file changed during the edit, or the write failed | present at 0.5.0 | `contract/exit-codes.json` | command `delegate`; exit `1` |
| `delegate.invalid` | the team file or proposed authority record is invalid or cannot be read | present at 0.5.0 | `contract/exit-codes.json` | command `delegate`; exit `2` |
| `delegate.invocation` | the command arguments are invalid | present at 0.5.0 | `contract/exit-codes.json` | command `delegate`; exit `2` |
| `doctor.clear` | nothing is missing | present at 0.5.0 | `contract/exit-codes.json` | command `doctor`; exit `0` |
| `doctor.missing` | something is missing | present at 0.5.0 | `contract/exit-codes.json` | command `doctor`; exit `1` |
| `doctor.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `doctor`; exit `2` |
| `doctor.file-invalid` | the team file can't be parsed | present at 0.5.0 | `contract/exit-codes.json` | command `doctor`; exit `2` |
| `doctor.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `doctor`; exit `2` |
| `doctor.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `doctor`; exit `2` |
| `down.dry-run` | a dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch) | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `0` |
| `down.idle` | there was nothing to stop | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `0` |
| `down.stopped` | the seats that could be stopped were stopped | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `0` |
| `down.abandon` | only the owner abandons a team | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.another-pane` | the state records another pane for the caller's seat | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.caller` | the caller may not change the team | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.delegate` | the caller is not the approved delegate of any entry | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.delegate-approval` | delegation needs a verified approval | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.delegate-command` | the approved delegate may not run `down` | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.delegate-evidence` | delegation cannot verify its placement or seats | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.delegate-flag` | a prohibited flag is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.delegate-placement` | the approved delegate must be an external non-seat pane | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.file-owner` | --file is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.grant-approval` | a grant needs a verified approval | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.grant-scope` | the grant does not list down | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.held` | a step was held | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.legacy` | a legacy approval record stops nobody | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.never-approved` | a file that was never approved stops nobody | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.no-launch` | this call has no way to reach herdr | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.no-pane` | the state records no pane for the caller's seat | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.refused` | a refused approval record stops nobody | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.run-lock` | another session-mutating run is holding the session | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.session-owner` | --session is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `1` |
| `down.agents` | the agents can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `2` |
| `down.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `2` |
| `down.file-invalid` | the team file can't be parsed | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `2` |
| `down.herdr` | herdr doesn't answer | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `2` |
| `down.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `2` |
| `down.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `down`; exit `2` |
| `feed.ok` | the message feed was printed | present at 0.5.0 | `contract/exit-codes.json` | command `feed`; exit `0` |
| `feed.unreadable` | the history log cannot be read | present at 0.5.0 | `contract/exit-codes.json` | command `feed`; exit `1` |
| `feed.configuration` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `feed`; exit `2` |
| `feed.usage` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `feed`; exit `2` |
| `grant.done` | the authority was written or already matched — the team file's grant, or a standing grant record — or a write-free preview passed | present at 0.5.0 | `contract/exit-codes.json` | command `grant`; exit `0` |
| `grant.refused` | the caller is not the owner, the file changed during the edit, or the write failed | present at 0.5.0 | `contract/exit-codes.json` | command `grant`; exit `1` |
| `grant.invalid` | the team file, the named seat or team, or the proposed authority record is invalid, unknown or cannot be read | present at 0.5.0 | `contract/exit-codes.json` | command `grant`; exit `2` |
| `grant.invocation` | the command arguments are invalid | present at 0.5.0 | `contract/exit-codes.json` | command `grant`; exit `2` |
| `hold.placed` | the hold was placed | present at 0.5.0 | `contract/exit-codes.json` | command `hold`; exit `0` |
| `hold.released` | the hold was released | present at 0.5.0 | `contract/exit-codes.json` | command `hold`; exit `0` |
| `hold.caller` | not the owner, the orchestrator or the operator | present at 0.5.0 | `contract/exit-codes.json` | command `hold`; exit `1` |
| `hold.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `hold`; exit `1` |
| `hold.held` | a hold already stands | present at 0.5.0 | `contract/exit-codes.json` | command `hold`; exit `1` |
| `hold.io` | the state can't be read or written | present at 0.5.0 | `contract/exit-codes.json` | command `hold`; exit `1` |
| `hold.not-held` | no hold stands | present at 0.5.0 | `contract/exit-codes.json` | command `hold`; exit `1` |
| `hold.until` | --until is not a clock or an instant | present at 0.5.0 | `contract/exit-codes.json` | command `hold`; exit `1` |
| `hold.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `hold`; exit `2` |
| `hold.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `hold`; exit `2` |
| `init.restored` | the approved copy was restored | present at 0.5.0 | `contract/exit-codes.json` | command `init`; exit `0` |
| `init.wrote` | a skeleton was written | present at 0.5.0 | `contract/exit-codes.json` | command `init`; exit `0` |
| `init.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `init`; exit `1` |
| `init.exists` | the team file already exists | present at 0.5.0 | `contract/exit-codes.json` | command `init`; exit `1` |
| `init.git-silent` | git doesn't answer for this folder | present at 0.5.0 | `contract/exit-codes.json` | command `init`; exit `1` |
| `init.legacy` | the record predates signed records | present at 0.5.0 | `contract/exit-codes.json` | command `init`; exit `1` |
| `init.not-owner` | not the owner | present at 0.5.0 | `contract/exit-codes.json` | command `init`; exit `1` |
| `init.nothing` | there is nothing to restore | present at 0.5.0 | `contract/exit-codes.json` | command `init`; exit `1` |
| `init.refused` | the stored record does not verify | present at 0.5.0 | `contract/exit-codes.json` | command `init`; exit `1` |
| `init.skeleton` | the skeleton doesn't validate | present at 0.5.0 | `contract/exit-codes.json` | command `init`; exit `1` |
| `init.tracked` | the team file is tracked | present at 0.5.0 | `contract/exit-codes.json` | command `init`; exit `1` |
| `init.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `init`; exit `2` |
| `init.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `init`; exit `2` |
| `issues.none` | nothing is waiting | present at 0.5.0 | `contract/exit-codes.json` | command `issues`; exit `0` |
| `issues.shown` | the task list was shown | present at 0.5.0 | `contract/exit-codes.json` | command `issues`; exit `0` |
| `issues.file` | the team file can't be read, it declares no task source, or its source is a broker's | present at 0.5.0 | `contract/exit-codes.json` | command `issues`; exit `1` |
| `issues.missing` | the task file is not there | present at 0.5.0 | `contract/exit-codes.json` | command `issues`; exit `1` |
| `issues.shape` | a record is not a task, or the task file is not a list | present at 0.5.0 | `contract/exit-codes.json` | command `issues`; exit `1` |
| `issues.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `issues`; exit `2` |
| `issues.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `issues`; exit `2` |
| `list.empty` | herdr answered and there is nothing to list | present at 0.5.0 | `contract/exit-codes.json` | command `list`; exit `0` |
| `list.herdr-down` | herdr cannot be asked, so the list is empty | present at 0.5.0 | `contract/exit-codes.json` | command `list`; exit `0` |
| `list.shown` | the sessions are printed | present at 0.5.0 | `contract/exit-codes.json` | command `list`; exit `0` |
| `list.invocation` | the arguments are not this command's | present at 0.5.0 | `contract/exit-codes.json` | command `list`; exit `2` |
| `lock.taken` | the lock was taken | present at 0.5.0 | `contract/exit-codes.json` | command `lock`; exit `0` |
| `lock.held` | the lock is already held | present at 0.5.0 | `contract/exit-codes.json` | command `lock`; exit `1` |
| `lock.io` | the lock directory could not be written | present at 0.5.0 | `contract/exit-codes.json` | command `lock`; exit `1` |
| `lock.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `lock`; exit `2` |
| `lock.project` | the caller's project can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `lock`; exit `2` |
| `mcp.clear` | the bridge is clear: doctor found nothing missing | present at 0.5.0 | `contract/exit-codes.json` | command `mcp`; exit `0` |
| `mcp.up` | every observed bridge leg is up | present at 0.5.0 | `contract/exit-codes.json` | command `mcp`; exit `0` |
| `mcp.down` | at least one leg is down or unknown | present at 0.5.0 | `contract/exit-codes.json` | command `mcp`; exit `1` |
| `mcp.missing` | doctor found something missing | present at 0.5.0 | `contract/exit-codes.json` | command `mcp`; exit `1` |
| `mcp.not-set-up` | no bridge configuration exists in the lobby folder | present at 0.5.0 | `contract/exit-codes.json` | command `mcp`; exit `1` |
| `mcp.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `mcp`; exit `2` |
| `messages.none` | nothing is waiting | present at 0.5.0 | `contract/exit-codes.json` | command `messages`; exit `0` |
| `messages.shown` | a waiting message was shown and its receipt was written | present at 0.5.0 | `contract/exit-codes.json` | command `messages`; exit `0` |
| `messages.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `messages`; exit `1` |
| `messages.id` | the filename is not the record's id | present at 0.5.0 | `contract/exit-codes.json` | command `messages`; exit `1` |
| `messages.key` | the message key is missing or unreadable | present at 0.5.0 | `contract/exit-codes.json` | command `messages`; exit `1` |
| `messages.root` | the record is bound to another checkout | present at 0.5.0 | `contract/exit-codes.json` | command `messages`; exit `1` |
| `messages.seat` | the record is addressed to another seat | present at 0.5.0 | `contract/exit-codes.json` | command `messages`; exit `1` |
| `messages.session` | the record is bound to another session | present at 0.5.0 | `contract/exit-codes.json` | command `messages`; exit `1` |
| `messages.shape` | the record is not a message | present at 0.5.0 | `contract/exit-codes.json` | command `messages`; exit `1` |
| `messages.signature` | the signature is not the message key's | present at 0.5.0 | `contract/exit-codes.json` | command `messages`; exit `1` |
| `messages.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `messages`; exit `2` |
| `messages.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `messages`; exit `2` |
| `next.none` | nothing to take or to release | present at 0.5.0 | `contract/exit-codes.json` | command `next`; exit `0` |
| `next.released` | the caller's lease was released | present at 0.5.0 | `contract/exit-codes.json` | command `next`; exit `0` |
| `next.taken` | a record was claimed, or the caller's live lease was renewed | present at 0.5.0 | `contract/exit-codes.json` | command `next`; exit `0` |
| `next.wait` | the wait was stopped, or a clock that did not advance ended it | present at 0.5.0 | `contract/exit-codes.json` | command `next`; exit `0` |
| `next.broker` | no broker is running, or its answer was not one this build knows | present at 0.5.0 | `contract/exit-codes.json` | command `next`; exit `1` |
| `next.caller` | the caller is not a seat of this team on its recorded pane | present at 0.5.0 | `contract/exit-codes.json` | command `next`; exit `1` |
| `next.file` | the team file can't be read, or it declares no task source | present at 0.5.0 | `contract/exit-codes.json` | command `next`; exit `1` |
| `next.missing` | the task file is not there | present at 0.5.0 | `contract/exit-codes.json` | command `next`; exit `1` |
| `next.policy` | a task policy the validator refuses | present at 0.5.0 | `contract/exit-codes.json` | command `next`; exit `1` |
| `next.read` | the broker failed the read | present at 0.5.0 | `contract/exit-codes.json` | command `next`; exit `1` |
| `next.shape` | nothing was taken, and a record is not a task or the task file is not a list | present at 0.5.0 | `contract/exit-codes.json` | command `next`; exit `1` |
| `next.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `next`; exit `2` |
| `next.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `next`; exit `2` |
| `plan.none` | nothing is takeable | present at 0.5.0 | `contract/exit-codes.json` | command `plan`; exit `0` |
| `plan.shown` | the takeable queue was printed | present at 0.5.0 | `contract/exit-codes.json` | command `plan`; exit `0` |
| `plan.broker` | no broker is running, or its answer was not one this build knows | present at 0.5.0 | `contract/exit-codes.json` | command `plan`; exit `1` |
| `plan.caller` | the caller is not a seat of this team on its recorded pane | present at 0.5.0 | `contract/exit-codes.json` | command `plan`; exit `1` |
| `plan.file` | the team file can't be read, or it declares no task source | present at 0.5.0 | `contract/exit-codes.json` | command `plan`; exit `1` |
| `plan.missing` | the task file is not there | present at 0.5.0 | `contract/exit-codes.json` | command `plan`; exit `1` |
| `plan.read` | the broker failed the read | present at 0.5.0 | `contract/exit-codes.json` | command `plan`; exit `1` |
| `plan.shape` | nothing was printed, and a record is not a task or the task file is not a list | present at 0.5.0 | `contract/exit-codes.json` | command `plan`; exit `1` |
| `plan.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `plan`; exit `2` |
| `plan.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `plan`; exit `2` |
| `policy.done` | the effective policies were listed, updated, or planned | present at 0.5.0 | `contract/exit-codes.json` | command `policy`; exit `0` |
| `policy.refused` | a non-owner attempted set or unset, a lower level loosened a higher level, or a source failed verification | present at 0.5.0 | `contract/exit-codes.json` | command `policy`; exit `1` |
| `policy.invalid` | the team file, policy name, or value is invalid | present at 0.5.0 | `contract/exit-codes.json` | command `policy`; exit `2` |
| `policy.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `policy`; exit `2` |
| `pr.passed` | the pull request body passed | present at 0.5.0 | `contract/exit-codes.json` | command `pr`; exit `0` |
| `pr.refused` | the pull request body was refused | present at 0.5.0 | `contract/exit-codes.json` | command `pr`; exit `1` |
| `pr.body` | the pull request body can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `pr`; exit `2` |
| `pr.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `pr`; exit `2` |
| `pr.file-invalid` | the team file can't be parsed | present at 0.5.0 | `contract/exit-codes.json` | command `pr`; exit `2` |
| `pr.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `pr`; exit `2` |
| `pr.ledger` | the approval ledger can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `pr`; exit `2` |
| `pr.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `pr`; exit `2` |
| `proc.added` | the process was recorded | present at 0.5.0 | `contract/exit-codes.json` | command `proc`; exit `0` |
| `proc.done` | the record was cleared | present at 0.5.0 | `contract/exit-codes.json` | command `proc`; exit `0` |
| `proc.listed` | the live records were listed | present at 0.5.0 | `contract/exit-codes.json` | command `proc`; exit `0` |
| `proc.caller` | the caller is no seat of this team and not the owner | present at 0.5.0 | `contract/exit-codes.json` | command `proc`; exit `1` |
| `proc.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `proc`; exit `1` |
| `proc.other-seat` | another seat's record, which the caller may not clear | present at 0.5.0 | `contract/exit-codes.json` | command `proc`; exit `1` |
| `proc.pid` | the pid is not running | present at 0.5.0 | `contract/exit-codes.json` | command `proc`; exit `1` |
| `proc.taken` | another seat holds the name, with its process live | present at 0.5.0 | `contract/exit-codes.json` | command `proc`; exit `1` |
| `proc.unknown` | no record holds that name | present at 0.5.0 | `contract/exit-codes.json` | command `proc`; exit `1` |
| `proc.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `proc`; exit `2` |
| `proc.file-invalid` | the team file can't be parsed | present at 0.5.0 | `contract/exit-codes.json` | command `proc`; exit `2` |
| `proc.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `proc`; exit `2` |
| `proc.not-yours` | the caller may not read this team | present at 0.5.0 | `contract/exit-codes.json` | command `proc`; exit `2` |
| `projects.listed` | the projects are listed | present at 0.5.0 | `contract/exit-codes.json` | command `projects`; exit `0` |
| `projects.unreadable` | the project registry cannot be read | present at 0.5.0 | `contract/exit-codes.json` | command `projects`; exit `1` |
| `projects.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `projects`; exit `2` |
| `register.already` | the seat is already recorded on that pane | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `0` |
| `register.dry-run` | the seat would be registered; nothing was written | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `0` |
| `register.ready` | the running seat's record was written | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `0` |
| `register.caller` | --session is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.cli` | the pane holds no process the seat's CLI profile names | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.delegate` | the caller is not the approved delegate for up | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.grant` | the caller is not the seat the file's grant names for up | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.grant-flag` | --session is the owner's for a granted seat | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.herdr` | herdr doesn't answer | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.many-agents` | the session has more than one agent with that name | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.no-agent` | no agent of that name is running in the session | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.no-cli` | the pane holds no CLI in front of its shell | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.no-pane` | no pane of that id runs in the session | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.no-profile` | the seat has no launch profile | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.no-seat` | the file has no such seat | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.no-session` | the herdr session is not running | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.not-owner` | the caller is not the owner, a delegate this file names for up, or the seat its grant names | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.pane-named` | --pane named a pane herdr already names as another agent | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.pane-taken` | another seat of the session holds that pane | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.recorded` | the state records another pane for that seat | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.screen` | the pane is not the seat at its prompt | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.session-file` | the session was launched from another team file | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.stopped` | the seat is stopped in the file | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `1` |
| `register.file` | the team file can't be read or parsed, or not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `2` |
| `register.usage` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `register`; exit `2` |
| `release.passed` | every check passed | present at 0.5.0 | `contract/exit-codes.json` | command `release`; exit `0` |
| `release.missing` | a check is missing | present at 0.5.0 | `contract/exit-codes.json` | command `release`; exit `1` |
| `release.unknown` | a check is unknown | present at 0.5.0 | `contract/exit-codes.json` | command `release`; exit `2` |
| `release.configuration` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `release`; exit `64` |
| `release.usage` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `release`; exit `64` |
| `reload.reloaded` | the seat was closed at an idle prompt and the new launch reached ready | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `0` |
| `reload.same` | the seat is already running what the file declares | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `0` |
| `reload.unrecorded` | its launch record held no model; the screen's or the file's values were recorded, and nothing was closed | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `0` |
| `reload.absent` | the file has no seat of that name | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.changed` | the seat changed before it closed; nothing relaunched | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.grant-another-pane` | the state records another pane for the granted seat | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.grant-approval` | a grant needs a verified approval | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.grant-caller` | only the seat the grant names runs this | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.grant-file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.grant-flag` | --file is the owner's; the granted seat cannot use it | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.grant-no-pane` | no pane is recorded for the granted seat | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.grant-omitted` | the file grants nothing | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.grant-scope` | the grant does not list reload | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.launch` | the close happened and the new launch did not reach ready | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.not-idle` | the seat is not at an idle prompt; nothing closed | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.not-running` | the seat has no ready pane to close | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.run-lock` | another session-mutating run is holding the session | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.self` | a reload does not close the caller's seat | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.unsent` | the seat holds unsent text; nothing closed | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.untested` | the installed CLI is outside its profile's tested range, so the relaunch's ready screen may not be recognised; nothing closed | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.working` | the seat is working; nothing closed | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `1` |
| `reload.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `2` |
| `reload.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `reload`; exit `2` |
| `remove.kept` | a stopped seat was kept | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `0` |
| `remove.removed` | the seat was removed | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `0` |
| `remove.swapped` | a lead seat was stopped for a swap; the file still names it | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `0` |
| `remove.temporary` | a temporary seat was removed | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `0` |
| `remove.abandon` | only the owner abandons a seat | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.agents` | the agents can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.ambiguous` | herdr lists more than one agent of this name | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.another-pane` | the state records another pane for the caller's seat | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.busy` | the seat is not free | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.caller` | the caller may not change the team | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.coordinator` | only the owner removes the orchestrator's or the operator's seat | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.default-session` | the session can't be "default" | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.delegate` | the caller is not the approved delegate | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.delegate-approval` | delegation needs a verified approval | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.delegate-command` | the approved delegate may not run remove | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.delegate-evidence` | the delegate's placement or seats can't be verified | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.delegate-flag` | the delegate may not use this flag | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.delegate-placement` | the approved delegate must be an external non-seat pane | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.file-owner` | --file is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.herdr` | herdr doesn't answer | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.keep-temporary` | a temporary seat is not kept in the file | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.never-approved` | the file was never approved | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.no-launch` | this call has no way to reach herdr | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.no-pane` | the state records no pane for the caller's seat | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.no-profile` | the running seat has no launch profile | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.no-seat` | the team has no such seat | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.run-lock` | another session-mutating run is holding the session | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.session-owner` | --session is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.stop-failed` | the seat could not be stopped | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.swap-grant` | no grant or delegate admits this caller's swap of a lead seat | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.swap-self` | a seat can't swap its own lead seat | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.unverified` | a name the file does not carry is left as it is | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `1` |
| `remove.edit` | the edit would not validate | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `2` |
| `remove.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `2` |
| `remove.file-invalid` | the team file can't be parsed | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `2` |
| `remove.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `2` |
| `remove.locked` | the locked edit does not validate | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `2` |
| `remove.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `remove`; exit `2` |
| `rename.done` | the seat was renamed (or --renumber planned/applied) | present at 0.5.0 | `contract/exit-codes.json` | command `rename`; exit `0` |
| `rename.refused` | the caller is not the owner or leads, the target seat exists, or the target clashes with a nickname | present at 0.5.0 | `contract/exit-codes.json` | command `rename`; exit `1` |
| `rename.invalid` | the team file or new seat name is invalid | present at 0.5.0 | `contract/exit-codes.json` | command `rename`; exit `2` |
| `rename.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `rename`; exit `2` |
| `restart.dry-run` | the stop and launch plan was printed and nothing was touched | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `0` |
| `restart.ready` | the seat was restarted in a new pane | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `0` |
| `restart.abandon-working` | a seat caller passed --abandon on a working seat | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.busy` | the seat is busy and --abandon was not given, or graceful stop did not close the pane | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.caller` | the caller may not restart a seat, or passed an owner-only flag | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.herdr` | herdr doesn't answer | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.lead` | a seat caller passed --abandon for the orchestrator's or the operator's seat | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.no-session` | the herdr session is not running | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.not-ready` | preflight or launch did not produce a ready seat | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.replaced` | the old pane holds a process that is not the seat's CLI | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.run-lock` | another session-mutating run is holding the session | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.self` | a seat caller tried to restart its own recorded pane | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.signed-off` | the seat is parked or stopped | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.temporary` | the seat is a temporary copy | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.unknown` | the seat is not a declared seat | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `1` |
| `restart.configuration` | the team file can't be read or parsed, or not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `2` |
| `restart.usage` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `restart`; exit `2` |
| `revoke.done` | the authority was removed or matched, the standing grant's revocation was appended or already named, or a write-free preview passed | present at 0.5.0 | `contract/exit-codes.json` | command `revoke`; exit `0` |
| `revoke.refused` | the caller is not the owner, the file changed during the edit, or the write failed | present at 0.5.0 | `contract/exit-codes.json` | command `revoke`; exit `1` |
| `revoke.invalid` | the team file, the named target or the proposed authority record is invalid or cannot be read | present at 0.5.0 | `contract/exit-codes.json` | command `revoke`; exit `2` |
| `revoke.invocation` | the command arguments are invalid | present at 0.5.0 | `contract/exit-codes.json` | command `revoke`; exit `2` |
| `route.dry-run` | the pair is admitted; the address is answered and nothing was written | present at 0.5.0 | `contract/exit-codes.json` | command `route`; exit `0` |
| `route.routed` | the pair is admitted and the recipient's address is answered and recorded | present at 0.5.0 | `contract/exit-codes.json` | command `route`; exit `0` |
| `route.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `route`; exit `1` |
| `route.refused` | no address was answered, on purpose | present at 0.5.0 | `contract/exit-codes.json` | command `route`; exit `1` |
| `route.unrecorded` | the pair is admitted and the route record could not be written | present at 0.5.0 | `contract/exit-codes.json` | command `route`; exit `1` |
| `route.configuration` | the team file cannot be read | present at 0.5.0 | `contract/exit-codes.json` | command `route`; exit `2` |
| `route.usage` | the invocation cannot be read | present at 0.5.0 | `contract/exit-codes.json` | command `route`; exit `2` |
| `seats.shown` | the seats table was printed | present at 0.5.0 | `contract/exit-codes.json` | command `seats`; exit `0` |
| `seats.file-owner` | --file is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `seats`; exit `1` |
| `seats.session-owner` | --session is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `seats`; exit `1` |
| `seats.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `seats`; exit `2` |
| `seats.file-invalid` | the team file can't be parsed | present at 0.5.0 | `contract/exit-codes.json` | command `seats`; exit `2` |
| `seats.herdr` | herdr doesn't answer | present at 0.5.0 | `contract/exit-codes.json` | command `seats`; exit `2` |
| `seats.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `seats`; exit `2` |
| `seats.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `seats`; exit `2` |
| `seats.not-yours` | the caller may not read this team | present at 0.5.0 | `contract/exit-codes.json` | command `seats`; exit `2` |
| `send.answered` | the seat's reply came back within the window | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `0` |
| `send.delivered` | the seat's channel took the message | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `0` |
| `send.dry-run` | the seat and channel were resolved and nothing was written | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `0` |
| `send.listed` | the addressable seats were printed, nothing was sent | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `0` |
| `send.record-dry-run` | a recorded native delivery was resolved and nothing was written | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `0` |
| `send.recorded` | a native delivery the sender made itself was written to the history | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `0` |
| `send.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `1` |
| `send.held` | the message is on disk and the pane was left untouched | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `1` |
| `send.not-submitted` | the trigger was typed and the seat never took it | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `1` |
| `send.refused` | nothing was sent, on purpose | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `1` |
| `send.stopped` | the seat is stopped in the team file | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `1` |
| `send.timeout` | sent on the socket, but no reply within the window | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `1` |
| `send.unreachable` | the seat was not reached | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `1` |
| `send.configuration` | the team file cannot be read, or the caller's folder is no team and a bare name has none to resolve in | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `2` |
| `send.usage` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `send`; exit `2` |
| `status.agrees` | the file, the state and the session agree | present at 0.5.0 | `contract/exit-codes.json` | command `status`; exit `0` |
| `status.project-listed` | the project's teams are listed | present at 0.5.0 | `contract/exit-codes.json` | command `status`; exit `0` |
| `status.difference` | there is a difference | present at 0.5.0 | `contract/exit-codes.json` | command `status`; exit `1` |
| `status.file-owner` | --file is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `status`; exit `1` |
| `status.project-unknown` | no project is named that | present at 0.5.0 | `contract/exit-codes.json` | command `status`; exit `1` |
| `status.session-owner` | --session is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `status`; exit `1` |
| `status.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `status`; exit `2` |
| `status.file-invalid` | the team file can't be parsed | present at 0.5.0 | `contract/exit-codes.json` | command `status`; exit `2` |
| `status.herdr` | herdr doesn't answer | present at 0.5.0 | `contract/exit-codes.json` | command `status`; exit `2` |
| `status.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `status`; exit `2` |
| `status.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `status`; exit `2` |
| `status.not-yours` | the caller may not read this team | present at 0.5.0 | `contract/exit-codes.json` | command `status`; exit `2` |
| `team.command-help` | a command's help was printed | present at 0.5.0 | `contract/exit-codes.json` | command `team`; exit `0` |
| `team.help` | help was printed | present at 0.5.0 | `contract/exit-codes.json` | command `team`; exit `0` |
| `team.version` | the version was printed | present at 0.5.0 | `contract/exit-codes.json` | command `team`; exit `0` |
| `team.command-threw` | a command threw | present at 0.5.0 | `contract/exit-codes.json` | command `team`; exit `1` |
| `team.approve-removed` | the approve command was removed in 0.5.0 | present at 0.5.0 | `contract/exit-codes.json` | command `team`; exit `2` |
| `team.no-command` | no command was given | present at 0.5.0 | `contract/exit-codes.json` | command `team`; exit `2` |
| `team.unknown` | the command is unknown | present at 0.5.0 | `contract/exit-codes.json` | command `team`; exit `2` |
| `tempo.set` | the tempo was written | present at 0.5.0 | `contract/exit-codes.json` | command `tempo`; exit `0` |
| `tempo.unchanged` | the tempo was already that word | present at 0.5.0 | `contract/exit-codes.json` | command `tempo`; exit `0` |
| `tempo.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `tempo`; exit `1` |
| `tempo.not-owner` | not the owner | present at 0.5.0 | `contract/exit-codes.json` | command `tempo`; exit `1` |
| `tempo.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `tempo`; exit `2` |
| `tempo.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `tempo`; exit `2` |
| `tempo.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `tempo`; exit `2` |
| `tempo.word` | the word is not a tempo | present at 0.5.0 | `contract/exit-codes.json` | command `tempo`; exit `2` |
| `unlock.released` | the lock was released | present at 0.5.0 | `contract/exit-codes.json` | command `unlock`; exit `0` |
| `unlock.io` | the lock directory could not be removed | present at 0.5.0 | `contract/exit-codes.json` | command `unlock`; exit `1` |
| `unlock.not-held` | the lock is not held | present at 0.5.0 | `contract/exit-codes.json` | command `unlock`; exit `1` |
| `unlock.not-yours` | the lock is held by someone else | present at 0.5.0 | `contract/exit-codes.json` | command `unlock`; exit `1` |
| `unlock.unknown-holder` | the lock's holder can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `unlock`; exit `1` |
| `unlock.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `unlock`; exit `2` |
| `unlock.project` | the caller's project can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `unlock`; exit `2` |
| `up.dry-run` | a dry run that reaches a refusal the real run would give before doing anything returns that refusal's status and exit id; a dry run that reaches its plan exits 0 and promises nothing about what happens after (the run lock, a launch, the watch) | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `0` |
| `up.ready` | the launch finished | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `0` |
| `up.agents` | the agents can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.clear` | a stopped session this team records did not clear | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.delegate` | only the owner or the approved delegate runs up | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.delegate-approval` | the delegate gate needs a verified approval | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.delegate-command` | the approved delegate may not run up | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.delegate-evidence` | the delegate gate can't verify its placement or seats | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.delegate-flag` | --session or --file is the owner's on a delegated run | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.delegate-placement` | the approved delegate must be an external non-seat pane | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.deny` | deny | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.doctor` | doctor refuses the launch | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.grant-another-pane` | the granted seat is not on its recorded pane | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.grant-approval` | a grant needs a verified approval | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.grant-caller` | only the seat the grant names runs this | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.grant-flag` | a granted seat cannot aim --session or --file | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.grant-no-pane` | no pane is recorded for the granted seat | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.grant-scope` | the grant does not list up | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.herdr` | herdr doesn't answer | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.lobby` | the lobby could not be created for the launch | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.machine` | the machine is over a launch limit | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.never-approved` | the file was never approved | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.no-launch` | this call has no way to reach herdr | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.not-owner` | deny | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.pending` | a seat was left short of ready | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.placement` | a seat has nowhere to start | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.run-lock` | another session-mutating run is holding the session | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.server` | the session's server did not start | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.stopped` | the session is stopped | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.unknown` | a running agent is not in this file's state | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.watch` | the watch did not start | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `1` |
| `up.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `2` |
| `up.file-invalid` | the team file can't be parsed | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `2` |
| `up.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `2` |
| `up.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `up`; exit `2` |
| `usage.block` | the machine's report printed | present at 0.5.0 | `contract/exit-codes.json` | command `usage`; exit `0` |
| `usage.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `usage`; exit `2` |
| `usage.store` | the store folder can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `usage`; exit `2` |
| `watch.started` | the watch started in its own workspace | present at 0.5.0 | `contract/exit-codes.json` | command `watch`; exit `0` |
| `watch.stopped` | the watch ran and stopped | present at 0.5.0 | `contract/exit-codes.json` | command `watch`; exit `0` |
| `watch.already` | a watch already runs | present at 0.5.0 | `contract/exit-codes.json` | command `watch`; exit `1` |
| `watch.caller` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `watch`; exit `1` |
| `watch.file-owner` | --file is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `watch`; exit `1` |
| `watch.no-notify` | a seat passed --no-notify | present at 0.5.0 | `contract/exit-codes.json` | command `watch`; exit `1` |
| `watch.no-nudge` | a seat passed --no-nudge | present at 0.5.0 | `contract/exit-codes.json` | command `watch`; exit `1` |
| `watch.watchdog` | only the recorded watch may read the file up recorded | present at 0.5.0 | `contract/exit-codes.json` | command `watch`; exit `1` |
| `watch.workspace` | the watch did not start in its workspace | present at 0.5.0 | `contract/exit-codes.json` | command `watch`; exit `1` |
| `watch.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `watch`; exit `2` |
| `watch.file-invalid` | the team file can't be parsed | present at 0.5.0 | `contract/exit-codes.json` | command `watch`; exit `2` |
| `watch.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `watch`; exit `2` |
| `watch.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `watch`; exit `2` |
| `worktree.created` | the worktree was created | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `0` |
| `worktree.listed` | the recorded worktrees were listed | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `0` |
| `worktree.record-gone` | the record was removed after the folder was already gone | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `0` |
| `worktree.removed` | the worktree was removed | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `0` |
| `worktree.another-pane` | the state records another pane for the caller's seat | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.base` | workspace.base is not a branch here | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.branch` | the branch already exists | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.branch-name` | the branch name is not valid | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.caller` | the caller may not change the team | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.config` | workspace.path and workspace.base are required | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.create-failed` | the worktree was not created | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.default-session` | the session can't be "default" | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.detached` | a run with no terminal | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.dirty` | the worktree has uncommitted files | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.elsewhere` | the worktree is recorded in another session | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.exists` | the worktree folder already exists | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.fetch` | the base couldn't be fetched | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.file-owner` | --file is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.forbidden` | a public project refuses that name | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.kind` | --kind is not a single segment | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.kind-nowhere` | --kind has nowhere to go | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.kind-required` | --kind is required | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.limit` | the worktree limit is reached | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.missing` | no worktree with that name is recorded | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.never-approved` | the standing approval record is legacy or cannot be verified | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.no-pane` | the state records no pane for the caller's seat | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.occupied` | a seat is recorded in the worktree | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.path-kind` | workspace.path must not contain {kind} | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.placeholder` | the branch or path pattern has an unknown placeholder | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.published` | the branch already exists on a remote | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.recorded` | the task is already recorded | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.recorded-elsewhere` | the task is recorded in another session | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.remove-branch` | the --branch given does not name the branch the worktree is on | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.remove-failed` | the worktree was not removed | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.remove-task` | the task name is not a single segment | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.seat` | --seat names no declared seat | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.session-owner` | --session is the owner's | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.setup` | setup failed | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.shared` | the workspace is shared | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.symlink` | the worktree follows a symlink outside the trust paths | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.task` | the task name is not a single segment | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.tracking` | the base tracks something that is not a remote branch | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.trust` | the worktree is outside the file's trust paths | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.unpublished` | the worktree has commits on no remote branch | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.unreadable` | the worktree couldn't be read | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `1` |
| `worktree.branch-flags` | new and list take no --branch | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `2` |
| `worktree.extra` | an unexpected argument was given | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `2` |
| `worktree.file` | the team file can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `2` |
| `worktree.file-invalid` | the team file can't be parsed | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `2` |
| `worktree.invocation` | the invocation can't be read | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `2` |
| `worktree.not-a-repo` | not inside a git repository | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `2` |
| `worktree.remove-flags` | remove takes no --kind or --seat | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `2` |
| `worktree.subcommand` | a subcommand is required | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `2` |
| `worktree.task-required` | a task name is required | present at 0.5.0 | `contract/exit-codes.json` | command `worktree`; exit `2` |

All 569 contract entries are retained in source order, including success and refusal variants sharing a numeric status. No identifier is inferred from a wildcard contribution. Proof: `exit-codes:check`, `test/exit-codes.test.ts`; rendered reference `docs/reference/exit-codes.md`. This fully expands the task, grant, registry, watch, lock, release and worktree contributions.

**Not at v0.5.0; present at int/0.5.1 8acb470b, unreleased:**

| Entry | Meaning | Since | Source at the tag | Note |
|---|---|---|---|---|
| `add.human` | the named seat is a human's pane | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `add`; exit `1` |
| `answer.human` | the seat is a human's pane; no dialog key is pressed and no rules line is typed | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `answer`; exit `1` |
| `bus.started` | the bus started and served on .agents/bus.sock | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `bus`; exit `0` |
| `bus.stopped` | the bus served until it was stopped | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `bus`; exit `0` |
| `bus.refused` | the caller is not the owner at a terminal outside herdr, a bus is already running or starting, or the socket could not be bound | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `bus`; exit `1` |
| `bus.configuration` | not inside a git repository or the team file cannot be read | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `bus`; exit `2` |
| `bus.usage` | the invocation cannot be read | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `bus`; exit `2` |
| `drops.ok` | the caller's unread drops were listed, or followed until it stopped | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `drops`; exit `0` |
| `drops.file` | the team file can't be read | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `drops`; exit `1` |
| `drops.refused` | the caller is not a placed seat of this team | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `drops`; exit `1` |
| `drops.unreadable` | the drop folder can't be read | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `drops`; exit `1` |
| `drops.invocation` | the invocation can't be read | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `drops`; exit `2` |
| `drops.not-a-repo` | not inside a git repository | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `drops`; exit `2` |
| `mcp.serve-ended` | the inbox server's stdin closed and it stopped cleanly | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `mcp`; exit `0` |
| `mcp.serve-refused` | the inbox server can't start: the invocation, the team placement or its inbox folder can't be read | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `mcp`; exit `2` |
| `raise.dry-run` | the route the raise would take; nothing was written | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `raise`; exit `0` |
| `raise.merged` | the line was merged into the owner's open record, and the record counts it | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `raise`; exit `0` |
| `raise.raised` | the line reached the owner's mailbox as a signed record, and the owner was notified | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `raise`; exit `0` |
| `raise.capped` | ten raises have reached the owner today | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `raise`; exit `1` |
| `raise.io` | the event log or the owner's record can't be read or written | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `raise`; exit `1` |
| `raise.refused` | not the orchestrator's seat or a lead's | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `raise`; exit `1` |
| `raise.file` | the team file can't be read | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `raise`; exit `2` |
| `raise.usage` | the invocation can't be read | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `raise`; exit `2` |
| `reload.human` | the seat is a human's pane; nothing is closed, typed into or launched over it | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `reload`; exit `1` |
| `reply.replied` | the reply record was written on its thread, or its thread was closed | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `reply`; exit `0` |
| `reply.refused` | the record can't be answered, the thread can't be closed, or the call is not the owner or a seat of the team | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `reply`; exit `1` |
| `reply.configuration` | the team file can't be read | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `reply`; exit `2` |
| `reply.usage` | the invocation can't be read | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `reply`; exit `2` |
| `send.confirmed` | a native handoff was recorded to the history and its pending record cleared | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `send`; exit `0` |
| `send.native` | a native handoff was printed for the sender's own SendMessage, and nothing was delivered | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `send`; exit `0` |
| `send.sent-unconfirmed` | the record is written and left in the seat's own folder — its inbox on the mcp-inbox leg, its drop folder on the drop leg — and no signed read receipt has come back | 0.5.1 unreleased | `contract/exit-codes.json` at int/0.5.1 8acb470b | command `send`; exit `0` |

The integration supplement preserves 31 additional ids; baseline rows keep the release-tag behavior even if the integration implementation changes their meaning.

Contributions reconciled at this draft: accounts and gates, budgets, events, grants, launch, messaging, quality gates, records and ledger, RFC process files (no entries), registry, roles, round, seat state and watch, tasks and broker. The Kernel’s §12 points to the same records/ledger contribution rows. All list-valued contributions were expanded against their pinned code source; feature settings outside the release catalogue remain planned.

## Revision log

- **Draft** (2026-10-18): read the pinned source lists and consolidated completed spec contributions; planned entries remain distinct.
