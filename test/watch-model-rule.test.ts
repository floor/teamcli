// The entity model rule in the watch (Policies rule 10): a declared seat whose vendor the rule
// refuses is reported once, naming the rule, the vendor and the swap proposed — or why none is;
// the same list `team check` prints, narrowed to this team. A pane outside the team file whose
// screen names a model of a lab the rule refuses for an unclaimed seat is reported by the extra
// check and never closed ; an unread pane, or one no shipped profile reads, stays
// the plain extra report. A rule that cannot be read is said once to the owner and judges nothing.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { ModelRuleBreachReading, ModelRulePass } from '../src/watch/check.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, pass, type Memory } from '../src/watch/pass.ts';
import { modelRuleOfPass } from '../src/watch/rule-pass.ts';
import { CLAUDE_IDLE } from './helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

const TEAM = `format: 1
project: beacon
entity: lab
coordinator: keeper
operator: keeper
session: beacon
workspace:
  mode: shared
seats:
  - role: coordinator
    name: keeper
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

function teamOf(text = TEAM): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

// --- modelRuleOfPass: the rule as one pass reads it, from the entity's own records. ---

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; root: string; home: string };

function world(text = TEAM): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'watch-model-rule-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config/team'), { recursive: true });
  const root = join(base, 'beacon');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), text);
  return { base, root, home };
}

function setRule(home: string, value: string): void {
  const wrote = writePolicySet(home, { level: 'entity', target: 'lab', name: 'model-rule', value }, { now: NOW });
  if (!wrote.ok) throw new Error(wrote.why);
}

function keeperBreach(root: string): ModelRuleBreachReading {
  return {
    rule: '*=!anthropic',
    vendor: 'anthropic',
    proposal: 'claude-code DeepSeek Flash 4.0 from beacon/worker',
    // The record keeps the donor's recipe whole: the watch queues its breaching seats from it,
    // so the reading carries what the run will write, not only the words it prints.
    recipe: {
      donor: { root, seat: 'worker', team: 'beacon' },
      recipe: {
        cli: 'claude-code',
        vendor: 'deepseek',
        model: 'DeepSeek Flash',
        version: '4.0',
        display: 'DeepSeek Flash 4.0',
        launch: 'claude --model deepseek-flash',
      },
    },
    reason: null,
  };
}

describe('the model rule as one pass reads it', () => {
  test('the rule, its entries, and this team\'s breaching seat with the swap proposed', () => {
    const w = world();
    setRule(w.home, '*=!anthropic');
    expect(modelRuleOfPass(teamOf(), w.root, w.home)).toEqual({
      ok: true,
      rule: '*=!anthropic',
      entries: [{ subject: '*', allow: false, labs: ['anthropic'] }],
      breaches: new Map([['keeper', keeperBreach(w.root)]]),
    });
  });

  test('an allowed seat is not in the breach map', () => {
    const w = world();
    setRule(w.home, '*=!anthropic');
    const found = modelRuleOfPass(teamOf(), w.root, w.home);
    expect(found?.ok).toBe(true);
    expect(found?.ok === true ? [...found.breaches.keys()] : []).toEqual(['keeper']);
  });

  test("another team's breach is not this team's", () => {
    const w = world();
    const other = join(w.base, 'outpost');
    mkdirSync(join(other, '.agents'), { recursive: true });
    writeFileSync(
      join(other, '.agents/team.yaml'),
      TEAM.replace('project: beacon', 'project: outpost').replace('name: keeper', 'name: outrider'),
    );
    upsertTeam(w.home, teamIdOf(other), { project: 'outpost', session: 'outpost', root: other, at: NOW.toISOString() });
    setRule(w.home, '*=!anthropic');
    const found = modelRuleOfPass(teamOf(), w.root, w.home);
    expect(found?.ok === true ? [...found.breaches.keys()] : []).toEqual(['keeper']);
  });

  test('a team with no entity, or a pass with no home, has no rule', () => {
    const w = world(TEAM.replace('entity: lab\n', ''));
    setRule(w.home, '*=!anthropic');
    expect(modelRuleOfPass(teamOf(TEAM.replace('entity: lab\n', '')), w.root, w.home)).toBeNull();
    expect(modelRuleOfPass(teamOf(), w.root, undefined)).toBeNull();
  });

  test('an entity with no rule reads as the empty rule, never a refusal', () => {
    const w = world();
    expect(modelRuleOfPass(teamOf(), w.root, w.home)).toEqual({ ok: true, rule: '', entries: [], breaches: new Map() });
  });

  test('a rule that cannot be read is its reason, never an empty rule', () => {
    const w = world();
    writeFileSync(join(w.home, '.config/team/entities.yaml'), '- not a map\n');
    const found = modelRuleOfPass(teamOf(), w.root, w.home);
    expect(found?.ok).toBe(false);
    expect(found?.ok === false && found.why.startsWith('entity: policy source cannot be read or verified (')).toBe(true);
  });
});

// --- The reports a pass makes from a rule reading. ---

const CREW = `format: 1
project: crew
entity: acme
coordinator: crew-lead
operator: crew-op
session: crew
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

