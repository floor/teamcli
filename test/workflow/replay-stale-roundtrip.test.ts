import { describe, expect, test } from 'bun:test';
import { decide } from '../../src/workflow/core.ts';
import type { DryRunResult } from '../../src/workflow/dry/run.ts';
import { dryRun } from '../../src/workflow/dry/run.ts';
import { readScript } from '../../src/workflow/dry/script.ts';
import type { DryScript } from '../../src/workflow/dry/script.ts';
import type { GuardCatalogue } from '../../src/workflow/registry.ts';
import { provisionalResolvers } from '../../src/workflow/registry.ts';
import type { ReplayResult } from '../../src/workflow/replay.ts';
import { readJournal, replay } from '../../src/workflow/replay.ts';
import { parseWorkflow } from '../../src/workflow/schema.ts';
import type { DryRunJournal, Workflow } from '../../src/workflow/types.ts';

// A terminal stale-revision refusal produced by the dry runner must replay from its own journal.
// A one-state self loop with no effects isolates the request precondition: the only thing that can
// move the run is the envelope's expectedRevision.

const DEFINITION = `workflow: rc3-replay-stale
version: 1
initial: idle
states:
  idle: {}
transitions:
  - { from: idle, to: idle, on: gate-passed, role: integrator }
`;

const TARGET = 'project://rc3-replay';

function script(signals: Array<{ request: string; expected: number; gate: string }>): string {
  const lines = signals.map(
    (one, index) => `  - signal: gate-passed
    at: 2026-10-22T00:0${String(index)}:00Z
    request-id: ${one.request}
    expected-revision: ${String(one.expected)}
    evidence: [${one.gate}]`,
  );
  const gates = signals.map(
    (one) => `  ${one.gate}:
    type: gate
    target: ${TARGET}`,
  );
  return `format: 1
target: ${TARGET}
artifact:
  kind: none
settings: {}
inputs: {}
evidence:
${gates.join('\n')}
signals:
${lines.join('\n')}
`;
}

function world(scriptText: string): {
  definitionBytes: Uint8Array;
  definition: Workflow;
  guards: GuardCatalogue;
  supplied: DryScript;
  produced: Extract<DryRunResult, { ok: true }>;
  text: string;
  journal: DryRunJournal;
} {
  const parsed = parseWorkflow(DEFINITION);
  if (!('workflow' in parsed)) throw new Error(`definition did not parse: ${JSON.stringify(parsed)}`);
  const read = readScript(scriptText);
  if (!read.ok) throw new Error(`script did not parse: ${JSON.stringify(read)}`);

  const definitionBytes = new TextEncoder().encode(DEFINITION);
  const guards = provisionalResolvers().guards;
  const produced = dryRun({ definitionBytes, definition: parsed.workflow, script: read.script, guards });
  if (!produced.ok) throw new Error(`producer refused the definition: ${JSON.stringify(produced)}`);

  // The journal crosses the same JSON boundary a caller writes and replay reads.
  const text = JSON.stringify(produced.journal);
  const reread = readJournal(text);
  if (!reread.ok) throw new Error(`producer journal did not re-read: ${JSON.stringify(reread)}`);

  return {
    definitionBytes,
    definition: parsed.workflow,
    guards,
    supplied: read.script,
    produced,
    text,
    journal: reread.journal,
  };
}

function replayJournal(
  fixture: ReturnType<typeof world>,
  journal: DryRunJournal = fixture.journal,
): ReplayResult {
  return replay({
    definitionBytes: fixture.definitionBytes,
    definition: fixture.definition,
    journal,
    evidence: fixture.supplied.evidence,
    guards: fixture.guards,
    decide,
  });
}

function reread(fixture: ReturnType<typeof world>, text: string): DryRunJournal {
  const result = readJournal(text);
  if (!result.ok) throw new Error(`tampered journal kept its shape: ${JSON.stringify(result)}`);
  return result.journal;
}

