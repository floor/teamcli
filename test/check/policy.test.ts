import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { loadConfig } from '../../src/check/load.ts';
import { forbiddenPatterns } from '../../src/check/config.ts';
import { readPolicyFile } from '../../src/check/policy.ts';
import { publicNameRules, scanPublicNames } from '../../src/check/public-names.ts';
import { checkBody, runCheck } from '../../src/check/run.ts';
import { check } from '../../src/commands/check.ts';
import { commits } from '../../src/commands/commits.ts';
import { testIo } from '../helpers.ts';
import { storePath } from '../../src/store/store.ts';
import { createRepository, HUMAN_EMAIL, type Repository } from './repository.ts';

const POLICY = join(import.meta.dir, '../../.github/policy.yaml');
const SYNTHETIC = `kind: check-policy
project: acme
visibility: public
identity:
  humans: [${HUMAN_EMAIL}]
  forbidden: [^blocked:]
signers:
  - { display: "Model 1", model: "Model", version: "1", role: "writer" }
`;
const roots: string[] = [];
const repos: Repository[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.remove();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'check-policy-'));
  roots.push(root);
  return root;
}
function repository(): Repository {
  const repo = createRepository();
  repos.push(repo);
  return repo;
}
function file(text = SYNTHETIC, name = 'policy.yaml'): string {
  const path = join(scratch(), name);
  writeFileSync(path, text);
  return path;
}
function loaded(path = file(), home = scratch()) {
  const result = loadConfig(dirname(path), path, home);
  if (!result.ok) throw new Error('synthetic policy was refused');
  return result.config;
}

test('a standalone policy needs no runnable team, registry or deprecated coordinator field', () => {
  const result = readPolicyFile('/', file());
  expect(result?.ok).toBe(true);
  if (!result?.ok) return;
  expect(result.warnings).toEqual([]);
  expect(result.config.commits).toEqual({ template: 'Agent: {display} · {role}', position: 'trailer', exemptMerge: true });
  expect(result.config.ledger).toHaveLength(1);
  expect(readPolicyFile('/', file(SYNTHETIC, 'custom.yaml'))?.ok).toBe(true);
});

for (const [name, text] of [
  ['wrong kind', SYNTHETIC.replace('check-policy', 'other')],
  ['unknown field', SYNTHETIC + 'workspace: {mode: shared}\n'],
  ['duplicate key', SYNTHETIC + 'project: other\n'],
  ['invalid expression', SYNTHETIC.replace('[^blocked:]', '["["]')],
  ['missing signer', SYNTHETIC.slice(0, SYNTHETIC.indexOf('signers:'))],
  ['invalid signer', SYNTHETIC.replace('version: "1"', 'version: 1')],
  ['invalid template', SYNTHETIC.replace('  humans:', '  signature: {template: "unsigned"}\n  humans:')],
  ['missing visibility', SYNTHETIC.replace('visibility: public\n', '')],
] as const) {
  test(`a policy with ${name} is refused without a fallback`, () => {
    expect(loadConfig('/', file(text), scratch()).ok).toBe(false);
  });
}

test('a missing or malformed conventional policy is refused; a legacy document remains distinct', () => {
  expect(readPolicyFile(scratch(), 'policy.yaml')?.ok).toBe(false);
  expect(readPolicyFile('/', file('not a map'))?.ok).toBe(false);
  expect(readPolicyFile('/', file('format: 1\nproject: acme\n', 'team.yaml'))).toBeNull();
});

test('local ledger history still accepts former signatures, and corruption still refuses', () => {
  const path = file();
  const home = scratch();
  const store = storePath('acme', dirname(path), home);
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'ledger.json'), JSON.stringify([{ display: 'Earlier 2', model: 'Earlier', version: '2', role: 'writer' }]));
  const config = loaded(path, home);
  const repo = repository();
  const ref = repo.commit('fix: history\n\nAgent: Earlier 2 · writer');
  expect(runCheck(config, { cwd: repo.path, ref }).ok).toBe(true);
  expect(runCheck(loaded(path), { cwd: repo.path, ref }).ok).toBe(false);
  writeFileSync(join(store, 'ledger.json'), '{ broken');
  expect(loadConfig(dirname(path), path, home).ok).toBe(false);
  expect(loadConfig(dirname(path), path, home, { ledger: false }).ok).toBe(true);
});

test('unsigned, misplaced and unknown signatures fail; the declared signature passes in commits and bodies', () => {
  const config = loaded();
  const repo = repository();
  for (const message of ['fix: unsigned', 'fix: unknown\n\nAgent: Other 1 · writer', 'fix: prose\n\nAgent: Model 1 · writer\nmore prose']) {
    expect(runCheck(config, { cwd: repo.path, ref: repo.commit(message) }).ok).toBe(false);
  }
  const ref = repo.commit('fix: signed\n\nAgent: Model 1 · writer');
  expect(runCheck(config, { cwd: repo.path, ref }).ok).toBe(true);
  expect(checkBody(config, 'A body\n\n**Agent:** Model 1 · writer')).toEqual([]);
  expect(checkBody(config, 'A body')).not.toEqual([]);
  expect(checkBody(config, '**Agent:** Model 1 · writer\n\nMore prose')).not.toEqual([]);
  expect(checkBody(config, '**Agent:** Other 1 · writer')).not.toEqual([]);
});

