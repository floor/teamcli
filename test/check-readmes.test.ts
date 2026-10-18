// The rule scripts/check-readmes.ts enforces, on fixture trees: the opening sentence in its
// places, and the version claims against package.json. The passing and the failing cases.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReadmes, helpOpeningLine, openingLine } from '../scripts/check-readmes.ts';

const SENTENCE = "Set up and run a team of AI agents for your project. Agents propose, you decide.";
const PLACEHOLDER = "OPENING SENTENCE PENDING: THE OWNER'S CHOICE";

type Tree = { readme?: string; npmReadme?: string; description?: string; version?: string; launcher?: string };

function fixture(files: Tree): string {
  const root = mkdtempSync(join(tmpdir(), 'team-readmes-'));
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'team', version: files.version ?? '0.2.1', description: files.description ?? SENTENCE }, null, 2)}\n`,
  );
  writeFileSync(join(root, 'README.md'), files.readme ?? `# team\n\n${SENTENCE}\n\nA paragraph.\n`);
  writeFileSync(join(root, 'npm-readme.md'), files.npmReadme ?? `# team\n\n${SENTENCE}\n\nA short paragraph.\n`);
  if (files.launcher !== undefined) {
    mkdirSync(join(root, 'packages/teamcli'), { recursive: true });
    writeFileSync(
      join(root, 'packages/teamcli/package.json'),
      `${JSON.stringify({ name: '@teamcli/cli', version: files.version ?? '0.2.1', description: files.launcher }, null, 2)}\n`,
    );
  }
  return root;
}

