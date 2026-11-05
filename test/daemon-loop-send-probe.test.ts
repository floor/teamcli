// The send endpoint's own health probe, at the product's 2,000 ms budget, while one real `send`
// request is being handled.
//
// The endpoint runs on the daemon's event loop with the real host reads
// (src/send/daemon.ts `realDaemonHost`). The terminal host here is a fake on PATH that sleeps
// three seconds on every call and answers the one read this scene reaches (an empty `agent list`);
// the real terminal host is never run. A probe that goes unanswered is judged in the scene's own
// process, where the daemon's loop runs: a 10 ms sampler records every interval's wall and CPU,
// and the fake's own call log names the call whose span covers the probe. That attribution is
// what separates this fault from a host that merely descheduled the process: the loop gap starts
// where the product's blocking call starts and ends where the fake exits, with the call's own
// start and end written down by the fake itself.
//
// Today the probe misses while the first read holds the loop; after the fix every probe answers
// and no gap on the loop covers a call. The request still ends `unreachable` either way: the
// message's outcome is not what this scene changes.
//
// Every world is synthetic: a temporary home, checkout and team file, no live session, credential
// file, seat or pane.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { realDaemonHost, startSendDaemon, type SendDaemonHandle } from '../src/send/daemon.ts';

const PROJECT = 'acme';
const SESSION = 'acme';
const FROM = 'lead';
const TO = 'helper';
/** The budget the machine daemon gives its own probe of a hosted send endpoint. */
const PROBE_BUDGET_MS = 2_000;
/** The fake terminal host's per-call sleep: longer than the probe budget. */
const CALL_MS = 3_000;

let base = '';
let pathBefore: string | undefined;
let logBefore: string | undefined;
const handles: SendDaemonHandle[] = [];
const monitors: Array<ReturnType<typeof setInterval>> = [];

afterEach(async () => {
  for (const monitor of monitors.splice(0)) clearInterval(monitor);
  for (const handle of handles.splice(0)) {
    try { await handle.close(); } catch { /* the scene already closed it */ }
  }
  if (pathBefore !== undefined) process.env.PATH = pathBefore;
  pathBefore = undefined;
  if (logBefore === undefined) delete process.env.HERDR_FAKE_LOG;
  else process.env.HERDR_FAKE_LOG = logBefore;
  logBefore = undefined;
  if (base !== '') rmSync(base, { recursive: true, force: true });
  base = '';
});

function teamYaml(root: string, lobby: string): string {
  return `format: 1
project: ${PROJECT}
coordinator: ${FROM}
operator: ${FROM}
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: ${FROM}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: ${TO}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
}

/** A fake terminal host that records each call with its own start and end, sleeps, then answers
 *  the one read the scene reaches. It is a child of the product's own read, so its log is written
 *  even while the parent's event loop is held. */
function writeFakeHerdr(dir: string): { bin: string; log: string } {
  mkdirSync(dir, { recursive: true });
  const log = join(base, 'herdr-calls.log');
  const script = `#!/bin/sh
stamp() { ${JSON.stringify(process.execPath)} -e 'process.stdout.write(String(Date.now()))'; }
start=$(stamp)
printf '%s\\tstart\\t%s\\n' "$start" "$*" >> "$HERDR_FAKE_LOG"
sleep ${String(CALL_MS / 1000)}
end=$(stamp)
printf '%s\\tend\\t%s\\n' "$end" "$*" >> "$HERDR_FAKE_LOG"
case "$*" in
  *"pane read"*) printf '%s\\n' 'fake screen, empty box' ;;
  *"agent list"*) printf '%s\\n' '{"id":"cli:agent:list","result":{"agents":[],"type":"agent_list"}}' ;;
  *) printf '%s\\n' '{"id":"cli:fake","result":{}}' ;;
esac
`;
  const bin = join(dir, 'herdr');
  writeFileSync(bin, script, { mode: 0o755 });
  return { bin, log };
}

function setupWorld() {
  const short = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();
  base = realpathSync(mkdtempSync(join(short, 'talos-loop-send-')));
  const home = join(base, 'home');
  const root = join(base, PROJECT);
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), teamYaml(root, lobbyDir(home)));
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error('fixture team.yaml failed to load');
  const fake = writeFakeHerdr(join(base, 'bin'));
  return { home, root, dir, team: loaded.team, fake };
}

/** One real `send` frame over the endpoint's socket, resolving its answer line. */
function sendRequest(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the send request was never answered'));
    }, 30_000);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ v: 1, op: 'send', from: FROM, to: TO, body: `from ${FROM} — a synthetic body for the loop scene` })}\n`);
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(buffer.slice(0, nl));
    });
  });
}

type LoopInterval = { began: number; wall: number; cpu: number };
type Probe = { at: number; epoch: number; kind: string; ms: number };
type Call = { start: number; end: number; argv: string };

function callsOf(logPath: string): Call[] {
  if (!existsSync(logPath)) return [];
  const open = new Map<string, number>();
  const calls: Call[] = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const [stamp, phase, argv] = line.split('\t');
    if (stamp === undefined || phase === undefined || argv === undefined) continue;
    const at = Number(stamp);
    if (phase === 'start') open.set(argv, at);
    if (phase === 'end') calls.push({ start: open.get(argv) ?? at - CALL_MS, end: at, argv });
  }
  return calls.sort((a, b) => a.start - b.start);
}

