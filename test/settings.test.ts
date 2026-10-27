// `team settings <seat>`: one seat's settings, each with where its value comes from. The read is
// the live team file and the registry; the scenes cover a seat that writes every key, one that
// writes none, the team's own order standing under an unset seat order, and the refusals a read
// still owes (an invocation, a seat the file does not declare, a file that does not load, a team
// that is not the caller's).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { readEvents } from '../src/bus/log.ts';
import { runSettings, USAGE } from '../src/commands/settings.ts';
import { grantsDir } from '../src/grant.ts';
import { resolveSeatOverrides } from '../src/config/apply.ts';
import { planConfigSet, writeConfigSet } from '../src/config/sources.ts';
import { SETTINGS_CHANGE_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { agentsDir, readAgents, registerAgent, type AgentInit } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { installKey, recordedGeneration } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const TEAM = `format: 1
project: acme
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
`;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-settings-')));
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

const OWNER: Caller = { kind: 'owner' };

async function run(
  argv: string[],
  caller: Caller = OWNER,
  now: Date = new Date('2026-10-19T10:00:00Z'),
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
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

describe('a seat the launcher selects the model for', () => {
  test('the model reads unset, because the file does not decide it', async () => {
    writeFileSync(
      join(root, '.agents', 'team.yaml'),
      TEAM.replace('    name: lead\n    nickname: Atlas', '    name: lead\n    model_from: launcher\n    nickname: Atlas'),
    );
    const result = await run(['lead', '--json']);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out) as { settings: Record<string, unknown>[] };
    expect(doc.settings.find((entry) => entry.key === 'model')).toEqual({
      key: 'model',
      value: null,
      source: 'none',
      applies: 'restart-resume',
    });
  });
});

describe('a seat that writes every setting', () => {
  test('prints the five keys and where each comes from', async () => {
    const result = await run(['lead']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      '  KEY             VALUE             SOURCE      APPLIES\n'
      + '  model           Claude Opus       team file   restart that resumes\n'
      + '  effort          high              team file   restart that resumes\n'
      + '  nickname        Atlas             team file   at once\n'
      + '  delivery_order  mcp-inbox, typed  team order  at once\n'
      + '  human           false             default     at once\n',
    );
    expect(result.err).toBe('');
  });
});

describe('a seat that writes none', () => {
  test('reports an unset effort and nickname, and its own order over the team order', async () => {
    const result = await run(['worker']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      '  KEY             VALUE        SOURCE     APPLIES\n'
      + '  model           Claude Opus  team file  restart that resumes\n'
      + '  effort          -            unset      restart that resumes\n'
      + '  nickname        -            unset      at once\n'
      + '  delivery_order  typed        team file  at once\n'
      + '  human           true         team file  at once\n',
    );
  });
});

describe('--json', () => {
  test('carries every row, its value and its source', async () => {
    const result = await run(['lead', '--json']);
    expect(result.code).toBe(0);
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      format: number;
      project: string;
      seat: string;
      settings: { key: string; value: unknown; source: string; applies: string }[];
    }>(result.out, {
      type: 'object',
      required: ['schema', 'format', 'project', 'seat', 'settings'],
      properties: {
        format: { const: 1 },
        project: { const: 'acme' },
        seat: { const: 'lead' },
        settings: { type: 'array' },
      },
    });
    expect(doc.schema.name).toBe('team.settings');
    expect(doc.settings).toEqual([
      { key: 'model', value: 'Claude Opus', source: 'team file', applies: 'restart-resume' },
      { key: 'effort', value: 'high', source: 'team file', applies: 'restart-resume' },
      { key: 'nickname', value: 'Atlas', source: 'team file', applies: 'at-once' },
      { key: 'delivery_order', value: ['mcp-inbox', 'typed'], source: 'team default', applies: 'at-once' },
      { key: 'human', value: false, source: 'default', applies: 'at-once' },
    ]);
  });
});

