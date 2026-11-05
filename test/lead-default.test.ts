// A team's lead defaults through the chain universe < entity < project < team. The
// team file's own `leads: true` (or `coordinator:`) still decides the lead seat; the chain only
// picks the seat when the file marks none, and the narrowest level that declares a word wins.
// The universe's word is the machine settings file's top-level `lead:` (the universe has no
// runtime record in this build); the entity's is its entry's `lead:` in entities.yaml; the
// project's is its record's `lead_seat:` in projects.yaml; the team's is the file's `lead:`.
// Every scene is synthetic: homes, checkouts and registries are the test's own.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entitiesPath } from '../src/entities.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { defaultLeadOf, readLeadChain } from '../src/lead-chain.ts';
import { leadWordProblem, resolveLead } from '../src/lead.ts';
import { projectsFile } from '../src/registry/projects.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { machineSettingsPath } from '../src/settings/declared.ts';

const NO_LEAD = 'the file has no seat that leads: put `leads: true` on one seat';

/** The chain's order, as a plain function: the narrowest declared word wins. */
describe('the resolution order', () => {
  test('each narrower level overrides the wider one', () => {
    const all = { universe: 'yoda', entity: 'obi', project: 'rex', team: 'ahsoka' };
    expect(resolveLead(all)).toEqual({ lead: 'ahsoka', level: 'team' });
    expect(resolveLead({ ...all, team: undefined })).toEqual({ lead: 'rex', level: 'project' });
    expect(resolveLead({ universe: 'yoda', entity: 'obi' })).toEqual({ lead: 'obi', level: 'entity' });
    expect(resolveLead({ universe: 'yoda' })).toEqual({ lead: 'yoda', level: 'universe' });
  });

  test('a level that declares nothing is skipped, not invented', () => {
    expect(resolveLead({ universe: 'yoda', project: 'rex' })).toEqual({ lead: 'rex', level: 'project' });
    expect(resolveLead({ entity: 'obi', team: 'ahsoka' })).toEqual({ lead: 'ahsoka', level: 'team' });
  });

  test('no word at any level resolves to no lead', () => {
    expect(resolveLead({})).toBeNull();
  });

  test('a lead word is one seat name', () => {
    for (const word of ['yoda', 'obi-wan', 'r2.d2', 'hand_1', 'a']) expect(leadWordProblem(word)).toBeNull();
    for (const word of ['', 'two words', 'orchestrator lead', '.hidden', 'x'.repeat(65)]) {
      expect(leadWordProblem(word)).not.toBeNull();
    }
  });
});

type World = { base: string; home: string; root: string };

let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'lead-default-')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A machine: a home, a checkout that is a project root, and nothing declared yet. */
function world(): World {
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  return { base, home, root };
}

/** The universe's word, in the machine settings file. */
function universeLead(home: string, word: string): void {
  writeFileSync(machineSettingsPath(home), `lead: ${word}\n`);
}

/** The entity's word, in the owner's entities file. */
function entityLead(home: string, word: string): void {
  writeFileSync(entitiesPath(home), `floor:\n  roots:\n    - ${base}\n  lead: ${word}\n`);
}

/** The project's word: its registry record names the team and carries `lead_seat`. */
function projectLead(world: World, word: string): void {
  const prov = '{ registered_by: owner, registered_at: "2026-11-05T00:00:00.000Z", updated_at: "2026-11-05T00:00:00.000Z" }';
  const text = [
    'projects:',
    '  acme:',
    '    name: Acme',
    '    entity: floor',
    '    lead: null',
    `    teams: [${teamIdOf(world.root)}]`,
    `    lead_seat: ${word}`,
    `    provenance: ${prov}`,
    '',
  ].join('\n');
  writeFileSync(projectsFile(world.home), text);
}

/** The team file: five declared seats, so every level's word can name one of them. */
function teamText(options: { lead?: string; mark?: string } = {}): string {
  const seat = (name: string, extra = ''): string => `  - role: implementer
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${extra}`;
  const marked = (name: string): string => (options.mark === name ? '    leads: true\n' : '');
  return `format: 1
project: acme
session: acme
entity: floor
operator: worker
${options.lead !== undefined ? `lead: ${options.lead}\n` : ''}workspace:
  mode: shared
seats:
${seat('yoda', marked('yoda'))}${seat('obi', marked('obi'))}${seat('rex', marked('rex'))}${seat('ahsoka', marked('ahsoka'))}${seat('worker', marked('worker'))}`;
}

