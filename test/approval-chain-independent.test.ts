// A declared project name does not select a lead from a project that already has a team.
// A seat rename under a drifted chain is refused. A team rename keeps the chain-led
// approval. Approve reads the stored copy under the verified pin only.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalDifferences, approvalOf, recordTeamRenameOf } from '../src/approve/approval.ts';
import { runApprove, type ApproveSources } from '../src/approve/command.ts';
import { runRename } from '../src/commands/rename.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { renameTeamIdentity } from '../src/file/lines.ts';
import { readLeadChain } from '../src/lead-chain.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { approvalStanding, readApproval, storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T08:00:00.000Z');
const bases: string[] = [];

afterEach(() => {
  const held = bases.splice(0);
  discardFixtures(held, { roots: held.map((base) => dirname(base)) });
});

function seat(name: string, leads = false): string {
  return `  - role: implementer
    name: ${name}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
${leads ? '    leads: true\n' : ''}`;
}

function teamText(leadsOn: string | null = null): string {
  return `format: 1
project: oak
session: morning
operator: clerk
workspace:
  mode: shared
seats:
${seat('keeper', leadsOn === 'keeper')}${seat('clerk', leadsOn === 'clerk')}`;
}

function world(): { home: string; root: string; other: string } {
  const base = fixtureBase('approval-chain-');
  bases.push(base);
  const home = join(base, 'throwaway-home');
  const root = join(base, 'oak');
  const other = join(base, 'elm');
  mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, '.agents'), { recursive: true, mode: 0o700 });
  mkdirSync(other, { recursive: true, mode: 0o700 });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText());
  return { home, root, other };
}

function claim(home: string, root: string, projectId: string, leadSeat: string): void {
  upsertProject(home, projectId, { name: projectId, entity: 'north', lead: null, leadSeat, by: 'fixture', at: NOW.toISOString() });
  upsertTeam(home, teamIdOf(root), {
    project: 'oak',
    session: 'morning',
    root,
    projectId,
    by: 'fixture',
    at: NOW.toISOString(),
  });
}

function loaded(home: string, root: string) {
  const read = loadTeamFile(root, { home });
  if (!read.ok) throw new Error(read.errors.map((error) => error.message).join('; '));
  return read;
}

function approve(home: string, root: string): string {
  const read = loaded(home, root);
  const store = storePath(read.team.project, read.root, home);
  writeApproval(
    store,
    { approval: approvalOf(read.team, read.root, NOW), file: readFileSync(join(root, '.agents', 'team.yaml'), 'utf8') },
    read.team.seats,
    home,
    NOW,
  );
  return store;
}

test('a declared project name does not select a lead from a project that already has a team', () => {
  const made = world();
  claim(made.home, made.other, 'pine', 'keeper');
  const occupied = readLeadChain({ home: made.home, root: made.root, inProject: 'pine' });
  expect(occupied).toEqual({ ok: true, chain: {} });

  upsertProject(made.home, 'cedar', { name: 'cedar', entity: 'north', lead: null, leadSeat: 'keeper', by: 'fixture', at: NOW.toISOString() });
  const empty = readLeadChain({ home: made.home, root: made.root, inProject: 'cedar' });
  expect(empty).toEqual({ ok: true, chain: { project: 'keeper' } });
});

test('a seat rename under a drifted chain is refused and the approval stays pinned', async () => {
  const made = world();
  claim(made.home, made.root, 'pine', 'keeper');
  const store = approve(made.home, made.root);
  expect(readApproval(store)?.approval.lead).toBe('keeper');
  upsertProject(made.home, 'pine', { leadSeat: 'clerk', by: 'fixture', at: NOW.toISOString() });

  const io = testIo(made.root, { kind: 'owner' });
  const code = await runRename(['keeper', 'keeper-two'], io, { home: made.home, now: () => NOW });
  expect(code).toBe(1);
  expect(io.err).toContain('the live chain leads with "clerk", but the approval pinned "keeper"');
  const text = readFileSync(join(made.root, '.agents', 'team.yaml'), 'utf8');
  expect(text).toContain('name: keeper\n');
  expect(text).not.toContain('keeper-two');
  expect(approvalStanding(made.root, made.home).kind).toBe('verified');
  expect(readApproval(store)?.approval.lead).toBe('keeper');
});

test('a team rename keeps the chain-led approval', () => {
  const made = world();
  claim(made.home, made.root, 'pine', 'keeper');
  approve(made.home, made.root);
  const before = approvalStanding(made.root, made.home);
  expect(before.kind).toBe('verified');
  const path = join(made.root, '.agents', 'team.yaml');
  writeFileSync(path, renameTeamIdentity(readFileSync(path, 'utf8'), { project: 'oak-next', session: 'morning-next', oldSession: 'morning' }));
  const read = loaded(made.home, made.root);
  recordTeamRenameOf(before, read.team, made.root, { project: 'oak-next', session: 'morning-next', oldSession: 'morning' }, made.home);
  expect(approvalStanding(made.root, made.home).kind).toBe('verified');
  expect(readApproval(storePath(read.team.project, made.root, made.home))?.approval.lead).toBe('keeper');
  expect(approvalDifferences(read.team, made.root, made.home)).toEqual([]);
});

test('approve shows a lead change when an unverified pin was swapped', async () => {
  const made = world();
  claim(made.home, made.root, 'pine', 'keeper');
  const store = approve(made.home, made.root);
  expect(approvalStanding(made.root, made.home).kind).toBe('verified');

  writeFileSync(join(made.root, '.agents', 'team.yaml'), teamText('clerk'));
  const approvalPath = join(store, 'approval.json');
  const raw = JSON.parse(readFileSync(approvalPath, 'utf8')) as { lead?: string };
  raw.lead = 'clerk';
  writeFileSync(approvalPath, `${JSON.stringify(raw, null, 2)}\n`);
  expect(approvalStanding(made.root, made.home).kind).toBe('refused');

  const io = testIo(made.root, { kind: 'owner' });
  const sources: ApproveSources = {
    ask: async () => null,
    waiting: () => 'empty',
    now: () => NOW,
    home: made.home,
  };
  const code = await runApprove(['--show'], io, sources);
  expect(code).toBe(0);
  expect(io.out).not.toContain('only its layout changed');
  expect(io.out).toContain('leads: true');
  expect(io.out).toContain('`orchestrator` changed');
});
