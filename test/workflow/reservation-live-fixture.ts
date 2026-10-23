// A minimal live workflow for reservation scenes that need a real run: one idle state, no
// transitions, no effects. It parses, it opens a journal, and it can be closed by an outcome, so
// a scene can reach a terminal item or a reopen without a real definition file.

import type { ItemKey, RunStore } from '../../src/workflow/live/index.ts';
import { parseWorkflow } from '../../src/workflow/schema.ts';
import type { Workflow } from '../../src/workflow/types.ts';

export const MINIMAL_DEFINITION = `workflow: probe
version: 1
initial: idle
states:
  idle: {}
transitions: []
effects: {}
`;

export function minimalWorkflow(): Workflow {
  const parsed = parseWorkflow(MINIMAL_DEFINITION);
  if (!('workflow' in parsed)) {
    throw new Error(`the minimal definition does not parse: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return parsed.workflow;
}

/** Opens a real run for the item on this store and returns its run id. */
export function createRunFor(store: RunStore, item: ItemKey): string {
  const created = store.transact((tx) =>
    tx.createRun({
      item,
      definitionBytes: MINIMAL_DEFINITION,
      definition: minimalWorkflow(),
      target: 'none',
      artifact: { kind: 'none' },
      inputs: {},
      settings: {},
    }),
  );
  return created.record.run;
}
