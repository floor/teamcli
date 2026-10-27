# The entity's model rule and the queued swap

Read at 0.5.2. The sources are the owner's model-rule and swap decisions of 2026-10-18 and
2026-10-19; Runtime commitments 40 and 41; Planning commitment 27;
Policies rules 10 and 11; and the swap frictions recorded on 2026-10-19.

At that commit the tool has the four-level signed policy system
(`src/policy/types.ts`, `src/policy/sources.ts`, `src/policy/resolve.ts`), the watch and its
checks (`src/watch/`), the restart path (`src/commands/restart.ts`), the session registry
(`src/sessions/registry.ts`), task leases (`src/tasks/lease.ts`) and the model-drift check.
It has no model rule, no queue and no swap.

## The rule is a policy

`model-rule` is an enforced policy in the closed catalogue. Its only level is `entity`: a
project, team or seat that tries to set it is refused by the same `levels` check every other
name uses, and the write is owner-only, signed and stored in `entities.yaml` like the rest
(amendment 02 §2.2, §2.6). Its default is `''`, no rule in force.

The value is one or more entries separated by `;`:

    orchestrator=anthropic; architect=anthropic; *=!anthropic

- An entry is `<subject>=<labs>`. The subject is a seat name, a role word (the file's
  `role:`), or `*`. A seat name wins over a role, and a role wins over `*`; a subject named
  twice is refused, so the entry for the most specific subject is the one that decides. A
  seat no entry names is allowed.
- The labs are `+`-joined vendor words exactly as a seat writes `vendor:` (`anthropic`,
  `openai`, `google`, `deepseek`, `moonshot`, `zhipu`, `meta`, `xai`, …). A plain list means
  the seat must run one of those labs; a single `!lab` (or a list of `!lab`s) means it must
  run none of them. Mixing plain and negated words in one entry is refused.
- A malformed value is the catalogue's `policy.invalid`, naming the entry that is wrong.

The rule is read from the entity policy source (`readEntityPolicySource`) through the normal
resolver, so an expired declaration is unset and an unreadable or badly signed source is
reported, never silently ignored.

`swap-wait-seconds` is the second enforced name (Policies rule 11, amendment §2.14). It is a
positive whole number of seconds, default `1800` (30 minutes, the proposed value), settable at
entity, project, team and seat as a normal tighten-only setting: a shorter wait is the tighter
one, as every other seconds policy reads it, and the settings surface resolves the same chain
(`src/settings/inherit.ts`).

## Finding breaches and proposing replacements

A breach is a **file declaration**: a seat whose `vendor` does not satisfy the rule for its
name, role and team. The screen's own contradiction of the file is already the model-drift
check; this rule never double-reports it.

The entity's teams are the records in `teams.yaml` whose `entity` is the rule's entity, plus
the current team when its own file declares that entity. Each team's live file is read from
its record's root with `loadTeamFile`, and a team file that cannot be read is named, not
skipped silently.

A replacement is proposed, never invented:

- A **donor recipe** is the model fields (`cli`, `vendor`, `model`, `version`, `display`,
  `launch`, `model_from`, and `effort` when it has one) of a seat already running in the
  entity's teams. The target keeps everything else — its role, name, nickname, cwd,
  workspace, `human`, `parked` — and takes the donor's model fields only.
- Donors from the **same team** come first, and a donor on the **same CLI** comes first
  within that: a same-CLI swap is the one the tool can try to resume.
- Then donors from other teams of the entity with the **same visibility**. A `public` team
  never draws a recipe from a `private` one.
- A recipe that would itself break the rule for the target seat is skipped. The proposal
  keeps the target's own `account:` when it equals the new vendor, and otherwise the new
  vendor becomes the account, exactly as the file reads an absent `account:` — a proposal
  never widens an account, a grant or a team's visibility.
- When no recipe is available the breach is reported with no proposal, and nothing is
  queued.

The listing (`team swap --rule`) is read-only: it shows every breaching seat of the entity,
its team, its role, and the proposed recipe with the donor it came from.

## The queue

A queued swap is a project record, not a session's: it outlives `down` and `up` the way the
hold and the pause do. It is stored at the top level of `team.state.json`:

    swaps: { "<seat>": { from, to, reason, rule?, queuedAt, deadline, waitFor,
                         handover?, forced? } }

`from` and `to` hold `cli`, `vendor`, `model`, `version`; `to` also holds `launch`,
`model_from` and `effort` when the recipe has them. `reason` is `model-rule`, `config` (the
same queue serves a `team settings` model or effort change) or `owner`.
The record is cleaned at the state read door like every other outside value.

`team swap` is the command family:

- `team swap` — what this team waits on: queued swaps, with what each waits for.
- `team swap --rule` — the entity-wide breach listing and proposals, read-only.
- `team swap queue <seat> [--to <cli>:<model>]` — queue a swap. The owner, or this team's
  lead; the rule's own breaching seats are queued by the watch without a caller.
