// Team-file validation only. All key-shaped values are manufactured strings; no real credential
// is loaded. Directory probes stay in owned scratch paths, and fixture parity denies all lstat.
import { afterEach, expect, test } from 'bun:test';
import { assertIndependentHome } from './independent-home-fixture.ts';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { findSecrets, KEY_PREFIXES } from '../src/file/secrets.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Problem } from '../src/file/types.ts';
import { defaultFs, type FsReader } from '../src/lobby/gate.ts';
import { parseYaml, type YamlNode } from '../src/yaml.ts';

const PREFIXES = ['sk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-', 'xoxb-', 'xoxp-', 'xoxa-', 'xoxs-', 'AKIA', 'ASIA', 'AIza', 'lin_api_', 'npm_', 'shpat_', 'dckr_pat_'];
const BODY = '0123456789AbCdEfGhIjKlMnO';
const MESSAGE = 'a value shaped like a key or token: a team file never holds a credential';
const baseTeam = `format: 1
project: framing-scene
operator: lead
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    leads: true
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
`;
const noFs: FsReader = { ...defaultFs, lstat: () => { throw Object.assign(new Error('synthetic missing path'), { code: 'ENOENT' }); } };
const found = (text: string, reader = noFs) => findSecrets(parseYaml(text), reader);
const channel = (value: string) => baseTeam + `tools:\n  chat:\n    kind: slack\n    channel: ${JSON.stringify(value)}\n`;
const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) execFileSync('trash', [path]); });
function world() {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/sf-')); made.push(base);
  const directory = join(base, PREFIXES[0]! + BODY), file = join(base, PREFIXES[1]! + BODY);
  fs.mkdirSync(directory); fs.writeFileSync(file, 'synthetic file\n');
  const target = join(base, 'real'); fs.mkdirSync(target); fs.mkdirSync(join(target, PREFIXES[0]! + BODY)); fs.mkdirSync(join(target, 'child'));
  const finalLink = join(base, PREFIXES[2]! + BODY); fs.symlinkSync(target, finalLink, 'dir');
  const ordinaryLink = join(base, 'link'); fs.symlinkSync(target, ordinaryLink, 'dir');
  return { base, directory, file, target, finalLink, ordinaryLink };
}
test('the suite home is synthetic and every known prefix stays in the contract', () => {
  assertIndependentHome(); expect(KEY_PREFIXES).toEqual(PREFIXES);
  expect(validateTeamFile(baseTeam, { fs: noFs }).ok).toBe(true);
});
const frames: [string, (value: string) => string][] = [
  ['bare', s => s], ['start', s => s + ' trailing words'], ['end', s => 'leading words ' + s],
  ['backticks', s => '`' + s + '`'], ['parentheses', s => '(' + s + ')'], ['brackets', s => '[' + s + ']'], ['braces', s => '{' + s + '}'],
  ['colon', s => 'label:' + s], ['equals', s => 'label=' + s], ['comma', s => 'label,' + s], ['single quotes', s => "'" + s + "'"], ['double quotes', s => '"' + s + '"'],
];
for (const [index, prefix] of PREFIXES.entries()) for (const [frame, wrap] of frames) test(`prefix ${index + 1}: ${frame} framing refuses in an actual team-file value`, () => {
  const value = wrap(prefix + BODY), text = channel(value), result = validateTeamFile(text, { fs: noFs });
  expect(result.ok).toBe(false); if (result.ok) throw new Error('manufactured credential accepted');
  expect(result.errors).toEqual([{ line: text.split('\n').findIndex(row => row.includes('channel:')) + 1, message: MESSAGE }]);
  expect(JSON.stringify(result.errors)).not.toContain(prefix + BODY);
});
for (const [index, prefix] of PREFIXES.entries()) test(`prefix ${index + 1}: word interiors and a body below sixteen do not refuse`, () => {
  for (const value of ['x' + prefix + BODY, '_' + prefix + BODY, '-' + prefix + BODY, prefix + BODY.slice(0, 15)]) {
    expect(found(`value: ${JSON.stringify(value)}\n`).refused).toEqual([]);
    expect(validateTeamFile(channel(value), { fs: noFs }).ok).toBe(true);
  }
  expect(found(`value: ${JSON.stringify('(' + prefix + BODY.slice(0, 16) + ')')}\n`).refused.map(p => p.message)).toEqual([MESSAGE]);
});
for (const value of ['https://user@example.test/path', 'https://user:password@example.test/path', 'postgres://reader@db.example.test/catalog', 'git+ssh://builder:synthetic@example.test/repo', 'HTTPS://user@example.test/path']) test('URL userinfo is refused: ' + value.split('://')[0] + ', password=' + value.includes('password'), () => {
  const result = validateTeamFile(channel(value), { fs: noFs }); expect(result.ok).toBe(false);
  if (result.ok) throw new Error('userinfo accepted'); expect(result.errors.map(p => p.message)).toEqual(['a URL with credentials: a team file never holds a credential']);
});
test('URL and address controls without userinfo remain values', () => {
  for (const value of ['https://example.test/path', 'https://example.test:8443/path@item', 'user@example.test', 'https://example.test/path?who=user@example.test']) expect(validateTeamFile(channel(value), { fs: noFs }).ok).toBe(true);
});

