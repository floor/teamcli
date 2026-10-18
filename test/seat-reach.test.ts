// The seat auto-discovery seam, team side: a seat's owner-only `reach` grant — allowlist,
// schema, validation, and its place in the approval digest. The projection the grant feeds is
// test/reach-projection.test.ts.
import { describe, expect, test } from 'bun:test';
import { compare, fingerprints } from '../src/approve/fingerprint.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';

const HEAD = `format: 1
project: acme
session: acme
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
  - role: assistant
    name: iris
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
`;
const LAUNCH = '    launch: claude --model claude-opus-5-5\n';
const REACH = '    reach:\n      to: [grokbot]\n';

function teamText(reach = ''): string {
  return `${HEAD}${reach}${LAUNCH}`;
}

function team(text: string = teamText()): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function messages(text: string): string[] {
  const result = validateTeamFile(text);
  if (result.ok) throw new Error('the file validated, and the test wanted it refused');
  return result.errors.map((problem) => problem.message);
}

function seatOf(name: string, text: string = teamText()): TeamFile['seats'][number] {
  const seat = team(text).seats.find((one) => one.name === name);
  if (!seat) throw new Error(`no seat ${name}`);
  return seat;
}

describe('a seat\'s reach grant', () => {
  test('reads as written, and a seat without one carries none', () => {
    const granted = seatOf('iris', teamText('    reach:\n      to: [grokbot]\n      alias: iris-x\n      route: floor-20\n      key_id: seat-iris-1\n      guard_dir: /Users/x/guard-floor-iris\n'));
    expect(granted.reach).toEqual({ to: ['grokbot'], alias: 'iris-x', route: 'floor-20', keyId: 'seat-iris-1', guardDir: '/Users/x/guard-floor-iris' });
    const bare = seatOf('iris', teamText(REACH));
    expect(bare.reach).toEqual({ to: ['grokbot'] });
    expect(seatOf('lead', teamText(REACH)).reach).toBeUndefined();
  });

  test('refuses what the projection readers would refuse, by name and line', () => {
    const cases: Array<[string, string]> = [
      ['    reach: 5\n', 'seat "iris": reach must be a map of fields'],
      ['    reach:\n', 'seat "iris": reach.to is required: at least one front'],
      ['    reach:\n      from: [grokbot]\n', 'unknown field "from" in seat "iris": reach'],
      ['    reach:\n      to: []\n', 'seat "iris": reach.to is required: at least one front'],
      ['    reach:\n      to: [Grokbot]\n', 'seat "iris": reach.to "Grokbot" must be one of: grokbot'],
      ['    reach:\n      to: [other-front]\n', 'seat "iris": reach.to "other-front" must be one of: grokbot'],
      ['    reach:\n      to: [grokbot]\n      alias: "-iris"\n', 'seat "iris": reach.alias "-iris" takes letters, digits, ".", "_" and "-" (a letter or digit first, 64 at most)'],
      ['    reach:\n      to: [grokbot]\n      route: "floor 20"\n', 'seat "iris": reach.route "floor 20" takes letters, digits, ".", "_" and "-" (a letter or digit first, 64 at most)'],
      ['    reach:\n      to: [grokbot]\n      key_id: "seat iris"\n', 'seat "iris": reach.key_id "seat iris" takes letters, digits, ".", "_" and "-" (a letter or digit first, 64 at most)'],
      ['    reach:\n      to: [grokbot]\n      alias: iris-x\n      guard_dir: lobby/guard\n', 'seat "iris": reach.guard_dir must be an absolute path'],
    ];
    for (const [reach, message] of cases) {
      expect(messages(teamText(reach))).toContain(message);
    }
  });

  test('the defaults\' own rules: a name too long for the alias or for seat-<alias>-1 is refused here', () => {
    // 57 characters is the longest name whose default key_id `seat-<alias>-1` still fits 64.
    expect(() => team(teamText(REACH).replace('    name: iris\n', `    name: ${'i'.repeat(57)}\n`))).not.toThrow();
    expect(messages(teamText(REACH).replace('    name: iris\n', `    name: ${'i'.repeat(58)}\n`)))
      .toContainEqual(expect.stringContaining('the default reach key_id "seat-'));
    expect(messages(teamText(REACH).replace('    name: iris\n', `    name: ${'i'.repeat(65)}\n`)))
      .toContainEqual(expect.stringContaining('the reach alias'));
  });

  test('count expands the grant like every field, and two seats must not land on one alias', () => {
    const counted = team(teamText(REACH).replace('    name: iris\n', '    name: iris\n    count: 2\n'));
    expect(counted.seats.filter((seat) => seat.declared === 'iris').map((seat) => seat.name)).toEqual(['iris', 'iris-2']);
    const explicit = teamText('    reach:\n      to: [grokbot]\n      alias: shared\n').replace('    name: iris\n', '    name: iris\n    count: 2\n');
    expect(messages(explicit)).toContainEqual(expect.stringContaining('two seats reach the same alias "shared"'));
    // A name only differing in case collides too: the readers canonicalize to lowercase.
    const twin = teamText(REACH)
      .replace('    name: iris\n', '    name: IRIS\n')
      .replace(LAUNCH, `${LAUNCH}    reach:\n      to: [grokbot]\n      alias: iris\n`);
    expect(messages(twin)).toContainEqual(expect.stringContaining('two seats reach the same alias "iris"'));
  });

  test('the projection holds at most 32 seats, and the 33rd is refused with its line', () => {
    const seats = (count: number): string => Array.from({ length: count }, (_, n) =>
      `  - role: implementer\n    name: s${n}\n    cli: codex\n    vendor: openai\n    model: GPT Sol\n    version: "6"\n    launch: codex\n    reach:\n      to: [grokbot]\n`).join('');
    const text = (count: number): string =>
      `format: 1\nproject: acme\nsession: acme\ncoordinator: s0\noperator: s0\nworkspace:\n  mode: shared\nseats:\n${seats(count)}`;
    expect(() => team(text(32))).not.toThrow();
    expect(messages(text(33))).toContainEqual(expect.stringContaining('the projection holds at most 32 seats — this seat is number 33'));
  });

  test('a reach grant is part of the seat digest: writing one needs a new approval', () => {
    const before = fingerprints(team(teamText()));
    const after = fingerprints(team(teamText(REACH)));
    expect(after.seats['iris']).not.toBe(before.seats['iris']);
    expect(after.seats['lead']).toBe(before.seats['lead']);
    expect(compare(before, after)).toContainEqual({ kind: 'seat-changed', name: 'iris' });
  });
});
