// The presence consumer: a native projection is believed only when it is current for the seat's
// own incarnation, its exact sequence is fenced into the canonical activity clock, the channel is
// known healthy, and both the persisted and native idle clocks have passed the window. A
// malformed, unfenced or mismatched record holds the dispatcher; absence alone licenses the
// labelled terminal-host fallback. Every world is synthetic and reads no real session.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PresenceEvent, PresenceReading, PresenceWriterSource } from '../src/daemon/presence/contract.ts';
import { createPresenceIngester } from '../src/daemon/presence/ingest.ts';
import { stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { emptySession, type SessionState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { idleWorkReport } from '../src/watch/idle-work.ts';
import {
  prefetchPresence, presenceVerdict,
  type PresenceRead, type PresenceSeat,
} from '../src/watch/presence.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-20T03:00:00Z');
const BINDING = 'prs_0123456789ab';
const SEAT_ID = 'seat_0123456789ab';

const iso = (ago: number): string => new Date(NOW - ago).toISOString();

function reading(over: Partial<PresenceReading> = {}): PresenceReading {
  const since = over.since ?? iso(10 * MIN);
  const value: PresenceReading = {
    v: 1,
    seq: 7,
    id: `${since}-a1b2c3d4`,
    state: 'idle',
    source: 'runtime-hook',
    event: 'turn-end',
    binding: BINDING,
    since,
    observedAt: iso(9 * MIN),
    ...over,
  };
  if (over.id === undefined) value.id = `${value.since}-a1b2c3d4`;
  // Ingest never precedes the event it carries, and is never after now.
  if (over.observedAt === undefined) {
    value.observedAt = new Date(Math.min(NOW, Date.parse(value.since) + MIN)).toISOString();
  }
  return value;
}

function seat(over: Partial<PresenceSeat> = {}): PresenceSeat {
  const lastActive = over.lastActive === undefined ? iso(10 * MIN) : over.lastActive;
  return {
    seat: 'writer',
    seatId: SEAT_ID,
    binding: BINDING,
    fence: { seat_id: SEAT_ID, binding: BINDING, seq: 7, applied_at: iso(9 * MIN) },
    lastActive,
    channelHealthy: true,
    ...over,
  };
}

function verdict(over: Partial<PresenceReading> = {}, seatOver: Partial<PresenceSeat> = {}, thresholdSeconds = 300) {
  return presenceVerdict({ kind: 'native', reading: reading(over) }, seat(seatOver), {
    now: new Date(NOW), thresholdSeconds,
  });
}

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

function scratch(): { base: string; stateDir: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'watch-presence-')));
  made.push(base);
  const stateDir = join(base, '.agents');
  mkdirSync(join(stateDir, 'presence', 'crew'), { recursive: true });
  return { base, stateDir };
}

