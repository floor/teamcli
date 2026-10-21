// The two context corners of the config read: a roster line names the agent but must not skip the
// project registry that resolves the entity and project around it, and the loaded declaration's
// own `entity:` must still reach the entity source when the registry names none, so a bad entity
// source refuses the read instead of disappearing from it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runSettings } from '../src/commands/settings.ts';
import { agentIdOf, readSeatSettings } from '../src/config/read.ts';
import { entitiesPath } from '../src/entities.ts';
import { registerAgent, type AgentInit } from '../src/registry/agents.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { installKey } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

let base: string;
let home: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-config-read-context-')));
  home = join(base, 'home');
  root = join(base, 'repo');
  mkdirSync(join(root, '.agents'), { recursive: true });
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const SEAT = { name: 'builder-1', model: 'Claude Opus' } as const;

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

function read() {
  return readSeatSettings({ home, root, project: 'acme', seat: SEAT, teamDeliveryOrder: null });
}

/** The team record exists and carries a roster line, while its project and entity are null: the
 *  project registry is the only declaration of both. The registry also holds a newer agent for
 *  the same team and seat, so a read that falls through to it instead of the roster is visible. */
function rosterWithNullProject(): { rosterAgent: string; newerAgent: string } {
  const teamId = teamIdOf(root);
  const reach = { ...init().reach, team: teamId };
  const rosterAgent = registerAgent(home, { ...init(), reach }).id;
  const newerAgent = registerAgent(home, { ...init(), name: 'Builder One, again', reach }).id;
  upsertTeam(home, teamId, {
    project: 'acme',
    session: 'acme',
    root,
    lobby: '',
    roster: [{ agent: rosterAgent, seat: SEAT.name, role: 'builder' }],
  });
  return { rosterAgent, newerAgent };
}

function writeEntitySettings(text: string): void {
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(entitiesPath(home), text);
}

const ENTITY_SETTINGS = [
  'acme-entity:',
  '  roots:',
  '    - /srv/acme',
  '  settings:',
  '    workspace:',
  '      value: herdr',
  '      setter: owner',
  '      date: "2026-10-19T08:00:00.000Z"',
  '      target: acme-entity',
  '      generation: 1',
  '      signature: "aa"',
  '',
].join('\n');

describe('a roster line and the project it sits in', () => {
  test('the roster names the agent, and the project registry still resolves entity and project', () => {
    const { rosterAgent, newerAgent } = rosterWithNullProject();
    upsertProject(home, 'acme', { name: 'Acme', teams: [teamIdOf(root)], entity: 'acme-entity' });

    const found = agentIdOf(home, root, SEAT.name);
    expect(found.agentId).toBe(rosterAgent);
    expect(found.agentId).not.toBe(newerAgent);
    expect(found.projectId).toBe('acme');
    expect(found.entity).toBe('acme-entity');
  });

  test('the resolved project is read, so a bad project record refuses instead of being skipped', () => {
    rosterWithNullProject();
    upsertProject(home, 'acme', {
      name: 'Acme',
      teams: [teamIdOf(root)],
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

describe('the entity the declaration names', () => {
  test('reads the entity source a registry names no entity for', () => {
    registerAgent(home, init());
    writeEntitySettings(ENTITY_SETTINGS);

    // The registry names no entity, so the source is skipped when nothing else declares one.
    expect(read().ok).toBe(true);

    const declared = readSeatSettings({ home, root, project: 'acme', seat: SEAT, teamDeliveryOrder: null, entity: 'acme-entity' });
    expect(declared.ok).toBe(false);
    if (declared.ok) return;
    expect(declared.refusals.map((one) => one.level)).toEqual(['entity']);
    expect(declared.refusals[0]!.why).toContain(entitiesPath(home));
    expect(declared.refusals[0]!.why).toContain('not a setting of this release');
  });

  test('an unreadable entity source refuses when the declaration names the entity', () => {
    registerAgent(home, init());
    writeEntitySettings('acme-entity: [unclosed\n');

    expect(read().ok).toBe(true);

    const declared = readSeatSettings({ home, root, project: 'acme', seat: SEAT, teamDeliveryOrder: null, entity: 'acme-entity' });
    expect(declared.ok).toBe(false);
    if (declared.ok) return;
    expect(declared.refusals.map((one) => one.level)).toEqual(['entity']);
    expect(declared.refusals[0]!.why).toContain(entitiesPath(home));
  });
});

describe('the command passes the declaration entity', () => {
  const TEAM = `format: 1
project: acme
entity: acme-entity
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
`;

  test('team settings refuses a bad entity source the file declares', async () => {
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
    writeEntitySettings(ENTITY_SETTINGS);
    const io = testIo(root, { kind: 'owner' } as Caller);
    const code = await runSettings(['lead'], io, { home, now: new Date('2026-10-19T10:00:00Z') });
    expect(code).toBe(2);
    expect(io.out).toBe('');
    expect(io.err).toContain('team settings: ');
    expect(io.err).toContain(entitiesPath(home));
    expect(io.err).toContain('not a setting of this release');
  });
});