describe('refusals', () => {
  test('an invocation with no seat', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.err).toBe(`team settings: a seat name is required\n${USAGE}`);
  });

  test('an invocation with a second word', async () => {
    const result = await run(['lead', 'worker']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unexpected "worker"');
  });

  test('an unknown option', async () => {
    const result = await run(['lead', '--nope']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unknown option --nope');
  });

  test('a seat the team file does not declare', async () => {
    const result = await run(['ghost']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('team settings: no seat "ghost" is declared in acme\n');
    expect(result.out).toBe('');
  });

  test('a seat the team file does not declare, under --json', async () => {
    const result = await run(['ghost', '--json']);
    assertJsonErrorShape(result.out, { id: 'settings.no-seat', messageContains: 'no seat "ghost" is declared in acme' });
    expect(result.code).toBe(1);
  });

  test('a file that does not parse', async () => {
    writeFileSync(join(root, '.agents', 'team.yaml'), 'format: 1\nseats: not-a-list\n');
    const result = await run(['lead']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('team config line');
  });

  test('a file the owner names that is not there', async () => {
    const result = await run(['lead', '--file', 'missing.yaml']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('team settings:');
  });

  test('a team the caller is not part of', async () => {
    const result = await run(['lead'], { kind: 'pane', pane: 'w9:p1' });
    expect(result.code).toBe(2);
    expect(result.err).toBe('team settings: this team is not yours to read\n');
  });

  test('--file is the owner\'s', async () => {
    const result = await run(['lead', '--file', '.agents/team.yaml'], { kind: 'pane', pane: 'w9:p1' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('team settings:');
  });
});

describe('signed seat records', () => {
  /** Signs one seat setting and returns the file it landed in. */
  function signedSeatSetting(value = 'claude-opus-5-5'): string {
    const agentId = registerLead();
    const plan = planConfigSet(home, {
      level: 'seat',
      target: agentId,
      settings: [{ key: 'model', value }],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('plan refused');
    const written = writeConfigSet(home, plan, { now: new Date('2026-10-19T10:00:00Z') });
    expect(written.ok).toBe(true);
    return join(agentsDir(home), `${agentId}.yaml`);
  }

  /** Rewrites the record's signed value in place. The fixture's `launch` line carries the same
   *  model name, so the tamper targets the settings entry's own `value:` line rather than the
   *  first match, which would land on `launch` and leave the record verifying. */
  function tamper(path: string): void {
    const text = readFileSync(path, 'utf8');
    const tampered = text.replace('value: "claude-opus-5-5"', 'value: "claude-haiku-5-5"');
    expect(tampered).not.toBe(text);
    writeFileSync(path, tampered);
  }

  test('the record wins the key and names its file, in the table and in --json', async () => {
    const path = signedSeatSetting();
    const table = await run(['lead']);
    expect(table.code).toBe(0);
    expect(table.out).toContain('seat record');

    const result = await run(['lead', '--json']);
    expect(result.code).toBe(0);
    const doc = assertMatchesOutputSchema<{
      settings: { key: string; value: unknown; source: string; applies: string; source_file?: string }[];
    }>(result.out, {
      type: 'object',
      required: ['settings'],
      properties: { settings: { type: 'array' } },
    });
    expect(doc.settings.find((entry) => entry.key === 'model')).toEqual({
      key: 'model',
      value: 'claude-opus-5-5',
      source: 'seat record',
      applies: 'restart-resume',
      source_file: path,
    });
    expect(doc.settings.find((entry) => entry.key === 'nickname')).toEqual({
      key: 'nickname',
      value: 'Atlas',
      source: 'team file',
      applies: 'at-once',
    });
  });

  test('a record that does not verify refuses the read and names the file', async () => {
    const path = signedSeatSetting();
    tamper(path);
    const result = await run(['lead']);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toContain(path);
    expect(result.err).toContain('signature verification failed for setting "model"');
  });

  test('a tampered record under --json carries settings.source', async () => {
    const path = signedSeatSetting();
    tamper(path);
    const result = await run(['lead', '--json']);
    expect(result.code).toBe(2);
    assertJsonErrorShape(result.out, { id: 'settings.source', messageContains: 'signature verification failed' });
  });
});

describe('the write verbs', () => {
  test('set records a signed setting and the read names the seat record', async () => {
    const agentId = registerLead();
    const set = await run(['set', 'lead', 'nickname=Hera']);
    expect(set.code).toBe(0);
    expect(set.out).toBe('settings: set nickname=Hera at seat (lead)\n');
    expect(set.err).toBe('');

    const read = await run(['lead', '--json']);
    expect(read.code).toBe(0);
    const doc = JSON.parse(read.out) as { settings: { key: string; value: unknown; source: string; applies: string; source_file?: string }[] };
    expect(doc.settings.find((entry) => entry.key === 'nickname')).toEqual({
      key: 'nickname',
      value: 'Hera',
      source: 'seat record',
      applies: 'at-once',
      source_file: join(agentsDir(home), `${agentId}.yaml`),
    });
  });

  test('a nickname another seat signed collides, even when the file does not carry it', async () => {
    registerLead();
    const worker = registerAgent(home, {
      ...agentInit(),
      name: 'Worker One',
      reach: { team: teamIdOf(root), seat: 'worker', session: 'acme', pane: 'w3:p2', address: null },
    }).id;
    const plan = planConfigSet(home, { level: 'seat', target: worker, settings: [{ key: 'nickname', value: 'Hera' }] });
    if (!plan.ok) throw new Error(plan.why);
    const written = writeConfigSet(home, plan, { now: new Date('2026-10-19T10:00:00Z') });
    if (!written.ok) throw new Error(written.why);

    const set = await run(['set', 'lead', 'nickname=Hera']);

    // The roster a send addresses is the composed one: the worker's signed word is already
    // "Hera", so the write would make @Hera reach two seats and is refused before it is signed.
    expect(set.code).toBe(2);
    expect(set.err).toContain('seat "lead": the nickname "Hera" is also on seat "worker"');
  });

  test('a record that does not verify refuses the write instead of standing for the declaration', async () => {
    registerLead();
    const worker = registerAgent(home, {
      ...agentInit(),
      name: 'Worker One',
      reach: { team: teamIdOf(root), seat: 'worker', session: 'acme', pane: 'w3:p2', address: null },
    }).id;
    const plan = planConfigSet(home, { level: 'seat', target: worker, settings: [{ key: 'nickname', value: 'Hera' }] });
    if (!plan.ok) throw new Error(plan.why);
    const written = writeConfigSet(home, plan, { now: new Date('2026-10-19T10:00:00Z') });
    if (!written.ok) throw new Error(written.why);
    const path = join(agentsDir(home), `${worker}.yaml`);
    writeFileSync(path, readFileSync(path, 'utf8').replace('value: "Hera"', 'value: "Crow"'));

    const set = await run(['set', 'lead', 'nickname=Hera']);

    // The effective word the damaged record held is unknown; checking the new word against the
    // declaration alone could hand two seats one address, so the write is refused and names the
    // record it could not verify.
    expect(set.code).toBe(2);
    expect(set.err).toContain(path);
    expect(set.err).toContain('signature verification failed');
  });

  test('a model word is recorded as the launch id it names', async () => {
    registerLead();
    const set = await run(['set', 'lead', 'model=claude-haiku-5-5']);
    expect(set.code).toBe(0);

    const read = await run(['lead', '--json']);
    const doc = JSON.parse(read.out) as { settings: { key: string; value: unknown; source: string; applies: string; source_file?: string }[] };
    expect(doc.settings.find((entry) => entry.key === 'model')).toEqual({
      key: 'model',
      value: 'claude-haiku-5-5',
      source: 'seat record',
      applies: 'restart-resume',
      source_file: expect.any(String),
    });
  });

  test('key=value words set several settings in one record', async () => {
    registerLead();
    const set = await run(['set', 'lead', 'effort=high', 'human=true']);
    expect(set.code).toBe(0);
    expect(set.out).toBe('settings: set effort=high, human=true at seat (lead)\n');

    const read = await run(['lead', '--json']);
    const doc = JSON.parse(read.out) as { settings: { key: string; value: unknown; source: string; applies: string; source_file?: string }[] };
    expect(doc.settings.find((entry) => entry.key === 'effort')).toMatchObject({ value: 'high', source: 'seat record' });
    expect(doc.settings.find((entry) => entry.key === 'human')).toMatchObject({ value: true, source: 'seat record' });
  });

  test('unset removes the record and the team file shows through again', async () => {
    registerLead();
    expect((await run(['set', 'lead', 'nickname=Hera'])).code).toBe(0);
    const unset = await run(['unset', 'lead', 'nickname']);
    expect(unset.code).toBe(0);
    expect(unset.out).toBe('settings: unset nickname at seat (lead)\n');

    const read = await run(['lead', '--json']);
    const doc = JSON.parse(read.out) as { settings: { key: string; value: unknown; source: string; applies: string; source_file?: string }[] };
    expect(doc.settings.find((entry) => entry.key === 'nickname')).toEqual({
      key: 'nickname',
      value: 'Atlas',
      source: 'team file',
      applies: 'at-once',
    });
  });

  test('an unset is stamped with the clock it ran at, not the date the setting was written', async () => {
    registerLead();
    const setAt = new Date('2026-10-19T18:00:00Z');
    const unsetAt = new Date('2026-10-20T09:00:00Z');
    expect((await run(['set', 'lead', 'nickname=Hera'], OWNER, setAt)).code).toBe(0);
    expect((await run(['unset', 'lead', 'nickname'], OWNER, unsetAt)).code).toBe(0);

    const read = readEvents('acme', root, home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const unset = read.events.find(
      (entry) => entry.payload.kind === 'config.changed' && String(entry.payload.record_id).endsWith(':unset'),
    );
    expect(unset?.payload.ts).toBe(unsetAt.toISOString());
  });

  test('a policy expired at the command clock does not govern the write', async () => {
    writeFileSync(
      join(root, '.agents', 'team.yaml'),
      TEAM.replace('project: acme\n', 'project: acme\nentity: lab\n').replace('delivery_order: [mcp-inbox, typed]\n', ''),
    );
    registerLead();
    const policy = writePolicySet(
      home,
      {
        level: 'entity',
        target: 'lab',
        name: 'delivery-order',
        value: ['mcp-inbox'],
        expiry: '2026-11-01T00:00:00Z',
      },
      { now: new Date('2026-10-01T00:00:00Z') },
    );
    expect(policy.ok).toBe(true);

    // Control: before the expiry the same word is a loosening and is refused.
    const beforeExpiry = await run(['set', 'lead', 'delivery_order', 'mcp-inbox,drop'], OWNER, new Date('2026-10-25T00:00:00Z'));
    expect(beforeExpiry.code).toBe(1);
    expect(beforeExpiry.err).toContain('loosens policy "delivery-order" in force at level entity');

    // At a clock past the expiry the policy is read as unset and no longer governs.
    const afterExpiry = await run(['set', 'lead', 'delivery_order', 'mcp-inbox,drop'], OWNER, new Date('2026-12-01T00:00:00Z'));
    expect(afterExpiry.code).toBe(0);
  });

  test('--dry-run prints the change and leaves the record bytes alone', async () => {
    const agentId = registerLead();
    const path = join(agentsDir(home), `${agentId}.yaml`);
    const before = readFileSync(path, 'utf8');
    const dry = await run(['set', 'lead', 'nickname=Hera', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toBe('settings: would set nickname=Hera at seat (lead)\n');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('--json validates against the published schema', async () => {
    registerLead();
    const set = await run(['set', 'lead', 'nickname=Hera', '--json']);
    expect(set.code).toBe(0);
    const doc = assertMatchesOutputSchema<{
      status: string;
      dry_run: boolean;
      settings: Record<string, unknown>[];
    }>(set.out, SETTINGS_CHANGE_OUTPUT_SCHEMA);
    expect(doc.status).toBe('updated');
    expect(doc.dry_run).toBe(false);
    expect(doc.settings).toEqual([{ key: 'nickname', value: 'Hera', old: null, applies: 'at-once' }]);
  });

  test('a key the seat does not hold is refused before anything is written', async () => {
    const agentId = registerLead();
    const path = join(agentsDir(home), `${agentId}.yaml`);
    const before = readFileSync(path, 'utf8');
    const result = await run(['set', 'lead', 'nope=1']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unknown setting "nope"');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('a model the seat profile does not know is refused', async () => {
    registerLead();
    const result = await run(['set', 'lead', 'model=nope']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unknown model "nope" for claude-code');
  });

  test('a value that loosens the delivery order policy is refused', async () => {
    registerLead();
    const result = await run(['set', 'lead', 'delivery_order=drop']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('loosens policy "delivery-order"');
  });

  test('a declared seat with no agent record gets a registered one on its first write', async () => {
    installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
    const result = await run(['set', 'lead', 'nickname=Hera']);
    expect(result.code).toBe(0);
    const agents = readAgents(home);
    expect(agents).toHaveLength(1);
    const [agent] = agents;
    // Seeded from the team file's declaration: the identity words are the file's own.
    expect(agent?.name).toBe('lead');
    expect(agent?.signing).toEqual({ model: 'Claude Opus', version: '5.5', role: 'coordinator' });
    expect(agent?.lab).toBe('anthropic');
    expect(agent?.cli).toBe('claude-code');
    expect(agent?.launch).toBe('claude --model claude-opus-5-5');
    expect(agent?.lifecycle).toBe('registered');
    expect(agent?.reach).toEqual({ team: teamIdOf(root), seat: 'lead', session: 'acme', pane: null, address: null });
    expect(agent?.provenance.registered_by).toBe('team settings');
    // The word the command wrote is the signed one the seat reads back.
    expect(resolveSeatOverrides({ home, root, seat: 'lead' })).toEqual({ ok: true, overrides: { nickname: 'Hera' } });
  });

  test('a dry run on a seat that never launched prints the change and creates nothing', async () => {
    const result = await run(['set', 'lead', 'nickname=Hera', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.out).toBe('settings: would set nickname=Hera at seat (lead)\n');
    // A preview is not a write: no record, no setting, no generation and no event.
    expect(readAgents(home)).toHaveLength(0);
    expect(recordedGeneration(grantsDir(home), home)).toBeNull();
    const events = readEvents('acme', root, home);
    expect(events.ok).toBe(true);
    if (events.ok) expect(events.events).toHaveLength(0);
  });

  test('a refused key on a seat that never launched creates nothing', async () => {
    const result = await run(['set', 'lead', 'nope=1']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unknown setting "nope"');
    expect(readAgents(home)).toHaveLength(0);
    expect(recordedGeneration(grantsDir(home), home)).toBeNull();
  });

  test('a refused value on a seat that never launched creates nothing', async () => {
    const result = await run(['set', 'lead', 'model=nope']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unknown model "nope" for claude-code');
    expect(readAgents(home)).toHaveLength(0);
  });

  test('a policy refusal on a seat that never launched creates nothing', async () => {
    installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
    const result = await run(['set', 'lead', 'delivery_order=drop']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('loosens policy "delivery-order"');
    expect(readAgents(home)).toHaveLength(0);
    expect(recordedGeneration(grantsDir(home), home)).toBeNull();
  });

  test('a nickname collision on a seat that never launched creates nothing', async () => {
    // The team file gives lead the word "Atlas"; a first write for worker is checked against the
    // composed roster before any record exists for either of them.
    const result = await run(['set', 'worker', 'nickname=Atlas']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('seat "worker": the nickname "Atlas" is also on seat "lead"');
    expect(readAgents(home)).toHaveLength(0);
  });

  test('an unset on a seat that never launched says there is nothing to unset, not that its record is missing', async () => {
    const result = await run(['unset', 'lead', 'nickname']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('nothing to unset');
    expect(result.err).not.toContain('no registered agent record');
    // Nothing to remove is not a reason to register the seat.
    expect(readAgents(home)).toHaveLength(0);
  });

  test('a seat record that cannot be created is refused, and the id says which', async () => {
    // A path where the agent registry belongs cannot hold records: the bootstrap is refused
    // rather than the write landing nowhere.
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(join(home, '.config', 'team', 'agents'), 'not a directory');
    const result = await run(['set', 'lead', 'nickname=Hera']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('has no registered agent record');
    expect(result.err).toContain('none could be created');
  });

  test('unsetting a setting that is not set is refused', async () => {
    registerLead();
    const result = await run(['unset', 'lead', 'model']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('nothing to unset');
  });

  test('a caller that is not the owner is refused', async () => {
    registerLead();
    const result = await run(['set', 'lead', 'nickname=Hera'], { kind: 'seat', name: 'other', pane: 'w9:p1' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('only the owner sets a seat');
  });

  test('the set and unset forms refuse what they cannot parse, and --dry-run stays with the writes', async () => {
    const missingValue = await run(['set', 'lead', 'model']);
    expect(missingValue.code).toBe(2);
    expect(missingValue.err).toContain('needs a value');

    const noKey = await run(['unset', 'lead']);
    expect(noKey.code).toBe(2);
    expect(noKey.err).toContain('a setting key is required');

    const readDry = await run(['lead', '--dry-run']);
    expect(readDry.code).toBe(2);
    expect(readDry.err).toContain('--dry-run is for the write forms');
  });
});
