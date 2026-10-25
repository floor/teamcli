// Independent acceptance for `team workflow check <path> [--json]` (RC054-WF0-CLI).
//
// Derived from the published contract at the CLI head: docs/commands/workflow.md (synopsis,
// caller table, output/exit table, note/refusal wording and ordering), contract/cli.json and
// contract/exit-codes.json (exit ids), and schema/workflow.schema.json + schema/error.schema.json
// (the `team.workflow` and `team.error` documents). It spawns the real CLI against synthetic
// projects and a synthetic HOME, so exit codes, stderr discipline, JSON documents and read-only
// behavior are observed as a caller sees them. No source module is imported, so the same file runs
// unchanged at main for the red baseline and at the CLI head for the green measurement.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

const TEAM = `format: 1
project: wf0-acceptance
coordinator: wf0-lead
operator: wf0-lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: wf0-lead
    label: wf0-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: builder
    name: wf0-builder
    label: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const CLEAN = `workflow: review-pass
version: 1
initial: draft
states:
  draft: {}
  complete: {}
transitions:
  - from: draft
    to: complete
    on: pr-opened
    role: builder
`;

// One declared state is never entered: a provisional note on a passing check.
const NOTED = `workflow: noted-pass
version: 1
initial: draft
states:
  draft: {}
  complete: {}
  parked: {}
transitions:
  - from: draft
    to: complete
    on: pr-opened
    role: builder
`;

// The documentation's refusal example: an undeclared target state and an unknown role, plus the
// orphan note the same definition produces.
const BROKEN = `workflow: broken-pass
version: 1
initial: draft
states:
  draft: {}
  complete: {}
transitions:
  - from: draft
    to: missing
    on: pr-opened
    role: ghost
`;

const UNKNOWN_SIGNAL = `workflow: signal-pass
version: 1
initial: draft
states:
  draft: {}
  complete: {}
transitions:
  - from: draft
    to: complete
    on: tick
    role: builder
`;

const EXTRA_KEY = `workflow: extra-pass
version: 1
initial: draft
extra: 1
states:
  draft: {}
  complete: {}
transitions:
  - from: draft
    to: complete
    on: pr-opened
    role: builder
`;

const STRUCTURAL_ROLE = `workflow: structural-pass
version: 1
initial: draft
states:
  draft: {}
  complete: {}
transitions:
  - from: draft
    to: complete
    on: pr-opened
    role: lead
