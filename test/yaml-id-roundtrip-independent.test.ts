// An id YAML would read as a number is written so a read returns that same string.
// A letter-leading id stays a bare word. Synthetic ids only.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { skeleton } from '../src/commands/init.ts';
import { recordText } from '../src/config/team-record.ts';
import { renameTeamIdentity } from '../src/file/lines.ts';
import { canonicalTeam } from '../src/file/team-config.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { agentsDir, readAgents, registerAgent } from '../src/registry/agents.ts';
import { parseYaml, toValue } from '../src/yaml.ts';

const IDS = ['12e45', '1e5a3f', '123456789012', '0x1f'] as const;
const LETTER = 'harbor';

const SEATS = `operator: orchestrator
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Test
    version: "0"
    launch: claude
    leads: true
`;

function mapOf(text: string): Record<string, unknown> {
  const value = toValue(parseYaml(text));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a map');
  return value as Record<string, unknown>;
}

function teamText(project: string, session: string): string {
  return `format: 1\nproject: ${project}\nsession: ${session}\n${SEATS}`;
}

function digestOf(text: string): string {
  const loaded = validateTeamFile(text);
  expect(loaded.ok, loaded.ok ? '' : loaded.errors.map((error) => error.message).join(' | ')).toBe(true);
  if (!loaded.ok) return '';
  return createHash('sha256').update(canonicalTeam(loaded.team)).digest('hex');
}

test('a letter-leading id stays a bare word', () => {
  expect(skeleton(LETTER, null)).toContain(`project: ${LETTER}\n`);
  expect(skeleton(LETTER, null)).not.toContain(`project: "${LETTER}"`);

  const renamed = renameTeamIdentity(teamText('floor', 'floor'), {
    project: LETTER,
    inProject: LETTER,
    session: 'morning',
  });
  expect(renamed).toContain(`project: ${LETTER}\n`);
  expect(renamed).toContain(`in_project: ${LETTER}\n`);
  expect(renamed).toContain('session: morning\n');
  expect(renamed).not.toContain(`"${LETTER}"`);

  const record = recordText({ [LETTER]: 'kept' });
  expect(record).toContain(`${LETTER}: kept\n`);
  expect(record).not.toContain(`"${LETTER}"`);
  expect(mapOf(record)[LETTER]).toBe('kept');
});

test('each writer reads a number-shaped id back as that string', () => {
  for (const id of IDS) {
    const sketched = skeleton(id, null);
    expect(sketched, id).toContain(`project: "${id}"`);
    expect(mapOf(sketched).project, id).toBe(id);

    const renamed = renameTeamIdentity(teamText('floor', 'floor'), {
      project: id,
      inProject: id,
      session: id,
    });
    expect(renamed, id).toContain(`project: "${id}"`);
    expect(renamed, id).toContain(`in_project: "${id}"`);
    expect(renamed, id).toContain(`session: "${id}"`);
    const parsed = mapOf(renamed);
    expect(parsed.project, id).toBe(id);
    expect(parsed.in_project, id).toBe(id);
    expect(parsed.session, id).toBe(id);

    const record = recordText({ [id]: 'kept' });
    expect(record, id).toContain(`"${id}": kept\n`);
    expect(mapOf(record)[id], id).toBe('kept');
  }
});

test('rewriting a team file with a number-shaped id keeps the same canonical digest', () => {
  for (const id of IDS) {
    const once = renameTeamIdentity(teamText('floor', 'floor'), {
      project: id,
      inProject: id,
      session: id,
    });
    const twice = renameTeamIdentity(once, { project: id, inProject: id, session: id });
    expect(digestOf(twice), id).toBe(digestOf(once));
  }
});

test('an agent file reads number-shaped policy and settings keys back as those strings', () => {
  const home = mkdtempSync(join(tmpdir(), 'yaml-id-roundtrip-'));
  try {
    const agent = registerAgent(home, {
      name: 'hand',
      signing: { model: 'Test', version: '1', role: 'worker' },
      lab: 'test',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: IDS[0], seat: 'hand', session: LETTER, pane: null, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'registered',
      policies: { [LETTER]: { [IDS[0]]: 'kept', [IDS[1]]: 'kept', [IDS[3]]: 'kept' } },
      settings: { morning: { [IDS[2]]: 'kept' } },
      by: 'owner',
    });
    const written = readFileSync(join(agentsDir(home), `${agent.id}.yaml`), 'utf8');
    for (const id of IDS) expect(written, id).toContain(`"${id}"`);
    const read = readAgents(home).find((item) => item.id === agent.id);
    expect(read?.reach.team).toBe(IDS[0]);
    expect(read?.reach.session).toBe(LETTER);
    const policy = read?.policies?.[LETTER];
    expect(policy !== null && typeof policy === 'object' && !Array.isArray(policy)).toBe(true);
    if (policy !== null && typeof policy === 'object' && !Array.isArray(policy)) {
      const keys = policy as Record<string, unknown>;
      expect(keys[IDS[0]]).toBe('kept');
      expect(keys[IDS[1]]).toBe('kept');
      expect(keys[IDS[3]]).toBe('kept');
    }
    const settings = read?.settings?.morning;
    expect(settings !== null && typeof settings === 'object' && !Array.isArray(settings)).toBe(true);
    if (settings !== null && typeof settings === 'object' && !Array.isArray(settings)) {
      expect((settings as Record<string, unknown>)[IDS[2]]).toBe('kept');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
