import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../../src/approve/approval.ts';
import { main } from '../../src/cli.ts';
import { activeSeatsOf, formatActiveSeats, runList, type ListSeatsRow, type ListSources } from '../../src/commands/list.ts';
import { formatRelativeTime, realSeatsSources, runSeats, USAGE, type SeatsJson, type SeatsSources } from '../../src/commands/seats.ts';
import { realSources as realStatusSources, runStatus, type StatusJson, type StatusSources } from '../../src/commands/status.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { SEATS_OUTPUT_SCHEMA } from '../../src/output/index.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { watchLabel } from '../../src/watch/pane.ts';
import type { Live } from '../../src/status/compare.ts';
import type { Standing } from '../../src/store/store.ts';
import { gitEnv, testIo } from '../helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from '../helpers/output.ts';

const example = readFileSync(new URL('../fixtures/example.yaml', import.meta.url), 'utf8');
// A real idle capture, scrollback and all: the table's own reading of a pane.
const claudeIdle = readFileSync(new URL('../fixtures/claude-code/2.1.289/idle-suggestion-plain.txt', import.meta.url), 'utf8');
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
      { id: 'ws-9', label: watchLabel('acme-web') },
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
  test('--help prints the usage header and exits 0 (including with --json)', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const code = await main(['seats', '--help'], io);
    expect(code).toBe(0);
    expect(io.out).toBe(USAGE);

    const ioJsonHelp = testIo(dir, { kind: 'owner' });
    expect(await main(['seats', '--json', '--help'], ioJsonHelp)).toBe(0);
    expect(ioJsonHelp.out).toBe(USAGE);
  });

  test('a pause prints above the table and in --json', async () => {
    const pause = { by: 'owner', at: '2026-10-03T14:00:00.000Z', stops: [] };
    updateState(join(dir, '.agents'), (state) => {
      state.pause = pause;
    });
    const io = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file], io, statusSources)).toBe(0);
    expect(io.out).toContain('paused since 2026-10-03T14:00:00.000Z by owner');
    expect(io.out.indexOf('paused since')).toBeLessThan(io.out.indexOf('SEAT '));
    const again = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], again, statusSources)).toBe(0);
    expect((JSON.parse(again.out) as SeatsJson).pause).toEqual(pause);
  });

  test('lists active seats in the 12-column registry table and omits stopped seats by default', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const code = await runSeats(['--file', file], io, statusSources);
    expect(code).toBe(0);
    expect(io.out).toContain('team acme-web, session "acme-web"');
    expect(io.out).toContain('SEAT                     NICKNAME  ID                 ROLE                 CLI          MODEL                                   EFFORT  STATUS                                STATE    SOURCE  LAST ACTIVE  PANE');
    // The coordinator is idle at its prompt, but its record was touched 12s before NOW — a
    // trace inside the window, which an idle word yields to (src/labels/state.ts).
    // An unread screen keeps the declared display, marked declared and unread together.
    expect(io.out).toContain('claude-coordinator-acme  -         seat_111111111111  project coordinator  claude-code  Claude Opus 5.5                         high    working                               working  trace   now          pane-1');
    expect(io.out).toContain('codex-acme               -         seat_222222222222  implementer          codex        GPT-6 Sol (declared, unread)            xhigh   idle (screen not recognised), parked  idle     herdr   4m ago       pane-2');
    expect(io.out).toContain('deepseek-acme            -         seat_333333333333  implementer          claude-code  DeepSeek V4.1 Flash (declared, unread)  -       done (screen not recognised)          done     herdr   1h ago       pane-3');
    expect(io.out).toContain('deepseek-acme-2          -         seat_444444444444  implementer          claude-code  DeepSeek V4.1 Flash (declared, unread)  -       idle (screen not recognised)          idle     herdr   -            pane-4');
    expect(io.out).toContain('4 seats');
    expect(io.out).not.toContain('grok-acme');
  });

  test('a seat whose idle screen hides a commit inside the window reads working, source trace', async () => {
    const worktree = join(dir, 'worktrees', 'codex-task');
    mkdirSync(worktree, { recursive: true });
    // Committed two minutes before NOW, through a real repository the table reads back with
    // `git log` (src/labels/traces.ts). The window's boundary counts as inside.
    const when = '2026-10-03T14:08:00Z';
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
        cwd: worktree,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...gitEnv(), GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
      });
    git('init', '-q');
    writeFileSync(join(worktree, 'note.txt'), 'note\n');
    git('add', 'note.txt');
    git('commit', '-q', '-m', 'the work so far');
    updateState(join(dir, '.agents'), (state) => {
      state.sessions['acme-web']!.worktrees['codex-task'] = {
        path: worktree,
        branch: 'feat/codex-task',
        seat: 'codex-acme',
        setup: 'ok',
      };
    });
    const io = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file], io, statusSources)).toBe(0);
    // codex-acme's pane holds no screen read and herdr says idle — without the commit its row
    // reads `idle herdr`, as the scene above pins. The commit inside the window is a trace, and
    // a fresh trace beats an idle word: working, from TeamCLI's own record. A working reading is
    // activity now, whatever carried the word — the row says so, not the trace's age.
    expect(io.out).toContain('codex-acme               -         seat_222222222222  implementer          codex        GPT-6 Sol (declared, unread)            xhigh   idle (screen not recognised), parked  working  trace   now          pane-2');
  });

  test('a seat’s own hook file is read from the state folder beside the team file', async () => {
    // deepseek-acme-2's screen and herdr both read idle/no-screen, so without the state folder
    // the row says idle from herdr, as the table test pins. The hook the seat's own launch
    // installed wrote `working` five seconds ago: `team seats` passes `<dir>` and the session,
    // and reads the file under the session's own folder.
    mkdirSync(join(dir, '.agents', 'seat-state', 'acme-web'), { recursive: true });
    writeFileSync(
      join(dir, '.agents', 'seat-state', 'acme-web', 'deepseek-acme-2.json'),
      `{"state":"working","since":"${new Date(NOW.getTime() - 5000).toISOString()}"}\n`,
    );
    const io = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], io, statusSources)).toBe(0);
    const doc = JSON.parse(io.out) as SeatsJson;
    // The working reading also carries LAST ACTIVE as this run's instant: the row counts the
    // reading, not herdr's idle word, as activity.
    expect(doc.seats.find((item) => item.name === 'deepseek-acme-2')).toMatchObject({
      state: 'working',
      state_source: 'cli-hook',
      last_active: NOW.toISOString(),
    });
  });

  test('an idle screen whose scrollback holds an old tool row reads idle, not working', async () => {
    // Claude Code leaves its `⏺ Bash(...)` rows in the scrollback, and a screen carries no
    // clock: the row is never weighed as a fresh trace (src/labels/traces.ts). deepseek-acme-2
    // records no last_active and no worktree, so before this rule the read's own instant stood
    // as the row's time and the idle seat read working/trace forever. The screen is the real
    // 2.1.289 idle capture with one tool row above its composer.
    live!.screens['pane-4'] = `⏺ Bash(ls -la)\n${claudeIdle}`;
    const io = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file], io, statusSources)).toBe(0);
    expect(io.out).toContain('deepseek-acme-2          -         seat_444444444444  implementer          claude-code  DeepSeek V4.1 Flash (declared, unread)  -       idle                                  idle     cli     -            pane-4');
  });

  test('--all includes stopped seats with retained id and last_active', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const code = await runSeats(['--file', file, '--all'], io, statusSources);
    expect(code).toBe(0);
    // A retained seat is done (its process is gone), not judged blind on its day-old trace.
    expect(io.out).toContain('grok-acme                -         seat_555555555555  reviewer             grok         Grok 4.7                                -       stopped                               done     process  1d ago       -');
    expect(io.out).toContain('5 seats');
  });

  test('--json and --all --json emit the SeatsJson payload and match SEATS_OUTPUT_SCHEMA', async () => {
    const ioActive = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], ioActive, statusSources)).toBe(0);
    const parsedActive = assertMatchesOutputSchema<SeatsJson>(ioActive.out, SEATS_OUTPUT_SCHEMA);
    expect(parsedActive.schema).toEqual({ name: 'team.seats', version: 1 });
    expect(parsedActive.format).toBe(1);
    expect(parsedActive.project).toBe('acme-web');
    expect(parsedActive.session).toBe('acme-web');
    expect(parsedActive.notice).toBeUndefined();
    expect(parsedActive.seats.map((s) => s.name)).toEqual([
      'claude-coordinator-acme',
      'codex-acme',
      'deepseek-acme',
      'deepseek-acme-2',
    ]);
    expect(parsedActive.seats[0]).toEqual({
      name: 'claude-coordinator-acme',
      nickname: null,
      id: 'seat_111111111111',
      role: 'project coordinator',
      cli: 'claude-code',
      model: 'Claude Opus 5.5',
      effort: 'high',
      status: 'working',
      // The seat's own reading, beside `status`: the fresh trace (12s before NOW) over the
      // idle screen, the table's STATE and SOURCE columns.
      state: 'working',
      state_source: 'trace',
      last_active: NOW.toISOString(),
      pane: 'pane-1',
      launch_line: 'claude --model claude-opus-5-5',
    });

    const ioAll = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--all', '--json'], ioAll, statusSources)).toBe(0);
    const parsedAll = assertMatchesOutputSchema<SeatsJson>(ioAll.out, SEATS_OUTPUT_SCHEMA);
    expect(parsedAll.seats.map((s) => s.name)).toContain('grok-acme');
    const grok = parsedAll.seats.find((s) => s.name === 'grok-acme');
    expect(grok).toEqual({
      name: 'grok-acme',
      nickname: null,
      id: 'seat_555555555555',
      role: 'reviewer',
      cli: 'grok',
      model: 'Grok 4.7',
      effort: null,
      status: 'stopped',
      // A retained seat is done (its process is gone), never judged blind: the table's reading.
      state: 'done',
      state_source: 'process',
      last_active: '2026-10-02T14:10:00Z',
      pane: null,
      launch_line: 'grok --model grok-4.7',
    });

    const ioErr = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], ioErr, { ...statusSources, live: () => null })).toBe(2);
    expect(ioErr.err).toBe('');
    assertJsonErrorShape(ioErr.out, { id: 'seats.herdr', messageContains: "herdr doesn't answer" });

    writeFileSync(file, 'not: [valid');
    const ioNotice = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], ioNotice, statusSources)).toBe(0);
    const parsedNotice = assertMatchesOutputSchema<SeatsJson>(ioNotice.out, SEATS_OUTPUT_SCHEMA);
    expect(parsedNotice.notice).toContain('team.yaml is invalid');

    for (const [argv, messageContains] of [
      [['--nope', '--json'], 'unknown option --nope'],
      [['--json=1'], 'unknown option --json'],
    ] as const) {
      const ioBad = testIo(dir, { kind: 'owner' });
      expect(await runSeats([...argv], ioBad, statusSources)).toBe(2);
      expect(ioBad.err).toBe('');
      assertJsonErrorShape(ioBad.out, { id: 'seats.invocation', messageContains, repair: null });
    }
  });

  test('--json carries each seat’s state and state_source, and blind only where it applies', async () => {
    // herdr lists deepseek-acme and reports "blocked" — a word the reading does not take as one
    // of its own — the pane holds no screen, and its only trace is the record's own last_active
    // an hour before NOW, past the 30m blind threshold (src/labels/state.ts). The reading is
    // unknown from no source and blind: the seat counts as not working. The comparison's phrase
    // about the record stays `blocked`, so the reading is visibly its own thing beside it.
    live!.agents.find((listed) => listed.name === 'deepseek-acme')!.status = 'blocked';

    const ioSeats = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], ioSeats, statusSources)).toBe(0);
    const seatsDoc = JSON.parse(ioSeats.out) as SeatsJson;
    const blindSeat = seatsDoc.seats.find((row) => row.name === 'deepseek-acme');
    expect(blindSeat).toMatchObject({ state: 'unknown', state_source: 'none', blind: true });
    // The flag is present only where it applies: a seat that reads a word from a source
    // carries no `blind` key at all, not a false.
    const coordinator = seatsDoc.seats.find((row) => row.name === 'claude-coordinator-acme');
    expect(coordinator).toMatchObject({ state: 'working', state_source: 'trace' });
    expect(Object.keys(coordinator!)).not.toContain('blind');

    const ioStatus = testIo(dir, { kind: 'owner' });
    // The blind seat is a must-fix difference of its own (blindDifferences), so status exits 1
    // as any team with differences does — and still prints the document.
    expect(await runStatus(['--file', file, '--json'], ioStatus, statusSources)).toBe(1);
    const statusDoc = JSON.parse(ioStatus.out) as StatusJson;
    const statusRow = statusDoc.rows.find((row) => row.name === 'deepseek-acme')!;
    // `state` keeps its published meaning on a status row — the comparison's phrase about the
    // record — so the reading rides beside it as seat_state/seat_state_source.
    expect(statusRow.state).toBe('blocked');
    expect(statusRow).toMatchObject({ seat_state: 'unknown', seat_state_source: 'none', blind: true });
    // Without --all the expanded columns stay out, and the reading is on the row anyway.
    expect(Object.keys(statusRow)).not.toContain('role');
    expect(Object.keys(statusRow)).not.toContain('cli');
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
    expect(ioBad.err).toBe('');
    assertJsonErrorShape(ioBad.out, {
      id: 'seats.invocation',
      messageContains: "--watch and --json can't be used together",
      repair: null,
    });

    const ioMissing = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', join(dir, 'missing.yaml'), '--json'], ioMissing, statusSources)).toBe(2);
    expect(ioMissing.err).toBe('');
    assertJsonErrorShape(ioMissing.out, {
      id: 'seats.file',
      messageContains: 'no team file',
      repair: null,
    });

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