test('human matching stays case-insensitive without trimming; forbidden rules still apply to exempt authors', () => {
  const config = loaded();
  const repo = repository();
  const human = repo.commit('docs: unsigned human', HUMAN_EMAIL.toUpperCase());
  expect(runCheck(config, { cwd: repo.path, ref: human }).commits[0]?.exempt).toBe('human');
  expect(runCheck({ ...config, humans: [` ${HUMAN_EMAIL} `] }, { cwd: repo.path, ref: human }).commits[0]?.exempt).toBeUndefined();
  const blocked = repo.commit('blocked: human', HUMAN_EMAIL);
  expect(runCheck(config, { cwd: repo.path, ref: blocked }).ok).toBe(false);
  expect(config.humans).toEqual([HUMAN_EMAIL]);
});

test('check alias and commits check both use the standalone policy', async () => {
  const path = file();
  const repo = repository();
  const ref = repo.commit('fix: unsigned');
  const home = scratch();
  const loader = (cwd: string, file?: string) => loadConfig(cwd, file, home);
  const io = { cwd: repo.path, env: {}, stdinIsTTY: false, stdout: (_text: string) => {}, stderr: (_text: string) => {} };
  expect(await commits(['check', ref, '--file', path], io, loader)).toBe(1);
  expect(await check([ref, '--file', path], io, loader)).toBe(1);
});

test('every repository forbidden rule still rejects a violating commit, body and tracked path', () => {
  const config = loaded(POLICY);
  const values = [
    ['Claude', '-Session: synthetic'].join(''),
    ['https://claude', '.ai/code/session'].join(''),
    ['FL', 'O-', '123'].join(''),
    ['Co-', 'Authored-By: Synthetic <synthetic@example.test>'].join(''),
    ['w', '2', ':p', '1'].join(''),
    ['floor', '-', '3a'].join(''),
    ['O', 'D-', '123'].join(''),
  ];
  const patterns = forbiddenPatterns(config);
  expect(patterns).toHaveLength(values.length);
  const repo = repository();
  const base = repo.commit('base');
  const pathPatterns: string[] = [];
  for (const [index, pattern] of patterns.entries()) {
    const value = values[index]!;
    expect(pattern.regex.test(value)).toBe(true);
    const ref = repo.commit(`fix: rule\n\n${value}\n\nAgent: Claude Opus 5.5 · coordinator`);
    const report = runCheck(config, { cwd: repo.path, ref, since: base });
    expect(report.ok).toBe(false);
    expect(report.commits[0]?.findings.some((finding) => finding.kind === 'forbidden')).toBe(true);
    expect(checkBody(config, `${value}\n\n**Agent:** Claude Opus 5.5 · coordinator`).some((finding) => finding.kind === 'forbidden')).toBe(true);
    // The matched line may contain path separators: nested tracked paths are still scanned.
    const path = value.replace(/[:<>]/g, (character) => character === ':' ? ':' : '_');
    // A URL's double slash cannot survive as a git path. That rule's negative scenes
    // above exercise both text surfaces; all rules expressible as paths run below.
    if (!pattern.regex.test(normalize(path))) continue;
    pathPatterns.push(pattern.source);
    mkdirSync(dirname(join(repo.path, path)), { recursive: true });
    writeFileSync(join(repo.path, path), 'clean\n');
    repo.git('add', '--', path);
  }
  const built = publicNameRules(config);
  if ('problem' in built) throw new Error(built.problem);
  const scan = scanPublicNames(repo.path, built.rules);
  if ('problem' in scan) throw new Error(scan.problem);
  for (const source of pathPatterns) expect(scan.hits.some((hit) => hit.pattern === source && hit.line === 0)).toBe(true);
  expect(readFileSync(POLICY, 'utf8')).not.toContain('launch:');
}, 30_000);

const OUTSIDER = `kind: check-policy
project: acme
visibility: public
identity:
  humans: []
signers:
  - { display: "Model 9", model: "Model", version: "9", role: "writer" }
`;

test('a bare check reads the policy file and accepts a signer no roster seat has', async () => {
  const repo = repository();
  const home = scratch();
  mkdirSync(join(repo.path, '.github'));
  writeFileSync(join(repo.path, '.github/policy.yaml'), OUTSIDER);
  const ref = repo.commit('fix: signed\n\nAgent: Model 9 · writer');
  const io = testIo(repo.path);
  const code = await commits(['check', ref], io, (cwd, file) => loadConfig(cwd, file, home));
  expect(code, io.err + io.out).toBe(0);
  expect(io.err).toContain('team commits check: read .github/policy.yaml');
  expect(io.out).not.toContain('read .github/policy.yaml');
  expect(io.out).toContain('ok');
});

test('with no policy file a bare check still reads the roster', async () => {
  const repo = repository();
  const home = scratch();
  repo.commit('fix: signed\n\nAgent: Model 9 · writer');
  const io = testIo(repo.path);
  const code = await commits(['check', 'HEAD'], io, (cwd, file) => loadConfig(cwd, file, home));
  expect(code).toBe(2);
  expect(io.err).toContain('no team file');
  expect(io.out).not.toContain('read .github/policy.yaml');
});
