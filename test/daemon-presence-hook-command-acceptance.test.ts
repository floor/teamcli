// Independent acceptance for the generated settings hook, end to end at the real command path:
// the settings file a fresh launch installs, the shell command it writes, this build's hidden
// CLI, the spool, the daemon's ingester, the canonical activity reconciler and the consumer's
// own snapshot. Every path is a synthetic temp folder; HOME is a fresh empty folder, so no CLI's
// home, no screen read and no live seat is involved.
//
// The generated command reads no stdin: every field is in argv, written at install time. This
// file therefore sends no prompt payload and invents no runtime event shape — stdin is ignored.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isPresenceBinding } from '../src/daemon/presence/contract.ts';
import { createPresenceActivity } from '../src/daemon/presence/activity.ts';
import { presenceStepHealth } from '../src/daemon/presence/health.ts';
import { createPresenceIngester, type PresenceIngester } from '../src/daemon/presence/ingest.ts';
import { readPresenceCurrent } from '../src/daemon/presence/read.ts';
import { presencePaths } from '../src/daemon/presence/spool.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { installCliHooks, type CliHookSeat } from '../src/launch/cli-hook.ts';
import { emptySession, readState, type SessionState } from '../src/state.ts';
import { idleWorkReport } from '../src/watch/idle-work.ts';
import { prefetchPresence, presenceVerdict, type PresenceSeat } from '../src/watch/presence.ts';

const SESSION = 'crew';
const SEAT = 'writer';
const SEAT_ID = 'seat_0123456789ab';

const TEAM_TEXT = `format: 1
project: acme
entity: acme
session: crew
coordinator: lead
operator: lead
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
  - role: worker
    name: writer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const loaded = validateTeamFile(TEAM_TEXT);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const team: TeamFile = loaded.team;

type Entry = { hooks: { type: string; command: string }[] };
type Settings = { hooks: Record<string, Entry[]> };

type World = { base: string; home: string; root: string; dir: string };

let worlds: World[] = [];
let ingesters: PresenceIngester[] = [];

beforeEach(() => {
  // Under /private/tmp, not os.tmpdir(): a child bun started with its cwd under the system temp
  // on this host measured 0.8-1.4 s of startup alone (a /private/tmp cwd measured ~0.08 s),
  // which would drown the chain this file measures. The folder is still synthetic and removed
  // with the world.
  const base = realpathSync(mkdtempSync(join('/private/tmp', 'presence-hook-command-')));
  const home = join(base, 'home');
  const root = join(base, 'crew');
  const dir = join(root, '.agents');
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const world: World = { base, home, root, dir };
  worlds.push(world);
  writeFileSync(join(dir, 'team.yaml'), TEAM_TEXT);
  const state = emptySession();
  state.seats[SEAT] = {
    stage: 'ready',
    id: SEAT_ID,
  } as unknown as SessionState['seats'][string];
  writeFileSync(
    join(dir, 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { [SESSION]: state } })}\n`,
  );
  writeFileSync(join(dir, 'queue.yaml'), '- id: t1\n  title: "t1"\n');
});

afterEach(async () => {
  for (const ingester of ingesters.splice(0)) {
    try { if (!ingester.isClosed()) await ingester.close(); } catch { /* the scene closed it */ }
  }
  for (const world of worlds.splice(0)) rmSync(world.base, { recursive: true, force: true });
});

function worldState(world: World): SessionState {
  return readState(world.dir).sessions[SESSION] ?? emptySession();
}