describe('the reading against a live herdr', () => {
  test("a live agent outranks the file's stopped word", async () => {
    // The file marks codex-acme stopped while herdr lists a working agent for it. The comparison
    // says so as a difference of its own (`marked stopped in the file and is running`) and keeps
    // its working row; the reading is the observation, never done/process from the file's word.
    const stoppedFile = example.replace('    parked: true\n', '    parked: true\n    stopped: true\n');
    if (stoppedFile === example) throw new Error('the fixture no longer carries the parked line');
    writeFileSync(file, stoppedFile);
    live!.agents.find((listed) => listed.name === 'codex-acme')!.status = 'working';
    const io = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], io, statusSources)).toBe(0);
    const doc = JSON.parse(io.out) as SeatsJson;
    const row = doc.seats.find((s) => s.name === 'codex-acme')!;
    expect(row.status).toBe('working, parked');
    expect(row.state).toBe('working');
    expect(row.state_source).toBe('herdr');
  });

  test('a retained record beside a live agent is still the observation', async () => {
    // A stale retained record outliving its seat: while herdr lists an agent for the name, the
    // reading is that agent's, not the retained record's done/process.
    updateState(join(dir, '.agents'), (state) => {
      const session = state.sessions['acme-web']!;
      session.retained_seats ??= {};
      session.retained_seats['codex-acme'] = { id: 'seat_666666666666', last_active: '2026-10-02T14:10:00Z' };
    });
    live!.agents.find((listed) => listed.name === 'codex-acme')!.status = 'working';
    const io = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], io, statusSources)).toBe(0);
    const doc = JSON.parse(io.out) as SeatsJson;
    const row = doc.seats.find((s) => s.name === 'codex-acme')!;
    expect(row.state).toBe('working');
    expect(row.state_source).toBe('herdr');
  });

  test("another seat's agent on a stale recorded pane is never this seat's reading", async () => {
    // deepseek-acme-2's record still names pane-2 — now codex-acme's pane, whose agent is named
    // codex-acme and working. herdr lists no agent for deepseek-acme-2, the comparison calls the
    // seat missing, and the reading is that: done/process, never another seat's working word and
    // never `LAST ACTIVE: now` borrowed from its pane.
    updateState(join(dir, '.agents'), (state) => {
      state.sessions['acme-web']!.seats['deepseek-acme-2']!.pane = 'pane-2';
    });
    live!.agents = live!.agents.filter((listed) => listed.name !== 'deepseek-acme-2');
    live!.agents.find((listed) => listed.name === 'codex-acme')!.status = 'working';
    const io = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], io, statusSources)).toBe(0);
    const doc = JSON.parse(io.out) as SeatsJson;
    const row = doc.seats.find((s) => s.name === 'deepseek-acme-2')!;
    expect(row.state).toBe('done');
    expect(row.state_source).toBe('process');
    expect(row.last_active).not.toBe(NOW.toISOString());
  });

  test('an unnamed agent on the recorded pane is still the seat', async () => {
    // The fallback keeps what the comparison flags as a rename: an agent left unnamed on the
    // pane the state records for the seat is the seat, and its idle word is read.
    live!.agents.find((listed) => listed.name === 'deepseek-acme-2')!.name = null;
    const io = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], io, statusSources)).toBe(0);
    const doc = JSON.parse(io.out) as SeatsJson;
    const row = doc.seats.find((s) => s.name === 'deepseek-acme-2')!;
    expect(row.state).toBe('idle');
    expect(row.state_source).toBe('herdr');
  });

  test('a process team did not launch is untrusted: no observed state', async () => {
    // The comparison calls deepseek-acme `restored, not launched by team`: the process in its
    // pane is not the one the launch recorded. Its screen and herdr's working word are not the
    // seat's — the reading is TeamCLI's own records, and nothing else: unknown, blind by age.
    updateState(join(dir, '.agents'), (state) => {
      state.sessions['acme-web']!.seats['deepseek-acme']!.launched = { shell: 100, cli: [200] };
    });
    live!.processes = { 'pane-3': { shell: 1, foreground: [2, 3] } };
    live!.agents.find((listed) => listed.name === 'deepseek-acme')!.status = 'working';
    const io = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], io, statusSources)).toBe(0);
    const doc = JSON.parse(io.out) as SeatsJson;
    const row = doc.seats.find((s) => s.name === 'deepseek-acme')!;
    expect(row.status).toBe('restored, not launched by team');
    expect(row.state).toBe('unknown');
    expect(row.state_source).toBe('none');
    expect(row.blind).toBe(true);
    expect(row.last_active).not.toBe(NOW.toISOString());
  });
});

