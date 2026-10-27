import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { dryRunId, runWorkflow } from '../src/commands/workflow.ts';
import { buildCommandOutputSchema, ERROR_OUTPUT_SCHEMA, WORKFLOW_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { readScript } from '../src/workflow/dry/index.ts';
import { parseWorkflow } from '../src/workflow/index.ts';
import { testIo } from './helpers.ts';
import { validateAgainstJsonSchema } from './helpers/output.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-workflow-cli-')));
  dirs.push(dir);
  return dir;
}

const VALID_WORKFLOW = `workflow: build-review-merge
version: 1
initial: draft
states:
  draft: {}
  review:
    wait:
      for: approval
      role: lead
  merged: {}
transitions:
  - from: draft
    to: review
    on: pr-opened
    role: builder
  - from: review
    to: merged
    on: gate-passed
    role: integrator
`;

const CYCLE_WORKFLOW = `workflow: dry-cycle
version: 1
initial: ready
states:
  ready:
    on-enter: [stamp]
  resting:
    on-enter: [stamp]
effects:
  stamp:
    run: changelog-stamp
    role: builder
    capability: write
transitions:
  - from: ready
    to: resting
    on: pr-opened
    role: builder
  - from: resting
    to: ready
    on: pr-merged
    role: builder
`;

