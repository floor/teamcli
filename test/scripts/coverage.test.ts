import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { coverageOf, documentOf, trustCaptureNames, trustCapturesModule, type Cell } from '../../scripts/coverage.ts';

const root = join(import.meta.dir, '..', '..');
const shipped = join(root, 'test', 'fixtures');

const dirs: string[] = [];

/** A temporary fixtures folder holding the given files, as `scratch` in the conformance tests. */
function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** A one-screen manifest: `provenance` omitted when not given. */
function manifest(provenance?: string): string {
  const screen: Record<string, string> = { file: 'claude-code/probe.txt', cli: 'claude-code', classify: 'idle', composer: 'idle' };
  if (provenance !== undefined) screen.provenance = provenance;
  return `${JSON.stringify({ screens: [screen], yaml: [] }, null, 2)}\n`;
}

/** The cell counts for the one screen, whatever its provenance turned out to be. */
function counts(of: ReturnType<typeof coverageOf>): { real: number; constructed: number; undocumented: number } {
  return of.cells['claude-code']?.idle ?? { real: -1, constructed: -1, undocumented: -1 };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The reviewer's six README forms. None of them may make the screen real: the first three say it
// was built by hand, the last three say it safely — and none of it matters, because only a stated
// `capture` evidenced by a bullet under a captured heading counts.
const FORMS: [name: string, readme: string][] = [
  ['built by hand, in prose', '# Probe\n\n`probe.txt` was built by hand. Those are constructed too.\n'],
  ['constructed label, in prose', '# Probe\n\nConstructed: `probe.txt`\n'],
  ['heading names the file', '# Probe\n\n## `probe.txt`\n\nConstructed by hand.\n'],
  ['constructed heading, bullet', '# Probe\n\n## Constructed\n\n- `probe.txt`\n'],
  ['negated marker, in prose', '# Probe\n\n`probe.txt` was not constructed.\n'],
  ['reconstructed, in prose', '# Probe\n\n`probe.txt` was reconstructed.\n'],
];

for (const [name, readme] of FORMS) {
  test(`${name}: never real, whatever the prose says`, () => {
    const claimed = scratch({ 'conformance.json': manifest('capture'), 'claude-code/README.md': readme });
    const claimedOf = coverageOf(claimed, {});
    expect(counts(claimedOf).real).toBe(0);
    expect(claimedOf.problems.length).toBe(1);
    expect(claimedOf.problems[0]).toContain('probe.txt');

    const stated = scratch({ 'conformance.json': manifest('constructed'), 'claude-code/README.md': readme });
    expect(counts(coverageOf(stated, {})).constructed).toBe(1);
  });
}

test('a stated capture with a bullet in a captured section is real', () => {
  const dir = scratch({
    'conformance.json': manifest('capture'),
    'claude-code/README.md': '# Probe\n\n- `probe.txt`: the idle box.\n',
  });
  const of = coverageOf(dir, {});
  expect(counts(of)).toEqual({ real: 1, constructed: 0, undocumented: 0 });
  expect(of.problems).toEqual([]);
});

test('an entry with no provenance is undocumented and fails the check', () => {
  const dir = scratch({
    'conformance.json': manifest(),
    'claude-code/README.md': '# Probe\n\n- `probe.txt`: the idle box.\n',
  });
  const of = coverageOf(dir, {});
  expect(counts(of).undocumented).toBe(1);
  expect(of.problems.length).toBe(1);
  expect(of.problems[0]).toContain('probe.txt');
  expect(of.problems[0]).toContain('provenance');
});

test('a capture claim for a file under a Constructed heading fails with both locations', () => {
  const dir = scratch({
    'conformance.json': manifest('capture'),
    'claude-code/README.md': '# Probe\n\n## Constructed\n\n- `probe.txt`: built by hand.\n',
  });
  const of = coverageOf(dir, {});
  expect(counts(of).real).toBe(0);
  expect(of.problems.length).toBe(1);
  expect(of.problems[0]).toContain('probe.txt');
  expect(of.problems[0]).toContain('conformance.json');
  expect(of.problems[0]).toContain('## Constructed');
});

test('a file named under both a captured and a Constructed heading fails', () => {
  const dir = scratch({
    'conformance.json': manifest('constructed'),
    'claude-code/README.md': '# Probe\n\n- `probe.txt`: the idle box.\n\n## Constructed\n\n- `probe.txt`: built by hand.\n',
  });
  const of = coverageOf(dir, {});
  expect(of.problems.length).toBe(1);
  expect(of.problems[0]).toContain('probe.txt');
  expect(of.problems[0]).toContain('both');
});

test('a Not produced section still gives the reason a kind is missing', () => {
  const dir = scratch({
    'conformance.json': manifest('capture'),
    'claude-code/README.md': '# Probe\n\n- `probe.txt`: the idle box.\n\n## Not produced\n\n- permission: not produced: behind the trust dialog\n',
  });
  const of = coverageOf(dir, {});
  expect(of.notProduced['claude-code']?.permission).toBe('behind the trust dialog');
  expect(of.problems).toEqual([]);
});

/** A manifest over version folders: each entry is a file, its classify and its provenance. */
function versioned(entries: [file: string, classify: string, provenance: string][]): string {
  const screens = entries.map(([file, classify, provenance]) => ({ file, cli: 'claude-code', classify, composer: classify, provenance }));
  return `${JSON.stringify({ screens, yaml: [] }, null, 2)}\n`;
}

/** The Not-produced bullets that clear every baseline kind but the excluded one. */
function cleared(...except: string[]): string {
  const rows: [kind: string, note: string][] = [
    ['trust', 'the throwaway was trusted by an earlier scene'],
    ['unsent', 'the composer was not held full'],
    ['working', 'no turn was run'],
    ['question', 'the CLI asked nothing'],
    ['permission', 'no tool was offered'],
    ['unknown', 'the shell back was not captured'],
  ];
  return rows.filter(([kind]) => !except.includes(kind)).map(([kind, note]) => `- \`${kind}\`: not produced: ${note}`).join('\n');
}

test('a profile whose tested.to folder has no captures fails by name', () => {
  const dir = scratch({
    'conformance.json': versioned([['claude-code/2.1.289/idle.txt', 'idle', 'capture']]),
    'claude-code/2.1.289/README.md': '# Old\n\n- `idle.txt`: the idle box.\n',
  });
  const of = coverageOf(dir, { 'claude-code': { from: '2.1.289', to: '2.1.299' } });
  expect(of.problems.length).toBe(2);
  expect(of.problems.some((problem) => problem.includes('tested.to is 2.1.299') && problem.includes('has no captures'))).toBe(true);
  expect(of.problems.some((problem) => problem.includes('tested.to is 2.1.299') && problem.includes('README.md is missing'))).toBe(true);
});

test('a Not produced reason keeps a version number whole', () => {
  const dir = scratch({
    'conformance.json': versioned([['claude-code/2.1.299/idle.txt', 'idle', 'capture']]),
    'claude-code/2.1.299/README.md': '# New\n\n- `idle.txt`: the idle box.\n\n## Not produced\n\n- `unsent`: not produced, the installed binary 2.1.302 is newer than this folder, so it waits.\n',
  });
  const of = coverageOf(dir, {});
  expect(of.notProduced['claude-code']?.unsent).toBe('the installed binary 2.1.302 is newer than this folder');
});

test('a profile with no manifest entries at all is not skipped by the tested.to gate', () => {
  const dir = scratch({
    'conformance.json': versioned([['claude-code/2.1.289/idle.txt', 'idle', 'capture']]),
    'claude-code/2.1.289/README.md': '# Old\n\n- `idle.txt`: the idle box.\n',
  });
  const of = coverageOf(dir, { gemini: { from: '0.64.0', to: '0.64.0' } });
  expect(of.problems.some((problem) => problem.includes('gemini') && problem.includes('README.md is missing'))).toBe(true);
  expect(of.problems.some((problem) => problem.includes('gemini') && problem.includes('has no captures'))).toBe(true);
});

test('the tested.to folder owes the baseline set, and a Not-produced bullet clears its kind', () => {
  const dir = scratch({
    'conformance.json': versioned([['claude-code/2.1.299/idle.txt', 'idle', 'capture']]),
    'claude-code/2.1.299/README.md': `# New\n\n- \`idle.txt\`: the idle box.\n\n## Not produced\n\n${cleared('permission')}\n`,
  });
  const of = coverageOf(dir, { 'claude-code': { from: '2.1.288', to: '2.1.299' } });
  expect(of.problems.length).toBe(1);
  expect(of.problems[0]).toContain('permission.txt');
  expect(of.problems[0]).toContain('2.1.299');
});

test('a version folder older than tested.to is history, not judged', () => {
  const dir = scratch({
    'conformance.json': versioned([
      ['claude-code/2.1.289/idle.txt', 'idle', 'capture'],
      ['claude-code/2.1.299/idle.txt', 'idle', 'capture'],
    ]),
    'claude-code/2.1.289/README.md': '# Old\n\n- `idle.txt`: the idle box.\n',
    'claude-code/2.1.299/README.md': `# New\n\n- \`idle.txt\`: the idle box.\n\n## Not produced\n\n${cleared()}\n`,
  });
  const of = coverageOf(dir, { 'claude-code': { from: '2.1.288', to: '2.1.299' } });
  expect(of.problems).toEqual([]);
});

test('the document records every version folder beside the range the profile claims', () => {
  const dir = scratch({
    'conformance.json': versioned([
      ['claude-code/2.1.289/idle.txt', 'idle', 'capture'],
      ['claude-code/2.1.289/hand.txt', 'idle', 'constructed'],
      ['claude-code/2.1.299/idle.txt', 'idle', 'capture'],
    ]),
    'claude-code/2.1.289/README.md': '# Old\n\n- `idle.txt`: the idle box.\n\n## Constructed\n\n- `hand.txt`: built by hand.\n',
    'claude-code/2.1.299/README.md': `# New\n\n- \`idle.txt\`: the idle box.\n\n## Not produced\n\n${cleared()}\n`,
  });
  const profiles = { 'claude-code': { from: '2.1.288', to: '2.1.299' } };
  const of = coverageOf(dir, profiles);
  expect(of.versions['claude-code']?.tested).toEqual(profiles['claude-code']);
  expect(of.versions['claude-code']?.byVersion['2.1.289']?.idle).toEqual({ real: 1, constructed: 1, undocumented: 0 });
  const doc = JSON.parse(documentOf(dir, profiles)) as {
    versions: Record<string, { byVersion: Record<string, Record<string, Cell>> }>;
  };
  expect(doc.versions['claude-code']?.byVersion['2.1.299']?.idle).toEqual({ real: 1, constructed: 0, undocumented: 0 });
});

test('the shipped fixtures state a provenance the READMEs evidence, and the document is current', () => {
  const of = coverageOf(shipped);
  expect(of.problems).toEqual([]);
  expect(documentOf(shipped)).toBe(readFileSync(join(root, 'contract', 'capture-coverage.json'), 'utf8'));
});

test('the embedded captures are the manifest captures, and the module is current', () => {
  const dir = scratch({
    'conformance.json': `${JSON.stringify({
      screens: [
        { file: 'claude-code/trust.txt', cli: 'claude-code', classify: 'trust', provenance: 'capture' },
        { file: 'claude-code/built.txt', cli: 'claude-code', classify: 'trust', provenance: 'constructed' },
      ],
    }, null, 2)}\n`,
  });
  expect(trustCaptureNames(dir)).toEqual(['claude-code claude-code/trust.txt']);
  expect(trustCapturesModule(dir)).toContain('"claude-code claude-code/trust.txt"');
  expect(trustCapturesModule(dir)).not.toContain('built.txt');
  expect(trustCapturesModule(shipped)).toBe(readFileSync(join(root, 'src', 'profiles', 'trust-captures.ts'), 'utf8'));
});
