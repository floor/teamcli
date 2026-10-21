// WF1-DRY boundary: the runner and replay are pure. No file or stream writer is named in the
// module, and a full run plus replay performs no Bun.write. The caller prints; the runner writes
// nothing (P6/P7, matrix row 55).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dryReplay, dryRun, readScript } from '../../../src/workflow/dry/index.ts';
import { provisionalResolvers } from '../../../src/workflow/registry.ts';
import { parseWorkflow } from '../../../src/workflow/schema.ts';

const DRY_FILES = ['index.ts', 'replay.ts', 'run.ts', 'script.ts'] as const;
const FORBIDDEN = [
  'node:fs',
  'Bun.write',
  'writeFile',
  'createWriteStream',
  'process.stdout',
  'process.stderr',
  'console.',
] as const;

const DEFINITION = `workflow: no-write-dry
version: 1
initial: open
states:
  open: {}
  done: {}
transitions:
  - { from: open, to: done, on: time-reached, role: lead }
effects: {}
`;

const SCRIPT = `format: 1
target: floor/teamcli
artifact: { kind: none }
settings: {}
inputs: {}
evidence:
  timer-1: { type: timer }
signals:
  - { signal: time-reached, at: '2026-10-21T12:00:00Z', request-id: req-1, expected-revision: 0, evidence: [timer-1] }
`;

describe('dry boundary', () => {
  test('the dry module names no file or stream writer', () => {
    for (const file of DRY_FILES) {
      const source = readFileSync(new URL(`../../../src/workflow/dry/${file}`, import.meta.url), 'utf8');
      for (const token of FORBIDDEN) {
        expect(source).not.toContain(token);
      }
    }
  });

  test('a full run and replay perform no write', () => {
    const parsed = parseWorkflow(DEFINITION);
    if (!('workflow' in parsed)) throw new Error('fixture did not parse');
    const read = readScript(SCRIPT);
    if (!read.ok) throw new Error(`script refused: ${read.why}`);
    const bytes = new TextEncoder().encode(DEFINITION);
    const guards = provisionalResolvers().guards;

    const bun = Bun as unknown as { write: (...args: never[]) => Promise<unknown> };
    const original = bun.write;
    let writes = 0;
    bun.write = ((...args: never[]) => {
      writes += 1;
      return original(...args);
    }) as typeof bun.write;
    try {
      const run = dryRun({ definitionBytes: bytes, definition: parsed.workflow, script: read.script, guards });
      if (!run.ok) throw new Error(`dry run failed: ${run.why}`);
      const replay = dryReplay({
        definitionBytes: bytes,
        definition: parsed.workflow,
        journalText: JSON.stringify(run.journal),
        evidence: read.script.evidence,
        guards,
      });
      expect(replay.ok).toBe(true);
    } finally {
      bun.write = original;
    }
    expect(writes).toBe(0);
  });
});
