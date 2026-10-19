// `team settings set model`: the entity model rule judges the lab the PROPOSED model runs under
// — never the vendor the file declares today. The scenes cover the rule's subject precedence,
// its fail-closed reads, and the lab table the admission reads a model's maker through.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runSettings } from '../src/commands/settings.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { labOfModel } from '../src/policy/model-rule.ts';
import { registerAgent, type AgentInit } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { installKey } from '../src/store/keys.ts';
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
  });

  test('a refused lab names the lab the proposed model runs under', async () => {
    setRule('*=!anthropic');
    registerLead();

    const set = await run(['set', 'lead', 'model=claude-haiku-5-5']);
    expect(set.code).toBe(1);
    expect(set.err).toContain('runs under the lab "anthropic"');
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
