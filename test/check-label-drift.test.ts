// The two herdr sidebar lines a running file seat carries, as `team check` reports them: line 1
// is the file's own workspace label and nothing else writes it, so a different one is drift; line
// 2 may legitimately carry the model the pane shows or an effort word a screen showed (the
// watch's own line, `src/labels/observe.ts`), so only a line the file and the pane both fail to
// explain is drift. Both repairs are `team register <seat>`, which re-applies the file's two lines
// without a relaunch.
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
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T00:30:00Z');

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
/** Line 1 as the file writes it: `lead · coordinator`, the seat writes no label. */
const TITLE = workspaceLabel(seat);
/** Line 2 as the file writes it: `Claude Opus 5.5 default`, the seat sets no effort. */
const DISPLAY = displayAgent(seat);

function place(): { base: string; root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-drift-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), TEXT);
  // The seat's pane as the launch recorded it: the one pane the check reads a sidebar for.
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' } }, worktrees: {} };
  });
  return { base, root, home };
}

/** The live session as herdr answers it, with the seat's two sidebar lines as the arguments say. */
function live(title: string, display: string | undefined): Live {
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
        ...(display === undefined ? {} : { displayAgent: display }),
      },
    ],
    workspaces: [{ id: 'w1', label: title }],
    screens: {},
  };
}

function check(root: string, home: string, session: Live): { code: number; out: string } {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => session,
    branch: () => 'main',
    standing: (at) => approvalStanding(at, home),
    now: () => NOW,
    home,
  });
  return { code, out: `${io.out}${io.err}` };
}

describe('the sidebar the file is entitled to', () => {
  test('the file\'s own two lines are not a difference', () => {
    const { base, root, home } = place();
    const { out } = check(root, home, live(TITLE, DISPLAY));
    expect(out).not.toContain('its herdr workspace label reads');
    expect(out).not.toContain('its herdr display');
    rmSync(base, { recursive: true, force: true });
  });

  test('an effort word a screen showed is the watch\'s own line, not a difference', () => {
    const { base, root, home } = place();
    // The file sets no effort and the screen shows none now; the watch keeps the word it saw.
    const { out } = check(root, home, live(TITLE, 'Claude Opus 5.5 high'));
    expect(out).not.toContain('its herdr display');
    rmSync(base, { recursive: true, force: true });
  });

  test('a different workspace label is a difference, repaired by team register', () => {
    const { base, root, home } = place();
    const { code, out } = check(root, home, live('stale title', DISPLAY));
    expect(out).toContain(`difference: lead: its herdr workspace label reads "stale title", the file says "${TITLE}"`);
    expect(out).toContain('  repair: team register lead');
    expect(code).toBe(1);
    rmSync(base, { recursive: true, force: true });
  });

  test('a display line neither the file nor the pane explains is a difference', () => {
    const { base, root, home } = place();
    const { code, out } = check(root, home, live(TITLE, 'Something Else default'));
    expect(out).toContain(`difference: lead: its herdr display reads "Something Else default", the file's line is "${DISPLAY}"`);
    expect(out).toContain('  repair: team register lead');
    expect(code).toBe(1);
    rmSync(base, { recursive: true, force: true });
  });

  test('a pane herdr holds no display for is not drift', () => {
    const { base, root, home } = place();
    // Many panes never had a display reported, and the file does not require one: only a line
    // something else wrote is a difference.
    const { out } = check(root, home, live(TITLE, undefined));
    expect(out).not.toContain('its herdr display');
    rmSync(base, { recursive: true, force: true });
  });

  test('a pane the state does not record for the seat is not read', () => {
    const { base, root, home } = place();
    // No state record of that pane at all: the pane is not this seat's, so its lines are nobody's
    // business here even though herdr lists the name on it.
    writeFileSync(join(root, '.agents', 'team.state.json'), JSON.stringify({ format: 1, sessions: {} }));
    const { out } = check(root, home, live('stale title', 'Something Else default'));
    expect(out).not.toContain('its herdr workspace label reads');
    expect(out).not.toContain('its herdr display');
    rmSync(base, { recursive: true, force: true });
  });
});
