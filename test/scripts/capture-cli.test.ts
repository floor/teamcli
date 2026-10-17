import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import {
  BASELINE_STAGES,
  bumpTestedTo,
  manifestWith,
  owedOf,
  readmeStub,
  scrubCapture,
  stageOf,
  workspaceForms,
} from '../../scripts/capture-cli.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'capture-test-'));
  dirs.push(dir);
  return dir;
}

test('the baseline stages are the seven the design note names, each with its manifest kinds', () => {
  expect(BASELINE_STAGES).toEqual(['trust', 'idle', 'unsent', 'working', 'question', 'permission', 'exit']);
  expect(stageOf('trust')).toEqual({ file: 'trust.txt', classify: 'trust', composer: 'unknown' });
  expect(stageOf('idle')).toEqual({ file: 'idle.txt', classify: 'idle', composer: 'idle' });
  expect(stageOf('unsent')).toEqual({ file: 'unsent.txt', classify: 'unsent', composer: 'unsent' });
  expect(stageOf('working')).toEqual({ file: 'working.txt', classify: 'working', composer: 'idle' });
  expect(stageOf('question')).toEqual({ file: 'question.txt', classify: 'question', composer: 'unknown' });
  expect(stageOf('permission')).toEqual({ file: 'permission.txt', classify: 'permission', composer: 'unknown' });
  expect(stageOf('exit')).toEqual({ file: 'exit.txt', classify: 'unknown', composer: 'unknown' });
});

test('the workspace path is replaced in its plain, realpath and tilde forms, padded so rows keep their width', () => {
  const dir = scratch();
  const home = '/Users/example';
  const plain = scrubCapture(`launch ${dir} now`, { workspaceDir: dir, homeDir: home });
  expect(plain).toContain('<workspace>');
  expect(plain).not.toContain(dir);

  const real = workspaceForms(dir, home).find((form) => form !== dir);
  expect(real).toBeDefined();
  expect(scrubCapture(`seen at ${real} here`, { workspaceDir: dir, homeDir: home })).toContain('<workspace>');

  // A workspace under the home folder also appears as `~/...` in banners.
  const underHome = `${home}/work/space`;
  expect(scrubCapture(`banner ${underHome}`, { workspaceDir: underHome, homeDir: home })).toContain('<workspace>');
  expect(scrubCapture(`banner ~/work/space`, { workspaceDir: underHome, homeDir: home })).toContain('<workspace>');

  // A box row keeps exactly its columns: the placeholder stands in at the path's width.
  const row = `│ ${dir} │`;
  const scrubbed = scrubCapture(row, { workspaceDir: dir, homeDir: home });
  expect(scrubbed.length).toBe(row.length);
  expect(scrubbed.startsWith('│ <workspace>')).toBe(true);
  expect(scrubbed.endsWith(' │')).toBe(true);
  expect(scrubbed.split('\n').length).toBe(row.split('\n').length);
});

test('session ids, emails, the account and the plan are replaced without touching anything else', () => {
  const session = '3f2a9c1e-8b7d-4c6a-9f10-2d3e4f5a6b7c';
  const raw = [
    'Resume this session with: codex resume 9a8b7c6d5e4f',
    `conversation ${session}`,
    'owner jane.doe@example.test on the Pro plan',
    'plain text stays: team.log and team/team',
  ].join('\n');
  const scrubbed = scrubCapture(raw, { workspaceDir: '/nowhere', homeDir: '/Users/example', account: 'jane.doe@example.test', plan: 'Pro' });
  expect(scrubbed).not.toContain(session);
  expect(scrubbed).not.toContain('9a8b7c6d5e4f');
  expect(scrubbed).not.toContain('jane.doe@example.test');
  expect(scrubbed).not.toContain('Pro plan');
  expect(scrubbed).toContain('<session-id>');
  expect(scrubbed).toContain('<account>');
  expect(scrubbed).toContain('<plan> plan');
  expect(scrubbed.split('\n').length).toBe(raw.split('\n').length);
  // A hex run on a line that is not a resume line is left alone.
  expect(scrubCapture('build 9a8b7c6d5e4f done', { workspaceDir: '/nowhere' })).toContain('9a8b7c6d5e4f');
});

