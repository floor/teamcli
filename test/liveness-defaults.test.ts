// The liveness defaults: an idle seat is reported to its lead at five minutes, to the owner at
// fifteen, and a seat no source has heard from reads blind at five. They are settings in the
// inheritance — machine, entity, project, team — and every level may tighten one, never loosen it:
// a looser word is set aside where the thresholds resolve, the value in force standing, and the
// watch says the rule once.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateLimitsOf } from '../src/commands/seats.ts';
import { applyTempo } from '../src/file/sections/tempo.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { watchWords } from '../src/settings/declared.ts';
import {
  DEFAULT_LIVENESS_THRESHOLDS,
  LIVENESS_RULE,
  livenessOf,
  sayThreshold,
} from '../src/settings/inherit.ts';
import { stateThresholds, thresholdRefusals } from '../src/settings/resolve.ts';
import { emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, pass, type Report } from '../src/watch/pass.ts';

const MIN = 60_000;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;

/** A two-seat team — a lead, and one worker — with the watch words, entity name and worker
 *  fields the case declares. */
function fileWith(watch: string, extra: { entity?: string; worker?: string } = {}): string {
  return `
format: 1
project: quiet
${extra.entity === undefined ? '' : `entity: ${extra.entity}\n`}workspace:
  mode: shared
coordinator: claude-lead
operator: claude-lead
${watch}seats:
  - role: coordinator
    name: claude-lead
    label: claude-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: claude-worker
    label: claude-worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${extra.worker ?? ''}`;
}