describe('the native proof', () => {
  test('a native idle past both clocks is proven idle with its own source', () => {
    expect(verdict()).toEqual({
      idle: true, source: 'runtime-hook', nativeSince: iso(10 * MIN), observedAt: iso(9 * MIN),
    });
  });

  test('an old observedAt on a healthy same-incarnation record is not expired by age', () => {
    const since = iso(6 * 60 * MIN);
    const result = verdict({ since, observedAt: iso(6 * 60 * MIN - MIN) }, { lastActive: since });
    expect(result.idle).toBe(true);
  });

  test('working, waiting-for-a-person and gone are never idle, even with an old claim clock', () => {
    expect(verdict({ state: 'working', event: 'turn-start' }, { lastActive: iso(60 * MIN) }))
      .toMatchObject({ idle: false, reason: 'working' });
    expect(verdict({ state: 'waiting-for-a-person', event: 'human-wait', since: iso(MIN) }, { lastActive: iso(60 * MIN) }))
      .toMatchObject({ idle: false, reason: 'waiting-for-a-person' });
    expect(verdict({ state: 'gone', event: 'session-end', since: iso(MIN) }, { lastActive: iso(60 * MIN) }))
      .toMatchObject({ idle: false, reason: 'gone' });
    // Waiting/gone need not have a canonical stamp newer than the transition.
    expect(verdict({ state: 'waiting-for-a-person', event: 'human-wait', since: iso(MIN) }, { lastActive: undefined }))
      .toMatchObject({ idle: false, reason: 'waiting-for-a-person' });
  });

  test('both clocks must pass, and an unreconciled stamp is not merely too recent', () => {
    // Native transition past the window but a fresh persisted stamp: still too recent.
    expect(verdict({ since: iso(10 * MIN) }, { lastActive: iso(MIN) }))
      .toMatchObject({ idle: false, reason: 'too-recent' });
    // Fresh transition over a coherently fresh stamp: too recent on the native clock.
    expect(verdict({ since: iso(MIN) }, { lastActive: iso(30_000) }))
      .toMatchObject({ idle: false, reason: 'too-recent' });
    // A persisted stamp older than the transition means the fence was never reconciled there.
    expect(verdict({ since: iso(MIN) }, { lastActive: iso(60 * MIN) }))
      .toMatchObject({ idle: false, reason: 'invalid' });
  });

  test('a mismatched or missing incarnation is invalid, never a fallback', () => {
    expect(verdict({ binding: 'prs_ffffffffffff' })).toMatchObject({ idle: false, reason: 'invalid' });
    expect(verdict({}, { binding: null })).toMatchObject({ idle: false, reason: 'invalid' });
    expect(verdict({}, { seatId: null })).toMatchObject({ idle: false, reason: 'invalid' });
  });

  test('the fence must be canonical, from this seat and incarnation, and exactly at the record seq', () => {
    const fence = { seat_id: SEAT_ID, binding: BINDING, seq: 7, applied_at: iso(9 * MIN) };
    expect(verdict({}, { fence: undefined })).toMatchObject({ idle: false, reason: 'invalid' });
    expect(verdict({}, { fence: { ...fence, seq: 6 } })).toMatchObject({ idle: false, reason: 'invalid' });
    expect(verdict({}, { fence: { ...fence, seq: 8 } })).toMatchObject({ idle: false, reason: 'invalid' });
    expect(verdict({}, { fence: { ...fence, seat_id: 'seat_ffffffffffff' } }))
      .toMatchObject({ idle: false, reason: 'invalid' });
    expect(verdict({}, { fence: { ...fence, binding: 'prs_ffffffffffff' } }))
      .toMatchObject({ idle: false, reason: 'invalid' });
    expect(verdict({}, { fence: { ...fence, applied_at: new Date(NOW + 2 * MIN).toISOString() } }))
      .toMatchObject({ idle: false, reason: 'invalid' });
  });

  test('an unknown channel holds the reading, never a screen', () => {
    expect(verdict({}, { channelHealthy: false })).toMatchObject({ idle: false, reason: 'invalid' });
  });

  test('future timestamps and a since/id disagreement are refused; the id instant must be since', () => {
    expect(verdict({ observedAt: new Date(NOW + 2 * MIN).toISOString() }))
      .toMatchObject({ idle: false, reason: 'invalid' });
    const futureSince = new Date(NOW + 2 * MIN).toISOString();
    expect(verdict({ since: futureSince, observedAt: new Date(NOW).toISOString() }))
      .toMatchObject({ idle: false, reason: 'invalid' });
    expect(verdict({}, { lastActive: new Date(NOW + 2 * MIN).toISOString() }))
      .toMatchObject({ idle: false, reason: 'invalid' });
    expect(verdict({ id: `${iso(9 * MIN)}-a1b2c3d4` }))
      .toMatchObject({ idle: false, reason: 'invalid' });
  });

  test('the persisted stamp may be newer than the native transition but not older', () => {
    // 6 minutes persisted against a 10-minute native idle: still coherent and eligible.
    expect(verdict({}, { lastActive: iso(6 * MIN) }).idle).toBe(true);
    // A stamp 9 minutes older than the transition is not this projection's clock.
    expect(verdict({ since: iso(MIN) }, { lastActive: iso(10 * MIN) }))
      .toMatchObject({ idle: false, reason: 'invalid' });
  });

  test('a native source no runtime writes, an unknown event and a wrong mapping are invalid', () => {
    expect(verdict({ source: 'terminal-host' as unknown as PresenceWriterSource }))
      .toMatchObject({ idle: false, reason: 'invalid' });
    expect(verdict({ event: 'status-line' as unknown as PresenceEvent }))
      .toMatchObject({ idle: false, reason: 'invalid' });
    expect(verdict({ event: 'turn-start', state: 'idle' }))
      .toMatchObject({ idle: false, reason: 'invalid' });
    expect(verdict({ seq: 0 }, { fence: undefined }))
      .toMatchObject({ idle: false, reason: 'invalid' });
  });
});