const fields: [string, (value: string) => string][] = [
  ['lobby', v => `lobby: ${JSON.stringify(v)}\n`],
  ['workspace.path', v => `workspace:\n  path: ${JSON.stringify(v)}\n`],
  ['workspace.protected', v => `workspace:\n  protected: [${JSON.stringify(v)}]\n`],
  ['seats.reach.guard_dir', v => `seats:\n  - reach:\n      guard_dir: ${JSON.stringify(v)}\n`],
  ['watch.queue_dir', v => `watch:\n  queue_dir: ${JSON.stringify(v)}\n`],
];
for (const [name, scalar] of fields) test('only a whole owned directory without a link is exempt at ' + name, () => {
  const w = world(); expect(found(scalar(w.directory), defaultFs)).toEqual({ refused: [], warned: [] });
  const rejected = [join(w.base, PREFIXES[0]! + BODY + '-missing'), w.file, w.finalLink, join(w.ordinaryLink, PREFIXES[0]! + BODY), join(w.finalLink, 'child'),
    ' ' + w.directory, w.directory + ' ', 'inspect ' + w.directory, w.directory + ' suffix', '(' + w.directory + ')'];
  for (const value of rejected) expect(found(scalar(value), defaultFs).refused.map(p => p.message)).toEqual([MESSAGE]);
  let foreignReads = 0;
  const foreign: FsReader = { ...defaultFs, lstat: path => {
    const stat = defaultFs.lstat(path); if (path !== w.directory) return stat; foreignReads++;
    return { ...stat, uid: (process.getuid?.() ?? 0) + 1, isDirectory: () => stat.isDirectory(), isSymbolicLink: () => stat.isSymbolicLink(), isFile: () => stat.isFile() };
  } };
  expect(found(scalar(w.directory), foreign).refused.map(p => p.message)).toEqual([MESSAGE]); expect(foreignReads).toBeGreaterThan(0);
  const unreadable: FsReader = { ...defaultFs, lstat: path => { if (path === w.directory) throw Object.assign(new Error('synthetic unreadable'), { code: 'EACCES' }); return defaultFs.lstat(path); } };
  expect(found(scalar(w.directory), unreadable).refused.map(p => p.message)).toEqual([MESSAGE]);
});
test('free text, launch lines and path-shaped keys outside the closed schema list are never exempt', () => {
  const w = world(), values = [
    `rules: [${JSON.stringify(w.directory)}]\n`, `tools:\n  chat:\n    channel: ${JSON.stringify(w.directory)}\n`,
    `seats:\n  - launch: ${JSON.stringify('AUTH_TOKEN=$(basename ' + w.directory + ') claude')}\n`,
    `seats:\n  - nickname: ${JSON.stringify(w.directory)}\n`, `other:\n  path: ${JSON.stringify(w.directory)}\n`,
    `watch:\n  other:\n    queue_dir: ${JSON.stringify(w.directory)}\n`, `workspace:\n  path:\n    nested: ${JSON.stringify(w.directory)}\n`,
  ];
  for (const text of values) expect(found(text, defaultFs).refused.map(p => p.message)).toEqual([MESSAGE]);
  const launch = baseTeam.replace('launch: fixture', 'launch: ' + JSON.stringify('AUTH_TOKEN=$(basename ' + w.directory + ') claude'));
  const result = validateTeamFile(launch); expect(result.ok).toBe(false);
  if (result.ok) throw new Error('launch reconstruction accepted'); expect(result.errors.map(p => p.message)).toEqual([MESSAGE]);
});
test('a credential-shaped missing trust path retains its warning', () => {
  const path = '/synthetic/missing/' + PREFIXES[0]! + BODY;
  const read = found(`trust: [${JSON.stringify(path)}]\n`);
  expect(read.refused).toEqual([]); expect(read.warned).toEqual([{ line: 1, message: 'a long random-looking value: check it is not a credential' }]);
});

type Snapshot = { base: string; rows: { path: string; sha256: string; parsed: boolean; strings?: number; refused?: Problem[]; warned?: Problem[] }[] };
const snapshot: Snapshot = JSON.parse(fs.readFileSync(new URL('./fixtures/team-file-secret-framing-independent-parity.json', import.meta.url), 'utf8'));
function stringCount(node: YamlNode): number {
  if (node.kind === 'scalar') return typeof node.value === 'string' ? 1 : 0;
  return node.kind === 'seq' ? node.items.reduce((sum, n) => sum + stringCount(n), 0) : node.entries.reduce((sum, e) => sum + stringCount(e.value), 0);
}
test('parity manifest covers all forty-two existing YAML fixtures', () => { expect(snapshot.base).toBe('c2a43418ba71d0c338f2e5fe30725a04f76b8c12'); expect(snapshot.rows).toHaveLength(42); expect(new Set(snapshot.rows.map(r => r.path)).size).toBe(42); });
for (const row of snapshot.rows) test('existing fixture values keep their baseline verdict: ' + row.path, () => {
  const bytes = fs.readFileSync(new URL('../' + row.path, import.meta.url)); expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);
  let root: YamlNode | null = null; try { root = parseYaml(bytes.toString('utf8')); } catch { /* invalid YAML remains invalid */ }
  expect(root !== null).toBe(row.parsed);
  if (root !== null) { expect(stringCount(root)).toBe(row.strings!); expect(findSecrets(root, noFs)).toEqual({ refused: row.refused!, warned: row.warned! }); }
});
