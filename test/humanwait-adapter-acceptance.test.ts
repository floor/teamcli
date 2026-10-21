// Independent acceptance for the human-wait half of the Claude adapter, at integrated
// 78014e1a3 (the bc0d65a5f stage plus the ignored-notification exit hygiene): the generated
// settings file, its Notification command run through `sh` with a real stdin pipe, the real
// spool writer, the real ingester, and the display consumer's fence. No live seat, session,
// owner home or CLI is touched; every world lives under a synthetic temporary directory.
//
// What these scenes hold the adapter to:
//   - the settings entry carries no matcher; the filter is the exact stdin payload;
//   - the measured `Notification`/`permission_prompt` pair stages one `human-wait` record and
//     the consumer shows a person being waited on, never idle;
//   - every other type, name, shape, empty, malformed or oversized payload stages nothing and
//     leaves the consumer on its previous word;
//   - a filter word on a turn event, a missing filter on `human-wait`, or another filter value
//     is refused before stdin is read;
//   - turn start and turn end read no stdin, stage their own event with no raw word, and are the
//     way a human-wait clears: no permission-grant event is measured or claimed;
//   - a predecessor incarnation's later-clocked record cannot flip the current runtime's
//     projection, and the consumer fences it as invalid rather than as absence.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import run from '../src/daemon/presence/hook.ts';
import { createPresenceIngester } from '../src/daemon/presence/ingest.ts';
import { readPresenceForSeat } from '../src/labels/presence.ts';
import { cliHookSettings } from '../src/launch/cli-hook.ts';
import { presencePaths, stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { emptySession, updateState } from '../src/state.ts';

const SESSION = 'teamcli';
const SEAT = 'worker';
const BINDING = 'prs_0123456789ab';
const PREDECESSOR = 'prs_ba9876543210';

const PERMISSION_PROMPT = JSON.stringify({
  hook_event_name: 'Notification',
  notification_type: 'permission_prompt',
});

type HookEntry = { matcher?: unknown; hooks: { type: string; command: string }[] };
type SettingsDoc = { hooks: Record<string, HookEntry[]> };

type LogLine = {
  seq: number;
  event: string;
  state: string;
  binding: string;
  applied: boolean;
  raw?: string;
};

describe('the generated human-wait adapter filters its own stdin and never invents a state', () => {
  let root: string;
  let dir: string;
  let home: string;
  let settingsPath: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'b7-humanwait-world-')));
    dir = join(root, '.agents');
    mkdirSync(dir);
    home = join(root, 'home');
    mkdirSync(home);
    setBinding(BINDING);
    settingsPath = join(dir, 'seat-state', SESSION, `${SEAT}.json`);
  });

  function setBinding(binding: string): void {
    updateState(dir, (state) => {
      state.sessions[SESSION] = {
        ...emptySession(),
        seats: {
          worker: {
            id: 'seat_111111111111',
            pane: 'pane-1',
            workspace: 'ws-1',
            stage: 'ready',
            model: 'Claude Opus',
            version: '5.5',
            launch_line: 'claude --model claude-opus-5-5',
            presence_binding: binding,
          },
        },
      };
    });
  }

  function settingsDoc(binding = BINDING): SettingsDoc {
    const presence = { dir, session: SESSION, seat: SEAT, binding };
    return JSON.parse(cliHookSettings(settingsPath, undefined, undefined, undefined, presence)) as SettingsDoc;
  }

  function presenceCommand(doc: SettingsDoc, key: string, event: string): string {
    const entry = (doc.hooks[key] ?? [])
      .flatMap((candidate) => candidate.hooks)
      .map((hook) => hook.command)
      .find((command) => command.includes('presence-hook') && command.includes(`--event ${event}`));
    if (entry === undefined) throw new Error(`the settings hold no ${key} presence command for ${event}`);
    return entry;
  }

  /** The generated command in its real shape: `sh -c`, its stdin a pipe carrying the payload. */
  function runGenerated(command: string, payload: string) {
    return spawnSync('sh', ['-c', command], {
      input: payload,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: tmpdir() },
      timeout: 30_000,
    });
  }

  function spoolFiles(): string[] {
    const paths = presencePaths(dir, SESSION, SEAT);
    if (paths === null) return [];
    try {
      return readdirSync(paths.spool).filter((name) => name.endsWith('.json')).sort();
    } catch {
      return [];
    }
  }

  function stagedRecords(): { id: string; event: string; binding: string; raw?: string }[] {
    const paths = presencePaths(dir, SESSION, SEAT);
    if (paths === null) return [];
    return spoolFiles().map((name) => JSON.parse(readFileSync(join(paths.spool, name), 'utf8')) as {
      id: string; event: string; binding: string; raw?: string;
    });
  }

  function logLines(): LogLine[] {
    const paths = presencePaths(dir, SESSION, SEAT);
    if (paths === null) return [];
    try {
      return readFileSync(paths.log, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as LogLine);
    } catch {
      return [];
    }
  }

  async function ingest(): Promise<void> {
    const ingester = createPresenceIngester({ stateDir: dir, session: SESSION });
    try {
      await ingester.step();
    } finally {
      await ingester.close();
    }
  }

  function projection(binding: string, channelHealthy = true) {
    const read = readPresenceForSeat(dir, SESSION, SEAT, binding, channelHealthy);
    if (read.kind !== 'ok') throw new Error(`the consumer answered ${read.kind}`);
    return read.observation;
  }

  function argv(extra: readonly string[]): string[] {
    return ['--dir', dir, '--session', SESSION, '--seat', SEAT, '--binding', BINDING, ...extra];
  }

  test('the settings carry a matcherless Notification entry and stdin-free turn commands', () => {
    const doc = settingsDoc();
    const notification = doc.hooks.Notification ?? [];
    expect(notification).toHaveLength(1);
    expect(notification[0]).not.toHaveProperty('matcher');
    expect(notification[0]!.hooks).toHaveLength(1);
    expect(notification[0]!.hooks[0]!.type).toBe('command');
    const humanWait = notification[0]!.hooks[0]!.command;
    expect(humanWait).toContain('presence-hook');
    expect(humanWait).toContain(`--dir ${dir}`);
    expect(humanWait).toContain(`--session ${SESSION}`);
    expect(humanWait).toContain(`--seat ${SEAT}`);
    expect(humanWait).toContain(`--binding ${BINDING}`);
    expect(humanWait).toContain('--event human-wait');
    expect(humanWait).toContain('--notification permission_prompt');
    expect(humanWait).toContain('>/dev/null 2>&1 || true');

    const start = presenceCommand(doc, 'UserPromptSubmit', 'turn-start');
    const stop = presenceCommand(doc, 'Stop', 'turn-end');
    for (const command of [start, stop]) {
      expect(command).not.toContain('--notification');
      expect(command).toContain('>/dev/null 2>&1 || true');
    }
  });

  test('the exact measured pair stages human-wait and the consumer shows a person waited on, never idle', async () => {
    const before = readPresenceForSeat(dir, SESSION, SEAT, BINDING, true);
    expect(before.kind).toBe('absent');
    expect(projectionExists()).toBe(false);

    const result = runGenerated(presenceCommand(settingsDoc(), 'Notification', 'human-wait'), PERMISSION_PROMPT);
    expect(result.status).toBe(0);
    const [record] = stagedRecords();
    expect(record).toBeDefined();
    expect(record).toMatchObject({ event: 'human-wait', binding: BINDING, raw: 'permission_prompt' });

    await ingest();
    expect(logLines()).toHaveLength(1);
    expect(logLines()[0]).toMatchObject({
      seq: 1,
      event: 'human-wait',
      state: 'waiting-for-a-person',
      binding: BINDING,
      applied: true,
      raw: 'permission_prompt',
    });
    expect(projection(BINDING)).toMatchObject({
      state: 'waiting-for-a-person',
      event: 'human-wait',
      source: 'runtime-hook',
      live: true,
    });
    expect(projection(BINDING).state).not.toBe('idle');
    // Without a fresh channel answer the word is last-known, never a fresh idle.
    expect(projection(BINDING, false)).toMatchObject({
      state: 'waiting-for-a-person',
      event: 'human-wait',
      live: false,
    });
  });

  test('every other payload stages nothing and leaves the consumer on its previous word', async () => {
    // A real previous word: the runtime's own turn start, staged and ingested.
    const staged = stagePresenceRecord(dir, {
      session: SESSION,
      seat: SEAT,
      binding: BINDING,
      source: 'runtime-hook',
      event: 'turn-start',
    });
    expect(staged.kind).toBe('staged');
    await ingest();
    expect(projection(BINDING)).toMatchObject({ state: 'working', event: 'turn-start' });

    const command = presenceCommand(settingsDoc(), 'Notification', 'human-wait');
    const cases: [string, string][] = [
      ['another hook event', JSON.stringify({ hook_event_name: 'Stop', notification_type: 'permission_prompt' })],
      ['another notification type', JSON.stringify({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })],
      ['a missing notification type', JSON.stringify({ hook_event_name: 'Notification' })],
      ['an array', JSON.stringify([{ hook_event_name: 'Notification', notification_type: 'permission_prompt' }])],
      ['malformed JSON', '{"hook_event_name":"Notification",'],
      ['empty input', ''],
      ['an oversized pair', JSON.stringify({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        padding: 'x'.repeat(70_000),
      })],
    ];
    for (const [label, payload] of cases) {
      const result = runGenerated(command, payload);
      expect({ label, status: result.status }).toEqual({ label, status: 0 });
    }
    expect(spoolFiles()).toHaveLength(0);
    expect(logLines()).toHaveLength(1);
    expect(projection(BINDING)).toMatchObject({ state: 'working', event: 'turn-start' });
    expect(projection(BINDING).state).not.toBe('idle');
  });

  test('a mismatched argv filter or event is refused before stdin is read', () => {
    let reads = 0;
    const readInput = (): string => {
      reads += 1;
      return PERMISSION_PROMPT;
    };
    // `human-wait` is only ever staged from the filter, and the filter is only ever human-wait.
    expect(run(argv(['--event', 'human-wait']), readInput)).toBe(1);
    expect(run(argv(['--event', 'turn-start', '--notification', 'permission_prompt']), readInput)).toBe(1);
    expect(run(argv(['--event', 'turn-end', '--notification', 'permission_prompt']), readInput)).toBe(1);
    expect(run(argv(['--event', 'human-wait', '--notification', 'idle_prompt']), readInput)).toBe(1);
    expect(reads).toBe(0);
    expect(spoolFiles()).toHaveLength(0);

    // The one pairing that parses stages once.
    expect(run(argv(['--event', 'human-wait', '--notification', 'permission_prompt']), readInput)).toBe(0);
    expect(reads).toBe(1);
    expect(stagedRecords()).toHaveLength(1);
    expect(stagedRecords()[0]).toMatchObject({ event: 'human-wait', raw: 'permission_prompt' });
  });

  test('turn start and turn end read no stdin and stage their own event with no raw word', () => {
    let reads = 0;
    const readInput = (): string => {
      reads += 1;
      return PERMISSION_PROMPT;
    };
    expect(run(argv(['--event', 'turn-start']), readInput)).toBe(0);
    expect(run(argv(['--event', 'turn-end']), readInput)).toBe(0);
    expect(reads).toBe(0);
    const records = stagedRecords();
    // The spool is listed by record id, so same-millisecond events have no order promise here.
    expect(records.map((record) => record.event).sort()).toEqual(['turn-end', 'turn-start']);
    for (const record of records) expect(record).not.toHaveProperty('raw');

    // The generated commands, run with a matching payload on stdin, still stage their own event.
    const doc = settingsDoc();
    expect(runGenerated(presenceCommand(doc, 'UserPromptSubmit', 'turn-start'), PERMISSION_PROMPT).status).toBe(0);
    expect(runGenerated(presenceCommand(doc, 'Stop', 'turn-end'), PERMISSION_PROMPT).status).toBe(0);
    const after = stagedRecords();
    expect(after).toHaveLength(4);
    expect(after.map((record) => record.event).sort()).toEqual([
      'turn-end', 'turn-end', 'turn-start', 'turn-start',
    ]);
    for (const record of after) {
      expect(record.event).not.toBe('human-wait');
      expect(record).not.toHaveProperty('raw');
    }
  });

  test('a predecessor incarnation\'s later record cannot flip the current runtime, and the fence refuses it', async () => {
    // The predecessor's human-wait is real and applied in the log while it owned the binding,
    // with a clock later than every event of its successor.
    setBinding(PREDECESSOR);
    const old = stagePresenceRecord(dir, {
      session: SESSION,
      seat: SEAT,
      binding: PREDECESSOR,
      source: 'runtime-hook',
      event: 'human-wait',
      raw: 'permission_prompt',
      ts: '2026-10-19T10:00:02.000Z',
    });
    expect(old.kind).toBe('staged');
    await ingest();
    expect(projection(PREDECESSOR)).toMatchObject({ state: 'waiting-for-a-person', event: 'human-wait' });

    // The successor's first event is earlier on the runtime clock.
    setBinding(BINDING);
    const fresh = stagePresenceRecord(dir, {
      session: SESSION,
      seat: SEAT,
      binding: BINDING,
      source: 'runtime-hook',
      event: 'turn-end',
      ts: '2026-10-19T10:00:01.000Z',
    });
    expect(fresh.kind).toBe('staged');
    await ingest();

    const lines = logLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ binding: PREDECESSOR, event: 'human-wait', applied: true });
    expect(lines[1]).toMatchObject({ binding: BINDING, event: 'turn-end', applied: true });
    expect(projection(BINDING)).toMatchObject({ state: 'idle', event: 'turn-end', live: true });

    const oldIncarnation = readPresenceForSeat(dir, SESSION, SEAT, PREDECESSOR, true);
    expect(oldIncarnation.kind).toBe('invalid');
    if (oldIncarnation.kind !== 'invalid') throw new Error('unreachable');
    expect(oldIncarnation.why).toContain('another runtime incarnation');
  });

  test('the next real turn start and turn end clear a human-wait; no permission-grant event is claimed', async () => {
    const doc = settingsDoc();
    const humanWait = presenceCommand(doc, 'Notification', 'human-wait');
    const start = presenceCommand(doc, 'UserPromptSubmit', 'turn-start');
    const stop = presenceCommand(doc, 'Stop', 'turn-end');

    expect(runGenerated(humanWait, PERMISSION_PROMPT).status).toBe(0);
    await ingest();
    expect(projection(BINDING)).toMatchObject({ state: 'waiting-for-a-person', event: 'human-wait' });

    // The next turn's own start is the clear; the payload on stdin is ignored by this command.
    expect(runGenerated(start, PERMISSION_PROMPT).status).toBe(0);
    await ingest();
    expect(projection(BINDING)).toMatchObject({ state: 'working', event: 'turn-start', live: true });

    expect(runGenerated(stop, PERMISSION_PROMPT).status).toBe(0);
    await ingest();
    expect(projection(BINDING)).toMatchObject({ state: 'idle', event: 'turn-end', live: true });
    expect(logLines().map((line) => line.event)).toEqual(['human-wait', 'turn-start', 'turn-end']);
  });

  function projectionExists(): boolean {
    const paths = presencePaths(dir, SESSION, SEAT);
    if (paths === null) return false;
    try {
      readFileSync(paths.current);
      return true;
    } catch {
      return false;
    }
  }
});
