// The per-run memo of validated team texts (src/file/load.ts `loadTeamText`): within one run the
// same text for the same root, path and options is validated once, a changed text is a new load,
// each caller gets its own copy, a failed load is never kept, a custom filesystem reader is never
// memoised, and outside a run nothing is kept.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTeamText } from '../src/file/load.ts';
import { currentRunMemo, enterRunMemo, leaveRunMemo } from '../src/run-memo.ts';

const TEXT = `format: 1
project: memo
coordinator: lead
operator: lead
session: memo
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Test
    version: "1"
    launch: claude --model test
`;

const made: string[] = [];
afterEach(() => {
  while (currentRunMemo() !== null) leaveRunMemo();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scene(): { home: string; root: string; path: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-load-memo-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'memo');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  return { home, root, path: join(root, '.agents', 'team.yaml') };
}

test('within a run one text is validated once and each caller gets its own copy', () => {
  const { home, root, path } = scene();
  enterRunMemo();
  const first = loadTeamText(TEXT, root, path, { home });
  expect(first.ok).toBe(true);
  expect(currentRunMemo()!.teamLoads.size).toBe(1);
  if (first.ok) first.team.project = 'changed by a caller';
  const second = loadTeamText(TEXT, root, path, { home });
  expect(currentRunMemo()!.teamLoads.size).toBe(1);
  expect(second.ok && second.team.project).toBe('memo');
  // Another session option is another result.
  loadTeamText(TEXT, root, path, { home, session: 'other' });
  expect(currentRunMemo()!.teamLoads.size).toBe(2);
  // A changed text is a new key: a write within the run is never read from the memo.
  const changed = loadTeamText(TEXT.replace('label: lead', 'label: Lead'), root, path, { home });
  expect(changed.ok && changed.team.seats[0]?.label).toBe('Lead');
  expect(currentRunMemo()!.teamLoads.size).toBe(3);
  leaveRunMemo();
  expect(currentRunMemo()).toBeNull();
});

test('a failed load is not kept, a custom reader is not memoised, and outside a run nothing is kept', () => {
  const { home, root, path } = scene();
  expect(loadTeamText(TEXT, root, path, { home }).ok).toBe(true);
  expect(currentRunMemo()).toBeNull();
  enterRunMemo();
  expect(loadTeamText('format: 1\nproject: [', root, path, { home }).ok).toBe(false);
  expect(currentRunMemo()!.teamLoads.size).toBe(0);
  const fs = { lstat: (p: string) => require('node:fs').lstatSync(p), realpath: (p: string) => realpathSync(p) };
  loadTeamText(TEXT, root, path, { home, fs: fs as never });
  expect(currentRunMemo()!.teamLoads.size).toBe(0);
  leaveRunMemo();
});

test('placement is checked again on every load: a folder replaced by a link within the run is refused', () => {
  const { home, root, path } = scene();
  const text = TEXT.replace('workspace:\n  mode: shared\n', 'workspace:\n  mode: worktree\n  base: main\n  path: wt/{task}\n');
  mkdirSync(join(root, 'wt'));
  enterRunMemo();
  const first = loadTeamText(text, root, path, { home });
  expect(first.ok, JSON.stringify(first)).toBe(true);
  // The worktree folder becomes a link to the project's parent, inside the same run.
  renameSync(join(root, 'wt'), join(root, 'wt-old'));
  symlinkSync(join(root, '..'), join(root, 'wt'));
  const second = loadTeamText(text, root, path, { home });
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.errors.map((e) => e.message).join('\n')).toContain("the project's parent");
  leaveRunMemo();
});

test('a write in the run drops the kept validations', async () => {
  const { home, root, path } = scene();
  const { writeAtomic } = await import('../src/state.ts');
  enterRunMemo();
  loadTeamText(TEXT, root, path, { home });
  expect(currentRunMemo()!.teamLoads.size).toBe(1);
  writeAtomic(join(home, 'any.json'), '{}\n');
  expect(currentRunMemo()!.teamLoads.size).toBe(0);
  leaveRunMemo();
});
