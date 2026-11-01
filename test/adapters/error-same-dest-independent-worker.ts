import { homedir } from 'node:os';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [expectedHome, scenario] = process.argv.slice(2);
if (!expectedHome || !scenario || homedir() !== realpathSync(expectedHome)) throw new Error('child-start synthetic HOME required');
const { parseWorkflow, canonicalJson, canonicalRequestPayload, occurrenceId, payloadDigest, provisionalResolvers } = await import('../../src/workflow/index.ts');
const { decide } = await import('../../src/workflow/core.ts');
const { foldLive, replayLive, stepFault } = await import('../../src/workflow/live/replay.ts');
const { openRunStore } = await import('../../src/workflow/live/store.ts');
const { journalPath } = await import('../../src/workflow/live/journal.ts');
import type { EvidenceRecord, EvidenceRef, WorkflowEnvelope } from '../../src/workflow/types.ts';
import type { RunState } from '../../src/workflow/core-state.ts';
import type { StepInput } from '../../src/workflow/live/replay.ts';
const source = `workflow: independent-error
version: 1
initial: active
error: halted
inputs: [item-key]
states:
  active:
    on-enter: [dispatch-worker]
  halted: {}
  complete: {}
transitions:
  - { from: active, to: halted, on: step-failed, role: daemon }
  - { from: active, to: complete, on: step-done, role: daemon }
  - { from: active, to: halted, on: lead-word, role: daemon, guard: tested-head-equals-built }
effects:
  dispatch-worker: { run: dispatch-worker, capability: write, role: builder }
`;
const parsed = parseWorkflow(source);
if (!('workflow' in parsed)) throw new Error(JSON.stringify(parsed));
const definition = parsed.workflow;
const pin = parsed.definition;
const root = join(dirname(homedir()), 'journal');
const at = new Date().toISOString();
const target = 'refs/heads/synthetic';
const artifact = { kind: 'none' as const };
const store = openRunStore({ root });
const created = store.transact((tx) => tx.createRun({ item: { source: 'file', project: 'fixture', team: 'fixture', id: '42' }, definitionBytes: source, definition, target, artifact, inputs: { 'item-key': 'file.fixture.fixture.42' }, settings: {} }));
const open = created.record;
const runId = open.run;
const run: RunState = { runId, definitionId: pin, state: 'active', revision: 0, activation: 1, occurrences: new Map(open.start.effects.map((effect) => [effect.occurrence, { id: effect.occurrence, effect: effect.name, state: effect.state, activation: effect.activation, payloadDigest: effect.payloadDigest }])), requests: new Map(), waits: [] };
const signal = scenario === 'guarded' ? 'lead-word' : scenario.includes('other') || scenario === 'redirected-refusal' ? 'step-done' : 'step-failed';
const done = scenario === 'normal' || scenario.includes('over-done');
const evidence: Record<EvidenceRef, EvidenceRecord> = {
  'ev-signal': { type: signal === 'step-done' ? 'step' : signal === 'lead-word' ? 'message' : 'refusal', target },
  'ev-entry': { type: 'outcome', operation: 'dispatch-worker', effect: occurrenceId(runId, 1, 'dispatch-worker'), result: done ? 'done' : 'refused', target },
};
const transition = definition.transitions.find((item) => item.on === signal)!;
const envelope: WorkflowEnvelope = { format: 1, run: runId, definition: pin, expectedRevision: 0, requestId: 'independent-request', move: { transition: { from: transition.from, to: transition.to, on: transition.on } }, target, artifact, evidence: Object.keys(evidence) };
const decision = decide({ definition, definitionId: pin, run, envelope, signal: { name: signal, at }, evidence: { record: (ref) => evidence[ref] }, settings: { get: () => undefined }, guards: provisionalResolvers().guards });
if (decision.kind !== 'step') throw new Error(JSON.stringify(decision));
const step: StepInput = { revision: decision.nextRevision, signal, requestId: envelope.requestId, requestDigest: payloadDigest(canonicalRequestPayload({ move: envelope.move, target, artifact, evidence: envelope.evidence })), transition: { from: transition.from, to: transition.to, on: signal }, activation: decision.next.activation, next: decision.next.state, ...(decision.error ? { error: { ...decision.error } } : {}), ...(decision.guard ? { guard: decision.guard } : {}), evidence: [...envelope.evidence], evidenceRecords: evidence, effects: [] };
if (scenario.includes('over-done')) {
  step.next = 'halted';
  step.error = { rule: 'entry-effect-refused', from: 'active', to: 'halted', effect: 'dispatch-worker', occurrence: occurrenceId(runId, 1, 'dispatch-worker') };
}
if (scenario === 'without-error') delete step.error;
if (scenario === 'wrong-from') step.error!.from = 'complete';
if (scenario === 'wrong-to') step.error!.to = 'complete';
if (scenario === 'foreign-occurrence') step.error!.occurrence = occurrenceId(runId, 2, 'dispatch-worker');
if (scenario === 'bad-request') step.requestDigest = `sha256:${'0'.repeat(64)}`;
if (scenario === 'error-exit-effect') step.effects = [...open.start.effects];
const fault = stepFault({ definition, runId, target, artifact, state: run.state, previousRevision: 0, previousActivation: 1, step });
const previewRecord = { format: 1 as const, kind: open.kind, authoritative: true as const, seq: 2, at, record: 'step' as const, ...step };
const preview = [open, previewRecord];
const folded = foldLive(preview);
const previewReplay = replayLive({ definitionBytes: source, definition, journalText: preview.map((record) => canonicalJson(record) + '\n').join('') });
const path = journalPath(root, runId);
const before = readFileSync(path, 'utf8');
let appended = false;
let failure: { code?: string; why?: string } | undefined;
try { store.transact((tx) => tx.appendStep(runId, { ...step, at })); appended = true; } catch (error) { const caught = error as { code?: string; why?: string }; failure = { code: caught.code, why: caught.why }; }
const after = readFileSync(path, 'utf8');
const reopened = openRunStore({ root }).read(runId);
const replay = replayLive({ definitionBytes: source, definition, journalText: after });
console.log(JSON.stringify({ home: homedir(), decision, fault: fault ?? null, folded, previewReplay, appended, failure, unchanged: before === after, records: after.trimEnd().split('\n').length, reopened, replay }));
