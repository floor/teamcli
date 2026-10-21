// Independent CLI acceptance for `team workflow run --dry` and `team workflow replay` at B3's
// published pin 5283e7ce (branch feat/wf1-cli), authored from the public contract only:
// wf0-spec-slices-0-1.md §5 (commands, dry-only refusal, script and evidence rules, the journal
// boundary, replay re-evaluation, invariants), the Zeus ruling of 2026-10-21 line 8 ("Every
// output says \"dry run — no record is written\""), contract/cli.json and
// contract/exit-codes.json at the pin, and the real `runWorkflow` seam. Every fixture here was
// authored independently; no builder test or fixture was copied, and no expectation is taken
// from a builder test.
//
// The file is written against the seam that already exists on main (`runWorkflow` with `check`
// only), so at the honest baseline every run/replay row is red on its behavior, not on an
// import. The same bytes are then measured at the pin.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from '../../../src/commands/workflow.ts';
import type { DryRunJournal } from '../../../src/workflow/types.ts';
import { testIo } from '../../helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');
const NOTICE = 'dry run — no record is written';
const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Scene = {
  dir: string;
  path(name: string): string;
  write(name: string, text: string): void;
  bytes(name: string): Buffer;
  list(): string[];
};

/** A fresh folder holding every fixture byte-for-byte, so argv paths are short and stable. */
function scene(): Scene {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-workflow-cli-dry-')));
  dirs.push(dir);
  for (const name of readdirSync(FIXTURES)) {
    writeFileSync(join(dir, name), readFileSync(join(FIXTURES, name)));
  }
  return {
    dir,
    path: (name) => join(dir, name),
    write: (name, text) => writeFileSync(join(dir, name), text),
    bytes: (name) => readFileSync(join(dir, name)),
    list: () => readdirSync(dir).sort(),
  };
}

type Call = { code: number; out: string; err: string };

async function cli(s: Scene, argv: string[]): Promise<Call> {
  const io = testIo(s.dir);
  const code = await runWorkflow(argv, io, { teamRoles: ['builder'] });
  return { code, out: io.out, err: io.err };
}

function journalOf(call: Call): DryRunJournal {
  return JSON.parse(call.out) as DryRunJournal;
}

type ReplayDoc = {
  schema?: { name: string; version: number };
  format: 1;
  kind: 'workflow-replay';
  authoritative: false;
  notice: string;
  ok: boolean;
  definition?: { workflow: string; schemaVersion: number; digest: string };
  run?: string;
  stepsReplayed?: number;
  finalState?: string;
  revision?: number;
  activation?: number;
  blocked?: { decision: string; code: string } | null;
  reason?: { code: string; why: string; step?: number; expected?: unknown; actual?: unknown };
};

function replayDocOf(call: Call): ReplayDoc {
  return JSON.parse(call.out) as ReplayDoc;
}

const RUN_GREEN = ['run', 'definition-green.yaml', '--dry', '--script', 'script-green.yaml'];

/** The exact plain report the pinned command contract defines for a run. */
function expectedRunReport(path: string, doc: DryRunJournal): string {
  const lines = [
    doc.notice,
    `run: ${doc.run} (${doc.definition.workflow} ${doc.definition.digest})`,
    `start: state=${doc.start.state} activation=${doc.start.activation} effects=${doc.start.effects.length}`,
  ];
  for (const step of doc.steps) {
    lines.push(
      `step ${step.revision}: ${step.transition.from} -> ${step.transition.to} on ${step.signal} at ${step.at} (activation ${step.activation}, effects ${step.effects.length})`,
    );
  }
  if (doc.outcome.kind === 'script-exhausted') {
    const finalState = doc.steps.length > 0 ? doc.steps[doc.steps.length - 1]!.transition.to : doc.initial;
    const count = doc.steps.length === 1 ? '1 step' : `${doc.steps.length} steps`;
    lines.push(`team workflow run: ${path}: script-exhausted (${count}, state ${finalState}, revision ${doc.steps.length})`);
  } else {
    lines.push(`team workflow run: ${path}: stopped (${doc.outcome.decision} ${doc.outcome.code} at state ${doc.outcome.state}, revision ${doc.outcome.revision})`);
  }
  return `${lines.join('\n')}\n`;
}

