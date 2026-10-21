// Independent module acceptance for WF1-DRY: the pure dry script reader, the dry runner and the
// replay assembler, bound at builder-7's immutable public pin a74114ac5 (reader d30160f5c) which
// publishes src/workflow/dry/index.ts. Authored from the published contract and the measured core,
// replay and waits seams; no builder fixture and no private engine copy is used here.
//
// The dry module is loaded through one adapter because the seam lands red-first: this file must
// typecheck at the actual main baseline, where `src/workflow/dry/` does not exist. The adapter is
// the only place the published names and shapes are pinned, so every row fails at main with a
// module that cannot be imported and runs unchanged against the pin.
//
// Fixtures under fixtures/ are authored here: two cycle entry effects (four distinct occurrences),
// a missing guard input, an unknown guard answer, an unreleased entry effect, an unsigned approval
// carrying forged fields, a time wait reached and not reached, a missing wait setting, and a
// reachable `uses:`.

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, parseWorkflow, provisionalResolvers } from '../../../src/workflow/index.ts';
import type {
  DefinitionId,
  DryEffectRecord,
  DryRunJournal,
  EvidenceDocument,
  EvidenceRecord,
  Workflow,
} from '../../../src/workflow/index.ts';

const NOTICE = 'dry run — no record is written';
const DRY_DIR = join(import.meta.dir, '..', '..', '..', 'src', 'workflow', 'dry');

// ---------------------------------------------------------------------------------------------
// The published surface, mirrored locally. TypeScript cannot resolve a computed dynamic import,
// which is exactly what keeps the baseline honest: the shapes below are the pinned contract.

type ArtifactRef = { kind: 'none' } | { kind: 'ref' | 'tree'; value: string };

type DrySignal = {
  signal: string;
  at: string;
  requestId: string;
  expectedRevision: number;
  evidence: string[];
};

type DryScript = {
  format: 1;
  target: string;
  artifact: ArtifactRef;
  settings: Record<string, string>;
  inputs: Record<string, string>;
  evidence: EvidenceDocument;
  signals: DrySignal[];
};

type ScriptReadResult =
  | { ok: true; script: DryScript }
  | { ok: false; code: 'workflow.script' | 'workflow.evidence'; why: string };

type RunWait = { state: string; activation: number; status: 'pending' | 'fired' };

type RunBlock = {
  decision: 'held' | 'refused';
  code: string;
  state: string;
  revision: number;
  waitingOn?: unknown;
};

type RunState = {
  runId: string;
  definitionId: DefinitionId;
  state: string;
  revision: number;
  activation: number;
  occurrences: ReadonlyMap<string, unknown>;
  requests: ReadonlyMap<string, unknown>;
  waits: readonly RunWait[];
  blocked?: RunBlock;
};

type DecisionView = { kind: string; code?: string; waitingOn?: unknown };

type DryRunResult =
  | {
      ok: true;
      journal: DryRunJournal;
      run: RunState;
      decision: DecisionView | undefined;
      exit: 0 | 1;
    }
  | { ok: false; code: 'workflow.definition'; why: string };

type ReplayFailure = {
  code: string;
  step?: number;
  expected?: unknown;
  actual?: unknown;
  why: string;
};

type DryReplayResult =
  | { ok: true; run: RunState; exit: 0 }
  | { ok: false; fail: ReplayFailure; exit: 1 };

type Guards = ReturnType<typeof provisionalResolvers>['guards'];

type DryRunInput = {
  definitionBytes: Uint8Array;
  definition: Workflow;
  script: DryScript;
  guards: Guards;
};

type DryReplayInput = {
  definitionBytes: Uint8Array;
  definition: Workflow;
  journalText: string;
  evidence: EvidenceDocument;
  guards: Guards;
};

type DryModule = {
  readScript(text: string): ScriptReadResult;
  dryRun(input: DryRunInput): DryRunResult;
  dryReplay(input: DryReplayInput): DryReplayResult;
  dryRunId(pin: DefinitionId, script: DryScript): string;
  reachableUses(definition: Workflow, initial: string): string | undefined;
  usesDeferredWhy(state: string): string;
};

