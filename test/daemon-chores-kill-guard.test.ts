// Scenes for the child handle's forced-end guard: a child that stopped answering but is still
// consuming CPU is never forced, while a child that stopped consuming CPU, or one the hung
// ceiling ended, is forced. Each scene spawns one real fixture child that ignores the terminate
// signal and does no work; the CPU reading is fake, so the guard's own decision is what is
// observed.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChoresChildConfig } from '../src/daemon/chores/protocol.ts';
import { spawnChoresChild, type ChoresChild } from '../src/daemon/chores/spawn.ts';

const AT = '2026-11-04T02:00:00.000Z';
const FIXTURE = join(import.meta.dir, 'fixtures', 'chores-stubborn-child.ts');
const ANSWERING = join(import.meta.dir, 'fixtures', 'chores-answering-child.ts');
const dirs: string[] = [];
const live: ChoresChild[] = [];

afterEach(() => {
  for (const child of live.splice(0)) {
    try {
      if (child.pid !== null) process.kill(child.pid, 'SIGKILL');
    } catch {
      // The scene already ended it.
    }
  }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function configFor(home: string): ChoresChildConfig {
  return { version: 1, home, beatMs: 5000, sliceMs: 2000, since: AT, routes: [] };
}

/** Starts the fixture child and waits until it has installed its signal handler. */
async function start(
  home: string,
  cpuTimeOf: () => number | null,
  entry: string = FIXTURE,
): Promise<{ child: ChoresChild; notes: string[] }> {
  const ready = join(home, 'fixture-ready');
  const child = spawnChoresChild({
    config: configFor(home),
    entry,
    env: { CHORES_SCENE_READY: ready },
    cpuTimeOf,
  });
  live.push(child);
  const notes: string[] = [];
  child.subscribe((event) => {
    if (event.kind === 'note') notes.push(event.text);
  });
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
  if (!existsSync(ready)) throw new Error('the fixture child did not install its signal handler');
  return { child, notes };
}

/** A fake reading that keeps rising while `running`, and holds still once it is stopped: the
 *  wall clock, not a timer, drives it, so a loaded test process cannot make it look flat. */
function runningCpu(): { read: () => number; stop: () => void } {
  const started = Date.now();
  let frozen: number | null = null;
  const now = (): number => 1_000 + Math.floor((Date.now() - started) / 5) * 50;
  return {
    read: () => frozen ?? now(),
    stop: () => {
      if (frozen === null) frozen = now();
    },
  };
}

describe('chores child handle forced-end guard', () => {
  test('1. a child that stops answering while its CPU keeps advancing is not forced, and is forced once the CPU holds still', async () => {
    const home = mkdtempSync(join(tmpdir(), 'team-chores-guard-'));
    dirs.push(home);
    const cpu = runningCpu();
    const { child, notes } = await start(home, cpu.read);

    child.kill('the scene ends it', 100);
    await Bun.sleep(350);
    expect(child.alive).toBe(true);
    expect(notes.some((line) => line.includes('still consuming CPU'))).toBe(true);

    cpu.stop();
    const deadline = Date.now() + 5_000;
    while (child.alive && Date.now() < deadline) await Bun.sleep(25);
    expect(child.alive).toBe(false);
    await child.exited;
  });

  test('2. a child whose CPU holds still is forced at the first grace, as before', async () => {
    const home = mkdtempSync(join(tmpdir(), 'team-chores-guard-'));
    dirs.push(home);
    const { child } = await start(home, () => 500);

    child.kill('the scene ends it', 100);
    const deadline = Date.now() + 5_000;
    while (child.alive && Date.now() < deadline) await Bun.sleep(25);
    expect(child.alive).toBe(false);
    await child.exited;
  });

  test('3. a hung-ceiling end forces a child that is still consuming CPU', async () => {
    const home = mkdtempSync(join(tmpdir(), 'team-chores-guard-'));
    dirs.push(home);
    const cpu = runningCpu();
    const { child } = await start(home, cpu.read);

    child.kill('the child has not beaten for 600000 ms while its CPU kept advancing', 100, {
      evenIfWorking: true,
    });
    const deadline = Date.now() + 5_000;
    while (child.alive && Date.now() < deadline) await Bun.sleep(25);
    expect(child.alive).toBe(false);
    await child.exited;
  });

  test('4. a child that answers its end request is not forced, and a later deliberate end still forces it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'team-chores-guard-'));
    dirs.push(home);
    const cpu = runningCpu();
    const { child, notes } = await start(home, cpu.read, ANSWERING);

    child.kill('the scene ends it', 100);
    const answered = Date.now() + 3_000;
    while (!notes.some((line) => line.includes('answered its end request')) && Date.now() < answered) {
      await Bun.sleep(20);
    }
    expect(notes.some((line) => line.includes('answered its end request'))).toBe(true);
    // The handle stood down: a child that is still talking is not forced when its CPU goes quiet.
    cpu.stop();
    await Bun.sleep(350);
    expect(child.alive).toBe(true);

    // A deliberate end is not withdrawn: the hung ceiling and the daemon's stop must not leave a
    // child behind, so this request forces even a child that answered.
    child.kill('the scene forces it', 100, { evenIfWorking: true });
    const death = Date.now() + 5_000;
    while (child.alive && Date.now() < death) await Bun.sleep(25);
    expect(child.alive).toBe(false);
    await child.exited;
  });

  test('5. a reading that fails during the grace is no evidence: the handle defers instead of forcing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'team-chores-guard-'));
    dirs.push(home);
    let reading: number | null = null;
    const { child, notes } = await start(home, () => reading);

    child.kill('the scene ends it', 100);
    await Bun.sleep(250);
    expect(child.alive).toBe(true);
    expect(notes.some((line) => line.includes('could not be read'))).toBe(true);

    // A reading that recovers is only a baseline; one grace later the flat window forces the end.
    reading = 900;
    const death = Date.now() + 5_000;
    while (child.alive && Date.now() < death) await Bun.sleep(25);
    expect(child.alive).toBe(false);
    await child.exited;
  });
});