function run(root: string, help: string = SENTENCE): { file: string; message: string }[] {
  try {
    return checkReadmes(root, help);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('the opening sentence', () => {
  test('one sentence in the three places passes, and a launcher with none is not read', () => {
    expect(run(fixture({}))).toEqual([]);
  });

  test('the placeholder fails, and the line names the file that holds it', () => {
    // The places holding the real sentence are named too, as differing from the placeholder.
    const placed = (failures: { file: string; message: string }[]): string[] =>
      failures.filter((failure) => failure.message.includes('placeholder')).map((failure) => failure.file);

    expect(placed(run(fixture({ readme: `# team\n\n${PLACEHOLDER}\n\nA paragraph.\n` })))).toEqual(['README.md']);
    expect(placed(run(fixture({ npmReadme: `# team\n\n${PLACEHOLDER}\n` })))).toEqual(['npm-readme.md']);
    expect(placed(run(fixture({ description: PLACEHOLDER })))).toEqual(['package.json']);
    expect(placed(run(fixture({ launcher: PLACEHOLDER })))).toEqual(['packages/teamcli/package.json']);
  });

  test('places that differ from each other fail, each named', () => {
    expect(run(fixture({ npmReadme: '# team\n\nAnother sentence.\n' })).map((failure) => failure.file)).toEqual([
      'npm-readme.md',
    ]);
    expect(run(fixture({ description: 'Another sentence.' })).map((failure) => failure.file)).toEqual(['package.json']);
    expect(run(fixture({ launcher: 'Another sentence.' })).map((failure) => failure.file)).toEqual([
      'packages/teamcli/package.json',
    ]);
  });

  test('a launcher carrying the same sentence is read and passes', () => {
    expect(run(fixture({ launcher: SENTENCE }))).toEqual([]);
  });

  test("the help's opening line is a place: one that differs fails under its own name", () => {
    expect(run(fixture({}), SENTENCE)).toEqual([]);
    expect(run(fixture({}), 'Another sentence.').map((failure) => failure.file)).toEqual(['team --help']);
  });

  test("this build's --help opens with this tree's sentence", () => {
    const root = join(import.meta.dir, '..');
    expect(checkReadmes(root, helpOpeningLine())).toEqual([]);
  });

  test('the opening line is the first line under the title, comments and blanks skipped', () => {
    expect(openingLine(`<!-- a comment -->\n\n# team\n\n${SENTENCE}\n\nmore\n`)).toBe(SENTENCE);
    expect(openingLine('# team\n\n\n')).toBeUndefined();
  });
});

describe('the version claims', () => {
  test('the current version passes in every claim position', () => {
    const readme = [
      '# team',
      '',
      SENTENCE,
      '',
      '**Status: 0.2, early: herdr only.**',
      '',
      'Version 0.2 runs teams in herdr.',
      '',
      '```sh',
      'team --version            # 0.2.1',
      '```',
    ].join('\n');
    expect(run(fixture({ readme }))).toEqual([]);
  });

  test('a status or version line older than package.json fails', () => {
    const failures = run(fixture({ readme: `# team\n\n${SENTENCE}\n\n**Status: 0.1, early: herdr only.**\n` }));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.file).toBe('README.md');
    expect(failures[0]?.message).toContain('0.1');
    expect(failures[0]?.message).toContain('0.2.1');

    const sentence = run(fixture({ readme: `# team\n\n${SENTENCE}\n\nVersion 0.1 runs teams in herdr.\n` }));
    expect(sentence).toHaveLength(1);
    expect(sentence[0]?.message).toContain('0.1');
  });

  test('a team --version example older or newer than package.json fails; the exact version passes', () => {
    const example = (claimed: string): string => `# team\n\n${SENTENCE}\n\n\`\`\`sh\nteam --version # ${claimed}\n\`\`\`\n`;
    expect(run(fixture({ readme: example('0.2.0') }))[0]?.message).toContain('0.2.0');
    expect(run(fixture({ readme: example('0.3.0') }))[0]?.message).toContain('0.3.0');
    expect(run(fixture({ readme: example('0.2.1') }))).toEqual([]);
  });

  test('a candidate names its prerelease exactly; the release it precedes fails, and x.y still passes', () => {
    const example = (claimed: string): string => `# team\n\n${SENTENCE}\n\n\`\`\`sh\nteam --version # ${claimed}\n\`\`\`\n`;
    expect(run(fixture({ version: '0.5.0-rc.4', readme: example('0.5.0-rc.4') }))).toEqual([]);
    expect(run(fixture({ version: '0.5.0-rc.4', readme: example('0.5') }))).toEqual([]);
    expect(run(fixture({ version: '0.5.0-rc.4', readme: example('0.5.0') }))[0]?.message).toContain('0.5.0-rc.4');
    const status = run(fixture({ version: '0.5.0-rc.4', readme: `# team\n\n${SENTENCE}\n\n**Status: 0.5.0-rc.4, a candidate.**\n` }));
    expect(status).toEqual([]);
  });

  test('a sentence about the past may name an older version', () => {
    const readme = `# team\n\n${SENTENCE}\n\nSince 0.2 the file is private to each clone.\n\nUpgrading from 0.1: run team approve once.\n`;
    expect(run(fixture({ readme }))).toEqual([]);
  });

  test('a version that is not a claim is not read: a model version, a tag, another CLI', () => {
    const readme = [
      '# team',
      '',
      SENTENCE,
      '',
      'The Codex profile is tested with CLI 0.157.0.',
      '',
      '```yaml',
      'version: "5.5"',
      '```',
      '',
      '```sh',
      'git tag v0.1.0 && git push origin v0.1.0',
      '```',
      '',
      '[UPGRADE-0.3.md](https://github.com/floor/teamcli/blob/main/UPGRADE-0.3.md)',
    ].join('\n');
    expect(run(fixture({ readme }))).toEqual([]);
  });

  test('npm-readme.md is read too', () => {
    const failures = run(fixture({ npmReadme: `# team\n\n${SENTENCE}\n\n**Status: 0.1, early.**\n` }));
    expect(failures.map((failure) => failure.file)).toEqual(['npm-readme.md']);
  });
});
