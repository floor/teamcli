# Remove `team approve`

Read from `origin/main` at `2ba5f1d68224e2b6d9e3fc2f70878bb1bde78921`. Concurrent launch is not on that commit. It is the open change on `feat/parallel-launch` (pull request 378): `launchConcurrency` in `src/watch/machine.ts` and the window in `src/launch/execute.ts`. This change does not reimplement that window. The scene below is written only after that change is in this branch.

## What `up` reads

The grants are the live default team file, the one `loadTeamFile` already reads for this directory. No `--file`, no store.

- `grant` (`src/file/sections/grant.ts`): `session` is the file's session, `seat` is the orchestrator, `scope` includes `up`. Omitted means no grant.
- `delegates` (`src/file/sections/delegate.ts`): an entry whose pane is the caller and whose `commands` include `up`.

A later standing grant, recorded outside the file, is not this change. Nothing here reads or writes one.

`approve` stays a recognized word in `grant.scope` and in a delegates command list, so a file that already names it still parses. No command consults it.

## Who is calling

The same placement `up` already uses.

- The owner at a terminal outside herdr (`mayLaunchSeats`) launches as today. No grant is required.
- A run with no terminal outside herdr (`detachedRefusal`) keeps today's sentence and returns before the grant question.
- Anyone else is placed with `callerOf` in the file's session. A grant passes when `callerVerdict` is `ok` for `grant.seat` against `standingOf`: that seat's name, that session, and the pane the state records. A delegate passes when `delegateGate`'s `findEntry` matches and the entry lists `up`. Prohibited flags (`--session`, `--file`) stay their own refusals.

The check reads the file and the state. It does not verify a signature, open `approval.json`, or wait on a CLI.

## Deny

A caller who is neither the owner at a terminal nor admitted by `grant` or `delegates` gets one reply. Stderr is the four characters `deny` and a newline. Stdout is empty. The exit is 1, id `up.deny`, one return. A dry run of that caller is the same reply and prints no plan. Nothing is written and nothing is launched.

Misses that today print a sentence (`up.not-owner`, `up.grant-caller`, `up.grant-scope`, `up.grant-no-pane`, `up.grant-another-pane`, `up.grant-approval`, `up.grant-approved-copy`, `up.grant-drift`, `up.delegate`, `up.delegate-approval`, `up.delegate-approved-copy`, `up.delegate-drift`, `up.delegate-command`, `up.never-approved`, `up.differs`) collapse into that one reply. The reason is not said.

These stay, with their sentences and exit ids: a bad invocation, a file that does not parse, herdr not answering, the machine limit, a doctor finding that is not an approval miss, a stopped session, a prohibited flag, and the detached sentence.

## The approval record

`team approve` is deleted: the command module, its row in `src/cli.ts`, `contract/cli.json`, `docs/commands/approve.md`, and the reference pages that list it. `writeApproval` (`src/store/store.ts`) is what writes `approval.json` and `approved.yaml`. After this change nothing calls it. `recordSeatDigestOf` is not called from `add` or `remove`. Existing store files are left on disk and are not a gate. `list` may still open an old `approval.json` to name a project; that read decides nothing.

`up`, `add`, `remove`, and `down` work with no record. `add` and `remove` edit the live file only. `down` keeps the caller rule it has (owner, orchestrator, operator, delegate, or the live grant) and does not say `deny`. `delegateGate` and `grantGate` drop the standing, approved-copy, and drift steps. Membership and prohibited flags stay. No command gains a grant check it does not already have. The owner-token match is dropped with the fingerprint it compared; there is no replacement token.

Every other reader stops refusing because a record is missing, and stops telling anyone to run the deleted command. Where it acted on the approved copy, it acts on the live file:

| Caller | What changes |
| --- | --- |
| `doctor` | The "never approved" and "file differs" misses go away. Version and model repairs no longer say to approve. |
| `watch` | No approval gate today. The swap-total sentence in `src/watch/machine.ts` loses the approve clause. |
| `status`, `usage`, `budgets` | Read the live file. No repair that names the deleted command. |
| `answer`, `worktree`, `init` | The same. `init`'s hint no longer says to approve. |
| `rules-file`, profile overrides, the launch model sentence | A missing record does not block delivery or the launch. |
| `worktree/place.ts` | The trust repair no longer says to approve. |

`team trust` is unchanged, and the generated rule still forbids editing `trust:`.

## Contract and docs

`contract/exit-codes.json` drops every `approve.*` row and the ids that collapsed into `up.deny`. It gains one row: command `up`, code 1, id `up.deny`, meaning `deny`. The same edit regenerates `docs/reference/exit-codes.md`. `add.never-approved`, `remove.never-approved`, and `down.never-approved` go. Docs, the README command index, and any sentence that names `team approve` are updated in the same change. `CHANGELOG.md` is not touched.

## Tests

Two direct tests, with no approval record in the scratch home. Allow: the caller is the grant seat, on the recorded pane, `scope` includes `up`, and a dry run prints the plan. Deny: another seat, stderr exactly `deny\n`, exit 1, the file unchanged. A third allows a delegates pane whose commands include `up`. `add`, `remove`, and `down` keep a test each that runs with no record.

## Five seats, no owner terminal

The target is a team of five in `~/Code/acme/v4`: one orchestrator, two builders, two testers, mounted and ready for a first brief in 30 seconds, with no owner at a terminal. The test uses a scratch copy of that shape, not that folder. The caller is the orchestrator seat named by `grant`, placed in the file's session, stdin not a terminal.

No prompt on that path:

- Approval. The command is gone. `up` does not ask, and it does not wait on a record.
- Lobby. `lobbyPretrustLine` (`src/launch/pretrust.ts`) writes the CLI's trust record before the workspace exists. A failed write still sets today's repair and skips that seat. This change does not add an answerer.
- Trust and permission on the seat's screen. A granted seat is not the owner, so `dialog` is already `close-no-terminal` (`src/commands/up.ts`): `runPause` is not built and no `o`/`s`/`q` line is written. The happy path never draws the dialog, because the trust record is written first and the launch line keeps the profile's unattended flags (`--always-approve` on grok). A dialog that still appears is closed with no key, as today. This change does not start answering one.

Ready means each seat's state is `stage: ready` and the fake screen is idle. A brief is `team send` into that seat. `send` does not read an approval record.

The budget is the 30 seconds, on a machine whose reading makes `launchConcurrency` at least 5. A tighter machine stays at 1, which is that function's existing fallback; this change does not override it.

| Step | Budget |
| --- | --- |
| Read the file, place the caller, match `grant` or `delegates` | 1s |
| File, herdr, machine, and doctor findings that are not an approval | 2s |
| Five lobby trust records, before any pane | 1s |
| Launch five seats in the parallel window: workspace, CLI, idle | 22s |
| Name each seat and mark it ready. Grok rules ride the launch line, so nothing is typed into the box | 4s |

The scene uses the fake CLI host. It asserts: `runPause` is not called; no trust, permission, or approval text is drawn; classify goes from unknown to idle; no workspace is closed for a dialog; the fifth launch starts before the first seat is marked idle; all five end `ready`; a one-line send to one of them is accepted; the scratch home has no `approval.json` before or after. The scene does not assert a wall clock. The fakes return immediately. The 30 seconds is the production budget above.
