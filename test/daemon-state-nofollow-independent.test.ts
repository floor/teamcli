// The daemon record is opened once, with no follow. A symlink is refused, a path swapped
// after that open is not the record that is read, a missing record stays missing, and a FIFO
// at the path must return. The hook gate fails closed on each. No signal is installed.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { daemonStatePath } from '../src/daemon/paths.ts';
import { nativeHookEnabled } from '../src/daemon/presence/native-feed.ts';
import { presencePaths } from '../src/daemon/presence/spool.ts';
import { readDaemonState, writeDaemonState } from '../src/daemon/state.ts';
import type { Io } from '../src/io.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const BINDING = 'prs_0123456789ab';
const OWNER = 'a'.repeat(32);
const MARKER_OWNER = 'b'.repeat(32);
const SEAT = 'seat-one';
const SESSION = 'sandbox';
const ROOT = join(import.meta.dir, '..');

function record(pid: number, owner = OWNER): string {
  return `${JSON.stringify({
    format: 1,
    pid,
    uid: process.getuid?.() ?? 0,
    since: '2026-11-06T19:00:00.000Z',
    startedBy: 'manual',
    version: 'test',
    heartbeatAt: '2026-11-06T19:00:00.000Z',
    socket: 'daemon.sock',
    features: { broker: 'off' },
    stuck: [],
    roots: [],
    nativeFeedOwner: owner,
  })}\n`;
}

