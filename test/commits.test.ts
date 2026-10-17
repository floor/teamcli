// The output contract for `team commits check` (`docs/reference/output.md` row 2): the plain
// report is a column-0 COMMIT / STATUS / DETAIL table, each finding a `difference:` block with
// its `repair:` and `who:`, and one closing summary line; `--json` is the registered
// `team.commits` document; a refusal is the `team.error` document on stdout, stderr empty.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadConfig } from '../src/commands/check.ts';import { commits } from '../src/commands/commits.ts';
import { NOT_A_REPO } from '../src/file/load.ts';
import { COMMITS_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { config, SIGNATURE } from './check/fixtures.ts';
import { createRepository, HUMAN_EMAIL, type Repository } from './check/repository.ts';
import { testIo } from './helpers.ts';
import { assertGoldenOutput, assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

interface CommitsDoc {
  schema: { name: string; version: number };
  format: number;
  ref: string;
  since: string | null;
  commits: {
    hash: string;
    subject: string;
    status: string;
    exempt: string | null;
    findings: { kind: string; message: string; line?: number; text?: string }[];
  }[];
  skipped: number;
  pull_request: unknown[] | null;
  differences: { what: string; repair: string; who: string }[];
  notes: string[];
  summary: { commits: number; refused: number; exempt: number; skipped: number; ok: boolean };
  notice: string | null;
}

let repo: Repository;
const hash = {} as Record<'old' | 'clean' | 'refused' | 'unsigned' | 'human', string>;

beforeAll(() => {
  repo = createRepository();
  hash.old = repo.commit('chore: the base, always skipped');
  hash.clean = repo.commit(`feat: a clean one\n\n${SIGNATURE}`);
  hash.refused = repo.commit(`feat: leaks a line\n\nSee WEB-1234.\n\n${SIGNATURE}`);
  hash.unsigned = repo.commit('fix: unsigned\n\nSome prose.');
  hash.human = repo.commit('feat: by a human\n\nSome prose.', HUMAN_EMAIL);
});

afterAll(() => repo.remove());

/** The file the cases load: the fixtures' config, whole. */
const load: LoadConfig = () => ({ ok: true, config: config(), warnings: [] });

async function run(argv: string[], loader: LoadConfig = load, cwd = repo.path) {
  const io = testIo(cwd);
  const code = await commits(['check', ...argv], io, loader);
  return { code, out: io.out, err: io.err };
}

describe('team commits check follows the output contract', () => {
  test('the plain report is the table, the differences, then one summary line', async () => {
    const clean = await run([hash.clean]);
    expect(clean.code).toBe(0);
    expect(clean.err).toBe('');
    assertGoldenOutput(clean.out, [
      'COMMIT      STATUS  DETAIL',
      `${hash.clean.slice(0, 10)}  ok      feat: a clean one`,
      'team commits check: 1 commit checked: ok',
    ]);

    const refused = await run([hash.refused]);
    expect(refused.code).toBe(1);
    assertGoldenOutput(refused.out, [
      'COMMIT      STATUS   DETAIL',
      `${hash.refused.slice(0, 10)}  refused  feat: leaks a line`,
      `difference: commit ${hash.refused.slice(0, 10)} "feat: leaks a line", line 3: forbidden pattern \\bWEB-[0-9]+\\b — "See WEB-1234."`,
      '  repair: rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)',
      '  who: any seat',
      'team commits check: 1 commit checked: 1 commit refused',
    ]);
  });

  test('--json carries the registered team.commits document', async () => {
    const result = await run([hash.clean, '--json']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<CommitsDoc>(result.out, COMMITS_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      schema: { name: 'team.commits', version: 1 },
      format: 1,
      ref: hash.clean,
      since: null,
      skipped: 0,
      pull_request: null,
      notes: [],
      summary: { commits: 1, refused: 0, exempt: 0, skipped: 0, ok: true },
      notice: null,
    });
    expect(doc.commits).toEqual([
      { hash: hash.clean, subject: 'feat: a clean one', status: 'ok', exempt: null, findings: [] },
    ]);
    expect(doc.differences).toEqual([]);
  });

  test('--json: each finding is a difference with its repair and who', async () => {
    const result = await run([hash.refused, '--json']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<CommitsDoc>(result.out, COMMITS_OUTPUT_SCHEMA);
    expect(doc.summary).toEqual({ commits: 1, refused: 1, exempt: 0, skipped: 0, ok: false });
    expect(doc.commits[0]).toMatchObject({ hash: hash.refused, status: 'refused', exempt: null });
    expect(doc.commits[0]?.findings).toMatchObject([
      { kind: 'forbidden', line: 3, text: 'See WEB-1234.' },
    ]);
    expect(doc.differences).toEqual([
      {
        what: `commit ${hash.refused.slice(0, 10)} "feat: leaks a line", line 3: forbidden pattern \\bWEB-[0-9]+\\b — "See WEB-1234."`,
        repair: 'rewrite the commit message so the line no longer matches (git rebase --interactive, then reword)',
        who: 'any seat',
      },
    ]);
  });

  test('--json: a human commit is exempt, and its row says so', async () => {
    const result = await run([hash.human, '--json']);
    expect(result.code).toBe(0);
    const doc = assertMatchesOutputSchema<CommitsDoc>(result.out, COMMITS_OUTPUT_SCHEMA);
    expect(doc.commits).toEqual([
      { hash: hash.human, subject: 'feat: by a human', status: 'exempt', exempt: 'human', findings: [] },
    ]);
    expect(doc.summary).toMatchObject({ commits: 1, refused: 0, exempt: 1, ok: true });
  });

  test('--json: load warnings travel as notes, and stderr stays empty', async () => {
    const warned: LoadConfig = () => ({
      ok: true,
      config: config(),
      warnings: [{ line: 3, message: '`coordinator:` is now `leads: true`' }],
    });
    const result = await run([hash.clean, '--json'], warned);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<CommitsDoc>(result.out, COMMITS_OUTPUT_SCHEMA);
    expect(doc.notes).toEqual(['line 3: `coordinator:` is now `leads: true`']);
  });

  test('--json: an invocation refusal is the team.error document, stderr empty', async () => {
    const result = await run(['--json']);
    expect(result.code).toBe(2);
    expect(result.err).toBe('');
    assertJsonErrorShape(result.out, {
      id: 'commits.invocation',
      messageContains: 'a <ref> is required',
      repair: null,
    });
  });

  test('--json is read before the parser: a bad option, or --json=<value>, still writes the error document', async () => {
    for (const [argv, messageContains] of [
      [['--nope', '--json'], 'unknown option --nope'],
      [['--json=1'], 'unknown option --json'],
    ] as const) {
      const result = await run([...argv]);
      expect(result.code).toBe(2);
      expect(result.err).toBe('');
      assertJsonErrorShape(result.out, { id: 'commits.invocation', messageContains, repair: null });
    }
  });

  test('--json: a git failure is the team.error document for its row', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'team-commits-plain-'));
    try {
      const result = await run(['main', '--json'], load, folder);
      expect(result.code).toBe(2);
      expect(result.err).toBe('');
      assertJsonErrorShape(result.out, {
        id: 'commits.outside',
        messageContains: 'not in a git repository',
        repair: 'run team commits check from inside the git checkout',
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('--json: a load refusal is the team.error document for its row', async () => {
    const failing: LoadConfig = () => ({ ok: false, errors: [{ line: 0, message: NOT_A_REPO }] });
    const result = await run(['main', '--json'], failing);
    expect(result.code).toBe(2);
    expect(result.err).toBe('');
    assertJsonErrorShape(result.out, {
      id: 'commits.not-a-repo',
      messageContains: 'not inside a git repository',
      repair: null,
    });
  });

  test('a plain refusal keeps stderr and prints nothing on stdout', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'team-commits-plain-'));
    try {
      const result = await run(['main'], load, folder);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
      expect(result.err).toBe('team commits check: not in a git repository\n');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
