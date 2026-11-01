// The workflow MVP's one built-in definition: `work-item`, the published YAML of the WF0 schema
// (workflow-mvp-spec-draft-4 §2.1, docs dbdec48). Seventeen states, sixty-three transitions,
// fifteen `lead-stop`; the deadlines are the daemon's timer records, never state waits. The text
// is the spec's verbatim, so `team workflow check` reads the same bytes the two check measurements
// ran on. Nothing here writes, dispatches or activates a run.

import { parseWorkflow } from '../schema.ts';
import type { DefinitionId, Workflow } from '../types.ts';

export const WORK_ITEM_NAME = 'work-item';

/** The published definition, verbatim; SHA-256 648bb634c552a5b72384c6c827bd6ddd4b92700534459cb44148a59cd240b844. */
export const WORK_ITEM_YAML = `workflow: work-item
version: 1
initial: ready
error: failed
inputs:
  - item-key
  - title
  - description
  - repository
  - base-branch
  - role-sequence
  - model
  - assignee
states:
  ready: {}
  dispatching:
    on-enter:
      - dispatch-builder
  building: {}
  building-pending:
    on-enter:
      - dispatch-builder
  testing: {}
  testing-pending:
    on-enter:
      - dispatch-tester
  merging: {}
  installing: {}
  installing-pending:
    on-enter:
      - dispatch-integrator
  installed: {}
  done: {}
  failed: {}
  blocked-dispatching: {}
  blocked-building: {}
  blocked-testing: {}
  blocked-merging: {}
  blocked-installing: {}
transitions:
  - from: ready
    to: dispatching
    on: task-ready
    role: daemon
  - from: ready
    to: failed
    on: lead-stop
    role: lead
  - from: dispatching
    to: building
    on: acknowledged
    role: builder
  - from: dispatching
    to: dispatching
    on: redispatch
    role: daemon
  - from: dispatching
    to: failed
    on: step-failed
    role: daemon
  - from: dispatching
    to: blocked-dispatching
    on: seat-down
    role: daemon
  - from: dispatching
    to: failed
    on: lead-stop
    role: lead
  - from: building
    to: testing-pending
    on: step-done
    role: builder
  - from: building
    to: building-pending
    on: redispatch
    role: daemon
  - from: building
    to: failed
    on: step-failed
    role: daemon
  - from: building
    to: blocked-building
    on: step-blocked
    role: builder
  - from: building
    to: blocked-building
    on: seat-down
    role: daemon
  - from: building
    to: failed
    on: lead-stop
    role: lead
  - from: building-pending
    to: building
    on: acknowledged
    role: builder
  - from: building-pending
    to: building-pending
    on: redispatch
    role: daemon
  - from: building-pending
    to: failed
    on: step-failed
    role: daemon
  - from: building-pending
    to: blocked-building
    on: seat-down
    role: daemon
  - from: building-pending
    to: failed
    on: lead-stop
    role: lead
  - from: testing-pending
    to: testing
    on: acknowledged
    role: tester
  - from: testing-pending
    to: testing-pending
    on: redispatch
    role: daemon
  - from: testing-pending
    to: failed
    on: step-failed
    role: daemon
  - from: testing-pending
    to: blocked-testing
    on: seat-down
    role: daemon
  - from: testing-pending
    to: failed
    on: lead-stop
    role: lead
  - from: testing
    to: merging
    on: step-done
    role: tester
    guard: tested-head-equals-built
  - from: testing
    to: testing-pending
    on: redispatch
    role: daemon
  - from: testing
    to: failed
    on: step-failed
    role: daemon
  - from: testing
    to: blocked-testing
    on: step-blocked
    role: tester
  - from: testing
    to: blocked-testing
    on: seat-down
    role: daemon
  - from: testing
    to: failed
    on: lead-stop
    role: lead
  - from: merging
    to: installing-pending
    on: merge-observed
    role: daemon
    guard: merge-matches-request
  - from: merging
    to: testing-pending
    on: redispatch
    role: daemon
  - from: merging
    to: blocked-merging
    on: step-blocked
    role: integrator
  - from: merging
    to: blocked-merging
    on: seat-down
    role: daemon
  - from: merging
    to: failed
    on: lead-stop
    role: lead
  - from: installing-pending
    to: installing
    on: acknowledged
    role: integrator
  - from: installing-pending
    to: installing-pending
    on: redispatch
    role: daemon
  - from: installing-pending
    to: failed
    on: step-failed
    role: daemon
  - from: installing-pending
    to: blocked-installing
    on: seat-down
    role: daemon
  - from: installing-pending
    to: failed
    on: lead-stop
    role: lead
  - from: installing
    to: installed
    on: step-done
    role: integrator
  - from: installing
    to: installing-pending
    on: redispatch
    role: daemon
  - from: installing
    to: failed
    on: step-failed
    role: daemon
  - from: installing
    to: blocked-installing
    on: step-blocked
    role: integrator
  - from: installing
    to: blocked-installing
    on: seat-down
    role: daemon
  - from: installing
    to: failed
    on: lead-stop
    role: lead
  - from: installed
    to: done
    on: install-recorded
    role: daemon
    guard: install-matches-merge
  - from: installed
    to: installing-pending
    on: redispatch
    role: daemon
  - from: installed
    to: failed
    on: lead-stop
    role: lead
  - from: blocked-dispatching
    to: dispatching
    on: redispatch
    role: daemon
  - from: blocked-dispatching
    to: dispatching
    on: lead-word
    role: lead
  - from: blocked-dispatching
    to: failed
    on: lead-stop
    role: lead
  - from: blocked-building
    to: building-pending
    on: redispatch
    role: daemon
  - from: blocked-building
    to: building-pending
    on: lead-word
    role: lead
  - from: blocked-building
    to: failed
    on: lead-stop
    role: lead
  - from: blocked-testing
    to: testing-pending
    on: redispatch
    role: daemon
  - from: blocked-testing
    to: testing-pending
    on: lead-word
    role: lead
  - from: blocked-testing
    to: failed
    on: lead-stop
    role: lead
  - from: blocked-merging
    to: merging
    on: redispatch
    role: daemon
  - from: blocked-merging
    to: merging
    on: lead-word
    role: lead
  - from: blocked-merging
    to: failed
    on: lead-stop
    role: lead
  - from: blocked-installing
    to: installing-pending
    on: redispatch
    role: daemon
  - from: blocked-installing
    to: installing-pending
    on: lead-word
    role: lead
  - from: blocked-installing
    to: failed
    on: lead-stop
    role: lead
effects:
  dispatch-builder:
    run: dispatch
    role: daemon
    capability: write
  dispatch-tester:
    run: dispatch
    role: daemon
    capability: write
  dispatch-integrator:
    run: dispatch
    role: daemon
    capability: write
`;

