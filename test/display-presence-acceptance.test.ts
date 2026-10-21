// Independent acceptance of the seat display's reading of the daemon's presence projection
// (src/labels/presence.ts, src/labels/state.ts) and of the two commands that carry it
// (src/commands/seats.ts, src/commands/status.ts). Two levels:
//
//   - the reading itself, called with the projection, screen and trace a caller gathered;
//   - `team seats --json` over a real synthetic project on disk: a real team file, a real
//     `.agents/state.json` with the seat's recorded binding, a real `current.json` under the
//     presence tree, and a real screen read through the CLI's own fixtures. The daemon health
//     answer is the one injected source — the machine socket is the host's acceptance, not this file —
//     and it is the only thing that can qualify a projection live.
//
// Every world below is synthetic and under a temporary directory; no live CLI seat, pane, home or
// credential file is read. The screen texts are the repository's own captured fixtures.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runSeats, type SeatsJson, type SeatsSources } from '../src/commands/seats.ts';
import { runStatus, type StatusJson } from '../src/commands/status.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { presencePaths, presenceStatusPath } from '../src/daemon/presence/spool.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { presenceChannelHealthy } from '../src/labels/presence.ts';
import { seatState, type PresenceObservation } from '../src/labels/state.ts';
import type { Live } from '../src/status/compare.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Standing } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const SESSION = 'teamcli';
const BINDING = 'prs_0123456789ab';
const PREDECESSOR = 'prs_ba9876543210';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const TWO_DAYS_AGO = '2026-10-18T12:00:00.000Z';
const IDLE_SCREEN = readFileSync(new URL('./fixtures/claude-code/2.1.289/idle-suggestion-plain.txt', import.meta.url), 'utf8');
const WORKING_SCREEN = readFileSync(new URL('./fixtures/claude-code/2.1.302/working.txt', import.meta.url), 'utf8');
const PERMISSION_SCREEN = readFileSync(new URL('./fixtures/claude-code/2.1.289/permission-create-plain.txt', import.meta.url), 'utf8');
const QUESTION_SCREEN = readFileSync(new URL('./fixtures/claude-code/2.1.289/question-plain.txt', import.meta.url), 'utf8');

const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();