describe('team workflow check', () => {
  test('passes on a build-review-merge workflow in the repository context (human and --json)', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'build-review-merge.workflow.yaml'), VALID_WORKFLOW);

    const humanIo = testIo(dir);
    const code = await runWorkflow(['check', 'build-review-merge.workflow.yaml'], humanIo, { teamRoles: ['builder'] });
    expect(code).toBe(0);
    expect(humanIo.err).toBe('');
    expect(humanIo.out).toBe('team workflow check: build-review-merge.workflow.yaml: ok\n');

    const jsonIo = testIo(dir);
    const jsonCode = await runWorkflow(['check', 'build-review-merge.workflow.yaml', '--json'], jsonIo, { teamRoles: ['builder'] });
    expect(jsonCode).toBe(0);
    expect(jsonIo.err).toBe('');
    const doc = JSON.parse(jsonIo.out);
    expect(validateAgainstJsonSchema(doc, buildCommandOutputSchema(WORKFLOW_OUTPUT_SCHEMA))).toEqual([]);
    expect(doc.ok).toBe(true);
    expect(doc.path).toBe('build-review-merge.workflow.yaml');
    expect(doc.definition.workflow).toBe('build-review-merge');
    expect(doc.definition.schemaVersion).toBe(1);
    expect(doc.definition.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(doc.summary).toEqual({ refusals: 0, notes: 0 });
  });

  test('resolves team seat roles from team config in the working directory via main()', async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(
      join(dir, '.agents', 'team.yaml'),
      `format: 1
project: acme
coordinator: lead-1
operator: lead-1
trust:
  - ~/.config/team/lobby
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead-1
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: custom-specialist
    name: spec-1
    label: specialist
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`,
    );
    writeFileSync(
      join(dir, 'workflow.yaml'),
      VALID_WORKFLOW.replace('role: builder', 'role: custom-specialist'),
    );

    const io = testIo(dir);
    const code = await main(['workflow', 'check', 'workflow.yaml'], io);
    expect(code).toBe(0);
    expect(io.out).toBe('team workflow check: workflow.yaml: ok\n');
  });

  test('exits 0 with note findings when only notes (graph.orphan, provisional ref.operation) are present', async () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'workflow.yaml'),
      `workflow: with-notes
version: 1
initial: start
states:
  start:
    on-enter: [notify]
  orphan-state: {}
  done: {}
transitions:
  - from: start
    to: done
    on: pr-opened
    role: owner
effects:
  notify:
    run: release-notes
    role: owner
    capability: write
`,
    );

    const io = testIo(dir);
    const code = await runWorkflow(['check', 'workflow.yaml'], io);
    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('note: workflow.yaml:7: [graph.orphan]');
    expect(io.out).toContain('note: workflow.yaml:16: [ref.operation]');
    expect(io.out).toContain('team workflow check: workflow.yaml: ok (2 notes)\n');

    const jsonIo = testIo(dir);
    expect(await runWorkflow(['check', 'workflow.yaml', '--json'], jsonIo)).toBe(0);
    const doc = JSON.parse(jsonIo.out);
    expect(doc.ok).toBe(true);
    expect(doc.summary).toEqual({ refusals: 0, notes: 2 });
    expect(doc.findings.map((f: { code: string }) => f.code)).toEqual(['graph.orphan', 'ref.operation']);
  });

  test('exits 1 (workflow.check.refused) on schema findings and check findings, sorted by line then code', async () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'schema-bad.yaml'),
      `workflow: Bad_Name
version: 2
initial: start
states: {}
transitions: []
`,
    );

    const schemaIo = testIo(dir);
    expect(await runWorkflow(['check', 'schema-bad.yaml', '--json'], schemaIo)).toBe(1);
    const schemaDoc = JSON.parse(schemaIo.out);
    expect(validateAgainstJsonSchema(schemaDoc, buildCommandOutputSchema(WORKFLOW_OUTPUT_SCHEMA))).toEqual([]);
    expect(schemaDoc.ok).toBe(false);
    expect(schemaDoc.definition).toBeNull();
    expect(schemaDoc.summary.refusals).toBeGreaterThan(0);

    writeFileSync(
      join(dir, 'check-bad.yaml'),
      `workflow: check-bad
version: 1
initial: start
states:
  start: {}
  done: {}
transitions:
  - from: start
    to: nowhere
    on: pr-opened
    role: unknown-role
`,
    );
    const checkIo = testIo(dir);
    expect(await runWorkflow(['check', 'check-bad.yaml'], checkIo)).toBe(1);
    expect(checkIo.out).toContain('note: check-bad.yaml:6: [graph.orphan]');
    expect(checkIo.out).toContain('refusal: check-bad.yaml:8: [graph.transition]');
    expect(checkIo.out).toContain('refusal: check-bad.yaml:11: [ref.role]');
    expect(checkIo.out).toContain('team workflow check: check-bad.yaml: 2 refusals, 1 note: refused\n');
  });

  test('exits 2 on workflow.check.invocation, workflow.check.file, and workflow.check.file-invalid in both human and --json modes', async () => {
    const dir = makeTempDir();

    for (const argv of [
      ['check'],
      ['check', 'a.yaml', 'b.yaml'],
      ['check', 'a.yaml', '--nope'],
      ['check', 'a.yaml', '--dry'],
      ['check', 'a.yaml', '--script', 's.yaml'],
      ['check', 'a.yaml', '--evidence', 'e.json'],
    ]) {
      const humanIo = testIo(dir);
      expect(await runWorkflow(argv, humanIo)).toBe(2);
      expect(humanIo.err).toContain('team workflow check:');
      expect(humanIo.err).toContain('Usage: team workflow check <path> [--json]');

      const jsonIo = testIo(dir);
      expect(await runWorkflow([...argv, '--json'], jsonIo)).toBe(2);
      expect(jsonIo.err).toBe('');
      const errDoc = JSON.parse(jsonIo.out);
      expect(validateAgainstJsonSchema(errDoc, buildCommandOutputSchema(ERROR_OUTPUT_SCHEMA))).toEqual([]);
      expect(errDoc.error.id).toBe('workflow.check.invocation');
    }

    const missingHuman = testIo(dir);
    expect(await runWorkflow(['check', 'missing.yaml'], missingHuman)).toBe(2);
    expect(missingHuman.err).toContain("team workflow check: can't read missing.yaml:");

    const missingJson = testIo(dir);
    expect(await runWorkflow(['check', 'missing.yaml', '--json'], missingJson)).toBe(2);
    expect(missingJson.err).toBe('');
    const fileErr = JSON.parse(missingJson.out);
    expect(validateAgainstJsonSchema(fileErr, buildCommandOutputSchema(ERROR_OUTPUT_SCHEMA))).toEqual([]);
    expect(fileErr.error.id).toBe('workflow.check.file');

    writeFileSync(join(dir, 'broken-syntax.yaml'), 'workflow: [\n');
    const syntaxHuman = testIo(dir);
    expect(await runWorkflow(['check', 'broken-syntax.yaml'], syntaxHuman)).toBe(2);
    expect(syntaxHuman.err).toContain('team workflow check: broken-syntax.yaml:1:');

    const syntaxJson = testIo(dir);
    expect(await runWorkflow(['check', 'broken-syntax.yaml', '--json'], syntaxJson)).toBe(2);
    expect(syntaxJson.err).toBe('');
    const syntaxErr = JSON.parse(syntaxJson.out);
    expect(validateAgainstJsonSchema(syntaxErr, buildCommandOutputSchema(ERROR_OUTPUT_SCHEMA))).toEqual([]);
    expect(syntaxErr.error.id).toBe('workflow.check.file-invalid');
  });
});

