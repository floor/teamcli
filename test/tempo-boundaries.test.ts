// Adversarial boundaries around the team tempo: the scaling never leaves its stated
// bounds, the word list is closed at the command, an ordinary approval cannot move the
// key, and an unapproved tempo never reaches the watch in either direction. The builder's
// tempo.test.ts pins the happy scaling, the line editor and the caller gate; every row
// here is the other side of one of those.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf, watchInForceOf } from '../src/approve/approval.ts';
import { compare, describe as describeDifference, fingerprints } from '../src/approve/fingerprint.ts';
import type { Caller, CallerSources, Process } from '../src/caller.ts';
import { runTempo, setTempo } from '../src/commands/tempo.ts';
import { runApprove, type ApproveSources } from '../src/approve/command.ts';
import { delegateGate, type DelegateVerdict } from '../src/delegate.ts';
import { applyTempo } from '../src/file/sections/tempo.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, updateState } from '../src/state.ts';
import { readApproval, storePath, writeApproval, type Standing } from '../src/store/store.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
watch:
  idle_first: 10m
  idle_repeat: 20m
  team_idle: 10m
  nudge_wait: 10m
  unsent_after: 1m
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function parsed(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function verified(file: string, team: TeamFile): Extract<Standing, { kind: 'verified' }> {
  return {
    kind: 'verified',
    generation: 1,
    signedAt: '2026-10-14T00:00:00.000Z',
    record: { approval: approvalOf(team, '/proj'), file },
  };
}

/** A record from before the key: the stored fingerprints have no `tempo`. */
function predating(file: string, team: TeamFile): Extract<Standing, { kind: 'verified' }> {
  const standing = verified(file, team);
  const { tempo: _omitted, ...sections } = standing.record.approval.fingerprints.sections;
  standing.record.approval.fingerprints = { ...standing.record.approval.fingerprints, sections };
  return standing;
}

describe('the scaling stays inside its bounds', () => {
  const watch = (over: Partial<TeamFile['watch']>): TeamFile['watch'] => ({
    interval: 120,
    idleFirst: 600,
    idleOwner: 900,
    blindAfter: 300,
    teamIdle: 600,
    nudgeWait: 600,
    unsentAfter: 60,
    unreadAfter: 600,
    quotaMarks: [],
    checks: [],
    ...over,
  });

  test('the smallest whole-second table never scales below one second', () => {
    const smallest = watch({ idleFirst: 1, idleRepeat: 1, teamIdle: 1, nudgeWait: 1, unsentAfter: 1, unreadAfter: 1 });
    for (const word of ['relaxed', 'urgent'] as const) {
      const scaled = applyTempo(smallest, word);
      for (const key of ['idleFirst', 'idleRepeat', 'teamIdle', 'nudgeWait', 'unsentAfter', 'unreadAfter'] as const) {
        expect(scaled[key]).toBe(word === 'relaxed' ? 2 : 1);
      }
    }
  });

  test('a fractional wait floors at one rather than rounding to zero', () => {
    expect(applyTempo(watch({ unsentAfter: 0.5 }), 'urgent').unsentAfter).toBe(1);
    expect(applyTempo(watch({ nudgeWait: 0.5 }), 'relaxed').nudgeWait).toBe(1);
    expect(applyTempo(watch({ unreadAfter: 0.5 }), 'urgent').unreadAfter).toBe(1);
  });

  test('every scaled value stays a whole number at or above one, both directions', () => {
    const odd = watch({ idleFirst: 5, idleRepeat: 15, teamIdle: 25, nudgeWait: 45, unsentAfter: 90, unreadAfter: 55 });
    for (const word of ['relaxed', 'urgent'] as const) {
      const scaled = applyTempo(odd, word);
      for (const key of ['idleFirst', 'idleRepeat', 'teamIdle', 'nudgeWait', 'unsentAfter', 'unreadAfter'] as const) {
        expect(Number.isInteger(scaled[key])).toBe(true);
        expect(scaled[key] as number).toBeGreaterThanOrEqual(1);
      }
    }
    // Halving rounds to the nearest second, halves up: 5->3, 15->8, 25->13, 45->23, 90->45, 55->28.
    const urgent = applyTempo(odd, 'urgent');
    expect([urgent.idleFirst, urgent.idleRepeat, urgent.teamIdle, urgent.nudgeWait, urgent.unsentAfter, urgent.unreadAfter])
      .toEqual([3, 8, 13, 23, 45, 28]);
  });

  test('the pass rate and the checks are not scaled or rebuilt', () => {
    const checks = ['npm test'];
    const withChecks = watch({ checks });
    for (const word of ['relaxed', 'urgent'] as const) {
      const scaled = applyTempo(withChecks, word);
      expect(scaled.interval).toBe(withChecks.interval);
      expect(scaled.checks).toBe(checks);
    }
  });
});

describe('the word list is closed at the command', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function place(text: string = TEAM): { root: string; home: string; file: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'tempo-bounds-')));
    made.push(base);
    const root = join(base, 'acme');
    const home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    const file = join(root, '.agents', 'team.yaml');
    writeFileSync(file, text);
    return { root, home, file };
  }

  test('a missing word and an extra word are refused before anything is read', async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'tempo-bounds-')));
    made.push(empty);
    const bare = testIo(empty, { kind: 'owner' });
    expect(await runTempo([], bare)).toBe(2);
    expect(bare.err).toContain('a word is required');
    expect(bare.err).toContain('Usage: team tempo <word>');
    const extra = testIo(empty, { kind: 'owner' });
    expect(await runTempo(['urgent', 'now'], extra)).toBe(2);
    expect(extra.err).toContain('unexpected "now"');
  });

  test('no flag is accepted', async () => {
    const where = place();
    const before = readFileSync(where.file, 'utf8');
    const io = testIo(where.root, { kind: 'owner' });
    expect(await runTempo(['--later', 'urgent'], io, { home: where.home })).toBe(2);
    expect(io.err).toContain('Usage: team tempo <word>');
    expect(readFileSync(where.file, 'utf8')).toBe(before);
  });

  test('a file whose tempo line is empty is refused, not repaired', async () => {
    const where = place(`${TEAM}tempo:\n`);
    const before = readFileSync(where.file, 'utf8');
    const io = testIo(where.root, { kind: 'owner' });
    expect(await runTempo(['urgent'], io, { home: where.home })).toBe(2);
    expect(io.err).toContain('tempo must be one of');
    expect(readFileSync(where.file, 'utf8')).toBe(before);
  });
});

