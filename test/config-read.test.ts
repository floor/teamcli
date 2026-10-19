// The read path over the four signed records: the chain resolver verifies each source, the
// composition folds the winner with the team file's own words, and a record that does not verify
// refuses the read naming its file (OD-20261018-08).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentsDir, registerAgent, type AgentInit } from '../src/registry/agents.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { planConfigSet, writeConfigSet } from '../src/config/sources.ts';
import { agentIdOf, readSeatSettings } from '../src/config/read.ts';
import { installKey } from '../src/store/keys.ts';

let base: string;
let home: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-config-read-')));
  home = join(base, 'home');
  root = join(base, 'repo');
  mkdirSync(join(root, '.agents'), { recursive: true });
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const SEAT = { name: 'builder-1', model: 'Claude Opus' } as const;

function seatDoc(agentId: string) {
  return join(agentsDir(home), `${agentId}.yaml`);
}

function init(): AgentInit {
  return {
    name: 'Builder One',
    signing: { model: 'Claude Sonnet', version: '5.5', role: 'builder' },
    lab: 'anthropic',
    cli: 'antigravity',
    launcher: null,
    launch: 'zsh -lc "agy --model claude-sonnet-5-5-high"',
    reach: { team: 'acme', seat: SEAT.name, session: 'acme', pane: 'w36:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  };
}

function registeredSeat(): string {
  const agentId = registerAgent(home, init()).id;
  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    session: 'acme',
    root,
    lobby: '',
    roster: [{ agent: agentId, seat: SEAT.name, role: 'builder' }],
  });
  return agentId;
}

function writeSeatSetting(agentId: string): string {
  const plan = planConfigSet(home, {
    level: 'seat',
    target: agentId,
    settings: [{ key: 'model', value: 'claude-opus-5-5' }],
  });
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error('plan refused');
  const written = writeConfigSet(home, plan, { now: new Date('2026-10-19T08:00:00Z') });
  expect(written.ok).toBe(true);
  return seatDoc(agentId);
}

function read() {
  return readSeatSettings({ home, root, project: 'acme', seat: SEAT, teamDeliveryOrder: null });
}

describe('readSeatSettings', () => {
  test('the signed seat record wins the key and names its file', () => {
    const agentId = registeredSeat();
    const path = writeSeatSetting(agentId);
    const result = read();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const model = result.rows.find((entry) => entry.key === 'model')!;
    expect(model.value).toBe('claude-opus-5-5');
    expect(model.origin).toBe('seat record');
    expect(model.sourceFile).toBe(path);
    // A key no record sets still reads the team file / release default.
    expect(result.rows.find((entry) => entry.key === 'human')!.origin).toBe('default');
  });

  test('a tampered record refuses the read, naming the file and the setting', () => {
    const agentId = registeredSeat();
    const path = writeSeatSetting(agentId);
    writeFileSync(path, readFileSync(path, 'utf8').replace('claude-opus-5-5', 'claude-haiku-5-5'));
    const result = read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.length).toBe(1);
    expect(result.refusals[0]!.why).toContain(path);
    expect(result.refusals[0]!.why).toContain('signature verification failed for setting "model"');
  });

  test('a home of null reads the team file alone, never the real store', () => {
    registeredSeat();
    const result = readSeatSettings({ home: null, root, project: 'acme', seat: SEAT, teamDeliveryOrder: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((entry) => entry.key === 'model')!.origin).toBe('team file');
  });
});

describe('the seat found without a team record', () => {
  test('finds the agent by its stable team id, not the team’s own name', () => {
    const teamId = teamIdOf(root);
    const agentId = registerAgent(home, {
      ...init(),
      reach: { team: teamId, seat: SEAT.name, session: 'acme', pane: 'w36:p1', address: null },
    }).id;
    const found = agentIdOf(home, root, SEAT.name);
    expect(found.agentId).toBe(agentId);
  });

  test('derives the project and entity the project registry declares', () => {
    const teamId = teamIdOf(root);
    registerAgent(home, {
      ...init(),
      reach: { team: teamId, seat: SEAT.name, session: 'acme', pane: 'w36:p1', address: null },
    });
    upsertProject(home, 'acme', { name: 'Acme', teams: [teamId], entity: 'acme-entity' });
    const found = agentIdOf(home, root, SEAT.name);
    expect(found.projectId).toBe('acme');
    expect(found.entity).toBe('acme-entity');
  });

  test('a tampered project record refuses the read instead of being skipped', () => {
    const teamId = teamIdOf(root);
    registerAgent(home, {
      ...init(),
      reach: { team: teamId, seat: SEAT.name, session: 'acme', pane: 'w36:p1', address: null },
    });
    upsertProject(home, 'acme', {
      name: 'Acme',
      teams: [teamId],
      settings: {
        workspace: { value: 'herdr', setter: 'owner', date: '2026-10-19T08:00:00.000Z', target: 'acme', generation: 2, signature: 'cd' },
      },
    });
    const result = read();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.map((one) => one.level)).toEqual(['project']);
    expect(result.refusals[0]!.why).toContain('not a setting of this release');
  });
});
