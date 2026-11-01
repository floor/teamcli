// The registry's configuration record is read as JSON. JSON.parse creates an own data property
// for every member, __proto__ included (measured in this file), so a member named so cannot set
// the parsed object's prototype: the record's own fields read as written, and a field hidden
// under __proto__ satisfies nothing. The stored definition itself is YAML and is refused by the
// YAML reader when it names that key (test/yaml-own-keys.test.ts).
//
// Synthetic records under temp homes only; nothing here reads a real registry.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStoredTeamConfig, sha256, teamConfigRecordPath, TeamConfigStoreError } from '../src/registry/team-config-store.ts';

const ID = '0123456789ab';
const TEXT = 'format: 1\nproject: acme\n';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-config-store-own-keys-')));
  made.push(dir);
  return dir;
}

/** A record written as JSON text, with an extra member beside the envelope's own. */
function writeRecord(home: string, extra: string): string {
  const path = teamConfigRecordPath(home, ID);
  mkdirSync(join(home, '.config', 'team', 'team-config'), { recursive: true });
  writeFileSync(path, `{"format":1,"id":"${ID}","root":"/acme","text":"${TEXT.replace(/\n/g, '\\n')}","text_sha256":"${sha256(TEXT)}","record_version":"v1","record_sha256":"x"${extra}}\n`);
  return path;
}

describe('JSON.parse, measured', () => {
  test('a __proto__ member is an own data property and leaves the prototype alone', () => {
    const parsed = JSON.parse('{"__proto__":{"hidden":"x"},"a":1}') as { [key: string]: unknown };
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(parsed['hidden']).toBeUndefined();
    expect(({} as { hidden?: string }).hidden).toBeUndefined();
  });
});

describe("the registry's record", () => {
  test('reads its own fields and ignores a member named __proto__', () => {
    const home = temp();
    writeRecord(home, ',"__proto__":{"hidden":"x"}');
    const record = readStoredTeamConfig(home, ID);
    expect(record?.text).toBe(TEXT);
    expect(record?.id).toBe(ID);
    expect((record as { hidden?: string } | null)?.hidden).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'hidden')).toBe(false);
  });

  test('cannot satisfy its envelope from a member named __proto__', () => {
    const home = temp();
    const path = teamConfigRecordPath(home, ID);
    mkdirSync(join(home, '.config', 'team', 'team-config'), { recursive: true });
    writeFileSync(path, `{"__proto__":{"format":1,"id":"${ID}","root":"/acme","text":"${TEXT.replace(/\n/g, '\\n')}","text_sha256":"${sha256(TEXT)}"}}\n`);
    expect(() => readStoredTeamConfig(home, ID)).toThrow(TeamConfigStoreError);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'format')).toBe(false);
  });
});
