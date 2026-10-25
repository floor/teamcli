// The entity model rule as a `team check` difference (Policies rule 10): every breaching seat of
// the team the check runs in is one difference, naming the rule, the seat's vendor and the swap
// proposed — or why none is — and repaired with `team swap queue <seat>`. The repair is the
// team's lead's, not the grant holder `whoFromCommand` would read from the command name alone. A
// rule that cannot be read is a note, never an empty rule; another team of the entity is not this
// team's difference; and a check with no home reads no rule at all.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { setHerdrRun } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');

const KEEPER = 'w1:p1';
const WORKER = 'w2:p1';

const TEAM = `format: 1
project: beacon
session: beacon
entity: lab
coordinator: keeper
operator: keeper
workspace:
  mode: shared
seats:
  - role: coordinator
    name: keeper
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "4.0"
    launch: claude --model deepseek-flash
`;

// The same team with no entity: a model rule holds at entity level only.
const PLAIN = TEAM.replace('entity: lab\n', '');

const loaded = validateTeamFile(TEAM);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const SEATS = loaded.team.seats;

const made: string[] = [];
beforeEach(() => {
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});
afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; root: string; home: string; dir: string };

function world(text = TEAM): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-rule-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'beacon');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), text);
  return { base, root, home, dir: join(root, '.agents') };
}

function setRule(home: string, value: string): void {
  const wrote = writePolicySet(home, { level: 'entity', target: 'lab', name: 'model-rule', value }, { now: NOW });
  if (!wrote.ok) throw new Error(wrote.why);
}

/** The state two launches leave: both seats ready on their own pane, both briefs delivered. */
function started(w: World): void {
  for (const [i, seat] of SEATS.entries()) {
    updateState(w.dir, (state) => {
      const session = (state.sessions.beacon ??= emptySession());
      session.watch = { pid: 1, heartbeat: NOW.toISOString() };
      session.seats[seat.name] = { stage: 'ready', pane: i === 0 ? KEEPER : WORKER, workspace: `w${i + 1}` };
    });
  }
  deliverBriefs({
    dir: w.dir,
    root: w.root,
    session: 'beacon',
    seats: SEATS.map((seat) => seat.name),
    home: w.home,
    at: NOW.toISOString(),
  });
}

function liveAll(): Live {
  return {
    running: true,
    agents: SEATS.map((seat, i) => ({
      name: seat.name,
      agent: 'claude',
      pane: i === 0 ? KEEPER : WORKER,
      workspace: `w${i + 1}`,
      status: 'idle',
      cwd: null,
    })),
    workspaces: SEATS.map((seat, i) => ({ id: `w${i + 1}`, label: workspaceLabel(seat) })),
    screens: { [KEEPER]: CLAUDE_IDLE, [WORKER]: CLAUDE_IDLE },
  };
}

function check(
  w: World,
  argv: { json?: boolean } = {},
  live: Live = liveAll(),
  home: string | null = w.home,
): { code: number; out: string; err: string } {
  const io = testIo(w.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml', ...argv }, io, {
    live: () => live,
    branch: () => 'main',
    standing: (at) => approvalStanding(at, home ?? w.root),
    now: () => NOW,
    home: home ?? undefined,
  });
  return { code, out: io.out, err: io.err };
}

const THE_DIFFERENCE =
  'difference: keeper: declares vendor anthropic, which the entity model rule *=!anthropic refuses; a swap to claude-code DeepSeek Flash 4.0 from beacon/worker is proposed';

describe('team check names a seat the entity model rule refuses', () => {
  test('a breaching seat is one difference, repaired by the lead with the queue', () => {
    const w = world();
    started(w);
    setRule(w.home, '*=!anthropic');
    const { code, out } = check(w);
    expect(out).toContain(THE_DIFFERENCE);
    expect(out).toContain('  repair: team swap queue keeper');
    expect(out).toContain("  who: the team's lead");
    expect(code).toBe(1);
  });

  test('--json carries the same repair and who', () => {
    const w = world();
    started(w);
    setRule(w.home, '*=!anthropic');
    const { code, out } = check(w, { json: true });
    expect(code).toBe(1);
    const doc = JSON.parse(out) as { differences: Array<{ what: string; repair: string; who: string }> };
    const found = doc.differences.find((d) => d.what.startsWith('keeper: declares vendor anthropic'));
    expect(found).toEqual({ what: THE_DIFFERENCE.slice('difference: '.length), repair: 'team swap queue keeper', who: "the team's lead" });
  });

  test('an allowed seat is not named', () => {
    const w = world();
    started(w);
    setRule(w.home, '*=!anthropic');
    const { out } = check(w);
    expect(out).not.toContain('difference: worker:');
  });

  test('no recipe is a difference in its own words, with the same repair', () => {
    const w = world();
    started(w);
    // Both seats run anthropic: nothing of the entity may be copied, and the reason is the line.
    writeFileSync(
      join(w.root, '.agents/team.yaml'),
      TEAM.replace('vendor: deepseek', 'vendor: anthropic').replace('model: DeepSeek Flash', 'model: Claude Opus').replace('launch: claude --model deepseek-flash', 'launch: claude --model claude-opus-5-5'),
    );
    setRule(w.home, '*=!anthropic');
    const io = testIo(w.root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
      live: liveAll,
      branch: () => 'main',
      standing: (at) => approvalStanding(at, w.home),
      now: () => NOW,
      home: w.home,
    });
    expect(io.out).toContain(
      'difference: keeper: declares vendor anthropic, which the entity model rule *=!anthropic refuses; no seat of the entity on a team of the same visibility runs a model the rule allows here',
    );
    expect(io.out).toContain('  repair: team swap queue keeper');
    expect(io.out).not.toContain('is proposed');
    expect(code).toBe(1);
  });

  test('a team declaring no entity reads no rule', () => {
    const w = world(PLAIN);
    started(w);
    setRule(w.home, '*=!anthropic');
    const { code, out } = check(w);
    expect(out).not.toContain('model rule');
    expect(code).toBe(0);
  });

  test('an entity with no model-rule is not a difference', () => {
    const w = world();
    started(w);
    const { code, out } = check(w);
    expect(out).not.toContain('model rule');
    expect(code).toBe(0);
  });

  test('a rule that cannot be read is a note, never an empty rule', () => {
    const w = world();
    started(w);
    writeFileSync(join(w.home, '.config/team/entities.yaml'), '- not a map\n');
    const { out } = check(w);
    expect(out).toContain('note: the entity model rule cannot be read, so no breach is judged:');
    expect(out).not.toContain('which the entity model rule');
  });

  test("another team's breach is not this team's difference", () => {
    const w = world();
    started(w);
    const other = join(w.base, 'outpost');
    mkdirSync(join(other, '.agents'), { recursive: true });
    writeFileSync(
      join(other, '.agents/team.yaml'),
      TEAM.replace('project: beacon', 'project: outpost').replace('name: keeper', 'name: outrider'),
    );
    upsertTeam(w.home, teamIdOf(other), { project: 'outpost', session: 'outpost', root: other, at: NOW.toISOString() });
    setRule(w.home, '*=!anthropic');
    const { out } = check(w);
    expect(out).toContain('difference: keeper:');
    expect(out).not.toContain('outrider');
  });

  test('a check with no home reads no rule', () => {
    const w = world();
    started(w);
    setRule(w.home, '*=!anthropic');
    const { code, out } = check(w, {}, liveAll(), null);
    expect(out).not.toContain('model rule');
    expect(code).toBe(0);
  });
});