describe('the reading answers the native projection before every screen and trace', () => {
  const presence = (over: Partial<PresenceObservation> = {}): PresenceObservation => ({
    state: 'working',
    source: 'runtime-hook',
    event: 'turn-start',
    since: ago(2 * 24 * 60 * 60),
    live: true,
    ...over,
  });

  test('a two-day-old working word beats an idle prompt, a blocked dialog and a fresh trace', () => {
    const native = presence();
    for (const screen of [{ kind: 'idle' as const }, { kind: 'permission' as const }, { kind: 'question' as const }]) {
      const reading = seatState({ presence: native, screen, trace: ago(30) }, NOW);
      expect(reading).toMatchObject({
        state: 'working',
        source: 'presence',
        blind: false,
        presence: { state: 'working', event: 'turn-start', since: TWO_DAYS_AGO, live: true },
      });
    }
  });

  test('a two-day-old idle word beats a working screen and a fresh trace', () => {
    const reading = seatState(
      {
        presence: presence({ state: 'idle', event: 'turn-end' }),
        screen: { kind: 'working' },
        trace: ago(30),
      },
      NOW,
    );
    expect(reading).toMatchObject({
      state: 'idle',
      source: 'presence',
      presence: { state: 'idle', event: 'turn-end', since: TWO_DAYS_AGO, live: true },
    });
  });

  test('a removed terminal leaves the native word in charge: no screen and no trace', () => {
    for (const state of ['working', 'idle'] as const) {
      const reading = seatState(
        { presence: presence({ state, event: state === 'working' ? 'turn-start' : 'turn-end' }) },
        NOW,
      );
      expect(reading).toMatchObject({ state, source: 'presence', blind: false });
    }
  });

  test('a blocked screen and a fresh trace never answer in place of a projection', () => {
    // The projection exists, so its word is the reading event when the pane shows a dialog.
    for (const screen of [{ kind: 'permission' as const }, { kind: 'trust' as const }, { kind: 'question' as const }]) {
      expect(seatState({ presence: presence({ state: 'idle', event: 'turn-end' }), screen, trace: ago(5) }, NOW))
        .toMatchObject({ state: 'idle', source: 'presence' });
    }
  });

  test('the legacy hook keeps its day and working window only when no projection exists', () => {
    const hook = { state: 'working' as const, since: ago(30) };
    expect(seatState({ presence: presence({ state: 'idle', event: 'turn-end' }), hook }, NOW))
      .toMatchObject({ state: 'idle', source: 'presence' });
    // Without a projection the hook answers exactly as before this change.
    expect(seatState({ hook, screen: { kind: 'idle' } }, NOW))
      .toEqual({ state: 'working', source: 'cli-hook', blind: false });
  });

  test('last known is shown as itself, with its canonical provenance, never as live', () => {
    const reading = seatState(
      {
        presence: presence({
          state: 'waiting-for-a-person',
          source: 'runtime-event',
          event: 'human-wait',
          live: false,
        }),
        screen: { kind: 'working' },
        trace: ago(10),
      },
      NOW,
    );
    expect(reading).toMatchObject({
      state: 'blocked',
      source: 'presence',
      blind: false,
      presence: {
        state: 'waiting-for-a-person',
        source: 'runtime-event',
        event: 'human-wait',
        since: TWO_DAYS_AGO,
        live: false,
      },
    });
    // The mapped display word never replaces the canonical one.
    expect(reading.presence?.state).toBe('waiting-for-a-person');
    expect(reading.state).toBe('blocked');
  });

  test('a session end is done, with the canonical word kept beside the display word', () => {
    const reading = seatState(
      { presence: presence({ state: 'gone', event: 'session-end', source: 'daemon-launch' }), trace: ago(30) },
      NOW,
    );
    expect(reading).toMatchObject({
      state: 'done',
      source: 'presence',
      presence: { state: 'gone', event: 'session-end', source: 'daemon-launch' },
    });
  });

  test('an unreadable projection is unknown from presence, never a screen guess', () => {
    for (const screen of [{ kind: 'working' as const }, { kind: 'permission' as const }, { kind: 'idle' as const }]) {
      const reading = seatState({ presenceUnreadable: true, screen, trace: ago(1) }, NOW);
      expect(reading).toEqual({ state: 'unknown', source: 'presence', blind: false, presenceUnreadable: true });
    }
  });

  test('the certainties above presence still answer first', () => {
    const observed = { presence: presence({ state: 'idle', event: 'turn-end' }) };
    expect(seatState({ ...observed, held: true }, NOW)).toMatchObject({ state: 'held', source: 'hold' });
    expect(seatState({ ...observed, reachable: false }, NOW)).toMatchObject({ state: 'unreachable', source: 'herdr' });
    expect(seatState({ ...observed, present: false }, NOW)).toMatchObject({ state: 'done', source: 'process' });
  });
});

