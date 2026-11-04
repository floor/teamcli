// The check's orphan reading: a live agent CLI the team launched, or one found by its working
// folder inside the team's root, that no pane holds any more. The reading names it — the pid,
// the CLI, its age and the team record it belongs to — and, where the record proves it is the
// team's, offers the close the close flow runs. A pane list that could not be read, or that reads
// no agents while seats are recorded, names nothing and closes nothing: a failed read must never
// make a live seat's CLI look orphaned. Pure scenes: the table, the folder read and the caller's
// own ancestry are handed in, so no read touches this machine.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { orphanReading, type OrphanProcessEntry, type OrphanProcessSources } from '../src/check/orphans.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { SessionState } from '../src/state.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { TeamFile } from '../src/file/types.ts';
import { approvalStanding } from '../src/store/store.ts';
import { deliverBriefs, testIo } from './helpers.ts';

afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});
const made: string[] = [];

const NOW = new Date('2026-11-04T12:00:00Z');
const ROOT = '/team/acme';
const DAEMON_SINCE = new Date('2026-11-04T10:00:00Z').toISOString();

const TEAM = { project: 'acme' } as TeamFile;

/** One row of the table the reading is given. */
function row(pid: number, comm: string, startedAt: Date): OrphanProcessEntry {
  return { pid, comm, startedAtMs: startedAt.getTime() };
}

/** A live session with one agent in one pane, its process identity read as `processes` says. */
function liveWith(panes: Record<string, { shell: number; foreground: number[] } | null>): Live {
  return {
    running: true,
    agents: Object.keys(panes).map((pane) => ({
      name: `seat-${pane}`,
      agent: 'codex',
      pane,
      workspace: 'w',
      status: 'idle',
      cwd: null,
    })),
    workspaces: [{ id: 'w', label: 'team' }],
    screens: {},
    processes: panes,
  };
}

function stateWith(seats: SessionState['seats']): SessionState {
  return { ...emptySession(), seats };
}

type Sources = {
  table?: OrphanProcessEntry[] | null;
  folders?: Map<number, string | null> | null;
  ancestors?: number[] | null;
  own?: number[];
};

function sources(options: Sources = {}): OrphanProcessSources {
  return {
    table: () => (options.table === undefined ? [] : options.table),
    foldersOf: () => (options.folders === undefined ? new Map() : options.folders),
    // Null by default: the chain was not read, so a pane herdr could not answer for holds.
    ancestorsOf: () => (options.ancestors === undefined ? null : options.ancestors),
    own: () => options.own ?? [],
  };
}

function reading(options: {
  seats?: SessionState['seats'];
  live?: Live;
  table?: OrphanProcessEntry[] | null;
  folders?: Map<number, string | null> | null;
  ancestors?: number[] | null;
  own?: number[];
  daemonSince?: string | null;
}) {
  return orphanReading({
    project: TEAM.project,
    root: ROOT,
    session: 'acme',
    state: stateWith(options.seats ?? {}),
    live: options.live ?? liveWith({}),
    now: NOW,
    daemonSince: options.daemonSince === undefined ? DAEMON_SINCE : options.daemonSince,
    sources: sources({
      table: options.table,
      folders: options.folders,
      ...(options.ancestors !== undefined ? { ancestors: options.ancestors } : {}),
      ...(options.own ? { own: options.own } : {}),
    }),
  });
}