describe('an ordinary approval cannot change the tempo', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // The delegated gate, admitted as far as the ordinary-change guard: the caller is the
  // placed delegate, the approved copy omits `tempo`, and the live file is the same file
  // with a real word set — the scene a delegate would actually try to land.
  const land = realpathSync(mkdtempSync(join(tmpdir(), 'tempo-delegate-')));
  made.push(land);
  const yaml = `format: 1
project: acme
session: alpha
coordinator: lead
operator: lead
workspace:
  mode: shared
trust:
  - ${land}
rules:
  - Keep every change on a branch.
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
delegates:
  - pane: other/w1:p1
    commands: [up, approve]
`;
  const under: Process[] = [{ pid: 100, name: 'zsh' }, { pid: 10, name: 'herdr' }];
  const agent = (name: string | null, pane: string): HerdrAgent => ({
    name,
    agent: 'claude',
    pane,
    workspace: pane.split(':')[0] ?? '',
    status: 'idle',
    cwd: null,
  });

  function gateVerdict(team: TeamFile): DelegateVerdict {
    return delegateGate({
      command: 'approve',
      team,
      root: '/proj',
      dir: '/proj/.agents',
      flags: [],
      io: { env: {}, stdinIsTTY: true },
      sources: {
        standing: () => verified(yaml, parsed(yaml)) as Extract<Standing, { kind: 'verified' }>,
        state: () => ({ format: 1, sessions: {} }),
        agents: (session: string) => (session === 'other' ? [agent('worker', 'w1:p1')] : []),
        sessionRunning: () => null,
        callerSources: (session: string | undefined): CallerSources => ({
          ancestors: () => under,
          agents: () => (session === undefined ? [] : [agent('worker', 'w1:p1')]),
          paneRootPid: (pane) => (pane === 'w1:p1' ? 100 : null),
          env: {},
          stdinIsTTY: true,
        }),
      },
    });
  }

  test('a delegate approving a real word is refused by name', () => {
    const candidate = parsed(setTempo(yaml, 'urgent'));
    expect(gateVerdict(candidate)).toEqual({
      kind: 'refused',
      id: 'approve.delegate-not-ordinary',
      text: 'this change needs the owner: `tempo` changed',
    });
  });

  // The granted orchestrator, end to end: the file's only edit is `tempo: urgent`, the
  // grant lists approve, and the run still refuses and signs nothing.
  const GRANT = `format: 1
project: acme
session: alpha
operator: lead
workspace:
  mode: shared
rules:
  - Keep every change on a branch.
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
grant:
  session: alpha
  seat: lead
  scope:
    - approve
`;
  const T = new Date('2026-10-14T12:00:00.000Z');
  const lead: Caller = { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'alpha' };

  function grantedPlace(): { base: string; home: string; root: string; file: string; dir: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'tempo-grant-')));
    made.push(base);
    const home = join(base, 'home');
    const root = join(base, 'acme');
    const dir = join(root, '.agents');
    mkdirSync(home, { recursive: true });
    mkdirSync(dir, { recursive: true });
    return { base, home, root, file: join(dir, 'team.yaml'), dir };
  }

  test('a granted orchestrator is refused and the record is left alone', async () => {
    const here = grantedPlace();
    const team = parsed(GRANT);
    writeFileSync(here.file, GRANT);
    writeApproval(storePath(team.project, here.root, here.home), { approval: approvalOf(team, here.root, T), file: GRANT }, team.seats, here.home);
    updateState(here.dir, (state) => {
      const session = (state.sessions.alpha ??= emptySession());
      session.seats.lead = { stage: 'ready', pane: 'lead-pane' };
    });
    const candidate = setTempo(GRANT, 'urgent');
    writeFileSync(here.file, candidate);
    const before = readApproval(storePath(team.project, here.root, here.home));

    const io = testIo(here.root, lead);
    const sources: ApproveSources = {
      ask: async () => {
        throw new Error('a granted approve asked a question');
      },
      waiting: (): never => {
        throw new Error('a granted approve read the terminal');
      },
      now: () => T,
      home: here.home,
    };
    expect(await runApprove([], io, sources)).toBe(1);
    expect(io.err).toContain('this change needs the owner: `tempo` changed');
    expect(readApproval(storePath(team.project, here.root, here.home))).toEqual(before);
    expect(existsSync(join(here.dir, 'team.log'))).toBe(false);
  });
});

describe('the live tempo reaches the watch in either direction', () => {
  test('a relaxed edit scales waits even with a record from before the key', () => {
    const old = predating(TEAM, parsed(TEAM));
    const relaxed = parsed(setTempo(TEAM, 'relaxed'));
    expect(compare(old.record.approval.fingerprints, fingerprints(relaxed)).map(describeDifference))
      .toEqual(['`tempo` changed']);
    // The live relaxed word doubles the wait even with a predating record.
    expect(watchInForceOf(old, relaxed).idleFirst).toBe(1200);
  });

  test('a live revert to normal restores the unscaled waits', () => {
    const urgentText = setTempo(TEAM, 'urgent');
    const approved = verified(urgentText, parsed(urgentText));
    const reverted = parsed(TEAM);
    expect(compare(approved.record.approval.fingerprints, fingerprints(reverted)).map(describeDifference))
      .toEqual(['`tempo` changed']);
    // The live normal word restores the unscaled wait.
    expect(watchInForceOf(approved, reverted).idleFirst).toBe(600);
  });
});
