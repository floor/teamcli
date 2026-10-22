// Independent coverage for the reader boundary of a stopped request's recorded precondition.
// A producer stop that names a signal and a request id carries the request's own supplied
// `expectedRevision`, and the journal reader enforces that field's shape before replay can
// substitute anything: a negative, fractional or non-numeric value is refused as a journal
// shape error, not re-evaluated. The request-less reachable-`uses:` stop carries no request and
// must stay without the field; its exemption keeps the reader accepting the document and does
// not weaken the library-slice refusal.
import { describe, expect, test } from 'bun:test';
import { dryReplay } from '../../src/workflow/dry/replay.ts';
import { dryRun } from '../../src/workflow/dry/run.ts';
import type { DryScript } from '../../src/workflow/dry/script.ts';
import type { GuardCatalogue } from '../../src/workflow/registry.ts';
import { provisionalResolvers } from '../../src/workflow/registry.ts';
import { readJournal } from '../../src/workflow/replay.ts';
import { parseWorkflow } from '../../src/workflow/schema.ts';
import type { DryRunJournal, Workflow } from '../../src/workflow/types.ts';

const DEFINITION = `workflow: rc3-stop-precondition-reader
version: 1
initial: idle
states:
  idle: {}
transitions:
  - { from: idle, to: idle, on: gate-passed, role: integrator }
`;

// A graph whose reachable child-library state is refused before the core sees a request.
const USES = `workflow: rc3-stop-precondition-uses
version: 1
initial: open
states:
  open: {}
  child:
    uses: round
transitions:
  - { from: open, to: child, on: accepted, role: lead }
effects: {}
`;

const TARGET = 'project://rc3-stop-precondition';

type SignalInput = { request: string; expected: number; gate: string };

function scriptOf(signals: SignalInput[]): DryScript {
  return {
    format: 1,
    target: TARGET,
    artifact: { kind: 'none' },
    settings: {},
    inputs: {},
    evidence: Object.fromEntries(signals.map((one) => [one.gate, { type: 'gate', target: TARGET }])),
    signals: signals.map((one, index) => ({
      signal: 'gate-passed',
      at: `2026-10-22T00:0${String(index)}:00Z`,
      requestId: one.request,
      expectedRevision: one.expected,
      evidence: [one.gate],
    })),
  };
}

function world(signals: SignalInput[]): {
  definitionBytes: Uint8Array;
  definition: Workflow;
  guards: GuardCatalogue;
  journal: DryRunJournal;
  text: string;
} {
  const parsed = parseWorkflow(DEFINITION);
  if (!('workflow' in parsed)) throw new Error(`definition did not parse: ${JSON.stringify(parsed)}`);
  const definitionBytes = new TextEncoder().encode(DEFINITION);
  const guards = provisionalResolvers().guards;
  const produced = dryRun({ definitionBytes, definition: parsed.workflow, script: scriptOf(signals), guards });
  if (!produced.ok) throw new Error(`producer refused the definition: ${JSON.stringify(produced)}`);
  const text = JSON.stringify(produced.journal);
  const reread = readJournal(text);
  if (!reread.ok) throw new Error(`producer journal did not re-read: ${JSON.stringify(reread)}`);
  return { definitionBytes, definition: parsed.workflow, guards, journal: reread.journal, text };
}

/** A stale second request stops on the core's own revision check and keeps its supplied value. */
function staleWorld() {
  return world([
    { request: 'req-1', expected: 0, gate: 'gate-1' },
    { request: 'req-2', expected: 0, gate: 'gate-2' },
  ]);
}

function tampered(text: string, expectedRevision: unknown): Record<string, unknown> {
  const record = JSON.parse(text) as { outcome: { kind: string; expectedRevision?: unknown } };
  if (record.outcome.kind !== 'stopped') throw new Error('expected a stopped outcome');
  record.outcome.expectedRevision = expectedRevision;
  return record;
}

describe('the reader enforces a request stop', () => {
  test('a valid journal crosses the reader with the supplied stale precondition intact', () => {
    const fixture = staleWorld();
    const outcome = fixture.journal.outcome;
    if (outcome.kind !== 'stopped') throw new Error('expected a stopped outcome');
    expect(outcome.code).toBe('core.revision-stale');
    expect(outcome.requestId).toBe('req-2');
    expect(outcome.expectedRevision).toBe(0);
  });

  test('a negative recorded precondition is a journal shape refusal', () => {
    const fixture = staleWorld();
    const read = readJournal(JSON.stringify(tampered(fixture.text, -1)));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('workflow.journal');
    expect(read.why).toContain('expectedRevision');
  });

  test('a fractional recorded precondition is a journal shape refusal', () => {
    const fixture = staleWorld();
    const read = readJournal(JSON.stringify(tampered(fixture.text, 1.5)));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('workflow.journal');
    expect(read.why).toContain('expectedRevision');
  });

  test('a non-numeric recorded precondition is a journal shape refusal', () => {
    const fixture = staleWorld();
    const read = readJournal(JSON.stringify(tampered(fixture.text, '0')));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('workflow.journal');
    expect(read.why).toContain('expectedRevision');
  });
});

describe('a request-less uses stop', () => {
  test('keeps no precondition, stays readable, and replay still refuses the library slice', () => {
    const parsed = parseWorkflow(USES);
    if (!('workflow' in parsed)) throw new Error(`definition did not parse: ${JSON.stringify(parsed)}`);
    const definitionBytes = new TextEncoder().encode(USES);
    const guards = provisionalResolvers().guards;
    const script: DryScript = {
      format: 1,
      target: TARGET,
      artifact: { kind: 'none' },
      settings: {},
      inputs: {},
      evidence: {},
      signals: [],
    };
    const produced = dryRun({ definitionBytes, definition: parsed.workflow, script, guards });
    if (!produced.ok) throw new Error(`producer refused the definition: ${JSON.stringify(produced)}`);
    const outcome = produced.journal.outcome;
    if (outcome.kind !== 'stopped') throw new Error('expected a stopped outcome');
    expect(outcome.code).toBe('workflow.uses-deferred');
    expect(outcome.signal).toBeUndefined();
    expect(outcome.requestId).toBeUndefined();
    expect('expectedRevision' in outcome).toBe(false);

    // The reader accepts the request-less document, then the dry replay refuses the graph itself.
    const text = JSON.stringify(produced.journal);
    const reread = readJournal(text);
    expect(reread.ok).toBe(true);
    const replayed = dryReplay({
      definitionBytes,
      definition: parsed.workflow,
      journalText: text,
      evidence: {},
      guards,
    });
    expect(replayed.ok).toBe(false);
    if (replayed.ok) return;
    expect(replayed.fail.code).toBe('workflow.uses-deferred');
  });
});