describe('the orphan reading names a live CLI no pane holds', () => {
  test('a recorded CLI, alive outside every pane, is named with its seat and the close', () => {
    // The launch recorded shell 100 and CLI 200 in pane-a; the pane now holds only its shell.
    const { differences, candidates, unread } = reading({
      seats: { 'dev-one': { stage: 'ready', pane: 'pane-a', launched: { shell: 100, cli: [200] } } },
      live: liveWith({ 'pane-a': { shell: 100, foreground: [100] } }),
      table: [row(200, '/usr/local/bin/codex', new Date('2026-11-04T10:00:00Z'))],
    });
    expect(unread).toBe(false);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ pid: 200, cli: 'codex', seat: 'dev-one', recorded: true, closeable: true });
    expect(differences).toEqual([
      {
        what: 'pid 200: a live codex process with no pane in session "acme" (started 2h ago; last team acme, seat dev-one)',
        repair: 'close it through the team (team check --close-orphans)',
        who: "the team's lead",
      },
    ]);
  });

  test('a CLI whose pane still holds it is not named', () => {
    const { differences, candidates } = reading({
      seats: { 'dev-one': { stage: 'ready', pane: 'pane-a', launched: { shell: 100, cli: [200] } } },
      live: liveWith({ 'pane-a': { shell: 100, foreground: [100, 200] } }),
      table: [row(200, 'codex', new Date('2026-11-04T10:00:00Z'))],
    });
    expect(differences).toEqual([]);
    expect(candidates).toEqual([]);
  });

  test('a CLI found by its working folder inside the root is named with no seat record', () => {
    const { differences, candidates } = reading({
      seats: { other: { stage: 'ready', pane: 'pane-b', launched: { shell: 300, cli: [301] } } },
      live: liveWith({ 'pane-b': { shell: 300, foreground: [300, 301] } }),
      table: [row(400, '/opt/tools/bin/claude', new Date('2026-11-04T11:55:00Z'))],
      folders: new Map([[400, `${ROOT}/packages`]]),
    });
    expect(candidates).toHaveLength(1);
    // The row names the CLI in the team file's own word for it (`claude-code`), not the process
    // name the system holds; the pid beside it is what a person matches against the process list.
    expect(candidates[0]).toMatchObject({ pid: 400, cli: 'claude-code', seat: null, recorded: false, closeable: true });
    expect(differences).toEqual([
      {
        what: 'pid 400: a live claude-code process with no pane in session "acme" (started 5m ago; last team acme, no seat record)',
        repair: 'close it through the team (team check --close-orphans)',
        who: "the team's lead",
      },
    ]);
  });

  test('a CLI outside the team root is not this team\'s to name', () => {
    const { differences, candidates } = reading({
      seats: { other: { stage: 'ready', pane: 'pane-b', launched: { shell: 300, cli: [301] } } },
      live: liveWith({ 'pane-b': { shell: 300, foreground: [300, 301] } }),
      table: [row(400, 'claude', new Date('2026-11-04T11:55:00Z'))],
      folders: new Map([[400, '/elsewhere/acme/packages']]),
    });
    expect(differences).toEqual([]);
    expect(candidates).toEqual([]);
  });

  test('one that started before the daemon is named, never closeable', () => {
    // The folder read found it, and no state record names it: the daemon's own start is the floor
    // for closing, so this one is a person's to inspect.
    const { differences, candidates } = reading({
      seats: { other: { stage: 'ready', pane: 'pane-b', launched: { shell: 300, cli: [301] } } },
      live: liveWith({ 'pane-b': { shell: 300, foreground: [300, 301] } }),
      table: [row(400, 'gemini', new Date('2026-11-04T09:00:00Z'))],
      folders: new Map([[400, ROOT]]),
    });
    expect(candidates[0]).toMatchObject({ pid: 400, closeable: false });
    expect(differences[0]?.repair).toBe("inspect it, then stop it by hand if it is not a seat's");
    expect(differences[0]?.who).toBe('the owner');
  });

  test('a recorded CLI is closeable even when it started before the daemon', () => {
    const { candidates } = reading({
      seats: { 'dev-one': { stage: 'ready', pane: 'pane-a', launched: { shell: 100, cli: [200] } } },
      live: liveWith({ 'pane-a': { shell: 100, foreground: [100] } }),
      table: [row(200, 'codex', new Date('2026-11-04T09:00:00Z'))],
    });
    expect(candidates[0]).toMatchObject({ recorded: true, closeable: true });
  });

  test('a recorded pid the system now runs as something else is not named', () => {
    const { differences, candidates } = reading({
      seats: { 'dev-one': { stage: 'ready', pane: 'pane-a', launched: { shell: 100, cli: [200] } } },
      live: liveWith({ 'pane-a': { shell: 100, foreground: [100] } }),
      table: [row(200, 'zsh', new Date('2026-11-04T10:00:00Z'))],
    });
    expect(differences).toEqual([]);
    expect(candidates).toEqual([]);
  });

  test('the check\'s own ancestry is never named', () => {
    const { differences, candidates } = reading({
      seats: { 'dev-one': { stage: 'ready', pane: 'pane-a', launched: { shell: 100, cli: [200] } } },
      live: liveWith({ 'pane-a': { shell: 100, foreground: [100] } }),
      table: [row(200, 'codex', new Date('2026-11-04T10:00:00Z'))],
      own: [7, 200],
    });
    expect(differences).toEqual([]);
    expect(candidates).toEqual([]);
  });
});