function valid(source: string): TeamFile {
  const result = validateTeamFile(source);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function agent(name: string, status: string): HerdrAgent {
  return { name, agent: 'claude', pane: `${name}:p1`, workspace: name, status, cwd: null };
}

/** The lead at its own idle prompt, and the worker in the state the case shows. */
function scene(worker: { status: string; screen: string }): Live {
  const agents = [agent('claude-lead', 'idle'), agent('claude-worker', worker.status)];
  return {
    running: true,
    agents,
    workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    screens: { 'claude-lead:p1': idle, 'claude-worker:p1': worker.screen },
  };
}

const quiet = scene({ status: 'idle', screen: idle });
const working = scene({ status: 'working', screen: busy });

function at(team: TeamFile, now: number, live: Live, memory: ReturnType<typeof newMemory>, liveness?: Parameters<typeof pass>[0]['liveness']) {
  return pass({
    team, watch: team.watch, state: emptySession(), live, machine: fine, now, memory,
    ...(liveness !== undefined ? { liveness } : {}),
  });
}

const texts = (reports: Report[]) => reports.map((report) => report.text);

/** The three liveness windows and every word set aside, from the one chain the reading resolves. */
function resolve(declared: Parameters<typeof stateThresholds>[0]) {
  return { thresholds: livenessOf(stateThresholds(declared)), refused: thresholdRefusals(declared) };
}

describe('the shipped liveness defaults', () => {
  test('five minutes to the lead, fifteen to the owner, five to blind — and no word to refuse', () => {
    expect(DEFAULT_LIVENESS_THRESHOLDS)
      .toEqual({ idle_lead_seconds: 300, idle_owner_seconds: 900, blind_after_seconds: 300 });
    const resolved = resolve({});
    expect(resolved.thresholds).toEqual(DEFAULT_LIVENESS_THRESHOLDS);
    expect(resolved.refused).toEqual([]);
  });

  test('a level may tighten any of the three, and a word equal to the value in force is no word', () => {
    expect(resolve({ project: { idle_lead_seconds: 60, idle_owner_seconds: 120, blind_after_seconds: 30 } }).thresholds)
      .toEqual({ idle_lead_seconds: 60, idle_owner_seconds: 120, blind_after_seconds: 30 });
    // The tightest level wins, and each setting moves on its own.
    expect(resolve({ project: { blind_after_seconds: 120 }, team: { blind_after_seconds: 60 } }).thresholds.blind_after_seconds)
      .toBe(60);
    const equal = resolve({ project: { idle_lead_seconds: DEFAULT_LIVENESS_THRESHOLDS.idle_lead_seconds } });
    expect(equal.refused).toEqual([]);
    expect(equal.thresholds.idle_lead_seconds).toBe(300);
  });

  test('a project may not loosen: the word is set aside, the value in force stands, and the text names the rule', () => {
    const looser = resolve({ project: { idle_lead_seconds: 600 } });
    expect(looser.thresholds.idle_lead_seconds).toBe(300);
    expect(looser.refused).toEqual([{
      setting: 'idle_lead_seconds',
      level: 'project',
      value: 600,
      inherited: 300,
      text: `liveness_idle_lead_seconds: the project declared ${sayThreshold(600)}, longer than the ${sayThreshold(300)} in force — ${LIVENESS_RULE}`,
    }]);
    expect(looser.refused[0]?.text)
      .toBe('liveness_idle_lead_seconds: the project declared 10m, longer than the 5m in force — a liveness threshold may be tightened, never loosened, unless the level above allows it');
  });

  test('no level inside the project may loosen either: the team and the seat are set aside the same way', () => {
    for (const level of ['team', 'seat'] as const) {
      const looser = resolve({ [level]: { idle_owner_seconds: 1800 } });
      expect(looser.thresholds.idle_owner_seconds).toBe(900);
      expect(looser.refused.map((word) => [word.level, word.value])).toEqual([[level, 1800]]);
    }
  });
});

describe('the idle check reports by the thresholds in force', () => {
  // The team's own words: a minute to the lead, three to the owner, so both stages land apart.
  const team = () => valid(fileWith('watch:\n  idle_first: 1m\n  idle_owner: 3m\n'));

  test('the lead is told at idle_first, the owner at idle_owner, once per idle period', () => {
    const memory = newMemory();
    const t = team();
    expect(texts(at(t, 0, quiet, memory).reports)).toEqual([]);
    expect(at(t, 1 * MIN, quiet, memory).reports)
      .toEqual([{ key: 'idle:claude-worker', text: 'claude-worker has been idle since the watch started', to: 'operator' }]);
    // Nothing between the two stages, and the owner's line once.
    expect(texts(at(t, 2 * MIN, quiet, memory).reports)).toEqual([]);
    expect(at(t, 3 * MIN, quiet, memory).reports)
      .toEqual([{ key: 'idle-owner:claude-worker', text: 'claude-worker has been idle since the watch started — reported to the owner', to: 'owner' }]);
    expect(texts(at(t, 4 * MIN, quiet, memory).reports)).toEqual([]);
  });

  test('work resets the period: the lead hears again after idle_first, the owner after idle_owner', () => {
    const memory = newMemory();
    const t = team();
    at(t, 0, quiet, memory);
    at(t, 1 * MIN, quiet, memory);
    at(t, 3 * MIN, quiet, memory);
    // The worker runs a turn, and the clock starts again at its end.
    at(t, 4 * MIN, working, memory);
    expect(texts(at(t, 6 * MIN, quiet, memory).reports)).toEqual(['claude-worker has been idle for 2 minutes']);
    expect(texts(at(t, 7 * MIN, quiet, memory).reports))
      .toEqual(['claude-worker has been idle for 3 minutes — reported to the owner']);
  });

  test('a team that declares a looser word runs the default, and the pass names the rule', () => {
    // Ten minutes is longer than the five in force: the word is set aside.
    const t = valid(fileWith('watch:\n  idle_first: 10m\n'));
    const memory = newMemory();
    at(t, 0, quiet, memory);
    // Five minutes in, the lead hears — the default, not the team's ten.
    expect(texts(at(t, 5 * MIN, quiet, memory).reports)).toEqual(['claude-worker has been idle since the watch started']);
    const result = at(t, 10 * MIN, quiet, memory);
    // The lead's line stays said; ten minutes of a wholly idle team is the team-idle line alone.
    expect(texts(result.reports)).toEqual(['every agent is idle']);
    expect(result.refusals).toEqual([{
      setting: 'idle_lead_seconds',
      level: 'team',
      value: 600,
      inherited: 300,
      text: `liveness_idle_lead_seconds: the team declared ${sayThreshold(600)}, longer than the ${sayThreshold(300)} in force — ${LIVENESS_RULE}`,
    }]);
  });

  test('a seat\'s own word moves its report, and no other seat\'s', () => {
    const t = valid(fileWith('', { worker: '    liveness:\n      idle_lead_seconds: 30\n' }));
    const memory = newMemory();
    at(t, 0, quiet, memory);
    expect(texts(at(t, 30_000, quiet, memory).reports))
      .toEqual(['claude-worker has been idle since the watch started']);
    // Short of the forty-five seconds: nothing yet.
    expect(texts(at(t, 20_000, quiet, newMemory()).reports)).toEqual([]);
  });

  test('tempo scales the window after the tighten-only check', () => {
    const t = valid(fileWith('watch:\n  idle_first: 2m\n'));
    const run = (word: 'relaxed' | 'urgent', now: number, memory: ReturnType<typeof newMemory>) => pass({
      team: t, watch: applyTempo(t.watch, word), state: emptySession(), live: quiet, machine: fine, now, memory,
      livenessTeam: watchWords(t.watch), tempo: word,
    });
    // The team's two minutes is a tightening and stands; relaxed then doubles the resolved
    // window to four minutes, with no refusal line for the longer value.
    const memory = newMemory();
    expect(run('relaxed', 0, memory).refusals).toEqual([]);
    expect(texts(run('relaxed', 2 * MIN, memory).reports)).toEqual([]);
    expect(texts(run('relaxed', 4 * MIN, memory).reports))
      .toEqual(['claude-worker has been idle since the watch started']);
    // Urgent halves it to one minute.
    const urgent = newMemory();
    expect(texts(run('urgent', 0, urgent).reports)).toEqual([]);
    expect(texts(run('urgent', 30_000, urgent).reports)).toEqual([]);
    expect(texts(run('urgent', 60_000, urgent).reports))
      .toEqual(['claude-worker has been idle since the watch started']);
  });

  test('the pass reads the levels above the team too: a project may tighten, a looser project word is set aside', () => {
    const t = team();
    const memory = newMemory();
    // The project brings the lead's report forward to half a minute.
    at(t, 0, quiet, memory, { project: { idle_lead_seconds: 30 } });
    expect(texts(at(t, 30_000, quiet, memory, { project: { idle_lead_seconds: 30 } }).reports))
      .toEqual(['claude-worker has been idle since the watch started']);

    // A longer project word changes nothing and comes back as a refusal; the team's minute runs.
    const loose = newMemory();
    const word = { project: { idle_lead_seconds: 3600 } };
    at(t, 0, quiet, loose, word);
    expect(texts(at(t, 30_000, quiet, loose, word).reports)).toEqual([]);
    expect(texts(at(t, 60_000, quiet, loose, word).reports))
      .toEqual(['claude-worker has been idle since the watch started']);
    const settled = at(t, 60_000, quiet, newMemory(), { project: { idle_lead_seconds: 3600 } });
    expect(settled.refusals.map((word) => [word.level, word.setting, word.inherited]))
      .toEqual([['project', 'idle_lead_seconds', 300]]);
  });
});

describe('the blind threshold is the same liveness default', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'team-liveness-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('a team may tighten it, and the reading runs by the tightened value', () => {
    const t = valid(fileWith('watch:\n  blind_after: 2m\n'));
    expect(stateLimitsOf(t, undefined, 'quiet-team').blind_after_seconds).toBe(120);
    // No team file words at all: the shipped five minutes.
    expect(stateLimitsOf(valid(fileWith('')), undefined, 'quiet-team').blind_after_seconds).toBe(300);
  });

  test('a project record may tighten it, and the project is the one level that may open it', () => {
    upsertProject(home, 'quiet-project', {
      name: 'Quiet', teams: ['quiet-team'], liveness: { blind_after_seconds: 60 }, at: '2026-10-17T00:00:00.000Z',
    });
    expect(stateLimitsOf(valid(fileWith('')), home, 'quiet-team').blind_after_seconds).toBe(60);
    // The project is the one level the blind window lets loosen: two hours stands as declared.
    upsertProject(home, 'quiet-project', { liveness: { blind_after_seconds: 7200 }, at: '2026-10-17T00:00:01.000Z' });
    expect(stateLimitsOf(valid(fileWith('')), home, 'quiet-team').blind_after_seconds).toBe(7200);
    // A team inside it may close the window again.
    expect(stateLimitsOf(valid(fileWith('watch:\n  blind_after: 2m\n')), home, 'quiet-team').blind_after_seconds).toBe(120);
    // No level inside may open it further: the team's three hours is set aside.
    const opened = valid(fileWith('watch:\n  blind_after: 3h\n'));
    expect(stateLimitsOf(opened, home, 'quiet-team').blind_after_seconds).toBe(7200);
  });

  test('the machine settings file is the widest surface, and it may tighten but not loosen', () => {
    const path = join(home, '.config', 'team', 'settings.yaml');
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(path, 'liveness:\n  blind_after_seconds: 90\n');
    expect(stateLimitsOf(valid(fileWith('')), home, 'quiet-team').blind_after_seconds).toBe(90);
    // Parallel keys are not the setting: only the three liveness keys read.
    writeFileSync(path, 'liveness:\n  blind_after: 90\n');
    expect(stateLimitsOf(valid(fileWith('')), home, 'quiet-team').blind_after_seconds).toBe(300);
    // A number that is not one declares nothing, as does a word the machine may not write.
    writeFileSync(path, 'liveness:\n  blind_after_seconds: soon\n');
    expect(stateLimitsOf(valid(fileWith('')), home, 'quiet-team').blind_after_seconds).toBe(300);
    writeFileSync(path, 'liveness:\n  blind_after_seconds: 7200\n');
    expect(stateLimitsOf(valid(fileWith('')), home, 'quiet-team').blind_after_seconds).toBe(300);
  });

  test('an entity\'s liveness map applies to the teams it names', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(join(home, '.config', 'team', 'entities.yaml'), 'acme:\n  liveness:\n    blind_after_seconds: 90\n');
    expect(stateLimitsOf(valid(fileWith('', { entity: 'acme' })), home, 'quiet-team').blind_after_seconds).toBe(90);
    // A team that names no entity, or another entity, takes no word from it.
    expect(stateLimitsOf(valid(fileWith('')), home, 'quiet-team').blind_after_seconds).toBe(300);
    expect(stateLimitsOf(valid(fileWith('', { entity: 'other' })), home, 'quiet-team').blind_after_seconds).toBe(300);
  });

  test('a seat\'s own liveness map applies to that seat alone', () => {
    const t = valid(fileWith('', { worker: '    liveness:\n      blind_after_seconds: 60\n      idle_lead_seconds: 30\n' }));
    expect(stateLimitsOf(t, home, 'quiet-team', 'claude-worker').blind_after_seconds).toBe(60);
    expect(stateLimitsOf(t, home, 'quiet-team', 'claude-worker').idle_lead_seconds).toBe(30);
    // The lead, and the team as a whole, keep the shipped windows.
    expect(stateLimitsOf(t, home, 'quiet-team', 'claude-lead').blind_after_seconds).toBe(300);
    expect(stateLimitsOf(t, home, 'quiet-team', 'claude-lead').idle_lead_seconds).toBe(300);
    expect(stateLimitsOf(t, home, 'quiet-team').blind_after_seconds).toBe(300);
  });
});
