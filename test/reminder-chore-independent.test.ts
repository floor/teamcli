import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { choresConfigProblem, serveChoresChild } from '../src/daemon/chores/child.ts';
import {
  readChildMessage,
  type ChoresChildConfig,
  type ChoresChildMessage,
  type ChoresHostMessage,
} from '../src/daemon/chores/protocol.ts';
import type { ChoresChild, ChoresChildEvent } from '../src/daemon/chores/spawn.ts';
import { createChoresFleet } from '../src/daemon/chores/supervisor.ts';
import { daemonLockPath } from '../src/daemon/paths.ts';
import { writeDaemonState, type DaemonState } from '../src/daemon/state.ts';
import { entitiesPath } from '../src/entities.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { teamIdOf, teamsFile, upsertTeam } from '../src/registry/teams.ts';
import { verifyDaemonAuthority } from '../src/reminder/authority.ts';
import type { ReminderConfigEntry } from '../src/reminder/config.ts';
import type { DaemonDirectContext, DaemonDirectRequest, DaemonDirectResult } from '../src/reminder/direct-send.ts';
import { createReminderProvider } from '../src/reminder/provider.ts';
import { resolveReminderEntries } from '../src/reminder/resolve.ts';
import type { ReminderSpec } from '../src/reminder/run.ts';
import { world, type World } from './send-native-fixtures.ts';

const WORKER = join(import.meta.dir, 'authority-child-worker.ts');

const worlds: World[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const w of worlds.splice(0)) w.cleanup();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTempHome(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reminder-indep-')));
  tempDirs.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  return home;
}

function registerCheckout(
  home: string,
  project: string,
  fileEntity: string | null,
  recordEntity: string | null,
): World {
  const w = world();
  worlds.push(w);
  const path = join(w.root, '.agents', 'team.yaml');
  let text = readFileSync(path, 'utf8')
    .replace('project: acme', `project: ${project}`)
    .replace('session: acme', `session: ${project}`)
    .replace(`  - ${lobbyDir(w.home)}`, `  - ${lobbyDir(home)}`);
  if (fileEntity !== null) {
    text = `${text}entity: ${fileEntity}\nlobby: ${lobbyDir(home)}\n`;
  }
  writeFileSync(path, text);
  upsertTeam(home, teamIdOf(w.root), {
    project,
    entity: recordEntity,
    session: project,
    root: w.root,
    by: 'reminder-chore-independent',
    at: '2026-11-04T06:00:00.000Z',
  });
  return w;
}

function makeEntry(overrides: Partial<ReminderConfigEntry> = {}): ReminderConfigEntry {
  return {
    entity: 'acme',
    name: 'standup',
    at: ['08:00'],
    zone: 'UTC',
    catchUp: undefined,
    text: 'Hello {seat} of {team} ({name})',
    targets: [{ address: 'lead@alpha', text: null }],
    ...overrides,
  };
}

