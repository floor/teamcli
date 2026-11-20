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
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  test('a restarted seat turns from the predecessor refusal into a qualified idle', async () => {
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
    const ingester = createPresenceIngester({ stateDir: dir, session: SESSION });
    const activity = createPresenceActivity({ stateDir: dir, session: SESSION });
    // Every pass and verdict runs on the wall clock: the ingester stamps observedAt with it.
    const pass = async (): Promise<void> => {
      await ingester.step();
      await activity(new Date());
    };
    const verdict = async () => {
      const reads = await prefetchPresence({ stateDir: dir, session: SESSION, seatNames: [SEAT] });
      const seat = presenceSeatOf(readState(dir).sessions[SESSION], SEAT, () => true);
      return presenceVerdict(reads.get(SEAT)!, seat, { now: new Date(), thresholdSeconds: 0 });
    };

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
    await ingester.close();
  });
});
