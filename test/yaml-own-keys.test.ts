// The YAML reader builds the maps every reader above it reads: the team file, the registry's
// stored definition, and the settings files. A map key named __proto__ would set the built
// object's prototype instead of adding a key, so a text could write a value that every later
// read through the map sees while no entry lists it — the settings source's own reader looks
// such a value up with `in`. The parser refuses that name at the map entry, so no text reaches
// a reader as an object with a prototype it chose. `constructor` and `prototype` add ordinary
// own properties and stay ordinary keys.
//
// Synthetic text and temp homes only; nothing here reads a real team or settings file.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTeamText } from '../src/file/load.ts';
import { resolveTeamConfigSource } from '../src/file/team-config.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { parseYaml, toValue, YamlError } from '../src/yaml.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
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
    leads: true
`;

const POISONED = `${TEAM}__proto__:
  project: evil
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-yaml-own-keys-')));
  made.push(dir);
  return dir;
}

describe('a map key named __proto__', () => {
  test('is refused in a block map, a quoted key and a flow map', () => {
    const shapes = [
      'project: acme\n__proto__:\n  hidden: x\n',
      'project: acme\n"__proto__": x\n',
      'project: acme\nworkspace: {__proto__: {hidden: x}}\n',
    ];
    for (const text of shapes) {
      let error: unknown;
      try {
        parseYaml(text);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(YamlError);
      expect((error as YamlError).line).toBe(2);
      expect((error as YamlError).message).toContain('__proto__');
    }
  });

  test('is refused wherever a map sits, not only at the top', () => {
    const nested = `format: 1
project: acme
workspace:
  __proto__:
    mode: shared
`;
    let error: unknown;
    try {
      parseYaml(nested);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(YamlError);
    expect((error as YamlError).line).toBe(4);
  });
});

describe('the other names every object inherits', () => {
  test('are ordinary own keys, read as written', () => {
    const value = toValue(parseYaml('constructor: 1\nprototype: 2\nproject: acme\n')) as { [key: string]: unknown };
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(['constructor', 'prototype', 'project']);
    expect(Object.prototype.hasOwnProperty.call(value, 'constructor')).toBe(true);
    expect(value['constructor']).toBe(1);
    expect(value['prototype']).toBe(2);
  });
});

describe('a reader that would see an inherited value', () => {
  test('the team file does not validate: the parser refuses its key, with the line', () => {
    const checked = validateTeamFile(POISONED);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.parse).toBe(true);
    const at = POISONED.split('\n').findIndex((line) => line.startsWith('__proto__:')) + 1;
    expect(checked.errors).toEqual([{ line: at, message: 'a map key may not be "__proto__"' }]);
  });

  test("the registry's stored definition is read through the same parser", () => {
    const root = temp();
    const loaded = loadTeamText(POISONED, root, join(root, '.agents', 'team.yaml'));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.errors[0]?.message).toBe('a map key may not be "__proto__"');
  });

  test('a settings file cannot supply the config source through the prototype', () => {
    const home = temp();
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(join(home, '.config', 'team', 'settings.yaml'), '__proto__:\n  team-config.source: file\n');
    // Read from the settings file's prototype before the fix: {ok: true, source: 'file',
    // from: 'machine'}. The file no longer parses, so the release default stands.
    expect(resolveTeamConfigSource({ home, env: {} })).toEqual({ ok: true, source: 'registry', from: 'default' });
  });
});
