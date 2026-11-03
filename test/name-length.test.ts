// NAME-LENGTH coverage: an entity or project name is one path segment of 128 characters at most.
// The name can become a `config.changed` record id's target
// (`config:<level>:<target>:<key>:<generation>[:unset]`), and that id is refused past 200
// characters, so the bound is what keeps every id a name can compose inside the rule. The scenes
// below pin the boundary on both fields and the arithmetic behind it.
import { describe, expect, test } from 'bun:test';
import { EVENT_RECORD_ID } from '../src/bus/log.ts';
import { configChangedRecordId } from '../src/config/events.ts';
import { ENTITY_NAME } from '../src/file/sections/entity.ts';
import { validateTeamFile } from '../src/file/validate.ts';

const MAX = 128;
const at = (length: number): string => 'A'.repeat(length);

/** A valid file whose only interesting line is line 3. */
function file(key: 'entity' | 'in_project', value: string): string {
  return [
    'format: 1',
    'project: teamcli',
    `${key}: ${value}`,
    'operator: lead',
    'trust: []',
    'workspace:',
    '  mode: shared',
    'seats:',
    '  - role: coordinator',
    '    name: lead',
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    '    leads: true',
    '',
  ].join('\n');
}

function loaded(key: 'entity' | 'in_project', value: string): ReturnType<typeof validateTeamFile> {
  return validateTeamFile(file(key, value));
}

describe('an entity name stops at 128 characters', () => {
  test('a name of exactly 128 characters loads as the entity', () => {
    const result = loaded('entity', at(MAX));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.team.entity).toBe(at(MAX));
  });

  test('a name of 129 characters is refused at its line', () => {
    const result = loaded('entity', at(MAX + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      {
        line: 3,
        message:
          'entity must be a short name: letters, digits, ".", "_" and "-", starting with a letter or a digit, 128 at most',
      },
    ]);
  });

  test('the exported pattern holds the same bound', () => {
    expect(ENTITY_NAME.test(at(MAX))).toBe(true);
    expect(ENTITY_NAME.test(at(MAX + 1))).toBe(false);
  });
});

describe('a project name stops at 128 characters', () => {
  test('a name of exactly 128 characters loads as the project', () => {
    const result = loaded('in_project', at(MAX));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.team.inProject).toBe(at(MAX));
  });

  test('a name of 129 characters is refused at its line', () => {
    const result = loaded('in_project', at(MAX + 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      {
        line: 3,
        message:
          'in_project must be a short name: letters, digits, ".", "_" and "-", starting with a letter or a digit, 128 at most',
      },
    ]);
  });
});

describe('the bound is what keeps a recorded target inside the record id rule', () => {
  // The longest level (`project`, 7) and key (`delivery_order`, 14), an unset (the `:unset`
  // suffix), and a 16-digit generation: `config:` + 7 + `:` + name + `:` + 14 + `:` + 16 +
  // `:unset` = 53 characters around the name.
  const change = (name: string): string =>
    configChangedRecordId({
      level: 'project',
      target: name,
      key: 'delivery_order',
      generation: Number('1'.repeat(16)),
      value: null,
    });

  test('a name at the bound composes an id the rule admits', () => {
    const id = change(at(MAX));
    expect(id.length).toBe(MAX + 53);
    expect(EVENT_RECORD_ID.test(id)).toBe(true);
  });

  test('a name of 200 characters, which the shape alone allowed, composed an id the rule refuses', () => {
    const id = change(at(200));
    expect(id.length).toBe(200 + 53);
    expect(EVENT_RECORD_ID.test(id)).toBe(false);
  });
});