describe('independent probe: reminder-chore (entity boundary, corrupt registry, chores child beat, pid/ppid authority)', () => {
  test('recipients stay inside the reminder entity: foreign file entity, foreign registry entity, and entity-less teams are refused', () => {
    const home = makeTempHome();
    const alpha = registerCheckout(home, 'alpha', 'acme', 'acme');
    registerCheckout(home, 'foreign-file', 'other-org', 'other-org');
    registerCheckout(home, 'foreign-reg', null, 'other-org');
    registerCheckout(home, 'no-entity', null, null);

    const resolved = resolveReminderEntries(
      home,
      [
        makeEntry({ name: 'ok-in-entity', targets: [{ address: 'lead@alpha', text: null }] }),
        makeEntry({ name: 'bad-foreign-file', targets: [{ address: 'lead@foreign-file', text: null }] }),
        makeEntry({ name: 'bad-foreign-reg', targets: [{ address: 'lead@foreign-reg', text: null }] }),
        makeEntry({ name: 'bad-entityless', targets: [{ address: 'lead@no-entity', text: null }] }),
        makeEntry({
          name: 'bad-mixed-partial',
          targets: [
            { address: 'lead@alpha', text: null },
            { address: 'lead@no-entity', text: null },
          ],
        }),
      ],
      { hosted: [alpha.root] },
    );

    // Only the purely in-entity reminder resolves
    expect(resolved.specs.map((s) => s.name)).toEqual(['ok-in-entity']);
    expect(resolved.specs[0]?.targets[0]).toEqual({
      recipient: { root: alpha.root, session: 'alpha', seat: 'lead' },
      text: 'Hello lead of alpha (ok-in-entity)',
    });

    // All 4 invalid reminders are refused with descriptive reasons
    expect(resolved.problems.map((p) => p.name)).toEqual([
      'bad-foreign-file',
      'bad-foreign-reg',
      'bad-entityless',
      'bad-mixed-partial',
    ]);
    expect(resolved.problems[0]?.why).toContain('lead@foreign-file: the team foreign-file belongs to entity "other-org", not "acme"');
    expect(resolved.problems[1]?.why).toContain('lead@foreign-reg: the team foreign-reg belongs to entity "other-org", not "acme"');
    expect(resolved.problems[2]?.why).toContain('lead@no-entity: the team no-entity declares no entity, and a reminder stays inside entity "acme"');
    expect(resolved.problems[3]?.why).toContain('lead@no-entity: the team no-entity declares no entity');
  });

  test('corrupt registry refuses the entire reminder list without firing stale specs, logs once per failure reason, and recovers when repaired', () => {
    const home = makeTempHome();
    const alpha = registerCheckout(home, 'alpha', 'acme', 'acme');
    writeFileSync(
      entitiesPath(home),
      [
        'acme:',
        '  reminders:',
        '    - name: pulse',
        '      at: ["09:00"]',
        '      zone: UTC',
        '      to: [lead@alpha]',
        '      text: "Check {team}"',
      ].join('\n'),
    );

    const provider = createReminderProvider({ home, hosted: [alpha.root], defaultZone: 'UTC' });
    const logs: string[] = [];

    // 1. Healthy initial read
    const initial = provider((line) => logs.push(line));
    expect(initial.map((s) => s.name)).toEqual(['pulse']);
    expect(logs).toEqual([]);

    const savedRegistry = readFileSync(teamsFile(home), 'utf8');

    // 2. Touch entities.yaml and corrupt teams.yaml -> refuses the whole list (returns []) and logs once
    writeFileSync(
      entitiesPath(home),
      [
        'acme:',
        '  reminders:',
        '    - name: pulse',
        '      at: ["09:30"]',
        '      zone: UTC',
        '      to: [lead@alpha]',
        '      text: "Check {team} updated"',
      ].join('\n'),
    );
    writeFileSync(teamsFile(home), 'teams: { unclosed-corrupt-yaml\n');

    expect(provider((line) => logs.push(line))).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('reminders: the configured list could not be read');
    expect(logs[0]).toContain('teams.yaml');

    // 3. Subsequent beat with the same broken registry still returns [] and does not spam duplicate log lines
    expect(provider((line) => logs.push(line))).toEqual([]);
    expect(logs).toHaveLength(1);

    // 4. Repairing teams.yaml allows the next beat to recover without needing entities.yaml to change again
    writeFileSync(teamsFile(home), savedRegistry);
    const recovered = provider((line) => logs.push(line));
    expect(recovered.map((s) => s.name)).toEqual(['pulse']);
    expect(recovered[0]?.at).toEqual(['09:30']);
    expect(logs).toHaveLength(1);
  });

  test('the reminder beat runs inside the chores child and is supervised as a dedicated machine group in the fleet', async () => {
    const home = makeTempHome();
    const config: ChoresChildConfig = {
      version: 1,
      home,
      beatMs: 10_000,
      sliceMs: 2_000,
      since: '2026-11-04T00:00:00.000Z',
      routes: [],
      machine: { reminders: { hosted: ['/work/alpha'] } },
    };
    expect(choresConfigProblem(config)).toBeNull();

    // Part A: serveChoresChild executes the reminder beat on tick and emits reminder-note frames
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const frames: ChoresChildMessage[] = [];
    let buf = '';
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (line.trim() === '') continue;
        const msg = readChildMessage(JSON.parse(line) as Record<string, unknown>);
        if (msg !== null) frames.push(msg);
      }
    });

    let now = new Date('2026-11-03T08:00:05.000Z');
    const dispatches: { context: DaemonDirectContext; request: DaemonDirectRequest }[] = [];
    const sampleSpec: ReminderSpec = {
      name: 'morning',
      at: ['08:00'],
      zone: 'UTC',
      targets: [{ recipient: { root: '/work/alpha', session: 'alpha', seat: 'lead' }, text: 'Wake alpha' }],
    };

    const done = serveChoresChild({
      config,
      stdin,
      stdout,
      now: () => now,
      reminder: {
        provider: () => [sampleSpec],
        send: async (context, request) => {
          dispatches.push({ context, request });
          return { ok: true, code: 0, id: 'rem-msg-1', staged: true, text: '' } satisfies DaemonDirectResult;
        },
      },
    });

    const waitNote = async (substr: string): Promise<void> => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (frames.some((f) => f.type === 'reminder-note' && f.text.includes(substr))) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`timed out waiting for reminder-note containing "${substr}"`);
    };

    try {
      // First tick remembers without firing
      stdin.write(`${JSON.stringify({ type: 'tick', id: 't-1', at: now.toISOString() })}\n`);
      await waitNote('first run — remembered without firing');
      expect(dispatches).toHaveLength(0);

      // Next day's tick fires in the child and reports via reminder-note frame
      now = new Date('2026-11-04T08:00:05.000Z');
      stdin.write(`${JSON.stringify({ type: 'tick', id: 't-2', at: now.toISOString() })}\n`);
      await waitNote('reminder morning 2026-11-04T08:00: sent 1, refused 0');
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]?.request).toEqual({ root: '/work/alpha', seat: 'lead', body: 'Wake alpha' });
    } finally {
      stdin.write(`${JSON.stringify({ type: 'stop', why: 'done' })}\n`);
      expect(await done).toBe(0);
    }

    // Part B: createChoresFleet spawns the machine child with routes: [] and relays reminder-note lines unprefixed
    const spawnedConfigs: ChoresChildConfig[] = [];
    const hostMessages: ChoresHostMessage[] = [];
    const fleetLogs: string[] = [];
    const childState: { emit: ((event: ChoresChildEvent) => void) | null } = { emit: null };

    const fleet = createChoresFleet({
      home,
      beatMs: 5_000,
      since: '2026-11-04T00:00:00.000Z',
      now: () => now,
      routes: [],
      machine: { reminders: { hosted: ['/work/alpha'] } },
      log: (line) => fleetLogs.push(line),
      factory: ({ config: cfg }) => {
        spawnedConfigs.push(cfg);
        const fakeChild: ChoresChild = {
          pid: 98765,
          get alive() {
            return true;
          },
          exited: new Promise<void>(() => {}),
          send(msg) {
            hostMessages.push(msg);
            return true;
          },
          subscribe(listener) {
            childState.emit = listener;
            return () => {
              childState.emit = null;
            };
          },
          kill() {},
        };
        return fakeChild;
      },
    });

    // First fleet tick starts the machine child
    fleet.tick(now);
    expect(spawnedConfigs).toHaveLength(1);
    expect(spawnedConfigs[0]?.routes).toEqual([]);
    expect(spawnedConfigs[0]?.machine).toEqual({ reminders: { hosted: ['/work/alpha'] } });
    expect(fleet.stateFor('/work/alpha')).toBeUndefined();

    // Emit ready + heartbeat + reminder-note from the child, then tick again
    childState.emit?.({ kind: 'message', message: { type: 'ready', pid: 98765, at: now.toISOString() } });
    childState.emit?.({
      kind: 'message',
      message: {
        type: 'heartbeat',
        at: now.toISOString(),
        rssBytes: 1024,
        busy: null,
        markerCache: { read: 0, reused: 0, cached: 0 },
      },
    });
    childState.emit?.({
      kind: 'message',
      message: { type: 'reminder-note', text: 'reminder morning 2026-11-04T08:00: sent 1, refused 0; on time' },
    });

    expect(fleetLogs).toEqual(['reminder morning 2026-11-04T08:00: sent 1, refused 0; on time']);
    fleet.tick(new Date(now.getTime() + 5_000));
    expect(hostMessages.some((m) => m.type === 'tick')).toBe(true);
    await fleet.stop('test complete');
  });

  test('daemon authority admits only the daemon pid or its direct child (ppid), refusing grandchildren, lock mismatches, and replaced identities', () => {
    const home = makeTempHome();
    const at = new Date('2026-11-04T07:00:00.000Z');

    const writeRecordAndLock = (recordPid: number, lockHolderPid: number = recordPid, since = '2026-11-04T06:00:00.000Z'): void => {
      const state: DaemonState = {
        format: 1,
        pid: recordPid,
        uid: typeof process.getuid === 'function' ? process.getuid() : -1,
        since,
        startedBy: 'test',
        version: 'test',
        heartbeatAt: at.toISOString(),
        socket: join(home, '.config', 'team', 'daemon.sock'),
        features: { broker: 'absent' },
        stuck: [],
        roots: [{ root: '/work/alpha', team: 'alpha', send: 'serving', bus: 'serving', why: null }],
      };
      writeDaemonState(home, state);
      mkdirSync(dirname(daemonLockPath(home)), { recursive: true });
      writeFileSync(daemonLockPath(home), `${String(lockHolderPid)}\n`);
    };

    // 1. Direct daemon process (state.pid === process.pid) is admitted
    writeRecordAndLock(process.pid);
    const selfVerdict = verifyDaemonAuthority({ home, now: at });
    expect(selfVerdict.ok).toBe(true);

    // 2. Direct parent process (state.pid === process.ppid) is admitted in-process
    writeRecordAndLock(process.ppid);
    const parentVerdict = verifyDaemonAuthority({ home, now: at });
    expect(parentVerdict.ok).toBe(true);

    // 3. Real OS child vs grandchild process boundary via authority-child-worker.ts
    writeRecordAndLock(process.pid);
    const run = spawnSync(process.execPath, [WORKER, home, at.toISOString(), 'spawn'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      mine: { pid: number; ppid: number; ok: boolean; why: string | null };
      child?: { mine: { pid: number; ppid: number; ok: boolean; why: string | null } };
    };
    // Direct child of process.pid stands (its ppid === process.pid)
    expect(parsed.mine.ok).toBe(true);
    expect(parsed.mine.ppid).toBe(process.pid);
    // Grandchild spawned by that child is refused (its ppid === parsed.mine.pid !== process.pid)
    expect(parsed.child?.mine.ok).toBe(false);
    expect(parsed.child?.mine.why).toContain(`names process ${String(process.pid)}`);
    expect(parsed.child?.mine.why).toContain(`whose parent is ${String(parsed.mine.pid)}: neither the daemon nor a process it started`);

    // 4. Lock mismatch refuses even when pid matches
    writeRecordAndLock(process.pid, process.ppid);
    const lockMismatch = verifyDaemonAuthority({ home, now: at });
    expect(lockMismatch.ok).toBe(false);
    if (!lockMismatch.ok) {
      expect(lockMismatch.why).toContain('the daemon single-instance lock names');
    }

    // 5. Replaced daemon identity (since changed) refuses recheck even when pid and lock match
    writeRecordAndLock(process.pid, process.pid, '2026-11-04T06:30:00.000Z');
    if (selfVerdict.ok) {
      const replaced = verifyDaemonAuthority({ home, captured: selfVerdict.identity, now: at });
      expect(replaced).toEqual({
        ok: false,
        why: 'the daemon record changed since this send was established: a replaced daemon never inherits an earlier send',
      });
    }
  }, 30_000);
});