function load(world: World, text = teamText()): ReturnType<typeof validateTeamFile> {
  return validateTeamFile(text, { home: world.home, root: world.root });
}

function leadOf(result: ReturnType<typeof validateTeamFile>): string {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team.orchestrator;
}

describe('the default lead, end to end', () => {
  test('with no word anywhere the file is refused exactly as before', () => {
    const at = world();
    const refused = load(at);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('a file with no lead must not load');
    expect(refused.errors).toEqual([{ line: 1, message: NO_LEAD }]);
  });

  test('the universe word alone picks the lead', () => {
    const at = world();
    universeLead(at.home, 'yoda');
    expect(leadOf(load(at))).toBe('yoda');
  });

  test('the entity word overrides the universe', () => {
    const at = world();
    universeLead(at.home, 'yoda');
    entityLead(at.home, 'obi');
    expect(leadOf(load(at))).toBe('obi');
  });

  test('the home project\'s word overrides the entity', () => {
    const at = world();
    universeLead(at.home, 'yoda');
    entityLead(at.home, 'obi');
    projectLead(at, 'rex');
    expect(leadOf(load(at))).toBe('rex');
  });

  test('the team file\'s `lead:` overrides the project', () => {
    const at = world();
    universeLead(at.home, 'yoda');
    entityLead(at.home, 'obi');
    projectLead(at, 'rex');
    expect(leadOf(load(at, teamText({ lead: 'ahsoka' })))).toBe('ahsoka');
  });

  test('`leads: true` wins over every level, and over the team\'s own word', () => {
    const at = world();
    universeLead(at.home, 'yoda');
    entityLead(at.home, 'obi');
    projectLead(at, 'rex');
    expect(leadOf(load(at, teamText({ lead: 'ahsoka', mark: 'worker' })))).toBe('worker');
  });

  test('a level that cannot be read refuses rather than falling through', () => {
    const at = world();
    universeLead(at.home, 'yoda');
    writeFileSync(entitiesPath(at.home), 'floor:\n  roots:\n    - ' + base + '\n  lead: two words\n');
    const refused = load(at);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('a bad entity word must not load');
    expect(refused.errors[0]!.message).toContain(`${entitiesPath(at.home)}: entity "floor" lead must be one seat name`);
  });

  test('a chain word naming no declared seat is refused with the level that named it', () => {
    const at = world();
    entityLead(at.home, 'nobody');
    const refused = load(at);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('a word naming no seat must not load');
    expect(refused.errors).toEqual([{ line: 1, message: 'the entity\'s lead "nobody" names no declared seat' }]);
  });

  test('a team `lead:` naming no seat is refused even beside a mark', () => {
    const at = world();
    const refused = load(at, teamText({ lead: 'nobody', mark: 'yoda' }));
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('a typo must never be silently overridden');
    expect(refused.errors.map((problem) => problem.message)).toContain('lead "nobody" names no declared seat');
  });

  test('a reader holding only the text reads no chain: the file is refused as before', () => {
    const text = teamText();
    expect(validateTeamFile(text).ok).toBe(false);
  });
});

describe('the chain reader', () => {
  test('stops at the narrowest word: a wider level that would refuse is never read', () => {
    const at = world();
    writeFileSync(entitiesPath(at.home), 'floor:\n  roots:\n    - ' + base + '\n  lead: two words\n');
    const read = readLeadChain({ home: at.home, root: at.root, team: 'ahsoka' });
    expect(read).toEqual({ ok: true, chain: { team: 'ahsoka' } });
  });

  test('reports the level the word came from', () => {
    const at = world();
    projectLead(at, 'rex');
    expect(defaultLeadOf({ home: at.home, root: at.root })).toEqual({ ok: true, lead: { lead: 'rex', level: 'project' } });
  });

  test('a project whose `lead_seat` cannot be read refuses, naming the file', () => {
    const at = world();
    projectLead(at, '"two words"');
    const read = readLeadChain({ home: at.home, root: at.root });
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('a bad project word must not read');
    expect(read.why).toContain(projectsFile(at.home));
  });
});