describe('a live word is proven only by a fresh route verdict for this probe', () => {
  const ROOT = '/srv/acme';
  const AT = NOW.toISOString();
  const verdict = (over: Record<string, unknown> = {}) => ({
    root: ROOT,
    presence: {
      session: SESSION, state: 'serving', healthy: true, checkedAt: AT, why: null,
      // A serving route carries its complete per-seat answer; route health is only trustworthy
      // with one.
      seats: [{
        seat: 'writer', state: 'serving', healthy: true, source: 'hook',
        binding: BINDING, appliedEventId: null, why: null,
      }],
      ...over,
    },
  });
  const reading = (
    roots: readonly { root: string; presence?: Record<string, unknown> }[],
    at = AT,
    state: 'answered' | 'refused' | 'unanswered' | 'unknown' = 'answered',
  ) => ({ roots, probe: { state, at } });

  test('a serving, healthy verdict for this route and session is proof', () => {
    expect(presenceChannelHealthy(reading([verdict()]), ROOT, SESSION, NOW)).toBe(true);
  });

  test('the 2s edge is inside the bound', () => {
    // The bound is the health grace the daemon itself uses: a snapshot this fresh is current.
    expect(presenceChannelHealthy(
      reading([verdict({ checkedAt: new Date(Date.parse(AT) - 2000).toISOString() })]), ROOT, SESSION, NOW,
    )).toBe(true);
  });

  test('one millisecond past the bound is not current', () => {
    expect(presenceChannelHealthy(
      reading([verdict({ checkedAt: new Date(Date.parse(AT) - 2001).toISOString() })]), ROOT, SESSION, NOW,
    )).toBe(false);
  });

  test('a verdict well past the bound is not current', () => {
    expect(presenceChannelHealthy(
      reading([verdict({ checkedAt: new Date(Date.parse(AT) - 2500).toISOString() })]), ROOT, SESSION, NOW,
    )).toBe(false);
  });

  test('a verdict from an earlier probe is held back, however well formed', () => {
    expect(presenceChannelHealthy(
      reading([verdict({ checkedAt: new Date(Date.parse(AT) - 10 * 60 * 1000).toISOString() })]),
      ROOT,
      SESSION,
      NOW,
    )).toBe(false);
  });

  test('pending, unhealthy, another session, another route or no verdict proves nothing', () => {
    expect(presenceChannelHealthy(reading([verdict({ state: 'pending', healthy: false, why: 'backlog' })]), ROOT, SESSION, NOW)).toBe(false);
    expect(presenceChannelHealthy(reading([verdict({ healthy: false })]), ROOT, SESSION, NOW)).toBe(false);
    expect(presenceChannelHealthy(reading([verdict({ session: 'other' })]), ROOT, SESSION, NOW)).toBe(false);
    expect(presenceChannelHealthy(reading([verdict()]), '/srv/other', SESSION, NOW)).toBe(false);
    expect(presenceChannelHealthy(reading([{ root: ROOT }]), ROOT, SESSION, NOW)).toBe(false);
    expect(presenceChannelHealthy(reading([]), ROOT, SESSION, NOW)).toBe(false);
  });

  test('a probe that did not answer, and a persisted close record, never qualify', () => {
    for (const state of ['refused', 'unanswered', 'unknown'] as const) {
      expect(presenceChannelHealthy(reading([verdict()], AT, state), ROOT, SESSION, NOW)).toBe(false);
    }
    expect(presenceChannelHealthy(
      reading([{ root: ROOT, presence: { state: 'pending', why: 'the daemon is closing' } }]),
      ROOT,
      SESSION,
      NOW,
    )).toBe(false);
  });
});

