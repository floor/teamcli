// A restarted Claude Code seat proves its own presence before its first turn (fix/presence-fresh-start).
//
// A relaunch mints a new presence binding. The store keeps the predecessor's projection as
// last-known until the new incarnation stages a word of its own, and the watch rightly refuses a
// predecessor's projection ("emitted by a predecessor runtime binding"). A hook seat only staged on
// a turn, so a fresh seat could never prove presence, and the watch held the very message that
// would have started its first turn. The launch's settings now stage the incarnation's first
// `turn-end` from Claude Code's SessionStart hook when its payload names a start that leaves the
// CLI at its prompt (`startup`, `resume`, `clear`); `compact`, which can fire inside a turn, and
// any other shape decline.
//
// Scenes:
// 1. The settings file names the session-start command beside the model report.
// 2. The hidden command stages `turn-end` (raw `session-start`) for an at-prompt start only, and
//    refuses every widened argv.
// 3. With a predecessor's working projection on disk, the session-start word for the new binding
//    is ingested and fenced, and the watch's verdict turns from the predecessor refusal into a
//    qualified idle that licenses the first message.
// 4. A session-start word that lands after the incarnation's first turn began (a late hook, an
//    in-session /clear or /resume) is logged but never applied: the seat stays working.
// 5. With the native advisory channel live, a compact start writes nothing at all, and an
//    at-prompt start feeds only the presence spool, never the advisory status spool.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { readEvents } from '../src/bus/log.ts';
import run from '../src/daemon/presence/hook.ts';
import { createPresenceIngester } from '../src/daemon/presence/ingest.ts';
import { createPresenceActivity } from '../src/daemon/presence/activity.ts';
import { presencePaths, stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { cliHookSettings } from '../src/launch/cli-hook.ts';
import { nativeAllowsTyping, prefetchPresence, presenceSeatOf, presenceVerdict } from '../src/watch/presence.ts';
import { readState, STATE_FILE } from '../src/state.ts';

const SESSION = 'crew';
const SEAT = 'worker';
const PREDECESSOR = 'prs_0123456789ab';
const BINDING = 'prs_ba9876543210';

type Entry = { hooks: { type: string; command: string }[] };

let base: string;
let dir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'team-presence-fresh-'));
  dir = join(base, '.agents');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const startArgv = (over: Partial<Record<'event' | 'start' | 'notification', string>> = {}): string[] => {
  const fields = { event: 'turn-end', start: 'session-start', ...over };
  const args = ['--dir', dir, '--session', SESSION, '--seat', SEAT, '--binding', BINDING, '--event', fields.event];
  if (fields.start !== undefined) args.push('--start', fields.start);
  if (fields.notification !== undefined) args.push('--notification', fields.notification);
  return args;
};
const payload = (source: unknown, event = 'SessionStart'): string =>
  JSON.stringify({ session_id: 'synthetic', hook_event_name: event, source });
const spoolEvents = (): { event: string; raw?: string; binding: string }[] => {
  const spool = presencePaths(dir, SESSION, SEAT)!.spool;
  if (!existsSync(spool)) return [];
  return readdirSync(spool).map((file) => JSON.parse(readFileSync(join(spool, file), 'utf8')) as {
    event: string; raw?: string; binding: string;
  });
};

