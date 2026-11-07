// A generated id that YAML 1.1 would read as a float or an integer is written quoted,
// and a read returns the same text. Synthetic ids only. `12e45` is a float; twelve digits are an integer.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';
import { recordText } from '../src/config/team-record.ts';
import { skeleton } from '../src/commands/init.ts';
import { renameTeamIdentity } from '../src/file/lines.ts';
import { agentsDir, readAgents, registerAgent } from '../src/registry/agents.ts';
import { parseYaml, toValue } from '../src/yaml.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const FLOAT_ID = '12e45';
const DIGIT_ID = '123456789012';

function mapOf(text: string): Record<string, unknown> {
  const value = toValue(parseYaml(text));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a map');
  return value as Record<string, unknown>;
}

test('a letter-leading project stays a bare word', () => {
  expect(skeleton('floor', null)).toContain('project: floor\n');
});

test('a float-shaped project id and an all-digit project id are quoted and read back as text', () => {
  for (const id of [FLOAT_ID, DIGIT_ID]) {
    const text = skeleton(id, null);
    expect(text, id).toContain(`project: "${id}"`);
    expect(mapOf(text).project, id).toBe(id);
  }
});

test('a renamed project, in_project, and session keep a float-shaped id as text', () => {
  const next = renameTeamIdentity('format: 1\nproject: floor\n', {
    project: FLOAT_ID,
    inProject: DIGIT_ID,
    session: FLOAT_ID,
  });
  expect(next).toContain(`project: "${FLOAT_ID}"`);
  expect(next).toContain(`in_project: "${DIGIT_ID}"`);
  expect(next).toContain(`session: "${FLOAT_ID}"`);
  const parsed = mapOf(next);
  expect(parsed.project).toBe(FLOAT_ID);
  expect(parsed.in_project).toBe(DIGIT_ID);
  expect(parsed.session).toBe(FLOAT_ID);
});

test('a regenerated record quotes a float-shaped key', () => {
  const text = recordText({ [FLOAT_ID]: 'kept' });
  expect(text).toContain(`"${FLOAT_ID}":`);
  expect(mapOf(text)[FLOAT_ID]).toBe('kept');
});

test('an agent file quotes a float-shaped team id and a float-shaped policy key', () => {
  const base = fixtureBase('yaml-id-');
  const home = join(base, 'home');
  try {
    const agent = registerAgent(home, {
      name: 'hand',
      signing: { model: 'Test', version: '1', role: 'worker' },
      lab: 'test',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: FLOAT_ID, seat: 'hand', session: 'floor', pane: null, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'registered',
      policies: { note: { [FLOAT_ID]: 'kept' } },
      settings: { note: { [DIGIT_ID]: 'kept' } },
      by: 'owner',
    });
    const written = readFileSync(join(agentsDir(home), `${agent.id}.yaml`), 'utf8');
    expect(written).toContain(`team: "${FLOAT_ID}"`);
    expect(written).toContain(`"${FLOAT_ID}": "kept"`);
    expect(written).toContain(`"${DIGIT_ID}": "kept"`);
    const read = readAgents(home).find((item) => item.id === agent.id);
    expect(read?.reach.team).toBe(FLOAT_ID);
    const note = read?.policies?.note;
    expect(note !== null && typeof note === 'object' && !Array.isArray(note) ? (note as Record<string, unknown>)[FLOAT_ID] : undefined).toBe('kept');
  } finally {
    discardFixtures([base], { roots: [dirname(base)] });
  }
});
