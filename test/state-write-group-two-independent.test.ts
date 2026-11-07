// Marker, inherit token, blocked mark, handover, and task queue.
// A live or dangling link at the final name, or at the old pid temporary, is not written through.
// A linked agents directory or a linked project-root child is refused. A bad queue is not renamed
// over a good one. The marker publisher is the state-file writer at the marker path: binding a
// bus would open a real socket. The inherit site is asked only when the write must refuse,
// which happens before any child is started.
import { expect, test } from 'bun:test';
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { busMarkerPath } from '../src/bus/server.ts';
import { spawnInheritedBus } from '../src/bus/supervise.ts';
import { FileWriteRefusal, writeStateFile } from '../src/file-write.ts';
import { writeEndpointBlockedNotice } from '../src/send/endpoint-notice.ts';
import { addToQueue, LOCAL_QUEUE } from '../src/tasks/queue.ts';
import { handoverPath, readWatchHandover, writeWatchHandover } from '../src/watch/handover.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const OUTSIDE = 'synthetic outside data\n';
const WHEN = '2026-11-07T04:00:00.000Z';
const SESSION = 'hour';
const BOX = 'box';
const GUIDE = 'guide';
const GOOD = '- id: "kept"\n  title: "kept title"\n';

function world(prefix: string): { base: string; root: string; home: string; agents: string } {
  const base = fixtureBase(prefix);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  const agents = join(root, '.agents');
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { base, root, home, agents };
}

function discard(base: string): void {
  discardFixtures([base], { roots: [dirname(base)] });
}

function outsideFile(folder: string): string {
  const path = join(folder, 'outside.txt');
  writeFileSync(path, OUTSIDE, { mode: 0o600 });
  return path;
}

function plant(path: string, target: string, kind: 'live' | 'dangling'): string {
  const missing = join(dirname(target), 'missing-target');
  symlinkSync(kind === 'live' ? target : missing, path);
  return missing;
}

