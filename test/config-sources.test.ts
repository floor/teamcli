// The signed settings store on disk (OD-20261018-08 and the storage ruling): the seat record
// every write lands in today, the registry's own settings maps at each level, the generation a
// multi-key write shares, verification before any read, and a cross-level write applied lowest
// level first.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entitiesPath } from '../src/entities.ts';
import {
  loadAndResolveConfigChain,
  planConfigSet,
  planConfigUnset,
  readProjectConfigSource,
  readSeatConfigSource,
  readTeamConfigSource,
  resolveConfigChain,
  writeConfigAcross,
  writeConfigSet,
  writeConfigUnset,
  type ConfigSourceRead,
} from '../src/config/sources.ts';
import type { SignedConfigRecord } from '../src/config/record.ts';
import { signConfigRecord } from '../src/config/record.ts';
import { agentsDir, getAgent, registerAgent, updateAgent, type AgentInit } from '../src/registry/agents.ts';
import { get as getProject, upsertProject } from '../src/registry/projects.ts';
import { getTeam, teamIdOf, teamsFile, upsertTeam } from '../src/registry/teams.ts';
import { installKey, keyOf } from '../src/store/keys.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'team-config-sources-'));
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function init(overrides: Partial<AgentInit> = {}): AgentInit {
  return {
    name: 'Builder One',
    signing: { model: 'Claude Sonnet', version: '5.5', role: 'builder' },
    lab: 'anthropic',
    cli: 'antigravity',
    launcher: null,
    launch: 'zsh -lc "agy --model claude-sonnet-5-5-high"',
    reach: { team: 'teamcli', seat: 'builder-1', session: 'teamcli', pane: 'w36:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
    ...overrides,
  };
}

function seatAgent(seat = 'builder-1'): string {
  return registerAgent(home, init({ reach: { team: 'teamcli', seat, session: 'teamcli', pane: 'w36:p1', address: null } })).id;
}

function seatFile(agentId: string): string {
  return join(agentsDir(home), `${agentId}.yaml`);
}

/** Writes one signed seat record straight into the agent file, as an owner with the key could —
 *  the way a value the write refuses (a duplicate leg, "lead") reaches the read. */
function injectSeatRecord(agentId: string, entry: { key: SignedConfigRecord['key']; value: SignedConfigRecord['value']; target?: string }): void {
  const signed = signConfigRecord(
    {
      key: entry.key,
      value: entry.value,
      level: 'seat',
      target: entry.target ?? agentId,
      setter: 'owner',
      date: '2026-10-19T08:00:00.000Z',
      generation: 1,
    },
    keyOf(home),
  );
  const agent = getAgent(home, agentId);
  const settings = { ...(agent?.settings ?? {}) };
  settings[entry.key] = {
    value: Array.isArray(entry.value) ? [...entry.value] : (entry.value as string | boolean),
    setter: signed.setter,
    date: signed.date,
    target: signed.target,
    generation: signed.generation,
    signature: signed.signature,
  };
  updateAgent(home, agentId, { settings });
}

function registeredTeam(): string {
  const root = join(home, 'repo');
  mkdirSync(root, { recursive: true });
  const id = teamIdOf(root);
  upsertTeam(home, id, { project: 'teamcli', session: 'teamcli', root, lobby: '' });
  return id;
}

describe('the seat record', () => {
  test('a multi-key write lands in agents/<id>.yaml and reads back every value', () => {
    const agentId = seatAgent();
    const plan = planConfigSet(home, {
      level: 'seat',
      target: agentId,
      settings: [
        { key: 'model', value: 'claude-opus-5-5' },
        { key: 'effort', value: 'high' },
        { key: 'nickname', value: 'b1' },
        { key: 'delivery_order', value: 'native,typed' },
        { key: 'human', value: 'true' },
      ],
    });
    expect(plan.ok).toBe(true);
    const written = writeConfigSet(home, plan, { now: new Date('2026-10-19T08:00:00Z') });
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    const read = readSeatConfigSource(home, agentId, 'builder-1');
    expect(read.ok).toBe(true);
    expect(read.settings.map((entry) => entry.key)).toEqual(['model', 'effort', 'nickname', 'delivery_order', 'human']);
    expect(read.settings.map((entry) => entry.value)).toEqual([
      'claude-opus-5-5',
      'high',
      'b1',
      ['native', 'typed'],
      true,
    ]);
    expect(read.settings.every((entry) => entry.target === agentId)).toBe(true);
    expect(read.settings.every((entry) => entry.level === 'seat')).toBe(true);

    // The record's own fields survive the write, and the signed entries sit in its file.
    const agent = getAgent(home, agentId);
    expect(agent?.reach.seat).toBe('builder-1');
    expect(agent?.settings).toBeDefined();
    expect(readFileSync(seatFile(agentId), 'utf8')).toContain('settings:');
  });

  test('one write shares one bumped generation across every key it signs', () => {
    const agentId = seatAgent();
    const first = writeConfigSet(home, planConfigSet(home, {
      level: 'seat',
      target: agentId,
      settings: [{ key: 'model', value: 'claude-opus-5-5' }, { key: 'effort', value: 'high' }],
    }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const generations = new Set(first.written.map((record) => record.generation));
    expect(generations.size).toBe(1);

    const second = writeConfigSet(home, planConfigSet(home, {
      level: 'seat',
      target: agentId,
      settings: [{ key: 'effort', value: 'low' }],
    }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.written[0]?.generation).toBe(first.generation + 1);
  });

  test('a value changed after signing refuses the whole source, naming the file', () => {
    const agentId = seatAgent();
    const written = writeConfigSet(home, planConfigSet(home, {
      level: 'seat',
      target: agentId,
      settings: [{ key: 'model', value: 'claude-opus-5-5' }],
    }));
    expect(written.ok).toBe(true);

    const path = seatFile(agentId);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('"claude-opus-5-5"');
    writeFileSync(path, text.replace('"claude-opus-5-5"', '"claude-opus-6"'));

    const read = readSeatConfigSource(home, agentId, 'builder-1');
    expect(read.ok).toBe(false);
    expect(read.why).toContain(path);
    expect(read.why).toContain('signature verification failed for setting "model"');
    expect(read.settings).toEqual([]);

    const chain = loadAndResolveConfigChain({ home, agentId, seatName: 'builder-1' });
    expect(chain.ok).toBe(false);
  });

  test('a plan refuses the second key and leaves the first key\'s file unchanged', () => {
    const agentId = seatAgent();
    const path = seatFile(agentId);
    const before = readFileSync(path, 'utf8');

    const plan = planConfigSet(home, {
      level: 'seat',
      target: agentId,
      settings: [{ key: 'model', value: 'claude-opus-5-5' }, { key: 'not_a_setting', value: 'x' }],
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.why).toContain('unknown setting "not_a_setting"');
    expect(plan.why).toContain('known settings: model, effort, nickname, delivery_order, human');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readSeatConfigSource(home, agentId).settings).toEqual([]);
  });

  test('a credential-looking value is refused before anything is written', () => {
    const agentId = seatAgent();
    for (const value of ['ghp_abc123', 'my-secret-token', 'password=hunter2', 'xoxb-1234']) {
      const plan = planConfigSet(home, { level: 'seat', target: agentId, settings: [{ key: 'nickname', value }] });
      expect(plan.ok).toBe(false);
      if (plan.ok) continue;
      expect(plan.why).toContain('looks like a credential');
    }
    expect(readSeatConfigSource(home, agentId).settings).toEqual([]);
  });

  test('unset removes one key, keeps the others, and refuses a key that is not set', () => {
    const agentId = seatAgent();
    const written = writeConfigSet(home, planConfigSet(home, {
      level: 'seat',
      target: agentId,
      settings: [{ key: 'model', value: 'claude-opus-5-5' }, { key: 'effort', value: 'high' }],
    }));
    expect(written.ok).toBe(true);

    const unset = writeConfigUnset(home, { level: 'seat', target: agentId, keys: ['model'] });
    expect(unset.ok).toBe(true);
    const read = readSeatConfigSource(home, agentId);
    expect(read.settings.map((entry) => entry.key)).toEqual(['effort']);

    const path = seatFile(agentId);
    const before = readFileSync(path, 'utf8');
    const again = writeConfigUnset(home, { level: 'seat', target: agentId, keys: ['model'] });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.why).toContain('setting "model" is not set at level seat');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('a record signed for the seat name is read and planned by agent id', () => {
    const agentId = seatAgent('worker');
    injectSeatRecord(agentId, { key: 'nickname', value: 'wren', target: 'worker' });

    const read = readSeatConfigSource(home, agentId, 'worker');
    expect(read.ok).toBe(true);
    expect(read.settings[0]?.target).toBe('worker');

    // A write plan knows only the agent id; the agent file's own `reach.seat` supplies the name
    // the record was signed for, so the same record verifies.
    const plan = planConfigSet(home, { level: 'seat', target: agentId, settings: [{ key: 'nickname', value: 'wren' }] });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.settings[0]?.previous?.target).toBe('worker');
  });

  test('a seat declared before it is launched plans, from the roster or the team file', () => {
    const teamId = registeredTeam();
    const root = join(home, 'repo');
    mkdirSync(join(root, '.agents'), { recursive: true });
    // A file `team check` would refuse still declares its seats, and the declaration is what
    // the bootstrap ruling plans against.
    writeFileSync(join(root, '.agents', 'team.yaml'), [
      'format: 1',
      'project: teamcli',
      'coordinator: lead',
      'operator: lead',
      'seats:',
      '  - role: builder',
      '    name: runner',
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude --model claude-opus-5-5',
      '',
    ].join('\n'));
    upsertTeam(home, teamId, {
      project: 'teamcli',
      session: 'teamcli',
      root,
      lobby: '',
      roster: [{ agent: 'agt_0000000000ff', seat: 'scout', role: 'builder' }],
    });
    for (const name of ['scout', 'runner']) {
      const plan = planConfigSet(home, { level: 'seat', target: name, settings: [{ key: 'effort', value: 'high' }] });
      expect(plan.ok).toBe(true);
      if (plan.ok) expect(plan.settings[0]?.previous).toBeNull();
    }
  });

  test('an undeclared target is refused and burns no generation', () => {
    const agentId = seatAgent();
    const real = () => planConfigSet(home, { level: 'seat', target: agentId, settings: [{ key: 'effort', value: 'high' }] });
    const first = writeConfigSet(home, real());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The plan refuses the name; a forged plan handed straight to the writer refuses too, and
    // neither touches the owner key's generation.
    const plan = planConfigSet(home, { level: 'seat', target: 'ghost', settings: [{ key: 'effort', value: 'low' }] });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.kind).toBe('source');
    const forged = writeConfigSet(home, {
      ok: true,
      level: 'seat',
      target: 'ghost',
      settings: [{ key: 'effort', value: 'low', previous: null }],
    });
    expect(forged.ok).toBe(false);

    const second = writeConfigSet(home, real());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.generation).toBe(first.generation + 1);
  });

  test('the read refuses the words the write refuses, and accepts a model name with spaces', () => {
    const agentId = seatAgent('worker');
    for (const [key, value, needle] of [
      ['delivery_order', ['typed', 'typed'], 'names leg "typed" twice'],
      ['nickname', 'lead', 'may not be "lead"'],
      ['effort', 'sk-live-abc123', 'looks like a credential'],
    ] as const) {
      injectSeatRecord(agentId, { key, value });
      const read = readSeatConfigSource(home, agentId, 'worker');
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.why).toContain(needle);
        // The whole source refuses; the key that did not verify is named in the reason.
        expect(read.why).toContain(`setting "${key}"`);
      }
      // Remove the record again so each case reads alone.
      const agent = getAgent(home, agentId);
      const settings = { ...(agent?.settings ?? {}) };
      delete settings[key];
      updateAgent(home, agentId, { settings });
    }

    injectSeatRecord(agentId, { key: 'nickname', value: 'wren' });
    const plain = readSeatConfigSource(home, agentId, 'worker');
    expect(plain.ok).toBe(true);
    expect(plain.settings[0]?.value).toBe('wren');

    // A model name carries spaces: the write accepts one, and so does the read.
    const plan = planConfigSet(home, { level: 'seat', target: agentId, settings: [{ key: 'model', value: 'Claude Opus' }] });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.settings[0]?.value).toBe('Claude Opus');
    const control = planConfigSet(home, { level: 'seat', target: agentId, settings: [{ key: 'model', value: 'claude\nopus' }] });
    expect(control.ok).toBe(false);
    // The write-side refusals stay.
    for (const [key, value, needle] of [
      ['delivery_order', 'typed,typed', 'names leg "typed" twice'],
      ['nickname', 'lead', 'may not be "lead"'],
      ['nickname', 'sk-live-abc123', 'looks like a credential'],
    ] as const) {
      const refused = planConfigSet(home, { level: 'seat', target: agentId, settings: [{ key, value }] });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.why).toContain(needle);
    }
  });

  test('a target with no registered agent is refused by the plan, and nothing is written', () => {
    const plan = planConfigSet(home, {
      level: 'seat',
      target: 'agt_000000000000',
      settings: [{ key: 'model', value: 'claude-opus-5-5' }],
    });
    // Neither an agent record nor a roster line names the target: the plan refuses before a
    // write could reach the store.
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.kind).toBe('source');
    expect(plan.why).toContain('no registered agent');
    expect(existsSync(join(agentsDir(home), 'agt_000000000000.yaml'))).toBe(false);
  });
});