/** The one adapter the exact published names are pinned through. */
async function dryModule(): Promise<DryModule> {
  return (await import(join(DRY_DIR, 'index.ts'))) as DryModule;
}

// ---------------------------------------------------------------------------------------------
// Fixtures and helpers.

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8');
}

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function guards(): Guards {
  return provisionalResolvers().guards;
}

function parseOk(source: string): { workflow: Workflow; definition: DefinitionId } {
  const result = parseWorkflow(source);
  if (!('workflow' in result)) throw new Error(`fixture did not parse: ${JSON.stringify(result)}`);
  return { workflow: result.workflow, definition: result.definition };
}

function readScriptOk(mod: DryModule, name: string): DryScript {
  const read = mod.readScript(fixture(name));
  if (!read.ok) throw new Error(`script fixture ${name} was refused: ${read.code}: ${read.why}`);
  return read.script;
}

function outcome(
  operation: string,
  effect: string,
  target: string,
  result: 'done' | 'refused' = 'done',
): EvidenceRecord {
  return { type: 'outcome', operation, effect, target, result };
}

function stepFixture(target: string): EvidenceRecord {
  return { type: 'step', target };
}

/** The two cycles' entry-effect outcomes: one `done` per activation the run enters. */
function cycleEvidence(runId: string, target: string): EvidenceDocument {
  return {
    'step-1': stepFixture(target),
    'merge-1': outcome('merge', 'merge', target),
    'stamp-1': outcome('changelog-stamp', `${runId}/1/stamp`, target),
    'stamp-2': outcome('changelog-stamp', `${runId}/2/stamp`, target),
    'stamp-3': outcome('changelog-stamp', `${runId}/3/stamp`, target),
  };
}

type Prepared = {
  mod: DryModule;
  source: string;
  parsed: { workflow: Workflow; definition: DefinitionId };
  script: DryScript;
};

type EvidenceBuilder = (runId: string, target: string) => EvidenceDocument;

/** Read the fixtures, settle the run id, then add the evidence the id deliberately excludes. */
async function prepare(
  definitionFixture: string,
  scriptFixture: string,
  evidenceFor?: EvidenceBuilder,
): Promise<Prepared> {
  const mod = await dryModule();
  const source = fixture(definitionFixture);
  const parsed = parseOk(source);
  const base = readScriptOk(mod, scriptFixture);
  const runId = mod.dryRunId(parsed.definition, base);
  const evidence = evidenceFor === undefined ? base.evidence : evidenceFor(runId, base.target);
  return { mod, source, parsed, script: { ...base, evidence } };
}

function runPrepared(prepared: Prepared): DryRunResult {
  return prepared.mod.dryRun({
    definitionBytes: bytes(prepared.source),
    definition: prepared.parsed.workflow,
    script: prepared.script,
    guards: guards(),
  });
}

type OkRun = { prepared: Prepared; result: Extract<DryRunResult, { ok: true }> };

async function runOk(
  definitionFixture: string,
  scriptFixture: string,
  evidenceFor?: EvidenceBuilder,
): Promise<OkRun> {
  const prepared = await prepare(definitionFixture, scriptFixture, evidenceFor);
  const result = runPrepared(prepared);
  if (!result.ok) throw new Error(`dryRun refused the definition: ${result.code}: ${result.why}`);
  return { prepared, result };
}

function replayPrepared(
  prepared: Prepared,
  journalText: string,
  evidence: EvidenceDocument = prepared.script.evidence,
): DryReplayResult {
  return prepared.mod.dryReplay({
    definitionBytes: bytes(prepared.source),
    definition: prepared.parsed.workflow,
    journalText,
    evidence,
    guards: guards(),
  });
}

/** The journal as an editable JSON tree, so a row can tamper with exactly one field. */
function journalJson(journal: DryRunJournal): Record<string, unknown> {
  return JSON.parse(JSON.stringify(journal)) as Record<string, unknown>;
}

