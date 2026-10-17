import { describe, expect, test } from 'bun:test';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { formatDiff } from '../src/approve/diff.ts';
import { trustPolicy } from '../src/file/dialogs.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { insideTrust } from '../src/file/paths.ts';

const minimal = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function team(extra = '') {
  const result = validateTeamFile(`${minimal}${extra}`);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function problems(extra: string): string[] {
  const result = validateTeamFile(`${minimal}${extra}`);
  return result.ok ? [] : result.errors.map((problem) => problem.message);
}

describe('dialogs', () => {
  test('omitted means owner, and only owner or coordinator is a value', () => {
    expect(team().dialogs).toEqual({ trust: 'owner' });
    expect(team('dialogs:\n  trust: owner\n').dialogs).toEqual({ trust: 'owner' });
    expect(team('dialogs:\n  trust: coordinator\n').dialogs).toEqual({ trust: 'coordinator' });
    expect(problems('dialogs:\n')).toContain('dialogs must be a map containing trust');
    expect(problems('dialogs:\n  permission: owner\n').join('\n')).toContain('unknown field "permission"');
    expect(problems('dialogs:\n  permission: owner\n').join('\n')).toContain('dialogs must contain trust');
    expect(problems('dialogs:\n  trust: someone\n').join('\n')).toContain('dialogs.trust must be one of: owner, orchestrator, coordinator');
    expect(problems('dialogs:\n  trust: 1\n').join('\n')).toContain('dialogs.trust must be one of: owner, orchestrator, coordinator');
    expect(problems('dialogs:\n  trust: owner\n  trust: coordinator\n').join('\n')).toContain('duplicate key "trust"');
  });

  test('the new spelling reads, normalises to the hashed value, and warns nothing of its own', () => {
    const result = validateTeamFile(`${minimal}dialogs:\n  trust: orchestrator\n`);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    // Only the fixture's own legacy `coordinator:` key warns here (line 3); the new trust
    // value is today's word and says nothing.
    expect(result.warnings).toEqual([
      {
        line: 3,
        message: '`coordinator:` is now `leads: true` on the lead\'s seat, and is still read',
        repair: "set `leads: true` on the lead's seat and remove `coordinator:` from .agents/team.yaml",
      },
    ]);
    expect(result.team.dialogs).toEqual({ trust: 'coordinator' });
    expect(trustPolicy(result.team)).toBe('coordinator');
    // One policy, one parsed value: both spellings hash the same, so a file rewritten to the
    // new word is still the file the owner approved, and an old record still matches it.
    expect(fingerprints(result.team).sections.dialogs).toBe(fingerprints(team('dialogs:\n  trust: coordinator\n')).sections.dialogs);
  });

  test('the old spelling still reads, with its notice at its own line', () => {
    const result = validateTeamFile(`${minimal}dialogs:\n  trust: coordinator\n`);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.warnings).toEqual([
      {
        line: 3,
        message: '`coordinator:` is now `leads: true` on the lead\'s seat, and is still read',
        repair: "set `leads: true` on the lead's seat and remove `coordinator:` from .agents/team.yaml",
      },
      {
        line: minimal.split('\n').length + 1,
        message: '`dialogs.trust: coordinator` is now `orchestrator`, and is still read',
        repair: 'set `dialogs.trust: orchestrator` in .agents/team.yaml',
      },
    ]);
    expect(result.team.dialogs).toEqual({ trust: 'coordinator' });
  });

  test('the owner-section fingerprint changes with it, and the diff names the line', () => {
    const omitted = fingerprints(team());
    const owner = fingerprints(team('dialogs:\n  trust: owner\n'));
    const coordinator = fingerprints(team('dialogs:\n  trust: coordinator\n'));
    expect(omitted.sections.dialogs).toBe(owner.sections.dialogs);
    expect(coordinator.sections.dialogs).not.toBe(owner.sections.dialogs);
    const shown = formatDiff(minimal, `${minimal}dialogs:\n  trust: coordinator\n`).join('\n');
    expect(shown).toContain('dialogs:');
    expect(shown).toContain('trust: coordinator');
  });

  test('an absolute trust entry is not a prefix', () => {
    expect(insideTrust('srv/lobby', ['/srv/lobby'])).toBe(false);
  });

  test('the policy is read through one function, and a team without the section is the owner\'s', () => {
    expect(trustPolicy(team())).toBe('owner');
    expect(trustPolicy(team('dialogs:\n  trust: coordinator\n'))).toBe('coordinator');
    expect(trustPolicy({})).toBe('owner');
  });
});
