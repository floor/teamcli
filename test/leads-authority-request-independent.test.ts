// Independent scenes for the owner-seat door under the default rule.
// A placed operator's `config set coordinator --request` writes nothing. Approvals revoke and
// import are not lead-writable. Every target folder is judged, so a folder outside the team
// keeps a placed lead from being admitted. Homes, registries and pane names are synthetic.
// No terminal host is started.
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { actionApprovalsFolder } from '../src/client/team-create.ts';
import { ownerSeatStep } from '../src/client/owner-action-step.ts';
import { runApprovals } from '../src/commands/approvals.ts';
import { runConfig } from '../src/commands/config.ts';
import { runImport } from '../src/commands/import.ts';
import { readTeams } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-08T10:00:00Z');
const RULE = 'oa_0123456789abcdef01234567';
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Independent',
      GIT_AUTHOR_EMAIL: 'independent@example.invalid',
      GIT_COMMITTER_NAME: 'Independent',
      GIT_COMMITTER_EMAIL: 'independent@example.invalid',
    },
  });
}

function scene(): { home: string; root: string; outside: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'leads-request-')));
  made.push(home);
  const root = join(home, 'repo');
  const outside = join(home, 'outside');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(outside);
  // This file names entity acme, so the lobby the loader requires is the entity's own folder.
  const lobby = resolveLobby(home, { entity: 'acme' });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  chmodSync(lobby, 0o700);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
entity: acme
session: acme
coordinator: lead
operator: ops
trust:
  - ${lobby}
  - ${root}
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
  - role: implementer
    name: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead' };
    session.seats.ops = { stage: 'ready', pane: 'pane-ops' };
  });
  return { home, root, outside };
}

function lead(): Caller {
  return { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
}

function operator(): Caller {
  return { kind: 'seat', name: 'ops', pane: 'pane-ops', session: 'acme' };
}

function teamFile(root: string): string {
  return readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
}

function registry(home: string): string {
  return JSON.stringify(readTeams(home));
}

test('a placed operator config set coordinator --request writes nothing', async () => {
  const { home, root } = scene();
  const before = teamFile(root);
  const io = testIo(root, operator());
  const code = await runConfig(['set', 'coordinator', 'ops', '--request'], io, { home, now: () => NOW });
  expect(code, io.err + io.out).toBe(1);
  expect(io.err).toContain("only the owner changes the orchestrator's seat");
  expect(teamFile(root)).toBe(before);
  expect(teamFile(root)).toContain('coordinator: lead');
});

test('a placed lead or operator config set --request of an ordinary key writes nothing', async () => {
  const { home, root } = scene();
  const before = teamFile(root);
  const teams = registry(home);
  for (const caller of [lead(), operator()]) {
    const io = testIo(root, caller);
    const code = await runConfig(['set', 'project', 'evil', '--request'], io, { home, now: () => NOW });
    expect(code, io.err + io.out).toBe(0);
    expect(io.out).toContain('owner-seat request');
    expect(teamFile(root)).toBe(before);
    expect(registry(home)).toBe(teams);
  }
});

test('a placed lead cannot revoke an approval rule', async () => {
  const { home, root } = scene();
  const folder = actionApprovalsFolder(home);
  mkdirSync(folder, { recursive: true });
  const rule = join(folder, `${RULE}.json`);
  writeFileSync(rule, '{}\n');
  const io = testIo(root, lead());
  const code = await runApprovals(['revoke', RULE], io, { home, now: () => NOW });
  expect(code, io.err + io.out).toBe(1);
  expect(`${io.out}${io.err}`.includes('revoked')).toBe(false);
  expect(readFileSync(rule, 'utf8')).toBe('{}\n');
});

test('a placed lead import --request writes nothing, and a bare import is refused', async () => {
  const { home, root } = scene();
  const before = teamFile(root);
  const teams = registry(home);
  const asked = testIo(root, lead());
  const requested = await runImport(['--request'], asked, { home, now: () => NOW });
  expect(requested, asked.err + asked.out).toBe(0);
  expect(asked.out).toContain('owner-seat request');
  expect(teamFile(root)).toBe(before);
  expect(registry(home)).toBe(teams);
  const bare = testIo(root, lead());
  const refused = await runImport([], bare, { home, now: () => NOW });
  expect(refused, bare.err + bare.out).toBe(1);
  expect(teamFile(root)).toBe(before);
  expect(registry(home)).toBe(teams);
});

test('every target folder is judged: an outside folder blocks a placed lead', () => {
  const { home, root, outside } = scene();
  const io = testIo(root, lead());
  const ask = { request: false, approval: undefined, dry: false, json: false };
  const own = ownerSeatStep('config', 'team-config', ['set', 'project', 'evil'], ask, io, { home, root }, [root]);
  expect(own.kind).toBe('admitted');
  const mixed = ownerSeatStep('config', 'team-config', ['set', 'project', 'evil'], ask, io, { home, root }, [root, outside]);
  expect(mixed.kind).not.toBe('admitted');
  const reversed = ownerSeatStep('config', 'team-config', ['set', 'project', 'evil'], ask, io, { home, root }, [outside, root]);
  expect(reversed.kind).not.toBe('admitted');
  const approvals = ownerSeatStep('approvals', 'team-revoke-approval', ['revoke', RULE], ask, io, { home, root }, [root, outside]);
  expect(approvals.kind).not.toBe('admitted');
  const imported = ownerSeatStep('import', 'team-import', ['--request'], { ...ask, request: true }, io, { home, root }, [root]);
  expect(imported.kind).not.toBe('admitted');
});