describe('team workflow run --dry: published surface', () => {
  test('a green run prints the notice first, the step lines, and exits 0', async () => {
    const s = scene();
    const json = await cli(s, [...RUN_GREEN, '--json']);
    expect(json.code).toBe(0);
    expect(json.err).toBe('');
    const doc = journalOf(json);

    expect('schema' in (doc as unknown as Record<string, unknown>)).toBe(false);
    expect(doc.format).toBe(1);
    expect(doc.kind).toBe('workflow-run-dry');
    expect(doc.authoritative).toBe(false);
    expect(doc.notice).toBe(NOTICE);
    expect(doc.definition.workflow).toBe('dry-cli-green');
    expect(doc.definition.digest).toMatch(DIGEST);
    expect(doc.run).toMatch(RUN_ID);
    expect(doc.target).toBe('project://dry-cli');
    expect(doc.initial).toBe('draft');
    expect(doc.start).toEqual({ state: 'draft', activation: 1, effects: [] });
    expect(doc.steps).toHaveLength(1);
    const step = doc.steps[0]!;
    expect(step.revision).toBe(1);
    expect(step.signal).toBe('pr-opened');
    expect(step.at).toBe('2026-10-21T00:00:00.000Z');
    expect(step.transition).toEqual({ from: 'draft', to: 'live', on: 'pr-opened' });
    expect(step.evidence).toEqual(['step-1']);
    expect(step.effects).toEqual([]);
    expect(doc.outcome).toEqual({ kind: 'script-exhausted' });

    const plain = await cli(s, RUN_GREEN);
    expect(plain.code).toBe(0);
    expect(plain.err).toBe('');
    expect(plain.out).toBe(expectedRunReport('definition-green.yaml', doc));
    expect(plain.out.split('\n')[0]).toBe(NOTICE);
  });

  test('a run writes nothing: fixture bytes and the folder listing are unchanged', async () => {
    const s = scene();
    const before = s.list();
    const greenBytes = s.bytes('definition-green.yaml');
    const plain = await cli(s, RUN_GREEN);
    expect(plain.code).toBe(0);
    expect(s.list()).toEqual(before);
    expect(s.bytes('definition-green.yaml')).toEqual(greenBytes);
    expect(s.bytes('script-green.yaml')).toEqual(readFileSync(join(FIXTURES, 'script-green.yaml')));
  });

  test('a missing guard holds the run at revision 0 and exits 1', async () => {
    const s = scene();
    const json = await cli(s, ['run', 'definition-guard.yaml', '--dry', '--script', 'script-guard-missing.yaml', '--json']);
    expect(json.code).toBe(1);
    expect(json.err).toBe('');
    const doc = journalOf(json);
    expect(doc.outcome).not.toEqual({ kind: 'script-exhausted' });
    if (doc.outcome.kind !== 'stopped') throw new Error('expected a stopped journal');
    expect(doc.outcome.decision).toBe('held');
    expect(doc.outcome.code).toBe('evidence.missing');
    expect(doc.outcome.state).toBe('draft');
    expect(doc.outcome.revision).toBe(0);
    expect(doc.outcome.evidence).toEqual(['step-1']);
    expect(doc.steps).toEqual([]);

    const plain = await cli(s, ['run', 'definition-guard.yaml', '--dry', '--script', 'script-guard-missing.yaml']);
    expect(plain.code).toBe(1);
    expect(plain.err).toBe('');
    const lines = plain.out.split('\n');
    expect(lines[0]).toBe(NOTICE);
    expect(lines[1]).toBe(`run: ${doc.run} (dry-cli-guard ${doc.definition.digest})`);
    expect(lines[2]).toBe('start: state=draft activation=1 effects=0');
    expect(lines[3]).toMatch(/^stop: held \[evidence\.missing\] state=draft revision=0: .+$/);
    expect(lines[4]).toBe('team workflow run: definition-guard.yaml: stopped (held evidence.missing at state draft, revision 0)');
  });

  test('an unknown guard answer refuses the run and exits 1', async () => {
    const s = scene();
    const json = await cli(s, ['run', 'definition-guard.yaml', '--dry', '--script', 'script-guard-unknown.yaml', '--json']);
    expect(json.code).toBe(1);
    const doc = journalOf(json);
    if (doc.outcome.kind !== 'stopped') throw new Error('expected a stopped journal');
    expect(doc.outcome.decision).toBe('refused');
    expect(doc.outcome.code).toBe('evidence.unknown');
    expect(doc.outcome.evidence).toEqual(['step-1', 'ci-1']);

    const plain = await cli(s, ['run', 'definition-guard.yaml', '--dry', '--script', 'script-guard-unknown.yaml']);
    expect(plain.code).toBe(1);
    expect(plain.out.split('\n')[4]).toBe(
      'team workflow run: definition-guard.yaml: stopped (refused evidence.unknown at state draft, revision 0)',
    );
  });

  test('a time wait refuses before its setting and accepts at or after it', async () => {
    const s = scene();
    const before = await cli(s, ['run', 'definition-time.yaml', '--dry', '--script', 'script-time-before.yaml', '--json']);
    expect(before.code).toBe(1);
    const beforeDoc = journalOf(before);
    if (beforeDoc.outcome.kind !== 'stopped') throw new Error('expected a stopped journal');
    expect(beforeDoc.outcome.decision).toBe('refused');
    expect(beforeDoc.outcome.code).toBe('core.wait-not-reached');

    const at = await cli(s, ['run', 'definition-time.yaml', '--dry', '--script', 'script-time-at.yaml', '--json']);
    expect(at.code).toBe(0);
    const atDoc = journalOf(at);
    expect(atDoc.outcome).toEqual({ kind: 'script-exhausted' });
    expect(atDoc.steps).toHaveLength(1);
    expect(atDoc.steps[0]!.signal).toBe('time-reached');
  });

  test('a time wait with no setting holds on settings.missing', async () => {
    const s = scene();
    const json = await cli(s, ['run', 'definition-time.yaml', '--dry', '--script', 'script-time-missing-setting.yaml', '--json']);
    expect(json.code).toBe(1);
    const doc = journalOf(json);
    if (doc.outcome.kind !== 'stopped') throw new Error('expected a stopped journal');
    expect(doc.outcome.decision).toBe('held');
    expect(doc.outcome.code).toBe('settings.missing');
    expect(doc.outcome.waitingOn).toEqual({ kind: 'setting', name: 'release-date' });
  });

  test('a reachable uses: stops the run as refused at that state, exit 1', async () => {
    const s = scene();
    const json = await cli(s, ['run', 'definition-uses.yaml', '--dry', '--script', 'script-uses.yaml', '--json']);
    expect(json.code).toBe(1);
    expect(json.err).toBe('');
    const doc = journalOf(json);
    expect(doc.kind).toBe('workflow-run-dry');
    if (doc.outcome.kind !== 'stopped') throw new Error('expected a stopped journal');
    expect(doc.outcome.decision).toBe('refused');
    expect(doc.outcome.code).toBe('workflow.uses-deferred');
    expect(doc.outcome.state).toBe('work');
    expect(doc.outcome.revision).toBe(0);
    expect(doc.outcome.why).toContain('uses the child library');
    expect(doc.steps).toEqual([]);

    const plain = await cli(s, ['run', 'definition-uses.yaml', '--dry', '--script', 'script-uses.yaml']);
    expect(plain.code).toBe(1);
    expect(plain.err).toBe('');
    const lines = plain.out.split('\n');
    expect(lines[0]).toBe(NOTICE);
    expect(lines[3]).toMatch(/^stop: refused \[workflow\.uses-deferred\] state=work revision=0: .+$/);
    expect(lines[4]).toBe('team workflow run: definition-uses.yaml: stopped (refused workflow.uses-deferred at state work, revision 0)');
  });
});

