// `team settings set model|effort`: the entity model rule judges the lab the PROPOSED model runs
// under (never the vendor the file declares today), and a real change queues the bounded
// restart-resume config swap that applies it. The scenes cover the rule's subject precedence and
// its fail-closed reads, the queued record's recipe down to its launch line, the settings that
// ask for no restart (already in force, already queued, dry run, refused, a human's pane), and
// the unset that takes a config swap back.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runSettings } from '../src/commands/settings.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { labOfModel } from '../src/policy/model-rule.ts';
import { agentsDir, registerAgent, type AgentInit } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readState } from '../src/state.ts';
import { installKey } from '../src/store/keys.ts';
import { WAIT_FOR } from '../src/swap/auto.ts';
import { enqueueSwap } from '../src/swap/queue.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
entity: lab
coordinator: lead
operator: lead
workspace:
  mode: shared
delivery_order: [mcp-inbox, typed]
seats:
  - role: coordinator
    name: lead
    nickname: Atlas
    effort: high
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    delivery_order: [typed]
    human: true
  - role: reviewer
    name: helper
    cli: cursor
    vendor: cursor
    model: Composer
    version: "2.5"
    launch: cursor-agent --model composer-2.5
    account: cursor
budgets:
  accounts:
    cursor: { kind: subscription, reserve: 20%, sources: [status_line] }
