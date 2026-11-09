// An approval signed over a record from before the watch keys arrived still verifies once the
// build loads them at their defaults: the canonical record keeps the pre-arrival bytes, so the
// signature holds, the standing stays verified, and the file shows no differences. A watch key
// the file sets to a non-default value reopens the approval — the differences name the watch
// section — while the same key written at its default keeps it closed. Every home, key, root and
// seat here is synthetic.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { canonicalTeam } from '../src/file/team-config.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv } from './helpers.ts';

const NOW = new Date('2026-11-09T09:00:00Z');
const owned: string[] = [];
afterEach(() => { discardFixtures(owned); });

const SEATS = `seats:
  - role: coordinator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: synthetic
    model: Synth
    version: "1"
    launch: claude --model synth-claude-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: synthetic
    model: Synth
    version: "1"
    launch: claude --model synth-claude-5
`;

/** A world whose file predates the three watch keys: the section names an older key only. */
function world() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'awd-')));
  owned.push(base);
  const root = join(base, 'watch-team'), home = join(base, 'home');
  const dir = join(root, '.agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(home);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: gitEnv(), stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(join(root, 'README'), 'synthetic approval watch fixture\n');
  git('add', 'README');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'synthetic fixture');
  const file = join(dir, 'team.yaml');
  fs.writeFileSync(file, `format: 1
project: watch-team
session: main
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
  base: main
watch:
  idle_first: 300s
${SEATS}`);
  fs.writeFileSync(join(dir, 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: { main: { seats: {}, workspaces: {} } },
  }, null, 2)}\n`);
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  writeApproval(
    storePath(loaded.team.project, root, home),
    { approval: approvalOf(loaded.team, root, NOW), file: fs.readFileSync(file, 'utf8') },
    loaded.team.seats, home, NOW,
  );
  upsertTeam(home, teamIdOf(root), { project: 'watch-team', session: 'main', root });
  return { base, root, home, file };
}

function reload(root: string, home: string) {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  return loaded.team;
}

test('an approval signed before the watch keys arrived still verifies with them at their defaults', () => {
  const w = world();
  const team = reload(w.root, w.home);
  // The build loads the three keys at their arrival defaults.
  expect(team.watch.leadUnreadAfter).toBe(180);
  expect(team.watch.watchStartLimit).toBe(120);
  expect(team.watch.childLateLimit).toBe(30);
  // The canonical record keeps the pre-arrival bytes an earlier build signed.
  const canonical = canonicalTeam(team);
  expect(canonical).not.toContain('leadUnreadAfter');
  expect(canonical).not.toContain('watchStartLimit');
  expect(canonical).not.toContain('childLateLimit');
  // The signature over those bytes still verifies, and the file shows no differences.
  expect(approvalStanding(w.root, w.home).kind).toBe('verified');
  expect(approvalDifferences(team, w.root, w.home)).toEqual([]);
});

test('a non-default watch value reopens the approval; the default value keeps it closed', () => {
  const w = world();
  const before = reload(w.root, w.home);
  expect(approvalDifferences(before, w.root, w.home)).toEqual([]);
  // A non-default value changes the watch section the approval covered.
  fs.writeFileSync(w.file, fs.readFileSync(w.file, 'utf8').replace('watch:\n', 'watch:\n  lead_unread_after: 90s\n'));
  const moved = reload(w.root, w.home);
  expect(moved.watch.leadUnreadAfter).toBe(90);
  expect(approvalStanding(w.root, w.home).kind).toBe('verified');
  const differences = approvalDifferences(moved, w.root, w.home);
  expect(differences).not.toBeNull();
  if (differences === null) throw new Error('a verified standing gave no differences');
  expect(differences.length).toBeGreaterThan(0);
  expect(differences.join('\n')).toContain('watch');
  // The same key at its default — written, not omitted — reopens nothing.
  fs.writeFileSync(w.file, fs.readFileSync(w.file, 'utf8').replace('lead_unread_after: 90s', 'lead_unread_after: 180s'));
  const settled = reload(w.root, w.home);
  expect(settled.watch.leadUnreadAfter).toBe(180);
  expect(approvalDifferences(settled, w.root, w.home)).toEqual([]);
});
