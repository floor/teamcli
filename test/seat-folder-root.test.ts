// A seat's own folder, <root>/worktrees/<project>/<team>/<seat>, finds its team at <root>, so a
// seat started there can read its inbox. Only that exact shape: any other folder under the root
// is still not a team root (no walk up to a neighbouring project).
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTeamConfig } from '../src/file/team-config.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - .
workspace:
  mode: shared
seats:
  - role: lead
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    mode: shared
`;

const bases: string[] = [];
afterEach(() => { bases.length = 0; });

function world(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'seat-folder-root-')));
  bases.push(root);
  mkdirSync(join(root, '.agents'));
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return root;
}

test('a seat folder four levels under the team root reads that root\'s team', () => {
  const root = world();
  const seat = join(root, 'worktrees', 'acme', 'acme', 'worker');
  mkdirSync(seat, { recursive: true });
  const loaded = readTeamConfig(seat, { source: 'file' });
  expect(loaded.ok).toBe(true);
  if (loaded.ok) expect(loaded.root).toBe(root);
});

test('a folder of another shape under the root is still not a team root', () => {
  const root = world();
  const other = join(root, 'notes', 'acme', 'acme', 'worker');
  mkdirSync(other, { recursive: true });
  expect(readTeamConfig(other, { source: 'file' }).ok).toBe(false);
  const shallow = join(root, 'worktrees', 'worker');
  mkdirSync(shallow, { recursive: true });
  expect(readTeamConfig(shallow, { source: 'file' }).ok).toBe(false);
});