test('the home folder itself is never written into a fixture', () => {
  const scrubbed = scrubCapture('home is /Users/example and venv /Users/example/.venv', {
    workspaceDir: '/tmp/team-capture-x',
    homeDir: '/Users/example',
  });
  expect(scrubbed).not.toContain('/Users/example');
  expect(scrubbed).toContain('<home>');
});

test('a manifest gains the captures sorted by file, and a re-capture updates its entry', () => {
  const text = `${JSON.stringify(
    {
      screens: [
        { file: 'codex/0.161.0/idle.txt', cli: 'codex', classify: 'idle', composer: 'idle', provenance: 'capture' },
        { file: 'codex/0.161.0/working.txt', cli: 'codex', classify: 'working', composer: 'idle', provenance: 'capture' },
      ],
      yaml: [{ file: 'sample.yaml', ok: true }],
    },
    null,
    2,
  )}\n`;
  const merged = JSON.parse(
    manifestWith(text, [
      { file: 'codex/0.161.0/trust.txt', cli: 'codex', classify: 'trust', composer: 'unknown' },
      { file: 'codex/0.161.0/working.txt', cli: 'codex', classify: 'working', composer: 'idle' },
    ]),
  ) as { screens: { file: string; provenance?: string }[]; yaml: unknown[] };
  expect(merged.screens.map((screen) => screen.file)).toEqual([
    'codex/0.161.0/idle.txt',
    'codex/0.161.0/trust.txt',
    'codex/0.161.0/working.txt',
  ]);
  expect(merged.screens.every((screen) => screen.provenance === 'capture')).toBe(true);
  expect(merged.yaml).toEqual([{ file: 'sample.yaml', ok: true }]);
});

test('a profile bump moves the top-level tested.to only, never the nested records', () => {
  const yaml = [
    "cli: codex",
    'tested:',
    "  from: '0.157.0'",
    "  to: '0.161.0'",
    'accounts:',
    '  - name: work',
    '    tested:',
    "      from: '0.157.0'",
    "      to: '0.157.0'",
    '',
  ].join('\n');
  const bumped = bumpTestedTo(yaml, '0.162.0');
  expect(bumped).toContain("tested:\n  from: '0.157.0'\n  to: '0.162.0'");
  expect(bumped).toContain("    tested:\n      from: '0.157.0'\n      to: '0.157.0'");
});

test('a folder owes only the kinds neither the manifest nor its README Not produced bullets account for', () => {
  const readme = [
    '# Codex 0.161.0 terminal captures',
    '',
    '- `idle.txt`: the empty box.',
    '',
    '## Not produced',
    '',
    '- `question`: not produced, Codex has no interactive question widget.',
    '',
  ].join('\n');
  // The idle capture from the manifest and the question bullet clear two kinds; five are owed.
  expect(owedOf('codex', '0.161.0', ['codex/0.161.0/idle.txt'], readme)).toEqual([
    'trust',
    'unsent',
    'working',
    'permission',
    'exit',
  ]);
  // A capture an earlier run took counts, though this run did not take it.
  expect(owedOf('codex', '0.161.0', ['codex/0.161.0/idle.txt', 'codex/0.161.0/exit.txt'], readme)).not.toContain('exit');
  // The exit screen's kind is `unknown`; a bullet naming that kind clears the exit stage.
  const clearedExit = ['## Not produced', '', '- `unknown`: not produced, no shell-return screen.', ''].join('\n');
  expect(owedOf('muse', '1.4.9', [], clearedExit)).not.toContain('exit');
  // Prose alone never clears a kind: only a bullet in the Not produced section does.
  const prose = ['## Not produced', '', 'The question kind was not produced in the spike.', ''].join('\n');
  expect(owedOf('muse', '1.4.9', [], prose)).toContain('question');
});

test('a generated README names each capture and leaves the Not produced section to the operator', () => {
  const readme = readmeStub('codex', '0.161.0', 'codex-cli 0.161.0', [
    { stage: 'trust', styled: false },
    { stage: 'idle', styled: false },
  ], 'herdr 0.7.1');
  expect(readme).toContain('# codex 0.161.0 terminal captures');
  expect(readme).toContain("`codex-cli 0.161.0`");
  expect(readme).toContain('- `trust.txt`');
  expect(readme).toContain('- `idle.txt`');
  expect(readme).toContain('## Not produced');
  // The stub states the place, never a reason: the operator's statement is the honest one.
  expect(readme).not.toMatch(/not produced: /i);
});
