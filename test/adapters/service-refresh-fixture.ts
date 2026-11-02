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
const PREVIOUS_BYTES = 'synthetic previous binary\n';

/** The entry word a written unit runs: its second run word, which is the retained copy the
 *  install made, not the synthetic package folder the copy came from. */
export function unitEntry(text: string): string | null {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '';
  const words = [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((one) => one[1] ?? '');
  return words[1] ?? null;
}

export function refreshFixture(realWait = false, inPlace = false, baseDir = tmpdir()) {
  // Keep the synthetic files in storage a failing scene can inspect. A scene that also writes a
  // client key names a base outside the OS temp folder: a key's own placement rule refuses a
  // folder that overlaps it.
  const base = realpathSync(mkdtempSync(join(baseDir, 'service-refresh-scene-')));
  const root = join(base, 'repo');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  mkdirSync(bin);
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  // The two programs live in a folder of their own, so the entry's own folder — the whole
  // program a synthetic install keeps — is that folder and nothing else.
  const previousEntry = join(bin, 'previous-entry.js');
  const nextEntry = inPlace ? previousEntry : join(bin, 'next-entry.js');
  writeFileSync(previousEntry, PREVIOUS_BYTES);
  if (!inPlace) writeFileSync(nextEntry, 'synthetic replacement binary\n');
  const program: ServiceProgram = { execPath: '/synthetic/runtime', entry: nextEntry, roots: [root] };
  let policy: RefreshPolicy = 'accept';
  let running: 'previous' | 'next' | null = null;
  let runningBytes: string | null = null;
  let clock = 0;
  let stoppingUntil = 0;
  const waits: number[] = [];
  const events: { kind: 'load' | 'stop'; unit: string; accepted: boolean; at: number; bytes?: string; identity?: 'previous' | 'next' }[] = [];
  const healthReads: { running: 'previous' | 'next' | null; bytes: string }[] = [];
  const healthWaits: number[] = [];
  let probeDelay = 0;
  const runner: ServiceRunner = (_command, argv) => {
    if (argv[0] === 'bootout') {
      running = null;
      runningBytes = null;
      stoppingUntil = policy === 'slow-stop' ? clock + 250 : clock;
      events.push({ kind: 'stop', unit: '', accepted: true, at: clock });
      return OK;
    }
    if (argv[0] !== 'bootstrap' || argv[2] === undefined) throw new Error('unexpected synthetic manager operation');
    const unit = readFileSync(argv[2], 'utf8');
    const entry = unitEntry(unit);
    if (entry === null) throw new Error('the synthetic unit names no program');
    const bytes = readFileSync(entry, 'utf8');
    const identity: 'previous' | 'next' = bytes === PREVIOUS_BYTES ? 'previous' : 'next';
    const accepted = running === null && clock >= stoppingUntil && policy !== 'reject-all' &&
      !(policy === 'reject-new' && identity === 'next');
    events.push({ kind: 'load', unit, accepted, at: clock, bytes, identity });
    if (accepted) {
      running = identity;
      runningBytes = bytes;
    }
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
      // The daemon that runs is the program the accepted load started: its own retained copy,
      // read from there, not from the synthetic folder the copy was made from.
      const bytes = runningBytes ?? '';
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
