import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { runWorkflow } from '../src/commands/workflow.ts';
import { WORKFLOW_OUTPUT_SCHEMA, buildCommandOutputSchema, ERROR_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { validateAgainstJsonSchema } from './helpers/output.ts';
import { testIo } from './helpers.ts';

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

  test('resolves team seat roles from .agents/team.yaml in the working directory via main()', async () => {
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

    // 1. workflow.check.invocation (missing subcommand, unknown subcommand, missing path, extra path, unknown option)
    for (const argv of [[], ['run'], ['check'], ['check', 'a.yaml', 'b.yaml'], ['check', 'a.yaml', '--nope']]) {
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

    // 2. workflow.check.file (missing/unreadable file)
    const missingHuman = testIo(dir);
    expect(await runWorkflow(['check', 'missing.yaml'], missingHuman)).toBe(2);
    expect(missingHuman.err).toContain("team workflow check: can't read missing.yaml:");

    const missingJson = testIo(dir);
    expect(await runWorkflow(['check', 'missing.yaml', '--json'], missingJson)).toBe(2);
    expect(missingJson.err).toBe('');
    const fileErr = JSON.parse(missingJson.out);
    expect(validateAgainstJsonSchema(fileErr, buildCommandOutputSchema(ERROR_OUTPUT_SCHEMA))).toEqual([]);
    expect(fileErr.error.id).toBe('workflow.check.file');

    // 3. workflow.check.file-invalid (broken YAML syntax and non-mapping root)
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
