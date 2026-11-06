// Dev mode folds a legacy approval for `team worktree` the way `team restart` does.
// Outside dev mode the refusal stays. The fixture is a format-1 record: nothing here signs.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyApprovalRecord } from './legacy-approval.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { runWorktree } from '../src/commands/worktree.ts';
import { LEGACY_LINE, storePath } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-03T21:00:00Z');
const YAML = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
const RENEW = 'standing cannot be renewed in this build, and the owner is to be told';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wt-stand-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  writeFileSync(join(root, '.agents', 'team.yaml'), YAML);
  const loaded = readTeamConfig(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const store = storePath(loaded.team.project, loaded.root, home);
  mkdirSync(store, { recursive: true });
  const record = legacyApprovalRecord(loaded.team, loaded.root, YAML, NOW);
  writeFileSync(join(store, 'approval.json'), `${JSON.stringify(record, null, 2)}\n`);
  return { root, home };
}

describe('worktree and a legacy approval', () => {
  test('dev mode names the record and still lists', async () => {
    const { root, home } = fixture();
    const io = testIo(root, { kind: 'owner' });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runWorktree(['list'], io, { home, now: () => NOW }), io.err).toBe(0);
    expect(io.err).toContain(RENEW);
    expect(io.err).toContain('unverified lines');
  });

  test('outside dev mode a legacy record still refuses', async () => {
    const { root, home } = fixture();
    const io = testIo(root, { kind: 'owner' });
    expect(await runWorktree(['list'], io, { home, now: () => NOW })).toBe(1);
    expect(io.err).toContain(LEGACY_LINE);
    expect(io.err).not.toContain(RENEW);
  });
});