function world(): {
  base: string;
  home: string;
  stateDir: string;
  path: string;
  discard: () => void;
  arm: () => void;
  gate: () => boolean;
} {
  const base = fixtureBase('daemon-state-nofollow-');
  const stateDir = join(base, 'checkout', '.agents');
  const home = join(base, 'home');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: {
      [SESSION]: {
        seats: { [SEAT]: { stage: 'ready', pane: 'fixture-pane-one', presence_binding: BINDING } },
        worktrees: {},
        briefs: {},
      },
    },
  })}\n`, { mode: 0o600 });
  const identity = { stateDir, session: SESSION, seat: SEAT, binding: BINDING };
  const io: Io = {
    cwd: join(base, 'checkout'),
    env: { HOME: home },
    stdinIsTTY: false,
    stdout: () => {},
    stderr: () => {},
    caller: { kind: 'seat', name: SEAT, pane: 'fixture-pane-one', session: SESSION },
  };
  const one = presencePaths(stateDir, SESSION, SEAT);
  if (one === null) throw new Error('the fixture seat cannot name a presence folder');
  const arm = (): void => {
    mkdirSync(one.root, { recursive: true, mode: 0o700 });
    writeFileSync(join(one.root, 'status-feed.json'), `${JSON.stringify({
      v: 1,
      binding: BINDING,
      epoch: null,
      owner: MARKER_OWNER,
      daemon: OWNER,
      expires: Date.now() + 4000,
    })}\n`, { mode: 0o600 });
  };
  const gate = (): boolean => {
    arm();
    return nativeHookEnabled(identity, io, () => ({ ok: true }), () => home);
  };
  return {
    base,
    home,
    stateDir,
    path: daemonStatePath(home),
    discard: () => discardFixtures([base], { roots: [dirname(base)] }),
    arm,
    gate,
  };
}

test('a missing record stays missing and the hook gate stays closed', () => {
  const fix = world();
  try {
    const read = readDaemonState(fix.home);
    expect(read.kind).toBe('missing');
    expect(fix.gate()).toBe(false);
  } finally {
    fix.discard();
  }
});

test('a symlinked record is refused and the hook gate stays closed', () => {
  const fix = world();
  try {
    const other = join(dirname(fix.path), 'other.json');
    writeFileSync(other, record(222), { mode: 0o600 });
    symlinkSync(other, fix.path);
    const read = readDaemonState(fix.home);
    expect(read.kind).toBe('unreadable');
    if (read.kind === 'unreadable') expect(read.why).toBe('the daemon state record is not a regular file');
    expect(read).not.toMatchObject({ kind: 'ok', state: { pid: 222 } });
    expect(fix.gate()).toBe(false);
    expect(readFileSync(other, 'utf8')).toContain('"pid":222');
  } finally {
    fix.discard();
  }
});

test('a record swapped after the open is not the record that is read', () => {
  const fix = world();
  try {
    const other = join(dirname(fix.path), 'other.json');
    writeFileSync(other, record(222), { mode: 0o600 });
    writeFileSync(fix.path, record(111), { mode: 0o600 });
    const read = readDaemonState(fix.home, {
      afterOpen: () => {
        renameSync(fix.path, join(dirname(fix.path), 'opened.json'));
        symlinkSync(other, fix.path);
      },
    });
    expect(read).toMatchObject({ kind: 'ok', state: { pid: 111 } });
    const again = readDaemonState(fix.home);
    expect(again.kind).toBe('unreadable');
    expect(fix.gate()).toBe(false);
  } finally {
    fix.discard();
  }
});

/** One bun process, started after a ready mark, stopped by a writer if the open does not return. */
async function bounded(home: string, fifo: string, which: 'read' | 'gate', spec: string): Promise<{ blocked: boolean; body: string }> {
  const ready = `${fifo}.${which}.ready`;
  const result = `${fifo}.${which}.result`;
  const script = which === 'read'
    ? `import { writeFileSync } from 'node:fs';
       import { readDaemonState } from ${JSON.stringify(join(ROOT, 'src/daemon/state.ts'))};
       writeFileSync(${JSON.stringify(ready)}, 'ready');
       writeFileSync(${JSON.stringify(result)}, JSON.stringify(readDaemonState(process.env.FIXTURE_HOME ?? '')));`
    : `import { mkdirSync, writeFileSync } from 'node:fs';
       import { dirname } from 'node:path';
       import { nativeHookEnabled } from ${JSON.stringify(join(ROOT, 'src/daemon/presence/native-feed.ts'))};
       const spec = JSON.parse(${JSON.stringify(spec)});
       writeFileSync(${JSON.stringify(ready)}, 'ready');
       mkdirSync(dirname(spec.marker), { recursive: true });
       writeFileSync(spec.marker, JSON.stringify({ ...spec.markerBody, expires: Date.now() + 4000 }));
       const io = { cwd: spec.cwd, env: { HOME: spec.home }, stdinIsTTY: false, stdout() {}, stderr() {}, caller: spec.caller };
       const gate = nativeHookEnabled(spec.identity, io, () => ({ ok: true }), () => spec.home);
       writeFileSync(${JSON.stringify(result)}, JSON.stringify(gate));`;
  const child = Bun.spawn(['bun', '-e', script], {
    cwd: ROOT,
    env: { ...process.env, FIXTURE_HOME: home },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const wait = async (path: string, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (existsSync(path)) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return existsSync(path);
  };
  try {
    const started = await wait(ready, 8000);
    if (!started) return { blocked: true, body: 'the call never started' };
    const returned = await wait(result, 500);
    if (!returned) {
      let writer: number | undefined;
      try { writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK); } catch { /* the open is still waiting for a writer */ }
      await wait(result, 2000);
      if (writer !== undefined) closeSync(writer);
      return { blocked: true, body: existsSync(result) ? readFileSync(result, 'utf8') : 'the open did not return' };
    }
    return { blocked: false, body: readFileSync(result, 'utf8') };
  } finally {
    if (child.exitCode === null) {
      try {
        const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
        closeSync(writer);
      } catch { /* already open or gone */ }
      await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
  }
}

test('a FIFO at the record path returns and the hook gate stays closed', async () => {
  const fix = world();
  try {
    execFileSync('mkfifo', [fix.path]);
    const read = await bounded(fix.home, fix.path, 'read', '');
    const one = presencePaths(fix.stateDir, SESSION, SEAT);
    if (one === null) throw new Error('the fixture seat cannot name a presence folder');
    const spec = JSON.stringify({
      home: fix.home,
      cwd: join(fix.base, 'checkout'),
      identity: { stateDir: fix.stateDir, session: SESSION, seat: SEAT, binding: BINDING },
      caller: { kind: 'seat', name: SEAT, pane: 'fixture-pane-one', session: SESSION },
      marker: join(one.root, 'status-feed.json'),
      markerBody: { v: 1, binding: BINDING, epoch: null, owner: MARKER_OWNER, daemon: OWNER },
    });
    const gate = await bounded(fix.home, fix.path, 'gate', spec);
    expect({ read: read.blocked, readBody: read.body, gate: gate.blocked, gateBody: gate.body }).toEqual({
      read: false,
      readBody: JSON.stringify({ kind: 'unreadable', why: 'the daemon state record is not a regular file' }),
      gate: false,
      gateBody: 'false',
    });
  } finally {
    fix.discard();
  }
}, 20000);

/** Spaces before the closing brace keep the JSON valid, so a full parse would still succeed. */
function sizedRecord(bytes: number): string {
  const core = JSON.stringify({
    format: 1,
    pid: process.pid,
    uid: process.getuid?.() ?? 0,
    since: '2026-11-06T19:00:00.000Z',
    startedBy: 'manual',
    version: 'test',
    heartbeatAt: '2026-11-06T19:00:00.000Z',
    socket: 'daemon.sock',
    features: { broker: 'off' },
    stuck: [],
    roots: [],
    nativeFeedOwner: OWNER,
  });
  const pad = bytes - core.length;
  if (pad < 0) throw new Error('the fixture record is already past the bound');
  return `${core.slice(0, -1)}${' '.repeat(pad)}}`;
}

test('a record over 64 KiB is refused before it is parsed, and the hook gate stays closed', () => {
  const fix = world();
  try {
    writeFileSync(fix.path, sizedRecord(64 * 1024), { mode: 0o600 });
    expect(readDaemonState(fix.home)).toMatchObject({ kind: 'ok', state: { pid: process.pid } });
    writeFileSync(fix.path, sizedRecord(64 * 1024 + 1), { mode: 0o600 });
    expect(readDaemonState(fix.home)).toEqual({
      kind: 'unreadable',
      why: 'the daemon state record exceeds 64 KiB',
    });
    expect(fix.gate()).toBe(false);
  } finally {
    fix.discard();
  }
});

test('a regular record is read and the hook gate opens', () => {
  const fix = world();
  try {
    writeDaemonState(fix.home, {
      format: 1,
      pid: process.pid,
      uid: process.getuid?.() ?? 0,
      since: '2026-11-06T19:00:00.000Z',
      startedBy: 'manual',
      version: 'test',
      heartbeatAt: '2026-11-06T19:00:00.000Z',
      socket: 'daemon.sock',
      features: { broker: 'off' },
      stuck: [],
      roots: [],
      nativeFeedOwner: OWNER,
    });
    const read = readDaemonState(fix.home);
    expect(read).toMatchObject({ kind: 'ok', state: { pid: process.pid, nativeFeedOwner: OWNER } });
    expect(fix.gate()).toBe(true);
  } finally {
    fix.discard();
  }
});
