# team workflow

Checks, dry-runs, or replays a workflow definition (`version: 1`):
- `team workflow check <path> [--json]` checks one workflow definition and its transition graph:
  structural schema rules, reachability, transition ordering and ambiguity, hook effects, and
  resolved role references (`owner`, `lead`, `integrator`, and the `role:` strings declared on seats
  in `.agents/team.yaml`, read from the working directory first and from `<path>`'s folder when the
  working directory has no team file). Transition `on:` entries accept the twelve transition signals
  (`pr-opened`, `pr-merged`, `sha-verified`, `gate-passed`, `approved`, `tag-outcome`,
  `publish-outcome`, `deploy-outcome`, `time-reached`, `goals-set`, `diverged`, `accepted`).
- `team workflow run <path> --dry --script <path> [--json]` executes a pure in-memory dry run of the
  workflow definition against a deterministic `format: 1` dry script and emits the non-authoritative
  `DryRunJournal` (`kind: "workflow-run-dry"`, `authoritative: false`,
  `notice: "dry run — no record is written"`). Calling `team workflow run <path>` without `--dry` is
  refused (`workflow.dry-only`, exit 1) naming the Kernel workflow gate (amendment 04).
- `team workflow replay <definition> <journal> --evidence <path> [--json]` re-evaluates a recorded
  `DryRunJournal` against the pinned workflow definition and a standalone `EvidenceDocument` file
  (`ref -> fixture` mapping in JSON or YAML), checking the definition digest and comparing every
  step and terminal stop to the pure reducer.

Read-only: nothing writes to disk or any ledger, and no terminal host session is needed.

