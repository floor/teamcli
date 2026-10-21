// A relaunch that closed its seat and never reached ready leaves the record at "launched". The
// check names that state with the repair a lead runs: `team up` resumes the launch (the map's
// `up` row admits the owner and the team's leads), and the difference is not counted among the
// owner's.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { approvalStanding } from '../src/store/store.ts';
import { updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T09:00:00Z');

const TEXT = `format: 1
project: acme
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
    leads: true
`;

const loaded = validateTeamFile(TEXT);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const seat = loaded.team.seats[0]!;
const TITLE = workspaceLabel(seat);
const DISPLAY = displayAgent(seat);

/** The seat's record after a reload closed it and the new launch timed out: `launched`, with the
 *  pane and workspace the create step made, and no ready record behind it. */
function place(): { base: string; root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-relaunch-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), TEXT);
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      seats: { lead: { stage: 'launched', pane: 'w1:p1', workspace: 'w1' } },
      worktrees: {},
      // A watch has run: only the launch record is this scene's business.
      watch: { pid: 1, heartbeat: NOW.toISOString() },
    };
  });
  // The launch delivered the general brief before it typed: the seat's record and its state entry.
  // The launch stopped at `launched`, so the seat never had the turn that reads it.
  deliverBriefs({ dir: join(root, '.agents'), root, session: 'acme', seats: ['lead'], home, at: NOW.toISOString(), read: false });
  return { base, root, home };
}

function live(): Live {
  return {
    running: true,
    agents: [{ name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
    workspaces: [{ id: 'w1', label: TITLE }],
    screens: { 'w1:p1': CLAUDE_IDLE },
  };
}

function check(root: string, home: string): { code: number; out: string } {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live(),
    branch: () => 'main',
    standing: (at) => approvalStanding(at, home),
    now: () => NOW,
    home,
  });
  return { code, out: `${io.out}${io.err}` };
}

describe('a relaunch left before ready', () => {
  test('the check names the repair a lead runs, and does not count it for the owner', () => {
    const { base, root, home } = place();
    const { code, out } = check(root, home);
    expect(out).toContain('difference: lead: its launch stopped at "launched"\n  repair: team up (it resumes the launch)\n');
    // A delivery is a file fact: the brief landed, and the launch's own difference stands beside
    // it. The seat never had the turn that reads it, so no read is demanded.
    expect(out).toContain('difference: lead: the general seat brief has been delivered; launch not ready\n');
    expect(out).not.toContain('delivered and not read');
    expect(out).not.toContain('before readiness');
    expect(out).not.toContain('the owner runs');
    // The check's summary is the contract's own line: the count alone, no command prefix.
    expect(out).toContain('2 differences\n');
    expect(code).toBe(1);
    rmSync(base, { recursive: true, force: true });
  });
});