function crew(): TeamFile {
  const result = validateTeamFile(CREW);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function agent(name: string | null, workspace: string, label: string): HerdrAgent {
  return { name, agent: label, pane: `${workspace}:p1`, workspace, status: 'idle', cwd: null };
}

function liveScene(extra: HerdrAgent[] = [], screens: Record<string, string> = {}): Live {
  const agents = [
    agent('crew-lead', 'w1', 'claude'),
    agent('crew-op', 'w2', 'claude'),
    agent('worker-1', 'w3', 'claude'),
    ...extra,
  ];
  return {
    running: true,
    agents,
    workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    screens: { 'w1:p1': CLAUDE_IDLE, 'w2:p1': CLAUDE_IDLE, 'w3:p1': CLAUDE_IDLE, ...screens },
  };
}

function ruleOf(...breaches: [string, ModelRuleBreachReading][]): ModelRulePass {
  return {
    ok: true,
    rule: '*=!anthropic',
    entries: [{ subject: '*', allow: false, labs: ['anthropic'] }],
    breaches: new Map(breaches),
  };
}

function run(
  modelRule: ModelRulePass,
  options: {
    file?: TeamFile;
    live?: Live;
    foreground?: Readonly<Record<string, readonly string[] | null>>;
    memory?: Memory;
    approval?: string[] | null;
  } = {},
) {
  const file = options.file ?? crew();
  return pass({
    team: file,
    state: emptySession(),
    live: options.live ?? liveScene(),
    machine: fine,
    now: 0,
    memory: options.memory ?? newMemory(),
    watch: file.watch,
    approval: options.approval,
    modelRule,
    foreground: options.foreground ?? {},
  });
}

const texts = (result: { reports: { text: string }[] }) => result.reports.map((report) => report.text);

const DENIED: ModelRuleBreachReading = {
  rule: '*=!anthropic',
  vendor: 'anthropic',
  proposal: 'claude-code DeepSeek Flash 4.0 from crew/worker-1',
  reason: null,
};

describe('the watch reports a seat the entity model rule refuses', () => {
  test('once, naming the rule, the vendor and the swap proposed', () => {
    const memory = newMemory();
    const text = 'worker-1: declares vendor anthropic, which the entity model rule *=!anthropic refuses; a swap to claude-code DeepSeek Flash 4.0 from crew/worker-1 is proposed';
    const first = run(ruleOf(['worker-1', DENIED]), { memory });
    expect(texts(first)).toContain(text);
    expect(first.reports.find((report) => report.key === 'model-rule:worker-1')).toEqual({
      key: 'model-rule:worker-1',
      text,
      to: 'operator',
    });
    expect(texts(run(ruleOf(['worker-1', DENIED]), { memory }))).not.toContain(text);
  });

  test('no recipe is the reason the rule read gives', () => {
    const noRecipe: ModelRuleBreachReading = {
      rule: '*=!anthropic',
      vendor: 'anthropic',
      proposal: null,
      reason: 'no seat of the entity on a team of the same visibility runs a model the rule allows here',
    };
    expect(texts(run(ruleOf(['worker-1', noRecipe])))).toContain(
      'worker-1: declares vendor anthropic, which the entity model rule *=!anthropic refuses; no seat of the entity on a team of the same visibility runs a model the rule allows here',
    );
  });

  test('it is always on: a file that lists it off still reports', () => {
    const file = crew();
    const smuggled = { ...file, watch: { ...file.watch, checks: ['model-rule'] } };
    const reported = texts(run(ruleOf(['worker-1', DENIED]), { file: smuggled, approval: ['`rules` changed'] }));
    expect(reported).toContain(
      'worker-1: declares vendor anthropic, which the entity model rule *=!anthropic refuses; a swap to claude-code DeepSeek Flash 4.0 from crew/worker-1 is proposed',
    );
  });
});

describe('a pane outside the team file, judged by the rule for an unclaimed seat', () => {
  const PANE = 'w9:p1';
  const stranger = agent(null, 'w9', 'antigravity');
  // Antigravity's footer names a Gemini model, read from its last lines; the lab is the line's.
  const antigravity = liveScene([stranger], { [PANE]: 'Gemini 4 Argon · medium\n' });

  function withRule(...entries: { subject: string; allow: boolean; labs: readonly string[] }[]): ModelRulePass {
    return {
      ok: true,
      rule: entries.map((entry) => `${entry.subject}=${entry.labs.map((lab) => (entry.allow ? lab : `!${lab}`)).join('+')}`).join('; '),
      entries,
      breaches: new Map(),
    };
  }

  test('a forbidden lab is reported, and the pane is never closed', () => {
    const rule = withRule({ subject: '*', allow: false, labs: ['google-gemini'] });
    const result = run(rule, { live: antigravity, foreground: { [PANE]: ['agy'] } });
    const text = `an unnamed antigravity (${PANE}) runs Gemini Argon 4, of the lab google-gemini, which the entity model rule *=!google-gemini refuses for an unclaimed seat — reported, never closed`;
    expect(texts(result)).toContain(`an unnamed antigravity (${PANE}) is running and is not in the file`);
    expect(texts(result)).toContain(text);
    expect(result.reports.find((report) => report.key === `model-rule:extra:${PANE}`)).toEqual({
      key: `model-rule:extra:${PANE}`,
      text,
      to: 'operator',
    });
  });

  test('an allowed lab is the plain extra report only', () => {
    const rule = withRule({ subject: '*', allow: false, labs: ['openai'] });
    const reported = texts(run(rule, { live: antigravity, foreground: { [PANE]: ['agy'] } }));
    expect(reported).toContain(`an unnamed antigravity (${PANE}) is running and is not in the file`);
    expect(reported.some((text) => text.includes('for an unclaimed seat'))).toBe(false);
  });

  test('a named entry alone decides nothing for an unclaimed seat', () => {
    const rule = withRule({ subject: 'crew-lead', allow: false, labs: ['google-gemini'] });
    const reported = texts(run(rule, { live: antigravity, foreground: { [PANE]: ['agy'] } }));
    expect(reported.some((text) => text.includes('for an unclaimed seat'))).toBe(false);
  });

  test('an unread pane stays the plain extra report', () => {
    const rule = withRule({ subject: '*', allow: false, labs: ['google-gemini'] });
    const reported = texts(run(rule, { live: antigravity, foreground: { [PANE]: null } }));
    expect(reported).toContain(`an unnamed antigravity (${PANE}) is running and is not in the file`);
    expect(reported.some((text) => text.includes('for an unclaimed seat'))).toBe(false);
  });
});

describe('a rule that cannot be read', () => {
  const broken: ModelRulePass = { ok: false, why: 'entity: policy source cannot be read or verified (bad)' };

  test('is said once to the owner, and no breach is judged', () => {
    const memory = newMemory();
    const line = 'the entity model rule cannot be read, so no breach is judged: entity: policy source cannot be read or verified (bad)';
    const first = run(broken, { memory });
    expect(texts(first)).toContain(line);
    expect(first.reports.find((report) => report.key === 'model-rule:unreadable')?.to).toBe('owner');
    expect(texts(first).some((text) => text.includes('which the entity model rule'))).toBe(false);
    expect(texts(run(broken, { memory }))).not.toContain(line);
  });
});
