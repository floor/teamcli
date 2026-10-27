// A migrated team has no `.agents/team.yaml`. `team up --dry-run` names the registry config
// (`team config`), and a real team.yaml — `--file` — keeps the file wording.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { notInForce } from '../src/approve/approval.ts';
import { runUp } from '../src/commands/up.ts';
import { checkRulesFile } from '../src/launch/rules-file.ts';
import { RULES_HEAD, TRUST_RULE, rulesText } from '../src/launch/rules.ts';
import { gitEnv, testIo } from './helpers.ts';
import { intoRegistry, underRegistry } from './helpers/registry-team.ts';

const TEAM = `format: 1
project: docs
entity: floor
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scene(): { home: string; root: string; file: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-registry-wording-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'docs');
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  writeFileSync(file, TEAM);
  return { home, root, file };
}

const RULES = {
  orchestrator: 'lead',
  rules: [] as string[],
  signature: { commit: 'Agent: test', pullRequest: 'Agent: test', commitPosition: 'last-line' as const },
  workspace: { mode: 'shared' as const, protected: [] as string[] },
};

describe('registry wording', () => {
  test('the rules text and the never-approved line name the registry when that is the source', () => {
    const registry = rulesText({ ...RULES, origin: 'registry' }, 'option');
    expect(registry).toContain(RULES_HEAD.registry);
    expect(registry).toContain(TRUST_RULE.registry);
    expect(registry).not.toContain('from the team file');
    expect(registry).not.toContain('in the team file');
    const file = rulesText(RULES, 'option');
    expect(file.startsWith(RULES_HEAD.file)).toBe(true);
    expect(file).toContain(TRUST_RULE.file);
    expect(notInForce({ kind: 'none' }, 'registry')).toBe("the team's registry config was never approved on this machine");
    expect(notInForce({ kind: 'none' })).toBe('the file was never approved on this machine');
  });

  test('a rules file that differs names the source it was compared with', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-rules-differ-')));
    made.push(base);
    const path = join(base, 'rules.md');
    writeFileSync(path, 'other');
    chmodSync(path, 0o600);
    expect(checkRulesFile(path, 'wanted', 'registry')).toEqual({
      ok: false,
      what: "its rules file differs from the team's registry config",
    });
    expect(checkRulesFile(path, 'wanted')).toEqual({
      ok: false,
      what: "its rules file differs from the team file's rules",
    });
  });

  test('team up --dry-run in a migrated project with no team.yaml names the registry config', async () => {
    const { home, root, file } = scene();
    intoRegistry(root, home);
    rmSync(file);
    const io = testIo(root, { kind: 'owner' });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const code = await underRegistry(() => runUp(['--dry-run'], io, {
      home,
      sessionRunning: () => false,
      agents: () => [],
    }));
    expect(code).toBe(0);
    expect(io.out).toContain("! warning: the team's registry config was never approved on this machine; dev mode continues\n");
    // The launch line shell-quotes the apostrophe, so the headline is not one literal span.
    expect(io.out).toContain('Rules for this session, from the team');
    expect(io.out).toContain('s registry config:');
    expect(io.out).toContain('never edit `trust:` with `team config`');
    expect(io.out).not.toContain('from the team file');
    expect(io.out).not.toContain('in the team file');
    expect(io.out).not.toContain('the file was never approved');
  });

  test('--file keeps the team-file wording', async () => {
    const { home, root, file } = scene();
    intoRegistry(root, home);
    const io = testIo(root, { kind: 'owner' });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const code = await underRegistry(() => runUp(['--dry-run', '--file', file], io, {
      home,
      sessionRunning: () => false,
      agents: () => [],
    }));
    expect(code).toBe(0);
    expect(io.out).toContain('! warning: the file was never approved on this machine; dev mode continues\n');
    expect(io.out).toContain('Rules for this session, from the team file:');
    expect(io.out).toContain('never edit `trust:` in the team file');
    expect(io.out).not.toContain('s registry config:');
    expect(io.out).not.toContain('with `team config`');
  });
});