/** A stable view of the folded run: maps become sorted entry lists. */
function runView(run: RunState): unknown {
  const byKey = (a: [string, unknown], b: [string, unknown]): number =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  return {
    runId: run.runId,
    definitionId: run.definitionId,
    state: run.state,
    revision: run.revision,
    activation: run.activation,
    occurrences: [...run.occurrences.entries()].sort(byKey),
    requests: [...run.requests.entries()].sort(byKey),
    waits: [...run.waits],
    blocked: run.blocked ?? null,
  };
}

function allEffects(journal: DryRunJournal): DryEffectRecord[] {
  return [...journal.start.effects, ...journal.steps.flatMap((step) => step.effects)];
}

function decisionOf(result: Extract<DryRunResult, { ok: true }>): DecisionView {
  if (result.decision === undefined) throw new Error('the runner recorded no decision');
  return result.decision;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// The named fixture rows, each a fresh run over the shared fixtures.

function cycleRun(): Promise<OkRun> {
  return runOk('cycle.yaml', 'script-cycle.yaml', cycleEvidence);
}

function guardRun(): Promise<OkRun> {
  return runOk('guard-missing.yaml', 'script-guard-missing.yaml');
}

function unknownGuardRun(): Promise<OkRun> {
  return runOk('guard-missing.yaml', 'script-guard-unknown.yaml');
}

function entryEffectRun(): Promise<OkRun> {
  return runOk('cycle.yaml', 'script-cycle-missing-effect.yaml');
}

function approvalRun(): Promise<OkRun> {
  return runOk('approval-wait.yaml', 'script-approval.yaml');
}

function timeAtRun(): Promise<OkRun> {
  return runOk('time-wait.yaml', 'script-time-at.yaml');
}

function timeBeforeRun(): Promise<OkRun> {
  return runOk('time-wait.yaml', 'script-time-before.yaml');
}

function timeMissingSettingRun(): Promise<OkRun> {
  return runOk('time-wait.yaml', 'script-time-missing-setting.yaml');
}

function usesRun(): Promise<OkRun> {
  return runOk('uses-round.yaml', 'script-uses-round.yaml');
}

// ---------------------------------------------------------------------------------------------
// The published surface and the purity boundary.

describe('WF1-DRY published surface', () => {
  test('exports exactly the six pinned runtime names', async () => {
    const mod = await dryModule();
    expect(Object.keys(mod).sort()).toEqual([
      'dryReplay',
      'dryRun',
      'dryRunId',
      'reachableUses',
      'readScript',
      'usesDeferredWhy',
    ]);
  });

  test('stays pure: relative imports only, no clock, IO, spawn or randomness', async () => {
    await dryModule();
    const files = readdirSync(DRY_DIR).filter((name) => name.endsWith('.ts'));
    expect(files).toContain('index.ts');
    for (const file of files) {
      const text = readFileSync(join(DRY_DIR, file), 'utf8');
      const specifiers = [...text.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1]!);
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) expect(specifier.startsWith('.')).toBe(true);
      expect(text).not.toMatch(
        /\bDate\.now\b|\bnew\s+Date\b|\bsetTimeout\b|\bsetInterval\b|\bMath\.random\b|\bchild_process\b|\bBun\s*\.|\bprocess\.env\b|\bwriteFile\b|\bappendFile\b|\bcreateWriteStream\b|\bperformance\.now\b/,
      );
    }
  });

  test('does not mutate the definition, the script or the evidence fixtures', async () => {
    const prepared = await prepare('cycle.yaml', 'script-cycle.yaml', cycleEvidence);
    deepFreeze(prepared.script);
    deepFreeze(prepared.parsed.workflow);
    const before = canonicalJson({ script: prepared.script, definition: prepared.parsed.workflow });
    const result = runPrepared(prepared);
    expect(result.ok).toBe(true);
    expect(canonicalJson({ script: prepared.script, definition: prepared.parsed.workflow })).toBe(
      before,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The script reader: shape, closed vocabulary, and the workflow.evidence split.

describe('WF1-DRY script reader', () => {
  test('parses the committed script document exactly', async () => {
    const mod = await dryModule();
    const read = mod.readScript(fixture('script-cycle.yaml'));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script).toEqual({
      format: 1,
      target: 'project://dry-acceptance',
      artifact: { kind: 'none' },
      settings: {},
      inputs: { request: 'dry-acceptance' },
      evidence: {},
      signals: [
        {
          signal: 'pr-opened',
          at: '2026-10-21T00:00:00.000Z',
          requestId: 'req-1',
          expectedRevision: 0,
          evidence: ['step-1', 'stamp-1'],
        },
        {
          signal: 'pr-merged',
          at: '2026-10-21T00:01:00.000Z',
          requestId: 'req-2',
          expectedRevision: 1,
          evidence: ['merge-1', 'stamp-2'],
        },
        {
          signal: 'pr-opened',
          at: '2026-10-21T00:02:00.000Z',
          requestId: 'req-3',
          expectedRevision: 2,
          evidence: ['step-1', 'stamp-3'],
        },
      ],
    });
  });

  test('accepts a script with no signals', async () => {
    const mod = await dryModule();
    const read = mod.readScript(fixture('script-uses-round.yaml'));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.script.signals).toEqual([]);
    expect(read.script.evidence).toEqual({});
  });

  test('refuses closed-key and vocabulary violations as workflow.script', async () => {
    const mod = await dryModule();
    const unknownKey = [
      'format: 1',
      'target: project://dry-acceptance',
      'artifact:',
      '  kind: none',
      'settings: {}',
      'inputs: {}',
      'evidence: {}',
      'signals: []',
      'extra: true',
      '',
    ].join('\n');
    const missingSignals = [
      'format: 1',
      'target: project://dry-acceptance',
      'artifact:',
      '  kind: none',
      'settings: {}',
      'inputs: {}',
      'evidence: {}',
      '',
    ].join('\n');
    const badSignal = [
      'format: 1',
      'target: project://dry-acceptance',
      'artifact:',
      '  kind: none',
      'settings: {}',
      'inputs: {}',
      'evidence: {}',
      'signals:',
      '  - signal: nothing-happens',
      '    at: 2026-10-21T00:00:00.000Z',
      '    request-id: req-1',
      '    expected-revision: 0',
      '    evidence: []',
      '',
    ].join('\n');
    const signalExtraKey = [
      'format: 1',
      'target: project://dry-acceptance',
      'artifact:',
      '  kind: none',
      'settings: {}',
      'inputs: {}',
      'evidence: {}',
      'signals:',
      '  - signal: pr-opened',
      '    at: 2026-10-21T00:00:00.000Z',
      '    request-id: req-1',
      '    expected-revision: 0',
      '    evidence: []',
      '    note: extra',
      '',
    ].join('\n');

    const cases: Array<[string, string]> = [
      [unknownKey, 'unknown key "extra"'],
      [missingSignals, 'missing "signals"'],
      [badSignal, 'not a transition signal'],
      [signalExtraKey, 'unknown key "note"'],
    ];
    for (const [text, why] of cases) {
      const read = mod.readScript(text);
      expect(read.ok).toBe(false);
      if (read.ok) continue;
      expect(read.code).toBe('workflow.script');
      expect(read.why).toContain(why);
    }
  });

  test('refuses a non-mapping evidence fixture as workflow.evidence', async () => {
    const mod = await dryModule();
    const text = [
      'format: 1',
      'target: project://dry-acceptance',
      'artifact:',
      '  kind: none',
      'settings: {}',
      'inputs: {}',
      'evidence:',
      '  bad: plain',
      'signals: []',
      '',
    ].join('\n');
    const read = mod.readScript(text);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('workflow.evidence');
    expect(read.why).toContain('must be a mapping');
  });
});

// ---------------------------------------------------------------------------------------------
// D1–D6: the runner.

describe('WF1-DRY dry runner D1–D6', () => {
  test('D1: equal scripts give the same journal; the id excludes evidence and hashes requests', async () => {
    const { prepared, result } = await cycleRun();
    const clone = JSON.parse(JSON.stringify(prepared.script)) as DryScript;
    const again = prepared.mod.dryRun({
      definitionBytes: bytes(prepared.source),
      definition: prepared.parsed.workflow,
      script: clone,
      guards: guards(),
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(canonicalJson(again.journal)).toBe(canonicalJson(result.journal));
    expect(canonicalJson(runView(again.run))).toBe(canonicalJson(runView(result.run)));

    const base = readScriptOk(prepared.mod, 'script-cycle.yaml');
    // Evidence is deliberately outside the run id: the evidence-free script and the fully
    // supplied one give the same id, and the journal records it.
    expect(prepared.mod.dryRunId(prepared.parsed.definition, base)).toBe(result.journal.run);
    expect(prepared.mod.dryRunId(prepared.parsed.definition, prepared.script)).toBe(
      result.journal.run,
    );

    // Settings are hashed, so the same signals under another time setting move the id.
    const timeParsed = parseOk(fixture('time-wait.yaml'));
    const early = readScriptOk(prepared.mod, 'script-time-at.yaml');
    const late = readScriptOk(prepared.mod, 'script-time-before.yaml');
    expect(prepared.mod.dryRunId(timeParsed.definition, early)).not.toBe(
      prepared.mod.dryRunId(timeParsed.definition, late),
    );
  });

  test('D2: two cycles allocate four distinct entry occurrences, one per activation', async () => {
    const { result } = await cycleRun();
    const journal = result.journal;
    expect(journal.start.effects.map((effect) => effect.activation)).toEqual([1]);
    expect(journal.steps.map((step) => step.activation)).toEqual([2, 3, 4]);
    expect(journal.steps.map((step) => step.revision)).toEqual([1, 2, 3]);

    const effects = allEffects(journal);
    expect(effects.map((effect) => effect.name)).toEqual(['stamp', 'stamp', 'stamp', 'stamp']);
    expect(effects.map((effect) => effect.activation)).toEqual([1, 2, 3, 4]);
    const occurrences = effects.map((effect) => effect.occurrence);
    expect(new Set(occurrences).size).toBe(4);
    expect(occurrences).toEqual([1, 2, 3, 4].map((n) => `${journal.run}/${n}/stamp`));

    // The supplied outcome that released each activation's entry effect names its ref; the last
    // entered activation is never released, because the script ends first.
    expect(effects[0]!.outcome).toBe('stamp-1');
    expect(effects[1]!.outcome).toBe('stamp-2');
    expect(effects[2]!.outcome).toBe('stamp-3');
    expect(effects[3]!.outcome).toBeUndefined();

    expect(journal.outcome).toEqual({ kind: 'script-exhausted' });
    expect(result.exit).toBe(0);
    expect(result.run.state).toBe('resting');
    expect(result.run.revision).toBe(3);
    expect(result.run.activation).toBe(4);
  });

  test('D3: a missing guard input holds at evidence.missing and moves nothing', async () => {
    const { result } = await guardRun();
    const journal = result.journal;
    expect(journal.steps).toEqual([]);
    const stop = journal.outcome;
    expect(stop.kind).toBe('stopped');
    if (stop.kind !== 'stopped') return;
    expect(stop.decision).toBe('held');
    expect(stop.code).toBe('evidence.missing');
    expect(stop.state).toBe('draft');
    expect(stop.revision).toBe(0);
    expect(stop.evidence).toEqual(['step-1']);
    expect(result.run.state).toBe('draft');
    expect(result.run.revision).toBe(0);
    expect(result.exit).toBe(1);
    expect(decisionOf(result).kind).toBe('held');
  });

  test('D3c: an unreleased entry effect holds on its occurrence', async () => {
    const { result } = await entryEffectRun();
    const journal = result.journal;
    expect(journal.steps).toEqual([]);
    const stop = journal.outcome;
    expect(stop.kind).toBe('stopped');
    if (stop.kind !== 'stopped') return;
    expect(stop.decision).toBe('held');
    expect(stop.code).toBe('evidence.missing');
    expect(stop.waitingOn).toEqual({ kind: 'entry-effect', occurrence: `${journal.run}/1/stamp` });
    expect(result.run.state).toBe('ready');
    expect(result.run.revision).toBe(0);
    expect(result.exit).toBe(1);
  });

  test('D4: an unknown guard answer is refused, never held', async () => {
    const { result } = await unknownGuardRun();
    const journal = result.journal;
    expect(journal.steps).toEqual([]);
    const stop = journal.outcome;
    expect(stop.kind).toBe('stopped');
    if (stop.kind !== 'stopped') return;
    expect(stop.decision).toBe('refused');
    expect(stop.code).toBe('evidence.unknown');
    expect(result.run.state).toBe('draft');
    expect(result.run.revision).toBe(0);
    expect(result.exit).toBe(1);
    expect(decisionOf(result).kind).toBe('refused');
  });

  test('D5: every effect is undispatched and an outcome names only a supplied ref', async () => {
    const { prepared, result } = await cycleRun();
    const journal = result.journal;
    expect(journal.format).toBe(1);
    expect(journal.kind).toBe('workflow-run-dry');
    expect(journal.authoritative).toBe(false);
    expect(journal.notice).toBe(NOTICE);
    expect(journal.definition).toEqual(prepared.parsed.definition);

    const allowed = ['name', 'state', 'activation', 'occurrence', 'payloadDigest', 'dispatched', 'outcome'];
    for (const effect of allEffects(journal)) {
      expect(effect.dispatched).toBe(false);
      for (const key of Object.keys(effect)) expect(allowed).toContain(key);
      expect('result' in effect).toBe(false);
      if (effect.outcome !== undefined) {
        expect(Object.keys(prepared.script.evidence)).toContain(effect.outcome);
      }
    }
  });

  test('D6: supplied approval evidence is accepted unverified and never copied', async () => {
    const { prepared, result } = await approvalRun();
    const journal = result.journal;
    expect(journal.steps.length).toBe(1);
    expect(journal.steps[0]!.transition).toEqual({ from: 'review', to: 'done', on: 'approved' });
    expect(journal.outcome).toEqual({ kind: 'script-exhausted' });
    expect(result.run.state).toBe('done');
    expect(result.exit).toBe(0);
    expect([...result.run.waits]).toEqual([{ state: 'review', activation: 1, status: 'fired' }]);

    const text = JSON.stringify(journal);
    expect(text).not.toContain('"signature"');
    expect(text).not.toContain('"verified"');
    expect(text).not.toContain('forged');
    // The supplied fixture keeps its forged fields: the runner supplied it, it did not launder it.
    expect(prepared.script.evidence['approval-1']).toMatchObject({
      signature: 'forged',
      verified: true,
    });
  });

  test('D6b: a time wait moves at or after its setting and is refused before it', async () => {
    const at = await timeAtRun();
    expect(at.result.exit).toBe(0);
    expect(at.result.run.state).toBe('done');
    expect([...at.result.run.waits]).toEqual([{ state: 'parked', activation: 1, status: 'fired' }]);

    const before = await timeBeforeRun();
    const stop = before.result.journal.outcome;
    expect(stop.kind).toBe('stopped');
    if (stop.kind !== 'stopped') return;
    expect(stop.decision).toBe('refused');
    expect(stop.code).toBe('core.wait-not-reached');
    expect(before.result.journal.steps).toEqual([]);
    expect(before.result.run.state).toBe('parked');
    expect(before.result.run.revision).toBe(0);
    expect([...before.result.run.waits]).toEqual([
      { state: 'parked', activation: 1, status: 'pending' },
    ]);
    expect(before.result.exit).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// D7–D10: the replay assembler.

describe('WF1-DRY dry replay D7–D10', () => {
  test('D7: replaying the runner journal reproduces the run', async () => {
    const { prepared, result } = await cycleRun();
    const replay = replayPrepared(prepared, JSON.stringify(result.journal));
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.exit).toBe(0);
    expect(canonicalJson(runView(replay.run))).toBe(canonicalJson(runView(result.run)));
  });

  test('D7b: a stopped journal replays to a blocked run with its revision unmoved', async () => {
    const { prepared, result } = await guardRun();
    const replay = replayPrepared(prepared, JSON.stringify(result.journal));
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.exit).toBe(0);
    expect(replay.run.state).toBe('draft');
    expect(replay.run.revision).toBe(0);
    expect(replay.run.blocked).toEqual({
      decision: 'held',
      code: 'evidence.missing',
      state: 'draft',
      revision: 0,
    });
  });

  test('D8: replay reports the first divergent step, even when later steps are tampered too', async () => {
    const { prepared, result } = await cycleRun();
    const tampered = journalJson(result.journal);
    const steps = tampered.steps as Array<Record<string, unknown>>;
    steps[1]!.requestDigest = `sha256:${'0'.repeat(64)}`;
    steps[2]!.requestDigest = `sha256:${'1'.repeat(64)}`;
    const replay = replayPrepared(prepared, JSON.stringify(tampered));
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.fail.code).toBe('workflow.replay-mismatch');
    expect(replay.fail.step).toBe(1);
  });

  test('D9: different definition bytes are refused before the fold', async () => {
    const cycle = await cycleRun();
    const other = parseOk(fixture('approval-wait.yaml'));
    const replay = cycle.prepared.mod.dryReplay({
      definitionBytes: bytes(fixture('approval-wait.yaml')),
      definition: other.workflow,
      journalText: JSON.stringify(cycle.result.journal),
      evidence: cycle.prepared.script.evidence,
      guards: guards(),
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.fail.code).toBe('workflow.definition');
  });

  test('D9b: a tampered stop revision is a journal refusal', async () => {
    const { prepared, result } = await guardRun();
    const tampered = journalJson(result.journal);
    (tampered.outcome as Record<string, unknown>).revision = 1;
    const replay = replayPrepared(prepared, JSON.stringify(tampered));
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.fail.code).toBe('workflow.journal');
  });

  test('D9c: a stop that re-evaluates to a step diverges at the terminal index', async () => {
    const { prepared, result } = await timeMissingSettingRun();
    const stop = result.journal.outcome;
    expect(stop.kind).toBe('stopped');
    if (stop.kind !== 'stopped') return;
    expect(stop.code).toBe('settings.missing');
    expect(result.journal.steps).toEqual([]);

    const tampered = journalJson(result.journal);
    (tampered.settings as Record<string, string>)['release-date'] = '2026-10-21T00:00:00.000Z';
    const replay = replayPrepared(prepared, JSON.stringify(tampered));
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.fail.code).toBe('workflow.replay-mismatch');
    expect(replay.fail.step).toBe(result.journal.steps.length);
    expect(replay.fail.why).toContain('re-evaluates to step');
  });

  test('D10: a reachable library state is refused by both entries before folding', async () => {
    const { prepared, result } = await usesRun();
    expect(result.exit).toBe(1);
    expect(result.journal.steps).toEqual([]);
    const stop = result.journal.outcome;
    expect(stop.kind).toBe('stopped');
    if (stop.kind !== 'stopped') return;
    expect(stop.decision).toBe('refused');
    expect(stop.code).toBe('workflow.uses-deferred');
    expect(stop.why).toBe(
      'state "work" uses the child library; child execution lands with the library slice, which this dry runner refuses',
    );
    expect(result.run.state).toBe('draft');
    expect(result.run.revision).toBe(0);
    expect(result.decision).toBeUndefined();
    expect(prepared.mod.reachableUses(prepared.parsed.workflow, 'draft')).toBe('work');
    expect(prepared.mod.usesDeferredWhy('work')).toBe(stop.why);

    const replay = replayPrepared(prepared, JSON.stringify(result.journal));
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.fail.code).toBe('workflow.uses-deferred');
  });
});