describe('prefetch and the labelled fallback', () => {
  test('prefetch distinguishes a reading, a malformed record and an explicit absence', async () => {
    const { stateDir } = scratch();
    const dir = join(stateDir, 'presence', 'crew');
    mkdirSync(join(dir, 'writer'), { recursive: true });
    mkdirSync(join(dir, 'broken'), { recursive: true });
    writeFileSync(join(dir, 'writer', 'current.json'), JSON.stringify(reading()));
    writeFileSync(join(dir, 'broken', 'current.json'), '{not json');
    const reads = await prefetchPresence({ stateDir, session: 'crew', seatNames: ['writer', 'broken', 'absent'] });
    expect(reads.get('writer')).toMatchObject({ kind: 'native' });
    expect(reads.get('broken')).toMatchObject({ kind: 'invalid' });
    expect(reads.get('absent')).toMatchObject({ kind: 'absent' });
  });

  test('prefetch refuses a projection a runtime could not have written', async () => {
    const { stateDir } = scratch();
    const dir = join(stateDir, 'presence', 'crew', 'writer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'current.json'), JSON.stringify(reading({
      source: 'terminal-host' as unknown as PresenceWriterSource,
    })));
    const reads = await prefetchPresence({ stateDir, session: 'crew', seatNames: ['writer'] });
    expect(reads.get('writer')).toMatchObject({ kind: 'invalid' });
  });

  test('a projection written by the real ingester is read and proven end to end', async () => {
    const { stateDir } = scratch();
    const since = iso(10 * MIN);
    writeFileSync(join(stateDir, 'team.state.json'), `${JSON.stringify({
      format: 1,
      sessions: {
        crew: {
          seats: {
            writer: {
              stage: 'ready',
              last_active: since,
              id: SEAT_ID,
              presence_binding: BINDING,
              presence_applied: { seat_id: SEAT_ID, binding: BINDING, seq: 1, applied_at: since },
            },
          },
        },
      },
    }, null, 2)}\n`);
    expect(stagePresenceRecord(stateDir, {
      session: 'crew', seat: 'writer', binding: BINDING, source: 'runtime-hook', event: 'turn-end', ts: since,
    }).kind).toBe('staged');
    const ingester = createPresenceIngester({ stateDir, session: 'crew', now: () => new Date(NOW) });
    const stepped = await ingester.step();
    await ingester.close();
    expect(stepped.ingested).toHaveLength(1);
    const reads = await prefetchPresence({ stateDir, session: 'crew', seatNames: ['writer'] });
    const read = reads.get('writer');
    if (read?.kind !== 'native') throw new Error('the ingester wrote no native projection');
    expect(presenceVerdict(read, {
      seat: 'writer',
      seatId: SEAT_ID,
      binding: BINDING,
      fence: { seat_id: SEAT_ID, binding: BINDING, seq: read.reading.seq, applied_at: since },
      lastActive: since,
      channelHealthy: true,
    }, { now: new Date(NOW), thresholdSeconds: 300 })).toEqual({
      idle: true, source: 'runtime-hook', nativeSince: since, observedAt: new Date(NOW).toISOString(),
    });
  });
});

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
  - role: builder
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

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const IDLE_SCREEN = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;

function idleLive(): Live {
  return {
    running: true,
    agents: [{ name: 'writer', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
    workspaces: [{ id: 'w1', label: 'writer' }],
    screens: { 'w1:p1': IDLE_SCREEN },
  };
}

function writerState(stamp = iso(10 * MIN)): SessionState {
  const state = emptySession();
  state.seats.writer = {
    stage: 'ready',
    last_active: stamp,
    id: SEAT_ID,
    presence_binding: BINDING,
    presence_applied: { seat_id: SEAT_ID, binding: BINDING, seq: 7, applied_at: iso(9 * MIN) },
  } as SessionState['seats'][string];
  return state;
}

function reportWith(read: PresenceRead, options: { live?: Live | null; healthy?: boolean } = {}) {
  return idleWorkReport({
    root: '/nonexistent-acme-root',
    team,
    state: writerState(),
    live: options.live === undefined ? null : options.live,
    now: new Date(NOW),
    presence: new Map([['writer', read]]),
    presenceChannelHealthy: options.healthy ?? true,
  });
}

describe('the report seam', () => {
  test('a native idle seat is counted with live null, and keeps the persisted stamp as since', () => {
    const report = reportWith({ kind: 'native', reading: reading() });
    expect(report.presence_unknown).toBeUndefined();
    expect(report.idle).toEqual([{
      seat: 'writer',
      since: iso(10 * MIN),
      native_since: iso(10 * MIN),
      presence_source: 'runtime-hook',
    }]);
  });

  test('a working reading is known non-idle and does not hold the pass', () => {
    const report = reportWith({ kind: 'native', reading: reading({ state: 'working', event: 'turn-start' }) });
    expect(report.idle).toEqual([]);
    expect(report.presence_unknown).toBeUndefined();
  });

  test('an invalid or unfenced reading holds and is never counted', () => {
    const report = reportWith({ kind: 'invalid', why: 'the projection is unreadable' });
    expect(report.idle).toEqual([]);
    expect(report.presence_unknown).toContain('writer');
    expect(report.presence_unknown).toContain('the projection is unreadable');
  });

  test('an unknown channel holds a present projection even when it looks idle', () => {
    const report = reportWith({ kind: 'native', reading: reading() }, { healthy: false });
    expect(report.idle).toEqual([]);
    expect(report.presence_unknown).toContain('channel is not known healthy');
  });

  test('an absent record falls back to the labelled terminal-host reading', () => {
    const report = reportWith({ kind: 'absent', why: 'no projection' }, { live: idleLive() });
    expect(report.presence_unknown).toBeUndefined();
    expect(report.idle).toEqual([{
      seat: 'writer', since: iso(10 * MIN), presence_source: 'terminal-host',
    }]);
  });

  test('without a prefetched map the report keeps today’s unlabelled reading', () => {
    const report = idleWorkReport({
      root: '/nonexistent-acme-root', team, state: writerState(), live: idleLive(), now: new Date(NOW),
    });
    expect(report.idle).toEqual([{ seat: 'writer', since: iso(10 * MIN) }]);
  });
});
