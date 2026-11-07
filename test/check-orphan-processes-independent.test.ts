import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import {
  closeOrphans,
  orphanReading,
  type OrphanCandidate,
  type OrphanCloseSources,
  type OrphanProcessEntry,
  type OrphanProcessSources,
} from '../src/check/orphans.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { emptySession, updateState, type SessionState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { deliverBriefs, testIo } from './helpers.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NOW = new Date('2026-11-04T12:00:00Z');
const DAEMON_SINCE = new Date('2026-11-04T10:00:00Z').toISOString();
const STARTED_AT = new Date('2026-11-04T10:30:00Z');
const STARTED_MS = STARTED_AT.getTime();
const ROOT = '/workspace/acme';

function procRow(pid: number, comm: string, startedAt: Date = STARTED_AT): OrphanProcessEntry {
  return { pid, comm, startedAtMs: startedAt.getTime() };
}

function makeSources(overrides: {
  table?: OrphanProcessEntry[] | null;
  folders?: Map<number, string | null> | null;
  ancestors?: (pid: number) => readonly number[] | null;
  own?: readonly number[];
} = {}): OrphanProcessSources {
  return {
    table: () => (overrides.table === undefined ? [] : overrides.table),
    foldersOf: () => (overrides.folders === undefined ? new Map() : overrides.folders),
    ancestorsOf: (pid) => (overrides.ancestors ? overrides.ancestors(pid) : null),
    own: () => overrides.own ?? [],
  };
}

const TEAM_YAML = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: codex
    vendor: openai
    model: GPT
    version: "5"
    launch: codex
    leads: true

  - role: implementer
    name: dev-one
    cli: codex
    vendor: openai
    model: GPT
    version: "5"
    launch: codex

  - role: implementer
    name: dev-two
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

function makeTeamCheckout(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-orphan-ind-')));
  tempDirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = { ...process.env };
  delete env.GIT_DIR;
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', env });
  writeFileSync(join(root, '.agents/team.yaml'), TEAM_YAML);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = {
      stage: 'ready',
      pane: 'pane-lead',
      workspace: 'w',
      launched: { shell: 100, cli: [101] },
    };
    session.seats['dev-one'] = {
      stage: 'ready',
      pane: 'pane-one',
      workspace: 'w',
      launched: { shell: 200, cli: [201] },
    };
    session.seats['dev-two'] = {
      stage: 'ready',
      pane: 'pane-two',
      workspace: 'w',
      launched: { shell: 300, cli: [301] },
    };
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
  });
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: 'acme',
    seats: ['lead', 'dev-one', 'dev-two'],
    home,
    at: NOW.toISOString(),
  });
  return { root, home };
}

