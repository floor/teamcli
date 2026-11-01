// A synthetic adapter boundary: every registration command is interpreted here, never run.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { darwinServiceManager } from '../../src/daemon/service-darwin.ts';
import type { DaemonHealth } from '../../src/daemon/health.ts';
import type { ServiceProgram, ServiceRunResult, ServiceRunner } from '../../src/daemon/service.ts';

const TEAM = `format: 1
project: sample
coordinator: clerk
operator: op-1
session: sample
workspace:
  mode: shared
seats:
  - role: coordinator
    name: clerk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: worker
    name: op-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

export type RefreshPolicy = 'accept' | 'reject-new' | 'reject-all' | 'slow-stop';
const OK: ServiceRunResult = { status: 0, stdout: '', stderr: '' };
const REFUSED: ServiceRunResult = { status: 23, stdout: '', stderr: 'synthetic load refused' };

export function refreshFixture(realWait = false, inPlace = false) {
  // Keep the synthetic files in temporary storage so a failing scene can be inspected.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'service-refresh-scene-')));
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  const previousEntry = join(base, 'previous-entry.js');
  const nextEntry = inPlace ? previousEntry : join(base, 'next-entry.js');
  writeFileSync(previousEntry, 'synthetic previous binary\n');
  if (!inPlace) writeFileSync(nextEntry, 'synthetic replacement binary\n');
  const program: ServiceProgram = { execPath: '/synthetic/runtime', entry: nextEntry, roots: [root] };
  let policy: RefreshPolicy = 'accept';
  let running: 'previous' | 'next' | null = null;
  let clock = 0;
  let stoppingUntil = 0;
  const waits: number[] = [];
  const events: { kind: 'load' | 'stop'; unit: string; accepted: boolean; at: number; bytes?: string }[] = [];
  const healthReads: { running: 'previous' | 'next' | null; bytes: string }[] = [];
  const healthWaits: number[] = [];
  let probeDelay = 0;
  const runner: ServiceRunner = (_command, argv) => {
    if (argv[0] === 'bootout') {
      running = null;
      stoppingUntil = policy === 'slow-stop' ? clock + 250 : clock;
      events.push({ kind: 'stop', unit: '', accepted: true, at: clock });
      return OK;
    }
    if (argv[0] !== 'bootstrap' || argv[2] === undefined) throw new Error('unexpected synthetic manager operation');
    const unit = readFileSync(argv[2], 'utf8');
    const entry = unit.includes(previousEntry) ? previousEntry : nextEntry;
    const bytes = readFileSync(entry, 'utf8');
    const identity = inPlace ? (bytes === 'synthetic previous binary\n' ? 'previous' : 'next') : unit.includes(previousEntry) ? 'previous' : 'next';
    const accepted = running === null && clock >= stoppingUntil && policy !== 'reject-all' &&
      !(policy === 'reject-new' && identity === 'next');
    events.push({ kind: 'load', unit, accepted, at: clock, bytes });
    if (accepted) running = identity;
    return accepted ? OK : REFUSED;
  };
  const manager = darwinServiceManager({
    uid: 4242,
    runner,
    ...(realWait ? {} : { sleep: (ms: number) => { waits.push(ms); clock += ms; } }),
  });
  const unitPath = manager.unitPath(home);
  return {
    base, root, home, previousEntry, nextEntry, program, manager, unitPath, waits, events, healthReads, healthWaits,
    setProbeDelay(value: number) { probeDelay = value; },
    async health(): Promise<DaemonHealth> {
      const bytes = readFileSync(running === 'previous' ? previousEntry : nextEntry, 'utf8');
      healthReads.push({ running, bytes });
      const answered = running !== null && healthReads.length > probeDelay;
      return {
        daemon: 'teamcli', socket: join(base, 'synthetic.sock'), state: running === null ? 'not-running' : 'running',
        running: running !== null, pid: running === null ? null : 4242, uid: 4242, since: null, startedBy: 'synthetic-service-manager',
        version: 'synthetic', gitHead: null, heartbeatAt: null, features: null, stuck: [], roots: [],
        probe: answered ? { state: 'answered', at: new Date(0).toISOString() } : { state: 'unanswered', at: new Date(0).toISOString(), reason: 'closed' }, why: null,
      };
    },
    async healthSleep(ms: number) { healthWaits.push(ms); },
    running: () => running,
    setPolicy(value: RefreshPolicy) { policy = value; },
    seedPrevious() {
      const installed = manager.install(home, { ...program, entry: previousEntry });
      if (!installed.ok) throw new Error('the synthetic previous unit could not be seeded');
      events.length = 0;
      waits.length = 0;
      return readFileSync(unitPath, 'utf8');
    },
  };
}

// This worker uses the real bounded waits, but its runner still cannot execute a command.
if (import.meta.main) {
  const fixture = refreshFixture(true);
  fixture.setPolicy('reject-all');
  const started = performance.now();
  const result = fixture.manager.install(fixture.home, fixture.program);
  console.log(JSON.stringify({ result, elapsed: performance.now() - started, loads: fixture.events.filter((e) => e.kind === 'load').length }));
}