describe('the orphan reading names nothing when a pane read could lie', () => {
  test('no agents while seats are recorded: no rows, no close, one note', () => {
    const { differences, candidates, notes, unread } = reading({
      seats: {
        'dev-one': { stage: 'ready', pane: 'pane-a' },
        'dev-two': { stage: 'ready', pane: 'pane-b' },
      },
      live: { running: true, agents: [], workspaces: [], screens: {} },
      table: [row(200, 'codex', new Date('2026-11-04T10:00:00Z'))],
    });
    expect(differences).toEqual([]);
    expect(candidates).toEqual([]);
    expect(unread).toBe(true);
    expect(notes).toEqual(['the session\'s pane list reads no agents while the state records 2 seats; no orphan processes are named']);
  });

  test('a pane herdr could not read holds its recorded CLI and blocks folder discovery', () => {
    const { differences, candidates, notes } = reading({
      seats: { 'dev-one': { stage: 'ready', pane: 'pane-a', launched: { shell: 100, cli: [200] } } },
      live: liveWith({ 'pane-a': null }),
      table: [row(200, 'codex', new Date('2026-11-04T10:00:00Z')), row(400, 'claude', new Date('2026-11-04T11:00:00Z'))],
      folders: new Map([[400, ROOT]]),
    });
    expect(differences).toEqual([]);
    expect(candidates).toEqual([]);
    expect(notes).toEqual(['herdr could not say what runs in 1 pane; processes found by their folder are not named']);
  });

  test('a pane herdr could not read still names a CLI whose launch shell no longer contains it', () => {
    // The launch recorded shell 100 and CLI 200; herdr cannot answer for the pane, and the chain
    // no longer holds 100 — the CLI left its pane, so it is the reading's to name.
    const { differences, candidates } = reading({
      seats: { 'dev-one': { stage: 'ready', pane: 'pane-a', launched: { shell: 100, cli: [200] } } },
      live: liveWith({ 'pane-a': null }),
      table: [row(200, 'codex', new Date('2026-11-04T10:00:00Z'))],
      ancestors: [200, 1],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ pid: 200, recorded: true, closeable: true });
    expect(differences[0]?.what).toContain('pid 200: a live codex process with no pane');
  });

  test('the launch shell still holding its CLI keeps it unnamed even with no pane read', () => {
    const { differences, candidates } = reading({
      seats: { 'dev-one': { stage: 'ready', pane: 'pane-a', launched: { shell: 100, cli: [200] } } },
      live: liveWith({ 'pane-a': null }),
      table: [row(200, 'codex', new Date('2026-11-04T10:00:00Z'))],
      ancestors: [200, 100, 1],
    });
    expect(differences).toEqual([]);
    expect(candidates).toEqual([]);
  });

  test('the session not running: no rows, one note', () => {
    const { differences, notes, unread } = reading({
      seats: { 'dev-one': { stage: 'ready', pane: 'pane-a' } },
      live: { running: false, agents: [], workspaces: [], screens: {} },
      table: [row(200, 'codex', new Date('2026-11-04T10:00:00Z'))],
    });
    expect(differences).toEqual([]);
    expect(unread).toBe(true);
    expect(notes).toEqual(['session "acme" is not running; no processes are compared']);
  });

  test('an unreadable process table names nothing', () => {
    const { differences, notes, unread } = reading({
      seats: { 'dev-one': { stage: 'ready', pane: 'pane-a', launched: { shell: 100, cli: [200] } } },
      live: liveWith({ 'pane-a': { shell: 100, foreground: [100] } }),
      table: null,
    });
    expect(differences).toEqual([]);
    expect(unread).toBe(true);
    expect(notes).toEqual(['the process list could not be read; no orphan processes are named']);
  });

  test('a failed folder read still names what the state records', () => {
    const { differences, notes } = reading({
      seats: { 'dev-one': { stage: 'ready', pane: 'pane-a', launched: { shell: 100, cli: [200] } } },
      live: liveWith({ 'pane-a': { shell: 100, foreground: [100] } }),
      table: [row(200, 'codex', new Date('2026-11-04T10:00:00Z')), row(400, 'claude', new Date('2026-11-04T11:00:00Z'))],
      folders: null,
    });
    expect(differences.map((one) => one.what)).toEqual([
      'pid 200: a live codex process with no pane in session "acme" (started 2h ago; last team acme, seat dev-one)',
    ]);
    expect(notes).toEqual(['the folder read did not answer; processes the state does not record are not named']);
  });

  test('a team with no seats and no agents reads no process table at all', () => {
    let asked = false;
    const answer = orphanReading({
      project: TEAM.project,
      root: ROOT,
      session: 'acme',
      state: emptySession(),
      live: liveWith({}),
      now: NOW,
      daemonSince: DAEMON_SINCE,
      sources: {
        table: () => {
          asked = true;
          return [];
        },
        foldersOf: () => new Map(),
        ancestorsOf: () => null,
        own: () => [],
      },
    });
    expect(answer).toMatchObject({ differences: [], notes: [] });
    expect(asked).toBe(false);
  });
});

