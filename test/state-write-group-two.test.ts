import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busMarkerPath, startBus } from '../src/bus/server.ts';
import { spawnInheritedBus } from '../src/bus/supervise.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { writeEndpointBlockedNotice } from '../src/send/endpoint-notice.ts';
import { addToQueue } from '../src/tasks/queue.ts';
import { handoverPath, writeWatchHandover } from '../src/watch/handover.ts';

const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
const parsed = validateTeamFile(`format: 1
project: fixture
session: fixture
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - name: lead
    role: coordinator
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`);
if (!parsed.ok) throw new Error('invalid synthetic team');
const team = parsed.team;
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-write-two-'))); dirs.push(base);
  const root = join(base, 'repo'); const home = join(base, 'home'); const agents = join(root, '.agents');
  mkdirSync(agents, { recursive: true }); mkdirSync(home);
  return { base, root, home, agents };
}
function planted(base: string, path: string, dangling: boolean) {
  const outside = join(base, 'outside'); if (!dangling) writeFileSync(outside, 'unchanged');
  symlinkSync(outside, path);
  return () => {
    expect(existsSync(outside)).toBe(!dangling);
    if (!dangling) expect(readFileSync(outside, 'utf8')).toBe('unchanged');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  };
}
for (const dangling of [false, true]) {
  test(`A1 bus marker refuses a planted leaf (${dangling ? 'dangling' : 'live'})`, async () => {
    const at = fixture(); const unchanged = planted(at.base, busMarkerPath(at.root), dangling);
    const started = await startBus({ root: at.root, team, home: at.home, stderr: () => {}, reconcileIntervalMs: 0 });
    if (started.kind !== 'serving') throw new Error(started.kind);
    try { unchanged(); } finally { await started.handle.close(); }
  });
  test(`A2 bus inheritance refuses a planted leaf (${dangling ? 'dangling' : 'live'})`, async () => {
    const at = fixture(); const unchanged = planted(at.base, join(at.agents, 'bus.inherit'), dangling);
    try { await spawnInheritedBus(at.root, at.home); } catch { /* A refused token starts no child. */ }
    unchanged();
  });
  test(`A7 blocked notice refuses a planted leaf (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const folder = join(at.agents, 'endpoint-blocked', 'fixture'); mkdirSync(folder, { recursive: true });
    const unchanged = planted(at.base, join(folder, 'worker'), dangling);
    const result = writeEndpointBlockedNotice({ ...at, session: 'fixture', lead: 'lead', seat: 'worker', reason: 'synthetic', at: '2026-11-07T00:00:00.000Z' });
    unchanged(); expect(result).toBe(false);
  });
  test(`A8 handover leaves a planted old temporary alone (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const unchanged = planted(at.base, `${handoverPath(at.agents)}.${process.pid}.tmp`, dangling);
    writeWatchHandover(at.agents, { root: at.root, session: 'fixture', pid: process.pid, now: new Date() });
    unchanged(); expect(lstatSync(handoverPath(at.agents)).isFile()).toBe(true);
  });
  test(`A12 queue leaves a planted old temporary alone (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const path = join(at.agents, 'queue.yaml');
    const unchanged = planted(at.base, `${path}.${process.pid}.tmp`, dangling);
    const result = addToQueue(at.root, { path: '.agents/queue.yaml', local: true }, { id: 'item', title: 'Synthetic item' });
    unchanged(); expect(result.kind).toBe('added'); expect(lstatSync(path).isFile()).toBe(true);
  });
}

for (const dangling of [false, true]) {
  test(`A8 handover refuses a planted final leaf (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const unchanged = planted(at.base, handoverPath(at.agents), dangling);
    expect(() => writeWatchHandover(at.agents, { root: at.root, session: 'fixture', pid: process.pid, now: new Date() })).toThrow();
    unchanged();
  });
  test(`A12 queue refuses a planted final leaf (${dangling ? 'dangling' : 'live'})`, () => {
    const at = fixture(); const path = join(at.agents, 'queue.yaml'); const unchanged = planted(at.base, path, dangling);
    expect(addToQueue(at.root, { path: '.agents/queue.yaml', local: true }, { id: 'item', title: 'Synthetic item' }).kind).not.toBe('added');
    unchanged();
  });
}

test('A12 queue validates its staged candidate through an alias above the established root', () => {
  const at = fixture(); const physical = join(at.base, 'physical'); const root = join(physical, 'project');
  mkdirSync(join(root, '.agents'), { recursive: true });
  const alias = join(at.base, 'alias-above'); symlinkSync(physical, alias);
  const result = addToQueue(join(alias, 'project'), { path: '.agents/queue.yaml', local: true }, { id: 'item', title: 'Synthetic item' });
  expect(result.kind).toBe('added');
  expect(readFileSync(join(root, '.agents', 'queue.yaml'), 'utf8')).toContain('Synthetic item');
});