function commandsOf(settings: Settings, event: string): string[] {
  return (settings.hooks[event] ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

function presenceCommand(settings: Settings, event: 'UserPromptSubmit' | 'Stop'): string {
  const commands = commandsOf(settings, event).filter((command) => command.includes(' presence-hook '));
  expect(commands).toHaveLength(1);
  return commands[0]!;
}

/** Installs the settings a fresh launch of the worker loads, exactly through the launch path. */
function installFresh(world: World): { settingsPath: string; settings: Settings; binding: string } {
  const seats: CliHookSeat[] = [{ name: SEAT, cli: 'claude-code', launch: 'claude', fresh: true }];
  const landed = installCliHooks(world.dir, SESSION, seats);
  const settingsPath = landed[SEAT];
  if (settingsPath === undefined) throw new Error('the fresh launch installed no settings');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
  const binding = worldState(world).seats[SEAT]?.presence_binding;
  if (!isPresenceBinding(binding)) throw new Error('the fresh launch recorded no binding');
  return { settingsPath, settings, binding };
}

type Run = { status: number | null; elapsedMs: number };

/** Runs one generated command the way the settings file hands it to the platform: one shell
 *  line, our synthetic HOME, stdin ignored, no payload. */
function runGenerated(world: World, command: string): Run {
  const started = performance.now();
  const result = spawnSync('/bin/sh', ['-c', command], {
    cwd: world.root,
    env: { HOME: world.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: world.base },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return { status: result.status, elapsedMs: performance.now() - started };
}

type Staged = { id: string; ts: string; event: string; seat: string; session: string; binding: string; source: string };

function takeSpool(world: World): Staged[] {
  const paths = presencePaths(world.dir, SESSION, SEAT);
  if (paths === null || !existsSync(paths.spool)) return [];
  return readdirSync(paths.spool).filter((name) => name.endsWith('.json')).sort().map((name) => {
    const record = JSON.parse(readFileSync(join(paths.spool, name), 'utf8')) as Record<string, unknown>;
    return {
      id: String(record.id), ts: String(record.ts), event: String(record.event), seat: String(record.seat),
      session: String(record.session), binding: String(record.binding), source: String(record.source),
    };
  });
}

function ingester(world: World): PresenceIngester {
  const made = createPresenceIngester({ stateDir: world.dir, session: SESSION });
  ingesters.push(made);
  return made;
}

function seatRecord(world: World): SessionState['seats'][string] {
  const record = worldState(world).seats[SEAT];
  if (record === undefined) throw new Error('the scene seat left the state');
  return record;
}

function seatFacts(world: World, channelHealthy: boolean): PresenceSeat {
  const record = seatRecord(world);
  return {
    seat: SEAT,
    seatId: record.id ?? null,
    binding: record.presence_binding ?? null,
    fence: record.presence_applied,
    lastActive: record.last_active,
    channelHealthy,
  };
}

function report(world: World, presence: Awaited<ReturnType<typeof prefetchPresence>>, healthy: boolean, now: Date) {
  return idleWorkReport({
    root: world.root,
    team,
    state: worldState(world),
    live: null,
    now,
    presence,
    presenceChannelHealthy: healthy,
  });
}

/**
 * One daemon pass as the host runs it: the ingester's step, the activity reconciler at the same
 * beat, then the consumer's prefetch and report. Measured against the generated hook's exit.
 */
async function pass(world: World) {
  const started = performance.now();
  const made = ingester(world);
  const step = await made.step();
  const beat = new Date();
  const applied = await createPresenceActivity({ stateDir: world.dir, session: SESSION })(beat);
  const current = await readPresenceCurrent(world.dir, SESSION, SEAT);
  const presence = await prefetchPresence({ stateDir: world.dir, session: SESSION, seatNames: [SEAT] });
  const healthy = presenceStepHealth(step);
  const snapshot = report(world, presence, healthy, beat);
  const passMs = performance.now() - started;
  return { step, applied, current, presence, healthy, snapshot, beat, passMs };
}

describe('the settings a fresh launch installs', () => {
  test('one hidden presence command per turn edge, under the launch binding, with no stdin', () => {
    const world = worlds[0]!;
    const { settingsPath, settings, binding } = installFresh(world);
    expect(settingsPath).toBe(join(world.dir, 'hooks', 'crew', `${SEAT}.json`));

    const start = presenceCommand(settings, 'UserPromptSubmit');
    const stop = presenceCommand(settings, 'Stop');
    for (const [command, event] of [[start, 'turn-start'], [stop, 'turn-end']] as const) {
      expect(command).toContain(' presence-hook ');
      expect(command).toContain(`--dir ${world.dir}`);
      expect(command).toContain(`--session ${SESSION}`);
      expect(command).toContain(`--seat ${SEAT}`);
      expect(command).toContain(`--binding ${binding}`);
      expect(command).toContain(`--event ${event}`);
      expect(command).toContain('>/dev/null 2>&1 || true');
      expect(command).not.toContain('/dev/stdin');
    }
    // Today's adapter observes the two turn edges only; a human-wait observation is not written
    // here, so no scene in this file claims one.
    expect(commandsOf(settings, 'UserPromptSubmit').filter((command) => command.includes(' --event '))).toHaveLength(1);
    expect(commandsOf(settings, 'Stop').filter((command) => command.includes(' --event '))).toHaveLength(1);
  });
});

describe('the generated commands drive the whole chain', () => {
  test('turn start becomes working and turn end becomes idle, both inside one second', async () => {
    const world = worlds[0]!;
    const { settings, binding } = installFresh(world);
    expect(readdirSync(world.home)).toEqual([]);

    // Turn start: the installed command, run as the platform runs it.
    const chainStart = performance.now();
    const started = runGenerated(world, presenceCommand(settings, 'UserPromptSubmit'));
    expect(started.status).toBe(0);
    const stagedStart = takeSpool(world);
    expect(stagedStart).toHaveLength(1);
    const recordStart = stagedStart[0]!;
    expect(recordStart.event).toBe('turn-start');
    expect(recordStart.seat).toBe(SEAT);
    expect(recordStart.session).toBe(SESSION);
    expect(recordStart.binding).toBe(binding);
    expect(recordStart.source).toBe('runtime-hook');
    expect(recordStart.id.slice(0, -9)).toBe(recordStart.ts);
    expect(Number.isFinite(Date.parse(recordStart.ts))).toBe(true);

    const first = await pass(world);
    expect(first.step.ingested).toHaveLength(1);
    expect(first.step.healthy).toBe(true);
    expect(first.healthy).toBe(true);
    expect(takeSpool(world)).toEqual([]); // the ingester consumed the staged record
    expect(first.applied.failed).toBeNull();
    expect(first.applied.seats[0]).toMatchObject({ seat: SEAT, reconciled: 1, stamped: recordStart.ts, fence: 1 });
    if (first.current.kind !== 'ok') throw new Error(`the projection did not land: ${JSON.stringify(first.current)}`);
    expect(first.current.value).toMatchObject({ state: 'working', source: 'runtime-hook', binding, seq: 1, since: recordStart.ts });
    expect(seatRecord(world).last_active).toBe(recordStart.ts);
    expect(seatRecord(world).presence_applied).toMatchObject({
      seat_id: SEAT_ID, binding, seq: 1,
    });
    const working = report(world, first.presence, first.healthy, new Date());
    expect(working.idle).toEqual([]);
    expect(working.presence_unknown).toBeUndefined();
    expect(working.takeable).toBe(0);
    const verdict = presenceVerdict(first.presence.get(SEAT)!, seatFacts(world, true), {
      now: new Date(), thresholdSeconds: 300,
    });
    expect(verdict).toMatchObject({ idle: false, reason: 'working' });
    const chainStartMs = performance.now() - chainStart;
    expect(chainStartMs).toBeLessThan(1000);

    // Turn end: the Stop command, from the same installed file.
    const startedEnd = performance.now();
    const ended = runGenerated(world, presenceCommand(settings, 'Stop'));
    expect(ended.status).toBe(0);
    const stagedEnd = takeSpool(world);
    expect(stagedEnd).toHaveLength(1);
    const recordEnd = stagedEnd[0]!;
    expect(recordEnd.event).toBe('turn-end');
    expect(recordEnd.binding).toBe(binding);
    expect(recordEnd.source).toBe('runtime-hook');
    expect(Date.parse(recordEnd.ts)).toBeGreaterThanOrEqual(Date.parse(recordStart.ts));

    const second = await pass(world);
    expect(second.step.ingested).toHaveLength(1);
    expect(second.step.healthy).toBe(true);
    expect(takeSpool(world)).toEqual([]);
    expect(second.applied.seats[0]).toMatchObject({ seat: SEAT, reconciled: 1, stamped: recordEnd.ts, fence: 2 });
    if (second.current.kind !== 'ok') throw new Error(`the projection did not land: ${JSON.stringify(second.current)}`);
    expect(second.current.value).toMatchObject({ state: 'idle', source: 'runtime-hook', binding, seq: 2, since: recordEnd.ts });
    expect(seatRecord(world).last_active).toBe(recordEnd.ts);
    expect(seatRecord(world).presence_applied).toMatchObject({ seat_id: SEAT_ID, binding, seq: 2 });
    // The same beat is not yet idle on either clock; a later consumer clock is.
    expect(second.snapshot.idle).toEqual([]);
    expect(second.snapshot.presence_unknown).toBeUndefined();
    const later = report(world, second.presence, second.healthy, new Date(second.beat.getTime() + 301_000));
    expect(later.presence_unknown).toBeUndefined();
    expect(later.idle).toEqual([{ seat: SEAT, since: recordEnd.ts, native_since: recordEnd.ts, presence_source: 'runtime-hook' }]);
    expect(later.takeable).toBe(1);
    const chainEndMs = performance.now() - startedEnd;
    expect(chainEndMs).toBeLessThan(1000);

    // No CLI's home was read: the child's HOME was this synthetic folder, and nothing a CLI or
    // the team would write landed in it. (Child bun may create its own `Library/Caches` there;
    // the command's runner path is this test host's own bun, which the settings file computes
    // from the running process, not a session home.)
    expect(readdirSync(world.home).filter((name) => name !== 'Library')).toEqual([]);
  }, 30_000);
});
