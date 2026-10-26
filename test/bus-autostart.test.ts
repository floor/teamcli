// `team up` starts the event bus in its own workspace, the way it starts the watch; `team down`
// closes it; `bus.autostart: false` keeps it the owner's. Status and check read the bus from its
// process marker. Hermetic: plans are pure, markers live in a temp root, no herdr, no real home.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { downPlan, upPlan } from '../src/launch/plan.ts';
import { busHealth, busMarkerPath, readBusMarker, startBus } from '../src/bus/server.ts';
import { busProblemNotes, busStatusNotes } from '../src/bus/notes.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { busLabel } from '../src/watch/pane.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(join(realpathSync('/tmp'), 'tba-'));
  mkdirSync(join(root, '.agents'), { recursive: true });
  roots.push(root);
  return root;
}

const base = {
  root: '/r',
  session: 'scratch',
  sessionRunning: true,
  watchAlive: true,
  watchLabel: 'Watch · scratch',
  seats: [],
};

describe('the up plan starts the bus beside the watch', () => {
  test('a team with no bus answering gets a workspace and `team bus` in it', () => {
    const plan = upPlan({ ...base, startBus: true, busAlive: false, busLabel: busLabel('scratch') });
    const create = plan.find((step) => step.do?.do === 'create' && 'bus' in step.do && step.do.bus === true);
    expect(create?.do).toMatchObject({ do: 'create', label: 'Bus · scratch', cwd: '/r', bus: true });
    expect(plan.find((step) => step.do?.do === 'bus')?.do).toMatchObject({ do: 'bus', label: 'Bus · scratch', command: 'team bus' });
  });
  test('a bus already answering is left to serve', () => {
    const plan = upPlan({ ...base, startBus: true, busAlive: true, busLabel: busLabel('scratch') });
    expect(plan.some((step) => step.do?.do === 'bus')).toBe(false);
  });
  test('autostart off plans no bus', () => {
    const plan = upPlan({ ...base, startBus: false, busAlive: false, busLabel: busLabel('scratch') });
    expect(plan.some((step) => step.do?.do === 'bus' || (step.do?.do === 'create' && 'bus' in step.do && step.do.bus === true))).toBe(false);
  });
});

describe('the down plan closes the bus workspace', () => {
  const down = { session: 'scratch', seats: [], keep: [], extra: 0, watchPid: null };
  test('a recorded bus workspace is closed', () => {
    const plan = downPlan({ ...down, busWorkspace: 'w9' });
    expect(plan.find((step) => step.do?.do === 'close-bus')?.do).toEqual({ do: 'close-bus', workspace: 'w9' });
  });
  test('none recorded, none closed', () => {
    expect(downPlan({ ...down, busWorkspace: null }).some((step) => step.do?.do === 'close-bus')).toBe(false);
  });
});

describe('the bus section', () => {
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
    launch: claude --model claude-opus-5-5
tasks:
  source: file
  path: .agents/tasks.yaml
`;
  test('autostart defaults on, reads false, refuses a non-boolean', () => {
    const plain = validateTeamFile(TEAM);
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(plain.team.bus?.autostart ?? true).toBe(true);
    const off = validateTeamFile(`${TEAM}bus:\n  autostart: false\n`);
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.team.bus?.autostart).toBe(false);
    expect(validateTeamFile(`${TEAM}bus:\n  autostart: maybe\n`).ok).toBe(false);
  });
});

const MINI = `format: 1\nproject: lobby\ncoordinator: lead\noperator: lead\nworkspace:\n  mode: shared\nseats:\n  - role: coordinator\n    name: lead\n    cli: claude-code\n    vendor: test\n    model: Test\n    version: "1"\n    launch: claude\ntasks:\n  source: file\n  path: .agents/tasks.yaml\n`;

describe('status and check read the bus from its marker', () => {
  test('a serving bus writes its marker and clears it on close', async () => {
    const root = tempRoot();
    const home = join(root, 'h');
    mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root });
    const parsed = validateTeamFile(MINI);
    if (!parsed.ok) throw new Error('fixture');
    const started = await startBus({ root, team: parsed.team, home, stderr: () => {}, reconcileIntervalMs: 0 });
    if (started.kind !== 'serving') throw new Error(started.kind);
    const bus = started.handle;
    try {
      expect(readBusMarker(root)?.pid).toBe(process.pid);
      expect(busHealth(root, () => true)).toEqual({ kind: 'running', pid: process.pid });
      expect(busStatusNotes({ root, alive: () => true, autostart: true })[0]).toContain('bus: running');
      expect(busProblemNotes({ root, alive: () => true, autostart: true })).toEqual([]);
    } finally {
      await bus.close();
    }
    expect(readBusMarker(root)).toBeNull();
  });
  test('a dead bus is named with the repair; autostart off names `team bus`', () => {
    const root = tempRoot();
    writeFileSync(busMarkerPath(root), JSON.stringify({ pid: 999999, started: '2026-10-26T10:00:00.000Z' }));
    expect(busHealth(root, () => false)).toEqual({ kind: 'dead', pid: 999999 });
    expect(busProblemNotes({ root, alive: () => false, autostart: true })[0]).toContain('`team up` starts it again');
    expect(busProblemNotes({ root, alive: () => false, autostart: false })[0]).toContain('`team bus`');
  });
  test('no marker: silent unless team up recorded a bus', () => {
    const root = tempRoot();
    expect(busStatusNotes({ root, alive: () => false, autostart: true })).toEqual([]);
    expect(busProblemNotes({ root, alive: () => false, autostart: true, recorded: { pane: 'w9:p1', workspace: 'w9' } })[0]).toContain('not running');
  });
});