// A real check run over a file and a state: the row is in the run's own output, and the
// suppression note replaces it when the pane list reads no agents.
const TEAM_TEXT = `format: 1
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
`;

/** A checkout with the file above and the launch's record for dev-one: shell 100, CLI 200. */
function fixture(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-orphans-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  const env = { ...process.env };
  delete env.GIT_DIR;
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', env });
  writeFileSync(join(root, '.agents/team.yaml'), TEAM_TEXT);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats['dev-one'] = { stage: 'ready', pane: 'pane-a', workspace: 'w', launched: { shell: 100, cli: [200] } };
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
  });
  deliverBriefs({ dir: join(root, '.agents'), root, session: 'acme', seats: ['lead', 'dev-one'], home, at: NOW.toISOString() });
  return { root, home };
}

function runCheck(agentsListed: boolean): { code: number; out: string } {
  const { root, home } = fixture();
  const io = testIo(root, { kind: 'owner' });
  const live: Live = {
    running: true,
    agents: agentsListed
      ? [{ name: 'dev-one', agent: 'codex', pane: 'pane-a', workspace: 'w', status: 'idle', cwd: null }]
      : [],
    workspaces: [{ id: 'w', label: 'team' }],
    screens: {},
    processes: { 'pane-a': { shell: 100, foreground: [100] } },
  };
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live,
    branch: () => 'main',
    standing: (at) => approvalStanding(at, home),
    now: () => NOW,
    home,
    orphans: {
      table: () => [row(200, 'codex', new Date('2026-11-04T10:00:00Z'))],
      foldersOf: () => new Map(),
      ancestorsOf: () => null,
      own: () => [],
    },
  });
  return { code, out: `${io.out}${io.err}` };
}

describe('the check prints the orphan row and the close it offers', () => {
  test('a live CLI with no pane is a difference with the team\'s close', () => {
    const { code, out } = runCheck(true);
    expect(out).toContain(
      'difference: pid 200: a live codex process with no pane in session "acme" (started 2h ago; last team acme, seat dev-one)',
    );
    expect(out).toContain('close it through the team (team check --close-orphans)');
    expect(code).toBe(1);
  });

  test('a pane list that reads no agents names no process and prints the note', () => {
    const { out } = runCheck(false);
    expect(out).not.toContain('pid 200:');
    expect(out).toContain(
      "note: the session's pane list reads no agents while the state records 1 seat; no orphan processes are named",
    );
  });
});
