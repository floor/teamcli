// A queued self-restart on a shipped launcher resumes its conversation or does not run
// (src/launch/plan.ts resumeRequired): the shipped Claude Code line names no resume of its own,
// so the plan carries the conversation onto the resolved line. Plan only; nothing is launched.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPlan, upPlan, type UpSeat } from '../../src/launch/plan.ts';
import { validateTeamFile } from '../../src/file/validate.ts';

const CONV = '5f1c2e3a-0b4d-4e6f-8a9b-1c2d3e4f5a6b';
const TEAM = `format: 1
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
    launch: claude
    launcher: claude-code
`;

function planOf(extra: Partial<UpSeat>): string {
  const home = mkdtempSync(join(tmpdir(), 'self-restart-launcher-'));
  try {
    const checked = validateTeamFile(TEAM);
    if (!checked.ok) throw new Error(`refused: ${JSON.stringify(checked.errors)}`);
    const seat: UpSeat = {
      name: 'lead', cli: 'claude-code', launch: 'claude', launcher: 'claude-code', vendor: 'anthropic', role: 'coordinator',
      model: 'Claude Opus', version: '5.5', cwd: '.', label: 'lead · coordinator', displayAgent: 'Claude Opus 5.5 default',
      repairLine: '`team down` then `team up` (to restart the whole team)', stopped: false, rules: '', resolveSession: CONV, ...extra,
    };
    return formatPlan(upPlan({
      root: '/work/acme', session: 'acme', sessionRunning: true, seats: [seat], watchAlive: true, watchLabel: 'Watch · acme',
      home, team: checked.team, resolveLaunch: true,
    }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('the shipped Claude Code line resolves without the conversation unless a resume is required', () => {
  // The gap a self-restart must not fall into: the resolver's resume decision is not on its argv.
  expect(planOf({})).not.toContain(`--resume ${CONV}`);
  expect(planOf({ resumeRequired: true })).toContain(`--resume ${CONV}`);
});