describe('independent test: feat/check-orphan-processes (0d2b775c3)', () => {
  test('1. a recorded launch whose pane is gone is named', () => {
    // Case 1a: The seat's recorded pane ('pane-gone') is no longer in the session at all,
    // while another pane ('pane-lead') is alive in the session, and the CLI's ancestor chain
    // ([201, 1]) no longer includes its recorded launch shell (200).
    const stateGonePane: SessionState = {
      ...emptySession(),
      seats: {
        lead: { stage: 'ready', pane: 'pane-lead', launched: { shell: 100, cli: [101] } },
        'dev-one': { stage: 'ready', pane: 'pane-gone', launched: { shell: 200, cli: [201] } },
      },
    };
    const liveOnePane: Live = {
      running: true,
      agents: [
        { name: 'lead', agent: 'codex', pane: 'pane-lead', workspace: 'w', status: 'idle', cwd: null },
      ],
      workspaces: [{ id: 'w', label: 'team' }],
      screens: {},
      processes: {
        'pane-lead': { shell: 100, foreground: [100, 101] },
      },
    };

    const resGonePane = orphanReading({
      project: 'acme',
      root: ROOT,
      session: 'acme',
      state: stateGonePane,
      live: liveOnePane,
      now: NOW,
      daemonSince: DAEMON_SINCE,
      sources: makeSources({
        table: [
          procRow(101, '/usr/local/bin/codex'),
          procRow(201, '/usr/local/bin/codex'),
        ],
        ancestors: (pid) => (pid === 201 ? [201, 1] : [pid, 1]),
      }),
    });

    expect(resGonePane.unread).toBe(false);
    expect(resGonePane.notes).toEqual([]);
    expect(resGonePane.candidates).toEqual([
      {
        pid: 201,
        comm: '/usr/local/bin/codex',
        startedAtMs: STARTED_MS,
        cli: 'codex',
        seat: 'dev-one',
        recorded: true,
        closeable: true,
        shell: 200,
      },
    ]);
    expect(resGonePane.differences).toEqual([
      {
        what: 'pid 201: a live codex process with no pane in session "acme" (started 1h ago; last team acme, seat dev-one)',
        repair: 'close it through the team (team check --close-orphans)',
        who: "the team's lead",
      },
    ]);

    // Case 1b: The pane still exists in `live.processes`, but holds only its shell (200) while
    // the recorded CLI (201) is running detached outside the pane.
    const liveShellOnly: Live = {
      running: true,
      agents: [
        { name: 'lead', agent: 'codex', pane: 'pane-lead', workspace: 'w', status: 'idle', cwd: null },
        { name: 'dev-one', agent: 'codex', pane: 'pane-gone', workspace: 'w', status: 'idle', cwd: null },
      ],
      workspaces: [{ id: 'w', label: 'team' }],
      screens: {},
      processes: {
        'pane-lead': { shell: 100, foreground: [100, 101] },
        'pane-gone': { shell: 200, foreground: [200] },
      },
    };
    const resDetached = orphanReading({
      project: 'acme',
      root: ROOT,
      session: 'acme',
      state: stateGonePane,
      live: liveShellOnly,
      now: NOW,
      daemonSince: DAEMON_SINCE,
      sources: makeSources({
        table: [procRow(101, 'codex'), procRow(201, 'codex')],
      }),
    });
    expect(resDetached.candidates).toHaveLength(1);
    expect(resDetached.candidates[0]).toMatchObject({
      pid: 201,
      cli: 'codex',
      seat: 'dev-one',
      recorded: true,
      closeable: true,
    });

    // Case 1c: End-to-end `runTeamCheck` prints the orphan difference row when `dev-one`'s pane is gone.
    const { root, home } = makeTeamCheckout();
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({}, io, {
      live: () => ({
        running: true,
        agents: [
          { name: 'lead', agent: 'codex', pane: 'pane-lead', workspace: 'w', status: 'idle', cwd: null },
          { name: 'dev-two', agent: 'claude', pane: 'pane-two', workspace: 'w', status: 'idle', cwd: null },
        ],
        workspaces: [{ id: 'w', label: 'team' }],
        screens: {},
        processes: {
          'pane-lead': { shell: 100, foreground: [100, 101] },
          'pane-two': { shell: 300, foreground: [300, 301] },
        },
      }),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
      orphans: makeSources({
        table: [procRow(101, 'codex'), procRow(201, 'codex'), procRow(301, 'claude')],
        ancestors: (pid) => (pid === 201 ? [201, 1] : [pid, 1]),
      }),
    });
    expect(code).toBe(1);
    expect(io.out).toContain(
      'difference: pid 201: a live codex process with no pane in session "acme" (started 1h ago; last team acme, seat dev-one)',
    );
    expect(io.out).toContain('close it through the team (team check --close-orphans)');
  });

  test('2. a process a pane holds is not named', () => {
    const state: SessionState = {
      ...emptySession(),
      seats: {
        lead: { stage: 'ready', pane: 'pane-lead', launched: { shell: 100, cli: [101] } },
        'dev-one': { stage: 'ready', pane: 'pane-one', launched: { shell: 200, cli: [201] } },
        'dev-two': { stage: 'ready', pane: 'pane-two', launched: { shell: 300, cli: [301] } },
      },
    };
    // `pane-lead` holds 101; `pane-one` holds 201 and also holds an unrecorded CLI 401 in its foreground;
    // `pane-two` could not be read (`null`), but 301's ancestor chain still includes its launch shell 300.
    const live: Live = {
      running: true,
      agents: [
        { name: 'lead', agent: 'codex', pane: 'pane-lead', workspace: 'w', status: 'idle', cwd: null },
        { name: 'dev-one', agent: 'codex', pane: 'pane-one', workspace: 'w', status: 'idle', cwd: null },
        { name: 'dev-two', agent: 'claude', pane: 'pane-two', workspace: 'w', status: 'idle', cwd: null },
      ],
      workspaces: [{ id: 'w', label: 'team' }],
      screens: {},
      processes: {
        'pane-lead': { shell: 100, foreground: [100, 101] },
        'pane-one': { shell: 200, foreground: [200, 201, 401] },
        'pane-two': null,
      },
    };

    const reading = orphanReading({
      project: 'acme',
      root: ROOT,
      session: 'acme',
      state,
      live,
      now: NOW,
      daemonSince: DAEMON_SINCE,
      sources: makeSources({
        table: [
          procRow(101, 'codex'),
          procRow(201, 'codex'),
          procRow(301, 'claude'),
          procRow(401, 'gemini'),
          procRow(501, 'cursor-agent'),
        ],
        folders: new Map([
          [401, ROOT],
          [501, ROOT],
        ]),
        // 301 is still under its launch shell 300, so it is still inside its pane.
        ancestors: (pid) => (pid === 301 ? [301, 300, 1] : [pid, 1]),
        // 501 is in `own` (the check's own ancestry), so it is never named either.
        own: [501],
      }),
    });

    expect(reading.candidates).toEqual([]);
    expect(reading.differences).toEqual([]);
  });

  test("3. another team's process is not named or closed", () => {
    const state: SessionState = {
      ...emptySession(),
      seats: {
        lead: { stage: 'ready', pane: 'pane-lead', launched: { shell: 100, cli: [101] } },
      },
    };
    const live: Live = {
      running: true,
      agents: [
        { name: 'lead', agent: 'codex', pane: 'pane-lead', workspace: 'w', status: 'idle', cwd: null },
      ],
      workspaces: [{ id: 'w', label: 'team' }],
      screens: {},
      processes: {
        'pane-lead': { shell: 100, foreground: [100, 101] },
      },
    };

    // Processes in another team's root (`/workspace/beta`), a prefix-colliding sibling root
    // (`/workspace/acme-other`), or the parent directory (`/workspace`) must NOT be named,
    // whereas a process inside `/workspace/acme/sub` IS named.
    const reading = orphanReading({
      project: 'acme',
      root: ROOT,
      session: 'acme',
      state,
      live,
      now: NOW,
      daemonSince: DAEMON_SINCE,
      sources: makeSources({
        table: [
          procRow(101, 'codex'),
          procRow(601, 'claude'),
          procRow(602, 'codex'),
          procRow(603, 'gemini'),
          procRow(604, 'agy'),
        ],
        folders: new Map<number, string | null>([
          [601, '/workspace/beta'],
          [602, '/workspace/acme-other'],
          [603, '/workspace'],
          [604, `${ROOT}/packages/core`],
        ]),
      }),
    });

    expect(reading.candidates.map((c) => c.pid)).toEqual([604]);
    expect(reading.candidates[0]).toMatchObject({
      pid: 604,
      cli: 'antigravity',
      seat: null,
      recorded: false,
      closeable: true,
    });
    expect(reading.differences).toEqual([
      {
        what: 'pid 604: a live antigravity process with no pane in session "acme" (started 1h ago; last team acme, no seat record)',
        repair: 'close it through the team (team check --close-orphans)',
        who: "the team's lead",
      },
    ]);

    // Furthermore, during `closeOrphans`, if another team's session holds the pid in one of its
    // panes (`heldElsewhere` contains the pid), `closeOrphans` refuses to signal it.
    const signals: { pid: number; signal: 'terminate' | 'kill' }[] = [];
    const closeRes = closeOrphans({
      candidates: reading.candidates,
      session: 'acme',
      confirm: () => true,
      sources: {
        alive: () => true,
        commOf: () => 'agy',
        startOf: () => STARTED_MS,
        ancestorsOf: () => [604, 1],
        heldElsewhere: () => new Set([604]),
        heldHere: () => new Set(),
        signal: (pid, signal) => {
          signals.push({ pid, signal });
          return true;
        },
        pause: () => {},
      },
    });
    expect(signals).toEqual([]);
    expect(closeRes).toEqual({
      closed: 0,
      lines: ["left: pid 604: another session's pane holds it"],
    });
  });

  test('4. an unreadable pane list gives no rows and no close', () => {
    const state: SessionState = {
      ...emptySession(),
      seats: {
        lead: { stage: 'ready', pane: 'pane-lead', launched: { shell: 100, cli: [101] } },
        'dev-one': { stage: 'ready', pane: 'pane-one', launched: { shell: 200, cli: [201] } },
      },
    };

    // 4a. Session is running, but `live.agents` is empty while 2 seats are recorded.
    const emptyAgents = orphanReading({
      project: 'acme',
      root: ROOT,
      session: 'acme',
      state,
      live: { running: true, agents: [], workspaces: [], screens: {} },
      now: NOW,
      daemonSince: DAEMON_SINCE,
      sources: makeSources({
        table: [procRow(101, 'codex'), procRow(201, 'codex')],
        ancestors: (pid) => [pid, 1],
      }),
    });
    expect(emptyAgents.differences).toEqual([]);
    expect(emptyAgents.candidates).toEqual([]);
    expect(emptyAgents.unread).toBe(true);
    expect(emptyAgents.notes).toEqual([
      "the session's pane list reads no agents while the state records 2 seats; no orphan processes are named",
    ]);

    // 4b. Session is not running while seats are recorded.
    const notRunning = orphanReading({
      project: 'acme',
      root: ROOT,
      session: 'acme',
      state,
      live: { running: false, agents: [], workspaces: [], screens: {} },
      now: NOW,
      daemonSince: DAEMON_SINCE,
      sources: makeSources({
        table: [procRow(101, 'codex'), procRow(201, 'codex')],
        ancestors: (pid) => [pid, 1],
      }),
    });
    expect(notRunning.differences).toEqual([]);
    expect(notRunning.candidates).toEqual([]);
    expect(notRunning.unread).toBe(true);
    expect(notRunning.notes).toEqual(['session "acme" is not running; no processes are compared']);

    // 4c. End-to-end `runTeamCheck({ closeOrphans: true })` when the pane list reads no agents:
    // prints no orphan rows, asks no confirmation question, and sends no signals.
    const { root, home } = makeTeamCheckout();
    const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    io.stdinIsTTY = true;
    let prompted = false;
    io.stdin = () => {
      prompted = true;
      return 'y\n';
    };
    const signals: { pid: number; signal: 'terminate' | 'kill' }[] = [];
    const code = runTeamCheck({ closeOrphans: true }, io, {
      live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
      orphans: makeSources({
        table: [procRow(101, 'codex'), procRow(201, 'codex'), procRow(301, 'claude')],
        ancestors: (pid) => [pid, 1],
      }),
      closeOrphans: {
        alive: () => true,
        commOf: () => 'codex',
        startOf: () => STARTED_MS,
        ancestorsOf: () => [201, 1],
        heldElsewhere: () => new Set(),
        heldHere: () => new Set(),
        signal: (pid, signal) => {
          signals.push({ pid, signal });
          return true;
        },
        pause: () => {},
      },
    });
    expect(code).toBe(1);
    expect(prompted).toBe(false);
    expect(signals).toEqual([]);
    expect(io.out).not.toContain('pid 201:');
    expect(io.out).toContain(
      "note: the session's pane list reads no agents while the state records 3 seats; no orphan processes are named",
    );

    // 4d. When the terminal host itself cannot answer (`live() === null`), `runTeamCheck` exits 2
    // without prompting or signalling.
    const ioUnreachable = testIo(root, {
      kind: 'seat',
      name: 'lead',
      pane: 'pane-lead',
      session: 'acme',
    });
    ioUnreachable.stdinIsTTY = true;
    const codeUnreachable = runTeamCheck({ closeOrphans: true }, ioUnreachable, {
      live: () => null,
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
      orphans: makeSources({ table: [procRow(201, 'codex')] }),
      closeOrphans: {
        alive: () => true,
        commOf: () => 'codex',
        startOf: () => STARTED_MS,
        ancestorsOf: () => [201, 1],
        heldElsewhere: () => new Set(),
        heldHere: () => new Set(),
        signal: (pid, signal) => {
          signals.push({ pid, signal });
          return true;
        },
        pause: () => {},
      },
    });
    expect(codeUnreachable).toBe(2);
    expect(signals).toEqual([]);
  });

  test('5. a plain seat cannot close (while still seeing the orphan row on bare check)', () => {
    const { root, home } = makeTeamCheckout();
    const plainCaller: Caller = {
      kind: 'seat',
      name: 'dev-two',
      pane: 'pane-two',
      session: 'acme',
    };
    const live: Live = {
      running: true,
      agents: [
        { name: 'lead', agent: 'codex', pane: 'pane-lead', workspace: 'w', status: 'idle', cwd: null },
        { name: 'dev-two', agent: 'claude', pane: 'pane-two', workspace: 'w', status: 'idle', cwd: null },
      ],
      workspaces: [{ id: 'w', label: 'team' }],
      screens: {},
      processes: {
        'pane-lead': { shell: 100, foreground: [100, 101] },
        'pane-two': { shell: 300, foreground: [300, 301] },
      },
    };
    const signals: { pid: number; signal: 'terminate' | 'kill' }[] = [];
    let prompted = false;

    const ioClose = testIo(root, plainCaller);
    ioClose.stdinIsTTY = true;
    ioClose.stdin = () => {
      prompted = true;
      return 'y\n';
    };

    const closeCode = runTeamCheck({ closeOrphans: true }, ioClose, {
      live: () => live,
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
      orphans: makeSources({
        table: [procRow(101, 'codex'), procRow(201, 'codex'), procRow(301, 'claude')],
        ancestors: (pid) => [pid, 1],
      }),
      closeOrphans: {
        alive: () => true,
        commOf: () => 'codex',
        startOf: () => STARTED_MS,
        ancestorsOf: () => [201, 1],
        heldElsewhere: () => new Set(),
        heldHere: () => new Set(),
        signal: (pid, signal) => {
          signals.push({ pid, signal });
          return true;
        },
        pause: () => {},
      },
    });

    expect(closeCode).toBe(1);
    expect(prompted).toBe(false);
    expect(signals).toEqual([]);
    expect(ioClose.err).toBe("team check: --close-orphans is the team's lead's or the owner's\n");
    expect(ioClose.out).toBe('');

    // Bare `runTeamCheck` by the same plain seat still sees the orphan difference row.
    const ioRead = testIo(root, plainCaller);
    const readCode = runTeamCheck({}, ioRead, {
      live: () => live,
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
      orphans: makeSources({
        table: [procRow(101, 'codex'), procRow(201, 'codex'), procRow(301, 'claude')],
        ancestors: (pid) => [pid, 1],
      }),
    });
    expect(readCode).toBe(1);
    expect(ioRead.out).toContain(
      'difference: pid 201: a live codex process with no pane in session "acme" (started 1h ago; last team acme, seat dev-one)',
    );
  });

  test('6. the lead closes after y, a changed start time is skipped, and a pane that picks up the process while the question is open stops the signal', () => {
    const { root, home } = makeTeamCheckout();
    const leadCaller: Caller = {
      kind: 'seat',
      name: 'lead',
      pane: 'pane-lead',
      session: 'acme',
    };
    const io = testIo(root, leadCaller);
    io.stdinIsTTY = true;

    // Both `dev-one` (pid 201, codex) and `dev-two` (pid 301, claude) lost their panes, and
    // a third recorded launch (`dev-three`, pid 401, codex) also lost its pane before the question.
    // While the confirmation question is open (`io.stdin`):
    // - pid 201 keeps its start time (`STARTED_MS`) and is not picked up by any pane -> closed!
    // - pid 301 has its start time move to `STARTED_MS + 2001` (> `SAME_START_MS = 2000`) -> skipped!
    // - pid 401 is picked up by a pane of this session (`heldHereNow.add(401)`) -> skipped!
    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['dev-three'] = {
        stage: 'ready',
        pane: 'pane-three',
        workspace: 'w',
        launched: { shell: 400, cli: [401] },
      };
    });
    let pid201Alive = true;
    const pid301StartAtClose = STARTED_MS + 2001;
    const heldHereNow = new Set<number>([100, 101]);
    const signals: { pid: number; signal: 'terminate' | 'kill' }[] = [];

    io.stdin = () => {
      // While the prompt waits for the lead's answer, a pane of this session picks up pid 401.
      heldHereNow.add(401);
      return 'y\n';
    };

    const live: Live = {
      running: true,
      agents: [
        { name: 'lead', agent: 'codex', pane: 'pane-lead', workspace: 'w', status: 'idle', cwd: null },
      ],
      workspaces: [{ id: 'w', label: 'team' }],
      screens: {},
      processes: {
        'pane-lead': { shell: 100, foreground: [100, 101] },
      },
    };

    const code = runTeamCheck({ closeOrphans: true }, io, {
      live: () => live,
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
      orphans: {
        table: () => [
          procRow(101, 'codex'),
          ...(pid201Alive ? [procRow(201, 'codex', STARTED_AT)] : []),
          procRow(301, 'claude', STARTED_AT),
          procRow(401, 'codex', STARTED_AT),
        ],
        foldersOf: () => new Map(),
        ancestorsOf: (pid) => [pid, 1],
        own: () => [],
      },
      closeOrphans: {
        alive: (pid) => (pid === 201 ? pid201Alive : true),
        commOf: (pid) => (pid === 301 ? 'claude' : pid === 201 && !pid201Alive ? null : 'codex'),
        startOf: (pid) => (pid === 301 ? pid301StartAtClose : STARTED_MS),
        ancestorsOf: (pid) => [pid, 1],
        heldElsewhere: () => new Set(),
        heldHere: () => heldHereNow,
        signal: (pid, signal) => {
          signals.push({ pid, signal });
          if (pid === 201) pid201Alive = false;
          return true;
        },
        pause: () => {},
      },
    });

    expect(code).toBe(1);
    expect(io.out).toContain('team check: close 3 orphan processes? [y/N] ');
    expect(io.out).toContain('closed: pid 201: codex (seat dev-one)');
    expect(io.out).toContain('left: pid 301: it is not the process the check saw');
    expect(io.out).toContain('left: pid 401: a pane of this session holds it');
    // Only pid 201 was signalled; pid 301 (changed start time) and pid 401 (picked up by a pane
    // while the question was open) received zero signals.
    expect(signals).toEqual([{ pid: 201, signal: 'terminate' }]);
    expect(pid201Alive).toBe(false);
    expect(io.out).not.toContain('difference: pid 201:');
    expect(io.out).toContain('difference: pid 301:');

    // Also verify a folder-found candidate (`seat: null, recorded: false, shell: null`) picked up
    // by a pane of this session while `confirm` is open gets no signal.
    const folderHere = new Set<number>();
    const folderPickupSignals: { pid: number; signal: 'terminate' | 'kill' }[] = [];
    const folderPickupOut = closeOrphans({
      candidates: [
        {
          pid: 555,
          comm: 'codex',
          startedAtMs: STARTED_MS,
          cli: 'codex',
          seat: null,
          recorded: false,
          closeable: true,
          shell: null,
        },
      ],
      session: 'acme',
      confirm: () => {
        folderHere.add(555);
        return true;
      },
      sources: {
        alive: () => true,
        commOf: () => 'codex',
        startOf: () => STARTED_MS,
        ancestorsOf: () => [555, 1],
        heldElsewhere: () => new Set(),
        heldHere: () => folderHere,
        signal: (pid, signal) => {
          folderPickupSignals.push({ pid, signal });
          return true;
        },
        pause: () => {},
      },
    });
    expect(folderPickupSignals).toEqual([]);
    expect(folderPickupOut).toEqual({
      closed: 0,
      lines: ['left: pid 555: a pane of this session holds it'],
    });

    // Also verify an earlier start time shift (> 2000 ms), a null start time, and an unreadable
    // `heldHere` (`null`) are skipped before any signal, whereas a start time within the 2000 ms
    // clock resolution tolerance (`STARTED_MS + 2000`) closes.
    const directSignals: { pid: number; signal: 'terminate' | 'kill' }[] = [];
    const aliveSet = new Set([701, 702, 703]);
    const candidates: OrphanCandidate[] = [
      {
        pid: 701,
        comm: 'codex',
        startedAtMs: STARTED_MS,
        cli: 'codex',
        seat: 'dev-one',
        recorded: true,
        closeable: true,
        shell: 200,
      },
      {
        pid: 702,
        comm: 'codex',
        startedAtMs: STARTED_MS,
        cli: 'codex',
        seat: 'dev-two',
        recorded: true,
        closeable: true,
        shell: 300,
      },
      {
        pid: 703,
        comm: 'codex',
        startedAtMs: STARTED_MS,
        cli: 'codex',
        seat: 'dev-three',
        recorded: true,
        closeable: true,
        shell: 400,
      },
    ];
    const directOut = closeOrphans({
      candidates,
      session: 'acme',
      confirm: () => true,
      sources: {
        alive: (pid) => aliveSet.has(pid),
        commOf: () => 'codex',
        startOf: (pid) => {
          if (pid === 701) return STARTED_MS - 2001;
          if (pid === 702) return null;
          return STARTED_MS + 2000;
        },
        ancestorsOf: (pid) => [pid, 1],
        heldElsewhere: () => new Set(),
        heldHere: () => new Set(),
        signal: (pid, signal) => {
          directSignals.push({ pid, signal });
          aliveSet.delete(pid);
          return true;
        },
        pause: () => {},
      },
    });
    expect(directSignals).toEqual([{ pid: 703, signal: 'terminate' }]);
    expect(directOut).toEqual({
      closed: 1,
      lines: [
        'left: pid 701: it is not the process the check saw',
        'left: pid 702: it is not the process the check saw',
        'closed: pid 703: codex (seat dev-three)',
      ],
    });

    // If `heldHere` returns `null` when re-reading this session's panes right before the signal,
    // no signal is sent.
    const unreadableHereSignals: { pid: number; signal: 'terminate' | 'kill' }[] = [];
    const unreadableHereOut = closeOrphans({
      candidates: [candidates[0]!],
      session: 'acme',
      confirm: () => true,
      sources: {
        alive: () => true,
        commOf: () => 'codex',
        startOf: () => STARTED_MS,
        ancestorsOf: (pid) => [pid, 1],
        heldElsewhere: () => new Set(),
        heldHere: () => null,
        signal: (pid, signal) => {
          unreadableHereSignals.push({ pid, signal });
          return true;
        },
        pause: () => {},
      },
    });
    expect(unreadableHereSignals).toEqual([]);
    expect(unreadableHereOut).toEqual({
      closed: 0,
      lines: ["left: pid 701: this session's panes could not be read"],
    });
  });

  test('7. SIGKILL is sent only after the full 2000 ms terminate grace, and a pid reused or picked up by a pane during the grace is not killed', () => {
    const baseCandidate: OrphanCandidate = {
      pid: 201,
      comm: 'codex',
      startedAtMs: STARTED_MS,
      cli: 'codex',
      seat: 'dev-one',
      recorded: true,
      closeable: true,
      shell: 200,
    };

    // 7a. Process exits during the 2000 ms grace (after 600 ms of pause steps):
    // SIGKILL is never sent.
    {
      let elapsedMs = 0;
      let alive = true;
      const events: { atMs: number; signal: 'terminate' | 'kill' }[] = [];
      const sources: OrphanCloseSources = {
        alive: () => alive,
        commOf: () => 'codex',
        startOf: () => STARTED_MS,
        ancestorsOf: () => [201, 1],
        heldElsewhere: () => new Set(),
        heldHere: () => new Set(),
        signal: (_pid, signal) => {
          events.push({ atMs: elapsedMs, signal });
          return true;
        },
        pause: (ms) => {
          elapsedMs += ms;
          if (elapsedMs >= 600) alive = false;
        },
      };
      const res = closeOrphans({
        candidates: [baseCandidate],
        session: 'acme',
        sources,
        confirm: () => true,
      });
      expect(events).toEqual([{ atMs: 0, signal: 'terminate' }]);
      expect(elapsedMs).toBe(600);
      expect(res).toEqual({
        closed: 1,
        lines: ['closed: pid 201: codex (seat dev-one)'],
      });
    }

    // 7b. Process exits right at the 2000 ms grace boundary (on the 20th 100 ms step):
    // SIGKILL is still NOT sent.
    {
      let elapsedMs = 0;
      let alive = true;
      const events: { atMs: number; signal: 'terminate' | 'kill' }[] = [];
      const sources: OrphanCloseSources = {
        alive: () => alive,
        commOf: () => 'codex',
        startOf: () => STARTED_MS,
        ancestorsOf: () => [201, 1],
        heldElsewhere: () => new Set(),
        heldHere: () => new Set(),
        signal: (_pid, signal) => {
          events.push({ atMs: elapsedMs, signal });
          return true;
        },
        pause: (ms) => {
          elapsedMs += ms;
          if (elapsedMs >= 2000) alive = false;
        },
      };
      const res = closeOrphans({
        candidates: [baseCandidate],
        session: 'acme',
        sources,
        confirm: () => true,
      });
      expect(events).toEqual([{ atMs: 0, signal: 'terminate' }]);
      expect(elapsedMs).toBe(2000);
      expect(res).toEqual({
        closed: 1,
        lines: ['closed: pid 201: codex (seat dev-one)'],
      });
    }

    // 7c. Process ignores terminate across the full 2000 ms grace, then stops 300 ms after kill:
    // `kill` (SIGKILL) is sent at exactly `elapsedMs === 2000` (after 20 x 100 ms steps), never earlier.
    {
      let elapsedMs = 0;
      let alive = true;
      let killSent = false;
      const pauses: number[] = [];
      const events: { atMs: number; signal: 'terminate' | 'kill' }[] = [];
      const sources: OrphanCloseSources = {
        alive: () => alive,
        commOf: () => 'codex',
        startOf: () => STARTED_MS,
        ancestorsOf: () => [201, 1],
        heldElsewhere: () => new Set(),
        heldHere: () => new Set(),
        signal: (_pid, signal) => {
          events.push({ atMs: elapsedMs, signal });
          if (signal === 'kill') killSent = true;
          return true;
        },
        pause: (ms) => {
          pauses.push(ms);
          elapsedMs += ms;
          if (killSent && elapsedMs >= 2300) alive = false;
        },
      };
      const res = closeOrphans({
        candidates: [baseCandidate],
        session: 'acme',
        sources,
        confirm: () => true,
      });
      expect(events).toEqual([
        { atMs: 0, signal: 'terminate' },
        { atMs: 2000, signal: 'kill' },
      ]);
      expect(pauses.slice(0, 20)).toEqual(Array(20).fill(100));
      expect(elapsedMs).toBe(2300);
      expect(res).toEqual({
        closed: 1,
        lines: ['forced: pid 201: codex (seat dev-one)'],
      });
    }

    // 7d. Pid reused during the 2000 ms terminate grace (process name changes to 'node' or start
    // time moves past 2000 ms, or a pane of this session picks the pid up during the grace):
    // SIGKILL is NOT sent after the grace.
    {
      // Reused by a different program ('node') during the grace:
      let elapsedMs = 0;
      let comm = 'codex';
      const events: { atMs: number; signal: 'terminate' | 'kill' }[] = [];
      const resRenamed = closeOrphans({
        candidates: [baseCandidate],
        session: 'acme',
        confirm: () => true,
        sources: {
          alive: () => true,
          commOf: () => comm,
          startOf: () => STARTED_MS,
          ancestorsOf: () => [201, 1],
          heldElsewhere: () => new Set(),
          heldHere: () => new Set(),
          signal: (_pid, signal) => {
            events.push({ atMs: elapsedMs, signal });
            return true;
          },
          pause: (ms) => {
            elapsedMs += ms;
            if (elapsedMs === 500) comm = 'node';
          },
        },
      });
      expect(events).toEqual([{ atMs: 0, signal: 'terminate' }]);
      expect(elapsedMs).toBe(2000);
      expect(resRenamed).toEqual({
        closed: 0,
        lines: ['left: pid 201: the pid now runs node'],
      });
    }

    {
      // Reused by another process of the same CLI whose start instant moved during the grace:
      let elapsedMs = 0;
      let start = STARTED_MS;
      const events: { atMs: number; signal: 'terminate' | 'kill' }[] = [];
      const resMovedStart = closeOrphans({
        candidates: [baseCandidate],
        session: 'acme',
        confirm: () => true,
        sources: {
          alive: () => true,
          commOf: () => 'codex',
          startOf: () => start,
          ancestorsOf: () => [201, 1],
          heldElsewhere: () => new Set(),
          heldHere: () => new Set(),
          signal: (_pid, signal) => {
            events.push({ atMs: elapsedMs, signal });
            return true;
          },
          pause: (ms) => {
            elapsedMs += ms;
            if (elapsedMs === 1000) start = STARTED_MS + 2001;
          },
        },
      });
      expect(events).toEqual([{ atMs: 0, signal: 'terminate' }]);
      expect(elapsedMs).toBe(2000);
      expect(resMovedStart).toEqual({
        closed: 0,
        lines: ['left: pid 201: it is not the process the check saw'],
      });
    }

    {
      // Picked up by a pane of this session during the grace:
      let elapsedMs = 0;
      const here = new Set<number>();
      const events: { atMs: number; signal: 'terminate' | 'kill' }[] = [];
      const resPickedUp = closeOrphans({
        candidates: [baseCandidate],
        session: 'acme',
        confirm: () => true,
        sources: {
          alive: () => true,
          commOf: () => 'codex',
          startOf: () => STARTED_MS,
          ancestorsOf: () => [201, 1],
          heldElsewhere: () => new Set(),
          heldHere: () => here,
          signal: (_pid, signal) => {
            events.push({ atMs: elapsedMs, signal });
            return true;
          },
          pause: (ms) => {
            elapsedMs += ms;
            if (elapsedMs === 800) here.add(201);
          },
        },
      });
      expect(events).toEqual([{ atMs: 0, signal: 'terminate' }]);
      expect(elapsedMs).toBe(2000);
      expect(resPickedUp).toEqual({
        closed: 0,
        lines: ['left: pid 201: a pane of this session holds it'],
      });
    }

    // 7e. Process survives both the 2000 ms terminate grace and the 1000 ms kill grace:
    // `kill` is sent once at 2000 ms, and at 3000 ms the process is left as `it did not stop`.
    {
      let elapsedMs = 0;
      const events: { atMs: number; signal: 'terminate' | 'kill' }[] = [];
      const sources: OrphanCloseSources = {
        alive: () => true,
        commOf: () => 'codex',
        startOf: () => STARTED_MS,
        ancestorsOf: () => [201, 1],
        heldElsewhere: () => new Set(),
        heldHere: () => new Set(),
        signal: (_pid, signal) => {
          events.push({ atMs: elapsedMs, signal });
          return true;
        },
        pause: (ms) => {
          elapsedMs += ms;
        },
      };
      const res = closeOrphans({
        candidates: [baseCandidate],
        session: 'acme',
        sources,
        confirm: () => true,
      });
      expect(events).toEqual([
        { atMs: 0, signal: 'terminate' },
        { atMs: 2000, signal: 'kill' },
      ]);
      expect(elapsedMs).toBe(3000);
      expect(res).toEqual({
        closed: 0,
        lines: ['left: pid 201: it did not stop'],
      });
    }
  });
});
