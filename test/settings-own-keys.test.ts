// The settings chain reads declarations out of parsed files, never out of an object the caller
// built: a `liveness:` map is read from the parse tree's entries and only the three liveness
// words are taken, and the machine's file is found by an entry whose key is `liveness`. A map
// entry named after an inherited property therefore declares nothing — it is not one of the
// words, and no value of it can reach a threshold.
//
// Synthetic homes and hand-built nodes only.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { livenessMap, machineLiveness, machineSettingsPath } from '../src/settings/declared.ts';
import type { YamlNode } from '../src/yaml.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-settings-own-keys-')));
  made.push(dir);
  return dir;
}

function seconds(line: number, value: number): YamlNode {
  return { kind: 'scalar', line, value, quoted: false, raw: String(value) };
}

describe('a liveness map', () => {
  test('takes nothing from an entry named after an inherited property', () => {
    const node: YamlNode = {
      kind: 'map',
      line: 1,
      entries: [
        { key: '__proto__', line: 2, value: { kind: 'scalar', line: 2, value: 1, quoted: false, raw: '1' } },
        { key: 'idle_lead_seconds', line: 3, value: seconds(3, 60) },
      ],
    };
    // A map with any word outside the three declares nothing at all; the word here is not one
    // of them, so the declaration is refused whole rather than partly taken.
    expect(livenessMap(node)).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'idle_lead_seconds')).toBe(false);
  });

  test("the machine's file cannot declare one through the prototype", () => {
    const home = temp();
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(machineSettingsPath(home), '__proto__:\n  liveness:\n    idle_lead_seconds: 1\n');
    // The file no longer parses (test/yaml-own-keys.test.ts); before, the entry list had no
    // `liveness` entry either, so no threshold was read. The value in force stands.
    expect(machineLiveness(home)).toBeUndefined();
  });

  test('still reads the three words it declares', () => {
    const node: YamlNode = {
      kind: 'map',
      line: 1,
      entries: [{ key: 'idle_lead_seconds', line: 2, value: seconds(2, 60) }],
    };
    expect(livenessMap(node)).toEqual({ idle_lead_seconds: 60 });
  });
});