describe('team status --all', () => {
  test('renders the 12-column registry table while preserving difference footer and notes', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const code = await runStatus(['--file', file, '--all'], io, statusSources);
    expect(code).toBe(0);
    expect(io.out).toContain('team acme-web, session "acme-web"');
    expect(io.out).toContain('SEAT                     NICKNAME  ID                 ROLE                 CLI          MODEL                                   EFFORT  STATUS                                STATE    SOURCE   LAST ACTIVE  PANE');
    expect(io.out).toContain('claude-coordinator-acme  -         seat_111111111111  project coordinator  claude-code  Claude Opus 5.5                         high    working                               working  trace    now          pane-1');
    expect(io.out).toContain('grok-acme                -         seat_555555555555  reviewer             grok         Grok 4.7                                -       stopped                               done     process  1d ago       -');
    expect(io.out).toContain('no differences');
    expect(io.out).toContain('note: codex-acme: its screen shows no model; the declared GPT-6 Sol stands, and the screen reading is unread');
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
    expect(ioBad.err).toBe('');
    assertJsonErrorShape(ioBad.out, {
      id: 'list.invocation',
      messageContains: "--watch and --json can't be used together",
      repair: null,
    });

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
    expect(ioTable.out).toContain('2 sessions');

    const ioJson = testIo(dir, { kind: 'owner' });
    expect(await runList(['--all', '--seats', '--json'], ioJson, listSources)).toBe(0);
    const parsed = (JSON.parse(ioJson.out) as { rows: ListSeatsRow[] }).rows;
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

  test('realSeatsSources.home lazily forwards realStatusSources.home', () => {
    expect(realSeatsSources.home).toBe(realStatusSources.home);
  });
});

describe('a seat\'s nickname', () => {
  test('is a column in seats and status --all, and a field in their JSON', async () => {
    const named = example.replace(
      '    launch: claude --model claude-opus-5-5\n',
      '    launch: claude --model claude-opus-5-5\n    nickname: zeus\n',
    );
    expect(named).not.toBe(example);
    writeFileSync(file, named);

    const io = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file], io, statusSources)).toBe(0);
    expect(io.out).toContain('claude-coordinator-acme  zeus      seat_111111111111  project coordinator');
    expect(io.out).toContain('codex-acme               -         seat_222222222222');

    const ioJson = testIo(dir, { kind: 'owner' });
    expect(await runSeats(['--file', file, '--json'], ioJson, statusSources)).toBe(0);
    const doc = JSON.parse(ioJson.out) as SeatsJson;
    expect(doc.seats.map((seat) => [seat.name, seat.nickname])).toEqual([
      ['claude-coordinator-acme', 'zeus'],
      ['codex-acme', null],
      ['deepseek-acme', null],
      ['deepseek-acme-2', null],
    ]);

    const ioAll = testIo(dir, { kind: 'owner' });
    expect(await runStatus(['--file', file, '--all', '--json'], ioAll, statusSources)).toBe(0);
    const status = JSON.parse(ioAll.out) as StatusJson;
    expect(status.rows.find((row) => row.name === 'claude-coordinator-acme')?.nickname).toBe('zeus');
  });
});

