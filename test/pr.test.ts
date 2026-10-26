// The output contract for `team pr check` (`docs/reference/output.md` row 24): the plain report
// is one `difference:` block per finding with its `repair:` and `who:`, then the closing summary
// line; `--json` is the registered `team.pr` document; a refusal is the `team.error` document on
// stdout, stderr empty.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadConfig } from '../src/commands/check.ts';
import { pr, USAGE } from '../src/commands/pr.ts';
import { NOT_A_REPO } from '../src/file/load.ts';
import { PR_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { config, PR_SIGNATURE } from './check/fixtures.ts';
import { testIo } from './helpers.ts';
import { assertGoldenOutput, assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

interface PrDoc {
  schema: { name: string; version: number };
  format: number;
  differences: { what: string; repair: string; who: string }[];
  notes: string[];
  summary: { differences: number; owner_differences: number };
  notice: string | null;
}

let folder: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'team-pr-contract-'));
});

afterAll(() => rmSync(folder, { recursive: true, force: true }));

/** The file the cases load: the fixtures' config, whole. */
const load: LoadConfig = () => ({ ok: true, config: config(), warnings: [] });

/** Writes a body file under the fixture folder and returns its name. */
function body(name: string, text: string): string {
  writeFileSync(join(folder, name), text);
  return name;
}

async function run(argv: string[], loader: LoadConfig = load) {
  const io = testIo(folder);
  const code = await pr(['check', ...argv], io, loader);
  return { code, out: io.out, err: io.err };
}