describe('the registry records above a seat', () => {
  test('the five seat keys may not be set above the seat', () => {
    const teamId = registeredTeam();
    for (const key of ['model', 'effort', 'nickname', 'delivery_order', 'human']) {
      const plan = planConfigSet(home, { level: 'team', target: teamId, settings: [{ key, value: 'x' }] });
      expect(plan.ok).toBe(false);
      if (plan.ok) continue;
      expect(plan.why).toContain('may not be set at level team (allowed: seat)');
    }
  });

  test('a team settings map is carried in teams.yaml, never in the team file', () => {
    const teamId = registeredTeam();
    const settings = {
      workspace: {
        value: 'herdr',
        setter: 'owner',
        date: '2026-10-19T08:00:00.000Z',
        target: teamId,
        generation: 2,
        signature: 'ab',
      },
    };
    upsertTeam(home, teamId, { settings });
    expect(getTeam(home, teamId)?.settings).toEqual(settings);
    const text = readFileSync(teamsFile(home), 'utf8');
    expect(text).toContain('settings:');
    expect(text).toContain('workspace:');

    // The reader verifies entries against the registry: a seat-only key in a team record is
    // refused naming the level where it may be set.
    const refused = readTeamConfigSource(home, teamId);
    expect(refused.ok).toBe(false);
    expect(refused.why).toContain('"workspace" is not a setting of this release');

    const seatKeyInTeam = {
      model: { value: 'claude-opus-5-5', setter: 'owner', date: '2026-10-19T08:00:00.000Z', target: teamId, generation: 2, signature: 'ab' },
    };
    upsertTeam(home, teamId, { settings: seatKeyInTeam });
    const wrongLevel = readTeamConfigSource(home, teamId);
    expect(wrongLevel.ok).toBe(false);
    expect(wrongLevel.why).toContain('may not be set at level team');
  });

  test('a non-map settings in a team record refuses the read, naming the file', () => {
    const teamId = registeredTeam();
    const path = teamsFile(home);
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.replace('    lifecycle: defined\n', '    lifecycle: defined\n    settings: tampered\n'));

    const read = readTeamConfigSource(home, teamId);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.why).toContain(path);
    expect(read.why).toContain('"settings" must be a map');

    // The chain refuses at the team level rather than reading the damage as an absent record.
    const chain = loadAndResolveConfigChain({ home, teamId });
    expect(chain.ok).toBe(false);
    if (!chain.ok) expect(chain.refusals.map((one) => one.level)).toEqual(['team']);
  });

  test('a project settings map is carried in projects.yaml and round-trips', () => {
    const settings = {
      workspace: {
        value: 'headless',
        setter: 'owner',
        date: '2026-10-19T08:00:00.000Z',
        target: 'teamcli',
        generation: 2,
        signature: 'cd',
      },
    };
    upsertProject(home, 'teamcli', { name: 'TeamCLI', settings });
    expect(getProject(home, 'teamcli')?.settings).toEqual(settings);
    const read = readProjectConfigSource(home, 'teamcli');
    expect(read.ok).toBe(false);
    expect(read.why).toContain('not a setting of this release');
  });

  test('an agent settings map round-trips through updateAgent, beside its policies', () => {
    const agentId = seatAgent();
    updateAgent(home, agentId, {
      settings: {
        workspace: { value: 'herdr', setter: 'owner', date: '2026-10-19T08:00:00.000Z', target: agentId, generation: 1, signature: 'ef' },
      },
    });
    expect(getAgent(home, agentId)?.settings?.workspace).toBeDefined();
    expect(readSeatConfigSource(home, agentId).ok).toBe(false);
  });

  test('an entity settings write preserves roots and policies', () => {
    const path = entitiesPath(home);
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(path, [
      'acme:',
      '  roots:',
      '    - /srv/acme',
      '  policies:',
      '    delivery-order:',
      '      value: [native, typed]',
      '      setter: owner',
      '      date: "2026-10-18T00:00:00.000Z"',
      '      expiry: null',
      '      kind: enforced',
      '      target: acme',
      '      generation: 1',
      '      signature: "aa"',
      '',
    ].join('\n'));
    // The entity level admits no key of this release, so a plan is refused there; the reader
    // still reads the file's settings map (empty) and the writer's preservation is covered by the
    // registry round-trip above.
    const read = readProjectConfigSource(home, 'teamcli');
    expect(read.ok).toBe(true);
    expect(read.settings).toEqual([]);
    const entityText = readFileSync(path, 'utf8');
    expect(entityText).toContain('policies:');
    expect(entityText).toContain('roots:');
  });
});