export type BuiltinDefinition = {
  name: string;
  workflow: Workflow;
  definition: DefinitionId;
};

export const BUILTIN_DEFINITION_NAMES: readonly string[] = [WORK_ITEM_NAME];

let cached: BuiltinDefinition | undefined;

/**
 * The one graph the daemon may run live (workflow-mvp-spec-draft-4 §2.4, §2.6). Any other name
 * answers undefined and is refused upstream. The text is parsed with the pin's own parser and
 * cached; a broken built-in is a programming error and throws, never a silent empty graph.
 */
export function builtinDefinition(name: string): BuiltinDefinition | undefined {
  if (name !== WORK_ITEM_NAME) return undefined;
  if (cached === undefined) {
    const parsed = parseWorkflow(WORK_ITEM_YAML);
    if ('invalid' in parsed) {
      const where = parsed.invalid.line > 0 ? `line ${parsed.invalid.line}: ` : '';
      throw new Error(`built-in workflow "${name}" is not valid YAML: ${where}${parsed.invalid.message}`);
    }
    if ('findings' in parsed) {
      const first = parsed.findings[0];
      const detail = first
        ? `${first.code} at line ${first.line}: ${first.message}`
        : 'an unknown parse finding';
      throw new Error(`built-in workflow "${name}" does not parse: ${detail}`);
    }
    cached = { name, workflow: parsed.workflow, definition: parsed.definition };
  }
  return cached;
}