- `team swap now <seat>` — the owner forces a swap at once; the force is logged.
- `team swap cancel <seat>` — the owner or this team's lead.
- `team swap --run` — perform the due swaps of this team now (owner or lead), for a team
  whose watch is not running.

`team status` shows each queued swap and what it waits for. `team next` refuses to claim a
task for a seat that waits on a swap, and the watch sends it no work — typed or pushed — so the
seat takes no new task while the swap waits.

## The boundary, the wait and the run

The watch marks the boundary itself, from what it observes, never from the agent's word:
the seat is quiet, not working, not at a prompt or dialog, holds no task lease, and no work
drop waits for it. A done report is an input the workflow records, but the observation is
the mark: a seat that says it is done and is still working does not swap.

- A **broken seat** swaps at once: its screen is at the CLI's rate limit or provider error
  (the two states `provider-error` already reads), because it cannot finish its task.
- Otherwise the swap waits for the boundary. After `swap-wait-seconds` the swap runs at the
  next pass with no turn running, no dialog and no unsent text in the input box
  (`!working && !prompt && !unsent`); text nobody sent is a retry, never a boundary or a
  pause, and the log says the deadline forced it — a lead that is never idle cannot hold it
  forever.
- `team swap now` runs at once, logs who forced it and when.
- The same queue is drained by `team swap --run`, so a team with no watch is not stuck.

The run, one seat at a time, is the restart path's own sequence: inspect (a replaced pane,
a busy turn or unsent text is a retry, never a fight), stop, record the session end with
reason `swap`, install the hooks, write the general brief, launch from the file's new
declaration, wait for ready. The shared pieces of `runRestart` move into a `performRestart`
function the command and the swap both call, so there is one launch sequence in the tool.

**Resume or handover.** When the CLI is unchanged and the profile says the CLI keeps its
sessions (`supportsSessionResume`, today Claude Code, Codex and Antigravity), the launch line is given the recorded
session id to resume, and the old conversation is tried on the new model. The log records
the attempt and what the screen showed; lossless resumption is not an observed fact.
When the CLI changes — or the CLI cannot resume, where a fresh
conversation would lose the context anyway — the seat is first asked for a handover file at
a path the tool names, as the last step of its task, and the file is passed to the new
conversation; a handover not written before the bounded wait is logged, and the run goes on.
A broken seat is not asked: its screen cannot answer, and its swap runs at once.

**Read-back.** After ready the screen is read again. A model the profile can show is
compared with the new declaration (`modelDiffers`), and a mismatch is a failed swap, reported
and logged — the queue record stands and no log line says the swap succeeded. A model the
profile cannot show is looked for in the CLI's own model-id line (the
`· API Usage Billing` banner a launch-wrapper pane draws, captured in
`test/fixtures/nudge-typing/`); the id is compared by its normalized words with the id the
donor seat shows the same way. When neither reading exists the log says `read-back: unread`
and never claims the swap verified.

The steps done by hand on 2026-10-19 are the shared restart path's and remain so for a swap:
unsent text (the typed-leg paste-back, once it lands), the folder-trust prompt (the launch's
trust answer), the owner-only lead restart (the rule in force is the owner's authorization
for a rule-driven swap; a lead-requested `queue` still passes the caller gate), and the new
session registered as the seat's agent through the same address refresh `restart` uses. A
pane a lead opened by hand that breaks the rule is reported to its lead and to `team check`,
and never closed.

## Checks

- `model-rule` is a watch seat check: a breaching declared seat reports once, naming the
  rule, the seat's vendor and the proposal or the reason there is none. It runs always on,
  like model-drift.
- The same breach list is a `team check` difference for the team it runs in.
- A pane outside the team file whose screen names a model of a lab the rule forbids for an
  unclaimed seat is reported by the extra-pane check, to the operator and the lead, and
  never closed. Only a model the profile can read is judged; an unread pane
  stays the existing "extra" report.

## Scope

In this release: the two policy names, the grammar, entity discovery, the breach listing and
proposals, the queue record, the swap command and its exit ids, the status and next surfaces,
the watch check and the rule check in `team check`, the executor and its read-back.

Shared surfaces this feature touches that a related 0.5.3 change may also touch:
`src/policy/types.ts` (catalogue rows), `src/settings/inherit.ts` (the settings spec),
`src/state.ts` (the top-level record), `src/cli.ts`, `contract/cli.json`,
`contract/exit-codes.json`, and the generated reference pages.

Out of this release: `team cast` (Planning commitment 27's casting, its own feature), the
`team config` / `team settings` / `team seat` family (a separate feature family; the queue
already accepts `reason: config`), and the typed-leg paste-back, which the restart path
inherits when it lands.
