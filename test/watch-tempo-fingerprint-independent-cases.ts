// Independent scenes for the approval fingerprint's scope after the two new watch tempo keys.
// The record is written as the code before the keys wrote it — every record in the fleet today.
// It keeps running while the keys are absent or written at their approval-time defaults; a
// non-default value on either key, or any later watch change, reopens it for approval. Every
// file below is synthetic; nothing here reads a real store.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { assertIndependentHome } from './independent-home-fixture.ts';
import { gitEnv } from './helpers.ts';

const NOW = new Date('2026-11-09T12:00:00Z');
const owned: string[] = [];

afterEach(() => {
  const paths = owned.splice(0).filter(p => fs.existsSync(p));
  if (paths.length) discardFixtures(paths);
});

const SEATS = `seats:
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'wtfp-'))); owned.push(base);
  const root = join(base, 'tempo'), home = join(base, 'home');
  const dir = join(root, '.agents');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const file = join(dir, 'team.yaml');
  const write = (watch: string) => fs.writeFileSync(file, `format: 1
project: tempo
session: main
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
  base: main
${watch}${SEATS}`);
  write('');
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  // The record is written as the code before the two keys wrote it: the approved copy carries
  // the watch section without them, which is what every approval in the fleet holds today.
  const watch = { ...(loaded.team.watch as Record<string, unknown>) };
  delete watch.watchStartLimit;
  delete watch.childLateLimit;
  const preKeys = { ...loaded.team, watch } as typeof loaded.team;
  writeApproval(
    storePath(loaded.team.project, root, home),
    { approval: approvalOf(preKeys, root, NOW), file: fs.readFileSync(file, 'utf8') },
    loaded.team.seats, home, NOW,
  );
  // What the file still owes its approval: empty means the file matches the record and runs.
  const differences = (): string[] => {
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
    const owed = approvalDifferences(loaded.team, root, home);
    if (owed === null) throw new Error('no verified approval is in force for this root');
    return owed;
  };
  return { base, root, home, file, write, differences };
}

test('the suite and all module defaults use the internally created HOME', () => { assertIndependentHome(); });

test('a pre-key record keeps running when the keys are absent or at their defaults', () => {
  const w = world();
  expect(w.differences()).toEqual([]);
  w.write(`watch:
  watch_start_limit: 120s
  child_late_limit: 30
`);
  expect(w.differences()).toEqual([]);
});

test('a non-default value or a later change reopens it', () => {
  const nonDefault = world();
  nonDefault.write(`watch:
  watch_start_limit: 180s
  child_late_limit: 45
`);
  const owedKeys = nonDefault.differences();
  expect(owedKeys).not.toEqual([]);
  expect(owedKeys.join('\n')).toContain('watch');
  const later = world();
  // `interval` sits in every digest shape, so an edit of it is never covered by the exclusion.
  later.write(`watch:
  interval: 7m
`);
  const owedInterval = later.differences();
  expect(owedInterval).not.toEqual([]);
  expect(owedInterval.join('\n')).toContain('watch');
});