## Synopsis

    team workflow check <path> [--json]
    team workflow run <path> --dry --script <path> [--json]
    team workflow replay <definition> <journal> --evidence <path> [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `<path>` | a workflow file | the workflow definition (`version: 1`) to check or dry-run |
| `<definition>` | a workflow file | the workflow definition (`version: 1`) to replay against |
| `<journal>` | a dry-run journal file | the `DryRunJournal` JSON file (`run --dry --json` stdout) to replay |
| `--dry` | — | required for `run`: executes the workflow in pure in-memory dry mode; omitted `--dry` is refused (`workflow.dry-only`, exit 1) |
| `--script <path>` | a dry-run script file | required for `run --dry`: the `format: 1` YAML script supplying `target`, `artifact`, `inputs`, `settings`, `evidence`, and `signals` |
| `--evidence <path>` | an evidence file | required for `replay`: the standalone `EvidenceDocument` (`ref -> fixture` mapping in JSON or YAML) |
| `--json` | — | for `check`, the `team.workflow` check report; for `run --dry`, the bare `DryRunJournal` document on stdout (`workflow.run-dry` exit 0 or stopped `workflow.refused` exit 1); for `replay`, the `team.workflow` (`kind: "workflow-replay"`) document on stdout; pre-journal refusals and exit-2 failures write the `team.error` document on stdout |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| anyone — a seat, an agent-run CLI, CI, or the owner, from any folder | run `check`, `run --dry`, or `replay`: none of them needs a terminal host session or a terminal |

## Output and exit codes

| Subcommand | Outcome | What is printed | Exit |
| --- | --- | --- | --- |
| `check` | the workflow passes with no refusals (`workflow.check.passed`) | any `note:` lines (`graph.orphan`, provisional `ref.operation`), then `team workflow check: <path>: ok` (or `ok (<n> notes)`) | 0 |
| `check` | at least one finding is a refusal (`workflow.check.refused`) | one `refusal:` or `note:` line per finding (sorted by `line`, then `code`), then `team workflow check: <path>: <n> refusals: refused` | 1 |
| `check` | bad invocation, unreadable file, or invalid YAML (`workflow.check.invocation`, `workflow.check.file`, `workflow.check.file-invalid`) | `team workflow check: <reason>`, with the usage for a bad invocation | 2 |
| `run` | the dry run exhausts the script without a stop (`workflow.run-dry`) | `dry run — no record is written`, `run:`, `start:`, each `step <n>:`, and `team workflow run: <path>: script-exhausted (...)` (or the `DryRunJournal` under `--json`) | 0 |
| `run` | `run` invoked without `--dry` (`workflow.dry-only`) | `dry run — no record is written` and `team workflow run: live workflow execution requires the Kernel workflow gate (amendment 04); pass --dry --script <path> for a dry run` on stderr | 1 |
| `run` | the dry run stops on a held or refused decision or reachable `uses:` (`workflow.refused`) | `dry run — no record is written`, steps up to the stop, `stop:`, and `team workflow run: <path>: stopped (...)` (or the `DryRunJournal` under `--json`) | 1 |
| `run` | malformed `--script` (`workflow.script`) or malformed script `evidence:` block (`workflow.evidence`) | `dry run — no record is written` and `team workflow run: <script>: <reason>` on stderr | 1 |
| `run` | bad invocation (`workflow.invocation`) or unreadable/invalid workflow or script file (`workflow.file`) | `dry run — no record is written` and `team workflow run: <reason>` on stderr, with the usage for a bad invocation | 2 |
| `replay` | the journal replays identically (`workflow.replay`) | `dry run — no record is written` and `team workflow replay: <journal>: ok (...)` (or the `workflow-replay` document with `ok: true` under `--json`) | 0 |
| `replay` | step divergence (`workflow.replay-mismatch`), bad journal (`workflow.journal`), bad/mismatched definition (`workflow.definition`), or bad/missing evidence (`workflow.evidence`) | `dry run — no record is written` and `team workflow replay: <journal>: [<code>] <why>: refused` (or the `workflow-replay` document with `ok: false` and `reason` under `--json`) | 1 |
| `replay` | bad invocation (`workflow.invocation`) or unreadable input file (`workflow.file`) | `dry run — no record is written` and `team workflow replay: <reason>` on stderr, with the usage for a bad invocation | 2 |

Under `--json`:
- `check` writes the `team.workflow` check document (`schema/workflow.schema.json`) on exit 0 or 1, and `team.error` on exit 2.
- `run --dry` writes the bare `DryRunJournal` (`format: 1`, `kind: "workflow-run-dry"`, `authoritative: false`, `notice: "dry run — no record is written"`) on exit 0 (`workflow.run-dry`) and exit 1 (`workflow.refused`), so its stdout can be passed directly to `team workflow replay`; pre-journal refusals (`workflow.dry-only`, `workflow.script`, `workflow.evidence`, `workflow.invocation`, `workflow.file`) write `team.error` with `notice: "dry run — no record is written"`.
- a stopped outcome records the stopped request's own effective `expectedRevision` (`0` or more), including a stale value the core refused, and replay re-evaluates that request unchanged, so the producer's own journal replays to the same refusal. A request-derived stop (one naming a `signal` and a `requestId`) without the field is refused as `workflow.journal` rather than replayed under the folded revision; a request-less stop (the reachable `uses:` refusal) carries none. The journal `format` stays 1; this contract is unpublished, so no older journal shape is kept.
- `replay` writes the `team.workflow` replay document (`kind: "workflow-replay"`, `authoritative: false`, `notice: "dry run — no record is written"`, `ok: true | false`) on exit 0 and exit 1, and `team.error` with `notice: "dry run — no record is written"` on exit 2.

The three code families stay distinct:
- **CLI exit ids** (`workflow.check.*`, `workflow.run-dry`, `workflow.dry-only`, `workflow.refused`,
  `workflow.script`, `workflow.evidence`, `workflow.replay`, `workflow.replay-mismatch`,
  `workflow.journal`, `workflow.definition`, `workflow.invocation`, `workflow.file`) are the
  command's rows in `contract/exit-codes.json`.
- **Finding codes** (`schema.*`, `graph.*`, `ref.*`, `vocab.*`, `annotation.*`) are line-numbered
  parse and whole-graph `Finding` codes in `findings[]` (`src/workflow/schema.ts` and
  `src/workflow/check.ts`); they are never folded into CLI exit ids.
- **Decision codes** (`src/workflow/codes.ts`) are the runtime transition and effect evaluation
  codes for workflow runs and replays.

## Example

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

identity:
  humans: [jane@acme.example]

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

workspace:
  mode: shared

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: builder
    name: claude-beacon
    label: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
```

A workflow definition whose transitions and seat roles resolve cleanly:

```yaml file=workflow.yaml
workflow: review-pass
version: 1
initial: draft
states:
  draft: {}
  complete: {}
transitions:
  - from: draft
    to: complete
    on: pr-opened
    role: builder
```

```console
$ team workflow check workflow.yaml ; echo "exit $?"
team workflow check: workflow.yaml: ok
exit 0
```

A workflow with an unknown target state and an unknown role:

```yaml file=broken.yaml
workflow: broken-pass
version: 1
initial: draft
states:
  draft: {}
  complete: {}
transitions:
  - from: draft
    to: missing
    on: pr-opened
    role: ghost
```

```console
$ team workflow check broken.yaml ; echo "exit $?"
note: broken.yaml:6: [graph.orphan] state "complete" is not entered by any initial, on trigger or transition
refusal: broken.yaml:8: [graph.transition] transition from "draft" to "missing" names undeclared state "missing"
refusal: broken.yaml:11: [ref.role] role "ghost" is not known
team workflow check: broken.yaml: 2 refusals, 1 note: refused
exit 1
```