describe('team seats carries the projection, its provenance and its qualification', () => {
  let root: string;
  let agentsDir: string;
  let file: string;
  let home: string;
  let standing: Standing;
  let live: Live;
  let answer: DaemonHealth | null;
  let probes: number;

  const TEAM = `format: 1
project: acme
session: teamcli
coordinator: worker
operator: worker
identity:
  humans: [jane@acme.example]
workspace:
  mode: shared
seats:
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

  function built(): Live {
    return {
      running: true,
      agents: [
        { name: 'worker', agent: 'claude', pane: 'pane-1', workspace: 'ws-1', status: 'idle', cwd: null },
        { name: 'helper', agent: 'claude', pane: 'pane-2', workspace: 'ws-2', status: 'idle', cwd: null },
      ],
      workspaces: [
        { id: 'ws-1', label: 'claude opus 5.5' },
        { id: 'ws-2', label: 'claude opus 5.5' },
      ],
      screens: { 'pane-1': IDLE_SCREEN, 'pane-2': IDLE_SCREEN },
    };
  }

  function sources(): SeatsSources {
    return {
      live: () => live,
      branch: () => 'main',
      standing: () => standing,
      now: () => NOW,
      home,
      daemonHealth: async () => {
        probes += 1;
        if (answer === null) throw new Error('the scene staged no daemon health answer');
        return answer;
      },
    };
  }

  /** The frozen read-only answer shape the display consumes: the route by its canonical root,
   *  the probe that produced it, and for `serving` a verdict for this session. */
  function health(
    verdict: { state: 'serving' | 'pending'; healthy: boolean; checkedAt?: string; why?: string | null } | null,
    probeState: 'answered' | 'refused' | 'unanswered' | 'unknown' = 'answered',
    at = NOW.toISOString(),
  ): DaemonHealth {
    const roots = verdict === null
      ? []
      : [{
          root,
          presence: {
            session: SESSION,
            state: verdict.state,
            healthy: verdict.healthy,
            checkedAt: verdict.checkedAt ?? at,
            why: verdict.why ?? (verdict.healthy ? null : 'the presence channel is not current'),
            // A serving route carries its complete per-seat answer, and every declared seat
            // states its source class: both seats here are hook channels, fenced by the binding
            // their own state record names.
            ...(verdict.state === 'serving' && verdict.healthy
              ? {
                  seats: [
                    { seat: 'worker', state: 'serving' as const, healthy: true, source: 'hook' as const, binding: BINDING, appliedEventId: null, why: null },
                    { seat: 'helper', state: 'serving' as const, healthy: true, source: 'hook' as const, binding: 'prs_222222222222', appliedEventId: null, why: null },
                  ],
                }
              : {}),
          },
        }];
    return {
      daemon: 'teamcli',
      socket: join(home, 'daemon.sock'),
      state: 'running',
      running: true,
      pid: 4242,
      uid: 501,
      since: TWO_DAYS_AGO,
      startedBy: 'manual',
      version: '0.5.3',
      heartbeatAt: at,
      features: null,
      stuck: [],
      roots,
      probe: { state: probeState, at, ...(probeState === 'refused' ? { code: 'refused', message: 'no' } : {}) },
      why: null,
    } as unknown as DaemonHealth;
  }

  function writeProjection(seat: string, over: {
    state?: string;
    event?: string;
    source?: string;
    binding?: string;
    since?: string;
  } = {}): void {
    const paths = presencePaths(agentsDir, SESSION, seat);
    if (paths === null) throw new Error('the scene names no presence folder');
    mkdirSync(paths.root, { recursive: true });
    const since = over.since ?? TWO_DAYS_AGO;
    writeFileSync(paths.current, JSON.stringify({
      v: 1,
      seq: 7,
      id: `${since}-abcdef01`,
      state: over.state ?? 'idle',
      source: over.source ?? 'runtime-hook',
      event: over.event ?? 'turn-end',
      binding: over.binding ?? BINDING,
      since,
      observedAt: since,
    }));
  }

  function writeStatus(state: 'serving' | 'failed'): void {
    const path = presenceStatusPath(agentsDir, SESSION);
    if (path === null) throw new Error('the scene names no presence session folder');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      v: 1,
      session: SESSION,
      state,
      pid: 999,
      startedAt: TWO_DAYS_AGO,
      lastStepAt: TWO_DAYS_AGO,
      lastSuccessAt: state === 'serving' ? TWO_DAYS_AGO : null,
      heartbeatAt: TWO_DAYS_AGO,
      error: state === 'failed' ? 'the channel failed' : null,
      stoppedAt: null,
    }));
  }

  async function row(seat = 'worker'): Promise<SeatsJson['seats'][number]> {
    const io = testIo(root, { kind: 'owner' });
    const code = await runSeats(['--file', file, '--json'], io, sources());
    if (code !== 0) throw new Error(`team seats exited ${code}: ${io.err}`);
    const doc = JSON.parse(io.out) as SeatsJson;
    const found = doc.seats.find((candidate) => candidate.name === seat);
    if (found === undefined) throw new Error(`team seats printed no row for ${seat}`);
    return found;
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'b7-display-world-')));
    agentsDir = join(root, '.agents');
    mkdirSync(agentsDir);
    file = join(agentsDir, 'team.yaml');
    writeFileSync(file, TEAM);
    const checked = validateTeamFile(TEAM);
    if (!checked.ok) throw new Error('the scene team file does not validate');
    standing = verifiedOf(checked.team, TEAM, root, NOW);
    home = join(root, 'home');
    mkdirSync(home);
    live = built();
    answer = null;
    probes = 0;
    updateState(agentsDir, (state) => {
      state.sessions[SESSION] = {
        ...emptySession(),
        watch: { pid: 1, heartbeat: '2026-10-20T11:59:00Z' },
        seats: {
          worker: {
            id: 'seat_111111111111',
            pane: 'pane-1',
            workspace: 'ws-1',
            stage: 'ready',
            model: 'Claude Opus',
            version: '5.5',
            launch_line: 'claude --model claude-opus-5-5',
            presence_binding: BINDING,
          },
          helper: {
            id: 'seat_222222222222',
            pane: 'pane-2',
            workspace: 'ws-2',
            stage: 'ready',
            model: 'Claude Opus',
            version: '5.5',
            launch_line: 'claude --model claude-opus-5-5',
            presence_binding: 'prs_222222222222',
          },
        },
      };
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('one probe per pass, and a two-day working word is live over an idle prompt', async () => {
    writeProjection('worker', { state: 'working', event: 'turn-start' });
    answer = health({ state: 'serving', healthy: true });
    const reading = await row();
    expect(probes).toBe(1);
    expect(reading).toMatchObject({
      state: 'working',
      state_source: 'presence',
      presence: {
        state: 'working',
        source: 'runtime-hook',
        event: 'turn-start',
        since: TWO_DAYS_AGO,
        live: true,
      },
    });
    // The helper has no projection, so its own screen answers; the native word did not leak.
    const helper = await row('helper');
    expect(helper.presence).toBeUndefined();
  });

  test('a two-day idle word is live over a working screen', async () => {
    writeProjection('worker');
    live.screens['pane-1'] = WORKING_SCREEN;
    answer = health({ state: 'serving', healthy: true });
    expect(await row()).toMatchObject({
      state: 'idle',
      state_source: 'presence',
      presence: { state: 'idle', event: 'turn-end', since: TWO_DAYS_AGO, live: true },
    });
  });

  test('a blocked dialog never answers in place of the projection', async () => {
    writeProjection('worker', { state: 'working', event: 'turn-start' });
    live.screens['pane-1'] = PERMISSION_SCREEN;
    answer = health({ state: 'serving', healthy: true });
    expect(await row()).toMatchObject({
      state: 'working',
      state_source: 'presence',
      presence: { state: 'working', live: true },
    });
  });

  test('with no terminal screen read, the native word still governs', async () => {
    writeProjection('worker', { state: 'idle', event: 'turn-end' });
    delete live.screens['pane-1'];
    answer = health({ state: 'serving', healthy: true });
    expect(await row()).toMatchObject({
      state: 'idle',
      state_source: 'presence',
      presence: { state: 'idle', event: 'turn-end', live: true },
    });
  });

  test('a question screen does not override a two-day word either', async () => {
    writeProjection('worker', { state: 'working', event: 'turn-start' });
    live.screens['pane-1'] = QUESTION_SCREEN;
    answer = health({ state: 'serving', healthy: true });
    expect(await row()).toMatchObject({ state: 'working', state_source: 'presence' });
  });

  test('an unhealthy channel keeps the word and its provenance as last known', async () => {
    writeProjection('worker', { state: 'working', source: 'runtime-event', event: 'turn-start' });
    live.screens['pane-1'] = WORKING_SCREEN;
    answer = health({ state: 'pending', healthy: false, why: 'the presence channel still has a backlog' });
    expect(await row()).toMatchObject({
      state: 'working',
      state_source: 'presence',
      presence: {
        state: 'working',
        source: 'runtime-event',
        event: 'turn-start',
        since: TWO_DAYS_AGO,
        live: false,
      },
    });
  });

  test('the persisted status word is never the proof: failed says nothing, serving says nothing', async () => {
    writeProjection('worker', { state: 'idle', event: 'turn-end' });
    // A stale status record says the channel failed; the fresh route verdict says serving.
    writeStatus('failed');
    answer = health({ state: 'serving', healthy: true });
    expect((await row()).presence).toMatchObject({ live: true });
    // The reverse: the status record says serving, the fresh route verdict says pending.
    writeStatus('serving');
    answer = health({ state: 'pending', healthy: false });
    expect((await row()).presence).toMatchObject({ live: false });
  });

  test('a canonical wait and session end map to blocked and done with their words kept', async () => {
    writeProjection('worker', { state: 'waiting-for-a-person', event: 'human-wait', source: 'runtime-event' });
    answer = health({ state: 'serving', healthy: true });
    expect(await row()).toMatchObject({
      state: 'blocked',
      state_source: 'presence',
      presence: { state: 'waiting-for-a-person', event: 'human-wait', source: 'runtime-event' },
    });
    writeProjection('worker', { state: 'gone', event: 'session-end', source: 'daemon-launch' });
    expect(await row()).toMatchObject({
      state: 'done',
      state_source: 'presence',
      presence: { state: 'gone', event: 'session-end', source: 'daemon-launch' },
    });
  });

  test('a projection this build cannot read is unknown from presence, not a screen', async () => {
    const paths = presencePaths(agentsDir, SESSION, 'worker');
    if (paths === null) throw new Error('the scene names no presence folder');
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.current, '{not json');
    live.screens['pane-1'] = WORKING_SCREEN;
    answer = health({ state: 'serving', healthy: true });
    expect(await row()).toMatchObject({
      state: 'unknown',
      state_source: 'presence',
      presence_unreadable: true,
    });
  });

  test('status JSON carries the same canonical word, source, event and instant', async () => {
    writeProjection('worker', { state: 'waiting-for-a-person', event: 'human-wait', source: 'runtime-event' });
    answer = health({ state: 'serving', healthy: true });
    const io = testIo(root, { kind: 'owner' });
    const code = await runStatus(['--file', file, '--json'], io, sources());
    if (code !== 0) throw new Error(`team status exited ${code}: ${io.err}`);
    expect(code).toBe(0);
    const doc = JSON.parse(io.out) as StatusJson;
    // The published schema declares these fields on a row, so the assertions read the public
    // StatusJson row type directly; the reading they carry is the same PresenceObservation
    // `team seats` prints.
    const found = doc.rows.find((candidate) => candidate.name === 'worker');
    expect(found).toMatchObject({
      seat_state: 'blocked',
      seat_state_source: 'presence',
      seat_presence: {
        state: 'waiting-for-a-person',
        source: 'runtime-event',
        event: 'human-wait',
        since: TWO_DAYS_AGO,
        live: true,
      },
    });
  });

  test('a mismatched binding is not this seat’s current reading and not a screen fallback', async () => {
    writeProjection('worker', { state: 'working', event: 'turn-start', binding: PREDECESSOR });
    live.screens['pane-1'] = IDLE_SCREEN;
    answer = health({ state: 'serving', healthy: true });
    const reading = await row();
    // The projection exists, so the idle prompt is not allowed to answer in its place; no
    // current word is claimed from a predecessor's file.
    expect(reading.state_source).toBe('presence');
    expect(reading.state).not.toBe('idle');
    expect(reading.presence?.live ?? false).toBe(false);
  });

  test('a recorded state with no binding cannot open the projection and cannot fall back', async () => {
    writeProjection('worker', { state: 'working', event: 'turn-start' });
    updateState(agentsDir, (state) => {
      const seat = state.sessions[SESSION]?.seats.worker;
      if (seat === undefined) throw new Error('the scene lost its seat record');
      delete seat.presence_binding;
    });
    live.screens['pane-1'] = IDLE_SCREEN;
    answer = health({ state: 'serving', healthy: true });
    const reading = await row();
    expect(reading.state_source).toBe('presence');
    expect(reading.state).not.toBe('idle');
    expect(reading.presence?.live ?? false).toBe(false);
  });
});
