// A watch that stays starting, and a chores child that stays late, are restarted for that root
// alone. The daemon beat is what decides: it ticks the chores fleet, then restarts a stuck
// child. These scenes start that daemon on a fake clock and fixture children.
//
// The fleet starts a replacement from the child's exited promise, so a child that is stopped
// settles that promise when it leaves. The clock moves between beats. A 120s limit is one beat
// at that instant, not a 120s wait. No child process is spawned, and teardown stops only the
// children this file built.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ChoresChildMessage, ChoresHostMessage } from '../src/daemon/chores/protocol.ts';
import type { ChoresChild, ChoresChildEvent } from '../src/daemon/chores/spawn.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { daemonLogPath } from '../src/daemon/paths.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import type { HostedWatchState } from '../src/watch/hosted.ts';

const TEAM_YAML = `format: 1
entity: corp
project: acme
session: acme-dev
coordinator: seat-lead
operator: seat-lead
workspace:
  mode: shared
watch:
  watch_start_limit: 120s
  child_late_limit: 30
seats:
  - name: seat-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    delivery_order:
      - drop
`;

const HEARTBEAT_MS = 20;
const START_JUMP_MS = 121_000;
const LATE_LIMIT = 30;
const HOUR_MS = 60 * 60 * 1000;
const RSS = 48 * 1024 * 1024;

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type Phase = 'starting' | 'running' | 'silent' | 'progressing' | 'foreign-progress';

type Fake = {
  root: string;
  kills: { why: string; graceMs: number | undefined }[];
  heard: number;
  lastHeard: number;
  child: ChoresChild;
};

type Scene = {
  home: string;
  stuck: string;
  other: string;
  clock: { at: number };
  phase: { stuck: Phase };
  spawned: Fake[];
  close: () => Promise<void>;
  step: (ms?: number) => Promise<void>;
};

function git(root: string): void {
  execFileSync('git', ['init', '-q'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Independent',
      GIT_AUTHOR_EMAIL: 'independent@example.invalid',
      GIT_COMMITTER_NAME: 'Independent',
      GIT_COMMITTER_EMAIL: 'independent@example.invalid',
    },
  });
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