describe('team pr check follows the output contract', () => {
  test('a passing body is the closing line alone', async () => {
    const result = await run([body('pass.md', `The page is ready.\n\n${PR_SIGNATURE}\n`)]);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    assertGoldenOutput(result.out, ['team pr check: 1 pull request body checked: ok']);
  });

  test('a Cursor publication trailer after the signature still passes', async () => {
    const div = '<div><img src="https://cursor.com/assets/images/open-in-web-dark.png"><img src="https://cursor.com/assets/images/open-in-cursor-dark.png"></div>';
    const text = `The page is ready.\n\n${PR_SIGNATURE}\n\n<!-- CURSOR_AGENT_PR_BODY_END -->\n\n${div}\n`;
    const result = await run([body('trailer.md', text)]);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    assertGoldenOutput(result.out, ['team pr check: 1 pull request body checked: ok']);
  });

  test('prose after the signature still refuses when a publication trailer follows it', async () => {
    const div = '<div><img src="https://cursor.com/assets/images/open-in-web-dark.png"><img src="https://cursor.com/assets/images/open-in-cursor-dark.png"></div>';
    const text = `${PR_SIGNATURE}\n\nSee the notes.\n\n<!-- CURSOR_AGENT_PR_BODY_END -->\n\n${div}\n`;
    const result = await run([body('trailer-prose.md', text)]);
    expect(result.code).toBe(1);
    expect(result.out).toContain('the signature is not in the last line');
  });

  test('a refused body is one difference block per finding, then the closing line', async () => {
    const result = await run([body('refused.md', 'Bump the retry window.\n\nSee WEB-1234.\n')]);
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    assertGoldenOutput(result.out, [
      'difference: pull request body, line 3: forbidden pattern \\bWEB-[0-9]+\\b — "See WEB-1234."',
      '  repair: edit the pull request body so the line no longer matches (its author can edit it on the pull request)',
      '  who: any seat',
      'difference: pull request body: no signature: expected "**Agent:** {display} · {role}" in the last line',
      "  repair: end the pull request body with a seat's signature (its author can edit it on the pull request)",
      '  who: any seat',
      'team pr check: 1 pull request body checked: the pull request body refused',
    ]);
  });

  test('--json carries the registered team.pr document', async () => {
    const result = await run([
      body('json.md', `The page is ready.\n\n${PR_SIGNATURE}\n`),
      '--file',
      'unused.yaml',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<PrDoc>(result.out, PR_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      schema: { name: 'team.pr', version: 1 },
      format: 1,
      differences: [],
      notes: [],
      summary: { differences: 0, owner_differences: 0 },
      notice: null,
    });
  });

  test('--json: each finding is a difference with its repair and who', async () => {
    const result = await run([body('json-refused.md', 'See WEB-1234.\n'), '--json']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<PrDoc>(result.out, PR_OUTPUT_SCHEMA);
    expect(doc.differences).toEqual([
      {
        what: 'pull request body, line 1: forbidden pattern \\bWEB-[0-9]+\\b — "See WEB-1234."',
        repair: 'edit the pull request body so the line no longer matches (its author can edit it on the pull request)',
        who: 'any seat',
      },
      {
        what: 'pull request body: no signature: expected "**Agent:** {display} · {role}" in the last line',
        repair: "end the pull request body with a seat's signature (its author can edit it on the pull request)",
        who: 'any seat',
      },
    ]);
    expect(doc.summary).toEqual({ differences: 2, owner_differences: 0 });
  });

  test('--json: load warnings travel as notes, and stderr stays empty', async () => {
    const warned: LoadConfig = () => ({
      ok: true,
      config: config(),
      warnings: [{ line: 3, message: '`coordinator:` is now `leads: true`' }],
    });
    const result = await run([body('warned.md', `${PR_SIGNATURE}\n`), '--json'], warned);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const doc = assertMatchesOutputSchema<PrDoc>(result.out, PR_OUTPUT_SCHEMA);
    expect(doc.notes).toEqual(['line 3: `coordinator:` is now `leads: true`']);
  });

  test('--json: an invocation refusal is the team.error document, stderr empty', async () => {
    const result = await run(['--json']);
    expect(result.code).toBe(2);
    expect(result.err).toBe('');
    assertJsonErrorShape(result.out, { id: 'pr.invocation', messageContains: 'a <file> is required', repair: null });
  });

  test('--json is read before the parser: a bad option, or --json=<value>, still writes the error document', async () => {
    for (const [argv, messageContains] of [
      [['--nope', '--json'], 'unknown option --nope'],
      [['--json=1'], 'unknown option --json'],
    ] as const) {
      const result = await run([...argv]);
      expect(result.code).toBe(2);
      expect(result.err).toBe('');
      assertJsonErrorShape(result.out, { id: 'pr.invocation', messageContains, repair: null });
    }
  });

  // The rule `team release` documents and pins: an option's value is taken as given, whatever
  // it looks like, so only a `--json` that is not some option's value selects the JSON output.
  test('--json as the value of --file is a path; a free --json beside it still writes the document', async () => {
    const seen: (string | undefined)[] = [];
    const missing: LoadConfig = (cwd, file) => {
      seen.push(file);
      const path = join(cwd, file ?? '.agents/team.yaml');
      return { ok: false, errors: [{ line: 0, message: `no team file at ${file ?? '.agents/team.yaml'}` }], path };
    };
    const consumed = await run(['pass.md', '--file', '--json'], missing);
    expect(consumed.code).toBe(2);
    expect(consumed.out).toBe('');
    expect(consumed.err).toBe(`team pr check: ${join(folder, '--json')}: no team file at --json\n`);

    const free = await run(['pass.md', '--json', '--file', '--json'], missing);
    expect(free.code).toBe(2);
    expect(free.err).toBe('');
    assertJsonErrorShape(free.out, {
      id: 'pr.file',
      messageContains: `${join(folder, '--json')}: no team file at --json`,
    });
    expect(seen).toEqual(['--json', '--json']);
  });

  test('--json: a load refusal is the team.error document for its row', async () => {
    const failing: LoadConfig = () => ({ ok: false, errors: [{ line: 0, message: NOT_A_REPO }] });
    const result = await run(['body.md', '--json'], failing);
    expect(result.code).toBe(2);
    expect(result.err).toBe('');
    assertJsonErrorShape(result.out, { id: 'pr.not-a-repo', messageContains: 'not inside a git repository', repair: null });
  });

  test('--json: an unreadable body is the team.error document for pr.body', async () => {
    const result = await run(['missing.md', '--json']);
    expect(result.code).toBe(2);
    expect(result.err).toBe('');
    assertJsonErrorShape(result.out, {
      id: 'pr.body',
      messageContains: "can't read the pull request body: ",
      repair: null,
    });
  });

  test('a plain body refusal keeps stderr and prints nothing on stdout', async () => {
    const result = await run(['missing.md']);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toStartWith("team pr check: can't read the pull request body: ");
  });

  test('the usage names --json and ends with the matrix footer sentence', () => {
    expect(USAGE).toStartWith('Usage: team pr check <file> [--file <path>] [--json]');
    expect(USAGE).toEndWith(
      "Exits 0 when the body passes, 1 when it is refused, 2 when the check\ncan't run.\n",
    );
  });
});
