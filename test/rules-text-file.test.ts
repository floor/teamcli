// A Claude Code seat's rules ride its launch line as a file the line names, not as their whole
// text: the line stays short and its first line far under the terminal's 1024 bytes.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rulesTextFile, rulesTextPath } from '../src/launch/rules-text.ts';

let saved: { inline?: string; home?: string };

beforeEach(() => {
  saved = { inline: process.env.TEAM_RULES_INLINE, home: process.env.TEAM_RULES_HOME };
  delete process.env.TEAM_RULES_INLINE;
  process.env.TEAM_RULES_HOME = join(mkdtempSync(join(tmpdir(), 'rules-text-')), 'rules');
});

afterEach(() => {
  for (const [key, value] of [['TEAM_RULES_INLINE', saved.inline], ['TEAM_RULES_HOME', saved.home]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the rules file a launch names', () => {
  test('a launch writes the text once, owner-only, at a path named by its hash', () => {
    const text = '- Never stop at a question.\nThese are standing rules, not a task.';
    const path = rulesTextFile(text, true)!;
    expect(path).toBe(rulesTextPath(text));
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(rulesTextFile(text, true)).toBe(path);
  });

  test('changed rules name another file, so the recorded line still shows the change', () => {
    expect(rulesTextPath('rules one')).not.toBe(rulesTextPath('rules two'));
  });

  test('a run that only reads a line names the path and writes nothing', () => {
    const path = rulesTextFile('read only', false)!;
    expect(existsSync(path)).toBe(false);
  });

  test('the suite switch keeps the text inline', () => {
    process.env.TEAM_RULES_INLINE = '1';
    expect(rulesTextFile('inline', true)).toBeNull();
  });
});