describe('dry producer to replay round trip', () => {
  test('initial request expecting revision 0 advances one step and replays', () => {
    const fixture = world(script([{ request: 'req-1', expected: 0, gate: 'gate-1' }]));

    expect(fixture.produced.exit).toBe(0);
    expect(fixture.produced.journal.steps.length).toBe(1);
    expect(fixture.produced.journal.steps[0]?.revision).toBe(1);
    expect(fixture.produced.journal.outcome.kind).toBe('script-exhausted');

    const replayed = replayJournal(fixture);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.run.revision).toBe(1);
    expect(replayed.run.state).toBe('idle');
    expect(replayed.run.blocked).toBeUndefined();
  });

  test('a second request expecting the current revision yields two steps and replays', () => {
    const fixture = world(
      script([
        { request: 'req-1', expected: 0, gate: 'gate-1' },
        { request: 'req-2', expected: 1, gate: 'gate-2' },
      ]),
    );

    expect(fixture.produced.exit).toBe(0);
    expect(fixture.produced.journal.steps.length).toBe(2);
    expect(fixture.produced.journal.steps[1]?.revision).toBe(2);

    const replayed = replayJournal(fixture);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.run.revision).toBe(2);
    expect(replayed.run.blocked).toBeUndefined();
  });

  test('a second request expecting revision 0 stops core.revision-stale and its unchanged journal replays', () => {
    const fixture = world(
      script([
        { request: 'req-1', expected: 0, gate: 'gate-1' },
        { request: 'req-2', expected: 0, gate: 'gate-2' },
      ]),
    );

    expect(fixture.produced.exit).toBe(1);
    expect(fixture.produced.journal.steps.length).toBe(1);
    const stop = fixture.produced.journal.outcome;
    if (stop.kind !== 'stopped') throw new Error('expected a stopped outcome');
    expect(stop.decision).toBe('refused');
    expect(stop.code).toBe('core.revision-stale');
    expect(stop.state).toBe('idle');
    expect(stop.revision).toBe(1);
    expect(stop.requestId).toBe('req-2');
    // The journal keeps the request's own stale precondition rather than the run revision.
    expect(stop).toMatchObject({ expectedRevision: 0 });

    // The regression: the producer's own journal must replay unchanged, with the same refusal.
    const replayed = replayJournal(fixture);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.run.revision).toBe(1);
    expect(replayed.run.blocked?.decision).toBe('refused');
    expect(replayed.run.blocked?.code).toBe('core.revision-stale');
  });

  test('a divergent step request payload is still refused as a replay mismatch', () => {
    const fixture = world(
      script([
        { request: 'req-1', expected: 0, gate: 'gate-1' },
        { request: 'req-2', expected: 1, gate: 'gate-2' },
      ]),
    );
    const tampered = JSON.parse(fixture.text) as { steps: Array<{ evidence: string[] }> };
    tampered.steps[1]!.evidence = ['gate-1'];

    const replayed = replayJournal(fixture, reread(fixture, JSON.stringify(tampered)));
    expect(replayed.ok).toBe(false);
    if (replayed.ok) return;
    expect(replayed.fail.code).toBe('workflow.replay-mismatch');
    expect(replayed.fail.step).toBe(1);
  });

  test('a divergent stopped request signal is still refused', () => {
    const fixture = world(
      script([
        { request: 'req-1', expected: 0, gate: 'gate-1' },
        { request: 'req-2', expected: 0, gate: 'gate-2' },
      ]),
    );
    const tampered = JSON.parse(fixture.text) as { outcome: { kind: string; signal?: string } };
    if (tampered.outcome.kind !== 'stopped') throw new Error('expected a stopped outcome');
    tampered.outcome.signal = 'approved';

    const replayed = replayJournal(fixture, reread(fixture, JSON.stringify(tampered)));
    expect(replayed.ok).toBe(false);
    if (replayed.ok) return;
    expect(replayed.fail.code).toBe('workflow.replay-mismatch');
  });

  test('a stopped request with no recorded expected revision is refused, never substituted', () => {
    const fixture = world(
      script([
        { request: 'req-1', expected: 0, gate: 'gate-1' },
        { request: 'req-2', expected: 0, gate: 'gate-2' },
      ]),
    );
    const tampered = JSON.parse(fixture.text) as {
      outcome: { kind: string; signal?: string; requestId?: string; expectedRevision?: number };
    };
    if (tampered.outcome.kind !== 'stopped') throw new Error('expected a stopped outcome');
    expect(tampered.outcome.signal).toBeDefined();
    expect(tampered.outcome.requestId).toBe('req-2');
    delete tampered.outcome.expectedRevision;

    // Fail closed: an older request-derived stop without its precondition is not replayed under
    // a substituted revision. The reader may refuse the shape; if it keeps it, replay must refuse
    // the stop rather than rebuild it under the folded revision.
    const read = readJournal(JSON.stringify(tampered));
    if (!read.ok) {
      expect(read.code).toBe('workflow.journal');
      return;
    }
    const replayed = replayJournal(fixture, read.journal);
    expect(replayed.ok).toBe(false);
    if (replayed.ok) return;
    expect(replayed.fail.code).toBe('workflow.journal');
  });

  test('a tampered recorded expected revision is still refused', () => {
    const fixture = world(
      script([
        { request: 'req-1', expected: 0, gate: 'gate-1' },
        { request: 'req-2', expected: 0, gate: 'gate-2' },
      ]),
    );
    const tampered = JSON.parse(fixture.text) as {
      outcome: { kind: string; expectedRevision?: number };
    };
    if (tampered.outcome.kind !== 'stopped') throw new Error('expected a stopped outcome');
    tampered.outcome.expectedRevision = 1;

    // The reader may refuse the shape; if it accepts it, the re-evaluation under the altered
    // precondition must diverge from the recorded stop. Either way replay does not succeed.
    const read = readJournal(JSON.stringify(tampered));
    if (!read.ok) {
      expect(read.code).toBe('workflow.journal');
      return;
    }
    const replayed = replayJournal(fixture, read.journal);
    expect(replayed.ok).toBe(false);
    if (replayed.ok) return;
    expect(replayed.fail.code).toBe('workflow.replay-mismatch');
  });
});
