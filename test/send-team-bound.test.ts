// A plain seat name written by a seat placed in one team while it stands in another team's folder.
// Two teams each have a seat named `orchestrator`; the scene that started this: the floor lead
// ran `team send orchestrator` from the material folder, the name resolved in its own team, and
// the frame woke the sender itself while the command printed "delivered".
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { selfAddressed } from '../src/commands/send.ts';
import { setHerdrRun } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { resolveTarget, type Target } from '../src/send/resolve.ts';
import { emptySession, updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, fixtureScratchRoot, gitEnv, testIo } from './helpers.ts';

const made: string[] = [];
beforeEach(() => setHerdrRun(() => { throw new Error('no real terminal host in these scenes'); }));
afterEach(() => {
  setHerdrRun(null);
  discardFixtures(made.splice(0), { roots: [fixtureScratchRoot()] });
});

function teamText(home: string, root: string, name: string, seats: string[]): string {
  const seat = (seatName: string) => `  - role: ${seatName === 'orchestrator' ? 'coordinator' : 'implementer'}
    name: ${seatName}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  return `format: 1
project: ${name}
session: ${name}
coordinator: orchestrator
operator: orchestrator
trust:
  - ${lobbyDir(home)}
  - ${root}
workspace:
  mode: shared
seats:
${seats.map(seat).join('')}`;
}

/** Two sibling teams, each with an `orchestrator`; `gamma` has none. Only alpha's lead is tied. */
function world() {
  const base = fixtureBase('send-team-bound-');
  made.push(base);
  const home = join(base, 'home');
  const alpha = join(base, 'alpha');
  const beta = join(base, 'beta');
  const gamma = join(base, 'gamma');
  for (const folder of [home, alpha, beta, gamma, lobbyDir(home)]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config.source: file\n');
  const teams: Array<[string, string, string[]]> = [
    [alpha, 'alpha', ['orchestrator', 'worker']],
    [beta, 'beta', ['orchestrator', 'worker']],
    [gamma, 'gamma', ['worker']],
  ];
  for (const [root, name, seats] of teams) {
    mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(home, root, name, seats));
    upsertTeam(home, teamIdOf(root), { root, project: name, session: name, entity: null,
      roster: seats.map((seat) => ({ seat, role: 'operator', agent: '' })) });
    updateState(join(root, '.agents'), (state) => {
      const session = state.sessions[name] ??= emptySession();
      // alpha's lead is tied on its pane; beta's lead was restored by the terminal host and is not.
      if (name === 'alpha') session.seats.orchestrator = { stage: 'ready', pane: 'alpha-lead' };
    });
    for (const seat of seats) {
      registerAgent(home, { name: seat, signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
        lab: 'anthropic', cli: 'claude-code', launcher: null, launch: 'claude --model claude-opus-5-5',
        reach: { team: teamIdOf(root), seat, session: name, pane: `${name}-${seat === 'orchestrator' ? 'lead' : seat}`, address: null },
        mcp: [], skills: [], lifecycle: 'running', by: 'the send-team-bound scene' });
    }
  }
  return { home, alpha, beta, gamma };
}

const alphaLead: Caller = { kind: 'seat', name: 'orchestrator', pane: 'alpha-lead', session: 'alpha' };
const live = () => [];

test('a placed lead in another team\'s folder writing a seat both teams have is refused, naming both addresses', () => {
  const w = world();
  const result = resolveTarget(w.home, 'orchestrator', testIo(w.beta, alphaLead), live);
  expect('error' in result).toBe(true);
  if (!('error' in result)) return;
  expect(result.kind).toBe('ambiguous');
  expect(result.error).toContain(`orchestrator@${teamIdOf(w.alpha)}`);
  expect(result.error).toContain(`orchestrator@${teamIdOf(w.beta)}`);
  expect(result.error).toContain('nothing was sent');
});

test('the full address still reaches the untied lead of the other team, never the caller\'s own', () => {
  const w = world();
  const result = resolveTarget(w.home, `orchestrator@${teamIdOf(w.beta)}`, testIo(w.beta, alphaLead), live);
  expect('error' in result, JSON.stringify(result)).toBe(false);
  if ('error' in result) return;
  expect(result.team.root).toBe(w.beta);
  expect(result.agent.reach.session).toBe('beta');
});

test('in its own folder the placed lead keeps its own team', () => {
  const w = world();
  const result = resolveTarget(w.home, 'worker', testIo(w.alpha, alphaLead), live);
  expect('error' in result, JSON.stringify(result)).toBe(false);
  if (!('error' in result)) expect(result.team.root).toBe(w.alpha);
});

test('a folder whose team lacks the seat keeps the placed resolution', () => {
  const w = world();
  const result = resolveTarget(w.home, 'orchestrator', testIo(w.gamma, alphaLead), live);
  expect('error' in result, JSON.stringify(result)).toBe(false);
  if (!('error' in result)) expect(result.team.root).toBe(w.alpha);
});

test('the reverse: an unplaced caller in alpha\'s folder addresses alpha, not beta', () => {
  const w = world();
  const unplaced: Caller = { kind: 'unplaced', reason: 'synthetic' };
  const result = resolveTarget(w.home, 'orchestrator', testIo(w.alpha, unplaced), live);
  expect('error' in result, JSON.stringify(result)).toBe(false);
  if (!('error' in result)) expect(result.team.root).toBe(w.alpha);
});

test('a seat sending to its own seat is refused, by the resolved aim; the same name in another team is not itself', () => {
  const w = world();
  const own = { seat: 'orchestrator', root: w.alpha, session: 'alpha' };
  expect(selfAddressed(alphaLead, 'orchestrator', own, w.alpha)).toContain('that is your own seat');
  // The written words do not decide: a nickname that resolved to the sender's own seat is the sender.
  expect(selfAddressed(alphaLead, 'Atlas', own, w.alpha)).toContain('Atlas: that is your own seat');
  const other = resolveTarget(w.home, `orchestrator@${teamIdOf(w.beta)}`, testIo(w.alpha, alphaLead), live) as Target;
  expect(selfAddressed(alphaLead, 'orchestrator', { seat: other.agent.reach.seat, root: other.team.root, session: other.agent.reach.session }, w.alpha)).toBeNull();
  expect(selfAddressed(alphaLead, 'worker', { seat: 'worker', root: w.alpha, session: 'alpha' }, w.alpha)).toBeNull();
  expect(selfAddressed(alphaLead, 'orchestrator', { seat: 'orchestrator', root: w.alpha, session: 'other' }, w.alpha)).toBeNull();
  expect(selfAddressed({ kind: 'owner' }, 'orchestrator', own, w.alpha)).toBeNull();
});
