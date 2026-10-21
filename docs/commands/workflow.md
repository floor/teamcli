# team workflow check

Checks one workflow definition (`version: 1`) and its transition graph: structural schema rules,
reachability, transition ordering and ambiguity, hook effects, and resolved role references
(`owner`, `lead`, `integrator`, and the `role:` strings declared on seats in `.agents/team.yaml`,
read from the working directory first and from `<path>`'s folder when the working directory has no
team file). Transition `on:` entries accept the twelve transition signals (`pr-opened`,
`pr-merged`, `sha-verified`, `gate-passed`, `approved`, `tag-outcome`, `publish-outcome`,
`deploy-outcome`, `time-reached`, `goals-set`, `diverged`, `accepted`).
Read-only: nothing writes, and no herdr session is needed.

## Synopsis

    team workflow check <path> [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `<path>` | a workflow file | the workflow definition (`version: 1`) to parse and validate |
| `--json` | — | the report as the `team.workflow` document (`schema/workflow.schema.json`); an invocation or file-read error as the `team.error` document on stdout |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| anyone — a seat, an agent-run CLI, CI, or the owner, from any folder | run it: it needs no herdr session and no terminal |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the workflow passes with no refusals | any `note:` lines (`graph.orphan`, provisional `ref.operation`), then `team workflow check: <path>: ok` (or `ok (<n> notes)`) | 0 |
| at least one finding is a refusal | one `refusal:` or `note:` line per finding (sorted by `line`, then `code`), then `team workflow check: <path>: <n> refusals: refused` | 1 |
| the check can't run: a bad invocation, an unreadable file, or invalid YAML | `team workflow check: <reason>`, with the usage for a bad invocation | 2 |

Under `--json` the report is the `team.workflow` document (`schema/workflow.schema.json`), and an
invocation, unreadable-file, or YAML-syntax failure writes the `team.error` document on stdout with
its `contract/exit-codes.json` id; stderr stays empty.

The three code families stay distinct:
- **CLI exit ids** (`workflow.check.passed`, `workflow.check.refused`, `workflow.check.invocation`,
  `workflow.check.file`, `workflow.check.file-invalid`) are the command's rows in
  `contract/exit-codes.json` (and `error.id` in `team.error` on exit 2).
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
