// `team bus` wired against a stand-in server: the command and the policy chain are the real
// ones, and only `startBus` is replaced so the numbers handed to the server can be read. It runs
// as its own process so the stand-in is in place before the command loads. Two scenes share the
// stand-in: a chain with values at entity, team and seat levels (the seat word must not reach the
// bus), and a chain that will not load (the command must stop before asking the server to start).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';
import * as realServer from '../src/bus/server.ts';
import type { StartBusInput } from '../src/bus/server.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T12:00:00.000Z');

const TEAM_YAML = `format: 1
project: acme
entity: floor
coordinator: lead
operator: lead
session: acme
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
    leads: true
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

type Captured = {
  reconcileIntervalMs: number | undefined;
  retentionSeconds: number | undefined;
  heldThresholdSeconds: number | undefined;
};

let captured: Captured | null = null;
let starts = 0;

mock.module('../src/bus/server.ts', () => ({
  ...realServer,
  startBus: async (input: StartBusInput) => {
    starts += 1;
    captured = {
      reconcileIntervalMs: input.reconcileIntervalMs,
      retentionSeconds: input.retentionSeconds,
      heldThresholdSeconds: input.heldThresholdSeconds,
    };
    return {
      kind: 'serving' as const,
      cleared: false,
      handle: { reconcileNow: async () => {}, close: async () => {} },
    };
  },
}));

const { runBus } = await import('../src/commands/bus.ts');

function base(): { base: string; home: string; root: string; teamId: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-event-thresholds-bus-')));
  const home = join(dir, 'home');
  const root = join(dir, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  return { base: dir, home, root, teamId: teamIdOf(root) };
}

function stopNextTick(): (end: () => void) => () => void {
  return (end) => {
    setTimeout(end, 0);
    return () => {};
  };
}

async function scene(fx: { home: string; root: string }): Promise<{ code: number; starts: number }> {
  const before = starts;
  const io = testIo(fx.root, { kind: 'owner' });
  const code = await runBus([], io, { home: fx.home, stop: stopNextTick() });
  return { code, starts: starts - before };
}

// Entity holds the bus's held word at 120; the team tightens it to 90 and sets the reconcile
// period and retention window; a seat word of 30 must not reach the bus, which reads to the team.
const wired = base();
const worker = registerAgent(wired.home, {
  name: 'worker',
  signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
  lab: 'anthropic',
  cli: 'claude-code',
  launcher: null,
  launch: 'claude',
  reach: { team: wired.teamId, seat: 'worker', session: 'acme', pane: 'w2:p1', address: null },
  mcp: [],
  skills: [],
  lifecycle: 'running',
  by: 'owner',
});
for (const written of [
  { level: 'entity' as const, target: 'floor', name: 'event-held-threshold-seconds', value: 120 },
  { level: 'team' as const, target: wired.teamId, teamRoot: wired.root, name: 'event-held-threshold-seconds', value: 90 },
  { level: 'team' as const, target: wired.teamId, teamRoot: wired.root, name: 'event-reconcile-interval-seconds', value: 7 },
  { level: 'team' as const, target: wired.teamId, teamRoot: wired.root, name: 'event-retention-days', value: 2 },
  { level: 'seat' as const, target: worker.id, name: 'event-held-threshold-seconds', value: 30 },
]) {
  const set = writePolicySet(wired.home, written, { now: NOW });
  if (!set.ok) throw new Error(set.why);
}
captured = null;
const wiredScene = await scene(wired);
const wiredCaptured = captured;

// An entity source the policy reader cannot parse: the command must refuse before the server is
// asked to start, so the stand-in is not called again.
const broken = base();
mkdirSync(join(broken.home, '.config', 'team'), { recursive: true });
writeFileSync(join(broken.home, '.config', 'team', 'entities.yaml'), 'entities:\n  floor: [\n');
captured = null;
const brokenScene = await scene(broken);

rmSync(wired.base, { recursive: true, force: true });
rmSync(broken.base, { recursive: true, force: true });

console.log(JSON.stringify({ wired: { ...wiredScene, captured: wiredCaptured }, broken: { ...brokenScene, captured } }));