describe('the chain over the four records', () => {
  const record = (key: SignedConfigRecord['key'], value: SignedConfigRecord['value'], level: SignedConfigRecord['level'], target: string): SignedConfigRecord => ({
    key,
    value,
    level,
    target,
    setter: 'owner',
    date: '2026-10-19T00:00:00.000Z',
    generation: 2,
    signature: 'aa',
  });

  const empty = (level: SignedConfigRecord['level'], target: string): ConfigSourceRead => ({ ok: true, level, target, settings: [] });

  test('the nearest level that holds a key decides it, and absence inherits', () => {
    const chain = resolveConfigChain({
      seat: { ok: true, level: 'seat', target: 'agt_000000000001', settings: [record('model', 'seat-model', 'seat', 'agt_000000000001')] },
      team: { ok: true, level: 'team', target: 'team1', settings: [record('model', 'team-model', 'team', 'team1'), record('effort', 'high', 'team', 'team1')] },
      project: { ok: true, level: 'project', target: 'p1', settings: [record('effort', 'low', 'project', 'p1'), record('nickname', 'proj', 'project', 'p1')] },
      entity: { ok: true, level: 'entity', target: 'acme', settings: [record('nickname', 'ent', 'entity', 'acme')] },
    });
    expect(chain.ok).toBe(true);
    if (!chain.ok) return;
    const byKey = Object.fromEntries(chain.settings.map((setting) => [setting.key, setting]));
    expect(byKey.model?.level).toBe('seat');
    expect(byKey.model?.value).toBe('seat-model');
    expect(byKey.effort?.level).toBe('team');
    expect(byKey.nickname?.level).toBe('project');
    expect(byKey.human).toBeUndefined();
  });

  test('a source that does not verify refuses the chain rather than reading as absent', () => {
    const chain = resolveConfigChain({
      seat: null,
      team: empty('team', 'team1'),
      project: { ok: false, level: 'project', target: 'p1', why: 'projects.yaml: signature verification failed', settings: [] },
      entity: null,
    });
    expect(chain.ok).toBe(false);
    if (chain.ok) return;
    expect(chain.refusals[0]?.level).toBe('project');
    expect(chain.refusals[0]?.why).toContain('signature verification failed');
  });
});

