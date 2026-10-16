import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../../src/approve/approval.ts';
import { main } from '../../src/cli.ts';
import { activeSeatsOf, formatActiveSeats, runList, type ListSeatsRow, type ListSources } from '../../src/commands/list.ts';
import { formatRelativeTime, runSeats, USAGE, type SeatsJson, type SeatsSources } from '../../src/commands/seats.ts';
import { runStatus, type StatusJson, type StatusSources } from '../../src/commands/status.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { emptySession, updateState } from '../../src/state.ts';
import type { Live } from '../../src/status/compare.ts';
import type { Standing } from '../../src/store/store.ts';
import { testIo } from '../helpers.ts';

const example = readFileSync(new URL('../fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-03T14:10:00Z');

const claudeScreen = (model: string) => `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;

function agent(name: string | null, workspace: string, pane: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane, workspace, status, cwd: null };
}

function built(): Live {
  return {
    running: true,
    agents: [
      agent('claude-coordinator-acme', 'ws-1', 'pane-1', 'working'),
      agent('codex-acme', 'ws-2', 'pane-2', 'idle', 'codex'),
      agent('deepseek-acme', 'ws-3', 'pane-3', 'done'),
      agent('deepseek-acme-2', 'ws-4', 'pane-4', 'idle'),
    ],
    workspaces: [
      { id: 'ws-1', label: 'claude opus 5.5' },
      { id: 'ws-2', label: 'gpt sol 6' },
      { id: 'ws-3', label: 'deepseek flash v4.1' },
      { id: 'ws-4', label: 'deepseek flash v4.1-2' },
      { id: 'ws-9', label: 'watchdog' },
    ],
    screens: { 'pane-1': claudeScreen('Opus 5.5') },
  };
}

let dir: string;
let file: string;
let live: Live | null;
let branch: string | null;
let standing: Standing;

const statusSources: StatusSources = {
  live: () => live,
  branch: () => branch,
  standing: () => standing,
  now: () => NOW,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-seats-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, example);
  live = built();
  branch = 'main';
  const checked = validateTeamFile(example);
  if (!checked.ok) throw new Error('the example fixture does not validate');
  standing = verifiedOf(checked.team, example, dir, NOW);
  updateState(join(dir, '.agents'), (state) => {
    state.sessions['acme-web'] = {
      ...emptySession(),
      watch: { pid: 1, heartbeat: '2026-10-03T14:09:00Z' },
      seats: {
        'claude-coordinator-acme': {
          id: 'seat_111111111111',
          pane: 'pane-1',
          workspace: 'ws-1',
          stage: 'ready',
          model: 'Claude Opus',
          version: '5.5',
          effort: 'high',
          launch_line: 'claude --model claude-opus-5-5',
          last_active: '2026-10-03T14:09:48Z',
        },
        'codex-acme': {
          id: 'seat_222222222222',
          pane: 'pane-2',
          workspace: 'ws-2',
          stage: 'ready',
          model: 'GPT Sol',
          version: '6',
          effort: 'xhigh',
          launch_line: 'codex -m gpt-6-sol -c model_reasoning_effort=high',
          last_active: '2026-10-03T14:06:00Z',
        },
        'deepseek-acme': {
          id: 'seat_333333333333',
          pane: 'pane-3',
          workspace: 'ws-3',
          stage: 'ready',
          model: 'DeepSeek Flash',
          version: 'V4.1',
          launch_line: 'team-deepseek',
          last_active: '2026-10-03T13:10:00Z',
        },
        'deepseek-acme-2': {
          id: 'seat_444444444444',
          pane: 'pane-4',
          workspace: 'ws-4',
          stage: 'ready',
          model: 'DeepSeek Flash',
          version: 'V4.1',
          launch_line: 'team-deepseek',
        },
      },
      retained_seats: {
        'grok-acme': {
          id: 'seat_555555555555',
          last_active: '2026-10-02T14:10:00Z',
        },
      },
    };
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('formatRelativeTime', () => {
  test('renders seconds, minutes, hours, days, and - for null', () => {
    expect(formatRelativeTime(null, NOW)).toBe('-');
    expect(formatRelativeTime('2026-10-03T14:09:48Z', NOW)).toBe('12s ago');
    expect(formatRelativeTime('2026-10-03T14:06:00Z', NOW)).toBe('4m ago');
    expect(formatRelativeTime('2026-10-03T12:10:00Z', NOW)).toBe('2h ago');
    expect(formatRelativeTime('2026-10-01T14:10:00Z', NOW)).toBe('2d ago');
  });
});

describe('team seats', () => {
  test('--help prints the usage header and exits 0', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const code = await main(['seats', '--help'], io);
    expect(code).toBe(0);
    expect(io.out).toBe(USAGE);
  });

  test('lists active seats in the 9-column registry table and omits stopped seats by default', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const code = await runSeats(['--file', file], io, statusSources);
    expect(code).toBe(0);
    expect(io.out).toContain('SEAT                     ID                 ROLE                 CLI          MODEL                         EFFORT  STATUS                                LAST ACTIVE  PANE');
    expect(io.out).toContain('claude-coordinator-acme  seat_111111111111  project coordinator  claude-code  Claude Opus 5.5               high    working                               now          pane-1');
    expect(io.out).toContain('codex-acme               seat_222222222222  implementer          codex        GPT-6 Sol (from launch)       xhigh   idle (screen not recognised), parked  4m ago       pane-2');
    expect(io.out).toContain('deepseek-acme            seat_333333333333  implementer          claude-code  DeepSeek V4.1 Flash (unread)  -       done (screen not recognised)          1h ago       pane-3');
    expect(io.out).toContain('deepseek-acme-2          seat_444444444444  implementer          claude-code  DeepSeek V4.1 Flash (unread)  -       idle (screen not recognised)          -            pane-4');
    expect(io.out).not.toContain('grok-acme');
  });

  test('falls back to launch line model labelled (from launch) when screen model is unread but launch line names a model', async () => {
    const teamContent = example.replace('stopped: true              # kept in the file; `up` doesn\'t start it, `add grok-acme` does', '');
    writeFileSync(file, teamContent);
    const checked = validateTeamFile(teamContent);
    if (!checked.ok) throw new Error('team content does not validate');
    standing = verifiedOf(checked.team, teamContent, dir, NOW);

    updateState(join(dir, '.agents'), (state) => {
      state.sessions['acme-web']!.seats['grok-acme'] = {
        id: 'seat_555555555555',
        pane: 'pane-5',
        workspace: 'ws-5',
        stage: 'ready',
        model: 'Grok',
        version: '4.7',
        cli: 'grok',
        launch_line: 'grok --model grok-4.7',
        last_active: '2026-10-03T14:00:00Z',
      };
    });
    if (live) {
      live.agents.push(agent('grok-acme', 'ws-5', 'pane-5', 'idle', 'grok'));
      live.workspaces.push({ id: 'ws-5', label: 'grok 4.7' });
      live.screens['pane-5'] = 'Unrecognized Grok dialog screen without status row';
    }
    const io = testIo(dir, { kind: 'owner' });
    const code = await runSeats(['--file', file], io, statusSources);
    expect(code).toBe(0);
    expect(io.out).toContain('grok-acme                seat_555555555555  reviewer             grok         Grok 4.7 (from launch)');
  });

  test('--all includes stopped seats with retained id and last_active', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const code = await runSeats(['--file', file, '--all'], io, statusSources);
    expect(code).toBe(0);
    expect(io.out).toContain('grok-acme                seat_555555555555  reviewer             grok         Grok 4.7                      -       stopped                               1d ago       -');
  });

  test('--json and --all --json emit the SeatsJson payload', async () => {
    const ioActive = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], ioActive, statusSources)).toBe(0);
    const parsedActive = JSON.parse(ioActive.out) as SeatsJson;
    expect(parsedActive.format).toBe(1);
    expect(parsedActive.project).toBe('acme-web');
    expect(parsedActive.session).toBe('acme-web');
    expect(parsedActive.seats.map((s) => s.name)).toEqual([
      'claude-coordinator-acme',
      'codex-acme',
      'deepseek-acme',
      'deepseek-acme-2',
    ]);
    expect(parsedActive.seats[0]).toEqual({
      name: 'claude-coordinator-acme',
      id: 'seat_111111111111',
      role: 'project coordinator',
      cli: 'claude-code',
      model: 'Claude Opus 5.5',
      effort: 'high',
      status: 'working',
      last_active: NOW.toISOString(),
      pane: 'pane-1',
      launch_line: 'claude --model claude-opus-5-5',
    });

    const ioAll = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--all', '--json'], ioAll, statusSources)).toBe(0);
    const parsedAll = JSON.parse(ioAll.out) as SeatsJson;
    expect(parsedAll.seats.map((s) => s.name)).toContain('grok-acme');
    const grok = parsedAll.seats.find((s) => s.name === 'grok-acme');
    expect(grok).toEqual({
      name: 'grok-acme',
      id: 'seat_555555555555',
      role: 'reviewer',
      cli: 'grok',
      model: 'Grok 4.7',
      effort: null,
      status: 'stopped',
      last_active: '2026-10-02T14:10:00Z',
      pane: null,
      launch_line: 'grok --model grok-4.7',
    });
  });

  test('two seats recorded under one handle are not both shown as that handle', async () => {
    updateState(join(dir, '.agents'), (state) => {
      state.sessions['acme-web']!.seats['codex-acme'] = {
        ...state.sessions['acme-web']!.seats['codex-acme']!,
        id: 'seat_111111111111',
      };
    });
    const io = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], io, statusSources)).toBe(0);
    const doc = JSON.parse(io.out) as SeatsJson;
    const shown = doc.seats.map((row) => row.id).filter((id): id is string => id !== null);
    expect(new Set(shown).size).toBe(shown.length);
  });

  test('--watch refreshes until wait returns false and refuses --json', async () => {
    const ioBad = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--watch', '--json'], ioBad, statusSources)).toBe(2);
    expect(ioBad.err).toContain("--watch and --json can't be used together");

    let ticks = 0;
    const ioWatch = testIo(dir, { kind: 'owner' });
    ioWatch.stdoutIsTTY = true;
    const sources: SeatsSources = {
      ...statusSources,
      wait: async () => {
        ticks += 1;
        return ticks < 2;
      },
    };
    const code = await runSeats(['--file', file, '--watch'], ioWatch, sources);
    expect(code).toBe(0);
    expect(ticks).toBe(2);
    expect(ioWatch.out.split('\x1b[2J\x1b[H').length - 1).toBe(2);
  });
});

describe('team status --all', () => {
  test('renders the 9-column registry table while preserving difference footer and notes', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const code = await runStatus(['--file', file, '--all'], io, statusSources);
    expect(code).toBe(0);
    expect(io.out).toContain('team acme-web, session "acme-web"');
    expect(io.out).toContain('SEAT                     ID                 ROLE                 CLI          MODEL                         EFFORT  STATUS                                LAST ACTIVE  PANE');
    expect(io.out).toContain('claude-coordinator-acme  seat_111111111111  project coordinator  claude-code  Claude Opus 5.5               high    working                               now          pane-1');
    expect(io.out).toContain('grok-acme                seat_555555555555  reviewer             grok         Grok 4.7                      -       stopped                               1d ago       -');
    expect(io.out).toContain('0 difference(s)');
    expect(io.out).toContain('note: codex-acme: version unread');
  });

  test('--all --json includes id, role, cli, effort, last_active, and launch_line on each seat', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const code = await runStatus(['--file', file, '--all', '--json'], io, statusSources);
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out) as StatusJson;
    expect(parsed.rows[0]).toMatchObject({
      name: 'claude-coordinator-acme',
      id: 'seat_111111111111',
      role: 'project coordinator',
      cli: 'claude-code',
      effort: 'high',
      last_active: NOW.toISOString(),
      launch_line: 'claude --model claude-opus-5-5',
    });
    const grok = parsed.rows.find((s) => s.name === 'grok-acme');
    expect(grok).toMatchObject({
      name: 'grok-acme',
      id: 'seat_555555555555',
      role: 'reviewer',
      cli: 'grok',
      effort: null,
      last_active: '2026-10-02T14:10:00Z',
      launch_line: 'grok --model grok-4.7',
    });
  });
});

describe('team list --watch and --seats', () => {
  test('refreshes until wait returns false and refuses --json', async () => {
    const listSources: ListSources = {
      sessions: () => [{ name: 'acme', running: true }],
      roster: () => [{ name: 'lead', status: 'working' }],
      team: () => ({ project: 'acme', root: '/work/acme', seats: 1, unreadable: false }),
    };

    const ioBad = testIo(dir, { kind: 'owner' });
    expect(await runList(['--watch', '--json'], ioBad, listSources)).toBe(2);
    expect(ioBad.err).toContain("--watch and --json can't be used together");

    let ticks = 0;
    const ioWatch = testIo(dir, { kind: 'owner' });
    ioWatch.stdoutIsTTY = true;
    const code = await runList(['--watch'], ioWatch, {
      ...listSources,
      wait: async () => {
        ticks += 1;
        return ticks < 2;
      },
    });
    expect(code).toBe(0);
    expect(ticks).toBe(2);
    expect(ioWatch.out.split('\x1b[2J\x1b[H').length - 1).toBe(2);
    expect(ioWatch.out).toContain('acme');
  });

  test('--seats shows ready / working / waiting / stopped counts and per-seat rows across projects', async () => {
    const listSources: ListSources = {
      sessions: () => [
        { name: 'acme', running: true },
        { name: 'beacon', running: false },
      ],
      roster(session) {
        if (session === 'acme') {
          return [
            { name: 'lead', id: 'seat_111111111111', status: 'ready', cli: 'claude-code', model: 'Claude Opus 5.5', pane: 'pane-1' },
            { name: 'builder', id: 'seat_222222222222', status: 'working', cli: 'codex', model: 'GPT Sol 6', pane: 'pane-2' },
            { name: 'reviewer', id: 'seat_333333333333', status: 'waiting', cli: 'claude-code', model: 'Claude Sonnet 5.5', pane: 'pane-3' },
          ];
        }
        return [];
      },
      team(session) {
        if (session === 'acme') return { project: 'acme', root: '/work/acme', seats: 4, unreadable: false };
        if (session === 'beacon') return { project: 'beacon', root: '/work/beacon', seats: 2, unreadable: false };
        return null;
      },
    };

    const summary = activeSeatsOf(listSources.roster('acme'), 4, true);
    expect(summary).toEqual({ ready: 1, working: 1, waiting: 1, stopped: 1 });
    expect(formatActiveSeats(summary)).toBe('1 ready / 1 working / 1 waiting / 1 stopped');

    const ioTable = testIo(dir, { kind: 'owner' });
    expect(await runList(['--all', '--seats'], ioTable, listSources)).toBe(0);
    expect(ioTable.out).toContain('1 ready / 1 working / 1 waiting / 1 stopped');
    expect(ioTable.out).toContain('0 ready / 0 working / 0 waiting / 2 stopped');
    expect(ioTable.out).toContain('  lead      seat_111111111111  ready    claude-code  Claude Opus 5.5    pane-1');
    expect(ioTable.out).toContain('  builder   seat_222222222222  working  codex        GPT Sol 6          pane-2');
    expect(ioTable.out).toContain('  reviewer  seat_333333333333  waiting  claude-code  Claude Sonnet 5.5  pane-3');

    const ioJson = testIo(dir, { kind: 'owner' });
    expect(await runList(['--all', '--seats', '--json'], ioJson, listSources)).toBe(0);
    const parsed = JSON.parse(ioJson.out) as ListSeatsRow[];
    expect(parsed[0]).toMatchObject({
      team: 'acme',
      project: 'acme',
      status: 'running',
      seats: '4',
      activity: '1 ready / 1 working / 1 waiting / 1 stopped',
      active: { ready: 1, working: 1, waiting: 1, stopped: 1 },
    });
    expect(parsed[0]?.roster).toHaveLength(3);
    expect(parsed[1]).toMatchObject({
      team: 'beacon',
      project: 'beacon',
      status: 'stopped',
      seats: '2',
      activity: '0 ready / 0 working / 0 waiting / 2 stopped',
      active: { ready: 0, working: 0, waiting: 0, stopped: 2 },
      roster: [],
    });
  });
});