`;

type Ran = { status: number; stdout: string; stderr: string };

type World = {
  home: string;
  project: string;
  write: (name: string, text: string) => void;
  run: (args: string[], cwd?: string) => Ran;
};

function world(): World {
  const root = mkdtempSync(join(tmpdir(), 'wf0-cli-acceptance-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(project, '.agents'), { recursive: true });
  writeFileSync(join(project, '.agents', 'team.yaml'), TEAM);
  const write = (name: string, text: string): void => {
    writeFileSync(join(project, name), text);
  };
  const run = (args: string[], cwd = project): Ran => {
    const result = spawnSync(process.execPath, [CLI, 'workflow', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TEAM_CONFIG_SOURCE: 'file',
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        // The spawned runtime would otherwise fill the synthetic HOME with its own transpiler
        // cache; disabled, the home snapshot sees only writes the command itself makes.
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      },
    });
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { home, project, write, run };
}

// A byte-level snapshot of a tree: paths, sizes, mtimes and content hashes.
function manifest(root: string): string[] {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      const info = lstatSync(full);
      if (entry.isDirectory()) {
        rows.push(`dir ${rel}`);
        walk(full);
      } else if (entry.isFile()) {
        const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
        rows.push(`file ${rel} ${info.size} ${info.mtimeMs} ${digest}`);
      } else {
        rows.push(`other ${rel} ${info.mode}`);
      }
    }
  };
  walk(root);
  return rows;
}

type WorkflowDoc = {
  schema: { name: string; version: number };
  format: number;
  ok: boolean;
  path: string;
  definition: { workflow: string; schemaVersion: number; digest: string } | null;
  findings: { code: string; level: string; line: number; message: string }[];
  summary: { refusals: number; notes: number };
};

type ErrorDoc = {
  schema: { name: string; version: number };
  error: { id: string; message: string; repair: string | null };
};

describe('team workflow check acceptance', () => {
  test('passes a clean workflow with exit 0 and the documented line', () => {
    const w = world();
    w.write('workflow.yaml', CLEAN);
    const ran = w.run(['check', 'workflow.yaml']);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe('team workflow check: workflow.yaml: ok\n');
    expect(ran.stderr).toBe('');
  });

  test('passes with a note, counted in the summary wording, exit 0', () => {
    const w = world();
    w.write('noted.yaml', NOTED);
    const ran = w.run(['check', 'noted.yaml']);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe(
      'note: noted.yaml:7: [graph.orphan] state "parked" is not entered by any initial, on trigger or transition\n' +
        'team workflow check: noted.yaml: ok (1 note)\n',
    );
    expect(ran.stderr).toBe('');
  });

  test('refuses an undeclared target and an unknown role, sorted by line, exit 1', () => {
    const w = world();
    w.write('broken.yaml', BROKEN);
    const ran = w.run(['check', 'broken.yaml']);
    expect(ran.status).toBe(1);
    expect(ran.stdout).toBe(
      'note: broken.yaml:6: [graph.orphan] state "complete" is not entered by any initial, on trigger or transition\n' +
        'refusal: broken.yaml:8: [graph.transition] transition from "draft" to "missing" names undeclared state "missing"\n' +
        'refusal: broken.yaml:11: [ref.role] role "ghost" is not known\n' +
        'team workflow check: broken.yaml: 2 refusals, 1 note: refused\n',
    );
    expect(ran.stderr).toBe('');
  });

  test('refuses an unknown signal and an unknown top-level key', () => {
    const w = world();
    w.write('signal.yaml', UNKNOWN_SIGNAL);
    w.write('extra.yaml', EXTRA_KEY);
    const signal = w.run(['check', 'signal.yaml']);
    expect(signal.status).toBe(1);
    expect(signal.stdout).toContain('[vocab.signal] "tick" is not a transition signal');
    expect(signal.stdout.endsWith('team workflow check: signal.yaml: 1 refusal: refused\n')).toBe(true);
    expect(signal.stderr).toBe('');
    const extra = w.run(['check', 'extra.yaml']);
    expect(extra.status).toBe(1);
    expect(extra.stdout).toContain('[schema.key] top level: unknown key "extra"');
    expect(extra.stdout.endsWith('team workflow check: extra.yaml: 1 refusal: refused\n')).toBe(true);
    expect(extra.stderr).toBe('');
  });

  test('resolves a structural role with no such seat, exit 0', () => {
    const w = world();
    w.write('structural.yaml', STRUCTURAL_ROLE);
    const ran = w.run(['check', 'structural.yaml']);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe('team workflow check: structural.yaml: ok\n');
    expect(ran.stderr).toBe('');
  });

  test('emits the team.workflow document for a pass, a note and a refusal', () => {
    const w = world();
    w.write('workflow.yaml', CLEAN);
    w.write('noted.yaml', NOTED);
    w.write('broken.yaml', BROKEN);
    const pass = w.run(['check', 'workflow.yaml', '--json']);
    expect(pass.status).toBe(0);
    expect(pass.stderr).toBe('');
    const passDoc = JSON.parse(pass.stdout) as WorkflowDoc;
    expect(passDoc.schema).toEqual({ name: 'team.workflow', version: 1 });
    expect(passDoc.format).toBe(1);
    expect(passDoc.ok).toBe(true);
    expect(passDoc.path).toBe('workflow.yaml');
    expect(passDoc.definition).not.toBeNull();
    expect(passDoc.definition?.workflow).toBe('review-pass');
    expect(passDoc.definition?.schemaVersion).toBe(1);
    expect(passDoc.definition?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(passDoc.findings).toEqual([]);
    expect(passDoc.summary).toEqual({ refusals: 0, notes: 0 });

    const noted = w.run(['check', 'noted.yaml', '--json']);
    expect(noted.status).toBe(0);
    const notedDoc = JSON.parse(noted.stdout) as WorkflowDoc;
    expect(notedDoc.ok).toBe(true);
    expect(notedDoc.summary).toEqual({ refusals: 0, notes: 1 });
    expect(notedDoc.findings.map((finding) => [finding.level, finding.code, finding.line])).toEqual([
      ['note', 'graph.orphan', 7],
    ]);

    const refused = w.run(['check', 'broken.yaml', '--json']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toBe('');
    const refusedDoc = JSON.parse(refused.stdout) as WorkflowDoc;
    expect(refusedDoc.ok).toBe(false);
    expect(refusedDoc.summary).toEqual({ refusals: 2, notes: 1 });
    expect(refusedDoc.findings.map((finding) => [finding.level, finding.code, finding.line])).toEqual([
      ['note', 'graph.orphan', 6],
      ['refusal', 'graph.transition', 8],
      ['refusal', 'ref.role', 11],
    ]);
    for (const finding of refusedDoc.findings) {
      expect(typeof finding.message).toBe('string');
      expect(finding.message.length).toBeGreaterThan(0);
    }
  });

  test('writes the team.error document for invocation, unreadable and invalid input', () => {
    const w = world();
    w.write('list.yaml', '- not\n- a\n- mapping\n');
    const cases: { args: string[]; id: string; message: string }[] = [
      { args: ['check', '--json'], id: 'workflow.check.invocation', message: 'a <path> is required' },
      { args: ['check', 'workflow.yaml', 'extra.yaml', '--json'], id: 'workflow.check.invocation', message: 'one <path> at most' },
      { args: ['check', 'workflow.yaml', '--bad', '--json'], id: 'workflow.check.invocation', message: 'unknown option --bad' },
      { args: ['check', 'absent.yaml', '--json'], id: 'workflow.check.file', message: "can't read absent.yaml" },
      { args: ['check', '.agents', '--json'], id: 'workflow.check.file', message: "can't read .agents" },
      { args: ['check', 'list.yaml', '--json'], id: 'workflow.check.file-invalid', message: 'list.yaml:1: the top level must be a mapping' },
    ];
    for (const item of cases) {
      const ran = w.run(item.args);
      expect(ran.status).toBe(2);
      expect(ran.stderr).toBe('');
      const doc = JSON.parse(ran.stdout) as ErrorDoc;
      expect(doc.schema).toEqual({ name: 'team.error', version: 1 });
      expect(doc.error.id).toBe(item.id);
      expect(doc.error.message).toContain(item.message);
      expect(doc.error.repair).toBeNull();
    }
  });

  test('keeps a bad invocation on stderr with the usage when --json is absent', () => {
    const w = world();
    const ran = w.run(['check']);
    expect(ran.status).toBe(2);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('team workflow check: a <path> is required');
    expect(ran.stderr).toContain('Usage: team workflow check <path> [--json]');
  });

  test('answers --help and -h with the usage and exit 0', () => {
    const w = world();
    for (const flag of ['--help', '-h'] as const) {
      const ran = w.run(['check', flag]);
      expect(ran.status).toBe(0);
      expect(ran.stdout.startsWith('Usage: team workflow check <path> [--json]\n')).toBe(true);
      expect(ran.stderr).toBe('');
    }
  });

  test('is read-only over the project and the home folder', () => {
    const w = world();
    w.write('workflow.yaml', CLEAN);
    w.write('broken.yaml', BROKEN);
    const projectBefore = manifest(w.project);
    const homeBefore = manifest(w.home);
    const pass = w.run(['check', 'workflow.yaml']);
    const refused = w.run(['check', 'broken.yaml']);
    const refusedJson = w.run(['check', 'broken.yaml', '--json']);
    expect(pass.status).toBe(0);
    expect(refused.status).toBe(1);
    expect(refusedJson.status).toBe(1);
    expect(manifest(w.project)).toEqual(projectBefore);
    expect(manifest(w.home)).toEqual(homeBefore);
    expect(homeBefore).toEqual([]);
  });

  test('repeats identically and digests the definition content, not its path', () => {
    const w = world();
    w.write('broken.yaml', BROKEN);
    w.write('copy.yaml', BROKEN);
    const first = w.run(['check', 'broken.yaml', '--json']);
    const second = w.run(['check', 'broken.yaml', '--json']);
    expect(second).toEqual(first);
    const copy = w.run(['check', 'copy.yaml', '--json']);
    const originalDoc = JSON.parse(first.stdout) as WorkflowDoc;
    const copyDoc = JSON.parse(copy.stdout) as WorkflowDoc;
    expect(copyDoc.definition?.digest).toBe(originalDoc.definition?.digest);
    expect(copyDoc.path).toBe('copy.yaml');
  });
});