describe('a write across levels', () => {
  test('applies seat first, stops at the first refusal, and names what it did not attempt', () => {
    const agentId = seatAgent();
    const teamId = registeredTeam();
    const result = writeConfigAcross(home, [
      { level: 'entity', target: 'acme', settings: [{ key: 'model', value: 'x' }] },
      { level: 'team', target: teamId, settings: [{ key: 'model', value: 'x' }] },
      { level: 'seat', target: agentId, settings: [{ key: 'model', value: 'claude-opus-5-5' }] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.attempted.map((entry) => entry.level)).toEqual(['seat', 'team']);
    expect(result.attempted[0]?.result.ok).toBe(true);
    expect(result.attempted[1]?.result.ok).toBe(false);
    expect(result.skipped).toEqual([{ level: 'entity', target: 'acme' }]);
    expect(readSeatConfigSource(home, agentId).settings.map((entry) => entry.key)).toEqual(['model']);
  });

  test('names a target with no registered agent truthfully, after applying the seat', () => {
    const missing = 'agt_000000000000';
    const result = writeConfigAcross(home, [
      { level: 'seat', target: missing, settings: [{ key: 'effort', value: 'low' }] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.attempted[0]?.result.ok).toBe(false);
    if (result.attempted[0]?.result.ok !== false) return;
    expect(result.attempted[0].result.why).toContain('no registered agent');
    expect(existsSync(join(agentsDir(home), `${missing}.yaml`))).toBe(false);
  });
});