describe('team workflow run and team workflow replay', () => {
  test('refuses run without --dry (workflow.dry-only, exit 1) before reading any files', async () => {
    const dir = makeTempDir();
    const humanIo = testIo(dir);
    expect(await runWorkflow(['run', 'missing.yaml'], humanIo)).toBe(1);
    expect(humanIo.out).toBe('');
    expect(humanIo.err).toBe(
      'dry run — no record is written\n' +
        'team workflow run: live workflow execution requires the Kernel workflow gate (amendment 04); pass --dry --script <path> for a dry run\n',
    );

    const jsonIo = testIo(dir);
    expect(await runWorkflow(['run', 'missing.yaml', '--json'], jsonIo)).toBe(1);
    expect(jsonIo.err).toBe('');
    const errDoc = JSON.parse(jsonIo.out);
    expect(validateAgainstJsonSchema(errDoc, buildCommandOutputSchema(ERROR_OUTPUT_SCHEMA))).toEqual([]);
    expect(errDoc.error.id).toBe('workflow.dry-only');
    expect(errDoc.error.message).toContain('Kernel workflow gate (amendment 04)');
    expect(errDoc.notice).toBe('dry run — no record is written');
  });

  test('runs a cycle with entry effects deterministically, pipes run --json into replay, and writes zero files', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'cycle.yaml'), CYCLE_WORKFLOW);
    const parsedDef = parseWorkflow(CYCLE_WORKFLOW);
    if (!('definition' in parsedDef)) throw new Error('expected cycle workflow to parse');
    const rawScript = `format: 1
target: "project://dry-cycle"
artifact:
  kind: none
inputs: {}
settings: {}
evidence:
  step-1:
    type: step
    target: "project://dry-cycle"
  merge-1:
    type: outcome
    operation: merge
    effect: merge
    target: "project://dry-cycle"
    result: done
  ev-1:
    type: outcome
    operation: changelog-stamp
    result: done
    target: "project://dry-cycle"
    effect: <run>/1/stamp
  ev-2:
    type: outcome
    operation: changelog-stamp
    result: done
    target: "project://dry-cycle"
    effect: <run>/2/stamp
signals:
  - signal: pr-opened
    at: "2026-10-21T12:00:00Z"
    request-id: req-1
    expected-revision: 0
    evidence: [step-1, ev-1]
  - signal: pr-merged
    at: "2026-10-21T12:01:00Z"
    request-id: req-2
    expected-revision: 1
    evidence: [merge-1, ev-2]
`;
    const initialScript = readScript(rawScript);
    if (!initialScript.ok) throw new Error(initialScript.why);
    const runId = dryRunId(parsedDef.definition, initialScript.script);
    const scriptText = rawScript.replaceAll('<run>', runId);
    writeFileSync(join(dir, 'script.yaml'), scriptText);

    const plainIo = testIo(dir);
    expect(await runWorkflow(['run', 'cycle.yaml', '--dry', '--script', 'script.yaml'], plainIo)).toBe(0);
    expect(plainIo.err).toBe('');
    const lines = plainIo.out.trimEnd().split('\n');
    expect(lines[0]).toBe('dry run — no record is written');
    expect(lines[1]).toContain(`run: ${runId} (dry-cycle sha256:`);
    expect(lines[2]).toBe('start: state=ready activation=1 effects=1');
    expect(lines[3]).toBe('step 1: ready -> resting on pr-opened at 2026-10-21T12:00:00Z (activation 2, effects 1)');
    expect(lines[4]).toBe('step 2: resting -> ready on pr-merged at 2026-10-21T12:01:00Z (activation 3, effects 1)');
    expect(lines[5]).toBe('team workflow run: cycle.yaml: script-exhausted (2 steps, state ready, revision 2)');

    const jsonIo1 = testIo(dir);
    const jsonIo2 = testIo(dir);
    expect(await runWorkflow(['run', 'cycle.yaml', '--dry', '--script', 'script.yaml', '--json'], jsonIo1)).toBe(0);
    expect(await runWorkflow(['run', 'cycle.yaml', '--dry', '--script', 'script.yaml', '--json'], jsonIo2)).toBe(0);
    expect(jsonIo1.err).toBe('');
    expect(jsonIo1.out).toBe(jsonIo2.out);

    const journal = JSON.parse(jsonIo1.out);
    expect(validateAgainstJsonSchema(journal, buildCommandOutputSchema(WORKFLOW_OUTPUT_SCHEMA))).toEqual([]);
    expect(journal.kind).toBe('workflow-run-dry');
    expect(journal.authoritative).toBe(false);
    expect(journal.notice).toBe('dry run — no record is written');
    expect(journal.outcome).toEqual({ kind: 'script-exhausted' });
    expect(readdirSync(dir).sort()).toEqual(['cycle.yaml', 'script.yaml']);

    writeFileSync(join(dir, 'journal.json'), jsonIo1.out);
    writeFileSync(
      join(dir, 'evidence.json'),
      JSON.stringify(
        {
          'step-1': { type: 'step', target: 'project://dry-cycle' },
          'merge-1': { type: 'outcome', operation: 'merge', effect: 'merge', target: 'project://dry-cycle', result: 'done' },
          'ev-1': { type: 'outcome', operation: 'changelog-stamp', result: 'done', target: 'project://dry-cycle', effect: `${runId}/1/stamp` },
          'ev-2': { type: 'outcome', operation: 'changelog-stamp', result: 'done', target: 'project://dry-cycle', effect: `${runId}/2/stamp` },
        },
        null,
        2,
      ),
    );

    const replayPlain = testIo(dir);
    expect(await runWorkflow(['replay', 'cycle.yaml', 'journal.json', '--evidence', 'evidence.json'], replayPlain)).toBe(0);
    expect(replayPlain.err).toBe('');
    expect(replayPlain.out).toBe(
      'dry run — no record is written\n' +
        'team workflow replay: journal.json: ok (2 steps, state ready, revision 2)\n',
    );

    const replayJson = testIo(dir);
    expect(
      await runWorkflow(['replay', 'cycle.yaml', 'journal.json', '--evidence', 'evidence.json', '--json'], replayJson),
    ).toBe(0);
    expect(replayJson.err).toBe('');
    const replayDoc = JSON.parse(replayJson.out);
    expect(validateAgainstJsonSchema(replayDoc, buildCommandOutputSchema(WORKFLOW_OUTPUT_SCHEMA))).toEqual([]);
    expect(replayDoc).toEqual({
      schema: { name: 'team.workflow', version: 1 },
      format: 1,
      kind: 'workflow-replay',
      authoritative: false,
      notice: 'dry run — no record is written',
      ok: true,
      definition: journal.definition,
      run: runId,
      stepsReplayed: 2,
      finalState: 'ready',
      revision: 2,
      activation: 3,
      blocked: null,
    });
  });

  test('stops on held/refused decisions and reachable uses: (workflow.refused, exit 1) and replays stopped journals', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'cycle.yaml'), CYCLE_WORKFLOW);
    writeFileSync(
      join(dir, 'script-held.yaml'),
      `format: 1
target: floor/teamcli#42
artifact:
  kind: none
inputs: {}
settings: {}
evidence: {}
signals:
  - signal: pr-opened
    at: "2026-10-21T12:00:00Z"
    request-id: req-1
    expected-revision: 0
    evidence: []
`,
    );

    const heldPlain = testIo(dir);
    expect(await runWorkflow(['run', 'cycle.yaml', '--dry', '--script', 'script-held.yaml'], heldPlain)).toBe(1);
    expect(heldPlain.err).toBe('');
    expect(heldPlain.out.startsWith('dry run — no record is written\n')).toBe(true);
    expect(heldPlain.out).toContain('stop: held [evidence.missing] state=ready revision=0:');
    expect(heldPlain.out).toContain(
      'team workflow run: cycle.yaml: stopped (held evidence.missing at state ready, revision 0)\n',
    );

    const heldJson = testIo(dir);
    expect(await runWorkflow(['run', 'cycle.yaml', '--dry', '--script', 'script-held.yaml', '--json'], heldJson)).toBe(1);
    expect(heldJson.err).toBe('');
    const stoppedJournal = JSON.parse(heldJson.out);
    expect(stoppedJournal.outcome.kind).toBe('stopped');
    expect(stoppedJournal.outcome.decision).toBe('held');
    expect(stoppedJournal.outcome.code).toBe('evidence.missing');

    writeFileSync(join(dir, 'stopped-journal.json'), heldJson.out);
    writeFileSync(join(dir, 'empty-evidence.json'), '{}\n');
    const replayStoppedPlain = testIo(dir);
    expect(
      await runWorkflow(['replay', 'cycle.yaml', 'stopped-journal.json', '--evidence', 'empty-evidence.json'], replayStoppedPlain),
    ).toBe(0);
    expect(replayStoppedPlain.out).toBe(
      'dry run — no record is written\n' +
        'team workflow replay: stopped-journal.json: ok (0 steps, state ready, revision 0, blocked held evidence.missing)\n',
    );

    const replayStoppedJson = testIo(dir);
    expect(
      await runWorkflow(
        ['replay', 'cycle.yaml', 'stopped-journal.json', '--evidence', 'empty-evidence.json', '--json'],
        replayStoppedJson,
      ),
    ).toBe(0);
    const replayStoppedDoc = JSON.parse(replayStoppedJson.out);
    expect(replayStoppedDoc.ok).toBe(true);
    expect(replayStoppedDoc.finalState).toBe('ready');
    expect(replayStoppedDoc.blocked?.decision).toBe('held');
    expect(replayStoppedDoc.blocked?.code).toBe('evidence.missing');
  });

  test('reports replay failures (workflow.replay-mismatch, workflow.journal, workflow.definition, workflow.evidence) and exit-2 errors', async () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'workflow.yaml'),
      `workflow: simple-two-step
version: 1
initial: draft
states:
  draft: {}
  review: {}
  merged: {}
transitions:
  - from: draft
    to: review
    on: pr-opened
    role: builder
  - from: review
    to: merged
    on: gate-passed
    role: integrator
`,
    );
    writeFileSync(
      join(dir, 'script.yaml'),
      `format: 1
target: "project://simple"
artifact:
  kind: none
inputs: {}
settings: {}
evidence:
  step-1:
    type: step
    target: "project://simple"
signals:
  - signal: pr-opened
    at: "2026-10-21T12:00:00Z"
    request-id: req-1
    expected-revision: 0
    evidence: [step-1]
`,
    );

    const runIo = testIo(dir);
    expect(await runWorkflow(['run', 'workflow.yaml', '--dry', '--script', 'script.yaml', '--json'], runIo)).toBe(0);
    const journal = JSON.parse(runIo.out);
    journal.steps[0].transition.to = 'merged';
    writeFileSync(join(dir, 'tampered.json'), `${JSON.stringify(journal, null, 2)}\n`);
    writeFileSync(join(dir, 'evidence.json'), '{"step-1":{"type":"step","target":"project://simple"}}\n');

    const mismatchJson = testIo(dir);
    expect(
      await runWorkflow(['replay', 'workflow.yaml', 'tampered.json', '--evidence', 'evidence.json', '--json'], mismatchJson),
    ).toBe(1);
    const mismatchDoc = JSON.parse(mismatchJson.out);
    expect(validateAgainstJsonSchema(mismatchDoc, buildCommandOutputSchema(WORKFLOW_OUTPUT_SCHEMA))).toEqual([]);
    expect(mismatchDoc.ok).toBe(false);
    expect(mismatchDoc.reason.code).toBe('workflow.replay-mismatch');
    expect(mismatchDoc.reason.step).toBe(0);
    expect(mismatchDoc.reason.expected).toBeDefined();
    expect(mismatchDoc.reason.actual).toBeDefined();

    writeFileSync(join(dir, 'bad-evidence.json'), '[]\n');
    writeFileSync(join(dir, 'good-journal.json'), runIo.out);
    const badEvJson = testIo(dir);
    expect(
      await runWorkflow(['replay', 'workflow.yaml', 'good-journal.json', '--evidence', 'bad-evidence.json', '--json'], badEvJson),
    ).toBe(1);
    const badEvDoc = JSON.parse(badEvJson.out);
    expect(badEvDoc.ok).toBe(false);
    expect(badEvDoc.reason.code).toBe('workflow.evidence');

    for (const argv of [
      [],
      ['nope'],
      ['run'],
      ['run', 'workflow.yaml', '--dry'],
      ['run', 'workflow.yaml', '--dry', '--script', 'script.yaml', '--evidence', 'evidence.json'],
      ['replay'],
      ['replay', 'workflow.yaml'],
      ['replay', 'workflow.yaml', 'good-journal.json'],
      ['replay', 'workflow.yaml', 'good-journal.json', '--evidence', 'evidence.json', '--dry'],
    ]) {
      const plainInv = testIo(dir);
      expect(await runWorkflow(argv, plainInv)).toBe(2);
      expect(plainInv.out).toBe('');
      expect(plainInv.err.startsWith('dry run — no record is written\n')).toBe(true);

      const invIo = testIo(dir);
      expect(await runWorkflow([...argv, '--json'], invIo)).toBe(2);
      const errDoc = JSON.parse(invIo.out);
      expect(errDoc.error.id).toBe('workflow.invocation');
      expect(errDoc.notice).toBe('dry run — no record is written');
    }
  });
});