describe('the send endpoint under a real send request', () => {
  test('answers its own health probe at the product budget while a terminal-host read is in flight', async () => {
    const world = setupWorld();
    pathBefore = process.env.PATH;
    logBefore = process.env.HERDR_FAKE_LOG;
    process.env.PATH = `${join(base, 'bin')}:${pathBefore ?? ''}`;
    process.env.HERDR_FAKE_LOG = world.fake.log;

    // The daemon's own event loop, sampled from the process it runs in: each interval's wall gap
    // and the CPU consumed across it. Unlike the cold-read gate's fault, this one is a blocking
    // syscall — little CPU, all the wall — so the interval is attributed to the fake call whose
    // own start and end it covers, and a gap with no call under it stays the host's delay.
    const intervals: LoopInterval[] = [];
    let lastWall = performance.now();
    let lastCpu = process.cpuUsage();
    monitors.push(setInterval(() => {
      const now = performance.now();
      const cpu = process.cpuUsage();
      intervals.push({
        began: Math.round(performance.timeOrigin + lastWall),
        wall: Math.round(now - lastWall),
        cpu: Math.round((cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000),
      });
      lastWall = now;
      lastCpu = cpu;
    }, 10));

    const socketPath = join(base, 'send.sock');
    const started = await startSendDaemon({
      root: world.root,
      dir: world.dir,
      team: world.team,
      // The real host reads with the state folder pointed at this synthetic home, exactly the
      // shape host.ts gives its send endpoint ({ ...realDaemonHost, home }).
      host: { ...realDaemonHost, home: world.home },
      socketPath,
      lockPath: join(base, 'send.lock'),
    });
    if (started.kind !== 'serving') throw new Error(`the endpoint did not start: ${started.kind}`);
    handles.push(started.handle);

    const stopPath = join(base, 'probe.stop');
    const readyPath = join(base, 'probe.ready');
    const childPath = fileURLToPath(new URL('./fixtures/send-probe-child.ts', import.meta.url));
    const prober = Bun.spawn(
      [process.execPath, childPath, socketPath, readyPath, String(PROBE_BUDGET_MS), stopPath],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const readyBy = Date.now() + 10_000;
    while (!existsSync(readyPath)) {
      if (Date.now() > readyBy) throw new Error('the probe child never became ready');
      await new Promise((tick) => setTimeout(tick, 10));
    }

    // The one request: its first real host read is the endpoint's own admission path, and with an
    // empty agent list it is read twice (busy check, then the worker's own resolution).
    const answer = await sendRequest(socketPath);
    const response = JSON.parse(answer) as { ok?: unknown; outcome?: unknown; detail?: unknown };
    expect(response.ok).toBe(false);
    expect(response.outcome).toBe('unreachable');
    expect(String(response.detail)).toContain('no live agent carries that name');

    writeFileSync(stopPath, '');
    const stdout = await new Response(prober.stdout).text();
    const stderr = await new Response(prober.stderr).text();
    const exit = await prober.exited;
    if (exit !== 0) throw new Error(`the probe child failed (${String(exit)}): ${stdout}${stderr}`);

    const probes: Probe[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('PROBE ')) continue;
      const value = JSON.parse(line.slice('PROBE '.length)) as Record<string, unknown>;
      if (value.done !== undefined) continue;
      probes.push({ at: Number(value.at), epoch: Number(value.epoch), kind: String(value.kind), ms: Number(value.ms) });
    }
    const calls = callsOf(world.fake.log);

    // Vacuity: the probe ran repeatedly, the endpoint's request reached the real host reads, and
    // the loop was sampled. The sampler's own count is deliberately not a floor here: a held loop
    // skips its scheduled ticks, so in the red run only a handful of intervals exist and each one
    // is real evidence of a turn that ran late.
    expect(probes.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(intervals.length).toBeGreaterThanOrEqual(5);
    const sampledMs = intervals.reduce((sum, interval) => sum + interval.wall, 0);
    expect(sampledMs).toBeGreaterThan(1_000);

    // A probe answered only after its budget is the endpoint failing to answer its own health
    // check at the product's own cadence.
    const unanswered = probes.filter((probe) => probe.kind !== 'answered');
    expect(unanswered.map((probe) => {
      const from = probe.epoch;
      const to = probe.epoch + probe.ms;
      // The part of each overlapping interval that falls inside the probe's own wait: the loop
      // gap the probe actually sat through, not the interval's whole span.
      const gap = intervals.reduce((sum, interval) => {
        const overlap = Math.min(interval.began + interval.wall, to) - Math.max(interval.began, from);
        return overlap > 0 ? sum + overlap : sum;
      }, 0);
      const covering = calls.filter((call) => call.start <= to && call.end >= from);
      return `+${String(probe.at)} ms: waited ${String(probe.ms)} ms, ${String(Math.round(gap))} ms of it over the loop's own gaps; calls in flight: ${covering.map((call) => call.argv).join(' | ') || '(none)'}`;
    })).toEqual([]);

    // The loop-turn rule, in this fault's own terms: a gap of 1.5 s or more is a held loop only
    // when a fake call's own span sits under it. A gap no call covers is the host's scheduling
    // and is recorded, never failed.
    const long = intervals.filter((interval) => interval.wall >= 1_500);
    const held = long.filter((interval) => calls.some((call) =>
      call.start >= interval.began - 100 && call.end <= interval.began + interval.wall + 100));
    for (const interval of long) {
      if (held.includes(interval)) continue;
      console.log(`loop gap +${String(interval.began)} ms: ${String(interval.wall)} ms wall, ${String(interval.cpu)} ms CPU with no terminal-host call under it (host scheduling)`);
    }
    expect(held.map((interval) => {
      const under = calls.filter((call) =>
        call.start >= interval.began - 100 && call.end <= interval.began + interval.wall + 100);
      return `+${String(interval.began)} ms: ${String(interval.wall)} ms wall, ${String(interval.cpu)} ms CPU: ${under.map((call) => call.argv).join(' | ')}`;
    })).toEqual([]);
  }, 120_000);
});
