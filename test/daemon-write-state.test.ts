// LL2: the daemon's state record is written once per beat, off the loop, and only when its
// content changed — so a slow write can never hold the health probe. A counting, gateable
// writer stands in for the disk; synthetic homes and repositories only.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { daemonStatePath } from '../src/daemon/paths.ts';
import { readDaemonState, writeDaemonStateText } from '../src/daemon/state.ts';

const TEAM = `format: 1
project: acme
coordinator: clerk
operator: op-1
session: acme
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

const bases: string[] = [];

function scratch(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-write-state-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return { root, home };
}

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitServing(home: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const health = await daemonHealth(home);
    if (health.roots[0]?.send === 'serving' && health.roots[0]?.bus === 'serving') return;
    if (Date.now() > deadline) throw new Error('the daemon never served its root');
    await sleep(10);
  }
}

describe('the state record is written once per beat, off the loop, on change only', () => {
  test('one write per beat once serving', async () => {
    const { root, home } = scratch();
    let writes = 0;
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: 'test',
      heartbeatMs: 50,
      stateWriter: async (writerHome, text) => { writes += 1; await writeDaemonStateText(writerHome, text); },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      await waitServing(home);
      await sleep(120);
      writes = 0;
      await sleep(360);
      // Seven beats at 50 ms: one write each, never the old two.
      expect(writes).toBeGreaterThanOrEqual(4);
      expect(writes).toBeLessThanOrEqual(9);
    } finally {
      await started.daemon.close();
    }
  });

  test('a beat that changes nothing writes nothing', async () => {
    const { root, home } = scratch();
    let writes = 0;
    const fixed = new Date('2026-11-05T12:00:00Z');
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: 'test',
      heartbeatMs: 50,
      now: () => fixed,
      stateWriter: async (writerHome, text) => { writes += 1; await writeDaemonStateText(writerHome, text); },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      await waitServing(home);
      await sleep(150);
      writes = 0;
      await sleep(320);
      expect(writes).toBe(0);
    } finally {
      await started.daemon.close();
    }
  });

  test('the probe answers while a state write is still in flight', async () => {
    const { root, home } = scratch();
    const gate: { release: (() => void) | null } = { release: null };
    let gated = false;
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: 'test',
      heartbeatMs: 50,
      stateWriter: async (writerHome, text) => {
        if (gated) await new Promise<void>((resolve) => { gate.release = resolve; });
        await writeDaemonStateText(writerHome, text);
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      await waitServing(home);
      gated = true;
      // Let a beat queue its write behind the gate, then probe: the answer must not wait
      // for the disk.
      await sleep(120);
      expect(gate.release).not.toBeNull();
      const probeStarted = Date.now();
      const health = await daemonHealth(home);
      expect(health.state).toBe('running');
      expect(Date.now() - probeStarted).toBeLessThan(400);
    } finally {
      gated = false;
      gate.release?.();
      await started.daemon.close();
    }
  });

  test('a crash after a partial temp write leaves the old record whole, and the next beats recover', async () => {
    const { root, home } = scratch();
    let crashing = false;
    let inFlight = 0;
    let maxInFlight = 0;
    const started = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: 'test',
      heartbeatMs: 50,
      stateWriter: async (writerHome, text) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (crashing) {
            // The simulated crash: half the new record reaches the temp file in the same
            // folder, then the writer dies before the rename. No real signal is sent.
            writeFileSync(`${daemonStatePath(writerHome)}.${String(process.pid)}.tmp`, text.slice(0, 40));
            throw new Error('simulated crash before the rename');
          }
          await writeDaemonStateText(writerHome, text);
        } finally {
          inFlight -= 1;
        }
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      await waitServing(home);
      await sleep(150);
      // Flip first, then wait for the writer to go idle: a write that entered the writer
      // before the flip may still land, and `before` must be read after it has.
      crashing = true;
      const idleDeadline = Date.now() + 3000;
      while (inFlight > 0) {
        if (Date.now() > idleDeadline) throw new Error('the writer never went idle after the flip');
        await sleep(5);
      }
      const before = readDaemonState(home);
      expect(before.kind).toBe('ok');
      if (before.kind !== 'ok') return;
      await sleep(220);
      // Every write in the crash window died mid-temp; the record on disk is still the old
      // one, whole and readable, never the partial temp text.
      const during = readDaemonState(home);
      expect(during.kind).toBe('ok');
      if (during.kind !== 'ok') return;
      expect(during.state.heartbeatAt).toBe(before.state.heartbeatAt);
      expect(maxInFlight).toBe(1);
      // The daemon itself never noticed: the probe answers from memory throughout.
      const health = await daemonHealth(home);
      expect(health.state).toBe('running');
      crashing = false;
      const deadline = Date.now() + 3000;
      for (;;) {
        const after = readDaemonState(home);
        if (after.kind === 'ok' && after.state.heartbeatAt > before.state.heartbeatAt) break;
        if (Date.now() > deadline) throw new Error('the record never advanced after the crash window');
        await sleep(10);
      }
    } finally {
      crashing = false;
      await started.daemon.close();
    }
  });
});