describe('team workflow run --dry: invocation, file and script refusals', () => {
  test('no subcommand and an unknown subcommand are invocation refusals on the workflow group', async () => {
    const s = scene();
    const none = await cli(s, []);
    expect(none.code).toBe(2);
    expect(none.out).toBe('');
    expect(none.err).toContain('team workflow: a subcommand is required: check, run, or replay');
    expect(none.err).toContain('Usage: team workflow check');

    const unknown = await cli(s, ['nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('team workflow: unknown subcommand "nope"');
  });

  test('run validates its arguments in the published order', async () => {
    const s = scene();
    const noPath = await cli(s, ['run']);
    expect(noPath.code).toBe(2);
    expect(noPath.err).toContain('team workflow run: a <path> is required');

    const twoPaths = await cli(s, ['run', 'a.yaml', 'b.yaml']);
    expect(twoPaths.code).toBe(2);
    expect(twoPaths.err).toContain('team workflow run: one <path> at most');

    const evidence = await cli(s, ['run', 'definition-green.yaml', '--dry', '--script', 'script-green.yaml', '--evidence', 'evidence-green.json']);
    expect(evidence.code).toBe(2);
    expect(evidence.err).toContain('team workflow run: workflow run takes no --evidence');

    const noScript = await cli(s, ['run', 'definition-green.yaml', '--dry']);
    expect(noScript.code).toBe(2);
    expect(noScript.err).toContain('team workflow run: --script <path> is required with --dry');

    const scriptNoValue = await cli(s, ['run', 'definition-green.yaml', '--dry', '--script']);
    expect(scriptNoValue.code).toBe(2);
    expect(scriptNoValue.err).toContain('team workflow run: --script needs a value');
  });

  test('run without --dry is refused as dry-only before the script and before any read', async () => {
    const s = scene();
    const plain = await cli(s, ['run', 'definition-green.yaml']);
    expect(plain.code).toBe(1);
    expect(plain.out).toBe('');
    expect(plain.err).toContain('team workflow run: live workflow execution requires the Kernel workflow gate (amendment 04)');
    expect(plain.err).toContain('pass --dry --script <path> for a dry run');

    const json = await cli(s, ['run', 'definition-green.yaml', '--json']);
    expect(json.code).toBe(1);
    expect(json.err).toBe('');
    const error = JSON.parse(json.out) as { schema: { name: string }; error: { id: string; message: string } };
    expect(error.schema.name).toBe('team.error');
    expect(error.error.id).toBe('workflow.dry-only');
  });

  test('unreadable definition and script are file refusals, exit 2', async () => {
    const s = scene();
    const noDefinition = await cli(s, ['run', 'missing-definition.yaml', '--dry', '--script', 'script-green.yaml']);
    expect(noDefinition.code).toBe(2);
    expect(noDefinition.err).toContain("team workflow run: can't read missing-definition.yaml:");

    const noScript = await cli(s, ['run', 'definition-green.yaml', '--dry', '--script', 'missing-script.yaml']);
    expect(noScript.code).toBe(2);
    expect(noScript.err).toContain("team workflow run: can't read missing-script.yaml:");
  });

  test('an invalid or refused definition is a workflow.file refusal, exit 2', async () => {
    const s = scene();
    const invalid = await cli(s, ['run', 'definition-invalid.yaml', '--dry', '--script', 'script-green.yaml']);
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain('team workflow run: definition-invalid.yaml:');

    const refused = await cli(s, ['run', 'definition-refused.yaml', '--dry', '--script', 'script-green.yaml']);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('team workflow run: definition-refused.yaml:');
  });

  test('a malformed script is workflow.script and a malformed script fixture is workflow.evidence', async () => {
    const s = scene();
    const script = await cli(s, ['run', 'definition-green.yaml', '--dry', '--script', 'script-bad-key.yaml']);
    expect(script.code).toBe(1);
    expect(script.out).toBe('');
    expect(script.err).toContain('team workflow run: script-bad-key.yaml:');
    expect(script.err).toContain('unknown key "note"');

    const scriptJson = await cli(s, ['run', 'definition-green.yaml', '--dry', '--script', 'script-bad-key.yaml', '--json']);
    expect(scriptJson.code).toBe(1);
    const scriptError = JSON.parse(scriptJson.out) as { error: { id: string } };
    expect(scriptError.error.id).toBe('workflow.script');

    const evidence = await cli(s, ['run', 'definition-green.yaml', '--dry', '--script', 'script-bad-evidence.yaml']);
    expect(evidence.code).toBe(1);
    expect(evidence.err).toContain('team workflow run: script-bad-evidence.yaml:');
    const evidenceJson = await cli(s, ['run', 'definition-green.yaml', '--dry', '--script', 'script-bad-evidence.yaml', '--json']);
    expect(evidenceJson.code).toBe(1);
    const evidenceError = JSON.parse(evidenceJson.out) as { error: { id: string } };
    expect(evidenceError.error.id).toBe('workflow.evidence');
  });

  test('--json as the value of --script is a path, not JSON output', async () => {
    const s = scene();
    const call = await cli(s, ['run', 'definition-green.yaml', '--dry', '--script', '--json']);
    expect(call.code).toBe(2);
    expect(call.out).toBe('');
    expect(call.err).toContain("team workflow run: can't read --json:");
  });
});

describe('team workflow replay', () => {
  async function greenScene(): Promise<{ s: Scene; journal: DryRunJournal }> {
    const s = scene();
    const json = await cli(s, [...RUN_GREEN, '--json']);
    expect(json.code).toBe(0);
    const journal = journalOf(json);
    s.write('journal-green.json', `${JSON.stringify(journal, null, 2)}\n`);
    return { s, journal };
  }

  test('a journal written by run --json replays green with the notice line first', async () => {
    const { s, journal } = await greenScene();
    const plain = await cli(s, ['replay', 'definition-green.yaml', 'journal-green.json', '--evidence', 'evidence-green.json']);
    expect(plain.code).toBe(0);
    expect(plain.err).toBe('');
    expect(plain.out).toBe(
      `${NOTICE}\nteam workflow replay: journal-green.json: ok (1 step, state live, revision 1)\n`,
    );

    const json = await cli(s, ['replay', 'definition-green.yaml', 'journal-green.json', '--evidence', 'evidence-green.json', '--json']);
    expect(json.code).toBe(0);
    expect(json.err).toBe('');
    const doc = replayDocOf(json);
    expect(doc.schema).toEqual({ name: 'team.workflow', version: 1 });
    expect(doc.format).toBe(1);
    expect(doc.kind).toBe('workflow-replay');
    expect(doc.authoritative).toBe(false);
    expect(doc.notice).toBe(NOTICE);
    expect(doc.ok).toBe(true);
    expect(doc.definition).toEqual(journal.definition);
    expect(doc.run).toBe(journal.run);
    expect(doc.stepsReplayed).toBe(1);
    expect(doc.finalState).toBe('live');
    expect(doc.revision).toBe(1);
    expect(typeof doc.activation).toBe('number');
    expect(doc.blocked).toBeNull();
  });

  test('a stopped journal replays ok and reports the blocked decision', async () => {
    const s = scene();
    const runJson = await cli(s, ['run', 'definition-guard.yaml', '--dry', '--script', 'script-guard-missing.yaml', '--json']);
    expect(runJson.code).toBe(1);
    const journal = journalOf(runJson);
    if (journal.outcome.kind !== 'stopped') throw new Error('expected a stopped journal');
    s.write('journal-stopped.json', `${JSON.stringify(journal, null, 2)}\n`);

    const plain = await cli(s, ['replay', 'definition-guard.yaml', 'journal-stopped.json', '--evidence', 'evidence-green.json']);
    expect(plain.code).toBe(0);
    expect(plain.out).toBe(
      `${NOTICE}\nteam workflow replay: journal-stopped.json: ok (0 steps, state draft, revision 0, blocked held evidence.missing)\n`,
    );

    const json = await cli(s, ['replay', 'definition-guard.yaml', 'journal-stopped.json', '--evidence', 'evidence-green.json', '--json']);
    expect(json.code).toBe(0);
    const doc = replayDocOf(json);
    expect(doc.ok).toBe(true);
    expect(doc.blocked).toMatchObject({ decision: 'held', code: 'evidence.missing' });
  });

  test('a tampered revision is the first divergent step, exit 1', async () => {
    const { s } = await greenScene();
    const journal = JSON.parse(readFileSync(s.path('journal-green.json'), 'utf8')) as DryRunJournal;
    (journal.steps[0] as { revision: number }).revision = 99;
    s.write('journal-tampered.json', `${JSON.stringify(journal, null, 2)}\n`);

    const plain = await cli(s, ['replay', 'definition-green.yaml', 'journal-tampered.json', '--evidence', 'evidence-green.json']);
    expect(plain.code).toBe(1);
    expect(plain.err).toBe('');
    const lines = plain.out.split('\n');
    expect(lines[0]).toBe(NOTICE);
    expect(lines[1]).toMatch(/^team workflow replay: journal-tampered\.json: \[workflow\.replay-mismatch\] .+: refused$/);

    const json = await cli(s, ['replay', 'definition-green.yaml', 'journal-tampered.json', '--evidence', 'evidence-green.json', '--json']);
    expect(json.code).toBe(1);
    const doc = replayDocOf(json);
    expect(doc.ok).toBe(false);
    expect(doc.reason?.code).toBe('workflow.replay-mismatch');
    expect(doc.reason?.step).toBe(0);
    expect('expected' in (doc.reason ?? {})).toBe(true);
    expect('actual' in (doc.reason ?? {})).toBe(true);
  });

  test('a different definition is workflow.definition, exit 1', async () => {
    const { s } = await greenScene();
    const plain = await cli(s, ['replay', 'definition-guard.yaml', 'journal-green.json', '--evidence', 'evidence-green.json']);
    expect(plain.code).toBe(1);
    expect(plain.out.split('\n')[1]).toMatch(/\[workflow\.definition\] .+: refused$/);
    const json = await cli(s, ['replay', 'definition-guard.yaml', 'journal-green.json', '--evidence', 'evidence-green.json', '--json']);
    const doc = replayDocOf(json);
    expect(doc.reason?.code).toBe('workflow.definition');
  });

  test('a journal that is not JSON and a journal with the wrong shape are workflow.journal', async () => {
    const { s } = await greenScene();
    s.write('not-json.txt', 'this is not json\n');
    const notJson = await cli(s, ['replay', 'definition-green.yaml', 'not-json.txt', '--evidence', 'evidence-green.json']);
    expect(notJson.code).toBe(1);
    expect(notJson.out.split('\n')[1]).toMatch(/\[workflow\.journal\] .+: refused$/);

    const journal = JSON.parse(readFileSync(s.path('journal-green.json'), 'utf8')) as Record<string, unknown>;
    delete journal.format;
    s.write('journal-shape.json', `${JSON.stringify(journal, null, 2)}\n`);
    const shape = await cli(s, ['replay', 'definition-green.yaml', 'journal-shape.json', '--evidence', 'evidence-green.json', '--json']);
    expect(shape.code).toBe(1);
    expect(replayDocOf(shape).reason?.code).toBe('workflow.journal');
  });

  test('missing evidence refs and malformed evidence files are workflow.evidence, exit 1', async () => {
    const { s } = await greenScene();
    const missingRef = await cli(s, ['replay', 'definition-green.yaml', 'journal-green.json', '--evidence', 'evidence-empty.json', '--json']);
    expect(missingRef.code).toBe(1);
    expect(replayDocOf(missingRef).reason?.code).toBe('workflow.evidence');

    for (const name of ['evidence-array.json', 'evidence-malformed.json']) {
      const call = await cli(s, ['replay', 'definition-green.yaml', 'journal-green.json', '--evidence', name, '--json']);
      expect(call.code).toBe(1);
      expect(replayDocOf(call).reason?.code).toBe('workflow.evidence');
    }
  });

  test('replay validates its arguments in the published order', async () => {
    const s = scene();
    const noArgs = await cli(s, ['replay']);
    expect(noArgs.code).toBe(2);
    expect(noArgs.err).toContain('team workflow replay: <definition> and <journal> are required');

    const noJournal = await cli(s, ['replay', 'definition-green.yaml']);
    expect(noJournal.code).toBe(2);
    expect(noJournal.err).toContain('team workflow replay: a <journal> is required');

    const noEvidence = await cli(s, ['replay', 'definition-green.yaml', 'journal-green.json']);
    expect(noEvidence.code).toBe(2);
    expect(noEvidence.err).toContain('team workflow replay: --evidence <path> is required');

    const tooMany = await cli(s, ['replay', 'definition-green.yaml', 'journal-green.json', 'extra.json', '--evidence', 'evidence-green.json']);
    expect(tooMany.code).toBe(2);
    expect(tooMany.err).toContain('team workflow replay: <definition> and <journal> at most');

    const dry = await cli(s, ['replay', 'definition-green.yaml', 'journal-green.json', '--evidence', 'evidence-green.json', '--dry']);
    expect(dry.code).toBe(2);
    expect(dry.err).toContain('team workflow replay: workflow replay takes no --dry');

    const script = await cli(s, ['replay', 'definition-green.yaml', 'journal-green.json', '--evidence', 'evidence-green.json', '--script', 'script-green.yaml']);
    expect(script.code).toBe(2);
    expect(script.err).toContain('team workflow replay: workflow replay takes no --script');
  });

  test('unreadable definition, journal and evidence are file refusals, exit 2, in read order', async () => {
    const { s } = await greenScene();
    const noDefinition = await cli(s, ['replay', 'missing-definition.yaml', 'journal-green.json', '--evidence', 'evidence-green.json']);
    expect(noDefinition.code).toBe(2);
    expect(noDefinition.err).toContain("team workflow replay: can't read missing-definition.yaml:");

    const noJournal = await cli(s, ['replay', 'definition-green.yaml', 'missing-journal.json', '--evidence', 'missing-evidence.json']);
    expect(noJournal.code).toBe(2);
    expect(noJournal.err).toContain("team workflow replay: can't read missing-journal.json:");
    expect(noJournal.err).not.toContain('missing-evidence.json');

    const noEvidence = await cli(s, ['replay', 'definition-green.yaml', 'journal-green.json', '--evidence', 'missing-evidence.json']);
    expect(noEvidence.code).toBe(2);
    expect(noEvidence.err).toContain("team workflow replay: can't read missing-evidence.json:");
  });
});

describe('team workflow check keeps its published surface', () => {
  test('check refuses the run and replay options with its own invocation id', async () => {
    const s = scene();
    for (const [option, message] of [
      [['--dry'], 'workflow check takes no --dry'],
      [['--script', 'script-green.yaml'], 'workflow check takes no --script'],
      [['--evidence', 'evidence-green.json'], 'workflow check takes no --evidence'],
    ] as Array<[string[], string]>) {
      const call = await cli(s, ['check', 'definition-green.yaml', ...option]);
      expect(call.code).toBe(2);
      expect(call.out).toBe('');
      expect(call.err).toContain(`team workflow check: ${message}`);
      const json = await cli(s, ['check', 'definition-green.yaml', ...option, '--json']);
      expect(json.code).toBe(2);
      const error = JSON.parse(json.out) as { error: { id: string } };
      expect(error.error.id).toBe('workflow.check.invocation');
    }
  });
});

// The accepted Zeus ruling of 2026-10-21, line 8: "Every output says \"dry run — no record is
// written\"". The ruling does not pin where in an output the sentence sits, so these rows assert
// only that it is present, on every run and replay path that can refuse before a journal exists.
// At the published pin those helpers call ordinary `refuse`, so if the sentence is absent the
// rows fail against the accepted contract and the discrepancy is reported to the builder.
describe('dry notice on every output (Zeus ruling line 8)', () => {
  const preJournal: Array<[string, string[]]> = [
    ['run invocation refusal', ['run']],
    ['run file refusal', ['run', 'definition-green.yaml', '--dry', '--script', 'missing-script.yaml']],
    ['run dry-only refusal', ['run', 'definition-green.yaml']],
    ['run script refusal', ['run', 'definition-green.yaml', '--dry', '--script', 'script-bad-key.yaml']],
    ['run evidence refusal', ['run', 'definition-green.yaml', '--dry', '--script', 'script-bad-evidence.yaml']],
    ['replay invocation refusal', ['replay']],
    ['replay file refusal', ['replay', 'definition-green.yaml', 'missing-journal.json', '--evidence', 'missing-evidence.json']],
  ];

  for (const [name, argv] of preJournal) {
    test(`${name} says the dry notice`, async () => {
      const s = scene();
      const call = await cli(s, argv);
      expect(call.code).not.toBe(0);
      expect(call.err + call.out).toContain(NOTICE);
    });
  }

  test('the --json error document says the dry notice', async () => {
    const s = scene();
    for (const argv of [['run', '--json'], ['run', 'definition-green.yaml', '--json']] as string[][]) {
      const call = await cli(s, argv);
      expect(call.code).not.toBe(0);
      const doc = JSON.parse(call.out) as { error: { id: string } };
      expect(doc.error.id).toMatch(/^workflow\./);
      expect(call.out).toContain(NOTICE);
    }
  });

  test('no run or replay output claims a recovery', async () => {
    const s = scene();
    const calls = [
      await cli(s, RUN_GREEN),
      await cli(s, ['run', 'definition-guard.yaml', '--dry', '--script', 'script-guard-missing.yaml']),
    ];
    for (const call of calls) {
      expect(`${call.out}${call.err}`.toLowerCase()).not.toContain('recovery');
    }
  });
});