async function until(check: () => boolean, label: string, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function heartbeat(at: number, cpuMs: number): ChoresChildMessage {
  return { type: 'heartbeat', at: new Date(at).toISOString(), rssBytes: RSS, busy: null, markerCache: null, cpuMs };
}

function watchState(root: string, phase: 'starting' | 'running', startedAtMs: number): ChoresChildMessage {
  const startedAt = new Date(startedAtMs).toISOString();
  const state: HostedWatchState = {
    routeId: `route-${phase}`,
    root,
    team: 'acme',
    session: 'acme-dev',
    phase,
    startedAt,
    lastCycleAt: phase === 'running' ? startedAt : null,
    lastCycleOutcome: phase === 'running' ? 'pass' : null,
    cycles: phase === 'running' ? 1 : 0,
    failures: 0,
    effects: 'blocked',
    required: true,
    why: null,
  };
  return { type: 'watch-state', root, state };
}

function fakeChild(pid: number, root: string, bornAt: number, scene: { clock: { at: number }; phase: { stuck: Phase }; stuck: string; other: string }): Fake {
  const listeners = new Set<(event: ChoresChildEvent) => void>();
  let settle: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const kills: Fake['kills'] = [];
  let alive = true;
  let ready = false;
  let cpuMs = 1_000;
  const leave = (): void => {
    if (!alive) return;
    alive = false;
    for (const listener of [...listeners]) listener({ kind: 'exit', code: 0, signal: null });
    settle();
  };
  const emit = (message: ChoresChildMessage): void => {
    for (const listener of [...listeners]) listener({ kind: 'message', message });
  };
  const fake: Fake = {
    root,
    kills,
    heard: 0,
    lastHeard: bornAt,
    child: {
      pid,
      get alive() {
        return alive;
      },
      send(message: ChoresHostMessage) {
        if (!alive) return false;
        if (message.type !== 'tick') return true;
        const answer = root === scene.stuck ? scene.phase.stuck : 'running';
        if (answer === 'silent') return true;
        if (!ready) {
          ready = true;
          emit({ type: 'ready', pid, at: new Date(scene.clock.at).toISOString() });
        }
        cpuMs += 50;
        fake.heard += 1;
        fake.lastHeard = scene.clock.at;
        emit(heartbeat(scene.clock.at, cpuMs));
        emit(watchState(root, answer === 'progressing' || answer === 'foreign-progress' ? 'starting' : answer, bornAt));
        if (answer === 'progressing' || answer === 'foreign-progress') {
          emit({ type: 'watch-pulse', root: answer === 'progressing' ? root : scene.other, at: new Date(scene.clock.at).toISOString() });
        }
        return true;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      kill(why) {
        kills.push({ why, graceMs: undefined });
        // The fleet waits on `exited`, not the exit event. Settle after this call returns so
        // the stop still sees a live child, then the promise starts the replacement.
        queueMicrotask(leave);
      },
      exited,
    },
  };
  return fake;
}

async function open(initial: Phase): Promise<Scene> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-child-restart-')));
  dirs.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const stuck = join(base, 'root-stuck');
  const other = join(base, 'root-other');
  for (const root of [stuck, other]) {
    mkdirSync(join(root, '.agents'), { recursive: true });
    git(root);
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  }
  const clock = { at: Date.now() };
  const phase = { stuck: initial };
  const spawned: Fake[] = [];
  let daemon: { close: () => Promise<void> } | null = null;
  let shutting = false;
  const close = async (): Promise<void> => {
    if (shutting) return;
    shutting = true;
    await daemon?.close();
  };
  closers.push(close);
  const scene: Scene = {
    home,
    stuck,
    other,
    clock,
    phase,
    spawned,
    close,
    step: async (ms = HEARTBEAT_MS) => {
      const target = clock.at + ms;
      clock.at = target;
      await until(
        () => {
          const read = readDaemonState(home);
          return read.kind === 'ok' && Date.parse(read.state.heartbeatAt) === target;
        },
        `the daemon beat did not reach ${new Date(target).toISOString()}`,
      );
    },
  };
  const started = await startMachineDaemon({
    home,
    roots: [stuck, other],
    startedBy: 'child-restart-scene',
    version: '0.0.0-child-restart',
    now: () => new Date(clock.at),
    heartbeatMs: HEARTBEAT_MS,
    restoreSweep: false,
    choresHosting: true,
    watchHosting: true,
    sendStart: async () => ({ kind: 'already-running', socketPath: join(home, 'send.sock'), pid: null }),
    initialBusStart: async () => ({ kind: 'busy' }),
    choresFactory: (spawn) => {
      const root = spawn.config.routes[0]?.root;
      if (root === undefined) throw new Error('a child was started with no root');
      const built = fakeChild(40_000 + spawned.length, root, clock.at, scene);
      spawned.push(built);
      return built.child;
    },
  });
  if (started.kind !== 'serving') {
    throw new Error(`the daemon did not start (${started.kind})`);
  }
  daemon = started.daemon;
  await until(
    () => spawned.some((child) => child.root === stuck) && spawned.some((child) => child.root === other),
    'the daemon beat did not start both children',
  );
  // Both children answer twice before any later jump. A jump past the startup deadline must not
  // be the first time a child is judged, or the fleet ends it for a slow start.
  await until(
    () => latest(scene, stuck).heard >= 2 && latest(scene, other).heard >= 2,
    'both children did not answer two beats',
  );
  return scene;
}

function of(scene: Scene, root: string): Fake[] {
  return scene.spawned.filter((child) => child.root === root);
}

function latest(scene: Scene, root: string): Fake {
  const found = of(scene, root);
  const child = found[found.length - 1];
  if (child === undefined) throw new Error(`no child has been started for ${root}`);
  return child;
}

function kills(scene: Scene, root: string): number {
  return of(scene, root).reduce((sum, child) => sum + child.kills.length, 0);
}

/** Heartbeats the daemon has not heard since this child last answered. A beat that is merely
 *  due is not missed: the count is one behind the number of silent intervals. */
function missedSince(scene: Scene, child: Fake): number {
  if (child.heard < 2) return 0;
  return Math.max(0, Math.ceil((scene.clock.at - child.lastHeard) / HEARTBEAT_MS) - 1);
}

function teamLog(root: string): string {
  const path = join(root, '.agents', 'team.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function decisionLines(root: string, phrase: string): string[] {
  return teamLog(root).split('\n').filter((line) => line.includes('daemon [daemon]') && line.includes(phrase));
}

function decisionText(line: string): string {
  const mark = 'daemon [daemon] ';
  const at = line.indexOf(mark);
  return (at === -1 ? line : line.slice(at + mark.length)).trim();
}

function noticeBodies(root: string, phrase: string): string[] {
  return walk(join(root, '.agents', 'send-drops')).flatMap((path) => {
    if (basename(path).includes('.')) return [];
    const text = readFileSync(path, 'utf8');
    return text.includes(phrase) ? [text] : [];
  });
}

function daemonLog(home: string): string {
  const path = daemonLogPath(home);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function choresWhy(scene: Scene, root: string): string {
  const read = readDaemonState(scene.home);
  if (read.kind !== 'ok') return '';
  return read.state.roots.find((row) => row.root === root)?.chores?.why ?? '';
}

function choresRestarts(scene: Scene, root: string): number | undefined {
  const read = readDaemonState(scene.home);
  if (read.kind !== 'ok') return undefined;
  return read.state.roots.find((row) => row.root === root)?.chores?.restarts;
}

function expectUntouched(scene: Scene): void {
  expect(of(scene, scene.other)).toHaveLength(1);
  expect(kills(scene, scene.other)).toBe(0);
  expect(choresRestarts(scene, scene.other)).toBe(0);
}

async function expectDecision(root: string, phrase: string): Promise<string> {
  await until(() => decisionLines(root, phrase).length === 1, `the team log did not record ${phrase}`);
  const line = decisionLines(root, phrase)[0];
  if (line === undefined) throw new Error(`the team log did not record ${phrase}`);
  const text = decisionText(line);
  await until(() => noticeBodies(root, text).length === 1, `the lead notice was not staged (${text})`);
  expect(noticeBodies(root, text)).toHaveLength(1);
  return text;
}

describe('a stuck watch or a late chores child is restarted for its own root', () => {
  test('a watch still starting at 120s is restarted once, with one lead notice and one log line', async () => {
    const scene = await open('starting');
    try {
      await scene.step(START_JUMP_MS);
      await until(() => kills(scene, scene.stuck) === 1, 'the starting watch was not restarted');
      await until(() => of(scene, scene.stuck).length === 2, 'the restarted child was not started again');
      await until(() => choresRestarts(scene, scene.stuck) === 1, 'the restart was not recorded');
      const text = await expectDecision(scene.stuck, 'stopped and started again');
      const match = /chores child: still starting for (\d+)s, limit 120s, (\d+) cycles; stopped and started again/.exec(text);
      expect(match).not.toBeNull();
      expect(Number(match?.[1])).toBeGreaterThanOrEqual(120);
      expect(Number(match?.[2])).toBe(0);
      expect(decisionLines(scene.stuck, 'stopped and started again')).toHaveLength(1);
      expect(choresRestarts(scene, scene.stuck)).toBe(1);
      expectUntouched(scene);
    } finally {
      await scene.close();
    }
  }, 15_000);

  test('a chores child late past 30 beats is restarted once, with one lead notice and one log line', async () => {
    const scene = await open('running');
    try {
      await until(() => latest(scene, scene.stuck).heard >= 2, 'the child never answered two beats');
      scene.phase.stuck = 'silent';
      for (let i = 0; i < LATE_LIMIT + 8; i++) {
        await scene.step();
        if (kills(scene, scene.stuck) === 1) break;
      }
      expect(kills(scene, scene.stuck)).toBe(1);
      await until(() => of(scene, scene.stuck).length === 2, 'the restarted child was not started again');
      await until(() => choresRestarts(scene, scene.stuck) === 1, 'the restart was not recorded');
      const text = await expectDecision(scene.stuck, 'stopped and started again');
      const match = /chores child: missed (\d+) heartbeats, limit 30; stopped and started again/.exec(text);
      expect(match).not.toBeNull();
      expect(Number(match?.[1])).toBeGreaterThan(LATE_LIMIT);
      expect(decisionLines(scene.stuck, 'stopped and started again')).toHaveLength(1);
      expect(choresRestarts(scene, scene.stuck)).toBe(1);
      expectUntouched(scene);
    } finally {
      await scene.close();
    }
  }, 15_000);

  test('a chores child late under the limit is left running, and the beat recorded the count', async () => {
    const scene = await open('running');
    try {
      await until(() => latest(scene, scene.stuck).heard >= 2, 'the child never answered two beats');
      scene.phase.stuck = 'silent';
      let missed = 0;
      for (let i = 0; missed < 12 && i < LATE_LIMIT; i++) {
        await scene.step();
        missed = missedSince(scene, latest(scene, scene.stuck));
      }
      // This is the count the beat's stuck check reads. It is late, and it is not past the
      // limit. The child is still the one that went quiet, so the scene cannot pass on an
      // empty kill list from a child that was never late.
      expect(missed).toBeGreaterThan(0);
      expect(missed).toBeLessThanOrEqual(LATE_LIMIT);
      expect(kills(scene, scene.stuck)).toBe(0);
      expect(of(scene, scene.stuck)).toHaveLength(1);
      expect(choresRestarts(scene, scene.stuck)).toBe(0);
      await until(() => daemonLog(scene.home).includes('keeping it'), 'the late child was not kept under the limit');
      await until(() => /missed \d+ heartbeats/.test(choresWhy(scene, scene.stuck)), 'the beat did not record the missed count');
      const recorded = /missed (\d+) heartbeats/.exec(choresWhy(scene, scene.stuck));
      expect(recorded).not.toBeNull();
      const shown = Number(recorded?.[1]);
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThanOrEqual(LATE_LIMIT);
      expect(shown).toBeLessThanOrEqual(missed);
      expect(daemonLog(scene.home)).toContain('keeping it');
      expect(decisionLines(scene.stuck, 'stopped and started again')).toEqual([]);
      expect(decisionLines(scene.stuck, 'left for a person')).toEqual([]);
      expect(noticeBodies(scene.stuck, 'stopped and started again')).toEqual([]);
      expectUntouched(scene);
    } finally {
      await scene.close();
    }
  }, 15_000);

  test('a fourth restart inside an hour is left for a person, and the next beat is silent', async () => {
    const scene = await open('starting');
    try {
      const startedAt = scene.clock.at;
      for (let i = 0; kills(scene, scene.stuck) < 3 && i < 8; i++) await scene.step(START_JUMP_MS);
      expect(kills(scene, scene.stuck)).toBe(3);
      await scene.step(START_JUMP_MS);
      await until(() => decisionLines(scene.stuck, 'left for a person').length === 1, 'the lead was not told the child was left');
      const left = decisionText(decisionLines(scene.stuck, 'left for a person')[0] ?? '');
      expect(left).toContain('left for a person');
      expect(left).toContain('limit 120s');
      await until(() => noticeBodies(scene.stuck, left).length === 1, 'the left-for-a-person notice was not staged');
      const restarts = decisionLines(scene.stuck, 'stopped and started again');
      expect(restarts).toHaveLength(3);
      for (const line of restarts) expect(decisionText(line)).toMatch(/still starting for \d+s, limit 120s/);
      await until(
        () => noticeBodies(scene.stuck, 'stopped and started again').length === 3,
        'the three restart notices were not staged',
      );
      expect(kills(scene, scene.stuck)).toBe(3);
      const notices = noticeBodies(scene.stuck, 'chores child:').length;
      await scene.step(START_JUMP_MS);
      expect(decisionLines(scene.stuck, 'left for a person')).toHaveLength(1);
      expect(decisionLines(scene.stuck, 'stopped and started again')).toHaveLength(3);
      expect(kills(scene, scene.stuck)).toBe(3);
      expect(noticeBodies(scene.stuck, 'chores child:').length).toBe(notices);
      expect(scene.clock.at - startedAt).toBeLessThan(HOUR_MS);
      expectUntouched(scene);
    } finally {
      await scene.close();
    }
  }, 15_000);
});


test('real startup progress can exceed the startup age, but a first pass that stops progressing still expires', async () => {
  const scene = await open('progressing');
  try {
    // Four half-limits exceed total startup age using the existing START_JUMP_MS fixture bound.
    const halfLimit = Math.floor((START_JUMP_MS - 1000) / 2);
    for (let turn = 0; turn < 4; turn++) {
      scene.clock.at += halfLimit;
      await until(() => latest(scene, scene.stuck).lastHeard === scene.clock.at, 'the progressing child was not heard');
      expect(kills(scene, scene.stuck)).toBe(0);
    }
    const read = readDaemonState(scene.home);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.state.roots.find((row) => row.root === scene.stuck)?.watch?.cycles).toBe(0);
    scene.phase.stuck = 'starting';
    scene.clock.at += START_JUMP_MS;
    await until(() => kills(scene, scene.stuck) === 1, 'a first pass without progress did not expire');
    expectUntouched(scene);
  } finally { await scene.close(); }
});

test('a pulse for another root cannot refresh this watched roots startup clock', async () => {
  const scene = await open('foreign-progress');
  try {
    await scene.step(START_JUMP_MS);
    await until(() => kills(scene, scene.stuck) === 1, 'a foreign-root pulse incorrectly refreshed startup');
    expectUntouched(scene);
  } finally { await scene.close(); }
});
