// `dialogs:` is the 0.4 line's trust-dialog setting. This build reads and ignores it: a file
// that carries it still loads, the key grants nothing — trust answering is the owner's live team
// grant — and `team check` and `team doctor` name the deprecation, with its repair. The key is not an owner
// section, so it changes no approval digest, and it is not a difference, so it changes no exit.
// Fake herdr throughout: no live session is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { OWNER_SECTIONS } from '../src/approve/fingerprint.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { dialogsTrustInForce } from '../src/permissions/dialogs-trust.ts';
import { approvalStanding } from '../src/store/store.ts';
import { updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T11:00:00Z');

/** The team file, ending where a 0.4-era file would write its `dialogs:` section. */
function teamYaml(extra = ''): string {
  return `format: 1
project: acme
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
    leads: true
${extra}`;
}

const loaded = validateTeamFile(teamYaml());
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const seat = loaded.team.seats[0]!;
/** Line 1 as the file writes it, so a clean world carries no label drift. */
const TITLE = workspaceLabel(seat);
/** Line 2 as the file writes it, so a clean world carries no display drift. */
const DISPLAY = displayAgent(seat);

const REPAIR = 'remove dialogs: from {file}; trust answering is now an owner grant: team grant @team --capabilities dialogs.trust';

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

function place(text: string): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-dialogs-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), text);
  // The seat's pane as the launch recorded it, and a watch pass recent enough that the run
  // itself is no difference: the two ambient findings every clean check world seeds away.
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      seats: { lead: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' } },
      worktrees: {},
      watch: { pid: 1, heartbeat: NOW.toISOString() },
    };
  });
  // The launch delivered the general brief before it typed: the seat's record and its state entry.
  deliverBriefs({ dir: join(root, '.agents'), root, session: 'acme', seats: ['lead'], home, at: NOW.toISOString() });
  return { root, home };
}

/** The live session as herdr answers it, with the seat's sidebar lines as the file writes them. */
function live(): Live {
  return {
    running: true,
    agents: [
      {
        name: 'lead',
        agent: 'claude',
        pane: 'w1:p1',
        workspace: 'w1',
        status: 'idle',
        cwd: null,
        displayAgent: DISPLAY,
      },
    ],
    workspaces: [{ id: 'w1', label: TITLE }],
    screens: { 'w1:p1': CLAUDE_IDLE },
  };
}

function check(root: string, home: string): { code: number; out: string } {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live(),
    branch: () => 'main',
    standing: (at) => approvalStanding(at, join(root, 'nowhere')),
    now: () => NOW,
    home,
  });
  return { code, out: `${io.out}${io.err}` };
}

describe('the dialogs section the 0.4 line wrote', () => {
  test('an old file with dialogs.trust loads, and the key grants nothing', () => {
    const text = teamYaml('dialogs:\n  trust: orchestrator\n');
    const result = validateTeamFile(text);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    // Read and ignored: the parsed team has no dialogs value at all, so nothing downstream can
    // act on the key. No warning either — deprecations travel in their own list, which `team
    // check` and `team doctor` print, so every other command stays quiet about it.
    expect('dialogs' in result.team).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.deprecations).toEqual([{
      line: text.split('\n').indexOf('dialogs:') + 1,
      message: '`dialogs:` is deprecated and grants nothing',
      repair: REPAIR,
    }]);
    // Not an owner section: the approval digest never carries it again.
    expect(OWNER_SECTIONS).not.toContain('dialogs');
  });

  test('any shape under the key loads: the value is ignored, not judged', () => {
    for (const extra of ['dialogs:\n', 'dialogs: 5\n', 'dialogs:\n  permission: owner\n', 'dialogs:\n  trust: someone\n']) {
      const result = validateTeamFile(teamYaml(extra));
      expect(result.ok).toBe(true);
    }
  });

  test('the key grants no live dialogs.trust: the owner grant alone does', () => {
    const { root, home } = place(teamYaml('dialogs:\n  trust: orchestrator\n'));
    expect(dialogsTrustInForce(home, root, NOW)).toBe(false);
  });

  test('team check names the deprecation with its repair, and it is no difference', () => {
    const text = teamYaml('dialogs:\n  trust: orchestrator\n');
    const { root, home } = place(text);
    const { code, out } = check(root, home);
    const line = text.split('\n').indexOf('dialogs:') + 1;
    expect(out).toContain(
      `warning: the file, line ${line}: \`dialogs:\` is deprecated and grants nothing; `
      + 'repair: remove dialogs: from team config; trust answering is now an owner grant: '
      + 'team grant @team --capabilities dialogs.trust',
    );
    // A warning is not a difference: nothing to count, nothing to fail, no change to the exit.
    expect(out).not.toContain('difference:');
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test('team doctor names the deprecation too, with the message and repair check prints', async () => {
    const text = teamYaml('dialogs:\n  trust: orchestrator\n');
    const { root, home } = place(text);
    const io = testIo(root, { kind: 'owner' });
    const sources: DoctorSources = {
      version: () => '2.1.288 (Claude Code)',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => false,
      now: () => NOW,
      home,
    };
    await runDoctor(['--file', '.agents/team.yaml'], io, sources);
    const line = text.split('\n').indexOf('dialogs:') + 1;
    // The same sentence `team check` prints, in doctor's `warn` line.
    expect(io.out).toContain(
      `warn  the file, line ${line}: \`dialogs:\` is deprecated and grants nothing; `
      + 'repair: remove dialogs: from team config; trust answering is now an owner grant: '
      + 'team grant @team --capabilities dialogs.trust',
    );
  });

  test('a file without the key draws no warning', () => {
    const { root, home } = place(teamYaml());
    const { code, out } = check(root, home);
    expect(out).not.toContain('warning:');
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test('the loader hands the deprecation to the check alone, not to the warning list other commands print', () => {
    const { root, home } = place(teamYaml('dialogs:\n  trust: orchestrator\n'));
    const file = loadTeamFile(root, { home });
    if (!file.ok) throw new Error(JSON.stringify(file.errors));
    expect(file.warnings).toEqual([]);
    expect(file.deprecations).toHaveLength(1);
  });
});