`;

const NOW = new Date('2026-10-19T10:00:00Z');
const DEADLINE = '2026-10-19T10:30:00.000Z';
const OWNER: Caller = { kind: 'owner' };

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-settings-swap-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function run(
  argv: string[],
  now: Date = NOW,
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, OWNER);
  const code = await runSettings(argv, io, { home, now });
  return { code, out: io.out, err: io.err };
}

function agentInit(): AgentInit {
  return {
    name: 'Lead One',
    signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: 'acme', seat: 'lead', session: 'acme', pane: 'w3:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  };
}

/** The owner's key, a registered `lead` agent and its roster line: the record a write lands in. */
function registerLead(): string {
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
  const agentId = registerAgent(home, agentInit()).id;
  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    session: 'acme',
    root,
    lobby: '',
    roster: [{ agent: agentId, seat: 'lead', role: 'coordinator' }],
  });
  return agentId;
}

function setRule(value: string): void {
  const wrote = writePolicySet(home, { level: 'entity', target: 'lab', name: 'model-rule', value }, { now: NOW });
  if (!wrote.ok) throw new Error(wrote.why);
}

const stateDir = (): string => join(root, '.agents');
const queue = (): Record<string, unknown> => readState(stateDir()).swaps ?? {};

describe('the model rule judges the proposed model', () => {
  test('a model that moves the seat to another lab is judged by that lab, not by the vendor the file declares', async () => {
    // The declaration still says deepseek; the model the write proposes runs under anthropic.
    // Reading the declared vendor would refuse this under `*=anthropic`; the rule must read the
    // lab of the model being recorded.
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM.replace('vendor: anthropic', 'vendor: deepseek'));
    setRule('*=anthropic');
    registerLead();

    const set = await run(['set', 'lead', 'model=claude-haiku-5-5']);
    expect(set.code).toBe(0);
    expect(set.err).toBe('');

    const read = await run(['lead', '--json']);
    const doc = JSON.parse(read.out) as { settings: { key: string; value: unknown; source: string }[] };
    expect(doc.settings.find((entry) => entry.key === 'model')).toMatchObject({
      value: 'claude-haiku-5-5',
      source: 'seat record',
    });
    // The queued target's vendor is the proposed model's lab, not the file's stale word.
    expect(queue()['lead']).toMatchObject({
      to: { vendor: 'anthropic', model: 'Claude Haiku' },
      reason: 'config',
    });
  });

  test('a refused lab names the lab the proposed model runs under', async () => {
    setRule('*=!anthropic');
    registerLead();

    const set = await run(['set', 'lead', 'model=claude-haiku-5-5']);
    expect(set.code).toBe(1);
    expect(set.err).toContain('runs under the lab "anthropic"');
    expect(queue()).toEqual({});
  });

  test('a role entry decides before *', async () => {
    // The worker's role is the decided subject even though `*` would allow the lab.
    setRule('implementer=deepseek; *=anthropic');
    registerLead();

    const set = await run(['set', 'worker', 'model=claude-haiku-5-5']);
    expect(set.code).toBe(1);
    expect(set.err).toContain('worker');
    expect(set.err).toContain('runs under the lab "anthropic"');
  });

  test('a rule that decides nothing for the seat lets the model through', async () => {
    setRule('lead=deepseek');
    registerLead();

    const set = await run(['set', 'worker', 'model=claude-haiku-5-5']);
    expect(set.code).toBe(0);
    // A human's pane is never launched over, so the setting is recorded and nothing is queued.
    expect(queue()).toEqual({});
    const read = await run(['worker', '--json']);
    const doc = JSON.parse(read.out) as { settings: { key: string; value: unknown; source: string }[] };
    expect(doc.settings.find((entry) => entry.key === 'model')).toMatchObject({
      value: 'claude-haiku-5-5',
      source: 'seat record',
    });
  });

  test('a rule whose signature does not verify refuses the write', async () => {
    setRule('*=anthropic');
    registerLead();
    const path = join(home, '.config', 'team', 'entities.yaml');
    const text = readFileSync(path, 'utf8');
    const tampered = text.replace('*=anthropic', '*=openai');
    expect(tampered).not.toBe(text);
    writeFileSync(path, tampered);

    const set = await run(['set', 'lead', 'model=claude-haiku-5-5']);
    expect(set.code).toBe(1);
    expect(set.err).toContain('policy chain cannot be read');
    expect(queue()).toEqual({});
  });
});

describe('the lab of a model', () => {
  test('maps each shipped maker family to the lab the rule names', () => {
    expect(labOfModel('Claude Opus')).toBe('anthropic');
    expect(labOfModel('claude-haiku')).toBe('anthropic');
    expect(labOfModel('GPT Sol')).toBe('openai');
    expect(labOfModel('Gemini Flash')).toBe('google');
    expect(labOfModel('Grok')).toBe('xai');
    expect(labOfModel('Muse Wonder')).toBe('meta');
    expect(labOfModel('Composer')).toBe('cursor');
    expect(labOfModel('DeepSeek Flash')).toBe('deepseek');
    expect(labOfModel('GLM 5')).toBe('zhipu');
    expect(labOfModel('Z.ai GLM')).toBe('zhipu');
    expect(labOfModel('Kimi K2')).toBe('moonshot');
  });

  test('a maker the table does not know names no lab', () => {
    expect(labOfModel('Meridian One')).toBeUndefined();
    expect(labOfModel('')).toBeUndefined();
    expect(labOfModel('claudette')).toBeUndefined();
  });
});

describe('a model change queues the restart that applies it', () => {
  test('the record carries the declaration, the checked target and the table wait', async () => {
    registerLead();

    const set = await run(['set', 'lead', 'model=claude-haiku-5-5']);
    expect(set.code).toBe(0);
    expect(set.out).toBe('settings: set model=claude-haiku-5-5 at seat (lead)\n');
    expect(set.err).toBe('');
    expect(queue()['lead']).toEqual({
      from: { cli: 'claude-code', vendor: 'anthropic', model: 'Claude Opus', version: '5.5', display: 'Claude Opus 5.5' },
      to: {
        cli: 'claude-code',
        vendor: 'anthropic',
        model: 'Claude Haiku',
        version: '5.5',
        display: 'claude haiku 5.5',
        launch: 'claude --model claude-haiku-5-5 --effort high',
        effort: 'high',
      },
      reason: 'config',
      queuedAt: NOW.toISOString(),
      deadline: DEADLINE,
      waitFor: WAIT_FOR,
    });
  });

  test('a second identical set does not restart the wait', async () => {
    registerLead();
    expect((await run(['set', 'lead', 'model=claude-haiku-5-5'], NOW)).code).toBe(0);
    const later = new Date('2026-10-19T10:05:00Z');
    expect((await run(['set', 'lead', 'model=claude-haiku-5-5'], later)).code).toBe(0);
    expect(queue()['lead']).toMatchObject({ queuedAt: NOW.toISOString(), deadline: DEADLINE });
  });

  test('an effort change queues a swap that keeps the model', async () => {
    registerLead();

    const set = await run(['set', 'lead', 'effort=low']);
    expect(set.code).toBe(0);
    expect(queue()['lead']).toEqual({
      from: { cli: 'claude-code', vendor: 'anthropic', model: 'Claude Opus', version: '5.5', display: 'Claude Opus 5.5' },
      to: {
        cli: 'claude-code',
        vendor: 'anthropic',
        model: 'Claude Opus',
        version: '5.5',
        display: 'Claude Opus 5.5',
        launch: 'claude --model claude-opus-5-5 --effort low',
        effort: 'low',
      },
      reason: 'config',
      queuedAt: NOW.toISOString(),
      deadline: DEADLINE,
      waitFor: WAIT_FOR,
    });
  });

  test('a lab change drops an account that does not pay the new lab', async () => {
    registerLead();

    const set = await run(['set', 'helper', 'model=gpt-5.6-sol']);
    expect(set.code).toBe(0);
    const held = queue()['helper'] as { to: Record<string, unknown> };
    expect(held.to).toMatchObject({
      vendor: 'openai',
      model: 'GPT Sol',
      version: '5.6',
      display: 'gpt sol 5.6',
      launch: 'cursor-agent --model gpt-5.6-sol',
    });
    expect(held.to['account']).toBeUndefined();
  });

  test('a model change that stays on the same lab keeps the account', async () => {
    registerLead();

    const set = await run(['set', 'helper', 'model=composer-2.6']);
    expect(set.code).toBe(0);
    const held = queue()['helper'] as { to: Record<string, unknown> };
    expect(held.to).toMatchObject({ vendor: 'cursor', model: 'Composer', account: 'cursor' });
  });

  test('a setting already in force queues nothing', async () => {
    registerLead();

    const set = await run(['set', 'lead', 'effort=high']);
    expect(set.code).toBe(0);
    expect(queue()).toEqual({});
  });

  test('a dry run queues nothing', async () => {
    registerLead();

    const dry = await run(['set', 'lead', 'model=claude-haiku-5-5', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toBe('settings: would set model=claude-haiku-5-5 at seat (lead)\n');
    expect(queue()).toEqual({});
  });

  test('a refused set queues nothing', async () => {
    setRule('*=!anthropic');
    registerLead();

    const set = await run(['set', 'lead', 'model=claude-haiku-5-5']);
    expect(set.code).toBe(1);
    expect(queue()).toEqual({});
  });
});

describe('an unset takes the config swap back', () => {
  test('unsetting model cancels the queued config swap', async () => {
    registerLead();
    expect((await run(['set', 'lead', 'model=claude-haiku-5-5'])).code).toBe(0);
    expect(queue()['lead']).toBeDefined();

    const unset = await run(['unset', 'lead', 'model'], new Date('2026-10-19T10:05:00Z'));
    expect(unset.code).toBe(0);
    expect(unset.out).toBe('settings: unset model at seat (lead)\n');
    expect(unset.err).toBe('');
    expect(queue()).toEqual({});
  });

  test('a swap the entity rule queued stands', async () => {
    registerLead();
    expect((await run(['set', 'lead', 'model=claude-haiku-5-5'])).code).toBe(0);
    enqueueSwap(stateDir(), {
      seat: 'lead',
      from: { cli: 'claude-code', vendor: 'anthropic', model: 'Claude Opus', version: '5.5', display: 'Claude Opus 5.5' },
      to: {
        cli: 'claude-code',
        vendor: 'anthropic',
        model: 'Claude Fable',
        version: '5.5',
        display: 'claude fable 5.5',
        launch: 'claude --model claude-fable-5-5',
      },
      reason: 'model-rule',
      waitSeconds: 1800,
      waitFor: WAIT_FOR,
      now: NOW,
    });

    const unset = await run(['unset', 'lead', 'model'], new Date('2026-10-19T10:05:00Z'));
    expect(unset.code).toBe(0);
    expect(queue()['lead']).toMatchObject({ reason: 'model-rule' });
  });
});

// The record's own settings entry, read back from the seat's signed file: the fixture agent id
// is the one registerLead returned, and the value the write recorded is the launch id.
describe('the signed record a queued write leaves', () => {
  test('records the launch id and not the word the owner typed', async () => {
    const agentId = registerLead();
    const set = await run(['set', 'lead', 'model=Claude Haiku 5.5']);
    expect(set.code).toBe(0);
    expect(set.out).toBe('settings: set model=claude-haiku-5-5 at seat (lead)\n');
    const text = readFileSync(join(agentsDir(home), `${agentId}.yaml`), 'utf8');
    expect(text).toContain('value: "claude-haiku-5-5"');
    expect(queue()['lead']).toBeDefined();
  });
});