function kept(target: string, missing: string, link: string, kind: 'live' | 'dangling'): void {
  expect(readFileSync(target, 'utf8')).toBe(OUTSIDE);
  if (kind === 'dangling') expect(readdirSync(dirname(target))).not.toContain('missing-target');
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(kind === 'live' ? target : missing);
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function noPidTemp(directory: string, planted?: string): void {
  const names = readdirSync(directory).filter((name) => name.includes(`.${process.pid}.tmp`) && name !== planted);
  expect(names).toEqual([]);
}

function markerBody(): string {
  return `${JSON.stringify({ pid: 2, started: WHEN })}\n`;
}

function blockedMark(root: string): string {
  return join(root, '.agents', 'endpoint-blocked', SESSION, BOX);
}

function notice(root: string, home: string): boolean {
  return writeEndpointBlockedNotice({
    home, root, session: SESSION, lead: GUIDE, seat: BOX, reason: 'down', at: WHEN,
  });
}

function handover(root: string): void {
  const stateDir = join(root, '.agents', SESSION);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeWatchHandover(stateDir, { root, session: SESSION, pid: 2, now: new Date(WHEN) });
}

test('a normal publication is mode 0600 and leaves no pid temporary', () => {
  const { base, root, home, agents } = world('state-write-g2-plain');
  try {
    const marker = busMarkerPath(root);
    writeStateFile(marker, markerBody(), { root });
    expect(modeOf(marker)).toBe(0o600);
    expect(readFileSync(marker, 'utf8')).toBe(markerBody());
    noPidTemp(agents);

    const inherit = join(agents, 'bus.inherit');
    writeStateFile(inherit, 'abc123\n', { root });
    expect(modeOf(inherit)).toBe(0o600);
    expect(readFileSync(inherit, 'utf8')).toBe('abc123\n');

    expect(notice(root, home)).toBe(true);
    const mark = blockedMark(root);
    expect(modeOf(mark)).toBe(0o600);
    expect(readFileSync(mark, 'utf8')).toBe(`${WHEN}\n`);
    noPidTemp(dirname(mark));

    handover(root);
    const stateDir = join(agents, SESSION);
    const request = handoverPath(stateDir);
    expect(modeOf(request)).toBe(0o600);
    expect(readWatchHandover(stateDir)).toEqual({
      kind: 'request',
      request: {
        format: 1,
        kind: 'watch-handover',
        root,
        session: SESSION,
        pid: 2,
        requestedAt: WHEN,
        heartbeat: WHEN,
      },
    });
    noPidTemp(stateDir);

    const added = addToQueue(root, { path: LOCAL_QUEUE, local: true }, { id: 'kept', title: 'kept title' });
    expect(added.kind).toBe('added');
    const queue = join(root, LOCAL_QUEUE);
    expect(modeOf(queue)).toBe(0o600);
    expect(readFileSync(queue, 'utf8')).toContain('kept');
    expect(readFileSync(queue, 'utf8')).toContain('kept title');
    noPidTemp(agents);
  } finally {
    discard(base);
  }
});

// One world per kind: ten separate trees made the trash cleanup exceed the default limit.
test('a link at the final name is not written through', async () => {
  for (const kind of ['live', 'dangling'] as const) {
    const scene = world('state-write-g2-final');
    try {
      const target = outsideFile(scene.base);
      const marker = busMarkerPath(scene.root);
      const markerMissing = plant(marker, target, kind);
      expect(() => writeStateFile(marker, markerBody(), { root: scene.root })).toThrow(FileWriteRefusal);
      kept(target, markerMissing, marker, kind);

      const inherit = join(scene.agents, 'bus.inherit');
      const inheritMissing = plant(inherit, target, kind);
      let started = false;
      try {
        await spawnInheritedBus(scene.root, scene.home);
        started = true;
      } catch (error) {
        expect(error).toBeInstanceOf(FileWriteRefusal);
      }
      expect(started).toBe(false);
      kept(target, inheritMissing, inherit, kind);

      const mark = blockedMark(scene.root);
      mkdirSync(dirname(mark), { recursive: true, mode: 0o700 });
      const markMissing = plant(mark, target, kind);
      expect(notice(scene.root, scene.home)).toBe(false);
      kept(target, markMissing, mark, kind);

      const stateDir = join(scene.agents, SESSION);
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const request = handoverPath(stateDir);
      const requestMissing = plant(request, target, kind);
      expect(() => writeWatchHandover(stateDir, {
        root: scene.root, session: SESSION, pid: 2, now: new Date(WHEN),
      })).toThrow(FileWriteRefusal);
      kept(target, requestMissing, request, kind);

      const keptFile = join(scene.root, 'kept.yaml');
      writeFileSync(keptFile, GOOD, { mode: 0o600 });
      const queue = join(scene.root, 'queue.yaml');
      symlinkSync(keptFile, queue);
      const result = addToQueue(scene.root, { path: 'queue.yaml', local: false }, { id: 'next', title: 'second' });
      expect(result.kind).not.toBe('added');
      expect(readFileSync(keptFile, 'utf8')).toBe(GOOD);
      expect(lstatSync(queue).isSymbolicLink()).toBe(true);
      expect(readlinkSync(queue)).toBe(keptFile);
    } finally {
      discard(scene.base);
    }
  }
});

test('a link at the old pid temporary is not written through', () => {
  for (const kind of ['live', 'dangling'] as const) {
    const hand = world('state-write-g2-old-hand');
    try {
      const target = outsideFile(hand.base);
      const stateDir = join(hand.agents, SESSION);
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const path = handoverPath(stateDir);
      const missing = plant(`${path}.${process.pid}.tmp`, target, kind);
      writeWatchHandover(stateDir, { root: hand.root, session: SESSION, pid: 2, now: new Date(WHEN) });
      const planted = `${path}.${process.pid}.tmp`;
      kept(target, missing, planted, kind);
      expect(lstatSync(path).isFile()).toBe(true);
      expect(modeOf(path)).toBe(0o600);
      noPidTemp(stateDir, basename(planted));
    } finally {
      discard(hand.base);
    }

    const queue = world('state-write-g2-old-queue');
    try {
      const target = outsideFile(queue.base);
      const path = resolve(queue.root, LOCAL_QUEUE);
      const missing = plant(`${path}.${process.pid}.tmp`, target, kind);
      const added = addToQueue(queue.root, { path: LOCAL_QUEUE, local: true }, { id: 'kept', title: 'kept title' });
      expect(added.kind).toBe('added');
      const planted = `${path}.${process.pid}.tmp`;
      kept(target, missing, planted, kind);
      expect(lstatSync(path).isFile()).toBe(true);
      expect(modeOf(path)).toBe(0o600);
      noPidTemp(dirname(path), basename(planted));
    } finally {
      discard(queue.base);
    }
  }
});

test('a linked agents directory is refused', async () => {
  const base = fixtureBase('state-write-g2-agents');
  const root = join(base, 'repo');
  const home = join(base, 'home');
  const elsewhere = join(base, 'elsewhere');
  const agents = join(root, '.agents');
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(elsewhere, SESSION), { recursive: true, mode: 0o700 });
    const target = outsideFile(elsewhere);
    symlinkSync(elsewhere, agents);
    expect(() => writeStateFile(busMarkerPath(root), markerBody(), { root })).toThrow(FileWriteRefusal);
    let started = false;
    try {
      await spawnInheritedBus(root, home);
      started = true;
    } catch (error) {
      expect(error).toBeInstanceOf(FileWriteRefusal);
    }
    expect(started).toBe(false);
    expect(notice(root, home)).toBe(false);
    expect(() => writeWatchHandover(join(agents, SESSION), {
      root, session: SESSION, pid: 2, now: new Date(WHEN),
    })).toThrow(FileWriteRefusal);
    const queued = addToQueue(root, { path: LOCAL_QUEUE, local: true }, { id: 'kept', title: 'kept title' });
    expect(queued.kind).not.toBe('added');
    expect(readFileSync(target, 'utf8')).toBe(OUTSIDE);
    expect(lstatSync(agents).isSymbolicLink()).toBe(true);
    expect(readdirSync(elsewhere)).not.toContain('bus.pid');
    expect(readdirSync(elsewhere)).not.toContain('bus.inherit');
    expect(readdirSync(elsewhere)).not.toContain('queue.yaml');
  } finally {
    discard(base);
  }
});

test('a bad queue never replaces a good one', () => {
  const { base, root, agents } = world('state-write-g2-bad');
  try {
    const path = join(root, LOCAL_QUEUE);
    writeFileSync(path, GOOD, { mode: 0o600 });
    const result = addToQueue(root, { path: LOCAL_QUEUE, local: true }, { id: 'next', title: 'n'.repeat(201) });
    expect(result.kind).toBe('unreadable');
    expect(readFileSync(path, 'utf8')).toBe(GOOD);
    expect(lstatSync(path).isFile()).toBe(true);
    noPidTemp(agents);
  } finally {
    discard(base);
  }
});