describe('the session-start presence word', () => {
  test('the settings file runs the session-start command after the model report', () => {
    const text = cliHookSettings('/s/worker.json', undefined, undefined, undefined, {
      dir: '/p/.agents', session: SESSION, seat: SEAT, binding: BINDING,
    });
    const settings = JSON.parse(text) as { hooks: Record<string, Entry[]> };
    const commands = (settings.hooks.SessionStart ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
    expect(commands).toHaveLength(2);
    expect(commands[0]).not.toContain('presence-hook');
    expect(commands[1]).toContain(' presence-hook ');
    expect(commands[1]).toContain('--event turn-end --start session-start');
    expect(commands[1]).toContain(BINDING);
    expect(commands[1]).toContain('>/dev/null 2>&1 || true');
  });

  test('no presence object, no session-start presence command', () => {
    const settings = JSON.parse(cliHookSettings('/s/worker.json')) as { hooks: Record<string, Entry[]> };
    const commands = (settings.hooks.SessionStart ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
    expect(commands.some((command) => command.includes('presence-hook'))).toBe(false);
  });

  test('an at-prompt start stages the incarnation\'s first turn-end; every other start declines', () => {
    for (const source of ['compact', 'other', '', 7, null]) {
      expect(run(startArgv(), () => payload(source))).toBe(0);
    }
    expect(run(startArgv(), () => payload('startup', 'Stop'))).toBe(0);
    expect(run(startArgv(), () => '{"hook_event_name":"SessionStart","source":"startup"')).toBe(0);
    expect(run(startArgv(), () => '')).toBe(0);
    expect(spoolEvents()).toEqual([]);
    for (const source of ['startup', 'resume', 'clear']) {
      expect(run(startArgv(), () => payload(source))).toBe(0);
    }
    const staged = spoolEvents();
    expect(staged).toHaveLength(3);
    for (const record of staged) {
      expect(record).toMatchObject({ event: 'turn-end', raw: 'session-start', binding: BINDING });
    }
  });

  test('the start filter is one unit with the at-prompt word', () => {
    const cases = [
      startArgv({ event: 'turn-start' }),
      startArgv({ event: 'human-wait' }),
      startArgv({ start: 'startup' }),
      startArgv({ event: 'human-wait', notification: 'permission_prompt' }),
      startArgv({ notification: 'permission_prompt' }),
    ];
    for (const args of cases) expect(run(args, () => payload('startup'))).toBe(1);
    expect(spoolEvents()).toEqual([]);
  });

  const origin = Date.now() - 120_000;
  const at = (offsetMs: number): string => new Date(origin + offsetMs).toISOString();
  const writeSeat = (binding: string): void => {
    const state = existsSync(join(dir, STATE_FILE)) ? readState(dir) : { format: 1, sessions: {} };
    const sessions = state.sessions as Record<string, { seats: Record<string, Record<string, unknown>>; worktrees: object }>;
    sessions[SESSION] ??= { seats: {}, worktrees: {} };
    const record = sessions[SESSION].seats[SEAT] ?? { id: 'seat_0123456789ab', stage: 'ready' };
    record.presence_binding = binding;
    sessions[SESSION].seats[SEAT] = record;
    writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(state)}\n`);
  };
  /** One ingest + activity pass and the watch's verdict, on the wall clock the ingester stamps. */
  const pipeline = () => {
    const ingester = createPresenceIngester({ stateDir: dir, session: SESSION });
    const activity = createPresenceActivity({ stateDir: dir, session: SESSION });
    return {
      pass: async (): Promise<void> => {
        await ingester.step();
        await activity(new Date());
      },
      verdict: async () => {
        const reads = await prefetchPresence({ stateDir: dir, session: SESSION, seatNames: [SEAT] });
        const seat = presenceSeatOf(readState(dir).sessions[SESSION], SEAT, () => true);
        return presenceVerdict(reads.get(SEAT)!, seat, { now: new Date(), thresholdSeconds: 0 });
      },
      close: () => ingester.close(),
    };
  };

  test('a restarted seat turns from the predecessor refusal into a qualified idle', async () => {
    const { pass, verdict, close } = pipeline();

    // The predecessor was mid-turn when it was restarted.
    writeSeat(PREDECESSOR);
    stagePresenceRecord(dir, {
      session: SESSION, seat: SEAT, binding: PREDECESSOR, source: 'runtime-hook', event: 'turn-start', ts: at(0),
    });
    await pass();
    expect(await verdict()).toMatchObject({ idle: false, reason: 'working' });

    // The relaunch mints its binding: the projection on disk is the predecessor's.
    writeSeat(BINDING);
    await pass();
    const held = await verdict();
    expect(held).toMatchObject({ idle: false, reason: 'invalid', why: 'the projection was emitted by a predecessor runtime binding' });
    expect(nativeAllowsTyping(held)).toBe(false);

    // Claude Code starts at its prompt and its SessionStart hook runs under the new binding.
    expect(run(startArgv(), () => payload('startup'))).toBe(0);
    await pass();
    const ready = await verdict();
    expect(ready).toMatchObject({ idle: true, source: 'runtime-hook' });
    expect(nativeAllowsTyping(ready)).toBe(true);
    await close();
  });

  test('a session-start word after the first turn began never replaces working', async () => {
    const { pass, verdict, close } = pipeline();
    writeSeat(BINDING);
    // The launch's first typed input started a turn before the SessionStart hook's write landed.
    stagePresenceRecord(dir, {
      session: SESSION, seat: SEAT, binding: BINDING, source: 'runtime-hook', event: 'turn-start', ts: at(0),
    });
    await pass();
    expect(await verdict()).toMatchObject({ idle: false, reason: 'working' });
    expect(run(startArgv(), () => payload('resume'))).toBe(0);
    await pass();
    const held = await verdict();
    expect(held).toMatchObject({ idle: false, reason: 'working' });
    expect(nativeAllowsTyping(held)).toBe(false);
    // The word is in the durable log, marked not applied.
    const log = readFileSync(presencePaths(dir, SESSION, SEAT)!.log, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { raw?: string; applied: boolean });
    expect(log.map((line) => [line.raw ?? null, line.applied])).toEqual([[null, true], ['session-start', false]]);

    // Both in one batch, the hook's write stamped after the turn start: still working.
    writeSeat(PREDECESSOR);
    await pass();
    writeSeat('prs_aaaaaaaaaaaa');
    stagePresenceRecord(dir, {
      session: SESSION, seat: SEAT, binding: 'prs_aaaaaaaaaaaa', source: 'runtime-hook', event: 'turn-start', ts: at(10_000),
    });
    stagePresenceRecord(dir, {
      session: SESSION, seat: SEAT, binding: 'prs_aaaaaaaaaaaa', source: 'runtime-hook', event: 'turn-end',
      raw: 'session-start', ts: at(11_000),
    });
    await pass();
    expect(await verdict()).toMatchObject({ idle: false, reason: 'working' });
    await close();
  });
});

describe('the session-start word and the native advisory channel', () => {
  const TEAM = `format: 1
project: acme-web
session: crew
coordinator: crew-lead
operator: crew-op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

  test('compact writes nothing, and an at-prompt start feeds only the presence spool', async () => {
    const made = realpathSync(mkdtempSync(join(tmpdir(), 'team-presence-fresh-native-')));
    const root = join(made, 'repo');
    const home = join(made, 'home');
    const stateDir = join(root, '.agents');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(stateDir, 'team.yaml'), TEAM);
    writeFileSync(join(stateDir, STATE_FILE), JSON.stringify({ format: 1, sessions: { crew: { seats: {
      'worker-1': { stage: 'ready', pane: 'pane-example', presence_binding: BINDING },
    }, worktrees: {} } } }));
    const started = await startMachineDaemon({
      home, roots: [root], startedBy: 'service-manager', version: '0.5.3-presence-fresh-test',
      heartbeatMs: 20, presenceHosting: true, presenceEveryMs: 10, presenceSubscriptions: () => [],
    });
    if (started.kind !== 'serving') throw new Error(`the daemon did not start: ${started.kind}`);
    try {
      const paths = presencePaths(stateDir, 'crew', 'worker-1')!;
      const marker = join(paths.root, 'status-feed.json');
      const deadline = Date.now() + 3_000;
      while (!existsSync(marker)) {
        if (Date.now() > deadline) throw new Error('the native marker never appeared');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const io = {
        cwd: root, env: { HOME: home }, stdinIsTTY: false, stdout: () => {}, stderr: () => {},
        caller: { kind: 'seat' as const, name: 'worker-1', pane: 'pane-example', session: 'crew' },
      };
      const hookArgv = ['--dir', stateDir, '--session', 'crew', '--seat', 'worker-1', '--binding', BINDING,
        '--event', 'turn-end', '--start', 'session-start'];
      const statusSpool = join(paths.root, 'status-spool');
      const statusFiles = (): string[] => (existsSync(statusSpool) ? readdirSync(statusSpool) : []);
      const presenceFiles = (): string[] => (existsSync(paths.spool) ? readdirSync(paths.spool) : []);
      const nativeStatuses = (): number => {
        const bus = readEvents('acme-web', root, home);
        return bus.ok ? bus.events.filter((record) => record.payload.kind === 'seat.status').length : 0;
      };

      expect(run(hookArgv, () => payload('compact'), io, () => home)).toBe(0);
      expect(run(hookArgv, () => payload('startup'), io, () => home)).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(statusFiles()).toEqual([]);
      expect(nativeStatuses()).toBe(0);
      // The startup word reached the presence path (staged, or already taken by the ingester).
      const log = existsSync(paths.log) ? readFileSync(paths.log, 'utf8') : '';
      expect(presenceFiles().length + (log.includes('"session-start"') ? 1 : 0)).toBe(1);

      // Control: the channel is live in this scene, so an ordinary turn command does feed it.
      expect(presenceHookTurn(stateDir, io, home)).toBe(0);
      const until = Date.now() + 3_000;
      while (nativeStatuses() === 0) {
        if (Date.now() > until) throw new Error('the native channel never published');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await started.daemon.close();
      rmSync(made, { recursive: true, force: true });
    }
  }, 20_000);
});

function presenceHookTurn(stateDir: string, io: Parameters<typeof run>[2], home: string): number {
  return run(['--dir', stateDir, '--session', 'crew', '--seat', 'worker-1', '--binding', BINDING, '--event', 'turn-start'],
    () => '{"hook_event_name":"UserPromptSubmit"}', io, () => home);
}
